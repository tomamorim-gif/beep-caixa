// NFC-e: o servidor monta, assina com o certificado A1 e envia a nota de cada venda paga à SEFAZ.
// Quem chama:
//   - o próprio banco (venda paga -> "emitir"; a cada minuto -> "fila"; venda estornada -> "cancelar"), com a chave interna;
//   - o painel de gestão (dono/gerente), para configurar, testar, ver e reenviar notas;
//   - o caixa (token do aparelho), para pegar o QR Code da nota da venda que acabou de fazer.
// Certificado, senha e CSC ficam no cofre do Supabase (Vault). Nada disso volta para o navegador.
import { createClient } from "jsr:@supabase/supabase-js@2";
import forge from "npm:node-forge@1.3.1";
import {
  AUTORIZADA, DENEGADA, TEMPORARIO, UF_CODIGO, WS, agoraBR, assinar, campo, codigoNumerico, consSitNFe, consStatServ,
  envEvento, infEventoCancelamento, loteAutorizacao, lerRetorno, montarInfNFe, montarNFe, qrCodeV2, so, soap,
  type Item, type Pagamento,
} from "../_shared/nfce.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const erro = (m: string, s = 400) => json({ erro: m }, s);
const uuidOk = (s: unknown) => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);
const agoraIso = () => new Date().toISOString();

async function sha256(t: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function igual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------------- certificado ----------------
type Cert = { keyPem: string; certPem: string; certB64: string; key: any; titular: string; cnpj: string; validade: Date };

function lerPfx(pfxB64: string, senha: string): Cert {
  let p12: any;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.decode64(pfxB64)), false, senha);
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    throw new Error(/mac|password|invalid/i.test(m) ? "Senha do certificado incorreta" : "Arquivo de certificado inválido (" + m.slice(0, 80) + ")");
  }
  const keys = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const certs = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const key = keys[0]?.key;
  if (!key) throw new Error("O arquivo não tem a chave privada do certificado");
  // o certificado da empresa é o que casa com a chave (os outros são da cadeia da certificadora)
  const cert = certs.map((c: any) => c.cert).find((c: any) => c?.publicKey?.n?.equals?.(key.n)) ?? certs[0]?.cert;
  if (!cert) throw new Error("O arquivo não tem o certificado");
  const cn = String(cert.subject.getField("CN")?.value ?? "");
  const certB64 = forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());
  return {
    keyPem: forge.pki.privateKeyToPem(key), certPem: forge.pki.certificateToPem(cert), certB64, key,
    titular: cn.split(":")[0].slice(0, 120), cnpj: (cn.match(/(\d{14})/) ?? [])[1] ?? "", validade: cert.validity.notAfter,
  };
}

const cache = new Map<string, { cert: Cert; csc: string; client: Deno.HttpClient; em: number }>();
let caIcp: string[] | null = null;

