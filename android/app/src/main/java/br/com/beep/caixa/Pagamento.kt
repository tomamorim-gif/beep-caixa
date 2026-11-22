package br.com.beep.caixa

import android.annotation.SuppressLint
import android.app.Application
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import br.com.uol.pagseguro.plugpag.IPlugPag
import br.com.uol.pagseguro.plugpag.PlugPag
import br.com.uol.pagseguro.plugpag.PlugPagAuthenticationListener
import br.com.uol.pagseguro.plugpag.PlugPagDevice
import br.com.uol.pagseguro.plugpag.PlugPagEventListener
import br.com.uol.pagseguro.plugpag.PlugPagPaymentData
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class BeepApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Diag.iniciar(this)
        Pagamento.iniciar(this)
    }
}

/**
 * Tudo que fala com a maquininha passa por aqui.
 * - Uma única instância do PlugPag (exigência do PagBank), criada uma vez.
 * - Todas as chamadas numa única thread de fundo (o PlugPag não aceita chamadas paralelas nem na thread da tela).
 * - "Manter acordada": de tempos em tempos reconecta e acorda a maquininha para ela não entrar em descanso.
 */
object Pagamento {
    private lateinit var app: Context
    private var plugpag: PlugPag? = null
    private val ui = Handler(Looper.getMainLooper())
    /** Threads de trabalho (podem ser várias: uma chamada travada não segura as outras). */
    private val trabalho = Executors.newCachedThreadPool()
    private val agenda = Executors.newSingleThreadScheduledExecutor()
    /** Só uma chamada ao PlugPag por vez (a biblioteca não aceita chamadas paralelas). */
    private val trava = java.util.concurrent.locks.ReentrantLock()
    private val loginAberto = AtomicBoolean(false)

    @Volatile var cobrando = false
        private set
    @Volatile var ultimoSinalOk: Long = 0L
        private set
    @Volatile var ultimoErroConexao: String? = null
        private set

    /** Mensagens de diagnóstico (a tela da maquininha mostra). */
    var aoAnotar: ((String) -> Unit)? = null

    private const val PREFS = "beep_maquininha"
    private const val INTERVALO_ACORDAR_MIN = 3L
    private const val TRAVADA = "A maquininha não respondeu e a conexão ficou presa. Desligue e ligue a maquininha e feche e abra o app."

    fun iniciar(ctx: Context) {
        app = ctx.applicationContext
        trabalho.execute {
            Diag.log("criando PlugPag ${versaoBiblioteca()}…")
            try { pp(); Diag.log("PlugPag criado") } catch (e: Throwable) { Diag.log("PlugPag falhou ao criar: $e") }
        }
        agenda.scheduleWithFixedDelay({ manterAcordada() }, INTERVALO_ACORDAR_MIN, INTERVALO_ACORDAR_MIN, TimeUnit.MINUTES)
    }

    private val criando = Object()
    /** Uma única instância, criada fora da thread da tela (o construtor do PlugPag é pesado). */
    private fun pp(): PlugPag {
        plugpag?.let { return it }
        synchronized(criando) { return plugpag ?: PlugPag(app).also { plugpag = it } }
    }

    /** Passos com hora, para descobrir onde algo para. */
    private fun passo(m: String) { android.util.Log.i("BeepPag", m); ui.post { aoAnotar?.invoke("· $m") }; Diag.log("[${Thread.currentThread().name}] $m") }

    /** Roda um bloco do PlugPag com a trava. Se a trava estiver presa por mais de [esperaSeg], devolve null. */
    private fun <T> comPlugPag(esperaSeg: Long, bloco: (PlugPag) -> T): T? {
        if (!trava.tryLock(esperaSeg, TimeUnit.SECONDS)) return null
        try { return bloco(pp()) } finally { trava.unlock() }
    }

    /** Executa [bloco] numa thread de trabalho e devolve o resultado em até [limiteSeg]; senão, [seEstourar]. */
    private fun <T> comLimite(limiteSeg: Long, seEstourar: T, bloco: () -> T): T {
        val f = trabalho.submit<T> { bloco() }
        return try { f.get(limiteSeg, TimeUnit.SECONDS) } catch (e: java.util.concurrent.TimeoutException) { seEstourar } catch (e: Throwable) { seEstourar }
    }

