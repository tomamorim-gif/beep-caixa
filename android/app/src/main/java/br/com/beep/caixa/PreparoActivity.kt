package br.com.beep.caixa

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.Intent
import android.os.Bundle

/**
 * Preparação do tablet por QR code (Android 10 ou mais novo): o assistente de configuração do Android
 * pergunta ao PagNow em que modo ele quer ficar e se terminou de se configurar.
 * Resposta: "aparelho dedicado" (o PagNow como administrador = proteção total do quiosque).
 */
class PreparoActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        when (intent?.action) {
            DevicePolicyManager.ACTION_GET_PROVISIONING_MODE -> {
                setResult(RESULT_OK, Intent().putExtra(DevicePolicyManager.EXTRA_PROVISIONING_MODE, DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE))
            }
            DevicePolicyManager.ACTION_ADMIN_POLICY_COMPLIANCE -> {
                Diag.log("quiosque: tablet preparado (PagNow administrador do aparelho)")
                setResult(RESULT_OK)
            }
            else -> setResult(RESULT_CANCELED)
        }
        finish()
    }
}
