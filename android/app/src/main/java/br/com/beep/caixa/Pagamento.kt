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
    private val fila = Executors.newSingleThreadScheduledExecutor()
    private val ui = Handler(Looper.getMainLooper())
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

    fun iniciar(ctx: Context) {
        app = ctx.applicationContext
        fila.scheduleWithFixedDelay({ manterAcordada() }, 1, INTERVALO_ACORDAR_MIN, TimeUnit.MINUTES)
    }

    private fun pp(): PlugPag = plugpag ?: PlugPag(app).also { plugpag = it }

    private fun prefs() = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    var maquininhaEndereco: String?
        get() = prefs().getString("endereco", null)
        set(v) { prefs().edit().putString("endereco", v).apply() }

    var maquininhaNome: String?
        get() = prefs().getString("nome", null)
        set(v) { prefs().edit().putString("nome", v).apply() }

    var manterAcordadaLigado: Boolean
        get() = prefs().getBoolean("acordada", true)
        set(v) { prefs().edit().putBoolean("acordada", v).apply() }

    fun versaoBiblioteca(): String = try { br.com.uol.pagseguro.plugpag.PlugPagBase.getLibVersion() } catch (e: Throwable) { "?" }

    private fun anotar(m: String) { ui.post { aoAnotar?.invoke(m) } }

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
        fila.execute {
            val r = try { pp().isAuthenticated } catch (e: Throwable) { false }
            ui.post { fim(r) }
        }
    }

    /**
     * Abre a tela de login do próprio PagBank (a senha vai direto ao PagBank, nunca passa pelo Beep).
     * Se em 60 s o PagBank não responder, avisa — a tela do PagBank às vezes fica parada no "Entrar".
     */
    fun entrarNaConta(fim: (Boolean) -> Unit) {
        if (!loginAberto.compareAndSet(false, true)) { anotar("O login do PagBank já está aberto"); return }
        val respondeu = AtomicBoolean(false)
        val terminar = { _: String -> if (respondeu.compareAndSet(false, true)) { loginAberto.set(false); autenticado(fim) } }
        fila.execute {
            val req = try { pp().checkRequirements(PlugPagDevice.TYPE_PINPAD) } catch (e: Throwable) { -9999 }
            if (req != IPlugPag.RET_OK) anotar("Requisitos do PagBank: ${explicarCodigo(req.toString())}")
            ui.post {
                try {
                    val r = pp().requestAuthentication(object : PlugPagAuthenticationListener {
                        override fun onSuccess() { terminar("ok") }
                        override fun onError() { terminar("erro") }
                    })
                    if (r != IPlugPag.RET_OK) { anotar("O PagBank não abriu o login (${explicarCodigo(r.toString())})"); terminar("falhou") }
                } catch (e: Throwable) { anotar("Erro ao abrir o login: ${e.message ?: e.javaClass.simpleName}"); terminar("excecao") }
            }
            ui.postDelayed({
                if (!respondeu.get()) anotar("O login do PagBank não respondeu em 60 s. Feche a tela dele pelo botão voltar e teste a cobrança direto: nesta versão o login pode não ser necessário.")
            }, 60_000)
            ui.postDelayed({ if (!respondeu.get()) { loginAberto.set(false) } }, 180_000)
        }
    }

    fun loginFechadoSemResposta() { if (loginAberto.get()) loginAberto.set(false) }

    fun sairDaConta(fim: () -> Unit) {
        fila.execute {
            try { pp().invalidateAuthentication() } catch (_: Throwable) {}
            ui.post(fim)
        }
    }

    // ---------------- conexão e "manter acordada" ----------------

    /** Conecta por Bluetooth. Roda SEMPRE dentro da fila. Retorna null se ok, ou a mensagem do problema. */
    private fun conectar(end: String): String? {
        if (!bluetoothLigado()) return "Bluetooth do telefone desligado"
        return try {
            val r = pp().initBTConnectionWithResult(PlugPagDevice(end))
            if (r.result == IPlugPag.RET_OK) { ultimoSinalOk = SystemClock.elapsedRealtime(); ultimoErroConexao = null; null }
            else (r.message?.takeIf { it.isNotBlank() } ?: explicarCodigo(r.errorCode ?: r.result.toString())).also { ultimoErroConexao = it }
        } catch (e: Throwable) {
            // versões antigas da biblioteca não têm initBTConnectionWithResult
            try {
                val c = pp().initBTConnection(PlugPagDevice(end))
                if (c == IPlugPag.RET_OK) { ultimoSinalOk = SystemClock.elapsedRealtime(); ultimoErroConexao = null; null }
                else explicarCodigo(c.toString()).also { ultimoErroConexao = it }
            } catch (e2: Throwable) { (e2.message ?: e2.javaClass.simpleName).also { ultimoErroConexao = it } }
        }
    }

    private fun acordar() { try { pp().wakeupPinpad() } catch (_: Throwable) {} }

    private fun manterAcordada() {
        if (!::app.isInitialized || !manterAcordadaLigado || cobrando || loginAberto.get()) return
        val end = maquininhaEndereco ?: return
        val erro = conectar(end)
        if (erro == null) acordar() else anotar("Manter acordada: $erro")
    }

    /** Testa a conexão agora (botão "Testar conexão"). */
    fun testarConexao(fim: (String?) -> Unit) {
        val end = maquininhaEndereco ?: run { ui.post { fim("Nenhuma maquininha escolhida") }; return }
        fila.execute {
            val e = conectar(end)
            if (e == null) acordar()
            ui.post { fim(e) }
        }
    }

    fun diagnostico(fim: (String) -> Unit) {
        fila.execute {
            val s = StringBuilder()
            s.append("PlugPag ").append(versaoBiblioteca()).append('\n')
            s.append("Bluetooth: ").append(if (bluetoothLigado()) "ligado" else "DESLIGADO").append('\n')
            s.append("Maquininha: ").append(maquininhaNome ?: "nenhuma").append(" ").append(maquininhaEndereco ?: "").append('\n')
            val req = try { pp().checkRequirements(PlugPagDevice.TYPE_PINPAD) } catch (e: Throwable) { -9999 }
            s.append("Requisitos: ").append(if (req == IPlugPag.RET_OK) "ok" else explicarCodigo(req.toString())).append('\n')
            val aut = try { pp().isAuthenticated } catch (e: Throwable) { false }
            s.append("Conta PagBank: ").append(if (aut) "conectada" else "não conectada").append('\n')
            maquininhaEndereco?.let { end ->
                val e = conectar(end)
                s.append("Conexão: ").append(e ?: "ok").append('\n')
                if (e == null) {
                    acordar()
                    try { pp().readerInfo?.let { ri -> s.append("Leitor: ").append(ri.sharedLibraryVersion ?: "-").append('\n') } } catch (_: Throwable) {}
                }
            }
            ui.post { fim(s.toString().trim()) }
        }
    }

    // ---------------- cobrança ----------------

    /**
     * Cobra na maquininha. valor em centavos; forma = "credito" | "debito".
     * evento(msg) recebe as mensagens da maquininha ("Aproxime ou insira o cartão", "Digite a senha"...).
     * fim(json) recebe o resultado: ok, mensagem, codigo, transacao, nsu, bandeira, autorizacao.
     */
    fun cobrar(valor: Int, forma: String, referencia: String, evento: (String) -> Unit, fim: (JSONObject) -> Unit) {
        val end = maquininhaEndereco
        if (end == null) { ui.post { fim(erro("Nenhuma maquininha escolhida. Abra a configuração da maquininha.", "SEM_MAQUININHA")) }; return }
        if (cobrando) { ui.post { fim(erro("Já existe uma cobrança em andamento", "OCUPADO")) }; return }
        if (valor < 100) { ui.post { fim(erro("Valor mínimo no cartão é R$ 1,00", "VALOR")) }; return }
        if (forma != "credito" && forma != "debito") { ui.post { fim(erro("Forma de pagamento inválida", "FORMA")) }; return }
        cobrando = true
        ui.post { evento("Conectando à maquininha…") }
        fila.execute {
            val r = try {
                val p = pp()
                var falha = conectar(end)
                if (falha != null) { // segunda tentativa: a maquininha pode estar acordando
                    ui.post { evento("Acordando a maquininha…") }
                    Thread.sleep(1500)
                    falha = conectar(end)
                }
                if (falha != null) {
                    erro("Maquininha não respondeu: $falha. Confira se ela está ligada e perto do caixa.", "CONEXAO")
                } else {
                    acordar()
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
                }
            } catch (e: Throwable) {
                erro(e.message ?: e.javaClass.simpleName, "EXCECAO")
            } finally {
                cobrando = false
            }
            ui.post { fim(r) }
        }
    }

    fun cancelar() {
        // abort precisa rodar fora da fila (a fila está presa no doPayment)
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
