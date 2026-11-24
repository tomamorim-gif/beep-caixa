// Testes das regras do Mercado Pago. Rodar: node --experimental-strip-types --test supabase/tests/mp.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assinaturaValida, cobrancaDaReferencia, dataOk, hmacHex, iguais, lerAssinatura, lerOrdem, lerPix, manifesto, motivo, reais, referencia } from "../functions/_shared/mp.ts";

test("lerOrdem: pedido aprovado com dados do cartão", () => {
  const o = lerOrdem({ id: "ORD01", status: "processed", external_reference: "beepabc", transactions: { payments: [{ id: "PAY01", status: "processed", status_detail: "accredited", amount: "12.50", paid_amount: "12.50", payment_method: { id: "master" }, reference: { id: "123" } }] } });
  assert.equal(o.status, "aprovado");
  assert.equal(o.bandeira, "master");
  assert.equal(o.valor_centavos, 1250);
  assert.equal(o.mp_payment_id, "PAY01");
  assert.equal(o.external_reference, "beepabc");
});

test("lerOrdem: todos os status do Mercado Pago", () => {
  const m: Record<string, string> = { created: "aguardando", at_terminal: "na_maquininha", processed: "aprovado", failed: "recusado", canceled: "cancelado", expired: "expirado", refunded: "estornado", action_required: "verificar", qualquer: "aguardando" };
  for (const [mp, nosso] of Object.entries(m)) assert.equal(lerOrdem({ status: mp }).status, nosso, mp);
  assert.equal(lerOrdem({}).valor_centavos, null);
});

test("valor em centavos sem erro de arredondamento", () => {
  assert.equal(reais(1999), "19.99");
  assert.equal(lerOrdem({ transactions: { payments: [{ amount: "0.29" }] } }).valor_centavos, 29);
  assert.equal(lerOrdem({ transactions: { payments: [{ amount: "1234.56" }] } }).valor_centavos, 123456);
});

test("referência externa vai e volta", () => {
  const id = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  assert.equal(cobrancaDaReferencia(referencia(id)), id);
  assert.equal(cobrancaDaReferencia("outra"), null);
  assert.equal(cobrancaDaReferencia(null), null);
});

test("manifesto do webhook segue o modelo oficial", () => {
  assert.equal(manifesto("ORD01ABC", "req-1", "1704908010"), "id:ord01abc;request-id:req-1;ts:1704908010;");
  assert.equal(manifesto("ORD01", "", "1704908010"), "id:ord01;ts:1704908010;");
});

test("assinatura: aceita a certa e recusa adulterada", async () => {
  const segredo = "segredo-de-teste-123", ts = "1704908010";
  const v1 = await hmacHex(segredo, manifesto("ORD01", "req-1", ts));
  const cab = `ts=${ts},v1=${v1}`;
  assert.deepEqual(lerAssinatura(cab), { ts, v1 });
  assert.equal(await assinaturaValida({ segredo, cabecalho: cab, requestId: "req-1", dataId: "ORD01" }), true);
  assert.equal(await assinaturaValida({ segredo, cabecalho: cab, requestId: "req-1", dataId: "ORD02" }), false, "outro pedido");
  assert.equal(await assinaturaValida({ segredo, cabecalho: cab, requestId: "req-2", dataId: "ORD01" }), false, "outro request-id");
  assert.equal(await assinaturaValida({ segredo: "outro", cabecalho: cab, requestId: "req-1", dataId: "ORD01" }), false, "outro segredo");
  assert.equal(await assinaturaValida({ segredo: "", cabecalho: cab, requestId: "req-1", dataId: "ORD01" }), false, "sem segredo");
  assert.equal(await assinaturaValida({ segredo, cabecalho: null, requestId: "req-1", dataId: "ORD01" }), false, "sem cabeçalho");
  // janela de tempo opcional
  assert.equal(await assinaturaValida({ segredo, cabecalho: cab, requestId: "req-1", dataId: "ORD01", toleranciaSeg: 300, agoraMs: 1704908010_000 + 60_000 }), true);
  assert.equal(await assinaturaValida({ segredo, cabecalho: cab, requestId: "req-1", dataId: "ORD01", toleranciaSeg: 300, agoraMs: 1704908010_000 + 3600_000 }), false);
});

test("comparação em tempo constante", () => {
  assert.equal(iguais("abc", "abc"), true);
  assert.equal(iguais("abc", "abd"), false);
  assert.equal(iguais("abc", "abcd"), false);
});

test("motivos de recusa em português", () => {
  assert.equal(motivo("insufficient_amount", "recusado"), "Saldo ou limite insuficiente");
  assert.equal(motivo(null, "expirado"), "Tempo esgotado na maquininha");
  assert.equal(motivo(null, "aprovado"), "");
});

test("datas do tablet", () => {
  const agora = Date.parse("2026-11-23T12:00:00Z");
  assert.equal(dataOk("2026-11-23T11:59:00Z", agora), "2026-11-23T11:59:00.000Z");
  assert.equal(dataOk("lixo", agora), null);
  assert.equal(dataOk("2030-01-01T00:00:00Z", agora), null);
  assert.equal(dataOk(123, agora), null);
});

test("Pix: esperando pagamento é espera, vencido é tempo esgotado", () => {
  assert.equal(lerOrdem({ status: "action_required", transactions: { payments: [{ status_detail: "waiting_transfer" }] } }).status, "aguardando");
  assert.equal(lerOrdem({ status: "action_required", status_detail: "waiting_payment" }).status, "aguardando");
  assert.equal(lerOrdem({ status: "action_required", status_detail: "outra_coisa" }).status, "verificar");
  assert.equal(lerOrdem({ status: "failed", status_detail: "expired" }).status, "expirado");
  assert.equal(lerOrdem({ status: "canceled", status_detail: "expired" }).status, "expirado");
  assert.equal(lerOrdem({ status: "failed", status_detail: "rejected_by_bank" }).status, "recusado");
  const pago = lerOrdem({ status: "processed", transactions: { payments: [{ id: "PAY9", status_detail: "accredited", amount: "3.50", payment_method: { id: "pix", type: "bank_transfer" } }] } });
  assert.equal(pago.status, "aprovado");
  assert.equal(pago.valor_centavos, 350);
  assert.equal(motivo("waiting_transfer", "aguardando"), "Aguardando o Pix");
});

test("lerPix: pega o QR e recusa imagem estranha", () => {
  const img = "iVBORw0KGgo" + "A".repeat(200);
  const p = lerPix({ transactions: { payments: [{ payment_method: { qr_code: "00020101021226", qr_code_base64: img } }] } });
  assert.equal(p.qr, "00020101021226");
  assert.equal(p.img, img);
  assert.equal(lerPix({ transactions: { payments: [{ payment_method: { qr_code_base64: "<script>" } }] } }).img, null);
  assert.deepEqual(lerPix({}), { qr: null, img: null });
});