    private fun prefs() = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    var maquininhaEndereco: String?
        get() = prefs().getString("endereco", null)
        set(v) { prefs().edit().putString("endereco", v).apply() }

    var maquininhaNome: String?
        get() = prefs().getString("nome", null)
        set(v) { prefs().edit().putString("nome", v).apply() }

    var manterAcordadaLigado: Boolean
        get() = prefs().getBoolean("acordada2", false)
        set(v) { prefs().edit().putBoolean("acordada2", v).apply() }

    fun versaoBiblioteca(): String = try { br.com.uol.pagseguro.plugpag.PlugPagBase.getLibVersion() } catch (e: Throwable) { "?" }

    private fun anotar(m: String) { Diag.log(m); ui.post { aoAnotar?.invoke(m) } }

    fun bluetoothLigado(): Boolean {
        val m = app.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        return m?.adapter?.isEnabled == true
    }

    @SuppressLint("MissingPermission")
    fun aparelhosPareados(): List<Pair<String, String>> {
        val m = app.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val ad: BluetoothAdapter = m?.adapter ?: return emptyList()
        return try {
            ad.bondedDevices.map { (it.name ?: it.address) to it.address }
                .sortedByDescending { n -> listOf("PRO", "MINI", "PAX", "ME30", "PAG", "NFC").any { n.first.contains(it, true) } }
        } catch (e: SecurityException) { emptyList() }
    }

    // ---------------- conta PagBank ----------------

    fun autenticado(fim: (Boolean) -> Unit) {
        trabalho.execute {
            // não espera a trava: isAuthenticated é só leitura e não pode ficar preso atrás da conexão
            val r = comLimite(6, false) { try { pp().isAuthenticated } catch (e: Throwable) { false } }
            ui.post { fim(r) }
        }
    }

    /** Abre a tela de login do próprio PagBank (a senha vai direto ao PagBank, nunca passa pelo Beep). Nunca roda na thread da tela. */
    fun entrarNaConta(fim: (Boolean) -> Unit) {
        loginAberto.set(true)
        val respondeu = AtomicBoolean(false)
        val terminar = { if (respondeu.compareAndSet(false, true)) { loginAberto.set(false); autenticado(fim) } }
        trabalho.execute {
            passo("preparando o PagBank…")
            val r = comLimite(15, -7777) {
                try {
                    val p = pp()
                    passo("abrindo a tela de login do PagBank…")
                    p.requestAuthentication(object : PlugPagAuthenticationListener {
                        override fun onSuccess() { passo("PagBank respondeu: login ok"); terminar() }
                        override fun onError() { passo("PagBank respondeu: login não concluído"); terminar() }
                    })
                } catch (e: Throwable) { passo("erro: ${e.message ?: e.javaClass.simpleName}"); -8888 }
            }
            when (r) {
                IPlugPag.RET_OK -> passo("tela do PagBank aberta")
                -7777 -> { passo("o PagBank não abriu a tela em 15 s"); terminar() }
                else -> { passo("o PagBank recusou abrir o login (${explicarCodigo(r.toString())})"); terminar() }
            }
        }
        ui.postDelayed({ if (!respondeu.get()) anotar("O login do PagBank não respondeu em 60 s. Toque em voltar na tela dele e teste a cobrança direto.") }, 60_000)
    }

    fun loginFechadoSemResposta() { loginAberto.set(false) }

    fun sairDaConta(fim: () -> Unit) {
        trabalho.execute {
            comLimite(8, Unit) { try { pp().invalidateAuthentication() } catch (_: Throwable) {}; Unit }
            ui.post(fim)
        }
    }

    // ---------------- conexão e "manter acordada" ----------------

