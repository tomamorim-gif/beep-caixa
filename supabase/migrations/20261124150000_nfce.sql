-- NFC-e (nota fiscal de consumidor) emitida pelo servidor em cada venda paga.
-- O que esta migração faz:
--   1) fiscal_nfce: dados do emitente por empresa (IE, endereço, série, próximo número, ambiente). Sem segredos.
--   2) Segredos (certificado A1, senha, CSC) ficam no cofre do Supabase (Vault), nunca em tabela nem no código.
--   3) Numeração atômica: cada nota pega o próximo número da série sem repetir, mesmo com vários caixas ao mesmo tempo.
--   4) Fila: venda paga entra na fila da NFC-e e o servidor emite na hora; um relógio a cada minuto reenvia o que ficou pendente.
--   5) Venda cancelada/estornada com nota autorizada pede o cancelamento da nota.
-- Para desligar sem apagar nada: update fiscal_nfce set ativo = false;  (as vendas continuam, só param de entrar na fila)

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- 1) emitente
create table if not exists public.fiscal_nfce (
  empresa_id uuid primary key references public.empresas(id) on delete cascade,
  ativo boolean not null default false,
  ambiente text not null default 'homologacao' check (ambiente in ('homologacao', 'producao')),
  serie integer not null default 2 check (serie between 1 and 999),
  proximo_numero integer not null default 1 check (proximo_numero between 1 and 999999999),
  csc_id text,
  ie text,
  crt smallint not null default 1,
  logradouro text, numero text, complemento text, bairro text,
  cod_municipio text, municipio text, uf text, cep text, fone text,
  cert_titular text, cert_cnpj text, cert_validade timestamptz,
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid
);
alter table public.fiscal_nfce enable row level security;
-- sem políticas: o navegador não lê nem grava direto; só as funções do servidor (service_role)

-- 2) nota de cada venda (a tabela nfce já existia, vazia)
alter table public.nfce add column if not exists ambiente text;
alter table public.nfce add column if not exists dh_emissao timestamptz;
alter table public.nfce add column if not exists cstat integer;
alter table public.nfce add column if not exists processando_ate timestamptz;
alter table public.nfce add column if not exists cancelamento_protocolo text;
alter table public.nfce add column if not exists cancelada_em timestamptz;
alter table public.nfce alter column tentativas set default 0;
alter table public.nfce alter column criado_em set default now();
alter table public.nfce alter column atualizado_em set default now();
create unique index if not exists nfce_numero_unico on public.nfce (empresa_id, ambiente, serie, numero) where numero is not null;
create index if not exists nfce_fila_idx on public.nfce (status, atualizado_em) where status in ('fila', 'contingencia');

-- XML autorizado (guardar por 5 anos): bucket privado
insert into storage.buckets (id, name, public) values ('nfce', 'nfce', false) on conflict (id) do nothing;

-- 3) segredos no cofre
create or replace function public.fiscal_guardar_segredo(p_empresa uuid, p_tipo text, p_valor text)
returns void language plpgsql security definer set search_path to 'public', 'vault' as $$
declare v_nome text := 'nfce_' || p_tipo || '_' || p_empresa; v_id uuid;
begin
  if p_tipo not in ('pfx', 'senha', 'csc') then raise exception 'tipo inválido'; end if;
  select id into v_id from vault.secrets where name = v_nome;
  if v_id is null then perform vault.create_secret(p_valor, v_nome, 'NFC-e: ' || p_tipo);
  else perform vault.update_secret(v_id, p_valor); end if;
end $$;

create or replace function public.fiscal_ler_segredos(p_empresa uuid)
returns table (pfx text, senha text, csc text) language sql security definer set search_path to 'public', 'vault' as $$
  select (select decrypted_secret from vault.decrypted_secrets where name = 'nfce_pfx_' || p_empresa),
         (select decrypted_secret from vault.decrypted_secrets where name = 'nfce_senha_' || p_empresa),
         (select decrypted_secret from vault.decrypted_secrets where name = 'nfce_csc_' || p_empresa)
$$;

-- chave que o banco usa para chamar a função "nfce" (gerada aqui, ninguém precisa ver)
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'nfce_interno') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'nfce_interno', 'Chamada interna banco -> função nfce');
  end if;
end $$;

create or replace function public.fiscal_chave_interna()
returns text language sql security definer set search_path to 'public', 'vault' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'nfce_interno'
$$;

-- 4) numeração: devolve o número reservado (nunca repete)
create or replace function public.fiscal_reservar_numero(p_empresa uuid)
returns table (serie integer, numero integer) language sql security definer set search_path to 'public' as $$
  update fiscal_nfce set proximo_numero = proximo_numero + 1 where empresa_id = p_empresa
  returning serie, proximo_numero - 1
