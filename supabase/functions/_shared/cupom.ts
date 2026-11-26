// Cupom fiscal (NFC-e, modelo 65) de compra feita no varejo (atacarejo, supermercado).
// A NFC-e não chega pela distribuição da SEFAZ, então a entrada parte do cupom em mãos:
// o QR code do cupom (ou a chave) é consultado no site público da SEFAZ-CE, que devolve o DANFE em HTML.
// Formatos do parâmetro "p" do QR code (os mesmos que o site da SEFAZ-CE aceita):
//   v2 online:       chave|2|ambiente|id do CSC|hash
//   v2 contingência: chave|2|ambiente|dia|valor|digVal|id do CSC|hash   (tpEmis 9 na posição 34 da chave)
//   v3:              chave|3|ambiente
// Sem o QR, só com a chave, tentamos a v3 (só funciona para cupons emitidos com QR code versão 3).

export const CE_BASE = "http://nfce.sefaz.ce.gov.br";

export function dvOk(chave: string) {
  if (!/^\d{44}$/.test(chave)) return false;
  let soma = 0, peso = 2;
  for (let i = 42; i >= 0; i--) { soma += Number(chave[i]) * peso; peso = peso === 9 ? 2 : peso + 1; }
  const r = soma % 11, dv = r < 2 ? 0 : 11 - r;
  return dv === Number(chave[43]);
}

export type ConsultaCupom = { chave: string; versao: string; payload: Record<string, string>; url: string; pagina: string; soChave: boolean };

export class CupomInvalido extends Error {}

// Aceita o link lido do QR, só o "p", ou os 44 números da chave (com ou sem espaços).
export function lerCupom(entrada: string): ConsultaCupom {
  let t = String(entrada ?? "").trim();
  if (!t) throw new CupomInvalido("Leia o QR code do cupom ou digite a chave de acesso");
  if (t.length > 600) throw new CupomInvalido("Texto do QR code grande demais");
  // só a chave (44 números, às vezes com espaços como no cupom impresso)
  const dig = t.replace(/[\s.\-]/g, "");
  if (/^\d{44}$/.test(dig)) return montar(dig, ["3", "1"], true);
  let p = "";
  if (/^https?:\/\//i.test(t) || /^[a-z0-9.-]+\.gov\.br\//i.test(t)) {
    let u: URL;
    try { u = new URL(/^https?:/i.test(t) ? t : "http://" + t); } catch { throw new CupomInvalido("Link do QR code inválido"); }
    const host = u.hostname.toLowerCase();
    if (!host.endsWith(".gov.br")) throw new CupomInvalido("Este QR code não é de um cupom fiscal (o link não é da SEFAZ)");
    if (host !== "nfce.sefaz.ce.gov.br") throw new CupomInvalido("Por enquanto o sistema lê cupons do Ceará. Este cupom é de outro estado.");
    p = u.searchParams.get("p") ?? "";
    if (!p) {
      if (u.searchParams.get("chNFe")) throw new CupomInvalido("Este cupom usa o QR code antigo (versão 1), que a SEFAZ não consulta mais por aqui");
      throw new CupomInvalido("O link do QR code não tem os dados do cupom");
    }
  } else if (t.includes("|")) p = t;
  else throw new CupomInvalido("Não reconheci o código. Leia o QR code do cupom ou digite os 44 números da chave.");
  p = decodeURIComponent(p.replace(/\+/g, " ")).trim();
  const partes = p.split("|").map((x) => x.trim());
  const chave = partes[0] ?? "";
  if (!/^\d{44}$/.test(chave)) throw new CupomInvalido("A chave do cupom deve ter 44 números");
  return montar(chave, partes.slice(1), false);
}

function montar(chave: string, resto: string[], soChave: boolean): ConsultaCupom {
  if (!dvOk(chave)) throw new CupomInvalido("Chave de acesso com número errado: confira os 44 números");
  if (chave.slice(20, 22) === "55") throw new CupomInvalido("Esta chave é de uma NF-e (nota de 55). Use \"Buscar pela chave de acesso\" na entrada de NF-e.");
  if (chave.slice(20, 22) !== "65") throw new CupomInvalido("Esta chave não é de um cupom fiscal (NFC-e)");
  if (chave.slice(0, 2) !== "23") throw new CupomInvalido("Por enquanto o sistema lê cupons do Ceará. Este cupom é de outro estado.");
  const [versao, amb] = resto;
  if (amb !== "1") throw new CupomInvalido("Este cupom é de teste (homologação), sem valor fiscal");
  const base = { chave_acesso: chave, versao_qrcode: versao, tipo_ambiente: amb };
  let payload: Record<string, string>;
  if (versao === "3") {
    if (resto.length !== 2) throw new CupomInvalido("QR code em formato desconhecido");
    payload = base;
  } else if (versao === "2") {
    const cont = chave[34] === "9", esperado = cont ? 7 : 4;
    if (resto.length !== esperado) throw new CupomInvalido("QR code em formato desconhecido");
    const csc = resto[esperado - 2], hash = resto[esperado - 1];
    if (!/^[0-9A-Fa-f]{40}$/.test(hash)) throw new CupomInvalido("QR code incompleto: tente ler de novo");
    payload = cont
      ? { ...base, dia_data_emissao: resto[2], valor_total_nfce: resto[3], digVal: resto[4], identificador_csc: csc, codigo_hash: hash }
      : { ...base, identificador_csc: csc, codigo_hash: hash };
  } else throw new CupomInvalido("Versão de QR code não suportada");
  const p = [chave, ...resto].join("|");
  return { chave, versao, payload, soChave, url: `${CE_BASE}/nfce/api/notasFiscal/qrcodev${versao}/`, pagina: `${CE_BASE}/pages/ShowNFCe.html?p=${p}` };
}

// "236 - Regra de neg&oacute;cios da NFC-e" -> texto para o dono
export function erroSefaz(erro: unknown, soChave: boolean) {
  const t = String(erro ?? "").replace(/&oacute;/g, "ó").replace(/&[a-z]+;/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const cod = t.split(" - ")[0];
  if (cod === "236" || !t) return soChave
    ? "A SEFAZ não mostra este cupom só pela chave. Leia o QR code do cupom (fica embaixo, perto do total)."
    : "A SEFAZ não encontrou este cupom. Leia o QR code de novo; se o cupom é de hoje, tente daqui a alguns minutos.";
  return "A SEFAZ recusou a consulta: " + t;
}
