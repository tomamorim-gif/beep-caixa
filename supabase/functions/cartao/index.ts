// Cobrança no cartão pela maquininha Mercado Pago Point (API Orders).
// - O token do Mercado Pago fica só aqui (segredo MP_ACCESS_TOKEN); o tablet nunca o vê.
// - O valor cobrado é sempre o total calculado aqui, com os preços da loja.
// - A venda só é gravada quando o Mercado Pago confirma o pagamento (pelo status ou pelo aviso/webhook).
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const MP = "https://api.mercadopago.com";
const TOKEN = () => (Deno.env.get("MP_ACCESS_TOKEN") ?? "").trim();
const TESTE = () => Deno.env.get("MP_POINT_TEST_MODE") === "true";
const TERMINAL_VIRTUAL = "NEWLAND_N950__SBX0000001";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const erro = (m: string, s = 400, extra: Record<string, unknown> = {}) => json({ erro: m, ...extra }, s);
const uuidOk = (s: unknown) => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);
const reais = (c: number) => (c / 100).toFixed(2);

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

async function mp(path: string, init: RequestInit = {}, idem = false) {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN()}`, "Content-Type": "application/json", ...(init.headers as Record<string, string> ?? {}) };
  if (idem) headers["X-Idempotency-Key"] = crypto.randomUUID();
  const r = await fetch(MP + path, { ...init, headers });
  const corpo = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, corpo };
}

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
  return { total, linhas };
}

// traduz o pedido do Mercado Pago para o nosso status
function lerOrdem(o: any) {
  const p = o?.transactions?.payments?.[0] ?? {};
  const st = String(o?.status ?? "");
  const det = String(p.status_detail ?? o?.status_detail ?? "");
  const nosso =
    st === "processed" ? "aprovado" :
    st === "failed" ? "recusado" :
    st === "canceled" ? "cancelado" :
    st === "expired" ? "expirado" :
    st === "refunded" ? "estornado" :
    st === "action_required" ? "verificar" :
    st === "at_terminal" ? "na_maquininha" : "aguardando";
  return {
    status: nosso, mp_status: st, status_detail: det || null,
    mp_payment_id: p.id ? String(p.id) : null,
    bandeira: p.payment_method?.id ? String(p.payment_method.id) : null,
    autorizacao: p.authorization_code ?? p.reference?.authorization_code ?? null,
    nsu: p.reference_id ?? p.reference?.id ?? (p.id ? String(p.id) : null),
  };
}

const FINAIS = new Set(["aprovado", "recusado", "cancelado", "expirado", "estornado", "falhou"]);

const MOTIVOS: Record<string, string> = {
  insufficient_amount: "Saldo ou limite insuficiente",
  rejected_by_issuer: "Recusado pelo banco do cartão",
  rejected_by_bank: "Recusado pelo banco do cartão",
  invalid_card: "Cartão inválido",
  card_expired: "Cartão vencido",
  invalid_pin: "Senha incorreta",
  canceled_by_api: "Cancelado",
  canceled_on_terminal: "Cancelado na maquininha",
  expired: "Tempo esgotado",
};
const motivo = (det: string | null, st: string) => (det && MOTIVOS[det]) || ({ recusado: "Pagamento recusado", cancelado: "Pagamento cancelado", expirado: "Tempo esgotado na maquininha", verificar: "Confira a maquininha" } as Record<string, string>)[st] || "";

// grava a venda uma única vez, quando o pagamento foi aprovado
async function gravarVenda(c: any) {
  const { data: pegou } = await db.from("cobrancas_cartao").update({ venda_gravada: true, atualizado_em: new Date().toISOString() }).eq("id", c.id).eq("venda_gravada", false).select("id");
  if (!pegou?.length) return;
  const { data: ja } = await db.from("vendas").select("id").eq("id", c.venda_id).maybeSingle();
  if (ja) return;
  const { data: custos } = await db.from("produtos").select("id, custo").in("id", c.itens.map((i: any) => i.produto_id));
  const custo = new Map((custos ?? []).map((p: any) => [p.id, p.custo]));
  const linhas = c.itens.map((l: any) => ({ venda_id: c.venda_id, empresa_id: c.empresa_id, seq: l.seq, produto_id: l.produto_id, quantidade: l.quantidade, preco_unit: l.preco_unit, custo_unit: custo.get(l.produto_id) ?? l.custo_unit ?? null }));
  const agora = new Date().toISOString();
  const { error } = await db.from("vendas").insert({ id: c.venda_id, empresa_id: c.empresa_id, local_id: c.local_id, dispositivo_id: c.dispositivo_id, iniciada_em: c.iniciada_em ?? agora, finalizada_em: agora, status: "paga", total: c.valor, origem: "telefone", teste: TESTE() });
  if (error) { await db.from("cobrancas_cartao").update({ venda_gravada: false, erro: "falha ao gravar venda: " + error.message }).eq("id", c.id); return; }
  await db.from("venda_itens").insert(linhas);
  await db.from("pagamentos").insert({ venda_id: c.venda_id, empresa_id: c.empresa_id, forma: c.forma, valor: c.valor, status: "aprovado", nsu: c.nsu ?? c.mp_payment_id, autorizacao: c.autorizacao, bandeira: c.bandeira });
  await db.from("estoque_mov").insert(linhas.map((l: any) => ({ empresa_id: c.empresa_id, local_id: c.local_id, produto_id: l.produto_id, tipo: "venda", quantidade: -l.quantidade, custo_unit: l.custo_unit, referencia: c.venda_id, usuario_id: null })));
}

// consulta o Mercado Pago (se ainda não terminou), atualiza e grava a venda quando aprovada
async function atualizar(c: any) {
  if (!FINAIS.has(c.status) && c.mp_order_id) {
    const r = await mp(`/v1/orders/${encodeURIComponent(c.mp_order_id)}`);
    if (r.ok) {
      const o = lerOrdem(r.corpo);
      const { data } = await db.from("cobrancas_cartao").update({ status: o.status, status_detail: o.status_detail, mp_payment_id: o.mp_payment_id, bandeira: o.bandeira, autorizacao: o.autorizacao, nsu: o.nsu, atualizado_em: new Date().toISOString() }).eq("id", c.id).select("*").single();
      if (data) c = data;
    }
  }
  if (c.status === "aprovado" && !c.venda_gravada) { await gravarVenda(c); c.venda_gravada = true; }
  return c;
}

const resposta = (c: any) => ({ cobranca: c.id, status: c.status, detalhe: c.status_detail, mensagem: motivo(c.status_detail, c.status), total: c.valor, bandeira: c.bandeira, venda_gravada: c.venda_gravada });

// ---------- aviso do Mercado Pago (webhook, tópico "orders") ----------
async function webhook(req: Request) {
  const segredo = (Deno.env.get("MP_WEBHOOK_SECRET") ?? "").trim();
  const url = new URL(req.url);
  let b: any = {};
  try { b = await req.json(); } catch { /* corpo vazio */ }
  const dataId = String(url.searchParams.get("data.id") ?? b?.data?.id ?? "");
  const tipo = String(b?.type ?? url.searchParams.get("type") ?? "");
  const sig = req.headers.get("x-signature") ?? "", reqId = req.headers.get("x-request-id") ?? "";
  const partes = Object.fromEntries(sig.split(",").map((p) => p.split("=").map((s) => s.trim())));
  let valido = false;
  if (segredo && partes.ts && partes.v1 && dataId && reqId) {
    const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const assinatura = await crypto.subtle.sign("HMAC", chave, new TextEncoder().encode(`id:${dataId.toLowerCase()};request-id:${reqId};ts:${partes.ts};`));
    const esperado = [...new Uint8Array(assinatura)].map((x) => x.toString(16).padStart(2, "0")).join("");
    valido = esperado.length === partes.v1.length && esperado === partes.v1;
  }
  await db.from("mp_webhooks").insert({ tipo, data_id: dataId || null, valido, corpo: b });
  if (!valido) return new Response("assinatura inválida", { status: 401 });
  // a fonte da verdade é sempre a consulta ao Mercado Pago, nunca o corpo do aviso
  const { data: c } = await db.from("cobrancas_cartao").select("*").eq("mp_order_id", dataId).maybeSingle();
  if (c) await atualizar(c);
  return new Response("ok", { status: 200 });
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
  const temToken = TOKEN().length > 20;
  const terminal = d.mp_terminal_id || (TESTE() ? TERMINAL_VIRTUAL : null);

  // o caixa pergunta se já pode cobrar no cartão
  if (acao === "config") return json({ provedor: "mercadopago", pronto: temToken && !!terminal, credencial: temToken, terminal, teste: TESTE() });

  if (!temToken) return erro("Credencial do Mercado Pago ainda não cadastrada no servidor", 503);

  // configuração: maquininhas da conta
  if (acao === "terminais") {
    const r = await mp("/terminals/v1/list?limit=50&offset=0");
    if (!r.ok) return erro("Mercado Pago recusou a consulta das maquininhas", 502, { detalhe: r.corpo?.message ?? r.status });
    const lista = (r.corpo?.data?.terminals ?? r.corpo?.terminals ?? r.corpo?.results ?? []).map((t: any) => ({ id: t.id, modo: t.operating_mode ?? null, loja: t.store_id ?? null, caixa: t.pos_id ?? null }));
    if (TESTE() && !lista.some((t: any) => t.id === TERMINAL_VIRTUAL)) lista.push({ id: TERMINAL_VIRTUAL, modo: "PDV", virtual: true });
    return json({ terminais: lista, atual: d.mp_terminal_id });
  }

  // configuração: liga esta maquininha a este caixa e coloca no modo PDV
  if (acao === "vincular") {
    const id = String(b.terminal_id ?? "").trim();
    if (!/^[A-Z0-9_]{6,80}$/i.test(id)) return erro("Maquininha inválida");
    let aviso: string | null = null;
    if (id !== TERMINAL_VIRTUAL) {
      const r = await mp("/terminals/v1/setup", { method: "PATCH", body: JSON.stringify({ terminals: [{ id, operating_mode: "PDV" }] }) });
      if (!r.ok) aviso = `Não consegui ativar o modo PDV (${r.corpo?.message ?? r.status}). Reinicie a maquininha e tente de novo.`;
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
    // uma cobrança aberta por caixa: cancela a anterior que tenha ficado pendurada
    const { data: abertas } = await db.from("cobrancas_cartao").select("*").eq("dispositivo_id", d.id).in("status", ["criando", "aguardando", "na_maquininha", "verificar"]);
    for (const a of abertas ?? []) {
      const at = await atualizar(a);
      if (at.status === "aprovado") return erro("Há um pagamento aprovado pendente neste caixa", 409, { cobranca: at.id });
      if (!FINAIS.has(at.status) && at.mp_order_id) await mp(`/v1/orders/${encodeURIComponent(at.mp_order_id)}/cancel`, { method: "POST", headers: { "x-allow-cancelable-status": "at_terminal" } }, true);
    }
    const c0: any = await calcular(d, b.itens);
    if (c0.erro) return erro(c0.erro);
    const { data: cob, error } = await db.from("cobrancas_cartao").insert({
      empresa_id: d.empresa_id, local_id: d.local_id, dispositivo_id: d.id, venda_id: b.venda_id, forma, valor: c0.total, itens: c0.linhas,
      iniciada_em: typeof b.iniciada_em === "string" ? b.iniciada_em : null, maior18_em: typeof b.maior18_em === "string" ? b.maior18_em : null, terminal_id: terminal,
    }).select("*").single();
    if (error || !cob) return erro("Não foi possível registrar a cobrança", 500);
    const ref = "beep" + cob.id.replace(/-/g, "");
    const r = await mp("/v1/orders", {
      method: "POST",
      body: JSON.stringify({
        type: "point",
        external_reference: ref,
        description: "Compra Beep",
        expiration_time: "PT3M",
        transactions: { payments: [{ amount: reais(c0.total) }] },
        config: { point: { terminal_id: terminal, print_on_terminal: "no_ticket" }, payment_method: { default_type: forma === "debito" ? "debit_card" : "credit_card" } },
      }),
    }, true);
    if (!r.ok) {
      const m = r.corpo?.message ?? r.corpo?.errors?.[0]?.message ?? `erro ${r.status}`;
      await db.from("cobrancas_cartao").update({ status: "falhou", erro: String(m).slice(0, 300) }).eq("id", cob.id);
      return erro("A maquininha não recebeu a cobrança: " + m, 502);
    }
    const o = lerOrdem(r.corpo);
    const { data: c } = await db.from("cobrancas_cartao").update({ mp_order_id: String(r.corpo.id), status: o.status === "aguardando" ? "aguardando" : o.status, status_detail: o.status_detail, atualizado_em: new Date().toISOString() }).eq("id", cob.id).select("*").single();
    return json(resposta(c ?? cob));
  }

  // 2) o caixa acompanha o pagamento
  if (acao === "status") {
    if (!uuidOk(b.cobranca)) return erro("cobrança inválida");
    const { data: c } = await db.from("cobrancas_cartao").select("*").eq("id", b.cobranca).eq("dispositivo_id", d.id).maybeSingle();
    if (!c) return erro("Cobrança não encontrada", 404);
    return json(resposta(await atualizar(c)));
  }

  // 3) cancelar (o cliente desistiu ou o caixa expirou)
  if (acao === "cancelar") {
    if (!uuidOk(b.cobranca)) return erro("cobrança inválida");
    const { data: c0 } = await db.from("cobrancas_cartao").select("*").eq("id", b.cobranca).eq("dispositivo_id", d.id).maybeSingle();
    if (!c0) return erro("Cobrança não encontrada", 404);
    let c = await atualizar(c0);
    if (FINAIS.has(c.status)) return json(resposta(c));
    const r = await mp(`/v1/orders/${encodeURIComponent(c.mp_order_id)}/cancel`, { method: "POST", headers: { "x-allow-cancelable-status": "at_terminal" } }, true);
    // 200 = cancelado na hora; 202 = pedido aceito (a maquininha confirma em seguida)
    if (r.status === 200) {
      const { data } = await db.from("cobrancas_cartao").update({ status: "cancelado", status_detail: "canceled_by_api", atualizado_em: new Date().toISOString() }).eq("id", c.id).select("*").single();
      c = data ?? c;
    }
    return json({ ...resposta(c), pedido: r.status === 202 ? "cancelamento_pedido" : r.ok ? "ok" : "nao_cancelou" });
  }

  return erro("Ação desconhecida");
});