$$;

-- pega notas da fila para enviar (várias execuções ao mesmo tempo não pegam a mesma nota)
create or replace function public.nfce_pegar(p_venda uuid default null, p_limite integer default 20)
returns setof public.nfce language sql security definer set search_path to 'public' as $$
  update nfce n set processando_ate = now() + interval '2 minutes', atualizado_em = now()
  where n.venda_id in (
    select venda_id from nfce
    where status in ('fila', 'contingencia')
      and (p_venda is null or venda_id = p_venda)
      and (processando_ate is null or processando_ate < now())
      and tentativas < 50
    order by criado_em
    limit p_limite
    for update skip locked)
  returning n.*
$$;

-- chama a função nfce sem esperar (o pedido sai depois que a transação termina)
create or replace function public.nfce_chamar(p_acao text, p_venda uuid default null)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  perform net.http_post(
    url := 'https://gdnvjpmpfgautrmtkjmx.supabase.co/functions/v1/nfce',
    body := jsonb_build_object('acao', p_acao, 'venda_id', p_venda),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-beep-interno', public.fiscal_chave_interna()),
    timeout_milliseconds := 60000);
end $$;

-- 5) venda paga entra na fila; venda cancelada pede cancelamento da nota
create or replace function public.nfce_ao_mudar_venda()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare f fiscal_nfce;
begin
  -- nada aqui pode travar a venda: qualquer erro da nota é engolido e a venda segue gravada
  begin
  select * into f from fiscal_nfce where empresa_id = new.empresa_id;
  if new.status = 'paga' and (tg_op = 'INSERT' or old.status is distinct from 'paga') then
    -- venda de teste (pagamento simulado) só gera nota em homologação, nunca em produção
    if f.ativo and (not coalesce(new.teste, false) or f.ambiente = 'homologacao') then
      insert into nfce (venda_id, empresa_id, status, ambiente, tentativas)
      values (new.id, new.empresa_id, 'fila', f.ambiente, 0) on conflict (venda_id) do nothing;
      perform nfce_chamar('emitir', new.id);
    end if;
  elsif new.status = 'cancelada' and tg_op = 'UPDATE' and old.status = 'paga' then
    if exists (select 1 from nfce where venda_id = new.id and status = 'autorizada') then
      perform nfce_chamar('cancelar', new.id);
    elsif exists (select 1 from nfce where venda_id = new.id and status in ('fila', 'rejeitada')) then
      -- ainda não autorizada: tira da fila
      update nfce set status = 'cancelada', ultimo_erro = 'Venda cancelada antes da autorização', atualizado_em = now()
      where venda_id = new.id and status in ('fila', 'rejeitada');
    end if;
  end if;
  exception when others then
    raise warning 'nfce: % (venda %)', sqlerrm, new.id;
  end;
  return new;
end $$;

drop trigger if exists vendas_nfce on public.vendas;
create trigger vendas_nfce after insert or update of status on public.vendas
  for each row execute function public.nfce_ao_mudar_venda();

-- relógio: a cada minuto reenvia o que ficou na fila (internet ou SEFAZ fora do ar)
select cron.unschedule(jobid) from cron.job where jobname = 'nfce-fila';
select cron.schedule('nfce-fila', '* * * * *', $$
  select public.nfce_chamar('fila') where exists (
    select 1 from public.nfce where status in ('fila', 'contingencia') and (processando_ate is null or processando_ate < now()) and tentativas < 50)
$$);

revoke all on function public.fiscal_guardar_segredo(uuid, text, text) from public, anon, authenticated;
revoke all on function public.fiscal_ler_segredos(uuid) from public, anon, authenticated;
revoke all on function public.fiscal_chave_interna() from public, anon, authenticated;
revoke all on function public.fiscal_reservar_numero(uuid) from public, anon, authenticated;
revoke all on function public.nfce_pegar(uuid, integer) from public, anon, authenticated;
revoke all on function public.nfce_chamar(text, uuid) from public, anon, authenticated;
revoke all on function public.nfce_ao_mudar_venda() from public, anon, authenticated;
grant execute on function public.fiscal_guardar_segredo(uuid, text, text) to service_role;
grant execute on function public.fiscal_ler_segredos(uuid) to service_role;
grant execute on function public.fiscal_chave_interna() to service_role;
grant execute on function public.fiscal_reservar_numero(uuid) to service_role;
grant execute on function public.nfce_pegar(uuid, integer) to service_role;
grant execute on function public.nfce_chamar(text, uuid) to service_role;
