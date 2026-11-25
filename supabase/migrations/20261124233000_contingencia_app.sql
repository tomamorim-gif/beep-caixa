-- Modo contingência: quando o caixa (tablet) da loja fica sem internet, o app do cliente assume a compra
-- (ler o código de barras e pagar no Pix). Quando o caixa volta, o app volta sozinho à regra do Painel.
--
-- Como funciona:
--   1) o caixa manda um sinal a cada 30 s (rpc caixa_sinal, com o token do aparelho; não precisa de login);
--   2) se nenhum caixa ativo da loja der sinal por 90 s, loja_contingencia() abre um registro em "contingencias"
--      e o app passa a aceitar compra com Pix (só nas lojas com a opção "Aceita pagamento com sistema offline");
--   3) no primeiro sinal de volta, o registro é fechado e o app volta ao normal.
--   Um job de 1 em 1 minuto confere todas as lojas, para o Painel mostrar a hora certa mesmo sem ninguém no app.
--
-- Também: Pix de verdade no app do cliente (antes o pagamento no app era simulado). A cobrança usa a mesma
-- tabela e as mesmas travas do Pix do caixa (cobrancas_cartao + gravar_venda_cartao), com cliente_app_id no
-- lugar do aparelho.
--
-- Para voltar atrás sem apagar nada:
--   update locais set contingencia_auto = false;          -- desliga a contingência em todas as lojas
--   select cron.unschedule('contingencia');                -- para o job
-- O histórico em "contingencias" fica guardado.

-- 1) opções do app por loja
alter table public.locais add column if not exists contingencia_auto boolean not null default false;
-- "aceita pagamento para clientes selecionados": a liberação individual só vale com esta opção ligada.
-- Fica ligada por padrão para não mudar o que já funciona hoje.
alter table public.locais add column if not exists app_selecionados boolean not null default true;

-- 2) histórico de contingências
create table if not exists public.contingencias (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id),
  local_id uuid not null references public.locais(id),
  inicio timestamptz not null,
  fim timestamptz,
  sem_sinal_desde timestamptz not null,
  criado_em timestamptz not null default now()
);
create unique index if not exists contingencias_uma_aberta on public.contingencias (local_id) where fim is null;
create index if not exists contingencias_empresa_idx on public.contingencias (empresa_id, inicio desc);
alter table public.contingencias enable row level security;
drop policy if exists contingencias_ler on public.contingencias;
create policy contingencias_ler on public.contingencias for select to authenticated
  using (app_acessa_local(empresa_id, local_id, '{dono,gerente}'::papel_membro[]));

-- 3) avalia a loja agora: abre ou fecha a contingência e diz se ela está valendo
create or replace function public.loja_contingencia(p_local uuid) returns boolean
language plpgsql security definer set search_path to 'public' as $$
declare
  v_emp uuid; v_auto boolean; v_ult timestamptz; v_on boolean; v_aberta uuid;
  v_lim constant interval := interval '90 seconds';
begin
  select empresa_id, (contingencia_auto and ativo) into v_emp, v_auto from locais where id = p_local and tipo = 'loja';
  if not found then return false; end if;
  -- caixas ativos que deram sinal nos últimos 7 dias (aparelho esquecido na gaveta não conta)
  select max(ultimo_sinal) into v_ult from dispositivos
   where local_id = p_local and ativo and ultimo_sinal > now() - interval '7 days';
  v_on := coalesce(v_auto, false) and v_ult is not null and v_ult < now() - v_lim;
  select id into v_aberta from contingencias where local_id = p_local and fim is null;
  if v_on and v_aberta is null then
    insert into contingencias (empresa_id, local_id, inicio, sem_sinal_desde) values (v_emp, p_local, v_ult + v_lim, v_ult)
    on conflict do nothing;
  elsif not v_on and v_aberta is not null then
    update contingencias set fim = now() where id = v_aberta and fim is null;
  end if;
  return v_on;
end $$;

-- 4) sinal do caixa: chamado direto pelo tablet (sem passar por função do servidor, para ser leve e barato).
-- Só aceita o token do aparelho (guardado como hash); devolve se a loja usa a contingência.
create or replace function public.caixa_sinal(p_token text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid; v_local uuid; v_auto boolean;
begin
  if p_token is null or length(p_token) < 40 or length(p_token) > 200 then return jsonb_build_object('ok', false); end if;
  update dispositivos set ultimo_sinal = now()
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') and ativo
   returning id, local_id into v_id, v_local;
  if v_id is null then return jsonb_build_object('ok', false); end if;
  perform loja_contingencia(v_local);
  select contingencia_auto into v_auto from locais where id = v_local;
  return jsonb_build_object('ok', true, 'contingencia', coalesce(v_auto, false));
end $$;

-- 5) o que o cliente pode fazer no app (regra única, usada pelo app e pelo Pix)
create or replace function public.app_perm(p_cliente uuid) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare c clientes_app; l locais; v_cont boolean; v_compra boolean;
begin
  select * into c from clientes_app where id = p_cliente and ativo;
  if not found then return null; end if;
  select * into l from locais where id = c.local_id and tipo = 'loja' and ativo;
  if not found then return null; end if;
  v_cont := loja_contingencia(l.id);
  v_compra := l.app_compra or (l.app_selecionados and c.compra_liberada) or v_cont;
  return jsonb_build_object('consulta', true, 'compra', v_compra, 'pendente', l.app_pendente or v_compra,
    'contingencia', v_cont, 'contingencia_auto', l.contingencia_auto);
