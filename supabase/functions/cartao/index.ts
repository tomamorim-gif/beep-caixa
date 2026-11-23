// Cobrança no cartão pela maquininha Mercado Pago Point (API Orders).
// - O token do Mercado Pago de cada empresa fica só no servidor (cadastrado pelo dono no Painel); o tablet nunca o vê.
// - O valor cobrado é sempre o total calculado aqui, com os preços da loja.
// - A venda só é gravada quando o Mercado Pago confirma o pagamento (pela consulta ou pelo aviso/webhook),
//   numa única transação no banco (gravar_venda_cartao), uma vez só.
// - Toda chamada que cria ou muda algo no Mercado Pago leva uma chave de idempotência fixa por cobrança:
//   repetir a chamada (rede caiu, toque duplo) nunca cria uma segunda cobrança na maquininha.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ABERTOS, FINAIS, assinaturaValida, cobrancaDaReferencia, dataOk, lerOrdem, motivo, reais, referencia } from "../_shared/mp.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const MP = "https://api.mercadopago.com";
const TESTE = () => Deno.env.get("MP_POINT_TEST_MODE") === "true";
// Credencial global (segredos MP_ACCESS_TOKEN / MP_WEBHOOK_SECRET) só vale se ligada de propósito.
// Desligada, uma empresa sem credencial própria nunca cobra na conta de outra.
const GLOBAL = () => Deno.env.get("MP_PERMITIR_CREDENCIAL_GLOBAL") === "true";
const TERMINAL_VIRTUAL = "NEWLAND_N950__SBX0000001";
const EXPIRA = "PT3M"; // a maquininha desiste sozinha depois de 3 minutos
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const erro = (m: string, s = 400, extra: Record<string, unknown> = {}) => json({ erro: m, ...extra }, s);
const uuidOk = (s: unknown) => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const agora = () => new Date().toISOString();

// ---------- credencial de cada empresa ----------
const credCache = new Map<string, { token: string; segredo: string; t: number }>();
async function credencial(empresaId: string) {
  const c = credCache.get(empresaId);
  if (c && Date.now() - c.t < 60_000) return c;
  const { data } = await db.from("integracoes_pagamento").select("access_token, webhook_secret").eq("empresa_id", empresaId).eq("provedor", "mercadopago").maybeSingle();
  const g = GLOBAL();
  const r = {
    token: (data?.access_token ?? (g ? Deno.env.get("MP_ACCESS_TOKEN") : "") ?? "").trim(),
    segredo: (data?.webhook_secret ?? (g ? Deno.env.get("MP_WEBHOOK_SECRET") : "") ?? "").trim(),
    t: Date.now(),
  };
  credCache.set(empresaId, r);
  return r;
}

