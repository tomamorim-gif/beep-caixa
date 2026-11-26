// Regras puras da NFC-e (modelo 65, leiaute 4.00): chave de acesso, XML, QR Code e leitura das respostas da SEFAZ.
// Sem banco e sem rede: dá para testar fora do Supabase (ver supabase/tests/nfce.test.ts).
// O XML é montado já na forma canônica (C14N): atributos em ordem, sem tags vazias abreviadas, sem espaços,
// e é essa mesma forma que é assinada.

export const NS = "http://www.portalfiscal.inf.br/nfe";
export const UF_CODIGO: Record<string, string> = { CE: "23", MA: "21", PI: "22", RN: "24", PB: "25", PE: "26" };

// Endereços. CE autoriza NFC-e pela SVRS desde 07/2025; o QR Code e a consulta continuam no portal do CE.
// urlChave: endereço oficial da tabela nacional de URLs de consulta (o mesmo para produção e homologação no CE).
export const WS: Record<string, Record<string, Record<string, string>>> = {
  CE: {
    homologacao: {
      autorizacao: "https://nfce-homologacao.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx",
      status: "https://nfce-homologacao.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx",
      consulta: "https://nfce-homologacao.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx",
      evento: "https://nfce-homologacao.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx",
      qrcode: "http://nfceh.sefaz.ce.gov.br/pages/ShowNFCe.html",
      urlChave: "http://www.sefaz.ce.gov.br/nfce/consulta",
    },
    producao: {
      autorizacao: "https://nfce.svrs.rs.gov.br/ws/NfeAutorizacao/NFeAutorizacao4.asmx",
      status: "https://nfce.svrs.rs.gov.br/ws/NfeStatusServico/NfeStatusServico4.asmx",
      consulta: "https://nfce.svrs.rs.gov.br/ws/NfeConsulta/NfeConsulta4.asmx",
      evento: "https://nfce.svrs.rs.gov.br/ws/recepcaoevento/recepcaoevento4.asmx",
      qrcode: "http://nfce.sefaz.ce.gov.br/pages/ShowNFCe.html",
      urlChave: "http://www.sefaz.ce.gov.br/nfce/consulta",
    },
  },
};

export const so = (v: unknown) => String(v ?? "").replace(/\D/g, "");

