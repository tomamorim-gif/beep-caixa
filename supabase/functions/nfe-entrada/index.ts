// Notas de compra (NF-e 55) emitidas contra o CNPJ da empresa.
// A conversa com a SEFAZ (Ambiente Nacional) roda no GitHub Actions (scripts/nfe-recebidas.ts), quando o dono
// aperta "Atualizar notas" no painel,
// porque o Ambiente Nacional pede o certificado por renegociação TLS, que este servidor (Deno/rustls) não suporta.
// Esta função é a ponte segura entre o GitHub e o banco:
//   - ponte_inicio (token BEEP_PONTE): entrega o certificado e diz o que buscar, respeitando a espera da SEFAZ;
//   - ponte_resultado (token BEEP_PONTE): guarda os XML e atualiza a lista de notas recebidas;
//   - atualizar (painel, dono/gerente): dispara o workflow do GitHub;
//   - buscar_chave (painel, dono/gerente): coloca uma nota na fila pela chave de acesso e dispara a busca.
//   - cupom (painel, dono/gerente): consulta um cupom fiscal (NFC-e) de compra no site da SEFAZ-CE pelo QR code
//     e devolve o DANFE em HTML; o painel lê os itens e segue a mesma conferência da NF-e.
// Certificado e senha ficam no Vault e só saem para o GitHub, por HTTPS, durante a busca.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { UF_CODIGO } from "../_shared/nfce.ts";
import { chaveValida, lerDoc } from "../_shared/dfe.ts";
import { CE_BASE, CupomInvalido, erroSefaz, lerCupom } from "../_shared/cupom.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const erro = (m: string, s = 400) => json({ erro: m }, s);
const agoraIso = () => new Date().toISOString();
const emHoras = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

function igual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function membro(req: Request) {
  const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!tok) return null;
  const { data: u } = await db.auth.getUser(tok);
  if (!u?.user) return null;
  const { data: m } = await db.from("membros").select("empresa_id").eq("user_id", u.user.id).eq("ativo", true).in("papel", ["dono", "gerente"]).limit(1);
  return (m?.[0]?.empresa_id as string | undefined) ?? null;
}

async function guardarNota(emp: string, chave: string, xml: string) {
  const path = `${emp}/${chave}.xml`;
  const up = await db.storage.from("notas").upload(path, new Blob([xml], { type: "text/xml" }), { upsert: true, contentType: "text/xml" });
  if (up.error) throw new Error("Não consegui guardar o XML: " + up.error.message);
  return path;
}

// grava/atualiza a nota na lista, sem nunca voltar status (lancada/ignorada ficam como estão)
async function registrar(emp: string, d: ReturnType<typeof lerDoc>, extra: Record<string, unknown>) {
  if (!d.chave) return;
  const { data: atual } = await db.from("nfe_recebidas").select("id, status").eq("empresa_id", emp).eq("chave", d.chave).maybeSingle();
  const dados: Record<string, unknown> = { atualizado_em: agoraIso() };
  if (d.emitenteCnpj) dados.emitente_cnpj = d.emitenteCnpj;
  if (d.emitenteNome) dados.emitente_nome = d.emitenteNome;
  if (d.emissao) dados.emissao = d.emissao;
  if (d.valor != null) dados.valor = d.valor;
  Object.assign(dados, extra);
  if (atual && ["lancada", "ignorada"].includes(atual.status)) delete dados.status;
  if (atual?.status === "xml" && ["ciencia", "resumo"].includes(String(dados.status))) delete dados.status;
  if (atual?.status === "ciencia" && dados.status === "resumo") delete dados.status;
  if (atual) await db.from("nfe_recebidas").update(dados).eq("id", atual.id);
  else await db.from("nfe_recebidas").insert({ empresa_id: emp, chave: d.chave, status: "resumo", ...dados });
}