    /** Conecta por Bluetooth com limite de tempo. Retorna null se ok, ou a mensagem do problema. */
    private fun conectar(end: String, limiteSeg: Long = 25): String? {
        if (!bluetoothLigado()) return "Bluetooth do telefone desligado"
        passo("conectando por Bluetooth (até $limiteSeg s)…")
        val r = comLimite<String?>(limiteSeg, "A maquininha não respondeu em $limiteSeg s (desligada, em descanso ou longe)") {
            comPlugPag<String?>(2) { p ->
                try {
                    val c = p.initBTConnection(PlugPagDevice(end))
                    if (c == IPlugPag.RET_OK) null else explicarCodigo(c.toString())
                } catch (e: Throwable) { e.message ?: e.javaClass.simpleName }
            } ?: TRAVADA
        }
        if (r == null) { ultimoSinalOk = SystemClock.elapsedRealtime(); ultimoErroConexao = null; passo("conectado") } else { ultimoErroConexao = r; passo("falhou: $r") }
        return r
    }

    private fun acordar() { trabalho.execute { comPlugPag(1) { try { it.wakeupPinpad() } catch (_: Throwable) {} } } }

    private fun manterAcordada() {
        if (!::app.isInitialized || !manterAcordadaLigado || cobrando || loginAberto.get() || trava.isLocked) return
        val end = maquininhaEndereco ?: return
        val erro = conectar(end, 15)
        if (erro == null) acordar() else anotar("Manter acordada: $erro")
    }

    /** Testa a conexão agora (botão "Testar conexão"). */
    fun testarConexao(fim: (String?) -> Unit) {
        val end = maquininhaEndereco ?: run { ui.post { fim("Nenhuma maquininha escolhida") }; return }
        trabalho.execute {
            val e = conectar(end)
            if (e == null) acordar()
            ui.post { fim(e) }
        }
    }

    fun diagnostico(fim: (String) -> Unit) {
        trabalho.execute {
            val s = StringBuilder()
            s.append("PlugPag ").append(versaoBiblioteca()).append('\n')
            s.append("Bluetooth: ").append(if (bluetoothLigado()) "ligado" else "DESLIGADO").append('\n')
            s.append("Maquininha: ").append(maquininhaNome ?: "nenhuma").append(" ").append(maquininhaEndereco ?: "").append('\n')
            s.append("Cobrança em andamento: ").append(if (cobrando) "sim" else "não").append(" · conexão presa: ").append(if (trava.isLocked) "sim" else "não").append('\n')
            val req = comLimite(8, -9999) { try { pp().checkRequirements(PlugPagDevice.TYPE_PINPAD) } catch (e: Throwable) { -9999 } }
            s.append("Requisitos: ").append(if (req == IPlugPag.RET_OK) "ok" else explicarCodigo(req.toString())).append('\n')
            val aut = comLimite(6, false) { try { pp().isAuthenticated } catch (e: Throwable) { false } }
            s.append("Conta PagBank: ").append(if (aut) "conectada" else "não conectada").append('\n')
            maquininhaEndereco?.let { end -> s.append("Conexão: ").append(conectar(end) ?: "ok").append('\n') }
            ui.post { fim(s.toString().trim()) }
        }
    }

    /** Libera a tela se algo ficou preso (botão "Destravar"). */
    fun destravar() {
        Thread { try { plugpag?.abort() } catch (_: Throwable) {} }.start()
        cobrando = false
        loginAberto.set(false)
    }

    // ---------------- cobrança ----------------

