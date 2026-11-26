package br.com.beep.caixa

import android.app.Activity
import android.app.ActivityManager
import android.app.AlarmManager
import android.app.PendingIntent
import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.os.UserManager
import android.provider.Settings
import org.json.JSONObject
import java.security.MessageDigest

/**
 * Modo quiosque: o tablet fica preso no PagNow.
 *
 * Dois níveis, conforme o tablet foi preparado:
 * - Proteção total (o PagNow é o "administrador do aparelho", ver AdminQuiosque): trava sem aviso,
 *   esconde a barra do Android, tira a tela de bloqueio, vira a tela inicial do tablet e mantém a tela
 *   ligada na tomada. Ninguém sai sem o PIN.
 * - Proteção básica (tablet comum): o Android "fixa" o app (pede confirmação uma vez) e o PagNow vira a
 *   tela inicial. Serve para teste; um cliente esperto consegue sair segurando Voltar + Recentes.
 *
 * A configuração fica guardada no próprio tablet (vale sem internet). O Painel pode mandar outra; ela é
 * aplicada quando o caixa recebe o catálogo e só se for mais nova que a última aplicada.
 */
object Quiosque {
    private const val PREFS = "pagnow_quiosque"
    const val PAGINA_CAIXA = "caixa"
    const val PAGINA_VENDEDOR = "vendedor"
    private const val BASE = "https://app.pagnow.com.br/"
    const val PAUSA_MIN = 5
    private const val MAX_ERROS = 5
    private const val ESPERA_ERROS_MS = 60_000L

    private lateinit var app: Context
    private val ui = Handler(Looper.getMainLooper())
    private val prefs get() = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun iniciar(ctx: Context) { app = ctx.applicationContext }

    val ligado get() = prefs.getBoolean("ligado", false)
    val temPin get() = !prefs.getString("pin", null).isNullOrEmpty()
    val pagina get() = prefs.getString("pagina", PAGINA_CAIXA) ?: PAGINA_CAIXA
    val url get() = if (pagina == PAGINA_VENDEDOR) BASE + "vendedor/" else BASE
    /** Data (texto ISO) da última configuração vinda do Painel, ou null se foi feita no tablet. */
    val doPainelEm: String? get() = prefs.getString("painel_em", null)

    val admin get() = ComponentName(app, AdminQuiosque::class.java)
    private val inicio get() = ComponentName(app, "br.com.beep.caixa.Inicio")
    private val dpm get() = app.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager

    /** O PagNow é o administrador do aparelho? (proteção total) */
    fun protecaoTotal(): Boolean = try { dpm.isDeviceOwnerApp(app.packageName) } catch (e: Throwable) { false }

    /** A pausa é contada no relógio desde que o tablet ligou; ao religar, o InicioReceiver encerra a pausa. */
    fun emPausa(): Boolean = SystemClock.elapsedRealtime() < prefs.getLong("pausa_ate", 0L)

    // ---------- PIN ----------
    private fun sha256(t: String) = MessageDigest.getInstance("SHA-256").digest(t.toByteArray()).joinToString("") { "%02x".format(it) }
    /** Mesmo cálculo do Painel: sha256("pagnow-quiosque:" + sal + ":" + pin). O sal é o id do caixa no Painel, ou "local". */
    private fun hashPin(pin: String, sal: String) = sha256("pagnow-quiosque:$sal:$pin")

    fun definirPin(pin: String) {
        prefs.edit().putString("sal", "local").putString("pin", hashPin(pin, "local")).apply()
    }

    /** Milissegundos que ainda faltam de espera por erros seguidos (0 = pode tentar). */
    fun esperaRestante(): Long {
        val ate = prefs.getLong("erro_ate", 0L)
        val falta = ate - System.currentTimeMillis()
        return if (falta > ESPERA_ERROS_MS) 0L else falta.coerceAtLeast(0L)
    }

