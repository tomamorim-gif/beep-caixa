-- Inteligência do negócio, etapa 1 (estoque e reposição).
-- Tudo aqui é ADITIVO: uma coluna nova, uma tabela nova (histórico importado) e funções novas.
-- Nada é alterado nem apagado nas vendas, no estoque ou nos produtos.
-- As contas (ritmo, previsão, sugestões) ficam no Painel; o banco só entrega os números já somados.
--
-- Para voltar atrás:
--   drop function if exists public.inteligencia_base(uuid, boolean, text);
--   drop function if exists public.inteligencia_importar_historico(uuid, jsonb, text);
--   drop table if exists public.vendas_historico;
--   alter table public.empresas drop column if exists inteligencia;

-- Ajustes da inteligência por empresa: prazos, dias de segurança, produtos "não pode faltar" marcados à mão.
alter table public.empresas add column if not exists inteligencia jsonb;

-- Histórico de vendas trazido de outro sistema (ex.: SAC Varejo), um registro por loja, produto e dia.
-- Serve só para a inteligência aprender; não entra no financeiro nem nas notas fiscais.
create table if not exists public.vendas_historico (
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  local_id uuid not null references public.locais(id) on delete cascade,
  produto_id uuid not null references public.produtos(id) on delete cascade,
  dia date not null,
  quantidade numeric not null check (quantidade >= 0),
  valor bigint not null default 0,   -- centavos
  origem text not null default 'importado',
  importado_em timestamptz not null default now(),
  primary key (empresa_id, local_id, produto_id, dia, origem)
);
create index if not exists vendas_historico_dia on public.vendas_historico (empresa_id, dia);
alter table public.vendas_historico enable row level security;
create policy vh_sel on public.vendas_historico for select to authenticated
  using (app_eh_membro(empresa_id, '{dono,gerente}'));
-- sem policy de insert/update/delete: só a função abaixo grava.

create or replace function public.inteligencia_importar_historico(p_empresa uuid, p_linhas jsonb, p_origem text default 'importado')
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare n int;
begin
  if not app_eh_membro(p_empresa, '{dono,gerente}') then raise exception 'sem acesso'; end if;
  if jsonb_typeof(p_linhas) <> 'array' or jsonb_array_length(p_linhas) > 20000 then raise exception 'lote inválido'; end if;
  insert into vendas_historico (empresa_id, local_id, produto_id, dia, quantidade, valor, origem)
  select p_empresa, l.id, p.id, (x->>'dia')::date, greatest((x->>'quantidade')::numeric, 0),
         coalesce((x->>'valor')::bigint, 0), left(coalesce(p_origem, 'importado'), 40)
  from jsonb_array_elements(p_linhas) x
  join locais l on l.id = (x->>'local_id')::uuid and l.empresa_id = p_empresa
  join produtos p on p.id = (x->>'produto_id')::uuid and p.empresa_id = p_empresa
  on conflict (empresa_id, local_id, produto_id, dia, origem)
  do update set quantidade = excluded.quantidade, valor = excluded.valor, importado_em = now();
  get diagnostics n = row_count;
  return jsonb_build_object('gravados', n);
end $$;
revoke all on function public.inteligencia_importar_historico(uuid, jsonb, text) from public, anon;
grant execute on function public.inteligencia_importar_historico(uuid, jsonb, text) to authenticated;

-- Números que a inteligência usa, já somados por loja e produto (últimos 90 dias).
create or replace function public.inteligencia_base(p_empresa uuid, p_teste boolean default false, p_tz text default 'America/Fortaleza')
returns jsonb
language plpgsql stable security invoker set search_path = public
as $$
declare r jsonb; hoje date := (now() at time zone p_tz)::date;
begin
  if not app_eh_membro(p_empresa, '{dono,gerente}') then raise exception 'sem acesso'; end if;

  with v as (
    select id, local_id, (coalesce(finalizada_em, iniciada_em) at time zone p_tz)::date as dia
    from vendas
    where empresa_id = p_empresa and status = 'paga' and (p_teste or not teste)
      and coalesce(finalizada_em, iniciada_em) >= now() - interval '91 days'
  ),
  -- vendas do PagNow e histórico importado, por loja/produto/dia (o PagNow vale mais quando os dois existem no mesmo dia)
  pdv as (
    select v.local_id, i.produto_id, v.dia, sum(i.quantidade) as qtd,
           sum(round(i.quantidade * i.preco_unit))::bigint as bruto,
           sum(round(i.quantidade * coalesce(i.custo_unit, 0)))::bigint as cmv,
           count(distinct v.id) as tickets
    from v join venda_itens i on i.venda_id = v.id group by 1, 2, 3
  ),
  imp as (
    select h.local_id, h.produto_id, h.dia, sum(h.quantidade) as qtd, sum(h.valor)::bigint as bruto, 0::bigint as cmv, 0::bigint as tickets
    from vendas_historico h
    where h.empresa_id = p_empresa and h.dia > hoje - 91 and h.dia <= hoje
      and not exists (select 1 from pdv where pdv.local_id = h.local_id and pdv.produto_id = h.produto_id and pdv.dia = h.dia)
    group by 1, 2, 3
  ),
  d as (select * from pdv union all select * from imp),
  pr as (
    select local_id, produto_id,
           sum(qtd) filter (where dia > hoje - 7) as q7,
           sum(qtd) filter (where dia > hoje - 28) as q28,
           sum(qtd) as q90,
           sum(bruto) as bruto90, sum(cmv) as cmv90, sum(tickets) as tickets90,
           count(distinct dia) as dias_com_venda, max(dia) as ultima
    from d group by 1, 2
  ),
  lj as (
    select local_id, min(dia) as primeira, count(distinct dia) as dias_com_venda,
           (select count(*) from v where v.local_id = d.local_id) as tickets90
    from d group by 1
  ),
  dw as (
    select local_id, extract(dow from dia)::int as dow, sum(qtd) as qtd, count(distinct dia) as dias
    from d group by 1, 2
  ),
  sd as (
    select local_id, produto_id, saldo, ultima_mov from saldos_estoque
    where empresa_id = p_empresa and saldo <> 0
  ),
  cu as (
    select distinct on (i.produto_id) i.produto_id, i.custo_unit::bigint as custo,
           n.fornecedor_nome as fornecedor, (n.lancada_em at time zone p_tz)::date as dia
    from notas_entrada_itens i join notas_entrada n on n.id = i.nota_id
    where i.empresa_id = p_empresa and n.status = 'lancada' and i.produto_id is not null and i.custo_unit > 0
    order by i.produto_id, n.lancada_em desc
  )
  select jsonb_build_object(
    'hoje', hoje,
    'produtos', coalesce((select jsonb_agg(to_jsonb(pr)) from pr), '[]'::jsonb),
    'lojas', coalesce((select jsonb_agg(jsonb_build_object('local_id', local_id, 'primeira', primeira, 'dias_com_venda', dias_com_venda, 'tickets90', tickets90)) from lj), '[]'::jsonb),
    'semana', coalesce((select jsonb_agg(to_jsonb(dw)) from dw), '[]'::jsonb),
    'saldos', coalesce((select jsonb_agg(to_jsonb(sd)) from sd), '[]'::jsonb),
    'custos', coalesce((select jsonb_agg(to_jsonb(cu)) from cu), '[]'::jsonb)
  ) into r;
  return r;
end $$;
revoke all on function public.inteligencia_base(uuid, boolean, text) from public, anon;
grant execute on function public.inteligencia_base(uuid, boolean, text) to authenticated;
