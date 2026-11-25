-- Financeiro v2: o resumo passa a trazer também vendas por hora/dia da semana e, quando pedido,
-- o resultado por produto (para a curva ABC). Só leitura; não altera nem apaga dados.
-- É uma função NOVA (financeiro_painel); a financeiro_resumo continua existindo, sem uso.
-- Para voltar atrás: drop function if exists public.financeiro_painel(uuid, timestamptz, timestamptz, boolean, text, boolean);

create or replace function public.financeiro_painel(
  p_empresa uuid, p_ini timestamptz, p_fim timestamptz, p_teste boolean default false,
  p_tz text default 'America/Fortaleza', p_detalhe boolean default false)
returns jsonb
language plpgsql stable security invoker set search_path = public
as $$
declare r jsonb;
begin
  if not app_eh_membro(p_empresa, '{dono,gerente}') then raise exception 'sem acesso'; end if;
  if p_fim <= p_ini or p_fim - p_ini > interval '400 days' then raise exception 'período inválido'; end if;

  with v as (
    select id, local_id, status, total, coalesce(finalizada_em, iniciada_em) at time zone p_tz as quando
    from vendas
    where empresa_id = p_empresa and coalesce(finalizada_em, iniciada_em) >= p_ini and coalesce(finalizada_em, iniciada_em) < p_fim
      and status in ('paga', 'cancelada') and (p_teste or not teste)
  ),
  itens as (
    select v.id, sum(i.quantidade) as qtd,
           sum(round(i.quantidade * coalesce(i.custo_unit, 0)))::bigint as cmv,
           count(*) filter (where i.custo_unit is null or i.custo_unit = 0) as sem_custo
    from v join venda_itens i on i.venda_id = v.id where v.status = 'paga' group by v.id
  ),
  dl as (
    select v.quando::date as dia, v.local_id,
           count(*) filter (where v.status = 'paga') as vendas,
           coalesce(sum(v.total) filter (where v.status = 'paga'), 0)::bigint as bruto,
           coalesce(sum(it.cmv), 0)::bigint as cmv,
           coalesce(sum(it.qtd), 0) as itens,
           coalesce(sum(it.sem_custo), 0)::bigint as sem_custo
    from v left join itens it on it.id = v.id group by 1, 2
  ),
  fp as (
    select v.quando::date as dia, v.local_id, p.forma::text as forma,
           count(*) filter (where p.status = 'aprovado' and v.status = 'paga') as n,
           coalesce(sum(p.valor) filter (where p.status = 'aprovado' and v.status = 'paga'), 0)::bigint as valor,
           count(*) filter (where p.status = 'estornado') as n_estorno,
           coalesce(sum(p.valor) filter (where p.status = 'estornado'), 0)::bigint as estornado
    from v join pagamentos p on p.venda_id = v.id
    group by 1, 2, 3
  ),
  hr as (
    select v.local_id, extract(dow from v.quando)::int as dow, extract(hour from v.quando)::int as hora,
           count(*) as vendas, sum(v.total)::bigint as bruto
    from v where v.status = 'paga' group by 1, 2, 3
  ),
  pr as (
    select v.local_id, i.produto_id, sum(i.quantidade) as qtd,
           sum(round(i.quantidade * i.preco_unit))::bigint as bruto,
           sum(round(i.quantidade * coalesce(i.custo_unit, 0)))::bigint as cmv
    from v join venda_itens i on i.venda_id = v.id
    where p_detalhe and v.status = 'paga' group by 1, 2
  ),
  cp as (
    select (n.lancada_em at time zone p_tz)::date as dia, n.local_destino_id as local_id,
           count(*) as notas, coalesce(sum(n.valor_total), 0)::bigint as valor
    from notas_entrada n
    where n.empresa_id = p_empresa and n.status = 'lancada' and n.lancada_em >= p_ini and n.lancada_em < p_fim
    group by 1, 2
  )
  select jsonb_build_object(
    'dias', coalesce((select jsonb_agg(to_jsonb(dl) order by dia) from dl), '[]'::jsonb),
    'formas', coalesce((select jsonb_agg(to_jsonb(fp) order by dia) from fp), '[]'::jsonb),
    'horas', coalesce((select jsonb_agg(to_jsonb(hr)) from hr), '[]'::jsonb),
    'produtos', coalesce((select jsonb_agg(to_jsonb(pr)) from pr), '[]'::jsonb),
    'compras', coalesce((select jsonb_agg(to_jsonb(cp) order by dia) from cp), '[]'::jsonb)
  ) into r;
  return r;
end $$;

revoke all on function public.financeiro_painel(uuid, timestamptz, timestamptz, boolean, text, boolean) from public, anon;
grant execute on function public.financeiro_painel(uuid, timestamptz, timestamptz, boolean, text, boolean) to authenticated;
