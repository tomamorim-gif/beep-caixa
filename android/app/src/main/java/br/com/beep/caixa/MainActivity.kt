package br.com.beep.caixa

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import org.json.JSONObject
import java.util.Locale

/**
 * O caixa Beep (o mesmo site do navegador) rodando dentro do app, com uma ponte "BeepNativo"
 * para a maquininha e para a voz. O site continua sendo atualizado sem reinstalar o app.
 */
class MainActivity : AppCompatActivity() {
    companion object {
        // app.pagnow.com.br: domínio próprio (o endereço antigo do GitHub passa a redirecionar para ele)
        private val HOSTS_OK = setOf("tomamorim-gif.github.io", "app.pagnow.com.br")
        private const val REQ_PERM = 10
    }

    private lateinit var web: WebView
    private var tts: TextToSpeech? = null
    private var ttsPronto = false
    private var pedidoWeb: PermissionRequest? = null
    /** Página que está aberta (autoatendimento ou vendedor), para recarregar se o quiosque trocar. */
    private var paginaAberta = ""
    // 5 toques seguidos no canto superior esquerdo abrem a área do responsável (PIN do quiosque)
    private var toquesCanto = 0
    private var primeiroToque = 0L

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.statusBarColor = Color.BLACK
        window.navigationBarColor = Color.BLACK

        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#0B0B0B"))
        setContentView(web)
        telaCheia()

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            userAgentString = "$userAgentString BeepCaixaApp/${BuildConfig.VERSION_NAME}"
        }
        WebView.setWebContentsDebuggingEnabled(false)
        web.addJavascriptInterface(Ponte(), "BeepNativo")

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val u = req.url
                if (u.scheme == "https" && u.host in HOSTS_OK) return false
                // links externos (anúncios, WhatsApp) não saem do caixa: o caixa é de uso público
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val origem = request.origin
                if (origem.host !in HOSTS_OK) { request.deny(); return }
                val faltando = mutableListOf<String>()
                if (request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) && !tem(Manifest.permission.CAMERA)) faltando += Manifest.permission.CAMERA
                if (request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) && !tem(Manifest.permission.RECORD_AUDIO)) faltando += Manifest.permission.RECORD_AUDIO
                if (faltando.isEmpty()) request.grant(request.resources)
                else { pedidoWeb = request; ActivityCompat.requestPermissions(this@MainActivity, faltando.toTypedArray(), REQ_PERM) }
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { /* botão voltar desativado no caixa */ }
        })

        tts = TextToSpeech(this) { st ->
            if (st == TextToSpeech.SUCCESS) {
                tts?.language = Locale("pt", "BR")
                ttsPronto = true
            }
        }

        pedirPermissoesIniciais()
        paginaAberta = Quiosque.pagina
        if (savedInstanceState == null) web.loadUrl(Quiosque.url) else web.restoreState(savedInstanceState)

        // primeira vez: abre a configuração da maquininha
        if (Pagamento.maquininhaEndereco == null && savedInstanceState == null) {
            startActivity(Intent(this, MaquininhaActivity::class.java))
        }
    }

    private fun tem(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun pedirPermissoesIniciais() {
        val lista = mutableListOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) { lista += Manifest.permission.BLUETOOTH_CONNECT; lista += Manifest.permission.BLUETOOTH_SCAN }
        val falta = lista.filter { !tem(it) }
        if (falta.isNotEmpty()) ActivityCompat.requestPermissions(this, falta.toTypedArray(), REQ_PERM + 1)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_PERM) {
            val r = pedidoWeb ?: return
            pedidoWeb = null
            val ok = r.resources.filter {
                (it == PermissionRequest.RESOURCE_VIDEO_CAPTURE && tem(Manifest.permission.CAMERA)) ||
                    (it == PermissionRequest.RESOURCE_AUDIO_CAPTURE && tem(Manifest.permission.RECORD_AUDIO))
            }
            if (ok.isEmpty()) r.deny() else r.grant(ok.toTypedArray())
        }
    }

    private fun telaCheia() {
        WindowCompat.setDecorFitsSystemWindows(window, true)
        val c = WindowInsetsControllerCompat(window, window.decorView)
        c.hide(WindowInsetsCompat.Type.systemBars())
        c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) telaCheia()
    }

    override fun onResume() {
        super.onResume(); web.onResume()
        abrirPaginaCerta()
        Quiosque.garantir(this)
        js("window.beepNativoVoltou&&window.beepNativoVoltou()")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra("recarregar", false)) web.reload()
    }

    private fun abrirPaginaCerta() {
        if (Quiosque.pagina != paginaAberta) { paginaAberta = Quiosque.pagina; web.loadUrl(Quiosque.url) }
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ev.actionMasked == MotionEvent.ACTION_DOWN) {
            val canto = 80 * resources.displayMetrics.density
            if (ev.x <= canto && ev.y <= canto) {
                val agora = SystemClock.elapsedRealtime()
                if (agora - primeiroToque > 3000) { primeiroToque = agora; toquesCanto = 0 }
                if (++toquesCanto >= 5) { toquesCanto = 0; primeiroToque = 0; abrirQuiosque() }
            } else toquesCanto = 0
        }
        return super.dispatchTouchEvent(ev)
    }

    private fun abrirQuiosque() = startActivity(Intent(this, QuiosqueActivity::class.java))
    override fun onPause() { web.onPause(); super.onPause() }
    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); web.saveState(outState) }
    override fun onDestroy() { tts?.shutdown(); web.destroy(); super.onDestroy() }

    private fun js(code: String) = runOnUiThread { web.evaluateJavascript(code, null) }
    private fun q(s: String) = JSONObject.quote(s)

    inner class Ponte {
        @JavascriptInterface fun disponivel(): Boolean = true
        @JavascriptInterface fun versao(): String = BuildConfig.VERSION_NAME

        @JavascriptInterface fun status(): String {
            val o = JSONObject()
            o.put("app", BuildConfig.VERSION_NAME)
            o.put("maquininha", Pagamento.maquininhaNome ?: JSONObject.NULL)
            o.put("cobrando", Pagamento.cobrando)
            o.put("bluetooth", Pagamento.bluetoothLigado())
            o.put("cartao", Pagamento.maquininhaEndereco != null)
            return o.toString()
        }

        @JavascriptInterface fun configurar() {
            runOnUiThread { startActivity(Intent(this@MainActivity, MaquininhaActivity::class.java)) }
        }

        /** Cobra na maquininha. O resultado volta em window.beepPagResultado(id, json); mensagens em window.beepPagEvento(id, texto). */
        @JavascriptInterface fun cobrar(id: String, valorCentavos: Int, forma: String) {
            Pagamento.cobrar(valorCentavos, forma, id.filter { it.isLetterOrDigit() },
                evento = { m -> js("window.beepPagEvento&&window.beepPagEvento(${q(id)},${q(m)})") },
                fim = { r -> js("window.beepPagResultado&&window.beepPagResultado(${q(id)},${r})") })
        }

        @JavascriptInterface fun cancelarCobranca() = Pagamento.cancelar()

        /** Configuração do quiosque que veio do Painel (junto com o catálogo). */
        @JavascriptInterface fun quiosque(json: String?) {
            runOnUiThread { if (Quiosque.aplicarDoPainel(json, this@MainActivity)) abrirPaginaCerta() }
        }
        @JavascriptInterface fun quiosqueEstado(): String = Quiosque.estado().toString()
        /** Abre a área do responsável (o menu do caixa pode chamar). */
        @JavascriptInterface fun abrirQuiosque() { runOnUiThread { this@MainActivity.abrirQuiosque() } }

        /** Voz do caixa (o WebView do Android não fala sozinho). */
        @JavascriptInterface fun falar(texto: String) {
            if (ttsPronto) tts?.speak(texto.take(400), TextToSpeech.QUEUE_FLUSH, null, "beep")
        }
        @JavascriptInterface fun calar() { tts?.stop() }
    }
}