end $$;

revoke all on function public.loja_contingencia(uuid) from public, anon, authenticated;
revoke all on function public.app_perm(uuid) from public, anon, authenticated;
revoke all on function public.caixa_sinal(text) from public;
grant execute on function public.loja_contingencia(uuid) to service_role;
grant execute on function public.app_perm(uuid) to service_role;
grant execute on function public.caixa_sinal(text) to anon, authenticated, service_role;

-- 6) Pix do app do cliente na mesma tabela de cobranças
alter table public.cobrancas_cartao alter column dispositivo_id drop not null;
alter table public.cobrancas_cartao add column if not exists cliente_app_id uuid references public.clientes_app(id);
alter table public.cobrancas_cartao add column if not exists contingencia boolean not null default false;
alter table public.cobrancas_cartao drop constraint if exists cobrancas_cartao_quem_check;
alter table public.cobrancas_cartao add constraint cobrancas_cartao_quem_check check (dispositivo_id is not null or cliente_app_id is not null);
create unique index if not exists cobrancas_cartao_uma_aberta_por_cliente on public.cobrancas_cartao (cliente_app_id)
  where cliente_app_id is not null and status in ('criando', 'aguardando', 'na_maquininha', 'verificar');
create index if not exists cobrancas_cartao_cliente_idx on public.cobrancas_cartao (cliente_app_id, criado_em desc) where cliente_app_id is not null;

alter table public.vendas add column if not exists contingencia boolean not null default false;

-- 7) grava a venda quando o Mercado Pago confirma: agora também do app do cliente e das vendas travadas
create or replace function public.gravar_venda_cartao(p_cobranca uuid, p_teste boolean default false)
returns text language plpgsql security definer set search_path to 'public' as $function$
declare c cobrancas_cartao; v vendas; it jsonb; v_custo int; v_agora timestamptz := now();
begin
  select * into c from cobrancas_cartao where id = p_cobranca for update;
  if not found then return 'nao_encontrada'; end if;
  if c.status <> 'aprovado' then return 'nao_aprovada'; end if;
  if c.venda_gravada then return 'ja_gravada'; end if;

  select * into v from vendas where id = c.venda_id for update;
  if found then
    -- venda travada (registrada pela loja para o cliente pagar no app): só muda para paga e baixa o estoque
    if c.cliente_app_id is not null and v.origem = 'pendente_app' and v.status = 'aberta' and v.cliente_app_id = c.cliente_app_id and v.total = c.valor then
      update vendas set status = 'paga', finalizada_em = v_agora, teste = p_teste, contingencia = c.contingencia where id = v.id;
      insert into estoque_mov (empresa_id, local_id, produto_id, tipo, quantidade, custo_unit, referencia, usuario_id)
      select v.empresa_id, v.local_id, produto_id, 'venda', -quantidade, custo_unit, v.id, null from venda_itens where venda_id = v.id;
      insert into pagamentos (venda_id, empresa_id, forma, valor, status, nsu, autorizacao, bandeira)
      values (v.id, c.empresa_id, c.forma::forma_pagamento, c.valor, 'aprovado', coalesce(c.nsu, c.mp_payment_id), c.autorizacao, c.bandeira);
      update cobrancas_cartao set venda_gravada = true, erro = null, atualizado_em = v_agora where id = c.id;
      return 'gravada';
    end if;
    if exists (select 1 from pagamentos where venda_id = c.venda_id and status = 'aprovado' and nsu = coalesce(c.nsu, c.mp_payment_id)) then
      update cobrancas_cartao set venda_gravada = true, erro = null, atualizado_em = v_agora where id = c.id;
      return 'ja_existia';
    end if;
    update cobrancas_cartao set venda_gravada = true, status_detail = 'pagamento_em_dobro',
      erro = 'Compra já paga por outro meio: estornar este pagamento no Mercado Pago', atualizado_em = v_agora where id = c.id;
    return 'duplicada';
  end if;

  insert into vendas (id, empresa_id, local_id, dispositivo_id, iniciada_em, finalizada_em, status, total, origem, teste, cliente_app_id, contingencia)
  values (c.venda_id, c.empresa_id, c.local_id, c.dispositivo_id, coalesce(c.iniciada_em, v_agora), v_agora, 'paga', c.valor,
          case when c.cliente_app_id is not null then 'app_cliente' else 'telefone' end, p_teste, c.cliente_app_id, c.contingencia);

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
end $function$;

-- 8) confere todas as lojas a cada minuto
select cron.unschedule(jobid) from cron.job where jobname = 'contingencia';
select cron.schedule('contingencia', '* * * * *', $$select public.loja_contingencia(id) from public.locais where tipo = 'loja'$$);
