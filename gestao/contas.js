// Contas a pagar: parcelas de compra (entram sozinhas ao lançar NF-e ou cupom) e despesas cadastradas à mão.
// O Início avisa o que venceu e o que vence nos próximos dias (avisosContas).

const FORMAS = { boleto: 'Boleto', pix: 'Pix', transferencia: 'Transferência', cartao: 'Cartão', dinheiro: 'Dinheiro', debito_automatico: 'Débito automático' };
const CATEGORIAS = ['Compra de mercadoria', 'Aluguel', 'Condomínio', 'Energia', 'Água', 'Internet e telefone', 'Salários e encargos', 'Impostos', 'Contador', 'Sistema e aplicativos', 'Manutenção', 'Material de limpeza', 'Frete', 'Outros'];
const F = { filtro: 'aberto', q: '' };

const diaIso = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
const hojeIso = () => diaIso(new Date());
const dias = (a, b) => Math.round((new Date(a + 'T12:00:00') - new Date(b + 'T12:00:00')) / 864e5);
const somaDias = (iso, n) => diaIso(new Date(new Date(iso + 'T12:00:00').getTime() + n * 864e5));
const proximoMes = iso => { const d = new Date(iso + 'T12:00:00'), dia = d.getDate(), x = new Date(d.getFullYear(), d.getMonth() + 1, 1, 12); x.setDate(Math.min(dia, new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate())); return diaIso(x); };
const dataBR = iso => iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '—';
const centavos = v => { const c = Math.round(parseFloat(String(v || '').trim().replace(/\./g, '').replace(',', '.')) * 100); return c > 0 ? c : 0; };
const reais = c => c ? (c / 100).toFixed(2).replace('.', ',') : '';

function situacao(c, hoje) {
  if (c.pago_em) return { k: 'paga', pill: 'ok', t: `Paga em ${dataBR(c.pago_em)}` };
  const d = dias(c.vencimento, hoje);
  if (d < 0) return { k: 'vencida', pill: 'bad', t: `Vencida há ${-d} ${d === -1 ? 'dia' : 'dias'}` };
  if (d === 0) return { k: 'hoje', pill: 'warn', t: 'Vence hoje' };
  if (d <= 7) return { k: 'semana', pill: 'warn', t: `Vence em ${d} ${d === 1 ? 'dia' : 'dias'}` };
  return { k: 'futura', pill: '', t: `Vence em ${d} dias` };
}

// para o "Precisa da sua atenção" do Início
export async function avisosContas(C) {
  const { sb, S } = C, hoje = hojeIso();
  const r = await sb.from('contas_pagar').select('valor,vencimento').eq('empresa_id', S.emp.id).is('pago_em', null).lte('vencimento', somaDias(hoje, 3)).limit(1000);
  if (r.error) return null;
  const venc = r.data.filter(c => c.vencimento < hoje), prox = r.data.filter(c => c.vencimento >= hoje);
  const soma = a => a.reduce((s, c) => s + c.valor, 0);
  return { vencidas: venc.length, vencidasValor: soma(venc), hoje: prox.filter(c => c.vencimento === hoje).length, proximas: prox.length, proximasValor: soma(prox) };
}

