// Avisos da inteligência no celular (notificação do Painel instalado).
// - "diario": chamado pelo banco todo dia às 8h de Fortaleza. Para cada empresa com aparelhos cadastrados,
//   manda o resumo da inteligência (última análise salva pelo Painel), compras e contas que vencem.
// - "teste": a própria pessoa logada pede um aviso de teste nos aparelhos dela.
// O dono decide em Configurações › Avisos se a empresa recebe, quem recebe (dono, gerente) e quais tipos.
// A chave privada das notificações fica só no servidor (segredo VAPID_PRIVATE ou cofre do banco).
import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const PUBLICA = "BLzX5j5PkB1yyecilY6cujpbCFVzKLFvM2Cmqo96UZYwktpE8ZwpuImyMeLmdGS81hu8k6iBHDCJJ6p3Cd51vmg";
const URL_PAINEL = "https://app.pagnow.com.br/gestao/";
const PADRAO = { ativo: true, papeis: { dono: true, gerente: true }, tipos: { estrategico: true, vencimentos: true, abastecimento: true } };

function igual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const hojeFortaleza = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const somaDias = (d: string, n: number) => new Date(new Date(d + "T12:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);
const brl = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

type Aviso = { chave: string; tipo: "estrategico" | "vencimentos" | "abastecimento"; titulo: string; texto: string; tela: string };
type Assin = { id: string; empresa_id: string; user_id: string; endpoint: string; p256dh: string; auth: string };

async function configurar() {
  // chave privada: segredo da função ou, se não houver, o cofre do banco (avisos_vapid)
  let priv = Deno.env.get("VAPID_PRIVATE") || "";
  if (!priv) { const { data } = await db.rpc("avisos_vapid"); priv = String(data || ""); }
  if (!priv) throw new Error("chave das notificações não cadastrada");
  webpush.setVapidDetails("https://app.pagnow.com.br", PUBLICA, priv);
}

async function enviar(a: Assin, av: { titulo: string; texto: string; tela: string; chave: string }) {
  try {
    await webpush.sendNotification({ endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } },
      JSON.stringify({ title: av.titulo, body: av.texto, url: URL_PAINEL + "#" + av.tela, tag: av.chave }), { TTL: 6 * 3600 });
    await db.from("push_assinaturas").update({ ultimo_envio: new Date().toISOString() }).eq("id", a.id);
    return true;
  } catch (e) {
    const st = (e as { statusCode?: number }).statusCode;
    // aparelho desinstalou ou recusou: tira da lista para não tentar de novo
    if (st === 404 || st === 410) await db.from("push_assinaturas").delete().eq("id", a.id);
    return false;
  }
}

async function avisosDaEmpresa(emp: { id: string; inteligencia: Record<string, unknown> | null }): Promise<Aviso[]> {
  const hoje = hojeFortaleza(), out: Aviso[] = [];
  // contas a pagar vencidas, de hoje e de amanhã
  const { data: cp } = await db.from("contas_pagar").select("valor,vencimento").eq("empresa_id", emp.id).is("pago_em", null).lte("vencimento", somaDias(hoje, 1)).limit(1000);
  if (cp?.length) {
    const venc = cp.filter((c) => c.vencimento < hoje), hj = cp.filter((c) => c.vencimento === hoje), am = cp.filter((c) => c.vencimento > hoje);
    const s = (l: typeof cp) => l.reduce((t, c) => t + Number(c.valor || 0), 0);
    const partes = [];
    if (hj.length) partes.push(`${hj.length} ${hj.length === 1 ? "vence" : "vencem"} hoje (${brl(s(hj))})`);
    if (am.length) partes.push(`${am.length} amanhã (${brl(s(am))})`);
    if (venc.length) partes.push(`${venc.length} ${venc.length === 1 ? "vencida" : "vencidas"} (${brl(s(venc))})`);
    out.push({ chave: "vencimentos", tipo: "vencimentos", titulo: "Contas a pagar", texto: partes.join(" · "), tela: "cp" });
  }
  // resumo da inteligência: a última análise que o Painel salvou (vale por 3 dias)
  const r = (emp.inteligencia?.resumo_avisos || null) as null | { em: string; falta: number; perdaDia: number; compraValor: number; compraItens: number; compraUrgente: number; abs: number; top: string[] };
  if (r && Date.now() - new Date(r.em).getTime() < 3 * 86400000) {
    if (r.falta > 0) out.push({ chave: "falta", tipo: "estrategico", titulo: `${r.falta} ${r.falta === 1 ? "produto em falta" : "produtos em falta"} nas lojas`, texto: (r.top?.[0] ? r.top[0] + ". " : "") + `Perda estimada de ${brl(Math.round(r.perdaDia || 0))} por dia.`, tela: "int" });
    if (r.abs > 0 || r.compraItens > 0) {
      const t = [];
      if (r.abs > 0) t.push(`${r.abs} produtos para levar às lojas`);
      if (r.compraItens > 0) t.push(`pedido de compra sugerido de ${brl(Math.round(r.compraValor || 0))}${r.compraUrgente ? ` (${r.compraUrgente} urgentes)` : ""}`);
      out.push({ chave: "abastecimento", tipo: "abastecimento", titulo: "Abastecimento e compras", texto: t.join(" e ") + ".", tela: "int" });
    }
  }
  return out;
}

async function diario() {
  await configurar();
  const { data: assins } = await db.from("push_assinaturas").select("id,empresa_id,user_id,endpoint,p256dh,auth");
  if (!assins?.length) return { enviados: 0 };
  const hoje = hojeFortaleza();
  let enviados = 0;
  for (const empId of [...new Set(assins.map((a) => a.empresa_id))]) {
    const { data: emp } = await db.from("empresas").select("id,inteligencia").eq("id", empId).maybeSingle();
    if (!emp) continue;
    const cfg = { ...PADRAO, ...((emp.inteligencia as Record<string, unknown>)?.avisos as object || {}) } as typeof PADRAO;
    if (!cfg.ativo) continue;
    const avisos = (await avisosDaEmpresa(emp)).filter((a) => cfg.tipos?.[a.tipo] !== false);
    if (!avisos.length) continue;
    const { data: membros } = await db.from("membros").select("user_id,papel").eq("empresa_id", empId).eq("ativo", true);
    const papel = new Map((membros || []).map((m) => [m.user_id, m.papel as string]));
    for (const a of assins.filter((x) => x.empresa_id === empId)) {
      const p = papel.get(a.user_id);
      if (!p || (cfg.papeis as Record<string, boolean>)?.[p] === false || !["dono", "gerente"].includes(p)) continue;
      for (const av of avisos) {
        // um aviso de cada tipo por pessoa por dia, mesmo com vários aparelhos
        const { error } = await db.from("avisos_enviados").insert({ empresa_id: empId, user_id: a.user_id, chave: av.chave + ":" + a.id, dia: hoje });
        if (error) continue;
        if (await enviar(a, av)) enviados++;
      }
    }
  }
  return { enviados };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erro: "Método não permitido" }, 405);
  let corpo: { acao?: string } = {};
  try { corpo = await req.json(); } catch { /* corpo vazio */ }
  try {
    const interno = req.headers.get("x-beep-interno");
    if (interno) {
      const { data: chave } = await db.rpc("fiscal_chave_interna");
      if (!chave || !igual(interno, String(chave))) return json({ erro: "Não autorizado" }, 401);
      if (corpo.acao === "diario") return json(await diario());
      return json({ erro: "Ação desconhecida" }, 400);
    }
    // pessoa logada: só o teste nos próprios aparelhos
    const tok = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await db.auth.getUser(tok);
    if (!u?.user) return json({ erro: "Entre no Painel de novo" }, 401);
    if (corpo.acao !== "teste") return json({ erro: "Ação desconhecida" }, 400);
    await configurar();
    const { data: assins } = await db.from("push_assinaturas").select("id,empresa_id,user_id,endpoint,p256dh,auth").eq("user_id", u.user.id);
    if (!assins?.length) return json({ erro: "Este aparelho ainda não está cadastrado" }, 400);
    let ok = 0;
    for (const a of assins) if (await enviar(a, { titulo: "PagNow", texto: "Avisos ligados. É assim que a inteligência vai falar com você.", tela: "int", chave: "teste" })) ok++;
    return json({ enviados: ok, aparelhos: assins.length });
  } catch (e) {
    return json({ erro: (e as Error).message }, 500);
  }
});