    fun conferirPin(pin: String): Boolean {
        if (esperaRestante() > 0) return false
        val sal = prefs.getString("sal", "local") ?: "local"
        val ok = prefs.getString("pin", null) == hashPin(pin, sal)
        if (ok) prefs.edit().putInt("erros", 0).apply()
        else {
            val n = prefs.getInt("erros", 0) + 1
            val e = prefs.edit().putInt("erros", if (n >= MAX_ERROS) 0 else n)
            if (n >= MAX_ERROS) e.putLong("erro_ate", System.currentTimeMillis() + ESPERA_ERROS_MS)
            e.apply()
            Diag.log("quiosque: PIN errado ($n)")
        }
        return ok
    }

    // ---------- configuração ----------
    fun definirPagina(p: String) { prefs.edit().putString("pagina", if (p == PAGINA_VENDEDOR) PAGINA_VENDEDOR else PAGINA_CAIXA).apply() }

    fun ligar() {
        if (!temPin) return
        prefs.edit().putBoolean("ligado", true).apply()
        encerrarPausa()
        Diag.log("quiosque: ligado (${if (protecaoTotal()) "total" else "básica"})")
        // quem trava é o caixa, quando volta para a frente (MainActivity.onResume)
        habilitarInicio(true)
    }

    fun desligar(a: Activity) {
        prefs.edit().putBoolean("ligado", false).apply()
        encerrarPausa()
        soltar(a)
        Diag.log("quiosque: desligado")
    }

    /**
     * Configuração mandada pelo Painel (via site do caixa): {"ligado":bool,"pin_hash":"…","sal":"…","pagina":"caixa|vendedor","atualizado":"…"}.
     * Devolve true se mudou algo.
     */
    fun aplicarDoPainel(json: String?, a: Activity?): Boolean {
        val o = try { if (json.isNullOrBlank() || json == "null") return false else JSONObject(json) } catch (e: Throwable) { return false }
        val quando = o.optString("atualizado", "")
        if (quando.isEmpty() || quando == prefs.getString("painel_em", null)) return false
        val hash = o.optString("pin_hash", "")
        val sal = o.optString("sal", "")
        val querLigado = o.optBoolean("ligado", false)
        val e = prefs.edit().putString("painel_em", quando)
        if (hash.length == 64 && sal.isNotEmpty()) e.putString("pin", hash).putString("sal", sal)
        o.optString("pagina", "").takeIf { it == PAGINA_CAIXA || it == PAGINA_VENDEDOR }?.let { e.putString("pagina", it) }
        // ligar exige um PIN conhecido, senão ninguém sairia do quiosque
        val podeLigar = querLigado && (hash.length == 64 || temPin)
        e.putBoolean("ligado", podeLigar).remove("pausa_ate").apply()
        Diag.log("quiosque: configuração do Painel aplicada (ligado=$podeLigar)")
        if (a != null) { if (podeLigar) garantir(a) else soltar(a) }
        return true
    }

    fun estado(): JSONObject = JSONObject()
        .put("ligado", ligado).put("pin", temPin).put("pagina", pagina)
        .put("protecao", if (protecaoTotal()) "total" else "basica").put("pausa", emPausa())
        .put("painel", doPainelEm ?: JSONObject.NULL)

    // ---------- travar e soltar ----------
    /** Chamado sempre que o caixa volta para a frente: se o quiosque está ligado, trava. */
    fun garantir(a: Activity) {
        habilitarInicio(ligado)
        if (!ligado || emPausa()) return
        val total = protecaoTotal()
        if (total) politicas(true)
        if (!travado(a)) {
            try { a.startLockTask() } catch (e: Throwable) { Diag.log("quiosque: não travou: ${e.message}") }
        }
    }