async function ponteInicio() {
  const { data: emps } = await db.from("fiscal_nfce").select("empresa_id").not("cert_validade", "is", null);
  const out: unknown[] = [];
  for (const x of emps ?? []) {
    const emp = x.empresa_id as string;
    const { data: ctl } = await db.from("dfe_controle").select("*").eq("empresa_id", emp).maybeSingle();
    // consultar antes da hora faz a SEFAZ bloquear por 1 hora (erro 656)
    if (ctl?.proxima_em && new Date(ctl.proxima_em) > new Date()) continue;
    if (ctl?.rodando_ate && new Date(ctl.rodando_ate) > new Date()) continue;
    const [{ data: e }, { data: seg }, { data: ci }, { data: co }] = await Promise.all([
      db.from("empresas").select("cnpj, uf").eq("id", emp).single(),
      db.rpc("fiscal_ler_segredos", { p_empresa: emp }),
      db.from("nfe_recebidas").select("chave").eq("empresa_id", emp).eq("status", "resumo").eq("situacao_sefaz", "1")
        .is("ultimo_erro", null).order("emissao", { ascending: false, nullsFirst: true }).limit(25),
      // já com ciência e ainda sem XML: o script baixa pela chave na mesma rodada
      db.from("nfe_recebidas").select("chave").eq("empresa_id", emp).eq("status", "ciencia").is("xml_path", null).order("emissao", { ascending: false }).limit(20),
    ]);
    const s = Array.isArray(seg) ? seg[0] : seg;
    if (!s?.pfx || !s?.senha) continue;
    await db.from("dfe_controle").upsert({ empresa_id: emp, ult_nsu: ctl?.ult_nsu ?? "000000000000000", rodando_ate: emHoras(0.25) });
    out.push({
      empresa_id: emp, cnpj: String(e?.cnpj ?? "").replace(/\D/g, ""), cUF: UF_CODIGO[e?.uf ?? "CE"] ?? "23",
      pfx: s.pfx, senha: s.senha, ult_nsu: ctl?.ult_nsu ?? "000000000000000",
      ciencia: (ci ?? []).map((r) => r.chave), consultar: (co ?? []).map((r) => r.chave),
    });
  }
  return { empresas: out };
}

async function ponteResultado(b: Record<string, any>) {
  const emp = String(b.empresa_id ?? "");
  const { data: ctl } = await db.from("dfe_controle").select("empresa_id").eq("empresa_id", emp).maybeSingle();
  if (!ctl) throw new Error("empresa sem busca em andamento");
  let xmls = 0;
  for (const c of Array.isArray(b.ciencias) ? b.ciencias : []) {
    if (!/^\d{44}$/.test(String(c.chave))) continue;
    const ok = [135, 136, 573].includes(Number(c.cStat));
    await registrar(emp, { tipo: "resumo", chave: c.chave }, ok ? { status: "ciencia", ultimo_erro: null } : { ultimo_erro: `Ciência não aceita (${c.cStat}): ${String(c.motivo ?? "")}`.slice(0, 300) });
  }
  for (const doc of (Array.isArray(b.docs) ? b.docs : []).slice(0, 60)) {
    const xml = String(doc.xml ?? "");
    if (xml.length > 3_000_000) continue;
    const info = lerDoc(String(doc.schema ?? ""), xml);
    if (!info.chave || !/^\d{44}$/.test(info.chave)) continue;
    const nsu = doc.nsu ? { nsu: String(doc.nsu).slice(0, 15) } : {};
    if (info.tipo === "resumo") {
      await registrar(emp, info, { ...nsu, situacao_sefaz: info.situacao, status: info.situacao === "1" ? "resumo" : "cancelada" });
    } else if (info.tipo === "nota") {
      const path = await guardarNota(emp, info.chave, xml);
      xmls++;
      await registrar(emp, info, { ...nsu, xml_path: path, status: "xml", ultimo_erro: null });
    } else if (info.tipo === "evento" && info.tpEvento === "110111") {
      await registrar(emp, info, { status: "cancelada", situacao_sefaz: "3" });
    }
  }
  if (b.final) {
    const ciencias = (Array.isArray(b.ciencias) ? b.ciencias : []).length;
    let espera = Number(b.espera_horas) || 1;
    if (ciencias && espera >= 1) espera = 0.25; // depois da ciência o XML chega como documento novo
    const erroMsg = b.erro ? String(b.erro).slice(0, 300) : null;
    const nsu = /^\d{1,15}$/.test(String(b.ult_nsu ?? "")) ? String(b.ult_nsu).padStart(15, "0") : undefined;
    await db.from("dfe_controle").update({
      ...(nsu ? { ult_nsu: nsu } : {}), rodando_ate: null, ultima_em: agoraIso(), proxima_em: emHoras(espera), ultimo_erro: erroMsg,
    }).eq("empresa_id", emp);
  }
  return { ok: true, xmls };
}

