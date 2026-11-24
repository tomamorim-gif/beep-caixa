// Notas de compra (NF-e 55) emitidas contra o CNPJ da empresa, direto da SEFAZ (Ambiente Nacional),
// com o certificado A1 da empresa:
//   - "sincronizar": lê os documentos novos (distribuição por NSU). Para cada resumo de nota, registra a
//     "ciência da operação" (evento 210210, exigido para liberar o XML; não aceita nem recusa a compra).
//     O XML completo chega numa leitura seguinte e fica guardado para a tela de Entrada de NF-e.
//     Roda sozinho pelo banco (pg_cron) e respeita a regra da SEFAZ: sem nada novo, só consulta de novo em 1 hora.
//   - "buscar_chave": busca uma nota específica pela chave de acesso (painel).
// Certificado e senha ficam no Vault; nada volta ao navegador.
import { createClient } from "jsr:@supabase/supabase-js@2";
import forge from "npm:node-forge@1.3.1";
import { UF_CODIGO, agoraBR, assinar, campo, envEvento, soap } from "../_shared/nfce.ts";
import { AN, chaveValida, distPorChave, distPorNsu, gunzipB64, infEventoCiencia, lerDist, lerDoc, soapDist } from "../_shared/dfe.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const erro = (m: string, s = 400) => json({ erro: m }, s);

type Cert = { keyPem: string; certPem: string; certB64: string; key: any; cnpj: string };
function lerPfx(pfxB64: string, senha: string): Cert {
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.decode64(pfxB64)), false, senha);
  const keys = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const key = keys[0]?.key;
  const certs = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const cert = certs.map((c: any) => c.cert).find((c: any) => c?.publicKey?.n?.equals?.(key?.n)) ?? certs[0]?.cert;
  if (!key || !cert) throw new Error("Certificado A1 incompleto");
  const cn = String(cert.subject.getField("CN")?.value ?? "");
  return {
    keyPem: forge.pki.privateKeyToPem(key), certPem: forge.pki.certificateToPem(cert), key,
    certB64: forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()),
    cnpj: (cn.match(/(\d{14})/) ?? [])[1] ?? "",
  };
}

let caIcp: string[] | null = null;
async function raizesIcp() {
  if (caIcp) return caIcp;
  const { data } = await db.storage.from("nfce").download("_ca/icp-brasil.pem");
  caIcp = data ? (await data.text()).split(/(?=-----BEGIN CERTIFICATE-----)/).filter((x) => x.includes("BEGIN")) : [];
  return caIcp;
}
function cliente(cert: Cert, ca: string[]) {
  // deno-lint-ignore no-explicit-any
  const o: any = { cert: cert.certPem, key: cert.keyPem, certChain: cert.certPem, privateKey: cert.keyPem };
  if (ca.length) o.caCerts = ca;
  return Deno.createHttpClient(o);
}
async function post(cert: Cert, url: string, envelope: string, acao: string) {
  const ir = async (cli: Deno.HttpClient) => {
    const r = await fetch(url, {
      method: "POST", client: cli, signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": `application/soap+xml; charset=utf-8; action="${acao}"` }, body: envelope,
    } as RequestInit);
    const t = await r.text();
    if (!r.ok && !t.includes("cStat")) throw new Error(`SEFAZ respondeu HTTP ${r.status}`);
    return t;
  };
  try { return await ir(cliente(cert, [])); } catch (e) {
    if (!/certificate|UnknownIssuer|tls|ssl/i.test(String((e as Error)?.message ?? e))) throw e;
    return await ir(cliente(cert, await raizesIcp()));
  }
}

async function membro(req: Request) {
  const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!tok) return null;
  const { data: u } = await db.auth.getUser(tok);
  if (!u?.user) return null;
  const { data: m } = await db.from("membros").select("empresa_id").eq("user_id", u.user.id).eq("ativo", true).in("papel", ["dono", "gerente"]).limit(1);
  return m?.[0]?.empresa_id as string | undefined ?? null;
}

async function consultar(cert: Cert, amb: "producao" | "homologacao", cUF: string, cnpj: string, chave: string) {
  const corpo = distPorChave({ tpAmb: amb === "producao" ? 1 : 2, cUF, cnpj, chave });
  const r = await post(cert, AN[amb].dist, soapDist(corpo), "http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse");
  const d = lerDist(r);
  for (const doc of d.docs) {
    if (doc.schema.startsWith("procNFe")) return { xml: await gunzipB64(doc.b64), cStat: d.cStat, motivo: d.motivo, resumo: false };
  }
  return { xml: null, cStat: d.cStat, motivo: d.motivo, resumo: d.docs.some((x) => x.schema.startsWith("resNFe")) };
}

