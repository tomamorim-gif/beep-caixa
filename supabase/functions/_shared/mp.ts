// Regras puras da integração com o Mercado Pago (API Orders / Point).
// Sem acesso a banco nem rede: dá para testar fora do Supabase (ver supabase/tests).

// Status do pedido (order) no Mercado Pago -> nosso status de cobrança
export const STATUS_MP: Record<string, string> = {
  created: "aguardando",
  at_terminal: "na_maquininha",
  processed: "aprovado",
  failed: "recusado",
  canceled: "cancelado",
  expired: "expirado",
  refunded: "estornado",
  action_required: "verificar",
};

// estados em que a cobrança não muda mais sozinha
export const FINAIS = new Set(["aprovado", "recusado", "cancelado", "expirado", "estornado", "falhou"]);
// estados em que a cobrança ainda pode virar aprovada na maquininha
export const ABERTOS = ["criando", "aguardando", "na_maquininha", "verificar"];

export type Ordem = {
  status: string;
  mp_status: string;
  status_detail: string | null;
  mp_payment_id: string | null;
  bandeira: string | null;
  autorizacao: string | null;
  nsu: string | null;
  valor_centavos: number | null;
  external_reference: string | null;
};

// traduz o pedido do Mercado Pago para o nosso status
export function lerOrdem(o: any): Ordem {
  const p = o?.transactions?.payments?.[0] ?? {};
  const st = String(o?.status ?? "");
  const det = String(p.status_detail ?? o?.status_detail ?? "");
  const valor = p.paid_amount ?? p.amount ?? o?.total_paid_amount ?? o?.total_amount;
  return {
    status: STATUS_MP[st] ?? "aguardando",
    mp_status: st,
    status_detail: det || null,
    mp_payment_id: p.id ? String(p.id) : null,
    bandeira: p.payment_method?.id ? String(p.payment_method.id) : null,
    autorizacao: p.authorization_code ?? p.reference?.authorization_code ?? null,
    nsu: p.reference_id ?? p.reference?.id ?? (p.id ? String(p.id) : null),
    valor_centavos: valor != null && valor !== "" && Number.isFinite(Number(valor)) ? Math.round(Number(valor) * 100) : null,
    external_reference: o?.external_reference ? String(o.external_reference) : null,
  };
}

export const MOTIVOS: Record<string, string> = {
  insufficient_amount: "Saldo ou limite insuficiente",
  rejected_by_issuer: "Recusado pelo banco do cartão",
  rejected_by_bank: "Recusado pelo banco do cartão",
  invalid_card: "Cartão inválido",
  card_expired: "Cartão vencido",
  invalid_pin: "Senha incorreta",
  canceled_by_api: "Cancelado",
  canceled_on_terminal: "Cancelado na maquininha",
  expired: "Tempo esgotado",
};
export function motivo(det: string | null, st: string) {
  return (det && MOTIVOS[det]) ||
    ({ recusado: "Pagamento recusado", cancelado: "Pagamento cancelado", expirado: "Tempo esgotado na maquininha", verificar: "Confira a maquininha", estornado: "Pagamento estornado", falhou: "A maquininha não recebeu a cobrança" } as Record<string, string>)[st] || "";
}

export const reais = (centavos: number) => (centavos / 100).toFixed(2);

// referência externa do pedido: liga o aviso do Mercado Pago à nossa cobrança mesmo antes de gravarmos o id do pedido
export const referencia = (cobrancaId: string) => "beep" + cobrancaId.replace(/-/g, "");
export function cobrancaDaReferencia(ref: string | null | undefined): string | null {
  const m = /^beep([0-9a-f]{32})$/i.exec(String(ref ?? ""));
  if (!m) return null;
  const h = m[1].toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------- assinatura do aviso (webhook) ----------
// Cabeçalho x-signature: "ts=1704908010,v1=618c8534..."
export function lerAssinatura(cab: string | null) {
  const partes: Record<string, string> = {};
  for (const p of String(cab ?? "").split(",")) {
    const i = p.indexOf("=");
    if (i > 0) partes[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  return { ts: partes.ts ?? "", v1: (partes.v1 ?? "").toLowerCase() };
}

// Modelo oficial: "id:[data.id];request-id:[x-request-id];ts:[ts];"
// O data.id vai em minúsculas quando é alfanumérico, e a parte que não veio fica de fora.
export function manifesto(dataId: string, requestId: string, ts: string) {
  let m = "";
  if (dataId) m += `id:${/^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId};`;
  if (requestId) m += `request-id:${requestId};`;
  if (ts) m += `ts:${ts};`;
  return m;
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function hmacHex(segredo: string, texto: string) {
  const chave = await crypto.subtle.importKey("raw", new TextEncoder().encode(segredo), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", chave, new TextEncoder().encode(texto)));
}

// comparação em tempo constante (não vaza por tempo de resposta quantos caracteres bateram)
export function iguais(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Valida o aviso. toleranciaSeg limita reenvio de um aviso antigo capturado (0 = sem limite).
export async function assinaturaValida(o: { segredo: string; cabecalho: string | null; requestId: string | null; dataId: string; agoraMs?: number; toleranciaSeg?: number }) {
  const { ts, v1 } = lerAssinatura(o.cabecalho);
  if (!o.segredo || !ts || !v1 || !o.dataId) return false;
  if (o.toleranciaSeg && o.toleranciaSeg > 0) {
    const n = Number(ts);
    if (!Number.isFinite(n)) return false;
    const tsMs = n > 1e12 ? n : n * 1000; // aceita segundos ou milissegundos
    if (Math.abs((o.agoraMs ?? Date.now()) - tsMs) > o.toleranciaSeg * 1000) return false;
  }
  const esperado = await hmacHex(o.segredo, manifesto(o.dataId, o.requestId ?? "", ts));
  return iguais(esperado, v1);
}

// data ISO vinda do tablet: aceita só se for uma data válida e não muito no futuro
export function dataOk(s: unknown, agoraMs = Date.now()): string | null {
  if (typeof s !== "string" || s.length > 40) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t) || t > agoraMs + 5 * 60_000 || t < agoraMs - 2 * 86_400_000) return null;
  return new Date(t).toISOString();
}