export async function telaContas(C) {
  const { sb, S, $, esc, brl, toast, bonito } = C, M = $('#main'), hoje = hojeIso();
  M.innerHTML = `<div class="head"><div><h1>Contas a pagar</h1><p>Boletos e parcelas das notas de compra entram sozinhos ao lançar a nota. Aluguel, energia e outras despesas você cadastra aqui.</p></div><button class="btn pri" id="cpNova">Nova conta</button></div><div id="cpCorpo"><p class="vazio">Carregando…</p></div>`;
  $('#cpNova').onclick = () => editar(C, null);
  const [r, rf] = await Promise.all([
    sb.from('contas_pagar').select('id,descricao,fornecedor_id,categoria,local_id,rateio,vencimento,valor,pago_em,valor_pago,forma,codigo_barras,nota_entrada_id,recorrente').eq('empresa_id', S.emp.id).order('vencimento', { ascending: true }).limit(2000),
    sb.from('fornecedores').select('id,razao_social,nome_fantasia').eq('empresa_id', S.emp.id)]);
  const el = $('#cpCorpo'); if (!el || S.tela !== 'cp') return;
  if (r.error) { el.innerHTML = `<p class="vazio">Não foi possível carregar: ${esc(r.error.message)}</p>`; return; }
  const forn = new Map((rf.data || []).map(f => [f.id, bonito(f.nome_fantasia || f.razao_social)]));
  const todas = r.data.map(c => ({ ...c, sit: situacao(c, hoje) }));
  const abertas = todas.filter(c => !c.pago_em), soma = a => a.reduce((s, c) => s + c.valor, 0);
  const venc = abertas.filter(c => c.sit.k === 'vencida'), hj = abertas.filter(c => c.sit.k === 'hoje'), sem = abertas.filter(c => c.sit.k === 'semana');
  const mes = hoje.slice(0, 7), pagasMes = todas.filter(c => c.pago_em && c.pago_em.slice(0, 7) === mes);
  const filtros = { aberto: abertas, vencidas: venc, semana: [...hj, ...sem], pagas: todas.filter(c => c.pago_em).reverse(), todas };
  const q = F.q.trim().toLowerCase();
  const lista = (filtros[F.filtro] || abertas).filter(c => !q || (c.descricao + ' ' + (forn.get(c.fornecedor_id) || '') + ' ' + c.categoria).toLowerCase().includes(q));
  const local = c => c.local_id ? (S.locais.find(l => l.id === c.local_id)?.nome || 'Local removido') : c.rateio === 'geral_igual' ? 'Geral (dividido igual)' : 'Geral (pelo faturamento)';
  const chip = (k, t) => `<button class="prchip${F.filtro === k ? ' on' : ''}" data-f="${k}">${t}<span class="num">${filtros[k].length}</span></button>`;
  el.innerHTML = `<div class="grid4" style="margin-bottom:16px">
    <div class="kpi"><span>Vencidas</span><b class="num" style="color:${venc.length ? 'var(--badt)' : 'inherit'}">${brl(soma(venc))}</b><small class="mu">${venc.length} ${venc.length === 1 ? 'conta' : 'contas'}</small></div>
    <div class="kpi"><span>Vencem hoje</span><b class="num" style="color:${hj.length ? 'var(--warnt)' : 'inherit'}">${brl(soma(hj))}</b><small class="mu">${hj.length} ${hj.length === 1 ? 'conta' : 'contas'}</small></div>
    <div class="kpi"><span>Próximos 7 dias</span><b class="num">${brl(soma(sem))}</b><small class="mu">${sem.length} ${sem.length === 1 ? 'conta' : 'contas'}</small></div>
    <div class="kpi"><span>Em aberto, total</span><b class="num">${brl(soma(abertas))}</b><small class="mu">pago no mês: ${brl(pagasMes.reduce((s, c) => s + (c.valor_pago || 0), 0))}</small></div></div>
   <div class="row" style="gap:8px;margin-bottom:12px">${chip('aberto', 'Em aberto')}${chip('vencidas', 'Vencidas')}${chip('semana', 'Até 7 dias')}${chip('pagas', 'Pagas')}${chip('todas', 'Todas')}<span class="sp"></span><input type="search" id="cpQ" placeholder="Buscar fornecedor ou descrição" value="${esc(F.q)}" style="max-width:280px"></div>
   ${lista.length ? `<div class="tblwrap"><table class="tbl cpt"><thead><tr><th>Vencimento</th><th>Conta</th><th>Centro de custo</th><th>Forma</th><th class="n">Valor</th><th>Situação</th><th></th></tr></thead><tbody>
   ${lista.map(c => `<tr class="${c.sit.k === 'vencida' ? 'cpv' : ''}"><td class="num" data-l="Vencimento">${dataBR(c.vencimento)}</td>
     <td><b>${esc(c.descricao)}</b><br><span class="mu sm">${esc(forn.get(c.fornecedor_id) || c.categoria)}${c.nota_entrada_id ? ' · da nota de compra' : ''}${c.recorrente ? ' · repete ' + (c.recorrente === 'mensal' ? 'todo mês' : 'toda semana') : ''}</span></td>
     <td data-l="Centro de custo">${esc(local(c))}</td><td data-l="Forma">${esc(FORMAS[c.forma] || '—')}</td>
     <td class="n num" data-l="Valor">${brl(c.valor)}${c.pago_em && c.valor_pago !== c.valor ? `<br><span class="mu sm">pago ${brl(c.valor_pago)}</span>` : ''}</td>
     <td data-l="Situação"><span class="pill ${c.sit.pill}">${c.sit.t}</span></td>
     <td class="n"><div class="row" style="justify-content:flex-end;gap:6px;flex-wrap:nowrap;white-space:nowrap">${c.codigo_barras && !c.pago_em ? `<button class="btn sm" data-cod="${c.id}">Copiar código</button>` : ''}${c.pago_em ? `<button class="btn sm" data-desf="${c.id}">Desfazer pagamento</button>` : `<button class="btn sm pri" data-pagar="${c.id}">Pagar</button>`}<button class="btn sm" data-ed="${c.id}">Editar</button></div></td></tr>`).join('')}</tbody></table></div>`
      : `<p class="vazio">${todas.length ? 'Nenhuma conta neste filtro.' : 'Nenhuma conta ainda. As parcelas das notas de compra entram aqui ao lançar a nota. Para aluguel, energia e outras despesas, use "Nova conta".'}</p>`}`;
  el.querySelectorAll('.prchip').forEach(b => b.onclick = () => { F.filtro = b.dataset.f; telaContas(C); });
  const iq = $('#cpQ'); iq.oninput = () => { F.q = iq.value; clearTimeout(iq._t); iq._t = setTimeout(() => { telaContas(C).then(() => { const i = $('#cpQ'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }); }, 250); };
  const achar = id => todas.find(c => c.id === id);
  el.querySelectorAll('[data-cod]').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(achar(b.dataset.cod).codigo_barras); toast('Código copiado. Cole no app do banco.'); } catch (e) { toast('Não consegui copiar: ' + achar(b.dataset.cod).codigo_barras); } });
  el.querySelectorAll('[data-pagar]').forEach(b => b.onclick = () => pagar(C, achar(b.dataset.pagar)));
  el.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => editar(C, achar(b.dataset.ed), forn));
  el.querySelectorAll('[data-desf]').forEach(b => b.onclick = async () => {
    if (!window.confirm('Voltar esta conta para "em aberto"?')) return;
    const x = await sb.from('contas_pagar').update({ pago_em: null, valor_pago: null }).eq('id', b.dataset.desf); if (x.error) toast(x.error.message); else telaContas(C);
  });
}