    /**
     * Cobra na maquininha. valor em centavos; forma = "credito" | "debito".
     * evento(msg) recebe as mensagens da maquininha; fim(json) recebe o resultado uma única vez.
     */
    fun cobrar(valor: Int, forma: String, referencia: String, evento: (String) -> Unit, fim: (JSONObject) -> Unit) {
        val end = maquininhaEndereco
        if (end == null) { ui.post { fim(erro("Nenhuma maquininha escolhida. Abra a configuração da maquininha.", "SEM_MAQUININHA")) }; return }
        if (cobrando) { ui.post { fim(erro("Já existe uma cobrança em andamento", "OCUPADO")) }; return }
        if (valor < 100) { ui.post { fim(erro("Valor mínimo no cartão é R$ 1,00", "VALOR")) }; return }
        if (forma != "credito" && forma != "debito") { ui.post { fim(erro("Forma de pagamento inválida", "FORMA")) }; return }
        cobrando = true
        val entregue = AtomicBoolean(false)
        val entregar = { r: JSONObject -> if (entregue.compareAndSet(false, true)) { cobrando = false; ui.post { fim(r) } } }
        // vigia: nenhuma cobrança fica presa mais de 3 minutos
        ui.postDelayed({
            if (!entregue.get()) { try { Thread { try { plugpag?.abort() } catch (_: Throwable) {} }.start() } catch (_: Throwable) {}
                entregar(erro("A maquininha não respondeu a tempo. Confira se ela está ligada e tente de novo.", "TEMPO")) }
        }, 180_000)
        ui.post { evento("Conectando à maquininha…") }
        trabalho.execute {
            val r = try {
                var falha = conectar(end)
                if (falha != null && falha != TRAVADA) {
                    ui.post { evento("Acordando a maquininha…") }
                    Thread.sleep(1500)
                    falha = conectar(end)
                }
                if (falha != null) {
                    erro("Maquininha não respondeu: $falha", "CONEXAO")
                } else {
                    comPlugPag(5) { p ->
                        try { p.wakeupPinpad() } catch (_: Throwable) {}
                        val tipo = if (forma == "debito") IPlugPag.TYPE_DEBITO else IPlugPag.TYPE_CREDITO
                        val ref = referencia.filter { it.isLetterOrDigit() }.take(9).ifEmpty { "BEEP" }
                        val dados = PlugPagPaymentData(tipo, valor, IPlugPag.INSTALLMENT_TYPE_A_VISTA, 1, ref)
                        p.setEventListener(PlugPagEventListener { ev ->
                            val msg = ev.customMessage
                            if (!msg.isNullOrBlank()) ui.post { evento(msg) }
                            IPlugPag.RET_OK
                        })
                        val res = p.doPayment(dados)
                        val ok = res.result == IPlugPag.RET_OK
                        JSONObject().apply {
                            put("ok", ok)
                            put("mensagem", if (ok) (res.message ?: "Aprovado") else traduzir(res.errorCode, res.message))
                            put("codigo", res.errorCode ?: res.result.toString())
                            put("transacao", res.transactionCode ?: "")
                            put("transacao_id", res.transactionId ?: "")
                            put("nsu", res.hostNsu ?: res.nsu ?: "")
                            put("autorizacao", res.autoCode ?: "")
                            put("bandeira", res.cardBrand ?: "")
                            put("forma", forma)
                            put("valor", valor)
                        }
                    } ?: erro(TRAVADA, "TRAVADA")
                }
            } catch (e: Throwable) {
                erro(e.message ?: e.javaClass.simpleName, "EXCECAO")
            }
            entregar(r)
        }
    }

    fun cancelar() {
        Thread { try { plugpag?.abort() } catch (_: Throwable) {} }.start()
    }

    private fun erro(m: String, c: String) = JSONObject().put("ok", false).put("mensagem", m).put("codigo", c)

    private fun traduzir(codigo: String?, mensagem: String?): String {
        val m = mensagem?.trim().orEmpty()
        val c = codigo?.trim().orEmpty()
        val explicado = explicarCodigo(c)
        return when {
            m.isNotEmpty() && explicado == c -> m
            m.isNotEmpty() -> "$m ($explicado)"
            else -> explicado
        }
    }

    /** Códigos do manual do PlugPag em português simples. */
    fun explicarCodigo(c: String): String = when (c.trim()) {
        "0" -> "ok"
        "-1003" -> "maquininha não estava pronta, tente de novo"
        "-1004" -> "transação não realizada"
        "-1017" -> "app sem identificação no PagBank"
        "-1018", "-1019" -> "falha de comunicação com a maquininha"
        "-1020" -> "maquininha em modo compartilhado: desative o compartilhamento"
        "-1024" -> "erro na carga de tabelas da maquininha, refaça a ativação"
        "-1030" -> "conta PagBank não conectada: faça o login"
        "-1031" -> "valor inválido"
        "-1032" -> "parcelamento inválido"
        "-2001", "-2023" -> "cobrança cancelada"
        "-3000" -> "faltam permissões do app (Bluetooth, telefone ou áudio)"
        "-3001" -> "telefone com root: o PagBank bloqueia"
        "-3300" -> "o PagBank não conseguiu abrir a tela dele"
        "-9999" -> "erro ao checar requisitos"
        else -> c
    }
}