// raízes da ICP-Brasil (alguns servidores da SEFAZ usam certificado dessa cadeia)
async function raizesIcp() {
  if (caIcp) return caIcp;
  const { data } = await db.storage.from("nfce").download("_ca/icp-brasil.pem");
  if (data) { caIcp = (await data.text()).split(/(?=-----BEGIN CERTIFICATE-----)/).filter((x) => x.includes("BEGIN")); return caIcp; }
  const out: string[] = [];
  for (const v of ["v5", "v10", "v11", "v12"]) {
    try {
      const r = await fetch(`http://acraiz.icpbrasil.gov.br/credenciadas/RAIZ/ICP-Brasil${v}.crt`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const bytes = new Uint8Array(await r.arrayBuffer());
      const txt = new TextDecoder().decode(bytes);
      if (txt.includes("BEGIN CERTIFICATE")) { out.push(txt.trim()); continue; }
      const b = btoa(String.fromCharCode(...bytes)).match(/.{1,64}/g)!.join("\n");
      out.push(`-----BEGIN CERTIFICATE-----\n${b}\n-----END CERTIFICATE-----`);
    } catch { /* sem essa raiz */ }
  }
  if (out.length) await db.storage.from("nfce").upload("_ca/icp-brasil.pem", new Blob([out.join("\n")]), { upsert: true, contentType: "application/x-pem-file" });
  caIcp = out;
  return out;
}

function clienteHttp(cert: Cert, ca: string[] = []) {
  // nomes novos (cert/key) e antigos (certChain/privateKey), conforme a versão do Deno do Supabase
  // deno-lint-ignore no-explicit-any
  const opts: any = { cert: cert.certPem, key: cert.keyPem, certChain: cert.certPem, privateKey: cert.keyPem };
  if (ca.length) opts.caCerts = ca;
  return Deno.createHttpClient(opts);
}

async function credencial(emp: string, forcarCa = false) {
  const c = cache.get(emp);
  if (c && !forcarCa && Date.now() - c.em < 10 * 60 * 1000) return c;
  const { data } = await db.rpc("fiscal_ler_segredos", { p_empresa: emp });
  const s = Array.isArray(data) ? data[0] : data;
  if (!s?.pfx || !s?.senha) throw new Error("Certificado A1 não cadastrado no painel");
  if (!s?.csc) throw new Error("CSC não cadastrado no painel");
  const cert = lerPfx(s.pfx, s.senha);
  const ca = forcarCa || caIcp ? await raizesIcp() : [];
  const novo = { cert, csc: s.csc, client: clienteHttp(cert, ca), em: Date.now() };
  cache.set(emp, novo);
  return novo;
}

// envia um SOAP à SEFAZ; se o TLS reclamar da cadeia do servidor, tenta de novo com as raízes da ICP-Brasil
async function enviar(emp: string, url: string, servico: string, corpo: string, acaoSoap: string) {
  const env = soap(servico, corpo);
  const ir = async (cli: Deno.HttpClient) => {
    const r = await fetch(url, {
      method: "POST", client: cli, signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": `application/soap+xml; charset=utf-8; action="http://www.portalfiscal.inf.br/nfe/wsdl/${servico}/${acaoSoap}"` },
      body: env,
    } as RequestInit);
    const t = await r.text();
    if (!r.ok && !t.includes("cStat")) throw new Error(`SEFAZ respondeu HTTP ${r.status}: ${t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 200)}`);
    return t;
  };
  let c = await credencial(emp);
  try { return await ir(c.client); } catch (e) {
    const m = String((e as Error)?.message ?? e);
    if (!/certificate|UnknownIssuer|tls|ssl/i.test(m) || caIcp?.length) throw e;
    c = await credencial(emp, true);
    return await ir(c.client);
  }
}

// ---------------- dados da empresa ----------------
async function configuracao(emp: string) {
  const [{ data: f }, { data: e }] = await Promise.all([
    db.from("fiscal_nfce").select("*").eq("empresa_id", emp).maybeSingle(),
    db.from("empresas").select("razao_social, nome_exibicao, cnpj, uf, regime_tributario").eq("id", emp).single(),
  ]);
  return { f, e };
}

function faltando(f: any) {
  const faltam: string[] = [];
  if (!f) return ["configuração"];
  for (const [k, n] of [["ie", "inscrição estadual"], ["logradouro", "endereço"], ["bairro", "bairro"], ["cod_municipio", "código do município"], ["municipio", "município"], ["cep", "CEP"], ["csc_id", "ID do CSC"], ["cert_validade", "certificado A1"]])
    if (!f[k]) faltam.push(n);
  return faltam;
}

const tpAmb = (f: any) => (f.ambiente === "producao" ? 1 : 2) as 1 | 2;
const ws = (f: any) => {
  const w = WS[f.uf]?.[f.ambiente];
  if (!w) throw new Error(`NFC-e ainda não configurada para a UF ${f.uf}`);
  return w;
};

async function guardarXml(path: string, xml: string) {
  await db.storage.from("nfce").upload(path, new Blob([xml], { type: "application/xml" }), { upsert: true, contentType: "application/xml" });
}

// ---------------- emissão ----------------
async function emitir(n: any): Promise<{ status: string; motivo?: string }> {
  const emp = n.empresa_id;
  const atualizar = (u: Record<string, unknown>) => db.from("nfce").update({ ...u, atualizado_em: agoraIso() }).eq("venda_id", n.venda_id);
  const falhaTemporaria = async (m: string) => {
    const t = (n.tentativas ?? 0) + 1, espera = Math.min(30, 2 ** Math.min(t, 5));
    await atualizar({ status: "fila", tentativas: t, ultimo_erro: m.slice(0, 500), processando_ate: new Date(Date.now() + espera * 60_000).toISOString() });
    return { status: "fila", motivo: m };
  };
  const rejeitar = async (m: string, cstat: number | null = null) => {
    await atualizar({ status: "rejeitada", tentativas: (n.tentativas ?? 0) + 1, ultimo_erro: m.slice(0, 500), cstat, processando_ate: null });
    return { status: "rejeitada", motivo: m };
  };

  const { f, e } = await configuracao(emp);
  if (!f?.ativo) return falhaTemporaria("NFC-e desligada no painel");
  const falta = faltando(f);
  if (falta.length) return falhaTemporaria("Falta no painel: " + falta.join(", "));

  const [{ data: v }, { data: itens }, { data: pags }] = await Promise.all([
    db.from("vendas").select("id, status, total, teste, local_id, finalizada_em").eq("id", n.venda_id).single(),
    db.from("venda_itens").select("seq, produto_id, quantidade, preco_unit").eq("venda_id", n.venda_id).order("seq"),
    db.from("pagamentos").select("forma, valor, status, nsu, autorizacao, bandeira").eq("venda_id", n.venda_id).eq("status", "aprovado"),
  ]);
  if (!v || v.status !== "paga") return rejeitar("A venda não está paga");
  if (v.teste && f.ambiente === "producao") return rejeitar("Venda de teste não gera nota em produção");
  // venda gravada em partes (caixa antigo): os itens chegam logo depois
  if (!itens?.length) return falhaTemporaria("Venda ainda sem itens");

  const ids = [...new Set(itens.map((i: any) => i.produto_id))];
  const { data: prods } = await db.from("produtos").select("id, nome, ean, sku, ncm, cest, unidade, origem, grupo_fiscal_id").in("id", ids);
  const gids = [...new Set((prods ?? []).map((p: any) => p.grupo_fiscal_id).filter(Boolean))];
  const { data: grupos } = gids.length ? await db.from("grupos_fiscais").select("id, csosn, cfop_saida, cst_pis_cofins").in("id", gids) : { data: [] };
  const pm = new Map((prods ?? []).map((p: any) => [p.id, p])), gm = new Map((grupos ?? []).map((g: any) => [g.id, g]));

  const linhas: Item[] = [];
  for (const i of itens) {
    const p: any = pm.get(i.produto_id), g: any = p && gm.get(p.grupo_fiscal_id);
    if (!p) return rejeitar("Produto da venda não encontrado");
    if (!/^\d{8}$/.test(p.ncm ?? "")) return rejeitar(`${p.nome}: falta o NCM no cadastro`);
    if (!g) return rejeitar(`${p.nome}: falta o grupo fiscal (CSOSN/CFOP) no cadastro`);
    if (g.csosn === "201" && f.ambiente === "producao") return rejeitar(`${p.nome}: CSOSN 201 precisa de base e alíquota de ST, que o cadastro não tem. Confirmar com o contador.`);
    linhas.push({
      codigo: p.sku || p.ean || p.id.slice(0, 8), ean: p.ean, nome: p.nome, ncm: p.ncm, cest: p.cest, cfop: g.cfop_saida,
      unidade: p.unidade || "UN", quantidade: Number(i.quantidade), preco_unit: i.preco_unit, origem: p.origem ?? 0,
      csosn: g.csosn, cst_pis_cofins: g.cst_pis_cofins,
    });
  }
  const totalItens = linhas.reduce((a, l) => a + l.quantidade * l.preco_unit, 0);
  let pagamentos: Pagamento[] = (pags ?? []).map((p: any) => ({ forma: p.forma, valor: p.valor, bandeira: p.bandeira, autorizacao: p.autorizacao, nsu: p.nsu, provedor: /^\d{6}$/.test(String(p.nsu ?? "")) ? "pagbank" : "mercadopago" }));
  if (!pagamentos.length) return rejeitar("Venda sem pagamento aprovado");
  // a nota fecha com o valor dos itens; diferença de pagamento fica registrada na venda para conferência
  const pagTot = pagamentos.reduce((a, p) => a + p.valor, 0);
  if (pagTot < totalItens) pagamentos = [{ ...pagamentos[0], valor: pagamentos[0].valor + (totalItens - pagTot) }, ...pagamentos.slice(1)];

  // número da série: reservado uma vez e reaproveitado se a SEFAZ rejeitar e a nota for reenviada
  let serie = n.serie, numero = n.numero;
  if (!numero) {
    const { data: r } = await db.rpc("fiscal_reservar_numero", { p_empresa: emp });
    const x = Array.isArray(r) ? r[0] : r;
    if (!x?.numero) return falhaTemporaria("Não foi possível reservar o número da nota");
    serie = x.serie; numero = x.numero;
    await atualizar({ serie, numero, ambiente: f.ambiente });
  }

  let cred;
  try { cred = await credencial(emp); } catch (err) { return falhaTemporaria(String((err as Error).message)); }
  const w = ws(f), amb = tpAmb(f), dhEmi = agoraBR();
  const emit = {
    cnpj: e.cnpj, razao: e.razao_social, fantasia: e.nome_exibicao, ie: f.ie, crt: f.crt, logradouro: f.logradouro, numero: f.numero,
    complemento: f.complemento, bairro: f.bairro, cod_municipio: f.cod_municipio, municipio: f.municipio, uf: f.uf, cep: f.cep, fone: f.fone,
  };
  const { xml: inf, chave } = montarInfNFe({ emit, itens: linhas, pagamentos, serie, numero, tpAmb: amb, dhEmi, cNF: codigoNumerico(numero) });
  const signer = (s: string) => { const md = forge.md.sha1.create(); md.update(s, "utf8"); return forge.util.encode64(cred.cert.key.sign(md)); };
  const sig = await assinar(inf, "NFe" + chave, signer, cred.cert.certB64);
  const qr = await qrCodeV2(w.qrcode, chave, amb, f.csc_id, cred.csc);
  const nfe = montarNFe(inf, qr, w.urlChave, sig);
  const pasta = `${emp}/${f.ambiente}/${dhEmi.slice(0, 7)}`;
  await guardarXml(`${pasta}/${chave}-nfe.xml`, nfe);
  await atualizar({ chave, dh_emissao: new Date().toISOString(), qrcode_url: qr });

  let resp: string;
  try {
    resp = await enviar(emp, w.autorizacao, "NFeAutorizacao4", loteAutorizacao(String(Date.now()).slice(-15), nfe), "nfeAutorizacaoLote");
  } catch (err) {
    return falhaTemporaria("Sem resposta da SEFAZ: " + String((err as Error).message).slice(0, 200));
  }
  const r = lerRetorno(resp);

  if (AUTORIZADA.has(r.cStat)) {
    const proc = `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">${nfe}${r.protXml}</nfeProc>`;
    const path = `${pasta}/${chave}-procNFe.xml`;
    await guardarXml(path, proc);
    await atualizar({ status: "autorizada", protocolo: r.protocolo, cstat: r.cStat, ultimo_erro: null, xml_path: path, processando_ate: null, tentativas: (n.tentativas ?? 0) + 1 });
    return { status: "autorizada" };
  }
  // a SEFAZ já tem uma nota com esse número (envio anterior sem resposta): adota a que foi autorizada
  const outra = (r.motivo.match(/\d{44}/) ?? [])[0];
  if ((r.cStat === 204 || r.cStat === 539) && outra) {
    try {
      const c = await enviar(emp, w.consulta, "NFeConsultaProtocolo4", consSitNFe(amb, outra), "nfeConsultaNF");
      const cr = lerRetorno(c);
      if (AUTORIZADA.has(cr.cStat)) {
        await atualizar({ status: "autorizada", chave: outra, protocolo: cr.protocolo, cstat: cr.cStat, ultimo_erro: "Autorizada em envio anterior", processando_ate: null });
        return { status: "autorizada" };
      }
    } catch { /* cai na rejeição abaixo */ }
  }
  if (TEMPORARIO.has(r.cStat) || !r.cStat) return falhaTemporaria(`SEFAZ ${r.cStat || "?"}: ${r.motivo}`);
  if (DENEGADA.has(r.cStat)) {
    await atualizar({ status: "rejeitada", cstat: r.cStat, ultimo_erro: `Denegada (${r.cStat}): ${r.motivo}. Este número não pode ser usado de novo.`, processando_ate: null });
    return { status: "rejeitada", motivo: r.motivo };
  }
  return rejeitar(`Rejeição ${r.cStat}: ${r.motivo}`, r.cStat);
}

async function cancelar(vendaId: string, justificativa = "Venda cancelada e valor estornado ao cliente") {
  const { data: n } = await db.from("nfce").select("*").eq("venda_id", vendaId).maybeSingle();
  if (!n) return { status: "sem_nota" };
  if (n.status === "cancelada") return { status: "cancelada" };
  if (n.status !== "autorizada") {
    await db.from("nfce").update({ status: "cancelada", ultimo_erro: "Venda cancelada antes da autorização", atualizado_em: agoraIso() }).eq("venda_id", vendaId);
    return { status: "cancelada" };
  }
  const { f, e } = await configuracao(n.empresa_id);
  const fa = { ...f, ambiente: n.ambiente ?? f.ambiente };
  const w = ws(fa), amb = tpAmb(fa), cred = await credencial(n.empresa_id);
  const { xml, id } = infEventoCancelamento({ cUF: UF_CODIGO[f.uf], tpAmb: amb, cnpj: e.cnpj, chave: n.chave, dh: agoraBR(), protocolo: n.protocolo, justificativa });
  const signer = (s: string) => { const md = forge.md.sha1.create(); md.update(s, "utf8"); return forge.util.encode64(cred.cert.key.sign(md)); };
  const sig = await assinar(xml, id, signer, cred.cert.certB64);
  const corpo = envEvento(String(Date.now()).slice(-15), xml, sig);
  const resp = await enviar(n.empresa_id, w.evento, "NFeRecepcaoEvento4", corpo, "nfeRecepcaoEvento");
  const ret = resp.slice(resp.indexOf("<retEvento"));
  const cStat = Number(campo(ret, "cStat")), motivo = campo(ret, "xMotivo") ?? campo(resp, "xMotivo") ?? "";
  if (cStat === 135 || cStat === 155) {
    const path = n.xml_path ? n.xml_path.replace("-procNFe.xml", "-cancelamento.xml") : `${n.empresa_id}/${n.ambiente}/${n.chave}-cancelamento.xml`;
    await guardarXml(path, `<?xml version="1.0" encoding="UTF-8"?>${corpo}${resp.slice(resp.indexOf("<retEnvEvento"), resp.indexOf("</retEnvEvento>") + 15)}`);
    await db.from("nfce").update({ status: "cancelada", cancelamento_protocolo: campo(ret, "nProt"), cancelada_em: agoraIso(), ultimo_erro: null, atualizado_em: agoraIso() }).eq("venda_id", vendaId);
    return { status: "cancelada" };
  }
  const m = `Cancelamento não aceito (${cStat}): ${motivo}` + (cStat === 501 ? ". Passou do prazo: fale com o contador sobre a nota de devolução." : "");
  await db.from("nfce").update({ ultimo_erro: m.slice(0, 500), atualizado_em: agoraIso() }).eq("venda_id", vendaId);
  return { status: "autorizada", motivo: m };
}

async function processar(vendaId: string | null) {
  const { data: rows } = await db.rpc("nfce_pegar", { p_venda: vendaId, p_limite: vendaId ? 1 : 20 });
  const out: any[] = [];
  for (const n of rows ?? []) {
    try { out.push({ venda_id: n.venda_id, ...(await emitir(n)) }); } catch (err) {
      const m = String((err as Error)?.message ?? err).slice(0, 300);
      await db.from("nfce").update({ status: "fila", tentativas: (n.tentativas ?? 0) + 1, ultimo_erro: "Erro interno: " + m, processando_ate: new Date(Date.now() + 5 * 60_000).toISOString(), atualizado_em: agoraIso() }).eq("venda_id", n.venda_id);
      out.push({ venda_id: n.venda_id, status: "fila", motivo: m });
    }
  }
  return out;
}

// ---------------- painel ----------------
const CAMPOS = ["ie", "logradouro", "numero", "complemento", "bairro", "cod_municipio", "municipio", "uf", "cep", "fone", "csc_id"] as const;

async function statusPainel(emp: string, papel: string) {
  const { f, e } = await configuracao(emp);
  const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const [{ data: ult }, { count: autorizadasHomolog }] = await Promise.all([
    db.from("nfce").select("venda_id, status, serie, numero, chave, ultimo_erro, ambiente, atualizado_em, cstat").eq("empresa_id", emp).order("atualizado_em", { ascending: false }).limit(10),
    db.from("nfce").select("venda_id", { count: "exact", head: true }).eq("empresa_id", emp).eq("ambiente", "homologacao").eq("status", "autorizada"),
  ]);
  const { data: s } = await db.rpc("fiscal_ler_segredos", { p_empresa: emp });
  const seg = Array.isArray(s) ? s[0] : s;
  const cfg: Record<string, unknown> = {};
  for (const k of CAMPOS) cfg[k] = f?.[k] ?? null;
  return {
    empresa: { razao_social: e.razao_social, cnpj: e.cnpj, uf: e.uf, regime: e.regime_tributario },
    configurado: !!f, ativo: !!f?.ativo, ambiente: f?.ambiente ?? "homologacao", serie: f?.serie ?? 2, proximo_numero: f?.proximo_numero ?? 1,
    ...cfg, uf: f?.uf ?? e.uf,
    certificado: f?.cert_validade ? { titular: f.cert_titular, cnpj: f.cert_cnpj, validade: f.cert_validade } : null,
    tem_csc: !!seg?.csc, faltando: faltando(f), autorizadas_homologacao: autorizadasHomolog ?? 0, ultimas: ult ?? [], pode_editar: papel === "dono", hoje,
  };
}

async function salvarPainel(emp: string, uid: string, b: any) {
  const { f, e } = await configuracao(emp);
  const upd: Record<string, unknown> = { empresa_id: emp, atualizado_em: agoraIso(), atualizado_por: uid };
  for (const k of CAMPOS) if (b[k] !== undefined) upd[k] = String(b[k] ?? "").trim().slice(0, 120) || null;
  for (const k of ["ie", "cod_municipio", "cep", "fone", "csc_id"]) if (upd[k]) upd[k] = so(upd[k]) || null;
  if (upd.uf) upd.uf = String(upd.uf).toUpperCase().slice(0, 2);
  if (!f && !upd.uf) upd.uf = e.uf;
  if (upd.cod_municipio && !/^\d{7}$/.test(String(upd.cod_municipio))) return "O código do município (IBGE) tem 7 dígitos";
  if (upd.cep && !/^\d{8}$/.test(String(upd.cep))) return "O CEP tem 8 dígitos";
  if (upd.ie && !/^\d{8,14}$/.test(String(upd.ie))) return "Inscrição estadual inválida (só números)";
  if (b.serie !== undefined || b.proximo_numero !== undefined) {
    // série e número só mudam antes da primeira nota em produção, para não pular nem repetir número
    const { count } = await db.from("nfce").select("venda_id", { count: "exact", head: true }).eq("empresa_id", emp).eq("ambiente", "producao").not("numero", "is", null);
    if (count) return "Já há notas em produção: a série e o número não podem mais ser trocados aqui";
    const s = Number(b.serie ?? f?.serie ?? 2), nn = Number(b.proximo_numero ?? f?.proximo_numero ?? 1);
    if (!Number.isInteger(s) || s < 1 || s > 999) return "Série inválida";
    if (!Number.isInteger(nn) || nn < 1) return "Número inválido";
    upd.serie = s; upd.proximo_numero = nn;
  }
  if (b.pfx) {
    const senha = String(b.senha ?? "");
    if (!senha) return "Informe a senha do certificado";
    const pfx = String(b.pfx).replace(/^data:[^,]*,/, "");
    if (pfx.length > 40000) return "Arquivo de certificado grande demais";
    let c: Cert;
    try { c = lerPfx(pfx, senha); } catch (err) { return String((err as Error).message); }
    if (c.cnpj && so(e.cnpj) && c.cnpj !== so(e.cnpj)) return `Este certificado é do CNPJ ${c.cnpj}, não da empresa (${e.cnpj})`;
    if (c.validade < new Date()) return "Este certificado está vencido";
    await db.rpc("fiscal_guardar_segredo", { p_empresa: emp, p_tipo: "pfx", p_valor: pfx });
    await db.rpc("fiscal_guardar_segredo", { p_empresa: emp, p_tipo: "senha", p_valor: senha });
    upd.cert_titular = c.titular; upd.cert_cnpj = c.cnpj; upd.cert_validade = c.validade.toISOString();
    cache.delete(emp);
  }
  if (b.csc) {
    const csc = String(b.csc).trim();
    if (csc.length < 16 || csc.length > 36) return "O CSC tem de 16 a 36 caracteres";
    await db.rpc("fiscal_guardar_segredo", { p_empresa: emp, p_tipo: "csc", p_valor: csc });
    cache.delete(emp);
  }
  if (b.ativo !== undefined) upd.ativo = !!b.ativo;
  if (b.ambiente !== undefined) {
    if (!["homologacao", "producao"].includes(b.ambiente)) return "Ambiente inválido";
    if (b.ambiente === "producao" && f?.ambiente !== "producao") {
      const { count } = await db.from("nfce").select("venda_id", { count: "exact", head: true }).eq("empresa_id", emp).eq("ambiente", "homologacao").eq("status", "autorizada");
      if (!count) return "Antes de ligar em produção, emita pelo menos uma nota de teste autorizada em homologação";
      if (b.confirmo !== true) return "Confirme que quer emitir notas com valor fiscal";
    }
    upd.ambiente = b.ambiente;
  }
  const { error } = await db.from("fiscal_nfce").upsert(upd, { onConflict: "empresa_id" });
  if (error) return "Não foi possível salvar: " + error.message;
  if (upd.ativo === true || b.pfx || b.csc) {
    const { f: f2 } = await configuracao(emp);
    const falta = faltando(f2);
    if (f2?.ativo && falta.length) return { aviso: "Salvo, mas ainda falta: " + falta.join(", ") };
  }
  return null;
}

async function membro(req: Request) {
  const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!tok) return null;
  const { data: u } = await db.auth.getUser(tok);
  if (!u?.user) return null;
  const { data: m } = await db.from("membros").select("empresa_id, papel").eq("user_id", u.user.id).eq("ativo", true).in("papel", ["dono", "gerente"]).limit(1);
  return m?.[0] ? { uid: u.user.id, emp: m[0].empresa_id as string, papel: m[0].papel as string } : null;
}

