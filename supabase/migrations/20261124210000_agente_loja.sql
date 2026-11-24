-- Agente "Configurar minha loja": importa produtos de XMLs de compra ou da planilha modelo,
-- organiza categorias e guarda cada importação como um lote que pode ser desfeito.
-- Só acrescenta coisas: nenhuma tabela ou dado existente é alterado por esta migration.
-- Para voltar atrás: drop function agente_desfazer, agente_aplicar; drop table agente_lotes;
--                    alter table empresas drop column agente;

alter table public.empresas add column if not exists agente jsonb not null default '{}'::jsonb;
comment on column public.empresas.agente is 'Preferências do agente (dicionário de categorias por palavra-chave).';

create table if not exists public.agente_lotes (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  criado_por uuid default auth.uid(),
  criado_em timestamptz not null default now(),
  origem text not null check (origem in ('xml', 'planilha', 'organizar')),
  resumo jsonb not null default '{}'::jsonb,
  produtos_criados uuid[] not null default '{}',
  categorias_criadas uuid[] not null default '{}',
  alteracoes jsonb not null default '[]'::jsonb,
  desfeito_em timestamptz,
  desfeito_por uuid,
  resultado_desfazer jsonb
);
create index if not exists agente_lotes_empresa on public.agente_lotes (empresa_id, criado_em desc);
alter table public.agente_lotes enable row level security;
drop policy if exists agente_lotes_ler on public.agente_lotes;
create policy agente_lotes_ler on public.agente_lotes for select
  using (app_eh_membro(empresa_id, '{dono,gerente}'::papel_membro[]));
-- gravação só pelas funções abaixo (sem policy de insert/update/delete)

