// Notas de compra (NF-e modelo 55) emitidas contra o CNPJ da empresa: consulta no Ambiente Nacional
// (NFeDistribuicaoDFe) e evento de "ciência da operação" (210210), que a SEFAZ exige para liberar o XML completo.
// Regras puras, sem banco e sem rede (ver supabase/tests/dfe.test.ts).
import { NS, so } from "./nfce.ts";

export const AN = {
  producao: {
    dist: "https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx",
    evento: "https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx",
  },
  homologacao: {
    dist: "https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx",
    evento: "https://hom1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx",
  },
} as const;

export function chaveValida(chave: string) {
  if (!/^\d{44}$/.test(chave)) return false;
  let soma = 0, peso = 2;
  for (let i = 42; i >= 0; i--) { soma += Number(chave[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  const r = soma % 11, dv = r < 2 ? 0 : 11 - r;
  return dv === Number(chave[43]) && chave.slice(20, 22) === "55";
}

// pedido dos documentos novos a partir do último NSU lido (até 50 por vez)
export function distPorNsu(p: { tpAmb: number; cUF: string; cnpj: string; ultNsu: string }) {
  const nsu = so(p.ultNsu).padStart(15, "0").slice(-15);
  return `<distDFeInt xmlns="${NS}" versao="1.01"><tpAmb>${p.tpAmb}</tpAmb><cUFAutor>${p.cUF}</cUFAutor><CNPJ>${so(p.cnpj)}</CNPJ><distNSU><ultNSU>${nsu}</ultNSU></distNSU></distDFeInt>`;
}

// pedido de um documento pela chave
export function distPorChave(p: { tpAmb: number; cUF: string; cnpj: string; chave: string }) {
  return `<distDFeInt xmlns="${NS}" versao="1.01"><tpAmb>${p.tpAmb}</tpAmb><cUFAutor>${p.cUF}</cUFAutor><CNPJ>${so(p.cnpj)}</CNPJ><consChNFe><chNFe>${p.chave}</chNFe></consChNFe></distDFeInt>`;
}

// o serviço de distribuição usa um envelope próprio (nfeDadosMsg dentro de nfeDistDFeInteresse)
export function soapDist(corpo: string) {
  return `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg>${corpo}</nfeDadosMsg></nfeDistDFeInteresse></soap12:Body></soap12:Envelope>`;
}

// ciência da operação: <infEvento> canônico para assinar (órgão 91 = Ambiente Nacional)
export function infEventoCiencia(p: { tpAmb: number; cnpj: string; chave: string; dh: string }) {
  const id = `ID210210${p.chave}01`;
  const xml = `<infEvento xmlns="${NS}" Id="${id}"><cOrgao>91</cOrgao><tpAmb>${p.tpAmb}</tpAmb><CNPJ>${so(p.cnpj)}</CNPJ><chNFe>${p.chave}</chNFe><dhEvento>${p.dh}</dhEvento><tpEvento>210210</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Ciencia da Operacao</descEvento></detEvento></infEvento>`;
  return { xml, id };
}

export type DocDist = { nsu: string; schema: string; b64: string };
export function lerDist(xml: string) {
  const cStat = Number((xml.match(/<cStat>(\d+)<\/cStat>/) ?? [])[1] ?? 0);
  const motivo = (xml.match(/<xMotivo>([^<]*)<\/xMotivo>/) ?? [])[1] ?? "";
  const docs: DocDist[] = [...xml.matchAll(/<docZip\s+([^>]*)>([^<]+)<\/docZip>/g)].map((m) => ({
    nsu: (m[1].match(/NSU="(\d+)"/) ?? [])[1] ?? "", schema: (m[1].match(/schema="([^"]+)"/) ?? [])[1] ?? "", b64: m[2].trim(),
  }));
  const ultNsu = (xml.match(/<ultNSU>(\d+)<\/ultNSU>/) ?? [])[1] ?? "";
  const maxNsu = (xml.match(/<maxNSU>(\d+)<\/maxNSU>/) ?? [])[1] ?? "";
  return { cStat, motivo, docs, ultNsu, maxNsu };
}

const tx = (xml: string, nome: string) => (xml.match(new RegExp(`<${nome}>([^<]*)</${nome}>`)) ?? [])[1] ?? null;

// resumo da nota (resNFe), nota completa (procNFe/nfeProc) ou evento (resEvento) -> dados para a lista
export type Recebida = { tipo: "resumo" | "nota" | "evento" | "outro"; chave: string | null; emitenteCnpj?: string | null; emitenteNome?: string | null; emissao?: string | null; valor?: number | null; situacao?: string | null; tpEvento?: string | null };
export function lerDoc(schema: string, xml: string): Recebida {
  if (schema.startsWith("resNFe")) {
    return { tipo: "resumo", chave: tx(xml, "chNFe"), emitenteCnpj: tx(xml, "CNPJ") ?? tx(xml, "CPF"), emitenteNome: tx(xml, "xNome"), emissao: tx(xml, "dhEmi"), valor: centavos(tx(xml, "vNF")), situacao: tx(xml, "cSitNFe") };
  }
  if (schema.startsWith("procNFe")) {
    const id = (xml.match(/<infNFe[^>]*Id="NFe(\d{44})"/) ?? [])[1] ?? tx(xml, "chNFe");
    const emit = (xml.match(/<emit>[\s\S]*?<\/emit>/) ?? [""])[0];
    const tot = (xml.match(/<ICMSTot>[\s\S]*?<\/ICMSTot>/) ?? [""])[0];
    return { tipo: "nota", chave: id, emitenteCnpj: tx(emit, "CNPJ") ?? tx(emit, "CPF"), emitenteNome: tx(emit, "xNome"), emissao: tx(xml, "dhEmi") ?? tx(xml, "dEmi"), valor: centavos(tx(tot, "vNF")) };
  }
  if (schema.startsWith("resEvento") || schema.startsWith("procEventoNFe")) return { tipo: "evento", chave: tx(xml, "chNFe"), tpEvento: tx(xml, "tpEvento") };
  return { tipo: "outro", chave: null };
}
const centavos = (v: string | null) => (v == null || v === "" ? null : Math.round(Number(v) * 100));

export async function gunzipB64(b64: string) {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const s = new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(s).text();
}
