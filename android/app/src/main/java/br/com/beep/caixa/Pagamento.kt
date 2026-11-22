package br.com.beep.caixa

import android.annotation.SuppressLint
import android.app.Application
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import br.com.uol.pagseguro.plugpag.PlugPag
import br.com.uol.pagseguro.plugpag.IPlugPag
import br.com.uol.pagseguro.plugpag.PlugPagAuthenticationListener
import br.com.uol.pagseguro.plugpag.PlugPagDevice
import br.com.uol.pagseguro.plugpag.PlugPagEventListener
import br.com.uol.pagseguro.plugpag.PlugPagPaymentData
import org.json.JSONObject
import java.util.concurrent.Executors

class BeepApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Pagamento.iniciar(this)
    }
}

/**
 * Tudo que fala com a maquininha passa por aqui. Uma única instância do PlugPag (exigência do PagBank)
 * e todas as chamadas numa thread de fundo (as chamadas do PlugPag demoram e usam internet).
 */
object Pagamento {
    private lateinit var app: Context
    private var plugpag: PlugPag? = null
    private val fila = Executors.newSingleThreadExecutor()
    private val ui = Handler(Looper.getMainLooper())
    @Volatile var cobrando = false
        private set

    private const val PREFS = "beep_maquininha"
    private const val TIPO_A_VISTA = 1

    fun iniciar(ctx: Context) {
        app = ctx.applicationContext
    }

    private fun pp(): PlugPag = plugpag ?: PlugPag(app).also { plugpag = it }

    private fun prefs() = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    var maquininhaEndereco: String?
        get() = prefs().getString("endereco", null)
        set(v) { prefs().edit().putString("endereco", v).apply() }

    var maquininhaNome: String?
        get() = prefs().getString("nome", null)
        set(v) { prefs().edit().putString("nome", v).apply() }

    fun versaoBiblioteca(): String = try { br.com.uol.pagseguro.plugpag.PlugPagBase.getLibVersion() } catch (e: Throwable) { "?" }

    @SuppressLint("MissingPermission")
    fun aparelhosPareados(): List<Pair<String, String>> {
        val m = app.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        val ad: BluetoothAdapter = m?.adapter ?: return emptyList()
        return try {
            ad.bondedDevices.map { (it.name ?: it.address) to it.address }
                .sortedByDescending { it.first.contains("PRO", true) || it.first.contains("MINI", true) || it.first.contains("PAX", true) || it.first.contains("ME30", true) || it.first.contains("PAG", true) }
        } catch (e: SecurityException) { emptyList() }
    }

    fun autenticado(fim: (Boolean) -> Unit) {
        fila.execute {
            val r = try { pp().isAuthenticated } catch (e: Throwable) { false }
            ui.post { fim(r) }
        }
    }

    /** Abre a tela de login do próprio PagBank (a senha é digitada pelo dono, nunca passa pelo Beep). */
    fun entrarNaConta(fim: (Boolean) -> Unit) {
        ui.post {
            try {
                pp().requestAuthentication(object : PlugPagAuthenticationListener {
                    override fun onSuccess() { autenticado(fim) }
                    override fun onError() { autenticado(fim) }
                })
            } catch (e: Throwable) { fim(false) }
        }
    }

    fun sairDaConta(fim: () -> Unit) {
        fila.execute {
            try { pp().invalidateAuthentication() } catch (_: Throwable) {}
            ui.post(fim)
        }
    }

    /**
     * Cobra na maquininha. valor em centavos; forma = "credito" | "debito".
     * evento(msg) recebe as mensagens da maquininha ("Aproxime ou insira o cartão", "Digite a senha"...).
     * fim(json) recebe o resultado: ok, mensagem, codigo, transacao, nsu, bandeira.
     */
    fun cobrar(valor: Int, forma: String, referencia: String, evento: (String) -> Unit, fim: (JSONObject) -> Unit) {
        val end = maquininhaEndereco
        if (end == null) { ui.post { fim(erro("Nenhuma maquininha escolhida. Abra a configuração da maquininha.", "SEM_MAQUININHA")) }; return }
        if (cobrando) { ui.post { fim(erro("Já existe uma cobrança em andamento", "OCUPADO")) }; return }
        if (valor < 100) { ui.post { fim(erro("Valor mínimo no cartão é R$ 1,00", "VALOR")) }; return }
        cobrando = true
        fila.execute {
            val r = try {
                val p = pp()
                val tipo = if (forma == "debito") IPlugPag.TYPE_DEBITO else IPlugPag.TYPE_CREDITO
                val dados = PlugPagPaymentData(tipo, valor, TIPO_A_VISTA, 1, referencia.take(9))
                val conexao = p.initBTConnection(PlugPagDevice(end))
                p.setEventListener(PlugPagEventListener { ev ->
                    val msg = ev.customMessage
                    if (!msg.isNullOrBlank()) ui.post { evento(msg) }
                    IPlugPag.RET_OK
                })
                val res = p.doPayment(dados)
                JSONObject().apply {
                    put("ok", res.result == IPlugPag.RET_OK)
                    put("mensagem", res.message ?: "")
                    put("codigo", res.errorCode ?: "")
                    put("transacao", res.transactionCode ?: "")
                    put("transacao_id", res.transactionId ?: "")
                    put("nsu", res.nsu ?: "")
                    put("bandeira", res.cardBrand ?: "")
                    put("conexao", conexao)
                    put("forma", forma)
                    put("valor", valor)
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
        Thread { try { plugpag?.abort() } catch (_: Throwable) {} }.start()
    }

    private fun erro(m: String, c: String) = JSONObject().put("ok", false).put("mensagem", m).put("codigo", c)
}
