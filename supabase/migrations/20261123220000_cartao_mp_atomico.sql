-- Maquininha Mercado Pago: gravação atômica da venda, estorno e travas contra cobrança em dobro.
-- Só a função "cartao" / "pagamento-config" (service_role) chama estas funções.

-- 1) No máximo uma cobrança aberta por caixa e por venda (evita duas cobranças com toque duplo)
create unique index if not exists cobrancas_cartao_uma_aberta_por_caixa
  on public.cobrancas_cartao (dispositivo_id)
  where status in ('criando', 'aguardando', 'na_maquininha', 'verificar');

create unique index if not exists cobrancas_cartao_uma_aberta_por_venda
  on public.cobrancas_cartao (venda_id)
  where status in ('criando', 'aguardando', 'na_maquininha', 'verificar');

-- só uma cobrança aprovada por venda (a segunda aprovação vira "pagamento_em_dobro" e pode ser estornada)
create unique index if not exists cobrancas_cartao_uma_aprovada_por_venda
  on public.cobrancas_cartao (venda_id)
  where status = 'aprovado';

alter table public.cobrancas_cartao add column if not exists estornado_em timestamptz;
alter table public.cobrancas_cartao add column if not exists estornado_por uuid;
alter table public.cobrancas_cartao drop constraint if exists cobrancas_cartao_status_check;
alter table public.cobrancas_cartao add constraint cobrancas_cartao_status_check
  check (status in ('criando', 'aguardando', 'na_maquininha', 'verificar', 'aprovado', 'recusado', 'cancelado', 'expirado', 'estornado', 'falhou'));

create index if not exists mp_webhooks_recebido_idx on public.mp_webhooks (recebido_em);

-- 2) Grava a venda de uma cobrança aprovada: venda, itens, pagamento e baixa de estoque numa única transação.
--    Idempotente: chamar duas vezes (aviso + consulta do tablet ao mesmo tempo) grava uma vez só.
create or replace function public.gravar_venda_cartao(p_cobranca uuid, p_teste boolean default false)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare c cobrancas_cartao; it jsonb; v_custo int; v_agora timestamptz := now();
begin
  select * into c from cobrancas_cartao where id = p_cobranca for update;
  if not found then return 'nao_encontrada'; end if;
  if c.status <> 'aprovado' then return 'nao_aprovada'; end if;
  if c.venda_gravada then return 'ja_gravada'; end if;

  if exists (select 1 from vendas where id = c.venda_id) then
    -- a venda já existe (gravada por outro caminho): nunca duplica.
    if exists (select 1 from pagamentos where venda_id = c.venda_id and status = 'aprovado' and nsu = coalesce(c.nsu, c.mp_payment_id)) then
      update cobrancas_cartao set venda_gravada = true, erro = null, atualizado_em = v_agora where id = c.id;
      return 'ja_existia';
    end if;
    -- foi paga por outro meio (ex.: Pix depois de um cartão dado como perdido): este cartão é um pagamento em dobro
    update cobrancas_cartao set venda_gravada = true, status_detail = 'pagamento_em_dobro',
      erro = 'Compra já paga por outro meio: estornar este cartão no Mercado Pago', atualizado_em = v_agora where id = c.id;
    return 'duplicada';
  end if;

  insert into vendas (id, empresa_id, local_id, dispositivo_id, iniciada_em, finalizada_em, status, total, origem, teste)
  values (c.venda_id, c.empresa_id, c.local_id, c.dispositivo_id, coalesce(c.iniciada_em, v_agora), v_agora, 'paga', c.valor, 'telefone', p_teste);

  for it in select * from jsonb_array_elements(c.itens) loop
    select custo into v_custo from produtos where id = (it->>'produto_id')::uuid and empresa_id = c.empresa_id;
    v_custo := coalesce(v_custo, (it->>'custo_unit')::int, 0);
    insert into venda_itens (venda_id, empresa_id, seq, produto_id, quantidade, preco_unit, custo_unit)
    values (c.venda_id, c.empresa_id, (it->>'seq')::int, (it->>'produto_id')::uuid, (it->>'quantidade')::numeric, (it->>'preco_unit')::int, v_custo);
    insert into estoque_mov (empresa_id, local_id, produto_id, tipo, quantidade, custo_unit, referencia, usuario_id)
    values (c.empresa_id, c.local_id, (it->>'produto_id')::uuid, 'venda', -((it->>'quantidade')::numeric), v_custo, c.venda_id, null);
  end loop;

  insert into pagamentos (venda_id, empresa_id, forma, valor, status, nsu, autorizacao, bandeira)
  values (c.venda_id, c.empresa_id, c.forma::forma_pagamento, c.valor, 'aprovado', coalesce(c.nsu, c.mp_payment_id), c.autorizacao, c.bandeira);

  update cobrancas_cartao set venda_gravada = true, erro = null, atualizado_em = v_agora where id = c.id;
  return 'gravada';
end $$;

-- 3) Estorno confirmado pelo Mercado Pago: cancela a venda, estorna o pagamento e devolve o estoque (uma vez só).
create or replace function public.estornar_venda_cartao(p_cobranca uuid, p_usuario uuid default null)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare c cobrancas_cartao; v_agora timestamptz := now();
begin
  select * into c from cobrancas_cartao where id = p_cobranca for update;
  if not found then return 'nao_encontrada'; end if;
  if c.estornado_em is not null then return 'ja_estornada'; end if;

  update cobrancas_cartao set status = 'estornado', estornado_em = v_agora, estornado_por = p_usuario, atualizado_em = v_agora where id = c.id;
  -- cartão em dobro: a venda é de outro pagamento e continua valendo
  if not c.venda_gravada or c.status_detail = 'pagamento_em_dobro' then return 'sem_venda'; end if;

  update vendas set status = 'cancelada' where id = c.venda_id and status = 'paga';
  update pagamentos set status = 'estornado' where venda_id = c.venda_id and status = 'aprovado' and forma = c.forma::forma_pagamento;
  insert into estoque_mov (empresa_id, local_id, produto_id, tipo, quantidade, custo_unit, referencia, usuario_id)
  select empresa_id, local_id, produto_id, 'cancelamento_venda', -quantidade, custo_unit, referencia, p_usuario
  from estoque_mov where referencia = c.venda_id and tipo = 'venda';
  return 'estornada';
end $$;

revoke all on function public.gravar_venda_cartao(uuid, boolean) from public, anon, authenticated;
revoke all on function public.estornar_venda_cartao(uuid, uuid) from public, anon, authenticated;
grant execute on function public.gravar_venda_cartao(uuid, boolean) to service_role;
grant execute on function public.estornar_venda_cartao(uuid, uuid) to service_role;
