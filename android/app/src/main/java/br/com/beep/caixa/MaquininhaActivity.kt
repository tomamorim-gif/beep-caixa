package br.com.beep.caixa

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Configuração da maquininha: permissões, escolher a Minizinha, conta PagBank e cobrança de teste. */
class MaquininhaActivity : AppCompatActivity() {
    private val amarelo = Color.parseColor("#FFD60A")
    private val fundo = Color.parseColor("#0B0B0B")
    private val cartao = Color.parseColor("#151515")
    private val linha = Color.parseColor("#2A2A2A")
    private val cinza = Color.parseColor("#A1A1AA")
    private val verde = Color.parseColor("#4ADE80")
    private val vermelho = Color.parseColor("#F87171")

    private lateinit var raiz: LinearLayout
    private lateinit var listaAparelhos: LinearLayout
    private lateinit var txtConta: TextView
    private lateinit var btnConta: Button
    private lateinit var log: TextView
    private lateinit var btnCred: Button
    private lateinit var btnDeb: Button
    private lateinit var btnPerm: Button
    private lateinit var chkAcordada: android.widget.Switch
    private lateinit var txtBt: TextView
    private lateinit var txtPronto: TextView
    private var autenticado = false

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = fundo
        window.navigationBarColor = fundo
        val scroll = ScrollView(this).apply { setBackgroundColor(fundo); isFillViewport = true }
        raiz = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(24), dp(20), dp(32)) }
        scroll.addView(raiz)
        setContentView(scroll)

        raiz.addView(texto("Maquininha", 28, Color.WHITE, true))
        raiz.addView(texto("Configure a Minizinha deste caixa e faça uma cobrança de teste.", 15, cinza).apply { setPadding(0, dp(4), 0, dp(18)) })

        // 1. permissões
        btnPerm = botao("Permitir Bluetooth", true) { pedirPermissoes() }
        raiz.addView(btnPerm)
        txtBt = texto("Bluetooth do telefone desligado. Ligue para usar a maquininha.", 14, vermelho).apply { setPadding(0, dp(10), 0, 0) }
        raiz.addView(txtBt)

        // 2. aparelho
        val c1 = bloco("1. Escolha a maquininha")
        c1.addView(texto("Primeiro pareie a Minizinha no Bluetooth do telefone. Para ver o PIN, aperte o botão 0 na maquininha.", 14, cinza).apply { setPadding(0, 0, 0, dp(10)) })
        listaAparelhos = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        c1.addView(listaAparelhos)
        c1.addView(botao("Abrir Bluetooth do telefone", false) { startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS)) })
        c1.addView(botao("Testar conexão", false) {
            anotar("Testando conexão…")
            Pagamento.testarConexao { e -> anotar(if (e == null) "✅ Maquininha conectada e acordada" else "❌ $e") }
        })
        chkAcordada = android.widget.Switch(this).apply {
            text = "Manter maquininha acordada (ligue só depois que a cobrança de teste funcionar)"
            setTextColor(Color.WHITE); setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            isChecked = Pagamento.manterAcordadaLigado
            setPadding(0, dp(14), 0, dp(4))
            setOnCheckedChangeListener { _, v -> Pagamento.manterAcordadaLigado = v; anotar(if (v) "Manter acordada: ligado" else "Manter acordada: desligado") }
        }
        c1.addView(chkAcordada)
        c1.addView(texto("Isso evita o modo descanso enquanto ela estiver ligada. Se a Minizinha desligar de vez (bateria ou botão), só o botão dela religa — deixe-a no carregador.", 12, cinza))

        // 3. conta
        val c2 = bloco("2. Conta PagBank (só se a cobrança pedir)")
        txtConta = texto("Verificando…", 15, cinza)
        c2.addView(txtConta)
        btnConta = botao("Entrar na conta PagBank", true) { alternarConta() }
        c2.addView(btnConta)
        c2.addView(texto("Teste primeiro a cobrança sem login. Só entre na conta se aparecer \"conta PagBank não conectada\". O login é na tela do próprio PagBank; a senha não passa pelo Beep. Se a tela dele travar no Entrar, toque em voltar.", 12, cinza).apply { setPadding(0, dp(8), 0, 0) })

        // 4. teste
        val c3 = bloco("3. Cobrança de teste — R$ 1,00")
        c3.addView(texto("Cobra R$ 1,00 de verdade no seu cartão (cai na sua conta PagBank). Serve só para confirmar que a maquininha responde ao sistema.", 14, cinza).apply { setPadding(0, 0, 0, dp(10)) })
        val fila = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        btnCred = botao("Crédito", true) { testar("credito") }
        btnDeb = botao("Débito", false) { testar("debito") }
        fila.addView(btnCred, LinearLayout.LayoutParams(0, dp(54), 1f).apply { marginEnd = dp(6) })
        fila.addView(btnDeb, LinearLayout.LayoutParams(0, dp(54), 1f).apply { marginStart = dp(6) })
        c3.addView(fila)
        txtPronto = texto("", 13, cinza).apply { setPadding(0, dp(8), 0, 0) }
        c3.addView(txtPronto)
        c3.addView(botao("Cancelar / destravar", false) { Pagamento.destravar(); anotar("Cancelado e destravado"); atualizar() })
        log = TextView(this).apply {
            setTextColor(Color.parseColor("#E4E4E7")); setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f); typeface = Typeface.MONOSPACE
            setPadding(dp(12), dp(12), dp(12), dp(12)); background = caixa(Color.parseColor("#0F0F0F"), linha, 12)
            text = "Aguardando…"; setTextIsSelectable(true)
        }
        c3.addView(log, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) })
        c3.addView(botao("Diagnóstico completo", false) {
            anotar("Rodando diagnóstico…")
            Pagamento.diagnostico { d -> anotar("\n$d") }
        })

        raiz.addView(botao("Voltar ao caixa", false) { finish() }.apply { (layoutParams as? LinearLayout.LayoutParams)?.topMargin = dp(18) })
        raiz.addView(texto("App ${BuildConfig.VERSION_NAME} · PlugPag ${Pagamento.versaoBiblioteca()}", 12, cinza).apply { gravity = Gravity.CENTER; setPadding(0, dp(18), 0, 0) })
    }

    override fun onResume() {
        super.onResume()
        Pagamento.aoAnotar = { m -> anotar(m) }
        Pagamento.loginFechadoSemResposta()
        atualizar()
    }

    override fun onPause() {
        Pagamento.aoAnotar = null
        super.onPause()
    }

    private fun permissoesFaltando(): List<String> {
        val l = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) { l += Manifest.permission.BLUETOOTH_CONNECT; l += Manifest.permission.BLUETOOTH_SCAN }
        else l += Manifest.permission.ACCESS_FINE_LOCATION
        l += Manifest.permission.READ_PHONE_STATE
        if (Build.VERSION.SDK_INT >= 33) l += Manifest.permission.READ_MEDIA_AUDIO
        return l.filter { ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED }
    }

    private fun pedirPermissoes() {
        val f = permissoesFaltando()
        if (f.isNotEmpty()) ActivityCompat.requestPermissions(this, f.toTypedArray(), 7)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        atualizar()
    }

    private fun atualizar() {
        val falta = permissoesFaltando()
        btnPerm.visibility = if (falta.isEmpty()) View.GONE else View.VISIBLE
        txtBt.visibility = if (Pagamento.bluetoothLigado()) View.GONE else View.VISIBLE
        if (falta.isNotEmpty()) btnPerm.text = "Permitir Bluetooth e acesso à maquininha"
        // aparelhos
        listaAparelhos.removeAllViews()
        val lista = Pagamento.aparelhosPareados()
        if (lista.isEmpty()) listaAparelhos.addView(texto(if (falta.isEmpty()) "Nenhum aparelho pareado ainda." else "Permita o Bluetooth para ver os aparelhos.", 14, vermelho).apply { setPadding(0, 0, 0, dp(8)) })
        for ((nome, end) in lista) {
            val sel = end == Pagamento.maquininhaEndereco
            val b = Button(this).apply {
                text = (if (sel) "✓  " else "") + nome
                isAllCaps = false
                setTextColor(if (sel) Color.BLACK else Color.WHITE)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                gravity = Gravity.START or Gravity.CENTER_VERTICAL
                setPadding(dp(16), 0, dp(16), 0)
                background = caixa(if (sel) amarelo else Color.parseColor("#1C1C1C"), if (sel) amarelo else linha, 14)
                stateListAnimator = null
                setOnClickListener { Pagamento.maquininhaEndereco = end; Pagamento.maquininhaNome = nome; anotar("Maquininha escolhida: $nome"); atualizar() }
            }
            listaAparelhos.addView(b, LinearLayout.LayoutParams(-1, dp(54)).apply { bottomMargin = dp(8) })
        }
        // conta
        Pagamento.autenticado { ok ->
            autenticado = ok
            txtConta.text = if (ok) "● Conta conectada" else "○ Conta não conectada"
            txtConta.setTextColor(if (ok) verde else cinza)
            btnConta.text = if (ok) "Sair da conta PagBank" else "Entrar na conta PagBank"
        }
        val pronto = Pagamento.maquininhaEndereco != null && !Pagamento.cobrando
        txtPronto.text = when {
            Pagamento.maquininhaEndereco == null -> "Toque na maquininha no passo 1 para liberar a cobrança."
            Pagamento.cobrando -> "Cobrança em andamento. Se travou, toque em Cancelar / destravar."
            else -> ""
        }
        txtPronto.visibility = if (txtPronto.text.isNullOrEmpty()) View.GONE else View.VISIBLE
        btnCred.isEnabled = pronto; btnDeb.isEnabled = pronto
        btnCred.alpha = if (pronto) 1f else .45f; btnDeb.alpha = if (pronto) 1f else .45f
    }

    private fun alternarConta() {
        btnConta.isEnabled = true
        if (autenticado) Pagamento.sairDaConta { anotar("Conta desconectada"); atualizar() }
        else { anotar("Abrindo login do PagBank…"); Pagamento.entrarNaConta { ok -> anotar(if (ok) "Conta conectada" else "Login não concluído"); atualizar() } }
    }

    private fun testar(forma: String) {
        log.text = ""
        anotar("Iniciando teste de R$ 1,00 no ${if (forma == "debito") "débito" else "crédito"}…")
        btnCred.isEnabled = false; btnDeb.isEnabled = false
        Pagamento.cobrar(100, forma, "TESTE1",
            evento = { m -> anotar("» $m") },
            fim = { r ->
                if (r.optBoolean("ok")) {
                    anotar("✅ APROVADO  ${r.optString("bandeira")}  NSU ${r.optString("nsu")}  aut ${r.optString("autorizacao")}  cód ${r.optString("transacao")}")
                    log.setTextColor(verde)
                } else {
                    anotar("❌ ${r.optString("mensagem")} (código ${r.optString("codigo")})")
                    log.setTextColor(vermelho)
                }
                atualizar()
            })
    }

    private fun anotar(m: String) {
        val h = SimpleDateFormat("HH:mm:ss", Locale("pt", "BR")).format(Date())
        log.setTextColor(Color.parseColor("#E4E4E7"))
        log.text = if (log.text.isNullOrBlank() || log.text == "Aguardando…") "$h  $m" else "${log.text}\n$h  $m"
    }

    // ---------- visual ----------
    private fun caixa(cor: Int, borda: Int, raio: Int) = GradientDrawable().apply { setColor(cor); cornerRadius = dp(raio).toFloat(); setStroke(dp(1), borda) }

    private fun texto(t: String, sp: Int, cor: Int, negrito: Boolean = false) = TextView(this).apply {
        text = t; setTextColor(cor); setTextSize(TypedValue.COMPLEX_UNIT_SP, sp.toFloat())
        if (negrito) typeface = Typeface.create("sans-serif", Typeface.BOLD)
        setLineSpacing(0f, 1.15f)
    }

    private fun botao(t: String, principal: Boolean, acao: () -> Unit) = Button(this).apply {
        text = t; isAllCaps = false; setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        setTextColor(if (principal) Color.BLACK else Color.WHITE)
        background = caixa(if (principal) amarelo else Color.parseColor("#1F1F1F"), if (principal) amarelo else linha, 14)
        stateListAnimator = null
        setOnClickListener { acao() }
        layoutParams = LinearLayout.LayoutParams(-1, dp(54)).apply { topMargin = dp(10) }
    }

    private fun bloco(titulo: String): LinearLayout {
        val b = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(16), dp(16), dp(16)); background = caixa(cartao, linha, 18)
        }
        b.addView(texto(titulo, 18, Color.WHITE, true).apply { setPadding(0, 0, 0, dp(8)) })
        raiz.addView(b, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(14) })
        return b
    }
}
