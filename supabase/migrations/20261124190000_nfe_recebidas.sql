-- Notas de compra emitidas contra o CNPJ da empresa, lidas sozinhas da SEFAZ (função nfe-entrada).
-- Como voltar atrás: select cron.unschedule('nfe-recebidas'); drop table nfe_recebidas, dfe_controle;
-- (as notas já lançadas continuam em notas_entrada; nada do estoque depende destas tabelas)

create table if not exists public.nfe_recebidas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  chave text not null check (chave ~ '^\d{44}$'),
  nsu text,
  emitente_cnpj text,
  emitente_nome text,
  emissao timestamptz,
  valor int,
  situacao_sefaz text,               -- 1 autorizada, 2 denegada, 3 cancelada
  status text not null default 'resumo' check (status in ('resumo', 'ciencia', 'xml', 'lancada', 'ignorada', 'cancelada')),
  xml_path text,
  ultimo_erro text,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (empresa_id, chave)
);
create index if not exists nfr_lista on public.nfe_recebidas (empresa_id, status, emissao desc);
alter table public.nfe_recebidas enable row level security;
drop policy if exists nfr_ler on public.nfe_recebidas;
create policy nfr_ler on public.nfe_recebidas for select using (app_eh_membro(empresa_id, '{dono,gerente}'::papel_membro[]));
revoke insert, update, delete on public.nfe_recebidas from anon, authenticated;

create table if not exists public.dfe_controle (
  empresa_id uuid primary key references public.empresas(id) on delete cascade,
  ult_nsu text not null default '000000000000000',
  proxima_em timestamptz,
  limite_ate timestamptz,
  rodando_ate timestamptz,
  ultima_em timestamptz,
  ultimo_erro text
);
alter table public.dfe_controle enable row level security;
drop policy if exists dfe_ler on public.dfe_controle;
create policy dfe_ler on public.dfe_controle for select using (app_eh_membro(empresa_id, '{dono,gerente}'::papel_membro[]));
revoke insert, update, delete on public.dfe_controle from anon, authenticated;

-- nota lançada pelo painel some da lista de pendentes
create or replace function public.nfe_recebida_ao_lancar()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.status = 'lancada' and (old.status is distinct from 'lancada') then
    update nfe_recebidas set status = 'lancada', atualizado_em = now() where empresa_id = new.empresa_id and chave = new.chave;
  end if;
  return new;
end $$;
drop trigger if exists nfe_recebida_lancada on public.notas_entrada;
create trigger nfe_recebida_lancada after update of status on public.notas_entrada
  for each row execute function public.nfe_recebida_ao_lancar();

-- ignorar (ou voltar a mostrar) uma nota da lista: só dono/gerente
create or replace function public.nfe_recebida_ignorar(p_id uuid, p_ignorar boolean default true)
returns void language plpgsql security definer set search_path to 'public' as $$
declare v nfe_recebidas%rowtype;
begin
  select * into v from nfe_recebidas where id = p_id for update;
  if not found or not app_eh_membro(v.empresa_id, '{dono,gerente}') then raise exception 'sem permissão'; end if;
  if v.status = 'lancada' then raise exception 'nota já lançada'; end if;
  update nfe_recebidas set status = case when p_ignorar then 'ignorada' when xml_path is not null then 'xml' else 'ciencia' end,
    atualizado_em = now() where id = p_id;
end $$;
revoke all on function public.nfe_recebida_ignorar(uuid, boolean) from public, anon;
grant execute on function public.nfe_recebida_ignorar(uuid, boolean) to authenticated;

-- (a chamada periódica fica no GitHub Actions: ver 20261124200000_dfe_ponte.sql)
