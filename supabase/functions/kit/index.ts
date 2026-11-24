// Kit pronto: o tablet de fábrica mostra um QR; o cliente cria a conta (ou entra) pelo celular
// e o tablet recebe sozinho o token de caixa daquela loja.
// O tablet nunca tem chave do banco. Ele guarda só o número de série (gravado na fábrica) e,
// durante o pareamento, um segredo aleatório. Tudo é guardado aqui como hash.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const erro = (m: string, s = 400) => json({ erro: m }, s);

async function sha256(t: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const ALFA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem 0/O/1/I
const aleatorio = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => ALFA[b % 32]).join("");
const norm = (c: unknown) => String(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const soDig = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const uuidOk = (s: unknown) => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);
const texto = (v: unknown, n: number) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, n);
function cnpjValido(c: string) {
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const calc = (n: number) => { let s = 0, p = n - 7; for (let i = 0; i < n; i++) { s += +c[i] * p--; if (p < 2) p = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return calc(12) === +c[12] && calc(13) === +c[13];
}
async function usuario(req: Request) {
  const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!tok || tok.split(".").length !== 3) return null;
  const { data } = await db.auth.getUser(tok);
  return data?.user ?? null;
}
async function pareamento(codigo: string) {
  if (codigo.length !== 8) return null;
  const { data } = await db.from("kit_pareamentos").select("*").eq("codigo_hash", await sha256(codigo)).maybeSingle();
  if (!data || data.vinculado_em || new Date(data.expira_em) < new Date() || data.tentativas >= 10) return null;
  return data;
}
async function vincular(p: any, empresa: string, local: string, user: string) {
  const { data } = await db.from("kit_pareamentos").update({ empresa_id: empresa, local_id: local, vinculado_por: user, vinculado_em: new Date().toISOString() })
    .eq("id", p.id).is("vinculado_em", null).select("id");
  return !!data?.length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return erro("use POST", 405);
  let b: Record<string, any>;
  try { b = await req.json(); } catch { return erro("JSON inválido"); }
  const acao = b.acao;

  // ---------- fábrica: equipe Beep gera o número de série de um tablet ----------
  if (acao === "gerar_serial") {
    const u = await usuario(req); if (!u) return erro("Entre no painel de novo", 401);
    const { data: adm } = await db.from("kit_admins").select("user_id").eq("user_id", u.id).maybeSingle();
    if (!adm) return erro("Só a equipe Beep prepara kits", 403);
    const serial = aleatorio(16);
    const { error } = await db.from("kit_seriais").insert({ serial_hash: await sha256(serial), final: serial.slice(-4), rotulo: texto(b.rotulo, 60) || null, criado_por: u.id });
    if (error) return erro("Não foi possível gerar", 500);
    return json({ serial });
  }

  // ---------- tablet: pede um QR novo ----------
  if (acao === "iniciar") {
    const serial = norm(b.serial);
    if (serial.length !== 16) return erro("Este tablet não tem número de série de fábrica", 403);
    const { data: s } = await db.from("kit_seriais").select("id, usado_em").eq("serial_hash", await sha256(serial)).maybeSingle();
    if (!s) return erro("Número de série desconhecido", 403);
    if (s.usado_em) return erro("Este kit já foi ativado. Para usar de novo, peça um código de ativação ao dono da loja.", 409);
    // limpa QRs vencidos deste tablet e evita acúmulo
    await db.from("kit_pareamentos").delete().eq("serial_id", s.id).is("vinculado_em", null).lt("expira_em", new Date().toISOString());
    const { count } = await db.from("kit_pareamentos").select("id", { count: "exact", head: true }).eq("serial_id", s.id).is("vinculado_em", null);
    if ((count ?? 0) > 20) return erro("Muitos pedidos. Aguarde alguns minutos.", 429);
    const codigo = aleatorio(8), segredo = crypto.randomUUID() + crypto.randomUUID();
    const expira = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    const { error } = await db.from("kit_pareamentos").insert({ serial_id: s.id, codigo_hash: await sha256(codigo), segredo_hash: await sha256(segredo), expira_em: expira });
    if (error) return erro("Não foi possível gerar o QR", 500);
    return json({ codigo, segredo, expira_em: expira });
  }

  // ---------- tablet: pergunta se já foi vinculado (e recebe o token uma vez só) ----------
  if (acao === "status") {
    const seg = String(b.segredo ?? ""); if (seg.length < 60) return erro("Pedido inválido", 400);
    const { data: p } = await db.from("kit_pareamentos").select("*").eq("segredo_hash", await sha256(seg)).maybeSingle();
    if (!p) return json({ pronto: false, expirado: true });
    if (!p.vinculado_em) return json({ pronto: false, expirado: new Date(p.expira_em) < new Date() });
    if (p.entregue_em) return erro("Este pareamento já foi usado", 409);
    const { data: marcou } = await db.from("kit_pareamentos").update({ entregue_em: new Date().toISOString() }).eq("id", p.id).is("entregue_em", null).select("id");
    if (!marcou?.length) return erro("Este pareamento já foi usado", 409);
    const { data: loja } = await db.from("locais").select("id, nome").eq("id", p.local_id).eq("empresa_id", p.empresa_id).single();
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + "." + crypto.randomUUID();
    const nome = texto(b.nome, 40) || "Tablet do kit";
    const { data: disp, error } = await db.from("dispositivos").insert({ empresa_id: p.empresa_id, local_id: p.local_id, nome, tipo: "telefone", token_hash: await sha256(token), ativado_em: new Date().toISOString(), ultimo_sinal: new Date().toISOString() }).select("id").single();
    if (error) { await db.from("kit_pareamentos").update({ entregue_em: null }).eq("id", p.id); return erro("Não foi possível ativar", 500); }
    await db.from("kit_pareamentos").update({ dispositivo_id: disp.id }).eq("id", p.id);
    await db.from("kit_seriais").update({ usado_em: new Date().toISOString(), empresa_id: p.empresa_id, dispositivo_id: disp.id }).eq("id", p.serial_id);
    return json({ pronto: true, token, loja });
  }

  // ---------- celular: o código do QR ainda vale? ----------
  if (acao === "consultar") {
    const p = await pareamento(norm(b.codigo));
    return json({ valido: !!p });
  }

  // ---------- celular, já com conta: vincula o tablet a uma loja da empresa ----------
  if (acao === "vincular") {
    const u = await usuario(req); if (!u) return erro("Entre no painel de novo", 401);
    const p = await pareamento(norm(b.codigo)); if (!p) return erro("Este QR venceu. Toque em \"Gerar novo QR\" no tablet.", 410);
    const { data: m } = await db.from("membros").select("empresa_id").eq("user_id", u.id).eq("papel", "dono").eq("ativo", true);
    const emps = (m ?? []).map((x: any) => x.empresa_id);
    if (!emps.length) return erro("Só o dono da loja pode vincular o tablet", 403);
    let local = b.local_id;
    if (!local && b.nova_loja) {
      const emp = emps.length === 1 ? emps[0] : (uuidOk(b.empresa_id) && emps.includes(b.empresa_id) ? b.empresa_id : null);
      if (!emp) return erro("Escolha a empresa");
      const nome = texto(b.nova_loja, 60); if (!nome) return erro("Dê um nome para a loja");
      const { data: l, error } = await db.from("locais").insert({ empresa_id: emp, tipo: "loja", nome, endereco: texto(b.endereco, 200) || null }).select("id").single();
      if (error) return erro("Não foi possível criar a loja", 500);
      local = l.id;
    }
    if (!uuidOk(local)) return erro("Escolha a loja");
    const { data: loja } = await db.from("locais").select("id, nome, empresa_id").eq("id", local).eq("tipo", "loja").eq("ativo", true).maybeSingle();
    if (!loja || !emps.includes(loja.empresa_id)) { await db.from("kit_pareamentos").update({ tentativas: p.tentativas + 1 }).eq("id", p.id); return erro("Loja inválida", 403); }
    if (!(await vincular(p, loja.empresa_id, loja.id, u.id))) return erro("Este QR já foi usado", 409);
    return json({ ok: true, loja: { id: loja.id, nome: loja.nome } });
  }

  // ---------- celular, cliente novo: cria a conta, a empresa e a loja ----------
  if (acao === "criar_conta") {
    const p = await pareamento(norm(b.codigo)); if (!p) return erro("Este QR venceu. Toque em \"Gerar novo QR\" no tablet.", 410);
    const cnpj = soDig(b.cnpj), email = texto(b.email, 120).toLowerCase(), senha = String(b.senha ?? "");
    const lojaNome = texto(b.loja, 60), resp = texto(b.responsavel, 80);
    if (!cnpjValido(cnpj)) return erro("CNPJ inválido");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return erro("E-mail inválido");
    if (senha.length < 8) return erro("A senha precisa ter pelo menos 8 caracteres");
    if (!lojaNome) return erro("Dê um nome para a loja");
    if (!resp) return erro("Informe o nome do responsável");
    const { data: ja } = await db.from("empresas").select("id").eq("cnpj", cnpj).maybeSingle();
    if (ja) { await db.from("kit_pareamentos").update({ tentativas: p.tentativas + 1 }).eq("id", p.id); return erro("Este CNPJ já tem conta no Beep. Entre com o login do dono para vincular o tablet.", 409); }
    // dados oficiais da Receita (BrasilAPI); se a consulta falhar, usa o que o cliente digitou
    let razao = texto(b.razao, 120), fantasia = texto(b.nome, 60), uf = texto(b.uf, 2).toUpperCase();
    try {
      const r = await fetch("https://brasilapi.com.br/api/cnpj/v1/" + cnpj, { signal: AbortSignal.timeout(6000) });
      if (r.ok) { const j = await r.json(); razao = texto(j.razao_social, 120) || razao; fantasia = fantasia || texto(j.nome_fantasia, 60); uf = texto(j.uf, 2).toUpperCase() || uf; }
      else if (r.status === 404) return erro("CNPJ não encontrado na Receita");
    } catch { /* segue com os dados digitados */ }
    if (!razao) return erro("Informe a razão social");
    const { data: novo, error: eu } = await db.auth.admin.createUser({ email, password: senha, email_confirm: true, user_metadata: { nome: resp } });
    if (eu || !novo?.user) return erro(/already|registered|exists/i.test(eu?.message ?? "") ? "Este e-mail já tem login. Use \"Já tenho conta\"." : "Não foi possível criar o login", 409);
    const uid = novo.user.id;
    const desfaz = async (emp?: string) => { if (emp) await db.from("empresas").delete().eq("id", emp); await db.auth.admin.deleteUser(uid); };
    const { data: emp, error: ee } = await db.from("empresas").insert({ razao_social: razao, cnpj, nome_exibicao: fantasia || razao.slice(0, 60), uf: /^[A-Z]{2}$/.test(uf) ? uf : "CE", plano: "caixa", agente: { onboarding: { responsavel: resp, origem: "kit" } } }).select("id").single();
    if (ee || !emp) { await desfaz(); return erro("Não foi possível criar a empresa", 500); }
    const { error: em } = await db.from("membros").insert({ empresa_id: emp.id, user_id: uid, papel: "dono" });
    const { data: loja, error: el } = await db.from("locais").insert({ empresa_id: emp.id, tipo: "loja", nome: lojaNome, endereco: texto(b.endereco, 200) || null }).select("id, nome").single();
    if (em || el || !loja) { await desfaz(emp.id); return erro("Não foi possível criar a loja", 500); }
    await db.from("locais").insert({ empresa_id: emp.id, tipo: "cd", nome: "Estoque" });
    // grupos fiscais padrão do Simples (o contador confere depois)
    await db.from("grupos_fiscais").insert([
      { empresa_id: emp.id, nome: "Com ST (CSOSN 500 · CFOP 5405) · PIS/COFINS 49", csosn: "500", cfop_saida: "5405", cst_pis_cofins: "49" },
      { empresa_id: emp.id, nome: "Com ST (CSOSN 500 · CFOP 5405) · PIS/COFINS 04 monofásico", csosn: "500", cfop_saida: "5405", cst_pis_cofins: "04" },
      { empresa_id: emp.id, nome: "Sem ST (CSOSN 201 · CFOP 5403) · PIS/COFINS 49", csosn: "201", cfop_saida: "5403", cst_pis_cofins: "49" },
      { empresa_id: emp.id, nome: "Sem ST (CSOSN 201 · CFOP 5403) · PIS/COFINS 04 monofásico", csosn: "201", cfop_saida: "5403", cst_pis_cofins: "04" },
    ]);
    if (!(await vincular(p, emp.id, loja.id, uid))) { await desfaz(emp.id); return erro("Este QR já foi usado", 409); }
    return json({ ok: true, email, loja });
  }

  return erro("ação desconhecida");
});
