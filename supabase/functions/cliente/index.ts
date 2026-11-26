// App do cliente do condomínio (link instalável): cadastro com CPF + senha de 4 dígitos,
// consulta de produtos/estoque da loja, compra no celular e vendas travadas, conforme o dono liberar.
// CPF não é guardado: só hash (login) e máscara (exibição). Senha com PBKDF2 + bloqueio após erros.
// Quem pode comprar vem do banco (app_perm): loja liberada, cliente selecionado ou contingência
// (caixa da loja sem internet). O pagamento é Pix de verdade, feito pela função "cartao" (ações app_*).
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
// logo da empresa (marca própria, bucket privado "marca"): link assinado de 30 dias
async function logoAssinado(path: string | null | undefined) {
  if (!path) return null;
  const { data } = await db.storage.from("marca").createSignedUrl(path, 60 * 60 * 24 * 30);
  return data?.signedUrl ?? null;
}
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const erro = (m: string, s = 400) => json({ erro: m }, s);
const uuidOk = (s: unknown) => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (t: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
async function pinHash(pin: string, salt: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 120000, hash: "SHA-256" }, k, 256));
}
function cpfValido(c: string) {
  if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false;
  for (const n of [9, 10]) {
    let s = 0;
    for (let i = 0; i < n; i++) s += +c[i] * (n + 1 - i);
    if (((s * 10) % 11) % 10 !== +c[n]) return false;
  }
  return true;
}
const cpfHash = (cpf: string) => sha256("beep-cpf:" + cpf);
const mascara = (cpf: string) => `***.***.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
const MAX_TENT = 5, BLOQ_MIN = 15;
const TERMOS_V = "2026-11-21";

async function novaSessao(clienteId: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await db.from("sessoes_cliente").insert({ token_hash: await sha256(token), cliente_id: clienteId });
  await db.from("clientes_app").update({ ultimo_acesso: new Date().toISOString() }).eq("id", clienteId);
  return token;
}
async function lojaInfo(id: string) {
  const { data: l } = await db.from("locais").select("id, nome, empresa_id, tipo, ativo, app_consulta, app_compra, app_pendente").eq("id", id).maybeSingle();
  if (!l || l.tipo !== "loja" || !l.ativo) return null;
  return l;
}
// contingência valendo agora nesta loja (caixa sem sinal): o app abre mesmo que a loja esteja só em consulta
// caixa: o caixa cujo QR o cliente leu (se ele estiver sem sinal, libera a compra mesmo com outro caixa online)
async function contingencia(localId: string, caixa?: unknown) {
  const { data, error } = await db.rpc("contingencia_agora", { p_local: localId, p_caixa: uuidOk(caixa) ? caixa : null });
  return !error && data === true;
}
async function sessao(req: Request, caixa?: unknown) {
  const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (tok.length < 30) return null;
  const { data: s } = await db.from("sessoes_cliente").select("cliente_id, expira_em").eq("token_hash", await sha256(tok)).maybeSingle();
  if (!s || new Date(s.expira_em) < new Date()) return null;
  const { data: c } = await db.from("clientes_app").select("id, empresa_id, local_id, nome, unidade, cpf_mascara, compra_liberada, ativo, termos_versao").eq("id", s.cliente_id).maybeSingle();
  if (!c || !c.ativo) return null;
  const l = await lojaInfo(c.local_id);
  if (!l) return null;
  const { data: p, error } = await db.rpc("app_perm", { p_cliente: c.id, p_caixa: uuidOk(caixa) ? caixa : null });
  let perm: any;
  if (!error && p) perm = { consulta: true, compra: !!p.compra, pendente: !!p.pendente, contingencia: !!p.contingencia };
  else { const compra = l.app_compra || c.compra_liberada; perm = { consulta: true, compra, pendente: l.app_pendente || compra, contingencia: false }; }
  return { c, l, tokHash: await sha256(tok), perm };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return erro("use POST", 405);
  let b: Record<string, any>;
  try { b = await req.json(); } catch { return erro("JSON inválido"); }
  const acao = b.acao;

  if (acao === "loja") {
    if (!uuidOk(b.loja)) return erro("Link da loja inválido");
    const l = await lojaInfo(b.loja);
    const cont = l ? await contingencia(l.id, b.caixa) : false;
    if (!l || !(l.app_consulta || cont)) return erro("Esta loja ainda não liberou o app", 404);
    const { data: e } = await db.from("empresas").select("nome_exibicao, logo_path, cores").eq("id", l.empresa_id).single();
    return json({ loja: { id: l.id, nome: l.nome }, empresa: e?.nome_exibicao ?? "", logo: await logoAssinado(e?.logo_path), cor: e?.cores?.principal ?? null, tema: e?.cores?.tema ?? null, contingencia: cont });
  }

  if (acao === "cadastrar") {
    if (!uuidOk(b.loja)) return erro("Link da loja inválido");
    const l = await lojaInfo(b.loja);
    if (!l || !(l.app_consulta || await contingencia(l.id, b.caixa))) return erro("Esta loja ainda não liberou o app", 404);
    const nome = String(b.nome ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
    const unidade = String(b.unidade ?? "").trim().slice(0, 30);
    const cpf = String(b.cpf ?? "").replace(/\D/g, "");
    const pin = String(b.pin ?? "");
    if (nome.length < 2) return erro("Informe seu nome");
    if (!unidade) return erro("Informe a casa ou o apartamento");
    if (!cpfValido(cpf)) return erro("CPF inválido");
    if (!/^\d{4}$/.test(pin)) return erro("A senha deve ter 4 números");
    if (b.termos !== true) return erro("Para criar o acesso, aceite os Termos de uso e a Política de privacidade");
    const h = await cpfHash(cpf);
    const { data: ja } = await db.from("clientes_app").select("id").eq("empresa_id", l.empresa_id).eq("cpf_hash", h).maybeSingle();
    if (ja) return erro("Este CPF já tem cadastro. Entre com a sua senha.", 409);
    const salt = crypto.randomUUID();
    const { data: c, error } = await db.from("clientes_app").insert({ empresa_id: l.empresa_id, local_id: l.id, nome, unidade, cpf_hash: h, cpf_mascara: mascara(cpf), pin_hash: await pinHash(pin, salt), pin_salt: salt, termos_versao: TERMOS_V, termos_aceitos_em: new Date().toISOString() }).select("id").single();
    if (error) return erro(error.code === "23505" ? "Este CPF já tem cadastro. Entre com a sua senha." : "Não foi possível cadastrar", error.code === "23505" ? 409 : 500);
    return json({ token: await novaSessao(c.id) });
  }

  if (acao === "entrar") {
    if (!uuidOk(b.loja)) return erro("Link da loja inválido");
    const l = await lojaInfo(b.loja);
    if (!l) return erro("Loja não encontrada", 404);
    const cpf = String(b.cpf ?? "").replace(/\D/g, "");
    const pin = String(b.pin ?? "");
    if (!cpfValido(cpf) || !/^\d{4}$/.test(pin)) return erro("CPF ou senha incorretos", 401);
    const { data: c } = await db.from("clientes_app").select("id, pin_hash, pin_salt, tentativas, bloqueado_ate, ativo").eq("empresa_id", l.empresa_id).eq("cpf_hash", await cpfHash(cpf)).maybeSingle();
    if (!c || !c.ativo) { await pinHash(pin, "x"); return erro("CPF ou senha incorretos", 401); }
    if (c.bloqueado_ate && new Date(c.bloqueado_ate) > new Date()) return erro(`Muitas tentativas. Tente de novo em ${Math.ceil((+new Date(c.bloqueado_ate) - Date.now()) / 60000)} min.`, 429);
    if (await pinHash(pin, c.pin_salt) !== c.pin_hash) {
      const n = (c.bloqueado_ate && new Date(c.bloqueado_ate) <= new Date() ? 0 : c.tentativas) + 1;
      await db.from("clientes_app").update(n >= MAX_TENT ? { tentativas: 0, bloqueado_ate: new Date(Date.now() + BLOQ_MIN * 60000).toISOString() } : { tentativas: n, bloqueado_ate: null }).eq("id", c.id);
      return erro(n >= MAX_TENT ? `Muitas tentativas. Tente de novo em ${BLOQ_MIN} min.` : "CPF ou senha incorretos", n >= MAX_TENT ? 429 : 401);
    }
    await db.from("clientes_app").update({ tentativas: 0, bloqueado_ate: null }).eq("id", c.id);
    return json({ token: await novaSessao(c.id) });
  }

  // relatório público do anunciante (link com código secreto da campanha)
  if (acao === "relatorio") {
    if (!uuidOk(b.t)) return erro("Relatório não encontrado", 404);
    const { data: c } = await db.from("campanhas_midia").select("id, empresa_id, anunciante_id, nome, anuncios, locais, inicio, fim, canais, status").eq("relatorio_token", b.t).maybeSingle();
    if (!c) return erro("Relatório não encontrado", 404);
    const [{ data: an }, { data: emp }, { data: ad }, { data: lojas }, { data: ev }] = await Promise.all([
      db.from("anunciantes").select("nome").eq("id", c.anunciante_id).single(),
      db.from("empresas").select("nome_exibicao, logo_path").eq("id", c.empresa_id).single(),
      db.from("anuncios").select("titulo, texto, arquivo_path, formato, cupom").in("id", c.anuncios ?? []).limit(1),
      db.from("locais").select("id, nome").eq("empresa_id", c.empresa_id).eq("tipo", "loja"),
      db.from("midia_exibicoes").select("exibido_em, tipo, canal, cliente_app_id").eq("campanha_id", c.id).order("exibido_em").limit(100000),
    ]);
    const dias = new Map<string, { v: number; c: number }>(), canais: Record<string, { v: number; c: number }> = {}, pessoas = new Set<string>();
    let v = 0, k = 0;
    for (const e of ev ?? []) {
      const d = new Date(new Date(e.exibido_em).getTime() - 3 * 36e5).toISOString().slice(0, 10);
      const x = dias.get(d) ?? { v: 0, c: 0 }; const y = canais[e.canal] ??= { v: 0, c: 0 };
      if (e.tipo === "clique") { x.c++; y.c++; k++; } else { x.v++; y.v++; v++; if (e.cliente_app_id) pessoas.add(e.cliente_app_id); }
      dias.set(d, x);
    }
    let midia = null;
    if (ad?.[0]?.arquivo_path) { const { data: u } = await db.storage.from("midia").createSignedUrl(ad[0].arquivo_path, 3600); midia = u?.signedUrl ?? null; }
    const nomes = (lojas ?? []).filter((l: any) => !c.locais?.length || c.locais.includes(l.id)).map((l: any) => l.nome);
    return json({ empresa: emp?.nome_exibicao ?? "", logo: await logoAssinado(emp?.logo_path), anunciante: an?.nome, campanha: { titulo: ad?.[0]?.titulo ?? c.nome, texto: ad?.[0]?.texto, cupom: ad?.[0]?.cupom, video: ad?.[0]?.formato !== "imagem", midia, inicio: c.inicio, fim: c.fim, status: c.status, canais: c.canais, lojas: nomes },
      totais: { visualizacoes: v, cliques: k, pessoas: pessoas.size }, canais, dias: [...dias].map(([d, x]) => ({ d, ...x })), gerado: new Date().toISOString() });
  }

  const s = await sessao(req, b.caixa);
  if (!s) return erro("Entre de novo no app", 401);

  if (acao === "aceitar_termos") {
    await db.from("clientes_app").update({ termos_versao: TERMOS_V, termos_aceitos_em: new Date().toISOString() }).eq("id", s.c.id);
    return json({ ok: true });
  }

  if (acao === "avisar") {
    if (!uuidOk(b.produto_id)) return erro("Produto inválido");
    if (b.cancelar) { await db.from("avisos_estoque").delete().eq("cliente_app_id", s.c.id).eq("produto_id", b.produto_id).is("avisado_em", null); return json({ ok: true }); }
    const { data: p } = await db.from("precos_local").select("produto_id").eq("local_id", s.l.id).eq("produto_id", b.produto_id).maybeSingle();
    if (!p) return erro("Produto não encontrado nesta loja", 404);
    const { error } = await db.from("avisos_estoque").insert({ empresa_id: s.c.empresa_id, local_id: s.l.id, produto_id: b.produto_id, cliente_app_id: s.c.id });
    if (error && error.code !== "23505") return erro("Não foi possível salvar o aviso", 500);
    return json({ ok: true });
  }

  if (acao === "me") {
    const { data: e } = await db.from("empresas").select("nome_exibicao, logo_path, cores").eq("id", s.c.empresa_id).single();
    return json({ cliente: { nome: s.c.nome, unidade: s.c.unidade, cpf: s.c.cpf_mascara }, loja: { id: s.l.id, nome: s.l.nome, empresa: e?.nome_exibicao ?? "", logo: await logoAssinado(e?.logo_path), cor: e?.cores?.principal ?? null, tema: e?.cores?.tema ?? null }, perm: s.perm, pagamento_teste: false, termos_ok: s.c.termos_versao === TERMOS_V });
  }

  // o app pergunta de tempos em tempos: a contingência começou ou acabou?
  if (acao === "status") return json({ perm: s.perm });

  if (acao === "sair") { await db.from("sessoes_cliente").delete().eq("token_hash", s.tokHash); return json({ ok: true }); }

  if (acao === "catalogo") {
    const [{ data: precos }, { data: mov }] = await Promise.all([
      db.from("precos_local").select("preco, produtos!inner(id, nome, ean, ativo, idade_minima, categoria_id, produto_codigos(ean))").eq("local_id", s.l.id).eq("ativo_no_mix", true),
      db.from("saldos_estoque").select("produto_id, saldo").eq("local_id", s.l.id),
    ]);
    const saldo = new Map<string, number>();
    for (const m of mov ?? []) saldo.set(m.produto_id, Number(m.saldo));
    const ativos = (precos ?? []).filter((p: any) => p.produtos.ativo);
    const ids = ativos.map((p: any) => p.produtos.id);
    const fotos = new Map<string, string>();
    // fotos em lotes: uma lista com centenas de ids numa URL só falha calada
    for (let i = 0; i < ids.length; i += 150) {
      const { data: fs } = await db.from("produto_fotos").select("produto_id, path").eq("empresa_id", s.c.empresa_id).in("produto_id", ids.slice(i, i + 150)).eq("principal", true);
      if (!fs?.length) continue;
      const { data: urls } = await db.storage.from("produtos").createSignedUrls(fs.map((f: any) => f.path), 60 * 60 * 24 * 7);
      const porPath = new Map((urls ?? []).filter((u: any) => u.signedUrl).map((u: any) => [u.path, u.signedUrl]));
      for (const f of fs) if (porPath.has(f.path)) fotos.set(f.produto_id, porPath.get(f.path)!);
    }
    // loja sem controle de estoque (quase nenhum produto com saldo lançado): não mostra "esgotado", senão o app
    // trava a compra de produtos que estão na prateleira
    const comSaldo = ativos.filter((p: any) => (saldo.get(p.produtos.id) ?? 0) > 0).length;
    const controla = comSaldo >= Math.max(5, ativos.length * 0.3);
    const produtos = ativos.map((p: any) => {
      const q = saldo.get(p.produtos.id) ?? 0;
      return { id: p.produtos.id, nome: p.produtos.nome, preco: p.preco, foto: fotos.get(p.produtos.id) ?? null, maior18: (p.produtos.idade_minima ?? 0) >= 18,
        codigos: [...new Set([p.produtos.ean, ...(p.produtos.produto_codigos ?? []).map((c: any) => c.ean)].filter(Boolean))],
        estoque: !controla ? null : q <= 0 ? "esgotado" : q <= 3 ? "poucos" : "tem" };
    }).sort((a: any, b: any) => a.nome.localeCompare(b.nome, "pt-BR"));
    // avise-me: o que o cliente pediu e o que já voltou ao estoque (avisa uma vez só)
    const { data: avs } = await db.from("avisos_estoque").select("id, produto_id").eq("cliente_app_id", s.c.id).is("avisado_em", null);
    const voltou = (avs ?? []).filter((a: any) => (saldo.get(a.produto_id) ?? 0) > 0);
    if (voltou.length) await db.from("avisos_estoque").update({ avisado_em: new Date().toISOString() }).in("id", voltou.map((a: any) => a.id));
    const chegaram = voltou.map((a: any) => produtos.find((p: any) => p.id === a.produto_id)).filter(Boolean).map((p: any) => ({ id: p.id, nome: p.nome }));
    return json({ produtos, perm: s.perm, avisos: (avs ?? []).filter((a: any) => !voltou.includes(a)).map((a: any) => a.produto_id), chegaram });
  }

  if (acao === "pendentes") {
    if (!s.perm.pendente) return json({ vendas: [] });
    const { data } = await db.from("vendas").select("id, total, iniciada_em, observacao, venda_itens(quantidade, preco_unit, produtos(nome, idade_minima))").eq("cliente_app_id", s.c.id).eq("status", "aberta").eq("origem", "pendente_app").order("iniciada_em", { ascending: false });
    return json({ vendas: (data ?? []).map((v: any) => ({ id: v.id, total: v.total, criada_em: v.iniciada_em, maior18: (v.venda_itens ?? []).some((i: any) => (i.produtos?.idade_minima ?? 0) >= 18), itens: (v.venda_itens ?? []).map((i: any) => ({ nome: i.produtos?.nome, quantidade: Number(i.quantidade), preco: i.preco_unit })) })) });
  }

  if (acao === "historico") {
    const { data } = await db.from("vendas").select("id, total, finalizada_em, origem, venda_itens(produto_id, quantidade, produtos(nome))").eq("cliente_app_id", s.c.id).eq("status", "paga").order("finalizada_em", { ascending: false }).limit(20);
    return json({ vendas: (data ?? []).map((v: any) => ({ id: v.id, total: v.total, quando: v.finalizada_em, itens: (v.venda_itens ?? []).map((i: any) => `${Number(i.quantidade)}× ${i.produtos?.nome}`), linhas: (v.venda_itens ?? []).map((i: any) => ({ id: i.produto_id, q: Number(i.quantidade) })) })) });
  }

  // anúncios de parceiros ativos para a loja do cliente (campanha ativa, no período, no horário, canal app)
  if (acao === "anuncios") {
    const agoraBR = new Date(Date.now() - 3 * 3600 * 1000); // horário de Brasília/Fortaleza
    const hoje = agoraBR.toISOString().slice(0, 10), hora = agoraBR.toISOString().slice(11, 19);
    const { data: camps } = await db.from("campanhas_midia").select("id, anunciante_id, anuncios, locais, hora_inicio, hora_fim, ordem, criado_em").eq("empresa_id", s.c.empresa_id).eq("status", "ativa").lte("inicio", hoje).gte("fim", hoje).contains("canais", ["app_cliente"]);
    const validas = (camps ?? []).filter((c: any) => (!c.locais?.length || c.locais.includes(s.l.id)) && (!c.hora_inicio || !c.hora_fim || (hora >= c.hora_inicio && hora <= c.hora_fim)));
    const ids = [...new Set(validas.flatMap((c: any) => c.anuncios ?? []))];
    if (!ids.length) return json({ anuncios: [] });
    const [{ data: ads }, { data: anunc }] = await Promise.all([
      db.from("anuncios").select("id, anunciante_id, titulo, formato, arquivo_path, texto, link_url, botao, legenda, cupom").eq("empresa_id", s.c.empresa_id).eq("aprovado", true).in("id", ids),
      db.from("anunciantes").select("id, nome, segmento, ativo, proprio").eq("empresa_id", s.c.empresa_id),
    ]);
    const nomeAn = new Map((anunc ?? []).filter((a: any) => a.ativo).map((a: any) => [a.id, a]));
    const paths = (ads ?? []).map((a: any) => a.arquivo_path).filter(Boolean);
    const { data: urls } = paths.length ? await db.storage.from("midia").createSignedUrls(paths, 60 * 60 * 24) : { data: [] };
    const url = new Map((urls ?? []).filter((u: any) => u.signedUrl).map((u: any) => [u.path, u.signedUrl]));
    const lista = [];
    validas.sort((x: any, y: any) => (nomeAn.get(x.anunciante_id)?.proprio ? 1 : 0) - (nomeAn.get(y.anunciante_id)?.proprio ? 1 : 0) || x.ordem - y.ordem || String(x.criado_em).localeCompare(String(y.criado_em)));
    for (const c of validas) for (const id of c.anuncios ?? []) {
      const a: any = (ads ?? []).find((x: any) => x.id === id);
      const an: any = a && nomeAn.get(a.anunciante_id);
      if (!a || !an || !url.get(a.arquivo_path)) continue;
      lista.push({ id: a.id, campanha_id: c.id, titulo: a.titulo, texto: a.texto, botao: a.botao, link: a.link_url, video: a.formato !== "imagem", midia: url.get(a.arquivo_path), anunciante: an.nome, segmento: an.segmento, cupom: a.cupom, proprio: !!an.proprio });
    }
    return json({ anuncios: lista.slice(0, 20) });
  }

  // contagem de exibições e cliques (para o relatório do anunciante)
  if (acao === "midia_evento") {
    const evs = Array.isArray(b.eventos) ? b.eventos.slice(0, 30) : [];
    const ok = evs.filter((e: any) => uuidOk(e.anuncio_id) && uuidOk(e.campanha_id) && ["exibicao", "clique"].includes(e.tipo));
    if (!ok.length) return json({ ok: true });
    const { data: camps } = await db.from("campanhas_midia").select("id").eq("empresa_id", s.c.empresa_id).in("id", [...new Set(ok.map((e: any) => e.campanha_id))]);
    const validas = new Set((camps ?? []).map((c: any) => c.id));
    const linhas = ok.filter((e: any) => validas.has(e.campanha_id)).map((e: any) => ({ empresa_id: s.c.empresa_id, campanha_id: e.campanha_id, anuncio_id: e.anuncio_id, local_id: s.l.id, segundos: 1, canal: "app_cliente", tipo: e.tipo, cliente_app_id: s.c.id }));
    if (linhas.length) await db.from("midia_exibicoes").insert(linhas);
    return json({ ok: true });
  }

  // o pagamento simulado do app foi desligado: agora é Pix de verdade, pela função "cartao" (app_pix)
  if (acao === "pagar") return erro("Atualize o app: feche e abra de novo para pagar com Pix.", 410);

  return erro("Ação desconhecida");
});
