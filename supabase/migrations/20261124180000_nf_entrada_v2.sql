-- Entrada de NF-e de compra, versão 2.
-- O que muda:
--  1. Cada item lançado fica guardado em notas_entrada_itens (histórico, custo anterior,
--     NCM e grupo fiscal anteriores: dá para conferir e voltar atrás produto a produto).
--  2. A nota pode corrigir o fiscal do cadastro (NCM, CEST e grupo Com ST / Sem ST),
--     só nos itens que o usuário aprovou na conferência.
--  3. Custo médio ponderado pelo saldo da empresa.
--  4. Produto novo entra no mix só das lojas escolhidas, com mínimo/máximo padrão,
--     sem reaplicar portfólio (o painel não chama mais aplicar_portfolio ao lançar).
-- Como voltar atrás: reaplicar a versão anterior de lancar_nota_entrada (está no
-- histórico do Supabase) e apagar a tabela notas_entrada_itens. Nenhum dado existente é alterado.

create table if not exists public.notas_entrada_itens (
  id uuid primary key default gen_random_uuid(),
  nota_id uuid not null references public.notas_entrada(id) on delete restrict,
  empresa_id uuid not null,
  n_item int not null,
  produto_id uuid not null references public.produtos(id),
  produto_novo boolean not null default false,
  fornecedor_codigo text,
  descricao text,
  ean text,
  quantidade numeric not null check (quantidade > 0),
  fator numeric not null default 1,
  custo_unit int not null check (custo_unit >= 0),
  custo_anterior int,
  ncm_nota text,
  cest_nota text,
  cfop_nota text,
  icms_cst_nota text,
  st_na_nota boolean,
  ncm_anterior text,
  grupo_anterior uuid,
  fiscal_aplicado boolean not null default false,
  criado_em timestamptz not null default now(),
  unique (nota_id, n_item)
);
create index if not exists nei_produto on public.notas_entrada_itens (produto_id);
create index if not exists nei_empresa on public.notas_entrada_itens (empresa_id, criado_em desc);

alter table public.notas_entrada_itens enable row level security;
drop policy if exists nei_ler on public.notas_entrada_itens;
create policy nei_ler on public.notas_entrada_itens for select
  using (app_eh_membro(empresa_id, '{dono,gerente}'::papel_membro[]));
-- sem policy de escrita: só a função abaixo grava (security definer, com checagem de papel)
revoke insert, update, delete on public.notas_entrada_itens from anon, authenticated;