function pagar(C, c) {
  const { sb, esc, brl, toast, modal, fechar, $ } = C;
  modal(`<h2>Pagar conta</h2><p class="mu">${esc(c.descricao)} · vence ${dataBR(c.vencimento)} · ${brl(c.valor)}</p>
   <div class="grid2"><label class="f">Pago em<input type="date" id="pgD" value="${hojeIso()}"></label><label class="f">Valor pago<input id="pgV" class="num" inputmode="decimal" value="${reais(c.valor)}"></label></div>
   <p class="mu sm">Com juros ou desconto, ajuste o valor pago.${c.recorrente ? ` Esta conta se repete ${c.recorrente === 'mensal' ? 'todo mês' : 'toda semana'}: a próxima é criada ao pagar.` : ''}</p>
   <div class="row"><span class="sp"></span><button class="btn" data-close>Cancelar</button><button class="btn pri" id="pgOk">Confirmar pagamento</button></div>`);
  $('#pgOk').onclick = async () => {
    const d = $('#pgD').value, v = centavos($('#pgV').value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !v) { toast('Informe a data e o valor pago'); return; }
    $('#pgOk').disabled = true;
    const r = await C.sb.from('contas_pagar').update({ pago_em: d, valor_pago: v }).eq('id', c.id);
    if (r.error) { toast(r.error.message); $('#pgOk').disabled = false; return; }
    if (c.recorrente) {
      const prox = c.recorrente === 'mensal' ? proximoMes(c.vencimento) : somaDias(c.vencimento, 7);
      const { id, sit, pago_em, valor_pago, codigo_barras, nota_entrada_id, ...resto } = c;
      const n = await sb.from('contas_pagar').insert({ ...resto, empresa_id: C.S.emp.id, vencimento: prox });
      if (n.error) toast('Paga, mas a próxima não foi criada: ' + n.error.message); else toast('Paga. A próxima vence em ' + dataBR(prox) + '.');
    } else toast('Conta paga');
    fechar(); telaContas(C);
  };
}