    /** Ajustes do Android por alguns minutos (Wi-Fi, Bluetooth). Volta a travar sozinho. */
    fun pausar(a: Activity) {
        val fim = SystemClock.elapsedRealtime() + PAUSA_MIN * 60_000L
        prefs.edit().putLong("pausa_ate", fim).apply()
        soltar(a, manterInicio = true)
        Diag.log("quiosque: pausado por $PAUSA_MIN min")
        // alarme do sistema: traz o caixa de volta mesmo se o app tiver sido fechado durante a pausa
        try {
            val am = app.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, fim + 500, alarmePausa())
        } catch (_: Throwable) {}
        ui.removeCallbacksAndMessages(null)
        ui.postDelayed({ encerrarPausa(); voltarParaFrente() }, PAUSA_MIN * 60_000L + 500)
    }

    fun encerrarPausa() {
        prefs.edit().remove("pausa_ate").apply()
        try { (app.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(alarmePausa()) } catch (_: Throwable) {}
    }

    private fun alarmePausa(): PendingIntent = PendingIntent.getBroadcast(app, 7,
        Intent(app, InicioReceiver::class.java).setAction(FIM_PAUSA), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    const val FIM_PAUSA = "br.com.beep.caixa.FIM_PAUSA"

    private fun soltar(a: Activity, manterInicio: Boolean = false) {
        if (travado(a)) try { a.stopLockTask() } catch (_: Throwable) {}
        if (protecaoTotal()) politicas(false)
        if (!manterInicio) habilitarInicio(false)
    }

    /** Abre o caixa por cima de tudo (fim da pausa, tablet ligado, app atualizado). */
    fun voltarParaFrente() {
        if (!ligado) return
        try {
            app.startActivity(Intent(app, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
        } catch (e: Throwable) { Diag.log("quiosque: não abriu o caixa: ${e.message}") }
    }

    private fun travado(a: Activity): Boolean {
        val am = a.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        return am.lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE
    }

    /** O PagNow como tela inicial do tablet: o botão Início e o ligar do tablet caem nele. */
    private fun habilitarInicio(sim: Boolean) {
        val st = if (sim) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        try {
            if (app.packageManager.getComponentEnabledSetting(inicio) != st)
                app.packageManager.setComponentEnabledSetting(inicio, st, PackageManager.DONT_KILL_APP)
        } catch (_: Throwable) {}
    }

    /** Só com proteção total (PagNow administrador do aparelho). */
    private fun politicas(travar: Boolean) {
        val d = dpm; val c = admin
        try {
            d.setLockTaskPackages(c, arrayOf(app.packageName))
            if (Build.VERSION.SDK_INT >= 28) d.setLockTaskFeatures(c, DevicePolicyManager.LOCK_TASK_FEATURE_NONE)
            if (Build.VERSION.SDK_INT >= 23) {
                d.setKeyguardDisabled(c, travar)
                d.setStatusBarDisabled(c, travar)
            }
            if (travar) {
                val f = IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_HOME); addCategory(Intent.CATEGORY_DEFAULT) }
                d.addPersistentPreferredActivity(c, f, inicio)
                d.addUserRestriction(c, UserManager.DISALLOW_SAFE_BOOT)
                // tela sempre ligada na tomada (1 = carregador, 2 = USB, 4 = sem fio)
                d.setGlobalSetting(c, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, "7")
            } else {
                d.clearPackagePersistentPreferredActivities(c, app.packageName)
                d.clearUserRestriction(c, UserManager.DISALLOW_SAFE_BOOT)
            }
        } catch (e: Throwable) { Diag.log("quiosque: política falhou: ${e.message}") }
    }

    /**
     * Libera o tablet de vez: tira o PagNow de administrador do aparelho (para desinstalar ou usar o tablet
     * para outra coisa). Para voltar à proteção total é preciso preparar o tablet de novo.
     */
    fun liberarAparelho(a: Activity) {
        desligar(a)
        try {
            val d = dpm
            if (Build.VERSION.SDK_INT >= 23) { d.setKeyguardDisabled(admin, false); d.setStatusBarDisabled(admin, false) }
            d.setGlobalSetting(admin, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, "0")
            @Suppress("DEPRECATION") d.clearDeviceOwnerApp(app.packageName)
            Diag.log("quiosque: aparelho liberado (administrador removido)")
        } catch (e: Throwable) { Diag.log("quiosque: não liberou: ${e.message}") }
    }
}

/** Recebe o papel de "administrador do aparelho" (proteção total). Não pede nenhuma permissão extra. */
class AdminQuiosque : DeviceAdminReceiver()

/** Tablet ligou (ou o app foi atualizado): com o quiosque ligado, abre o caixa sozinho. */
class InicioReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        Quiosque.iniciar(ctx)
        Quiosque.encerrarPausa()
        if (Quiosque.ligado) {
            Diag.log("quiosque: ${intent.action?.substringAfterLast('.')} → abrindo o caixa")
            Quiosque.voltarParaFrente()
        }
    }
}