drop function if exists public.lancar_nota_entrada(uuid, jsonb);
create function public.lancar_nota_entrada(p_nota uuid, p_itens jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_nota notas_entrada%rowtype; v_item jsonb; v_prod uuid; v_loja uuid; v_novo boolean;
  v_q numeric; v_custo int; v_ant_custo int; v_ant_medio int; v_ant_ncm text; v_ant_grupo uuid; v_saldo numeric; v_medio int;
  v_ncm text; v_cest text; v_grupo uuid; v_fiscal boolean; v_n int := 0; v_fisc int := 0; v_novos int := 0;
begin
  select * into v_nota from notas_entrada where id = p_nota for update;
  if not found then raise exception 'nota não encontrada'; end if;
  if not app_eh_membro(v_nota.empresa_id, '{dono,gerente}') then raise exception 'sem permissão'; end if;
  if v_nota.status <> 'conferencia' then raise exception 'nota já lançada ou descartada'; end if;
  if v_nota.local_destino_id is null then raise exception 'escolha o local de destino (CD ou loja)'; end if;
  if not exists (select 1 from locais where id = v_nota.local_destino_id and empresa_id = v_nota.empresa_id) then
    raise exception 'local de destino inválido'; end if;
  if jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 then raise exception 'nota sem itens'; end if;
  perform set_config('app.motivo_preco', 'nf_entrada', true);

  for v_item in select * from jsonb_array_elements(p_itens) loop
    v_q := (v_item ->> 'quantidade')::numeric;
    v_custo := (v_item ->> 'custo_unit')::int;
    if v_q is null or v_q <= 0 then raise exception 'quantidade inválida no item %', v_item ->> 'n_item'; end if;
    if v_custo is null or v_custo < 0 then raise exception 'custo inválido no item %', v_item ->> 'n_item'; end if;

    -- fiscal aprovado na conferência (opcional)
    v_fiscal := coalesce((v_item #>> '{fiscal,aplicar}')::boolean, false);
    v_ncm := nullif(regexp_replace(coalesce(v_item #>> '{fiscal,ncm}', ''), '\D', '', 'g'), '');
    v_cest := nullif(regexp_replace(coalesce(v_item #>> '{fiscal,cest}', ''), '\D', '', 'g'), '');
    v_grupo := nullif(v_item #>> '{fiscal,grupo_fiscal_id}', '')::uuid;
    if v_ncm is not null and v_ncm !~ '^\d{8}$' then raise exception 'NCM inválido no item %', v_item ->> 'n_item'; end if;
    if v_cest is not null and v_cest !~ '^\d{7}$' then v_cest := null; end if;
    if v_grupo is not null and not exists (select 1 from grupos_fiscais where id = v_grupo and empresa_id = v_nota.empresa_id) then
      raise exception 'grupo fiscal inválido no item %', v_item ->> 'n_item'; end if;

    v_prod := nullif(v_item ->> 'produto_id', '')::uuid;
    v_novo := v_prod is null;
    if v_novo then
      if coalesce(trim(v_item #>> '{novo,nome}'), '') = '' then raise exception 'produto novo sem nome no item %', v_item ->> 'n_item'; end if;
      insert into produtos (empresa_id, ean, nome, ncm, cest, unidade, custo, custo_medio, grupo_fiscal_id)
      values (v_nota.empresa_id, nullif(v_item #>> '{novo,ean}', ''), left(trim(v_item #>> '{novo,nome}'), 120),
              coalesce(v_ncm, nullif(v_item #>> '{novo,ncm}', '')), coalesce(v_cest, nullif(v_item #>> '{novo,cest}', '')),
              coalesce(nullif(v_item #>> '{novo,unidade}', ''), 'UN'), v_custo, v_custo, v_grupo)
      returning id into v_prod;
      v_ant_custo := null; v_ant_ncm := null; v_ant_grupo := null; v_novos := v_novos + 1;
    else
      select custo, custo_medio, ncm, grupo_fiscal_id into v_ant_custo, v_ant_medio, v_ant_ncm, v_ant_grupo
        from produtos where id = v_prod and empresa_id = v_nota.empresa_id for update;
      if not found then raise exception 'produto % não pertence à empresa', v_prod; end if;
      select coalesce(sum(saldo), 0) into v_saldo from saldos_estoque where produto_id = v_prod and empresa_id = v_nota.empresa_id;
      if v_saldo <= 0 or v_ant_medio is null or v_ant_medio <= 0 then v_medio := v_custo;
      else v_medio := round((v_saldo * v_ant_medio + v_q * v_custo) / (v_saldo + v_q)); end if;
      update produtos set custo = v_custo, custo_medio = v_medio,
        ncm = case when v_fiscal and v_ncm is not null then v_ncm else ncm end,
        cest = case when v_fiscal and v_ncm is not null then coalesce(v_cest, cest) else cest end,
        grupo_fiscal_id = case when v_fiscal and v_grupo is not null then v_grupo else grupo_fiscal_id end,
        atualizado_em = now()
      where id = v_prod;
    end if;
    if v_fiscal then v_fisc := v_fisc + 1; end if;

    if coalesce(v_item ->> 'fornecedor_codigo', '') <> '' then
      insert into produto_codigos_fornecedor (produto_id, empresa_id, fornecedor_cnpj, codigo, fator)
      values (v_prod, v_nota.empresa_id, v_nota.fornecedor_cnpj, v_item ->> 'fornecedor_codigo', coalesce((v_item ->> 'fator')::numeric, 1))
      on conflict (empresa_id, fornecedor_cnpj, codigo) do update set produto_id = excluded.produto_id, fator = excluded.fator;
    end if;

    -- preço: produto novo entra no mix das lojas escolhidas; existente só muda se veio preço aprovado
    if (v_item ->> 'preco_aprovado') is not null then
      if (v_item ->> 'preco_aprovado')::int <= 0 then raise exception 'preço inválido no item %', v_item ->> 'n_item'; end if;
      for v_loja in select l.id from locais l where l.empresa_id = v_nota.empresa_id and l.tipo = 'loja' and l.ativo
          and (v_item -> 'lojas_preco' is null or jsonb_typeof(v_item -> 'lojas_preco') = 'null'
               or l.id::text in (select jsonb_array_elements_text(v_item -> 'lojas_preco')))
      loop
        if v_novo then
          insert into precos_local (produto_id, local_id, empresa_id, preco, ativo_no_mix, estoque_min, estoque_max)
          values (v_prod, v_loja, v_nota.empresa_id, (v_item ->> 'preco_aprovado')::int, true,
                  coalesce((v_item ->> 'estoque_min')::numeric, 2), coalesce((v_item ->> 'estoque_max')::numeric, 8))
          on conflict (produto_id, local_id) do update set preco = excluded.preco;
        else
          update precos_local set preco = (v_item ->> 'preco_aprovado')::int where produto_id = v_prod and local_id = v_loja;
        end if;
      end loop;
    end if;

    insert into estoque_mov (empresa_id, local_id, produto_id, tipo, quantidade, custo_unit, lote, validade, referencia)
    values (v_nota.empresa_id, v_nota.local_destino_id, v_prod, 'entrada_nf', v_q, v_custo,
            nullif(v_item ->> 'lote', ''), nullif(v_item ->> 'validade', '')::date, p_nota);

    insert into notas_entrada_itens (nota_id, empresa_id, n_item, produto_id, produto_novo, fornecedor_codigo, descricao, ean,
      quantidade, fator, custo_unit, custo_anterior, ncm_nota, cest_nota, cfop_nota, icms_cst_nota, st_na_nota,
      ncm_anterior, grupo_anterior, fiscal_aplicado)
    values (p_nota, v_nota.empresa_id, coalesce((v_item ->> 'n_item')::int, v_n + 1), v_prod, v_novo,
      v_item ->> 'fornecedor_codigo', left(v_item ->> 'descricao', 200), nullif(v_item ->> 'ean', ''),
      v_q, coalesce((v_item ->> 'fator')::numeric, 1), v_custo, v_ant_custo,
      nullif(v_item #>> '{nota,ncm}', ''), nullif(v_item #>> '{nota,cest}', ''), nullif(v_item #>> '{nota,cfop}', ''),
      nullif(v_item #>> '{nota,icms_cst}', ''), (v_item #>> '{nota,st}')::boolean,
      v_ant_ncm, v_ant_grupo, v_fiscal);
    v_n := v_n + 1;
  end loop;

  update notas_entrada set status = 'lancada', lancada_por = auth.uid(), lancada_em = now() where id = p_nota;
  return jsonb_build_object('itens', v_n, 'novos', v_novos, 'fiscal', v_fisc);
end $function$;

revoke all on function public.lancar_nota_entrada(uuid, jsonb) from public, anon;
grant execute on function public.lancar_nota_entrada(uuid, jsonb) to authenticated;
