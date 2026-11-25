-- Financeiro (etapa 1): resumo de vendas, taxas, custo e compras por dia e por loja.
-- Só ACRESCENTA coisas (uma coluna, dois índices e uma função de leitura). Não altera nem apaga dados.
-- Para voltar atrás:
--   drop function if exists public.financeiro_resumo(uuid, timestamptz, timestamptz, boolean, text);
--   alter table public.empresas drop column if exists financeiro;

-- 1) Taxas da maquininha/Pix que o dono informa no Painel (em %), usadas para estimar o valor líquido.
alter table public.empresas add column if not exists financeiro jsonb not null default '{}'::jsonb;

-- 2) Índices para o resumo não pesar quando houver muitas lojas.
create index if not exists vendas_empresa_finalizada_idx on public.vendas (empresa_id, finalizada_em);
create index if not exists pagamentos_venda_idx on public.pagamentos (venda_id);
create index if not exists notas_entrada_empresa_lancada_idx on public.notas_entrada (empresa_id, lancada_em);

-- 3) Resumo agregado no servidor. SECURITY INVOKER: valem as mesmas regras de acesso (RLS) das telas,
--    então o gerente só enxerga as lojas a que tem acesso.
create or replace function public.financeiro_resumo(
  p_empresa uuid, p_ini timestamptz, p_fim timestamptz, p_teste boolean default false, p_tz text default 'America/Fortaleza')
returns jsonb
language plpgsql stable security invoker set search_path = public
as $$
declare r jsonb;
begin
  if not app_eh_membro(p_empresa, '{dono,gerente}') then raise exception 'sem acesso'; end if;
  if p_fim <= p_ini or p_fim - p_ini > interval '400 days' then raise exception 'período inválido'; end if;

  with v as (
    select id, local_id, status, total, (coalesce(finalizada_em, iniciada_em) at time zone p_tz)::date as dia
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
    select v.dia, v.local_id,
           count(*) filter (where v.status = 'paga') as vendas,
           coalesce(sum(v.total) filter (where v.status = 'paga'), 0)::bigint as bruto,
           coalesce(sum(it.cmv), 0)::bigint as cmv,
           coalesce(sum(it.qtd), 0) as itens,
           coalesce(sum(it.sem_custo), 0)::bigint as sem_custo
    from v left join itens it on it.id = v.id group by v.dia, v.local_id
  ),
  fp as (
    select v.dia, v.local_id, p.forma::text as forma,
           count(*) filter (where p.status = 'aprovado' and v.status = 'paga') as n,
           coalesce(sum(p.valor) filter (where p.status = 'aprovado' and v.status = 'paga'), 0)::bigint as valor,
           count(*) filter (where p.status = 'estornado') as n_estorno,
           coalesce(sum(p.valor) filter (where p.status = 'estornado'), 0)::bigint as estornado
    from v join pagamentos p on p.venda_id = v.id
    group by v.dia, v.local_id, p.forma
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
    'compras', coalesce((select jsonb_agg(to_jsonb(cp) order by dia) from cp), '[]'::jsonb)
  ) into r;
  return r;
end $$;

revoke all on function public.financeiro_resumo(uuid, timestamptz, timestamptz, boolean, text) from public, anon;
grant execute on function public.financeiro_resumo(uuid, timestamptz, timestamptz, boolean, text) to authenticated;