async function ciencia(cert: Cert, amb: "producao" | "homologacao", cnpj: string, chave: string) {
  const { xml, id } = infEventoCiencia({ tpAmb: amb === "producao" ? 1 : 2, cnpj, chave, dh: agoraBR() });
  const signer = (s: string) => { const md = forge.md.sha1.create(); md.update(s, "utf8"); return forge.util.encode64(cert.key.sign(md)); };
  const corpo = envEvento(String(Date.now()).slice(-15), xml, await assinar(xml, id, signer, cert.certB64));
  const r = await post(cert, AN[amb].evento, soap("NFeRecepcaoEvento4", corpo), "http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4/nfeRecepcaoEvento");
  const ret = r.slice(Math.max(0, r.indexOf("<retEvento")));
  return { cStat: Number(campo(ret, "cStat")), motivo: campo(ret, "xMotivo") ?? "" };
}

function igual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const agoraIso = () => new Date().toISOString();
const emHoras = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

async function empresa(emp: string) {
  const [{ data: e }, { data: seg }] = await Promise.all([
    db.from("empresas").select("cnpj, uf").eq("id", emp).single(),
    db.rpc("fiscal_ler_segredos", { p_empresa: emp }),
  ]);
  const s = Array.isArray(seg) ? seg[0] : seg;
  if (!s?.pfx || !s?.senha) throw new Error("Certificado A1 não cadastrado (Configurações → NFC-e)");
  const cert = lerPfx(s.pfx, s.senha);
  return { cert, cnpj: String(e?.cnpj ?? "").replace(/\D/g, ""), cUF: UF_CODIGO[e?.uf ?? "CE"] ?? "23" };
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
  if (atual?.status === "xml" && dados.status === "ciencia") delete dados.status;
  if (atual && ["ciencia", "xml"].includes(atual.status) && dados.status === "resumo") delete dados.status;
  if (atual) await db.from("nfe_recebidas").update(dados).eq("id", atual.id);
  else await db.from("nfe_recebidas").insert({ empresa_id: emp, chave: d.chave, status: "resumo", ...dados });
}

async function sincronizar(emp: string) {
  // trava: uma leitura por empresa de cada vez, e respeita a espera pedida pela SEFAZ
  const { data: ctl } = await db.from("dfe_controle").select("*").eq("empresa_id", emp).maybeSingle();
  // mesmo no botão "Buscar agora": consultar antes da hora faz a SEFAZ bloquear por 1 hora (erro 656)
  if (ctl?.proxima_em && new Date(ctl.proxima_em) > new Date()) return { pulou: true, proxima_em: ctl.proxima_em };
  if (ctl?.rodando_ate && new Date(ctl.rodando_ate) > new Date()) return { pulou: true, rodando: true };
  await db.from("dfe_controle").upsert({ empresa_id: emp, ult_nsu: ctl?.ult_nsu ?? "000000000000000", rodando_ate: new Date(Date.now() + 5 * 60_000).toISOString() });

  const inicio = Date.now();
  let ult = ctl?.ult_nsu ?? "000000000000000", novos = 0, ciencias = 0, xmls = 0, espera = 0, erroMsg: string | null = null;
  try {
    const { cert, cnpj, cUF } = await empresa(emp);
    for (let volta = 0; volta < 20; volta++) {
      const r = await post(cert, AN.producao.dist, soapDist(distPorNsu({ tpAmb: 1, cUF, cnpj, ultNsu: ult })), "http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse");
      const d = lerDist(r);
      if (d.cStat === 656) { espera = 1; erroMsg = "SEFAZ pediu para esperar 1 hora (consumo indevido)"; break; }
      if (d.cStat !== 137 && d.cStat !== 138) { espera = 1; erroMsg = `SEFAZ ${d.cStat}: ${d.motivo}`; break; }
      if (d.ultNsu) ult = d.ultNsu;
      for (const doc of d.docs) {
        const xml = await gunzipB64(doc.b64), info = lerDoc(doc.schema, xml);
        if (info.tipo === "resumo") {
          novos++;
          const ativa = info.situacao === "1";
          await registrar(emp, info, { nsu: doc.nsu, situacao_sefaz: info.situacao, status: ativa ? "resumo" : "cancelada" });
        } else if (info.tipo === "nota" && info.chave) {
          const path = await guardarNota(emp, info.chave, xml);
          xmls++;
          await registrar(emp, info, { nsu: doc.nsu, xml_path: path, status: "xml", ultimo_erro: null });
        } else if (info.tipo === "evento" && info.chave && info.tpEvento === "110111") {
          await registrar(emp, info, { status: "cancelada", situacao_sefaz: "3" });
        }
      }
      // 137 = nada novo; ou chegou no último NSU: só volta em 1 hora (regra da SEFAZ)
      if (d.cStat === 137 || !d.maxNsu || ult >= d.maxNsu) { espera = 1; break; }
      if (Date.now() - inicio > 60_000) break; // continua na próxima rodada
    }
    // ciência das notas que só têm o resumo (no máximo 25 por rodada, para caber no tempo da função)
    const { data: pend } = await db.from("nfe_recebidas").select("chave").eq("empresa_id", emp).eq("status", "resumo")
      .eq("situacao_sefaz", "1").is("ultimo_erro", null).order("emissao", { ascending: false }).limit(25);
    for (const p of pend ?? []) {
      if (Date.now() - inicio > 110_000) break;
      try {
        const c = await ciencia(cert, "producao", cnpj, p.chave);
        if ([135, 136, 573].includes(c.cStat)) { ciencias++; await registrar(emp, { tipo: "resumo", chave: p.chave }, { status: "ciencia", ultimo_erro: null }); }
        else await registrar(emp, { tipo: "resumo", chave: p.chave }, { ultimo_erro: `Ciência não aceita (${c.cStat}): ${c.motivo}`.slice(0, 300) });
      } catch (e) { await registrar(emp, { tipo: "resumo", chave: p.chave }, { ultimo_erro: String((e as Error).message).slice(0, 300) }); }
    }
    // depois da ciência a SEFAZ libera o XML como documento novo: voltar em 15 minutos para buscá-lo
    if (ciencias && espera === 1) espera = 0.25;
  } catch (e) { erroMsg = String((e as Error).message).slice(0, 300); espera = espera || 0.25; }
  const proxima = emHoras(espera || 0.02);
  await db.from("dfe_controle").update({
    ult_nsu: ult, rodando_ate: null, ultima_em: agoraIso(), proxima_em: proxima, ultimo_erro: erroMsg,
    ...(erroMsg?.includes("656") || erroMsg?.includes("consumo") ? { limite_ate: proxima } : {}),
  }).eq("empresa_id", emp);
  return { novos, ciencias, xmls, proxima_em: proxima, erro: erroMsg };
}