// texto dentro do XML (C14N escapa &, < e >; também tiramos acentos problemáticos de controle)
export function esc(v: unknown, max = 120) {
  return String(v ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const tag = (n: string, v: unknown, max?: number) => `<${n}>${esc(v, max)}</${n}>`;
const opt = (n: string, v: unknown, max?: number) => (v == null || String(v).trim() === "" ? "" : tag(n, v, max));
export const dec = (centavos: number) => (centavos / 100).toFixed(2);

// dígito verificador da chave (módulo 11, pesos 2 a 9 da direita para a esquerda)
export function dvChave(c43: string) {
  let soma = 0, peso = 2;
  for (let i = c43.length - 1; i >= 0; i--) {
    soma += Number(c43[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const r = soma % 11;
  return r < 2 ? 0 : 11 - r;
}

export function montarChave(p: { cUF: string; dhEmi: string; cnpj: string; serie: number; numero: number; tpEmis: number; cNF: string }) {
  const aamm = p.dhEmi.slice(2, 4) + p.dhEmi.slice(5, 7);
  const c43 = p.cUF + aamm + so(p.cnpj).padStart(14, "0") + "65" + String(p.serie).padStart(3, "0") + String(p.numero).padStart(9, "0") + String(p.tpEmis) + p.cNF;
  return c43 + dvChave(c43);
}

// código numérico aleatório de 8 dígitos, diferente do número da nota
export function codigoNumerico(numero: number) {
  let c = "";
  do c = String(crypto.getRandomValues(new Uint32Array(1))[0] % 100000000).padStart(8, "0");
  while (Number(c) === numero || /^(\d)\1{7}$/.test(c));
  return c;
}

// data/hora de Brasília (sem horário de verão)
export function agoraBR(d = new Date()) {
  const t = new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 19);
  return t + "-03:00";
}

// GTIN válido de circulação nacional; código interno (começa com 2 ou zeros) vira "SEM GTIN"
export function gtin(c: unknown) {
  const v = so(c);
  if (![8, 12, 13, 14].includes(v.length)) return "SEM GTIN";
  const g = v.padStart(14, "0");
  if (/^0{6}/.test(v.padStart(13, "0")) || /^2/.test(v.length === 13 ? v : g.slice(1))) return "SEM GTIN";
  let s = 0;
  for (let i = 0; i < 13; i++) s += Number(g[i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (s % 10)) % 10 === Number(g[13]) ? v : "SEM GTIN";
}

// bandeira do cartão (texto do Mercado Pago/PagBank) -> código da tabela tBand
export function bandeira(b: unknown) {
  const x = String(b ?? "").toLowerCase();
  if (x.includes("visa")) return "01";
  if (x.includes("master")) return "02";
  if (x.includes("amex") || x.includes("american")) return "03";
  if (x.includes("diners")) return "05";
  if (x.includes("elo")) return "06";
  if (x.includes("hiper")) return "07";
  if (x.includes("cabal")) return "09";
  return x ? "99" : null;
}

export const TPAG: Record<string, string> = { credito: "03", debito: "04", pix: "17" };
export const CNPJ_MERCADO_PAGO = "10573521000191";
export const CNPJ_PAGBANK = "08561701000101";

export type Emitente = {
  cnpj: string; razao: string; fantasia?: string | null; ie: string; crt: number;
  logradouro: string; numero: string; complemento?: string | null; bairro: string;
  cod_municipio: string; municipio: string; uf: string; cep: string; fone?: string | null;
};
export type Item = {
  codigo: string; ean?: string | null; nome: string; ncm: string; cest?: string | null; cfop: string;
  unidade: string; quantidade: number; preco_unit: number; origem: number; csosn: string; cst_pis_cofins: string;
};
export type Pagamento = { forma: string; valor: number; bandeira?: string | null; autorizacao?: string | null; nsu?: string | null; provedor?: string | null };
export type Nota = {
  emit: Emitente; itens: Item[]; pagamentos: Pagamento[];
  serie: number; numero: number; tpAmb: 1 | 2; dhEmi: string; cNF: string; tpEmis?: number;
  infCpl?: string | null;
};

function icms(i: Item) {
  const orig = `<orig>${Number(i.origem) || 0}</orig>`;
  switch (i.csosn) {
    case "500":
      return `<ICMSSN500>${orig}<CSOSN>500</CSOSN></ICMSSN500>`;
    case "201":
      // sem base e alíquota de ST no cadastro: vai zerado (só aceito em homologação, ver index.ts)
      return `<ICMSSN201>${orig}<CSOSN>201</CSOSN><modBCST>4</modBCST><vBCST>0.00</vBCST><pICMSST>0.0000</pICMSST><vICMSST>0.00</vICMSST></ICMSSN201>`;
    case "101":
      return `<ICMSSN101>${orig}<CSOSN>101</CSOSN><pCredSN>0.0000</pCredSN><vCredICMSSN>0.00</vCredICMSSN></ICMSSN101>`;
    case "900":
      return `<ICMSSN900>${orig}<CSOSN>900</CSOSN></ICMSSN900>`;
    default: // 102, 103, 300, 400
      return `<ICMSSN102>${orig}<CSOSN>${["102", "103", "300", "400"].includes(i.csosn) ? i.csosn : "102"}</CSOSN></ICMSSN102>`;
  }
}

function pisCofins(cst: string, vProd: string) {
  const c = String(cst || "49").padStart(2, "0");
  if (["04", "05", "06", "07", "08", "09"].includes(c))
    return `<PIS><PISNT><CST>${c}</CST></PISNT></PIS><COFINS><COFINSNT><CST>${c}</CST></COFINSNT></COFINS>`;
  if (c === "01" || c === "02")
    return `<PIS><PISAliq><CST>${c}</CST><vBC>${vProd}</vBC><pPIS>0.0000</pPIS><vPIS>0.00</vPIS></PISAliq></PIS><COFINS><COFINSAliq><CST>${c}</CST><vBC>${vProd}</vBC><pCOFINS>0.0000</pCOFINS><vCOFINS>0.00</vCOFINS></COFINSAliq></COFINS>`;
  return `<PIS><PISOutr><CST>${c}</CST><vBC>0.00</vBC><pPIS>0.0000</pPIS><vPIS>0.00</vPIS></PISOutr></PIS><COFINS><COFINSOutr><CST>${c}</CST><vBC>0.00</vBC><pCOFINS>0.0000</pCOFINS><vCOFINS>0.00</vCOFINS></COFINSOutr></COFINS>`;
}

const HOMOLOG = "NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL";

// <infNFe> já canônico, com o xmlns herdado do <NFe> (é assim que a C14N enxerga o elemento assinado)
export function montarInfNFe(n: Nota) {
  const e = n.emit, cUF = UF_CODIGO[e.uf];
  if (!cUF) throw new Error(`UF ${e.uf} ainda não configurada para NFC-e`);
  const tpEmis = n.tpEmis ?? 1;
  const chave = montarChave({ cUF, dhEmi: n.dhEmi, cnpj: e.cnpj, serie: n.serie, numero: n.numero, tpEmis, cNF: n.cNF });
  let vProdTot = 0;
  const dets = n.itens.map((i, k) => {
    const vProd = i.quantidade * i.preco_unit;
    vProdTot += vProd;
    const g = gtin(i.ean), q = i.quantidade.toFixed(4), vu = (i.preco_unit / 100).toFixed(10), un = esc(i.unidade || "UN", 6);
    const nome = n.tpAmb === 2 && k === 0 ? HOMOLOG : i.nome;
    return `<det nItem="${k + 1}"><prod>${tag("cProd", i.codigo, 60)}<cEAN>${g}</cEAN>${tag("xProd", nome, 120)}<NCM>${so(i.ncm)}</NCM>${opt("CEST", so(i.cest))}<CFOP>${so(i.cfop)}</CFOP><uCom>${un}</uCom><qCom>${q}</qCom><vUnCom>${vu}</vUnCom><vProd>${dec(vProd)}</vProd><cEANTrib>${g}</cEANTrib><uTrib>${un}</uTrib><qTrib>${q}</qTrib><vUnTrib>${vu}</vUnTrib><indTot>1</indTot></prod>`
      + `<imposto><ICMS>${icms(i)}</ICMS>${pisCofins(i.cst_pis_cofins, dec(vProd))}</imposto></det>`;
  }).join("");
  const vNF = dec(vProdTot);
  const pagTot = n.pagamentos.reduce((a, p) => a + p.valor, 0);
  const pags = n.pagamentos.map((p) => {
    const tPag = TPAG[p.forma] ?? "99";
    const cnpjCred = p.provedor === "pagbank" ? CNPJ_PAGBANK : CNPJ_MERCADO_PAGO;
    const tBand = p.forma === "pix" ? null : bandeira(p.bandeira);
    const card = tPag === "03" || tPag === "04" || tPag === "17"
      ? `<card><tpIntegra>1</tpIntegra><CNPJ>${cnpjCred}</CNPJ>${tBand ? `<tBand>${tBand}</tBand>` : ""}${opt("cAut", p.autorizacao || p.nsu, 128)}</card>`
      : "";
    return `<detPag><indPag>0</indPag><tPag>${tPag}</tPag>${tPag === "99" ? "<xPag>Outros</xPag>" : ""}<vPag>${dec(p.valor)}</vPag>${card}</detPag>`;
  }).join("");
  const troco = pagTot > vProdTot ? `<vTroco>${dec(pagTot - vProdTot)}</vTroco>` : "";
  const ender = `<enderEmit>${tag("xLgr", e.logradouro, 60)}${tag("nro", e.numero || "S/N", 60)}${opt("xCpl", e.complemento, 60)}${tag("xBairro", e.bairro, 60)}<cMun>${so(e.cod_municipio)}</cMun>${tag("xMun", e.municipio, 60)}<UF>${e.uf}</UF><CEP>${so(e.cep)}</CEP><cPais>1058</cPais><xPais>BRASIL</xPais>${opt("fone", so(e.fone))}</enderEmit>`;
  const xml = `<infNFe xmlns="${NS}" Id="NFe${chave}" versao="4.00">`
    + `<ide><cUF>${cUF}</cUF><cNF>${n.cNF}</cNF><natOp>VENDA</natOp><mod>65</mod><serie>${n.serie}</serie><nNF>${n.numero}</nNF><dhEmi>${n.dhEmi}</dhEmi><tpNF>1</tpNF><idDest>1</idDest><cMunFG>${so(e.cod_municipio)}</cMunFG><tpImp>4</tpImp><tpEmis>${tpEmis}</tpEmis><cDV>${chave.slice(-1)}</cDV><tpAmb>${n.tpAmb}</tpAmb><finNFe>1</finNFe><indFinal>1</indFinal><indPres>1</indPres><procEmi>0</procEmi><verProc>Beep 1.0</verProc></ide>`
    + `<emit><CNPJ>${so(e.cnpj)}</CNPJ>${tag("xNome", e.razao, 60)}${opt("xFant", e.fantasia, 60)}${ender}<IE>${so(e.ie)}</IE><CRT>${e.crt || 1}</CRT></emit>`
    + dets
    + `<total><ICMSTot><vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet><vProd>${vNF}</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro><vNF>${vNF}</vNF></ICMSTot></total>`
    + `<transp><modFrete>9</modFrete></transp>`
    + `<pag>${pags}${troco}</pag>`
    + (n.infCpl ? `<infAdic>${tag("infCpl", n.infCpl, 2000)}</infAdic>` : "")
    + `</infNFe>`;
  return { xml, chave, vNF };
}

// QR Code versão 2 (emissão normal): hash SHA-1 de "chave|2|tpAmb|idCSC" + CSC
export async function qrCodeV2(base: string, chave: string, tpAmb: number, cscId: string, csc: string) {
  const idToken = String(Number(cscId));
  const p = `${chave}|2|${tpAmb}|${idToken}`;
  const h = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(p + csc));
  const hex = [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `${base}?p=${p}|${hex}`;
}

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
export async function sha1b64(s: string) {
  return b64(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s)));
}

// <SignedInfo> canônico (com o xmlns do <Signature>, como a C14N enxerga ao assinar)
export function signedInfo(uri: string, digest: string) {
  return `<SignedInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></CanonicalizationMethod><SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod><Reference URI="#${uri}"><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform><Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"></Transform></Transforms><DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod><DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;
}

// assina um elemento canônico (infNFe ou infEvento): devolve o bloco <Signature>
export async function assinar(elementoC14n: string, id: string, assinarRsaSha1: (s: string) => Promise<string> | string, certB64: string) {
  const digest = await sha1b64(elementoC14n);
  const si = signedInfo(id, digest);
  const sig = await assinarRsaSha1(si);
  const siDoc = si.replace(' xmlns="http://www.w3.org/2000/09/xmldsig#"', "");
  return `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">${siDoc}<SignatureValue>${sig}</SignatureValue><KeyInfo><X509Data><X509Certificate>${certB64}</X509Certificate></X509Data></KeyInfo></Signature>`;
}

// NFe completa: infNFe + infNFeSupl (QR) + Signature
export function montarNFe(infNFeC14n: string, qrCode: string, urlChave: string, assinatura: string) {
  const inf = infNFeC14n.replace(`<infNFe xmlns="${NS}" `, "<infNFe ");
  return `<NFe xmlns="${NS}">${inf}<infNFeSupl><qrCode><![CDATA[${qrCode}]]></qrCode><urlChave>${urlChave}</urlChave></infNFeSupl>${assinatura}</NFe>`;
}

export function soap(servico: string, corpo: string) {
  return `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/${servico}">${corpo}</nfeDadosMsg></soap12:Body></soap12:Envelope>`;
}

export const loteAutorizacao = (idLote: string, nfe: string) => `<enviNFe xmlns="${NS}" versao="4.00"><idLote>${idLote}</idLote><indSinc>1</indSinc>${nfe}</enviNFe>`;
export const consStatServ = (tpAmb: number, cUF: string) => `<consStatServ xmlns="${NS}" versao="4.00"><tpAmb>${tpAmb}</tpAmb><cUF>${cUF}</cUF><xServ>STATUS</xServ></consStatServ>`;
export const consSitNFe = (tpAmb: number, chave: string) => `<consSitNFe xmlns="${NS}" versao="4.00"><tpAmb>${tpAmb}</tpAmb><xServ>CONSULTAR</xServ><chNFe>${chave}</chNFe></consSitNFe>`;

// evento de cancelamento (110111): <infEvento> canônico para assinar
export function infEventoCancelamento(p: { cUF: string; tpAmb: number; cnpj: string; chave: string; dh: string; protocolo: string; justificativa: string }) {
  const id = `ID110111${p.chave}01`;
  const xml = `<infEvento xmlns="${NS}" Id="${id}"><cOrgao>${p.cUF}</cOrgao><tpAmb>${p.tpAmb}</tpAmb><CNPJ>${so(p.cnpj)}</CNPJ><chNFe>${p.chave}</chNFe><dhEvento>${p.dh}</dhEvento><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Cancelamento</descEvento><nProt>${p.protocolo}</nProt>${tag("xJust", p.justificativa, 255)}</detEvento></infEvento>`;
  return { xml, id };
}
export function envEvento(idLote: string, infEventoC14n: string, assinatura: string) {
  const inf = infEventoC14n.replace(`<infEvento xmlns="${NS}" `, "<infEvento ");
  return `<envEvento xmlns="${NS}" versao="1.00"><idLote>${idLote}</idLote><evento xmlns="${NS}" versao="1.00">${inf}${assinatura}</evento></envEvento>`;
}

// leitura simples das respostas (texto do primeiro elemento com esse nome)
export function campo(xml: string, nome: string, depoisDe?: string) {
  let s = xml;
  if (depoisDe) { const i = s.indexOf(`<${depoisDe}`); if (i >= 0) s = s.slice(i); }
  const m = s.match(new RegExp(`<(?:\\w+:)?${nome}(?:\\s[^>]*)?>([^<]*)</(?:\\w+:)?${nome}>`));
  return m ? m[1] : null;
}
export function bloco(xml: string, nome: string) {
  const m = xml.match(new RegExp(`<${nome}[\\s>][\\s\\S]*?</${nome}>`));
  return m ? m[0] : null;
}

// resultado da autorização
export function lerRetorno(xml: string) {
  const lote = campo(xml, "cStat");
  const prot = bloco(xml, "protNFe");
  if (prot) {
    return {
      cStat: Number(campo(prot, "cStat")), motivo: campo(prot, "xMotivo") ?? "", protocolo: campo(prot, "nProt"),
      chave: campo(prot, "chNFe"), recebido: campo(prot, "dhRecbto"), protXml: prot, lote: Number(lote),
    };
  }
  return { cStat: Number(lote), motivo: campo(xml, "xMotivo") ?? "", protocolo: null, chave: null, recebido: null, protXml: null, lote: Number(lote) };
}

// 100 autorizada, 150 autorizada fora do prazo; 110/301/302 denegada (número usado, não reenviar)
export const AUTORIZADA = new Set([100, 150]);
export const DENEGADA = new Set([110, 301, 302, 303]);
// erros que não são do conteúdo da nota: tentar de novo depois
export const TEMPORARIO = new Set([105, 108, 109, 999]);
