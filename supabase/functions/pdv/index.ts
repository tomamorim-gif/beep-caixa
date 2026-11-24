// PDV no telefone/tablet: ativação por código de uso único e token do aparelho.
// O aparelho nunca tem chave do banco: só um token aleatório, guardado como hash.
// Preços e total são sempre calculados aqui, nunca confiados ao aparelho.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const erro = (m: string, s = 400) => json({ erro: m }, s);

async function sha256(t: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const normCodigo = (c: unknown) => String(c ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const uuidOk = (s: unknown) => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);

async function ativacao(codigo: string) {
  const { data } = await db.from("dispositivo_ativacoes").select("*").eq("codigo_hash", await sha256(codigo)).maybeSingle();
  if (!data || data.usado_em || new Date(data.expira_em) < new Date() || data.tentativas >= 10) return null;
  return data;
}

async function aparelho(req: Request) {
  const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (tok.length < 40) return null;
  const { data } = await db.from("dispositivos").select("id, empresa_id, local_id, nome, ativo").eq("token_hash", await sha256(tok)).maybeSingle();
  return data && data.ativo ? data : null;
}

// anúncios com canal "caixa" para a loja do aparelho, em ordem fixa (pagos primeiro, ofertas da loja depois)
async function midiaCaixa(d: any) {
  const br = new Date(Date.now() - 3 * 3600 * 1000), hoje = br.toISOString().slice(0, 10);
  const { data: camps } = await db.from("campanhas_midia").select("id, anunciante_id, anuncios, locais, hora_inicio, hora_fim, ordem, criado_em").eq("empresa_id", d.empresa_id).eq("status", "ativa").lte("inicio", hoje).gte("fim", hoje).contains("canais", ["caixa"]);
  const validas = (camps ?? []).filter((c: any) => !c.locais?.length || c.locais.includes(d.local_id));
  const ids = [...new Set(validas.flatMap((c: any) => c.anuncios ?? []))];
  if (!ids.length) return [];
  const [{ data: ads }, { data: an }] = await Promise.all([
    db.from("anuncios").select("id, anunciante_id, titulo, texto, formato, arquivo_path, link_url, cupom, duracao_s").eq("empresa_id", d.empresa_id).eq("aprovado", true).in("id", ids),
    db.from("anunciantes").select("id, nome, ativo, proprio").eq("empresa_id", d.empresa_id),
  ]);
  const anm = new Map((an ?? []).filter((a: any) => a.ativo).map((a: any) => [a.id, a]));
  const paths = (ads ?? []).map((a: any) => a.arquivo_path);
  const { data: urls } = paths.length ? await db.storage.from("midia").createSignedUrls(paths, 60 * 60 * 24) : { data: [] };
  const url = new Map((urls ?? []).filter((u: any) => u.signedUrl).map((u: any) => [u.path, u.signedUrl]));
  validas.sort((x: any, y: any) => (anm.get(x.anunciante_id)?.proprio ? 1 : 0) - (anm.get(y.anunciante_id)?.proprio ? 1 : 0) || x.ordem - y.ordem || String(x.criado_em).localeCompare(String(y.criado_em)));
  const out: any[] = [];
  for (const c of validas) for (const id of c.anuncios ?? []) {
    const a: any = (ads ?? []).find((x: any) => x.id === id), n: any = a && anm.get(a.anunciante_id);
    if (!a || !n || !url.get(a.arquivo_path)) continue;
    out.push({ id: a.id, campanha_id: c.id, titulo: a.titulo, texto: a.texto, cupom: a.cupom, link: a.link_url, video: a.formato !== "imagem", midia: url.get(a.arquivo_path), segundos: a.duracao_s || 10, anunciante: n.nome, proprio: !!n.proprio, hora_inicio: c.hora_inicio, hora_fim: c.hora_fim });
  }
  return out.slice(0, 20);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return erro("use POST", 405);
  let b: Record<string, any>;
  try { b = await req.json(); } catch { return erro("JSON inválido"); }
  const acao = b.acao;

  // 1) código de ativação -> lista de lojas da empresa
  if (acao === "lojas") {
    const a = await ativacao(normCodigo(b.codigo));
    if (!a) return erro("Código inválido ou vencido", 403);
    const { data: lojas } = await db.from("locais").select("id, nome").eq("empresa_id", a.empresa_id).eq("tipo", "loja").eq("ativo", true).order("nome");
    const { data: emp } = await db.from("empresas").select("nome_exibicao, cores").eq("id", a.empresa_id).single();
    return json({ empresa: emp, lojas });
  }

  // 2) ativar o aparelho numa loja -> token (mostrado uma vez)
  if (acao === "ativar") {
    const codigo = normCodigo(b.codigo);
    const a = await ativacao(codigo);
    if (!a) return erro("Código inválido ou vencido", 403);
    if (!uuidOk(b.local_id)) return erro("Escolha a loja");
    const { data: loja } = await db.from("locais").select("id, nome, empresa_id").eq("id", b.local_id).eq("empresa_id", a.empresa_id).eq("tipo", "loja").maybeSingle();
    if (!loja) { await db.from("dispositivo_ativacoes").update({ tentativas: a.tentativas + 1 }).eq("id", a.id); return erro("Loja inválida", 403); }
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + "." + crypto.randomUUID();
    const nome = String(b.nome ?? "Telefone").slice(0, 40);
    const { data: disp, error } = await db.from("dispositivos").insert({ empresa_id: a.empresa_id, local_id: loja.id, nome, tipo: "telefone", token_hash: await sha256(token), ativado_em: new Date().toISOString(), ultimo_sinal: new Date().toISOString() }).select("id").single();
    if (error) return erro("Não foi possível ativar", 500);
    // uso único: só marca se ainda não foi usado (evita dois aparelhos com o mesmo código)
    const { data: marcou } = await db.from("dispositivo_ativacoes").update({ usado_em: new Date().toISOString(), dispositivo_id: disp.id }).eq("id", a.id).is("usado_em", null).select("id");
    if (!marcou?.length) { await db.from("dispositivos").delete().eq("id", disp.id); return erro("Código já usado", 409); }
    return json({ token, loja: { id: loja.id, nome: loja.nome } });
  }

  const d = await aparelho(req);
  if (!d) return erro("Aparelho não autorizado. Ative de novo.", 401);

  if (acao === "catalogo") {
    const [{ data: precos }, { data: emp }, { data: loja }] = await Promise.all([
      db.from("precos_local").select("preco, ativo_no_mix, produtos!inner(id, nome, ean, unidade, ativo, idade_minima, produto_codigos(ean, quantidade))").eq("local_id", d.local_id).eq("ativo_no_mix", true),
      db.from("empresas").select("nome_exibicao, cores, gravacao, dias_video").eq("id", d.empresa_id).single(),
      db.from("locais").select("nome").eq("id", d.local_id).single(),
    ]);
    await db.from("dispositivos").update({ ultimo_sinal: new Date().toISOString() }).eq("id", d.id);
    const ativos = (precos ?? []).filter((p: any) => p.produtos.ativo);
    // foto principal de cada produto: link assinado (bucket privado) válido por 7 dias
    const fotos = new Map<string, string>();
    const ids = ativos.map((p: any) => p.produtos.id);
    if (ids.length) {
      // consulta em lotes de 150 produtos: a lista com centenas de ids numa URL só ficava longa demais e a consulta falhava calada (sem nenhuma foto)
      const fs: any[] = [];
      for (let i = 0; i < ids.length; i += 150) {
        const { data, error } = await db.from("produto_fotos").select("produto_id, path, principal, ordem").eq("empresa_id", d.empresa_id).in("produto_id", ids.slice(i, i + 150)).order("principal", { ascending: false }).order("ordem");
        if (error) console.error("catalogo: fotos", error.message);
        fs.push(...(data ?? []));
      }
      const primeira = new Map<string, string>();
      for (const f of fs) if (!primeira.has(f.produto_id)) primeira.set(f.produto_id, f.path);
      const paths = [...primeira.values()];
      const porPath = new Map<string, string>();
      // links assinados em lotes de 100
      for (let i = 0; i < paths.length; i += 100) {
        const { data: urls, error: eUrls } = await db.storage.from("produtos").createSignedUrls(paths.slice(i, i + 100), 60 * 60 * 24 * 7);
        if (eUrls) console.error("catalogo: links das fotos", eUrls.message);
        for (const u of urls ?? []) if (u.signedUrl && u.path) porPath.set(u.path, u.signedUrl);
      }
      for (const [pid, path] of primeira) if (porPath.has(path)) fotos.set(pid, porPath.get(path)!);
    }
    const produtos = ativos.map((p: any) => ({
      id: p.produtos.id, nome: p.produtos.nome, preco: p.preco, unidade: p.produtos.unidade, maior18: p.produtos.idade_minima === 18, foto: fotos.get(p.produtos.id) ?? null,
      codigos: [...new Set([p.produtos.ean, ...(p.produtos.produto_codigos ?? []).map((c: any) => c.ean)].filter(Boolean))],
    }));
    const gravacao = { modo: emp?.gravacao ?? "intercorrencias", dias: emp?.dias_video ?? 3 };
    return json({ empresa: { nome_exibicao: emp?.nome_exibicao, cores: emp?.cores }, loja: loja?.nome, aparelho: d.nome, gravacao, produtos, midia: await midiaCaixa(d), atualizado: new Date().toISOString() });
  }

  // preços sempre daqui: o aparelho nunca define o valor
  async function calcular(itensIn: any[]) {
    const itens = Array.isArray(itensIn) ? itensIn.slice(0, 100) : [];
    if (!itens.length) return { erro: "Carrinho vazio" };
    const ids = itens.map((i: any) => i.produto_id).filter(uuidOk);
    const { data: precos } = await db.from("precos_local").select("produto_id, preco, produtos!inner(custo, empresa_id)").eq("local_id", d.local_id).in("produto_id", ids);
    const mapa = new Map((precos ?? []).map((p: any) => [p.produto_id, p]));
    let total = 0;
    const linhas: any[] = [];
    for (const [k, i] of itens.entries()) {
      const p: any = mapa.get(i.produto_id);
      const q = Number(i.quantidade);
      if (!p || p.produtos.empresa_id !== d.empresa_id) return { erro: "Produto sem preço nesta loja" };
      if (!Number.isInteger(q) || q <= 0 || q > 99) return { erro: "Quantidade inválida" };
      total += p.preco * q;
      linhas.push({ seq: k + 1, produto_id: i.produto_id, quantidade: q, preco_unit: p.preco, custo_unit: p.produtos.custo });
    }
    return { total, linhas };
  }

  // total oficial antes de cobrar no cartão
  if (acao === "total") {
    const c: any = await calcular(b.itens);
    if (c.erro) return erro(c.erro);
    return json({ total: c.total });
  }

  if (acao === "venda") {
    if (!uuidOk(b.id)) return erro("id da venda inválido");
    const forma = ["pix", "credito", "debito"].includes(b.forma) ? b.forma : null;
    if (!forma) return erro("Forma de pagamento inválida");
    const simulado = b.simulado !== false;
    // venda real: só cartão aprovado na maquininha (com NSU/código da transação). Pix real ainda não está ligado.
    const cartao = !simulado ? (b.cartao ?? {}) : null;
    if (!simulado) {
      if (forma === "pix") return erro("Pix real ainda não está ligado neste aparelho", 403);
      const temId = [cartao.nsu, cartao.transacao, cartao.autorizacao].some((x: any) => typeof x === "string" && x.trim().length > 0);
      if (!temId) return erro("Pagamento sem comprovante da maquininha");
    }
    const { data: ja } = await db.from("vendas").select("id, total, status").eq("id", b.id).maybeSingle();
    if (ja) return json({ ok: true, venda: ja.id, total: ja.total, repetida: true });
    const c: any = await calcular(b.itens);
    if (c.erro) return erro(c.erro);
    const total = c.total;
    const pago = !simulado ? Number(cartao.valor) : total;
    // o cartão já foi cobrado: grava mesmo se o valor divergir, mas marca para conferência
    const divergente = !simulado && pago !== total;
    const linhas = c.linhas.map((l: any) => ({ ...l, venda_id: b.id, empresa_id: d.empresa_id }));
    const agora = new Date().toISOString();
    const limpo = (x: any, n = 40) => (typeof x === "string" ? x.trim().slice(0, n) : null) || null;
    const { error: e1 } = await db.from("vendas").insert({ id: b.id, empresa_id: d.empresa_id, local_id: d.local_id, dispositivo_id: d.id, iniciada_em: b.iniciada_em ?? agora, finalizada_em: agora, status: "paga", total, origem: "telefone", teste: simulado, observacao: divergente ? `Valor cobrado na maquininha (${pago}) diferente do total (${total}) — conferir` : null });
    if (e1) return erro("Não foi possível gravar a venda", 500);
    await db.from("venda_itens").insert(linhas);
    await db.from("pagamentos").insert({
      venda_id: b.id, empresa_id: d.empresa_id, forma, valor: simulado ? total : (Number.isInteger(pago) ? pago : total), status: "aprovado",
      nsu: simulado ? "SIMULADO" : (limpo(cartao.nsu) ?? limpo(cartao.transacao)),
      autorizacao: simulado ? null : (limpo(cartao.autorizacao) ?? limpo(cartao.transacao)),
      bandeira: simulado ? null : limpo(cartao.bandeira, 30),
    });
    await db.from("estoque_mov").insert(linhas.map((l: any) => ({ empresa_id: d.empresa_id, local_id: d.local_id, produto_id: l.produto_id, tipo: "venda", quantidade: -l.quantidade, custo_unit: l.custo_unit, referencia: b.id, usuario_id: null })));
    return json({ ok: true, venda: b.id, total, divergente });
  }

  // vídeo da câmera frontal: o aparelho pede um link de envio de uso único e manda o arquivo direto ao Storage
  if (acao === "video_inicio") {
    const motivos = ["paga", "cancelada", "abandonada", "recusada"];
    if (!motivos.includes(b.motivo)) return erro("Motivo inválido");
    // respeita a escolha do cliente: gravar tudo, só intercorrências ou nada
    const { data: cfg } = await db.from("empresas").select("gravacao, dias_video").eq("id", d.empresa_id).single();
    const modo = cfg?.gravacao ?? "intercorrencias", dias = cfg?.dias_video ?? 3;
    if (modo === "desligado" || (modo === "intercorrencias" && b.motivo === "paga")) return json({ ignorado: true, modo });
    const tipo = String(b.tipo ?? "").startsWith("video/mp4") ? "mp4" : "webm";
    const inicio = new Date(b.inicio ?? Date.now()), fim = new Date(b.fim ?? Date.now());
    if (isNaN(+inicio) || isNaN(+fim) || +fim - +inicio > 30 * 60 * 1000) return erro("Horário inválido");
    // limpeza: vídeos vencidos (prazo do cliente) saem do Storage e da tabela
    const { data: velhos } = await db.from("videos_seguranca").select("id, path").eq("empresa_id", d.empresa_id).lt("expira_em", new Date().toISOString()).limit(100);
    if (velhos?.length) { await db.storage.from("seguranca").remove(velhos.map((v: any) => v.path)); await db.from("videos_seguranca").delete().in("id", velhos.map((v: any) => v.id)); }
    const dia = inicio.toISOString().slice(0, 10);
    const path = `${d.empresa_id}/${d.local_id}/${dia}/${inicio.toISOString().replace(/[:.]/g, "-")}_${b.motivo}_${crypto.randomUUID().slice(0, 8)}.${tipo}`;
    const { data: up, error } = await db.storage.from("seguranca").createSignedUploadUrl(path);
    if (error || !up) return erro("Não foi possível preparar o envio", 500);
    const { data: v, error: e2 } = await db.from("videos_seguranca").insert({ empresa_id: d.empresa_id, local_id: d.local_id, dispositivo_id: d.id, venda_id: uuidOk(b.venda_id) ? b.venda_id : null, path, motivo: b.motivo, inicio: inicio.toISOString(), fim: fim.toISOString(), expira_em: new Date(Date.now() + dias * 86400000).toISOString() }).select("id").single();
    if (e2) return erro("Não foi possível registrar o vídeo", 500);
    return json({ id: v.id, url: up.signedUrl });
  }

  if (acao === "video_fim") {
    if (!uuidOk(b.id)) return erro("id inválido");
    await db.from("videos_seguranca").update({ enviado: true, bytes: Number(b.bytes) || null }).eq("id", b.id).eq("dispositivo_id", d.id);
    return json({ ok: true });
  }

  // exibições dos anúncios na tela de descanso do caixa
  if (acao === "midia_evento") {
    const evs = (Array.isArray(b.eventos) ? b.eventos.slice(0, 200) : []).filter((e: any) => uuidOk(e.anuncio_id) && uuidOk(e.campanha_id) && ["exibicao", "clique"].includes(e.tipo));
    if (!evs.length) return json({ ok: true });
    const { data: camps } = await db.from("campanhas_midia").select("id").eq("empresa_id", d.empresa_id).in("id", [...new Set(evs.map((e: any) => e.campanha_id))]);
    const ok = new Set((camps ?? []).map((c: any) => c.id));
    const linhas = evs.filter((e: any) => ok.has(e.campanha_id)).map((e: any) => ({ empresa_id: d.empresa_id, campanha_id: e.campanha_id, anuncio_id: e.anuncio_id, dispositivo_id: d.id, local_id: d.local_id, segundos: Math.min(60, Math.max(1, Number(e.segundos) || 8)), canal: "caixa", tipo: e.tipo, exibido_em: typeof e.em === "string" && !isNaN(Date.parse(e.em)) ? e.em : new Date().toISOString() }));
    if (linhas.length) await db.from("midia_exibicoes").insert(linhas);
    return json({ ok: true });
  }

  if (acao === "evento") {
    const tipos = ["venda_cancelada", "pagamento_negado", "carrinho_abandonado", "item_removido"];
    if (!tipos.includes(b.tipo)) return erro("Tipo inválido");
    await db.from("eventos_seguranca").insert({ empresa_id: d.empresa_id, local_id: d.local_id, dispositivo_id: d.id, tipo: b.tipo, venda_id: uuidOk(b.venda_id) ? b.venda_id : null, ocorrido_em: new Date().toISOString(), itens: Array.isArray(b.itens) ? b.itens.slice(0, 50) : [] });
    return json({ ok: true });
  }

  return erro("Ação desconhecida");
});
