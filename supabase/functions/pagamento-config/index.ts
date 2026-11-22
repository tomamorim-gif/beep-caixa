// Painel de gestão: o dono cadastra a credencial do Mercado Pago da própria empresa.
// - Só o dono (login do painel) cadastra ou remove; dono e gerente veem o status.
// - O token é validado no Mercado Pago antes de salvar e nunca volta para o navegador (só os 4 últimos caracteres).
// - Fica numa tabela trancada (sem acesso do navegador); só as funções do servidor leem.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const erro = (m: string, s = 400) => json({ erro: m }, s);
const fim4 = (t?: string | null) => (t ? "…" + t.slice(-4) : null);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return erro("use POST", 405);
  let b: Record<string, any>;
  try { b = await req.json(); } catch { return erro("JSON inválido"); }

  const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: u } = tok ? await db.auth.getUser(tok) : { data: { user: null } };
  if (!u?.user) return erro("Entre no painel de gestão de novo", 401);
  const { data: m } = await db.from("membros").select("empresa_id, papel").eq("user_id", u.user.id).eq("ativo", true).in("papel", ["dono", "gerente"]).limit(1);
  const emp = m?.[0]?.empresa_id, papel = m?.[0]?.papel;
  if (!emp) return erro("Sem permissão", 403);

  const atual = async () => (await db.from("integracoes_pagamento").select("access_token, webhook_secret, conta_nome, conta_id, atualizado_em").eq("empresa_id", emp).eq("provedor", "mercadopago").maybeSingle()).data;

  if (b.acao === "status") {
    const c = await atual();
    const { count } = await db.from("dispositivos").select("id", { count: "exact", head: true }).eq("empresa_id", emp).eq("ativo", true).not("mp_terminal_id", "is", null);
    return json({
      configurado: !!c?.access_token, token_final: fim4(c?.access_token), webhook: !!c?.webhook_secret,
      conta: c?.conta_nome ?? null, atualizado_em: c?.atualizado_em ?? null, caixas_com_maquininha: count ?? 0, pode_editar: papel === "dono",
    });
  }

  if (papel !== "dono") return erro("Só o dono pode mudar a credencial", 403);

  if (b.acao === "salvar") {
    const token = typeof b.access_token === "string" ? b.access_token.trim() : "";
    const segredo = typeof b.webhook_secret === "string" ? b.webhook_secret.trim() : "";
    const upd: Record<string, unknown> = { empresa_id: emp, provedor: "mercadopago", atualizado_em: new Date().toISOString(), atualizado_por: u.user.id };
    if (token) {
      if (!/^APP_USR-[A-Za-z0-9-]{20,}$/.test(token)) return erro("Use o Access Token de produção (começa com APP_USR-). Não é a Public Key.");
      // valida no Mercado Pago antes de guardar
      const r = await fetch("https://api.mercadopago.com/users/me", { headers: { Authorization: `Bearer ${token}` } });
      const me = await r.json().catch(() => ({}));
      if (!r.ok) return erro("O Mercado Pago não aceitou esse Access Token. Copie de novo em Credenciais de produção.");
      upd.access_token = token;
      upd.conta_nome = String(me.nickname ?? me.first_name ?? me.email ?? "").slice(0, 120) || null;
      upd.conta_id = me.id ? String(me.id) : null;
    }
    if (segredo) {
      if (!/^[A-Za-z0-9]{16,128}$/.test(segredo)) return erro("A assinatura secreta do webhook parece incompleta. Copie de novo na página de Webhooks.");
      upd.webhook_secret = segredo;
    }
    if (!token && !segredo) return erro("Cole o Access Token e/ou a assinatura secreta");
    const { error } = await db.from("integracoes_pagamento").upsert(upd, { onConflict: "empresa_id,provedor" });
    if (error) return erro("Não foi possível salvar", 500);
    const c = await atual();
    return json({ ok: true, configurado: !!c?.access_token, token_final: fim4(c?.access_token), webhook: !!c?.webhook_secret, conta: c?.conta_nome ?? null });
  }

  if (b.acao === "remover") {
    await db.from("integracoes_pagamento").delete().eq("empresa_id", emp).eq("provedor", "mercadopago");
    return json({ ok: true });
  }

  return erro("Ação desconhecida");
});