async function buscarChave(emp: string, chave: string) {
  const { cert, cnpj, cUF } = await empresa(emp);
  let r = await consultar(cert, "producao", cUF, cnpj, chave);
  const salvar = async (xml: string) => {
    const path = await guardarNota(emp, chave, xml);
    await registrar(emp, lerDoc("procNFe", xml), { xml_path: path, status: "xml", ultimo_erro: null });
  };
  if (r.xml) { await salvar(r.xml); return { ok: true, xml: r.xml }; }
  if (r.cStat === 656) return { ok: false, situacao: "limite", mensagem: "A SEFAZ limita as consultas. Tente de novo daqui a 1 hora." };
  const c = await ciencia(cert, "producao", cnpj, chave);
  if (![135, 136, 573].includes(c.cStat)) return { ok: false, situacao: "erro", mensagem: `A SEFAZ não aceitou a ciência da nota (${c.cStat}): ${c.motivo}. Confira se a nota é para o CNPJ da empresa.` };
  await registrar(emp, { tipo: "resumo", chave }, { status: "ciencia" });
  await new Promise((ok) => setTimeout(ok, 2500));
  r = await consultar(cert, "producao", cUF, cnpj, chave);
  if (r.xml) { await salvar(r.xml); return { ok: true, xml: r.xml, ciencia: true }; }
  return { ok: false, situacao: "aguardando", mensagem: "Ciência registrada na SEFAZ. O XML costuma ser liberado em alguns minutos e vai aparecer sozinho na lista de notas recebidas." };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return erro("use POST", 405);
  let b: Record<string, any>;
  try { b = await req.json(); } catch { return erro("JSON inválido"); }

  // chamada do banco (pg_cron): sincroniza todas as empresas com certificado
  const interno = req.headers.get("x-beep-interno");
  if (interno) {
    const { data: chave } = await db.rpc("fiscal_chave_interna");
    if (!chave || !igual(interno, String(chave))) return erro("Não autorizado", 401);
    const { data: emps } = await db.from("fiscal_nfce").select("empresa_id").not("cert_validade", "is", null);
    const out: unknown[] = [];
    for (const x of emps ?? []) out.push({ empresa: x.empresa_id, ...(await sincronizar(x.empresa_id)) });
    return json({ ok: true, resultado: out });
  }

  const emp = await membro(req);
  if (!emp) return erro("Entre no painel de gestão de novo", 401);

  if (b.acao === "sincronizar") {
    try { return json({ ok: true, ...(await sincronizar(emp)) }); } catch (err) { return erro(String((err as Error).message), 502); }
  }
  if (b.acao === "buscar_chave") {
    const chave = String(b.chave ?? "").replace(/\D/g, "");
    if (!chaveValida(chave)) return erro("Chave de acesso inválida: confira os 44 números (precisa ser NF-e modelo 55)");
    try { return json(await buscarChave(emp, chave)); } catch (err) {
      return erro("Não consegui falar com a SEFAZ agora: " + String((err as Error).message).slice(0, 200), 502);
    }
  }
  return erro("Ação desconhecida");
});