// dispara o workflow "Notas de compra (SEFAZ)" no GitHub, se a SEFAZ já permitir nova consulta
async function disparar(emp: string) {
  const { data: ctl } = await db.from("dfe_controle").select("proxima_em, rodando_ate").eq("empresa_id", emp).maybeSingle();
  const hora = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Fortaleza" });
  if (ctl?.rodando_ate && new Date(ctl.rodando_ate) > new Date()) return { disparado: false, rodando: true, mensagem: "A busca já está em andamento." };
  if (ctl?.proxima_em && new Date(ctl.proxima_em) > new Date())
    return { disparado: false, proxima_em: ctl.proxima_em, mensagem: `A SEFAZ só permite nova busca às ${hora(ctl.proxima_em)} (regra de 1 hora entre consultas sem novidade).` };
  const { data: tok } = await db.rpc("dfe_github_token");
  if (!tok) return { disparado: false, mensagem: "Falta ligar o botão ao GitHub (token github_dispatch no cofre)." };
  const r = await fetch("https://api.github.com/repos/tomamorim-gif/beep-caixa/actions/workflows/nfe-recebidas.yml/dispatches", {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "beep-caixa" },
    body: JSON.stringify({ ref: "main" }),
  });
  if (r.status !== 204) return { disparado: false, mensagem: `O GitHub não aceitou o pedido (HTTP ${r.status}). Confira o token github_dispatch.` };
  await db.from("dfe_controle").upsert({ empresa_id: emp, pedido_em: agoraIso() });
  return { disparado: true, mensagem: "Buscando na SEFAZ…" };
}

// Site público da SEFAZ-CE (o mesmo que o celular abre ao ler o QR do cupom). Abre a página antes,
// como o navegador, para receber o cookie de sessão, e depois pede o cupom à API do site.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
async function consultarCupom(entrada: string) {
  const c = lerCupom(entrada);
  let cookie = "";
  try {
    const pg = await fetch(c.pagina, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12_000) });
    cookie = pg.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ");
    await pg.body?.cancel();
  } catch { /* segue sem cookie */ }
  let r: Response;
  try {
    r = await fetch(c.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/plain, */*", "User-Agent": UA, Origin: CE_BASE, Referer: c.pagina, ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(c.payload), signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new Error("O site da SEFAZ-CE não respondeu. Tente de novo em alguns minutos."); }
  if (!r.ok) throw new Error(`O site da SEFAZ-CE está com problema agora (erro ${r.status}). Tente de novo em alguns minutos.`);
  const j = await r.json().catch(() => null) as { xml?: string; erro?: string } | null;
  const html = typeof j?.xml === "string" ? j.xml : "";
  if (!html) throw new CupomInvalido(erroSefaz(j?.erro, c.soChave));
  if (html.length > 3_000_000) throw new Error("Cupom grande demais");
  return { chave: c.chave, html };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return erro("use POST", 405);
  let b: Record<string, any>;
  try { b = await req.json(); } catch { return erro("JSON inválido"); }

  // GitHub Actions
  const ponte = req.headers.get("x-beep-ponte");
  if (ponte) {
    const { data: tok } = await db.rpc("dfe_ponte_token");
    if (!tok || String(tok).length < 32 || !igual(ponte, String(tok))) return erro("Não autorizado", 401);
    try {
      if (b.acao === "ponte_inicio") return json(await ponteInicio());
      if (b.acao === "ponte_resultado") return json(await ponteResultado(b));
    } catch (err) { return erro(String((err as Error).message), 500); }
    return erro("Ação desconhecida");
  }

  const emp = await membro(req);
  if (!emp) return erro("Entre no painel de gestão de novo", 401);

  if (b.acao === "atualizar") return json(await disparar(emp));

  if (b.acao === "buscar_chave") {
    const chave = String(b.chave ?? "").replace(/\D/g, "");
    if (!chaveValida(chave)) return erro("Chave de acesso inválida: confira os 44 números (precisa ser NF-e modelo 55)");
    const { data: ja } = await db.from("nfe_recebidas").select("status, xml_path").eq("empresa_id", emp).eq("chave", chave).maybeSingle();
    if (ja?.xml_path) {
      const { data: f } = await db.storage.from("notas").download(ja.xml_path);
      if (f) return json({ ok: true, xml: await f.text() });
    }
    if (ja?.status === "lancada") return erro("Esta nota já foi lançada");
    await registrar(emp, { tipo: "resumo", chave }, { situacao_sefaz: "1", status: "resumo", ultimo_erro: null });
    const d = await disparar(emp);
    return json({ ok: false, situacao: "fila", ...d, mensagem: d.disparado
      ? "Nota pedida à SEFAZ. Em 1 a 3 minutos ela aparece na lista, já com o XML para conferir."
      : `Nota pedida à SEFAZ. ${d.mensagem}` });
  }
  if (b.acao === "cupom") {
    try {
      const r = await consultarCupom(String(b.qr ?? b.chave ?? ""));
      return json({ ok: true, ...r });
    } catch (err) {
      return erro((err as Error).message, err instanceof CupomInvalido ? 422 : 502);
    }
  }
  return erro("Ação desconhecida");
});
