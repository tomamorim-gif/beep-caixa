-- Kit pronto: tablet sai de fábrica com um número de série; na primeira vez mostra um QR,
-- o cliente cria a conta pelo celular e o tablet se vincula sozinho à loja.
-- Só acrescenta tabelas novas. Para voltar atrás: drop table kit_pareamentos, kit_seriais, kit_admins;

-- quem pode preparar kits de fábrica (equipe Beep)
create table if not exists public.kit_admins (
  user_id uuid primary key,
  criado_em timestamptz not null default now()
);
alter table public.kit_admins enable row level security;
drop policy if exists kit_admins_proprio on public.kit_admins;
create policy kit_admins_proprio on public.kit_admins for select using (user_id = auth.uid());
-- começa com o dono da Beep Smart Mercadinhos
insert into public.kit_admins (user_id)
select m.user_id from public.membros m join public.empresas e on e.id = m.empresa_id
 where e.nome_exibicao = 'Beep Smart Mercadinhos' and m.papel = 'dono' and m.ativo
on conflict do nothing;

-- número de série gravado no tablet na fábrica (só o hash fica no banco)
create table if not exists public.kit_seriais (
  id uuid primary key default gen_random_uuid(),
  serial_hash text not null unique,
  final text not null,
  rotulo text,
  criado_por uuid,
  criado_em timestamptz not null default now(),
  usado_em timestamptz,
  empresa_id uuid references public.empresas(id) on delete set null,
  dispositivo_id uuid
);
alter table public.kit_seriais enable row level security;
drop policy if exists kit_seriais_admin on public.kit_seriais;
create policy kit_seriais_admin on public.kit_seriais for select
  using (exists (select 1 from public.kit_admins a where a.user_id = auth.uid()));

-- cada QR mostrado pelo tablet (vale 20 minutos)
create table if not exists public.kit_pareamentos (
  id uuid primary key default gen_random_uuid(),
  serial_id uuid not null references public.kit_seriais(id) on delete cascade,
  codigo_hash text not null unique,
  segredo_hash text not null unique,
  expira_em timestamptz not null,
  tentativas int not null default 0,
  empresa_id uuid references public.empresas(id) on delete cascade,
  local_id uuid references public.locais(id) on delete cascade,
  vinculado_por uuid,
  vinculado_em timestamptz,
  dispositivo_id uuid,
  entregue_em timestamptz,
  criado_em timestamptz not null default now()
);
create index if not exists kit_pareamentos_serial on public.kit_pareamentos (serial_id);
alter table public.kit_pareamentos enable row level security;
-- sem policies: só a função "kit" (chave de serviço) lê e grava
