package br.com.beep.caixa

import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.text.SimpleDateFormat
import java.util.Locale

/**
 * Área do responsável: PIN para sair do quiosque e as opções dele.
 * Aberta pelos 5 toques no canto superior esquerdo do caixa (ou pelo menu do caixa).
 */
class QuiosqueActivity : AppCompatActivity() {
    private val amarelo = Color.parseColor("#FFD60A")
    private val fundo = Color.parseColor("#0B0B0B")
    private val cartao = Color.parseColor("#151515")
    private val tecla = Color.parseColor("#1A1A1A")
    private val linha = Color.parseColor("#2A2A2A")
    private val cinza = Color.parseColor("#A1A1AA")
    private val verde = Color.parseColor("#4ADE80")
    private val vermelho = Color.parseColor("#F87171")

    private enum class Modo { ENTRAR, CRIAR, CONFIRMAR }

    private val ui = Handler(Looper.getMainLooper())
    private val fecharSozinho = Runnable { voltarAoCaixa() }
    private lateinit var palco: FrameLayout
    private var digitado = StringBuilder()
    private var primeiroPin = ""
    private var modo = Modo.ENTRAR
    private var depoisDeCriar: (() -> Unit)? = null
    private lateinit var pontos: LinearLayout
    private lateinit var aviso: TextView
    private lateinit var titulo: TextView

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or WindowManager.LayoutParams.FLAG_SECURE)
        window.statusBarColor = fundo
        window.navigationBarColor = fundo
        palco = FrameLayout(this).apply { setBackgroundColor(fundo) }
        setContentView(palco)
        telaCheia()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { voltarAoCaixa() }
        })
        // sem PIN ainda: quiosque nunca foi ligado neste tablet, vai direto às opções
        if (Quiosque.temPin) telaPin(Modo.ENTRAR) else telaOpcoes()
    }

    override fun onResume() { super.onResume(); armarFechamento() }
    override fun onPause() { ui.removeCallbacks(fecharSozinho); super.onPause() }
    override fun onUserInteraction() { super.onUserInteraction(); armarFechamento() }
    /** Ninguém deixa a área do responsável aberta para o próximo cliente: fecha sozinha em 60 s parada. */
    private fun armarFechamento() { ui.removeCallbacks(fecharSozinho); ui.postDelayed(fecharSozinho, 60_000) }

    private fun telaCheia() {
        WindowCompat.setDecorFitsSystemWindows(window, true)
        val c = WindowInsetsControllerCompat(window, window.decorView)
        c.hide(WindowInsetsCompat.Type.systemBars())
        c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }
    override fun onWindowFocusChanged(hasFocus: Boolean) { super.onWindowFocusChanged(hasFocus); if (hasFocus) telaCheia() }

    private fun voltarAoCaixa(recarregar: Boolean = false) {
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT).putExtra("recarregar", recarregar))
        finish()
    }

    // ---------------------------------------------------------------- PIN
    private fun telaPin(m: Modo) {
        modo = m; digitado.clear()
        palco.removeAllViews()
        val col = coluna(360)
        col.gravity = Gravity.CENTER_HORIZONTAL

        col.addView(selo())
        titulo = texto(when (m) {
            Modo.ENTRAR -> "Área do responsável"
            Modo.CRIAR -> "Crie o PIN do quiosque"
            Modo.CONFIRMAR -> "Repita o PIN"
        }, 26, Color.WHITE, true).apply { gravity = Gravity.CENTER; setPadding(0, dp(20), 0, dp(6)) }
        col.addView(titulo, LinearLayout.LayoutParams(-1, -2))
        aviso = texto(subtitulo(), 15, cinza).apply { gravity = Gravity.CENTER; minLines = 2 }
        col.addView(aviso, LinearLayout.LayoutParams(-1, -2))

        pontos = LinearLayout(this).apply { gravity = Gravity.CENTER; orientation = LinearLayout.HORIZONTAL }
        col.addView(pontos, LinearLayout.LayoutParams(-1, dp(56)).apply { topMargin = dp(18); bottomMargin = dp(18) })
        desenharPontos()

        // teclado 3 x 4, mesmo tamanho e mesmo espaço entre todas as teclas
        val teclas = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK")
        val lado = dp(84); val vao = dp(18)
        for (l in 0 until 4) {
            val fila = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
            for (c in 0 until 3) {
                val t = teclas[l * 3 + c]
                fila.addView(teclaPin(t), LinearLayout.LayoutParams(lado, lado).apply {
                    if (c > 0) leftMargin = vao
                })
            }
            col.addView(fila, LinearLayout.LayoutParams(-1, -2).apply { if (l > 0) topMargin = vao })
        }

        val sair = texto(if (m == Modo.ENTRAR) "Voltar ao caixa" else "Cancelar", 16, cinza).apply {
            gravity = Gravity.CENTER; setPadding(dp(24), dp(14), dp(24), dp(14))
            setOnClickListener { if (m == Modo.ENTRAR) voltarAoCaixa() else telaOpcoes() }
        }
        col.addView(sair, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(22) })
        centralizar(col)
        mostrarEspera()
    }

    private fun subtitulo() = when (modo) {
        Modo.ENTRAR -> "Digite o PIN para mexer no quiosque."
        Modo.CRIAR -> "De 4 a 6 números. Guarde bem: sem ele, ninguém sai do quiosque."
        Modo.CONFIRMAR -> "Digite o mesmo PIN de novo para confirmar."
    }

    private fun teclaPin(t: String) = TextView(this).apply {
        text = t; gravity = Gravity.CENTER
        val ok = t == "OK"
        setTextColor(if (ok) Color.BLACK else Color.WHITE)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, if (t.length == 1 && t[0].isDigit()) 30f else 22f)
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(if (ok) amarelo else tecla); setStroke(dp(1), if (ok) amarelo else linha)
        }
        isClickable = true
        contentDescription = when (t) { "⌫" -> "Apagar"; "OK" -> "Confirmar"; else -> t }
        setOnClickListener {
            alpha = .55f; animate().alpha(1f).setDuration(160).start()
            when (t) {
                "⌫" -> if (digitado.isNotEmpty()) digitado.setLength(digitado.length - 1)
                "OK" -> confirmar()
                else -> if (digitado.length < 6) digitado.append(t)
            }
            if (t != "OK") { aviso.setTextColor(cinza); aviso.text = subtitulo() }
            desenharPontos()
        }
    }

    private fun desenharPontos() {
        pontos.removeAllViews()
        val n = maxOf(4, digitado.length)
        for (i in 0 until n) {
            val cheio = i < digitado.length
            pontos.addView(View(this).apply {
                background = GradientDrawable().apply {
                    shape = GradientDrawable.OVAL
                    setColor(if (cheio) amarelo else Color.TRANSPARENT); setStroke(dp(2), if (cheio) amarelo else linha)
                }
            }, LinearLayout.LayoutParams(dp(16), dp(16)).apply { leftMargin = dp(8); rightMargin = dp(8) })
        }
    }

    private fun erro(msg: String) {
        aviso.setTextColor(vermelho); aviso.text = msg
        digitado.clear(); desenharPontos()
        pontos.animate().translationX(dp(10).toFloat()).setDuration(60).withEndAction {
            pontos.animate().translationX(-dp(10).toFloat()).setDuration(60).withEndAction {
                pontos.animate().translationX(0f).setDuration(60).start()
            }.start()
        }.start()
    }

    private fun mostrarEspera() {
        val falta = Quiosque.esperaRestante()
        if (modo != Modo.ENTRAR || falta <= 0) return
        aviso.setTextColor(vermelho)
        aviso.text = "Muitas tentativas erradas. Tente de novo em ${(falta + 999) / 1000} s."
        ui.postDelayed({ if (modo == Modo.ENTRAR && !isFinishing) { if (Quiosque.esperaRestante() > 0) mostrarEspera() else { aviso.setTextColor(cinza); aviso.text = subtitulo() } } }, 1000)
    }

    private fun confirmar() {
        val pin = digitado.toString()
        when (modo) {
            Modo.ENTRAR -> {
                if (Quiosque.esperaRestante() > 0) { mostrarEspera(); return }
                if (pin.length < 4) return erro("O PIN tem pelo menos 4 números.")
                if (Quiosque.conferirPin(pin)) telaOpcoes()
                else if (Quiosque.esperaRestante() > 0) { digitado.clear(); desenharPontos(); mostrarEspera() }
                else erro("PIN errado. Tente de novo.")
            }
            Modo.CRIAR -> {
                if (pin.length < 4) return erro("Use de 4 a 6 números.")
                if (pin.toSet().size == 1 || "0123456789".contains(pin) || "9876543210".contains(pin)) return erro("Fácil demais de adivinhar. Escolha outro.")
                primeiroPin = pin; telaPin(Modo.CONFIRMAR)
            }
            Modo.CONFIRMAR -> {
                if (pin != primeiroPin) { primeiroPin = ""; telaPin(Modo.CRIAR); erro("Os dois PINs ficaram diferentes. Comece de novo."); return }
                Quiosque.definirPin(pin); primeiroPin = ""
                val depois = depoisDeCriar; depoisDeCriar = null
                if (depois != null) depois() else telaOpcoes("PIN salvo.")
            }
        }
    }

    // ---------------------------------------------------------------- opções
    private fun telaOpcoes(recado: String? = null) {
        modo = Modo.ENTRAR
        palco.removeAllViews()
        val scroll = ScrollView(this).apply { isFillViewport = true; isVerticalScrollBarEnabled = false }
        val externo = LinearLayout(this).apply { gravity = Gravity.CENTER_HORIZONTAL; orientation = LinearLayout.VERTICAL; setPadding(dp(24), dp(32), dp(24), dp(32)) }
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        externo.addView(col, LinearLayout.LayoutParams(minOf(dp(560), resources.displayMetrics.widthPixels - dp(48)), -2))
        scroll.addView(externo)
        palco.addView(scroll, FrameLayout.LayoutParams(-1, -1))

        val ligado = Quiosque.ligado
        val total = Quiosque.protecaoTotal()

        // cabeçalho: título à esquerda, situação à direita, na mesma linha de base
        val cab = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        cab.addView(texto("Modo quiosque", 28, Color.WHITE, true), LinearLayout.LayoutParams(0, -2, 1f))
        cab.addView(pilula(if (ligado) "Ligado" else "Desligado", if (ligado) verde else cinza))
        col.addView(cab)
        col.addView(texto("O tablet fica preso no PagNow, abre sozinho ao ligar e só sai com o PIN.", 15, cinza).apply { setPadding(0, dp(6), 0, 0) })
        if (recado != null) col.addView(texto(recado, 15, verde).apply { setPadding(0, dp(10), 0, 0) })

        // 1. ligar / desligar
        val b1 = bloco(col, "Quiosque")
        b1.addView(botao(if (ligado) "Desligar o quiosque" else "Ligar o quiosque", !ligado) {
            if (ligado) { Quiosque.desligar(this); telaOpcoes("Quiosque desligado. O tablet está livre.") }
            else if (!Quiosque.temPin) { depoisDeCriar = { Quiosque.ligar(); voltarAoCaixa() }; telaPin(Modo.CRIAR) }
            else { Quiosque.ligar(); voltarAoCaixa() }
        })
        b1.addView(linhaInfo(
            if (total) "Proteção total" else "Proteção básica",
            if (total) "Este tablet foi preparado para o PagNow: a barra do Android some e não há como sair sem o PIN."
            else "Neste tablet o Android pede para fixar o app. Para travar de verdade, prepare o tablet como mostra o guia de instalação.",
            if (total) verde else amarelo))
        Quiosque.doPainelEm?.let { quando ->
            b1.addView(texto("Última configuração vinda do Painel: ${dataBr(quando)}.", 13, cinza).apply { setPadding(0, dp(12), 0, 0) })
        }

        // 2. tela que abre
        val b2 = bloco(col, "Tela que abre")
        val par = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val atual = Quiosque.pagina
        listOf(Quiosque.PAGINA_CAIXA to "Autoatendimento", Quiosque.PAGINA_VENDEDOR to "Vendedor").forEachIndexed { i, (k, rot) ->
            val sel = k == atual
            par.addView(escolha(rot, sel) {
                if (!sel) { Quiosque.definirPagina(k); telaOpcoes("Pronto: o tablet abre em \"$rot\".") }
            }, LinearLayout.LayoutParams(0, dp(54), 1f).apply { if (i > 0) leftMargin = dp(10) })
        }
        b2.addView(par)

        // 3. acesso
        val b3 = bloco(col, "PIN")
        b3.addView(botao(if (Quiosque.temPin) "Trocar o PIN" else "Criar o PIN", false) { depoisDeCriar = null; telaPin(Modo.CRIAR) })

        // 4. manutenção
        val b4 = bloco(col, "Manutenção")
        if (ligado) b4.addView(botao("Ajustes do Android por ${Quiosque.PAUSA_MIN} minutos", false) {
            Quiosque.pausar(this)
            try { startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Throwable) {}
            finish()
        }.also { (it.layoutParams as LinearLayout.LayoutParams).topMargin = 0 })
        b4.addView(botao("Maquininha", false) { startActivity(Intent(this, MaquininhaActivity::class.java)) }
            .also { if (!ligado) (it.layoutParams as LinearLayout.LayoutParams).topMargin = 0 })
        b4.addView(botao("Recarregar o caixa", false) { voltarAoCaixa(recarregar = true) })
        if (ligado) b4.addView(texto("Nos ajustes, o quiosque volta a travar sozinho em ${Quiosque.PAUSA_MIN} minutos.", 13, cinza).apply { setPadding(0, dp(10), 0, 0) })

        if (total) {
            val b5 = bloco(col, "Liberar este tablet")
            b5.addView(texto("Tira o PagNow de administrador do tablet, para desinstalar ou usar o tablet em outra coisa. Para voltar à proteção total, é preciso preparar o tablet de novo.", 14, cinza))
            b5.addView(botao("Liberar este tablet", false, perigo = true) {
                AlertDialog.Builder(this)
                    .setTitle("Liberar este tablet?")
                    .setMessage("O quiosque é desligado e o PagNow deixa de ser administrador do tablet.")
                    .setNegativeButton("Cancelar", null)
                    .setPositiveButton("Liberar") { _, _ -> Quiosque.liberarAparelho(this); telaOpcoes("Tablet liberado.") }
                    .show()
            })
        }

        col.addView(botao("Voltar ao caixa", true) { voltarAoCaixa() }.also { (it.layoutParams as LinearLayout.LayoutParams).topMargin = dp(24) })
        col.addView(texto("PagNow ${BuildConfig.VERSION_NAME}", 12, Color.parseColor("#52525B")).apply { gravity = Gravity.CENTER; setPadding(0, dp(18), 0, 0) },
            LinearLayout.LayoutParams(-1, -2))
    }

    // ---------------------------------------------------------------- peças
    private fun coluna(larguraDp: Int) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        layoutParams = FrameLayout.LayoutParams(minOf(dp(larguraDp), resources.displayMetrics.widthPixels - dp(32)), -2, Gravity.CENTER)
    }
    private fun centralizar(v: View) {
        val s = ScrollView(this).apply { isFillViewport = true; isVerticalScrollBarEnabled = false }
        val f = FrameLayout(this)
        f.addView(v)
        s.addView(f, ViewGroup.LayoutParams(-1, -1))
        palco.addView(s, FrameLayout.LayoutParams(-1, -1))
    }

    /** Selo do símbolo: quadrado amarelo com cadeado desenhado em linhas (mesmo raio S/4 da marca). */
    private fun selo() = FrameLayout(this).apply {
        val s = dp(64)
        layoutParams = LinearLayout.LayoutParams(s, s)
        background = GradientDrawable().apply { setColor(amarelo); cornerRadius = s / 4f }
        val arco = View(context).apply {
            background = GradientDrawable().apply { setColor(Color.TRANSPARENT); setStroke(dp(4), fundo); cornerRadius = dp(9).toFloat() }
        }
        addView(arco, FrameLayout.LayoutParams(dp(20), dp(24), Gravity.CENTER_HORIZONTAL).apply { topMargin = dp(12) })
        val corpo = View(context).apply { background = GradientDrawable().apply { setColor(fundo); cornerRadius = dp(5).toFloat() } }
        addView(corpo, FrameLayout.LayoutParams(dp(30), dp(22), Gravity.CENTER_HORIZONTAL).apply { topMargin = dp(28) })
        contentDescription = "Cadeado"
    }

    private fun texto(t: String, sp: Int, cor: Int, negrito: Boolean = false) = TextView(this).apply {
        text = t; setTextColor(cor); setTextSize(TypedValue.COMPLEX_UNIT_SP, sp.toFloat())
        if (negrito) typeface = Typeface.create("sans-serif", Typeface.BOLD)
        setLineSpacing(0f, 1.15f)
    }

    private fun caixa(cor: Int, borda: Int, raio: Int) = GradientDrawable().apply {
        setColor(cor); cornerRadius = dp(raio).toFloat(); setStroke(dp(1), borda)
    }

    private fun botao(t: String, principal: Boolean, perigo: Boolean = false, acao: () -> Unit) = TextView(this).apply {
        text = t; gravity = Gravity.CENTER; setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        setTextColor(if (principal) Color.BLACK else if (perigo) vermelho else Color.WHITE)
        background = caixa(if (principal) amarelo else Color.parseColor("#1F1F1F"), if (principal) amarelo else if (perigo) Color.parseColor("#5B2424") else linha, 14)
        isClickable = true
        setOnClickListener { acao() }
        layoutParams = LinearLayout.LayoutParams(-1, dp(54)).apply { topMargin = dp(10) }
    }

    private fun escolha(t: String, sel: Boolean, acao: () -> Unit) = TextView(this).apply {
        text = t; gravity = Gravity.CENTER; setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        setTextColor(if (sel) amarelo else Color.WHITE)
        background = caixa(if (sel) Color.parseColor("#26230F") else Color.parseColor("#1F1F1F"), if (sel) amarelo else linha, 14)
        isClickable = true; isSelected = sel
        setOnClickListener { acao() }
    }

    private fun pilula(t: String, cor: Int) = TextView(this).apply {
        text = t; setTextColor(cor); setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        setPadding(dp(12), dp(5), dp(12), dp(5))
        background = caixa(Color.TRANSPARENT, cor, 99)
    }

    private fun linhaInfo(t: String, d: String, cor: Int) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        setPadding(0, dp(14), 0, 0)
        addView(View(context).apply { background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(cor) } },
            LinearLayout.LayoutParams(dp(10), dp(10)).apply { topMargin = dp(6); rightMargin = dp(10) })
        val txt = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        txt.addView(texto(t, 15, Color.WHITE, true))
        txt.addView(texto(d, 14, cinza).apply { setPadding(0, dp(2), 0, 0) })
        addView(txt, LinearLayout.LayoutParams(0, -2, 1f))
    }

    private fun bloco(pai: LinearLayout, titulo: String): LinearLayout {
        val b = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(16), dp(16), dp(16)); background = caixa(cartao, linha, 18)
        }
        b.addView(texto(titulo, 18, Color.WHITE, true).apply { setPadding(0, 0, 0, dp(10)) })
        pai.addView(b, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(16) })
        return b
    }

    /** O Painel manda a data em UTC ("2026-11-26T10:00:00Z"); mostra no horário do tablet. */
    private fun dataBr(iso: String): String = try {
        val ent = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
        SimpleDateFormat("dd/MM 'às' HH:mm", Locale("pt", "BR")).format(ent.parse(iso.take(19))!!)
    } catch (e: Throwable) { iso.take(16).replace('T', ' ') }
}
