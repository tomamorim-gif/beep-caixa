-- Abastecimento, etapa 1: mínimo e máximo de cada produto em cada loja.
-- O que muda:
--   1. precos_local ganha "minmax_ajustado": marca o produto cujo mínimo/máximo foi ajustado só naquela loja.
--   2. salvar_minmax(): grava de uma vez as alterações feitas no painel (só dono ou gerente da loja).
--   3. aplicar_portfolio(): ao reaplicar um portfólio, mantém o que foi ajustado na loja.
-- Como voltar atrás: ver o final deste arquivo.

alter table public.precos_local add column if not exists minmax_ajustado boolean not null default false;

create or replace function public.salvar_minmax(p_local uuid, p_itens jsonb)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare
  v_emp uuid; v_pf uuid; it jsonb; v_prod uuid; v_min numeric; v_max numeric;
  v_ajustados int := 0; v_padrao int := 0; v_n int;
begin
  select empresa_id, portfolio_id into v_emp, v_pf from locais where id = p_local and tipo = 'loja';
  if v_emp is null then raise exception 'loja não encontrada'; end if;
  if not app_acessa_local(v_emp, p_local, '{dono,gerente}'::papel_membro[]) then raise exception 'sem permissão'; end if;
  if jsonb_typeof(p_itens) is distinct from 'array' or jsonb_array_length(p_itens) > 5000 then raise exception 'lista inválida'; end if;

  for it in select value from jsonb_array_elements(p_itens) loop
    v_prod := (it->>'produto_id')::uuid;
    if coalesce((it->>'padrao')::boolean, false) then
      -- volta ao padrão do portfólio da loja
      update precos_local pl
         set estoque_min = coalesce((select i.estoque_min from portfolio_itens i where i.portfolio_id = v_pf and i.produto_id = v_prod), pl.estoque_min),
             estoque_max = coalesce((select i.estoque_max from portfolio_itens i where i.portfolio_id = v_pf and i.produto_id = v_prod), pl.estoque_max),
             minmax_ajustado = false
       where pl.local_id = p_local and pl.empresa_id = v_emp and pl.produto_id = v_prod;
      get diagnostics v_n = row_count; v_padrao := v_padrao + v_n;
    else
      v_min := (it->>'min')::numeric; v_max := (it->>'max')::numeric;
      if v_min is null or v_max is null or v_min < 0 or v_max < v_min or v_max > 100000
         or v_min <> trunc(v_min) or v_max <> trunc(v_max) then
        raise exception 'mínimo e máximo inválidos (o máximo precisa ser maior ou igual ao mínimo)';
      end if;
      update precos_local
         set estoque_min = v_min, estoque_max = v_max, minmax_ajustado = true
       where local_id = p_local and empresa_id = v_emp and produto_id = v_prod;
      get diagnostics v_n = row_count; v_ajustados := v_ajustados + v_n;
    end if;
  end loop;
  return jsonb_build_object('ajustados', v_ajustados, 'padrao', v_padrao);
end $function$;

revoke all on function public.salvar_minmax(uuid, jsonb) from public, anon;
grant execute on function public.salvar_minmax(uuid, jsonb) to authenticated;

create or replace function public.aplicar_portfolio(p_local uuid, p_portfolio uuid)
returns jsonb
language plpgsql
set search_path to 'public'
as $function$
declare v_emp uuid; v_entram int; v_saem int; v_sem_preco int;
begin
  select empresa_id into v_emp from locais where id = p_local and tipo = 'loja';
  if v_emp is null then raise exception 'loja não encontrada'; end if;
  if not app_acessa_local(v_emp, p_local, '{dono,gerente}'::papel_membro[]) then raise exception 'sem permissão'; end if;
  if not exists (select 1 from portfolios where id = p_portfolio and empresa_id = v_emp) then raise exception 'portfólio não encontrado'; end if;

  -- produtos do portfólio entram no mix; o mínimo/máximo ajustado na loja é mantido
  insert into precos_local (produto_id, local_id, empresa_id, preco, ativo_no_mix, estoque_min, estoque_max)
  select i.produto_id, p_local, v_emp, pr.preco, true, i.estoque_min, i.estoque_max
  from portfolio_itens i
  cross join lateral (select max(pl.preco) preco from precos_local pl where pl.produto_id = i.produto_id and pl.empresa_id = v_emp) pr
  where i.portfolio_id = p_portfolio and pr.preco is not null
  on conflict (produto_id, local_id) do update set
    ativo_no_mix = true,
    estoque_min = case when precos_local.minmax_ajustado and precos_local.ativo_no_mix then precos_local.estoque_min else excluded.estoque_min end,
    estoque_max = case when precos_local.minmax_ajustado and precos_local.ativo_no_mix then precos_local.estoque_max else excluded.estoque_max end,
    minmax_ajustado = precos_local.minmax_ajustado and precos_local.ativo_no_mix;
  get diagnostics v_entram = row_count;

  select count(*) into v_sem_preco from portfolio_itens i
  where i.portfolio_id = p_portfolio and not exists (select 1 from precos_local pl where pl.produto_id = i.produto_id and pl.empresa_id = v_emp);

  update precos_local pl set ativo_no_mix = false, estoque_min = 0, estoque_max = 0, minmax_ajustado = false
  where pl.local_id = p_local and pl.ativo_no_mix
    and not exists (select 1 from portfolio_itens i where i.portfolio_id = p_portfolio and i.produto_id = pl.produto_id);
  get diagnostics v_saem = row_count;

  update locais set portfolio_id = p_portfolio where id = p_local;
  return jsonb_build_object('no_mix', v_entram, 'sairam', v_saem, 'sem_preco', v_sem_preco);
end $function$;

-- Como voltar atrás (nenhum dado de venda ou estoque é afetado):
--   drop function if exists public.salvar_minmax(uuid, jsonb);
--   alter table public.precos_local drop column if exists minmax_ajustado;
--   e recriar aplicar_portfolio sem as linhas "minmax_ajustado" (versão anterior: sobrescrevia sempre).