-- devolve a categoria (ou subcategoria) com esse nome, criando se não existir
create or replace function public.agente_categoria(p_emp uuid, p_pai uuid, p_nome text, inout p_criadas uuid[], out p_id uuid)
language plpgsql security definer set search_path to 'public' as $$
declare v_nome text := left(btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g')), 60);
begin
  if v_nome = '' then p_id := null; return; end if;
  select id into p_id from categorias
   where empresa_id = p_emp and pai_id is not distinct from p_pai and lower(nome) = lower(v_nome) limit 1;
  if p_id is null then
    insert into categorias (empresa_id, pai_id, nome) values (p_emp, p_pai, v_nome) returning id into p_id;
    p_criadas := p_criadas || p_id;
  end if;
end $$;
revoke all on function public.agente_categoria(uuid, uuid, text, uuid[]) from public, anon, authenticated;

-- grava, de uma vez só, o que o cliente aprovou na revisão
-- p_novos: [{nome, ean, ncm, cest, unidade, custo, preco, categoria, subcategoria, grupo_fiscal_id,
--            fornecedor_cnpj, fornecedor_codigo, fator}]
-- p_organizar: [{produto_id, categoria, subcategoria}]
create or replace function public.agente_aplicar(p_empresa uuid, p_origem text, p_novos jsonb, p_organizar jsonb,
  p_lojas uuid[], p_resumo jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_lote uuid; v_it jsonb; v_prod uuid; v_cat uuid; v_sub uuid; v_criadas uuid[] := '{}'; v_prods uuid[] := '{}';
  v_alt jsonb := '[]'::jsonb; v_ean text; v_ncm text; v_cest text; v_un text; v_grupo uuid; v_preco int; v_custo int;
  v_loja record; v_pulados int := 0; v_ant record; v_org int := 0;
begin
  if not app_eh_membro(p_empresa, '{dono,gerente}'::papel_membro[]) then raise exception 'sem permissão'; end if;
  if p_origem not in ('xml', 'planilha', 'organizar') then raise exception 'origem inválida'; end if;
  if jsonb_typeof(coalesce(p_novos, '[]')) <> 'array' or jsonb_typeof(coalesce(p_organizar, '[]')) <> 'array' then
    raise exception 'dados inválidos'; end if;
  if jsonb_array_length(coalesce(p_novos, '[]')) + jsonb_array_length(coalesce(p_organizar, '[]')) = 0 then
    raise exception 'nada para gravar'; end if;
  if jsonb_array_length(coalesce(p_novos, '[]')) > 5000 then raise exception 'no máximo 5.000 produtos por vez'; end if;
  if exists (select 1 from unnest(coalesce(p_lojas, '{}')) l
             where not exists (select 1 from locais where id = l and empresa_id = p_empresa and tipo = 'loja')) then
    raise exception 'loja inválida'; end if;
  perform set_config('app.motivo_preco', 'agente', true);

  for v_it in select * from jsonb_array_elements(coalesce(p_novos, '[]')) loop
    if coalesce(btrim(v_it ->> 'nome'), '') = '' then raise exception 'produto sem nome'; end if;
    v_ean := nullif(regexp_replace(coalesce(v_it ->> 'ean', ''), '\D', '', 'g'), '');
    if v_ean is not null and v_ean !~ '^\d{8,14}$' then v_ean := null; end if;
    -- código de barras que já existe na empresa: não duplica, pula
    if v_ean is not null and (exists (select 1 from produtos where empresa_id = p_empresa and ean = v_ean)
                              or exists (select 1 from produto_codigos where empresa_id = p_empresa and ean = v_ean)) then
      v_pulados := v_pulados + 1; continue;
    end if;
    v_ncm := nullif(regexp_replace(coalesce(v_it ->> 'ncm', ''), '\D', '', 'g'), '');
    if v_ncm is not null and v_ncm !~ '^\d{8}$' then v_ncm := null; end if;
    v_cest := nullif(regexp_replace(coalesce(v_it ->> 'cest', ''), '\D', '', 'g'), '');
    if v_cest is not null and v_cest !~ '^\d{7}$' then v_cest := null; end if;
    v_un := upper(coalesce(nullif(v_it ->> 'unidade', ''), 'UN'));
    if v_un not in ('UN', 'KG', 'G', 'L', 'ML', 'CX', 'PCT', 'DZ', 'FD') then v_un := 'UN'; end if;
    v_grupo := nullif(v_it ->> 'grupo_fiscal_id', '')::uuid;
    if v_grupo is not null and not exists (select 1 from grupos_fiscais where id = v_grupo and empresa_id = p_empresa) then
      v_grupo := null; end if;
    v_custo := greatest(coalesce((v_it ->> 'custo')::int, 0), 0);
    v_preco := (v_it ->> 'preco')::int;

    select c.p_id, c.p_criadas into v_cat, v_criadas from agente_categoria(p_empresa, null, v_it ->> 'categoria', v_criadas) c;
    v_sub := null;
    if v_cat is not null then
      select c.p_id, c.p_criadas into v_sub, v_criadas from agente_categoria(p_empresa, v_cat, v_it ->> 'subcategoria', v_criadas) c;
    end if;

    insert into produtos (empresa_id, ean, nome, ncm, cest, unidade, custo, custo_medio, grupo_fiscal_id,
                          categoria_id, subcategoria_id, sem_codigo)
    values (p_empresa, v_ean, left(btrim(v_it ->> 'nome'), 120), v_ncm, v_cest, v_un, v_custo, v_custo, v_grupo,
            v_cat, v_sub, v_ean is null)
    returning id into v_prod;
    v_prods := v_prods || v_prod;

    if coalesce(v_it ->> 'fornecedor_cnpj', '') <> '' and coalesce(v_it ->> 'fornecedor_codigo', '') <> '' then
      insert into produto_codigos_fornecedor (produto_id, empresa_id, fornecedor_cnpj, codigo, fator)
      values (v_prod, p_empresa, regexp_replace(v_it ->> 'fornecedor_cnpj', '\D', '', 'g'), v_it ->> 'fornecedor_codigo',
              greatest(coalesce((v_it ->> 'fator')::numeric, 1), 0.001))
      on conflict (empresa_id, fornecedor_cnpj, codigo) do nothing;
    end if;

    if v_preco is not null and v_preco > 0 then
      for v_loja in select id, portfolio_id from locais where id = any (coalesce(p_lojas, '{}')) loop
        insert into precos_local (produto_id, local_id, empresa_id, preco, ativo_no_mix, estoque_min, estoque_max)
        values (v_prod, v_loja.id, p_empresa, v_preco, true, 2, 8)
        on conflict (produto_id, local_id) do nothing;
        -- entra também no portfólio da loja, para não sair do mix se o portfólio for reaplicado
        if v_loja.portfolio_id is not null then
          insert into portfolio_itens (portfolio_id, produto_id, empresa_id, estoque_min, estoque_max)
          values (v_loja.portfolio_id, v_prod, p_empresa, 2, 8) on conflict do nothing;
        end if;
      end loop;
    end if;
  end loop;

  for v_it in select * from jsonb_array_elements(coalesce(p_organizar, '[]')) loop
    select id, categoria_id, subcategoria_id into v_ant from produtos
     where id = (v_it ->> 'produto_id')::uuid and empresa_id = p_empresa;
    if not found then continue; end if;
    select c.p_id, c.p_criadas into v_cat, v_criadas from agente_categoria(p_empresa, null, v_it ->> 'categoria', v_criadas) c;
    if v_cat is null then continue; end if;
    select c.p_id, c.p_criadas into v_sub, v_criadas from agente_categoria(p_empresa, v_cat, v_it ->> 'subcategoria', v_criadas) c;
    if v_ant.categoria_id is not distinct from v_cat and v_ant.subcategoria_id is not distinct from v_sub then continue; end if;
    update produtos set categoria_id = v_cat, subcategoria_id = v_sub, atualizado_em = now() where id = v_ant.id;
    v_alt := v_alt || jsonb_build_object('id', v_ant.id, 'antes_c', v_ant.categoria_id, 'antes_s', v_ant.subcategoria_id,
                                         'depois_c', v_cat, 'depois_s', v_sub);
    v_org := v_org + 1;
  end loop;

  insert into agente_lotes (empresa_id, origem, resumo, produtos_criados, categorias_criadas, alteracoes)
  values (p_empresa, p_origem,
          coalesce(p_resumo, '{}'::jsonb) || jsonb_build_object('criados', cardinality(v_prods), 'pulados', v_pulados,
                                                                'organizados', v_org, 'lojas', to_jsonb(coalesce(p_lojas, '{}'))),
          v_prods, v_criadas, v_alt)
  returning id into v_lote;
  return jsonb_build_object('lote', v_lote, 'criados', cardinality(v_prods), 'pulados', v_pulados, 'organizados', v_org,
                            'categorias_novas', cardinality(v_criadas));
end $$;
revoke all on function public.agente_aplicar(uuid, text, jsonb, jsonb, uuid[], jsonb) from public, anon;
grant execute on function public.agente_aplicar(uuid, text, jsonb, jsonb, uuid[], jsonb) to authenticated;

-- desfaz um lote: apaga o que foi criado; o que já foi vendido ou movimentado fica só desativado
create or replace function public.agente_desfazer(p_lote uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_l agente_lotes%rowtype; v_id uuid; v_apag int := 0; v_desat int := 0; v_rest int := 0; v_a jsonb; v_cat int := 0;
begin
  select * into v_l from agente_lotes where id = p_lote for update;
  if not found then raise exception 'importação não encontrada'; end if;
  if not app_eh_membro(v_l.empresa_id, '{dono,gerente}'::papel_membro[]) then raise exception 'sem permissão'; end if;
  if v_l.desfeito_em is not null then raise exception 'esta importação já foi desfeita'; end if;

  foreach v_id in array v_l.produtos_criados loop
    if exists (select 1 from venda_itens where produto_id = v_id)
       or exists (select 1 from estoque_mov where produto_id = v_id)
       or exists (select 1 from notas_entrada_itens where produto_id = v_id) then
      update produtos set ativo = false, atualizado_em = now() where id = v_id and empresa_id = v_l.empresa_id;
      update precos_local set ativo_no_mix = false where produto_id = v_id and empresa_id = v_l.empresa_id;
      v_desat := v_desat + 1;
    else
      begin
        delete from portfolio_itens where produto_id = v_id and empresa_id = v_l.empresa_id;
        delete from produto_codigos_fornecedor where produto_id = v_id and empresa_id = v_l.empresa_id;
        delete from produto_codigos where produto_id = v_id and empresa_id = v_l.empresa_id;
        delete from precos_local where produto_id = v_id and empresa_id = v_l.empresa_id;
        delete from produtos where id = v_id and empresa_id = v_l.empresa_id;
        v_apag := v_apag + 1;
      exception when others then
        update produtos set ativo = false, atualizado_em = now() where id = v_id and empresa_id = v_l.empresa_id;
        update precos_local set ativo_no_mix = false where produto_id = v_id and empresa_id = v_l.empresa_id;
        v_desat := v_desat + 1;
      end;
    end if;
  end loop;

  -- categorias: volta ao que era, só se ninguém mexeu depois
  for v_a in select * from jsonb_array_elements(v_l.alteracoes) loop
    update produtos set categoria_id = nullif(v_a ->> 'antes_c', '')::uuid, subcategoria_id = nullif(v_a ->> 'antes_s', '')::uuid,
                        atualizado_em = now()
     where id = (v_a ->> 'id')::uuid and empresa_id = v_l.empresa_id
       and categoria_id is not distinct from nullif(v_a ->> 'depois_c', '')::uuid
       and subcategoria_id is not distinct from nullif(v_a ->> 'depois_s', '')::uuid;
    if found then v_rest := v_rest + 1; end if;
  end loop;

  -- categorias criadas pelo lote e que ficaram vazias (subcategorias primeiro)
  for v_id in select c.id from categorias c where c.id = any (v_l.categorias_criadas) order by (c.pai_id is null) loop
    begin
      if not exists (select 1 from produtos where categoria_id = v_id or subcategoria_id = v_id)
         and not exists (select 1 from categorias where pai_id = v_id) then
        delete from categorias where id = v_id; v_cat := v_cat + 1;
      end if;
    exception when others then null;
    end;
  end loop;

  update agente_lotes set desfeito_em = now(), desfeito_por = auth.uid(),
         resultado_desfazer = jsonb_build_object('apagados', v_apag, 'desativados', v_desat, 'restaurados', v_rest, 'categorias', v_cat)
   where id = p_lote;
  return jsonb_build_object('apagados', v_apag, 'desativados', v_desat, 'restaurados', v_rest, 'categorias', v_cat);
end $$;
revoke all on function public.agente_desfazer(uuid) from public, anon;
grant execute on function public.agente_desfazer(uuid) to authenticated;