async function aparelho(req: Request) {
  const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (tok.length < 40) return null;
  const { data } = await db.from("dispositivos").select("id, empresa_id, ativo").eq("token_hash", await sha256(tok)).maybeSingle();
  return data?.ativo ? data : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return erro("use POST", 405);
  let b: Record<string, any>;
  try { b = await req.json(); } catch { return erro("JSON inválido"); }

  // chamadas internas do banco
  const interno = req.headers.get("x-beep-interno");
  if (interno) {
    const { data: chave } = await db.rpc("fiscal_chave_interna");
    if (!chave || !igual(interno, String(chave))) return erro("Não autorizado", 401);
    if (b.acao === "emitir" && uuidOk(b.venda_id)) return json({ ok: true, resultado: await processar(b.venda_id) });
    if (b.acao === "fila") return json({ ok: true, resultado: await processar(null) });
    if (b.acao === "cancelar" && uuidOk(b.venda_id)) {
      try { return json({ ok: true, ...(await cancelar(b.venda_id)) }); } catch (err) {
        await db.from("nfce").update({ ultimo_erro: "Cancelamento: " + String((err as Error).message).slice(0, 300), atualizado_em: agoraIso() }).eq("venda_id", b.venda_id);
        return erro(String((err as Error).message), 502);
      }
    }
    if (b.acao === "testar" && uuidOk(b.empresa_id)) {
      const { f } = await configuracao(b.empresa_id);
      try {
        const r = await enviar(b.empresa_id, ws(f).status, "NFeStatusServico4", consStatServ(tpAmb(f), UF_CODIGO[f.uf]), "nfeStatusServicoNF");
        return json({ ok: true, cStat: campo(r, "cStat"), motivo: campo(r, "xMotivo") });
      } catch (err) { return erro(String((err as Error).message), 502); }
    }
    return erro("Ação desconhecida");
  }

  // caixa: QR Code da nota da venda
  if (b.acao === "nota_caixa") {
    const d = await aparelho(req);
    if (!d) return erro("Aparelho não autorizado", 401);
    if (!uuidOk(b.venda_id)) return erro("Venda inválida");
    const { data: n } = await db.from("nfce").select("status, serie, numero, chave, qrcode_url, ambiente").eq("venda_id", b.venda_id).eq("empresa_id", d.empresa_id).maybeSingle();
    if (!n) return json({ status: "sem_nota" });
    return json({ status: n.status, numero: n.numero, serie: n.serie, chave: n.status === "autorizada" ? n.chave : null, qrcode: n.status === "autorizada" ? n.qrcode_url : null, homologacao: n.ambiente !== "producao" });
  }

  const m = await membro(req);
  if (!m) return erro("Entre no painel de gestão de novo", 401);

  if (b.acao === "status") return json(await statusPainel(m.emp, m.papel));

  if (b.acao === "notas") {
    const ids = (Array.isArray(b.venda_ids) ? b.venda_ids : []).filter(uuidOk).slice(0, 200);
    if (!ids.length) return json({ notas: [] });
    const { data } = await db.from("nfce").select("venda_id, status, serie, numero, chave, ultimo_erro, ambiente, qrcode_url, cstat").eq("empresa_id", m.emp).in("venda_id", ids);
    return json({ notas: data ?? [] });
  }

  if (b.acao === "xml") {
    if (!uuidOk(b.venda_id)) return erro("Venda inválida");
    const { data: n } = await db.from("nfce").select("xml_path").eq("empresa_id", m.emp).eq("venda_id", b.venda_id).maybeSingle();
    if (!n?.xml_path) return erro("Nota sem XML autorizado", 404);
    const { data: u } = await db.storage.from("nfce").createSignedUrl(n.xml_path, 300, { download: true });
    return json({ url: u?.signedUrl });
  }

  if (b.acao === "buscar_cnpj") {
    const { e } = await configuracao(m.emp);
    try {
      const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${so(e.cnpj)}`, { signal: AbortSignal.timeout(10_000) });
      const j = await r.json();
      if (!r.ok) return erro("Não achei o CNPJ na Receita agora. Preencha à mão.", 502);
      return json({
        logradouro: [j.descricao_tipo_de_logradouro, j.logradouro].filter(Boolean).join(" "), numero: j.numero, complemento: j.complemento,
        bairro: j.bairro, cod_municipio: j.codigo_municipio_ibge ? String(j.codigo_municipio_ibge) : null, municipio: j.municipio, uf: j.uf, cep: j.cep, fone: j.ddd_telefone_1,
      });
    } catch { return erro("Não achei o CNPJ na Receita agora. Preencha à mão.", 502); }
  }

  if (b.acao === "testar") {
    const { f } = await configuracao(m.emp);
    if (!f) return erro("Salve a configuração primeiro");
    try {
      const r = await enviar(m.emp, ws(f).status, "NFeStatusServico4", consStatServ(tpAmb(f), UF_CODIGO[f.uf]), "nfeStatusServicoNF");
      return json({ ok: true, cStat: campo(r, "cStat"), motivo: campo(r, "xMotivo") });
    } catch (err) { return erro(String((err as Error).message), 502); }
  }

  if (b.acao === "reenviar") {
    if (!uuidOk(b.venda_id)) return erro("Venda inválida");
    const { data: n } = await db.from("nfce").select("status").eq("empresa_id", m.emp).eq("venda_id", b.venda_id).maybeSingle();
    if (!n) {
      // venda anterior à NFC-e (ou feita com ela desligada): entra na fila agora
      const { data: v } = await db.from("vendas").select("id, status, teste").eq("id", b.venda_id).eq("empresa_id", m.emp).maybeSingle();
      const { f } = await configuracao(m.emp);
      if (!v || v.status !== "paga") return erro("Só venda paga tem nota");
      if (!f?.ativo) return erro("Ligue a NFC-e primeiro");
      if (v.teste && f.ambiente === "producao") return erro("Venda de teste não gera nota em produção");
      await db.from("nfce").insert({ venda_id: v.id, empresa_id: m.emp, status: "fila", ambiente: f.ambiente, tentativas: 0 });
    } else if (n.status === "rejeitada") {
      await db.from("nfce").update({ status: "fila", processando_ate: null, atualizado_em: agoraIso() }).eq("venda_id", b.venda_id);
    } else if (n.status === "fila") {
      await db.from("nfce").update({ processando_ate: null }).eq("venda_id", b.venda_id);
    } else return erro("Esta nota já está " + n.status);
    const r = await processar(b.venda_id);
    return json({ ok: true, resultado: r[0] ?? null });
  }

  if (m.papel !== "dono") return erro("Só o dono pode mudar a NFC-e", 403);

  if (b.acao === "salvar") {
    const r = await salvarPainel(m.emp, m.uid, b);
    if (typeof r === "string") return erro(r);
    return json({ ok: true, ...(r ?? {}), ...(await statusPainel(m.emp, m.papel)) });
  }

  if (b.acao === "cancelar") {
    if (!uuidOk(b.venda_id)) return erro("Venda inválida");
    const j = String(b.justificativa ?? "").trim();
    if (j.length < 15) return erro("Escreva o motivo do cancelamento (pelo menos 15 letras)");
    try { return json({ ok: true, ...(await cancelar(b.venda_id, j)) }); } catch (err) { return erro(String((err as Error).message), 502); }
  }

  return erro("Ação desconhecida");
});