async function sha256(t: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function aparelho(req: Request) {
  const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (tok.length < 40) return null;
  const { data } = await db.from("dispositivos").select("id, empresa_id, local_id, nome, ativo, mp_terminal_id").eq("token_hash", await sha256(tok)).maybeSingle();
  return data && data.ativo ? data : null;
}

// chamada ao Mercado Pago com tempo limite; status 0 = sem resposta (não sabemos se chegou)
async function mp(tk: string, path: string, init: RequestInit = {}, idem?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${tk}`, "Content-Type": "application/json", ...(init.headers as Record<string, string> ?? {}) };
  if (idem) headers["X-Idempotency-Key"] = idem;
  try {
    const r = await fetch(MP + path, { ...init, headers, signal: AbortSignal.timeout(12_000) });
    const corpo = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, corpo };
  } catch (e) {
    return { ok: false, status: 0, corpo: { message: "sem resposta do Mercado Pago: " + String((e as Error)?.message ?? e).slice(0, 120) } };
  }
}
const msgMp = (r: { status: number; corpo: any }) => String(r.corpo?.errors?.[0]?.message ?? r.corpo?.message ?? `erro ${r.status}`).slice(0, 300);

// preços sempre do servidor
async function calcular(d: any, itensIn: any[]) {
  const itens = Array.isArray(itensIn) ? itensIn.slice(0, 100) : [];
  if (!itens.length) return { erro: "Carrinho vazio" };
  const ids = itens.map((i: any) => i.produto_id).filter(uuidOk);
  const { data: precos } = await db.from("precos_local").select("produto_id, preco, produtos!inner(custo, empresa_id)").eq("local_id", d.local_id).in("produto_id", ids);
  const mapa = new Map((precos ?? []).map((p: any) => [p.produto_id, p]));
  let total = 0;
  const linhas: any[] = [];
  for (const [k, i] of itens.entries()) {
    const p: any = mapa.get(i.produto_id);
    const q = Number(i.quantidade);
    if (!p || p.produtos.empresa_id !== d.empresa_id) return { erro: "Produto sem preço nesta loja" };
    if (!Number.isInteger(q) || q <= 0 || q > 99) return { erro: "Quantidade inválida" };
    total += p.preco * q;
    linhas.push({ seq: k + 1, produto_id: i.produto_id, quantidade: q, preco_unit: p.preco, custo_unit: p.produtos.custo });
  }
  if (total < 100) return { erro: "Valor mínimo no cartão: R$ 1,00" };
  return { total, linhas };
}

const ehTeste = (c: any) => TESTE() || c.terminal_id === TERMINAL_VIRTUAL;

// grava a venda (transação única no banco; repetir é seguro)
async function gravarVenda(c: any) {
  const { data, error } = await db.rpc("gravar_venda_cartao", { p_cobranca: c.id, p_teste: ehTeste(c) });
  if (error) {
    await db.from("cobrancas_cartao").update({ erro: ("falha ao gravar venda: " + error.message).slice(0, 300), atualizado_em: agora() }).eq("id", c.id);
    return c;
  }
  if (data === "nao_encontrada" || data === "nao_aprovada") return c;
  const { data: c2 } = await db.from("cobrancas_cartao").select("*").eq("id", c.id).single();
  return c2 ?? c;
}

// aplica o que o Mercado Pago disse sobre o pedido
async function aplicarOrdem(c: any, ordem: any) {
  const o = lerOrdem(ordem);
  // estorno (pelo Painel ou direto no Mercado Pago) vale sempre
  if (o.status === "estornado") {
    if (c.status === "estornado") return c;
    await db.rpc("estornar_venda_cartao", { p_cobranca: c.id, p_usuario: null });
    const { data } = await db.from("cobrancas_cartao").select("*").eq("id", c.id).single();
    return data ?? c;
  }
  // separada para conferência manual: não muda mais sozinha
  if (c.status_detail === "valor_divergente" || c.status_detail === "pagamento_em_dobro") return c;
  // um pedido aprovado com valor diferente do que cobramos nunca vira venda
  if (o.status === "aprovado" && o.valor_centavos != null && o.valor_centavos !== c.valor) {
    const { data } = await db.from("cobrancas_cartao").update({ status: "falhou", status_detail: "valor_divergente", mp_payment_id: o.mp_payment_id, erro: `Conferir e estornar no Mercado Pago: pago ${o.valor_centavos}, cobrado ${c.valor} (centavos)`, atualizado_em: agora() }).eq("id", c.id).select("*").single();
    return data ?? c;
  }
  if (c.status === o.status && c.status_detail === o.status_detail && c.mp_payment_id === o.mp_payment_id) return c;
  // uma cobrança terminada não muda, com uma exceção: o Mercado Pago aprovou (o dinheiro entrou de verdade),
  // mesmo que aqui ela tenha sido dada como cancelada ou sem resposta
  if (FINAIS.has(c.status) && !(o.status === "aprovado" && c.status !== "aprovado")) return c;
  const { data, error } = await db.from("cobrancas_cartao").update({
    status: o.status, status_detail: o.status_detail, mp_payment_id: o.mp_payment_id ?? c.mp_payment_id, bandeira: o.bandeira ?? c.bandeira,
    autorizacao: o.autorizacao ?? c.autorizacao, nsu: o.nsu ?? c.nsu, atualizado_em: agora(),
  }).eq("id", c.id).select("*").single();
  if (error?.code === "23505") {
    // outra cobrança desta mesma venda já foi aprovada: o cliente pagou duas vezes
    const { data: d2 } = await db.from("cobrancas_cartao").update({ status: "falhou", status_detail: "pagamento_em_dobro", mp_payment_id: o.mp_payment_id, erro: "Segundo pagamento aprovado para a mesma compra: estornar no Mercado Pago", atualizado_em: agora() }).eq("id", c.id).select("*").single();
    return d2 ?? c;
  }
  return data ?? c;
}

// consulta o Mercado Pago (se ainda não terminou, ou sempre quando "forcar"), atualiza e grava a venda quando aprovada
async function atualizar(c: any, tk: string, forcar = false) {
  if (c.mp_order_id && (forcar || !FINAIS.has(c.status))) {
    const r = await mp(tk, `/v1/orders/${encodeURIComponent(c.mp_order_id)}`);
    if (r.ok) c = await aplicarOrdem(c, r.corpo);
  }
  if (c.status === "aprovado" && !c.venda_gravada) c = await gravarVenda(c);
  return c;
}

// cria (ou reencontra) o pedido na maquininha. Mesmo corpo + mesma chave = mesmo pedido.
function corpoOrdem(c: any) {
  return JSON.stringify({
    type: "point",
    external_reference: referencia(c.id),
    description: "Compra Beep",
    expiration_time: EXPIRA,
    transactions: { payments: [{ amount: reais(c.valor) }] },
    config: { point: { terminal_id: c.terminal_id, print_on_terminal: "no_ticket" }, payment_method: { default_type: c.forma === "debito" ? "debit_card" : "credit_card" } },
  });
}
async function enviarOrdem(c: any, tk: string) {
  let r = await mp(tk, "/v1/orders", { method: "POST", body: corpoOrdem(c) }, `beep-criar-${c.id}`);
  if (r.status === 0 || r.status >= 500) r = await mp(tk, "/v1/orders", { method: "POST", body: corpoOrdem(c) }, `beep-criar-${c.id}`); // repetir é seguro
  return r;
}

async function cancelarNoMp(c: any, tk: string) {
  return await mp(tk, `/v1/orders/${encodeURIComponent(c.mp_order_id)}/cancel`, { method: "POST", headers: { "x-allow-cancelable-status": "at_terminal" } }, `beep-cancelar-${c.id}`);
}

const resposta = (c: any) => ({ cobranca: c.id, status: c.status, detalhe: c.status_detail, mensagem: motivo(c.status_detail, c.status), total: c.valor, bandeira: c.bandeira, venda_gravada: !!c.venda_gravada, venda_id: c.venda_id });

// ---------- aviso do Mercado Pago (webhook, tópico "order") ----------
async function webhook(req: Request) {
  const url = new URL(req.url);
  let b: any = {};
  try { b = await req.json(); } catch { /* corpo vazio */ }
  const dataId = String(url.searchParams.get("data.id") ?? b?.data?.id ?? "").slice(0, 80);
  const tipo = String(b?.type ?? url.searchParams.get("type") ?? "").slice(0, 40);

  // acha a cobrança: pelo id do pedido ou, se o aviso chegou antes de guardarmos o id, pela referência externa
  let { data: cob } = dataId ? await db.from("cobrancas_cartao").select("*").eq("mp_order_id", dataId).maybeSingle() : { data: null as any };
  if (!cob) {
    const id = cobrancaDaReferencia(b?.data?.external_reference);
    if (id) cob = (await db.from("cobrancas_cartao").select("*").eq("id", id).maybeSingle()).data;
  }
  const cred = cob ? await credencial(cob.empresa_id) : { token: "", segredo: GLOBAL() ? (Deno.env.get("MP_WEBHOOK_SECRET") ?? "").trim() : "" };
  const valido = await assinaturaValida({ segredo: cred.segredo, cabecalho: req.headers.get("x-signature"), requestId: req.headers.get("x-request-id"), dataId });
  // aviso inválido não guarda o corpo (evita encher a tabela com lixo de quem não é o Mercado Pago)
  await db.from("mp_webhooks").insert({ tipo, data_id: dataId || null, valido, corpo: valido ? b : null });
  if (!valido) return new Response("assinatura inválida", { status: 401 });
  if (!cob || !cred.token) return new Response("ok", { status: 200 });

  // a fonte da verdade é sempre a consulta ao Mercado Pago, nunca o corpo do aviso
  if (!cob.mp_order_id) {
    const r = await mp(cred.token, `/v1/orders/${encodeURIComponent(dataId)}`);
    if (!r.ok || cobrancaDaReferencia(r.corpo?.external_reference) !== cob.id) return new Response("ok", { status: 200 });
    const { data } = await db.from("cobrancas_cartao").update({ mp_order_id: dataId }).eq("id", cob.id).is("mp_order_id", null).select("*").maybeSingle();
    if (data) cob = data;
  }
  await db.from("cobrancas_cartao").update({ webhook_ok: true }).eq("id", cob.id);
  await atualizar(cob, cred.token, true); // forçado: também pega estorno feito depois da aprovação
  return new Response("ok", { status: 200 });
}

// cobrança anterior deste caixa que ficou aberta: tenta encerrar antes de abrir outra
async function encerrarAnterior(a: any, tk: string) {
  if (!a.mp_order_id) {
    // ficou em "criando": pergunta de novo com a mesma chave; se o pedido existe, volta o mesmo
    const r = await enviarOrdem(a, tk);
    if (r.ok && r.corpo?.id) {
      const { data } = await db.from("cobrancas_cartao").update({ mp_order_id: String(r.corpo.id) }).eq("id", a.id).select("*").single();
      a = data ?? { ...a, mp_order_id: String(r.corpo.id) };
    } else if (r.status >= 400 && r.status < 500) {
      const { data } = await db.from("cobrancas_cartao").update({ status: "falhou", erro: msgMp(r), atualizado_em: agora() }).eq("id", a.id).select("*").single();
      return data ?? a;
    } else return a; // sem resposta: não dá para saber, continua aberta
  }
  a = await atualizar(a, tk);
  if (FINAIS.has(a.status)) return a;
  const r = await cancelarNoMp(a, tk);
  if (r.ok && r.corpo?.status) a = await aplicarOrdem(a, r.corpo);
  if (!FINAIS.has(a.status)) a = await atualizar(a, tk);
  return a;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return erro("use POST", 405);
  if (new URL(req.url).searchParams.get("wh") === "1") return webhook(req);

  let b: Record<string, any>;
  try { b = await req.json(); } catch { return erro("JSON inválido"); }
  const d = await aparelho(req);
  if (!d) return erro("Aparelho não autorizado. Ative de novo.", 401);
  const acao = b.acao;
  const tk = (await credencial(d.empresa_id)).token; // token desta empresa, só nesta requisição
  const temToken = tk.length > 20;
  const terminal = d.mp_terminal_id || (TESTE() ? TERMINAL_VIRTUAL : null);

  // o caixa pergunta se já pode cobrar no cartão
  if (acao === "config") return json({ provedor: "mercadopago", pronto: temToken && !!terminal, credencial: temToken, terminal, teste: TESTE() || terminal === TERMINAL_VIRTUAL });

  if (!temToken) return erro("Credencial do Mercado Pago ainda não cadastrada. O dono cadastra no Painel, em Configurações.", 503);

  // configuração: maquininhas da conta
  if (acao === "terminais") {
    const r = await mp(tk, "/terminals/v1/list?limit=50&offset=0");
    if (!r.ok) return erro("Mercado Pago recusou a consulta das maquininhas", 502, { detalhe: msgMp(r) });
    const lista = (r.corpo?.data?.terminals ?? r.corpo?.terminals ?? r.corpo?.results ?? []).map((t: any) => ({ id: t.id, modo: t.operating_mode ?? null, loja: t.store_id ?? null, caixa: t.pos_id ?? null }));
    if (TESTE() && !lista.some((t: any) => t.id === TERMINAL_VIRTUAL)) lista.push({ id: TERMINAL_VIRTUAL, modo: "PDV", virtual: true });
    return json({ terminais: lista, atual: d.mp_terminal_id });
  }

  // configuração: liga esta maquininha a este caixa e coloca no modo PDV
  if (acao === "vincular") {
    const id = String(b.terminal_id ?? "").trim();
    if (!/^[A-Z0-9_]{6,80}$/i.test(id)) return erro("Maquininha inválida");
    if (id === TERMINAL_VIRTUAL && !TESTE()) return erro("A maquininha virtual só existe no modo teste");
    let aviso: string | null = null;
    if (id !== TERMINAL_VIRTUAL) {
      const r = await mp(tk, "/terminals/v1/setup", { method: "PATCH", body: JSON.stringify({ terminals: [{ id, operating_mode: "PDV" }] }) });
      if (!r.ok) aviso = `Não consegui ativar o modo PDV (${msgMp(r)}). Reinicie a maquininha e tente de novo.`;
    }
    await db.from("dispositivos").update({ mp_terminal_id: id }).eq("id", d.id);
    return json({ ok: true, terminal: id, aviso, reiniciar: !aviso && id !== TERMINAL_VIRTUAL });
  }

  // 1) inicia a cobrança: calcula o total e manda para a maquininha
  if (acao === "iniciar") {
    if (!terminal) return erro("Nenhuma maquininha ligada a este caixa", 409);
    if (!uuidOk(b.venda_id)) return erro("id da venda inválido");
    const forma = b.forma === "debito" ? "debito" : b.forma === "credito" ? "credito" : null;
    if (!forma) return erro("Forma de pagamento inválida");
    const { data: vendida } = await db.from("vendas").select("id").eq("id", b.venda_id).maybeSingle();
    if (vendida) return erro("Esta venda já foi paga", 409);
    const { data: aprovada } = await db.from("cobrancas_cartao").select("*").eq("venda_id", b.venda_id).eq("status", "aprovado").maybeSingle();
    if (aprovada) return json(resposta(await atualizar(aprovada, tk))); // já pagou: só termina de gravar

    // uma cobrança aberta por caixa: encerra a anterior que tenha ficado pendurada
    const { data: abertas } = await db.from("cobrancas_cartao").select("*").eq("dispositivo_id", d.id).in("status", ABERTOS);
    for (const a0 of abertas ?? []) {
      const a = await encerrarAnterior(a0, tk);
      if (a.status === "aprovado") {
        if (a.venda_id === b.venda_id) return json(resposta(a));
        return erro("Há um pagamento aprovado de outra compra neste caixa. Ele já foi registrado.", 409, { cobranca: a.id });
      }
      if (!FINAIS.has(a.status)) return erro("A maquininha ainda está com a cobrança anterior. Cancele na maquininha e tente de novo.", 409, { cobranca: a.id });
    }

    const c0: any = await calcular(d, b.itens);
    if (c0.erro) return erro(c0.erro);
    const { data: cob, error } = await db.from("cobrancas_cartao").insert({
      empresa_id: d.empresa_id, local_id: d.local_id, dispositivo_id: d.id, venda_id: b.venda_id, forma, valor: c0.total, itens: c0.linhas,
      iniciada_em: dataOk(b.iniciada_em), maior18_em: dataOk(b.maior18_em), terminal_id: terminal, status: "criando",
    }).select("*").single();
    if (error?.code === "23505") return erro("Já há um pagamento em andamento neste caixa", 409);
    if (error || !cob) return erro("Não foi possível registrar a cobrança", 500);

    const r = await enviarOrdem(cob, tk);
    if (r.status === 0) {
      // não sabemos se a maquininha recebeu: a cobrança fica "criando" e a próxima tentativa reencontra o pedido pela mesma chave
      await db.from("cobrancas_cartao").update({ erro: msgMp(r), atualizado_em: agora() }).eq("id", cob.id);
      return erro("Sem resposta do Mercado Pago. Tente de novo.", 504, { cobranca: cob.id });
    }
    if (!r.ok || !r.corpo?.id) {
      const m = msgMp(r);
      await db.from("cobrancas_cartao").update({ status: "falhou", erro: m, atualizado_em: agora() }).eq("id", cob.id);
      return erro("A maquininha não recebeu a cobrança: " + m, 502);
    }
    const { data: c1 } = await db.from("cobrancas_cartao").update({ mp_order_id: String(r.corpo.id), erro: null, atualizado_em: agora() }).eq("id", cob.id).select("*").single();
    return json(resposta(await aplicarOrdem(c1 ?? { ...cob, mp_order_id: String(r.corpo.id) }, r.corpo)));
  }

  // 2) o caixa acompanha o pagamento
  if (acao === "status") {
    if (!uuidOk(b.cobranca)) return erro("cobrança inválida");
    const { data: c } = await db.from("cobrancas_cartao").select("*").eq("id", b.cobranca).eq("dispositivo_id", d.id).maybeSingle();
    if (!c) return erro("Cobrança não encontrada", 404);
    return json(resposta(await atualizar(c, tk)));
  }

  // 3) cancelar (o cliente desistiu ou o caixa expirou)
  if (acao === "cancelar") {
    if (!uuidOk(b.cobranca)) return erro("cobrança inválida");
    const { data: c0 } = await db.from("cobrancas_cartao").select("*").eq("id", b.cobranca).eq("dispositivo_id", d.id).maybeSingle();
    if (!c0) return erro("Cobrança não encontrada", 404);
    let c = await atualizar(c0, tk);
    if (FINAIS.has(c.status)) return json({ ...resposta(c), pedido: "ja_terminou" });
    if (!c.mp_order_id) {
      const { data } = await db.from("cobrancas_cartao").update({ status: "cancelado", status_detail: "canceled_by_api", atualizado_em: agora() }).eq("id", c.id).eq("status", "criando").is("mp_order_id", null).select("*").maybeSingle();
      return json({ ...resposta(data ?? c), pedido: data ? "ok" : "nao_cancelou" });
    }
    const r = await cancelarNoMp(c, tk);
    // 200 = cancelado na hora; 202 = pedido aceito (a maquininha confirma em seguida, pela consulta ou pelo aviso)
    if (r.ok && r.corpo?.status) c = await aplicarOrdem(c, r.corpo);
    if (!FINAIS.has(c.status)) c = await atualizar(c, tk);
    return json({ ...resposta(c), pedido: FINAIS.has(c.status) ? "ok" : r.status === 202 ? "cancelamento_pedido" : "nao_cancelou" });
  }

  return erro("Ação desconhecida");
});
