package br.com.beep.caixa

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Diagnóstico remoto: manda os passos da maquininha e os travamentos da tela para o servidor,
 * para o suporte ver o que aconteceu sem precisar de print. Não envia dados de cartão nem senha.
 */
object Diag {
    private const val URL_LOG = "https://gdnvjpmpfgautrmtkjmx.supabase.co/functions/v1/app-log"
    private val fila = ConcurrentLinkedQueue<String>()
    private val envio = Executors.newSingleThreadScheduledExecutor()
    private val vigia = Executors.newSingleThreadScheduledExecutor()
    private val ui = Handler(Looper.getMainLooper())
    private var aparelho = "?"
    @Volatile private var ultimoPulso = SystemClock.elapsedRealtime()
    @Volatile private var avisouTravada = false

    fun iniciar(ctx: Context) {
        aparelho = try { "a-" + (Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID) ?: "?").take(10) } catch (e: Throwable) { "?" }
        log("app aberto · ${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL} · Android ${android.os.Build.VERSION.RELEASE}")
        envio.scheduleWithFixedDelay({ enviar() }, 3, 3, TimeUnit.SECONDS)
        // vigia da tela: se a thread principal ficar 4 s sem responder, registra onde ela está parada
        vigia.scheduleWithFixedDelay({
            ui.post { ultimoPulso = SystemClock.elapsedRealtime(); if (avisouTravada) { avisouTravada = false; log("tela voltou a responder") } }
            val parada = SystemClock.elapsedRealtime() - ultimoPulso
            if (parada > 4000 && !avisouTravada) {
                avisouTravada = true
                val pilha = Looper.getMainLooper().thread.stackTrace.take(25).joinToString("\n  ") { it.toString() }
                log("TELA TRAVADA há ${parada / 1000}s em:\n  $pilha")
            }
        }, 2, 1, TimeUnit.SECONDS)
        val anterior = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            log("FECHOU COM ERRO na thread ${t.name}: ${e}\n  " + e.stackTrace.take(20).joinToString("\n  "))
            try { enviar() } catch (_: Throwable) {}
            anterior?.uncaughtException(t, e)
        }
    }

    fun log(m: String) {
        val h = SimpleDateFormat("HH:mm:ss", Locale("pt", "BR")).format(Date())
        fila.add("$h $m")
        while (fila.size > 300) fila.poll()
    }

    private fun enviar() {
        if (fila.isEmpty()) return
        val lote = JSONArray()
        while (lote.length() < 50) { val l = fila.poll() ?: break; lote.put(l) }
        try {
            val c = URL(URL_LOG).openConnection() as HttpURLConnection
            c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 8000; c.readTimeout = 8000
            c.setRequestProperty("Content-Type", "application/json")
            val corpo = JSONObject().put("app", "beep-caixa").put("aparelho", aparelho).put("versao", BuildConfig.VERSION_NAME).put("linhas", lote)
            c.outputStream.use { it.write(corpo.toString().toByteArray()) }
            c.responseCode
            c.disconnect()
        } catch (e: Throwable) {
            // sem internet: devolve para a fila e tenta depois
            for (i in 0 until lote.length()) fila.add(lote.getString(i))
        }
    }
}
