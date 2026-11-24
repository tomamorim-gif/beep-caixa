// Busca das notas de compra na SEFAZ (Ambiente Nacional), rodando no GitHub Actions quando o painel pede.
// Por que aqui e não no Supabase: o Ambiente Nacional pede o certificado por renegociação TLS,
// que o servidor do Supabase (Deno/rustls) não suporta; o Node (OpenSSL) suporta.
// Fluxo: pede à função nfe-entrada o que fazer (ponte_inicio), conversa com a SEFAZ e devolve o resultado (ponte_resultado).
// O repositório é público: este script NÃO imprime certificado, chave, CNPJ, fornecedor nem conteúdo de nota. Só contagens.
// Rodar: BEEP_PONTE=... node --experimental-strip-types scripts/nfe-recebidas.ts
import https from "node:https";
import forge from "node-forge";
import { agoraBR, assinar, campo, envEvento, soap } from "../supabase/functions/_shared/nfce.ts";
import { AN, distPorChave, distPorNsu, gunzipB64, infEventoCiencia, lerDist, soapDist } from "../supabase/functions/_shared/dfe.ts";

const FUNC = "https://gdnvjpmpfgautrmtkjmx.supabase.co/functions/v1/nfe-entrada";
const TOKEN = process.env.BEEP_PONTE ?? "";
if (!TOKEN) { console.error("Falta o segredo BEEP_PONTE no GitHub (Settings > Secrets and variables > Actions)."); process.exit(1); }

async function ponte(acao: string, corpo: Record<string, unknown> = {}) {
  const r = await fetch(FUNC, { method: "POST", headers: { "content-type": "application/json", "x-beep-ponte": TOKEN }, body: JSON.stringify({ acao, ...corpo }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`função respondeu ${r.status}: ${j.erro ?? ""}`);
  return j;
}

type Cred = { key: string; cert: string; keyObj: any; certB64: string };
function lerPfx(pfxB64: string, senha: string): Cred {
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.decode64(pfxB64)), false, senha);
  const keys = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const key = keys[0]?.key;
  const certs = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const cert = certs.map((c: any) => c.cert).find((c: any) => c?.publicKey?.n?.equals?.(key?.n)) ?? certs[0]?.cert;
  if (!key || !cert) throw new Error("certificado incompleto");
  return {
    key: forge.pki.privateKeyToPem(key), cert: forge.pki.certificateToPem(cert), keyObj: key,
    certB64: forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()),
  };
}

function post(c: Cred, url: string, corpo: string, acao: string): Promise<string> {
  const u = new URL(url);
  return new Promise((ok, falha) => {
    const req = https.request({
      host: u.hostname, path: u.pathname, method: "POST", key: c.key, cert: c.cert, timeout: 30_000,
      headers: { "Content-Type": `application/soap+xml; charset=utf-8; action="${acao}"`, "Content-Length": Buffer.byteLength(corpo) },
    }, (res) => {
      let t = ""; res.setEncoding("utf8"); res.on("data", (d) => (t += d));
      res.on("end", () => (res.statusCode && res.statusCode < 500) || t.includes("cStat") ? ok(t) : falha(new Error(`SEFAZ HTTP ${res.statusCode}`)));
    });
    req.on("timeout", () => req.destroy(new Error("SEFAZ não respondeu em 30 s")));
    req.on("error", falha);
    req.end(corpo);
  });
}

const DIST = "http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse";
const EVT = "http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4/nfeRecepcaoEvento";

async function ciencia(c: Cred, cnpj: string, chave: string) {
  const { xml, id } = infEventoCiencia({ tpAmb: 1, cnpj, chave, dh: agoraBR() });
  const signer = (s: string) => { const md = forge.md.sha1.create(); md.update(s, "utf8"); return forge.util.encode64(c.keyObj.sign(md)); };
  const corpo = envEvento(String(Date.now()).slice(-15), xml, await assinar(xml, id, signer, c.certB64));
  const r = await post(c, AN.producao.evento, soap("NFeRecepcaoEvento4", corpo), EVT);
  const ret = r.slice(Math.max(0, r.indexOf("<retEvento")));
  return { chave, cStat: Number(campo(ret, "cStat")), motivo: campo(ret, "xMotivo") ?? "" };
}

async function empresa(e: any) {
  const c = lerPfx(e.pfx, e.senha);
  const out: any = { empresa_id: e.empresa_id, ult_nsu: e.ult_nsu, docs: [], ciencias: [], erro: null, espera_horas: 1 };
  const inicio = Date.now();
  try {
    // 1) ciência das notas que só têm resumo (libera o XML)
    for (const chave of e.ciencia ?? []) out.ciencias.push(await ciencia(c, e.cnpj, chave));
    // 2) notas pedidas pela chave no painel
    for (const chave of e.consultar ?? []) {
      const d = lerDist(await post(c, AN.producao.dist, soapDist(distPorChave({ tpAmb: 1, cUF: e.cUF, cnpj: e.cnpj, chave })), DIST));
      if (d.cStat === 656) { out.erro = "SEFAZ pediu para esperar 1 hora (consumo indevido)"; return out; }
      for (const doc of d.docs) out.docs.push({ nsu: null, schema: doc.schema, xml: await gunzipB64(doc.b64) });
    }
    // 3) documentos novos por NSU (até 50 por vez)
    for (let volta = 0; volta < 30; volta++) {
      const d = lerDist(await post(c, AN.producao.dist, soapDist(distPorNsu({ tpAmb: 1, cUF: e.cUF, cnpj: e.cnpj, ultNsu: out.ult_nsu })), DIST));
      if (d.cStat === 656) { out.erro = "SEFAZ pediu para esperar 1 hora (consumo indevido)"; break; }
      if (d.cStat !== 137 && d.cStat !== 138) { out.erro = `SEFAZ ${d.cStat}: ${d.motivo}`; break; }
      if (d.ultNsu) out.ult_nsu = d.ultNsu;
      for (const doc of d.docs) out.docs.push({ nsu: doc.nsu, schema: doc.schema, xml: await gunzipB64(doc.b64) });
      if (d.cStat === 137 || !d.maxNsu || out.ult_nsu >= d.maxNsu) break;
      if (Date.now() - inicio > 4 * 60_000) { out.espera_horas = 0.02; break; } // continua na próxima rodada
    }
  } catch (err) {
    out.erro = String((err as Error).message).slice(0, 300);
    out.espera_horas = 0.25;
  }
  return out;
}

const ini = await ponte("ponte_inicio");
for (const e of ini.empresas ?? []) {
  const res = await empresa(e);
  // manda em partes para não estourar o tamanho do pedido
  const docs = res.docs as unknown[];
  for (let i = 0; i < docs.length || i === 0; i += 40) {
    const parte = docs.slice(i, i + 40), ultima = i + 40 >= docs.length;
    const r = await ponte("ponte_resultado", { ...res, docs: parte, ciencias: i === 0 ? res.ciencias : [], final: ultima });
    if (ultima) console.log(`empresa ${String(e.empresa_id).slice(0, 8)}: ${docs.length} documentos, ${res.ciencias.length} ciências, ${r.xmls ?? 0} XML novos${res.erro ? ", aviso: " + (res.erro.startsWith("SEFAZ") ? res.erro : "falha de conexão") : ""}`);
    if (ultima) break;
  }
}
if (!(ini.empresas ?? []).length) console.log("nada a fazer agora (fora do horário permitido pela SEFAZ ou sem certificado)");