async function editar(C, c, fornMap) {
  const { sb, S, esc, toast, modal, fechar, $, lojas } = C;
  const { data: forns } = await sb.from('fornecedores').select('id,razao_social,nome_fantasia').eq('empresa_id', S.emp.id).order('razao_social');
  const locs = S.locais.filter(l => l.ativo), sel = (v, o) => v === o ? 'selected' : '';
  const cc = c ? (c.local_id || (c.rateio === 'geral_igual' ? 'geral_igual' : 'geral_faturamento')) : (locs.find(l => l.tipo === 'cd')?.id || 'geral_faturamento');
  modal(`<h2>${c ? 'Editar conta' : 'Nova conta'}</h2>
   <label class="f">Descrição<input id="ceD" maxlength="120" value="${esc(c?.descricao || '')}" placeholder="Ex.: Aluguel da loja Tríade"></label>
   <div class="grid2"><label class="f">Categoria<input id="ceC" list="ceCats" value="${esc(c?.categoria || '')}" placeholder="Escolha ou digite"><datalist id="ceCats">${CATEGORIAS.map(x => `<option value="${esc(x)}">`).join('')}</datalist></label>
    <label class="f">Fornecedor<select id="ceF"><option value="">Nenhum</option>${(forns || []).map(f => `<option value="${f.id}" ${sel(c?.fornecedor_id, f.id)}>${esc(C.bonito(f.nome_fantasia || f.razao_social))}</option>`).join('')}</select></label></div>
   <div class="grid2"><label class="f">Vencimento<input type="date" id="ceV" value="${esc(c?.vencimento || '')}"></label><label class="f">Valor<input id="ceR" class="num" inputmode="decimal" value="${reais(c?.valor)}" placeholder="0,00"></label></div>
   <div class="grid2"><label class="f">Forma de pagamento<select id="ceFo"><option value="">—</option>${Object.entries(FORMAS).map(([k, t]) => `<option value="${k}" ${sel(c?.forma, k)}>${t}</option>`).join('')}</select></label>
    <label class="f">Centro de custo<select id="ceL">${locs.map(l => `<option value="${l.id}" ${sel(cc, l.id)}>${esc(l.nome)}${l.tipo === 'cd' ? ' (CD)' : ''}</option>`).join('')}<option value="geral_faturamento" ${sel(cc, 'geral_faturamento')}>Geral, dividido pelo faturamento das lojas</option><option value="geral_igual" ${sel(cc, 'geral_igual')}>Geral, dividido igual entre as lojas</option></select></label></div>
   <label class="f">Código de barras do boleto (opcional)<input id="ceB" inputmode="numeric" value="${esc(c?.codigo_barras || '')}" placeholder="Linha digitável"></label>
   <label class="f">Repetir<select id="ceRp"><option value="">Não repete</option><option value="mensal" ${sel(c?.recorrente, 'mensal')}>Todo mês (cria a próxima ao pagar)</option><option value="semanal" ${sel(c?.recorrente, 'semanal')}>Toda semana (cria a próxima ao pagar)</option></select></label>
   <div class="row">${c && !c.nota_entrada_id ? '<button class="btn" id="ceX" style="color:var(--badt)">Excluir</button>' : ''}<span class="sp"></span><button class="btn" data-close>Cancelar</button><button class="btn pri" id="ceOk">Salvar</button></div>`);
  $('#ceOk').onclick = async () => {
    const descricao = $('#ceD').value.trim(), categoria = $('#ceC').value.trim() || 'Outros', vencimento = $('#ceV').value, valor = centavos($('#ceR').value), l = $('#ceL').value;
    if (!descricao) { toast('Dê uma descrição para a conta'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(vencimento)) { toast('Informe o vencimento'); return; }
    if (!valor) { toast('Informe o valor'); return; }
    const geral = l.startsWith('geral');
    const d = { descricao: descricao.slice(0, 120), categoria, vencimento, valor, forma: $('#ceFo').value || null, fornecedor_id: $('#ceF').value || null, local_id: geral ? null : l, rateio: geral ? l : 'loja', codigo_barras: $('#ceB').value.replace(/\D/g, '') || null, recorrente: $('#ceRp').value || null };
    $('#ceOk').disabled = true;
    const r = c ? await sb.from('contas_pagar').update(d).eq('id', c.id) : await sb.from('contas_pagar').insert({ ...d, empresa_id: S.emp.id });
    if (r.error) { toast(r.error.message); $('#ceOk').disabled = false; return; }
    fechar(); toast(c ? 'Conta atualizada' : 'Conta cadastrada'); telaContas(C);
  };
  const x = $('#ceX'); if (x) x.onclick = async () => {
    if (!window.confirm('Excluir esta conta? Não dá para desfazer.')) return;
    const r = await sb.from('contas_pagar').delete().eq('id', c.id); if (r.error) toast(r.error.message); else { fechar(); telaContas(C); }
  };
}
