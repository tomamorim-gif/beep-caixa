-- Avisos da inteligência no celular (notificação do Painel instalado) e conexão opcional com IA.
-- Tudo aqui é ADITIVO: duas tabelas novas, funções novas e um agendamento diário.
-- Nada é alterado nem apagado nas vendas, no estoque, nos produtos ou no financeiro.
--
-- Para voltar atrás:
--   select cron.unschedule(jobid) from cron.job where jobname = 'avisos-diarios';
--   drop function if exists public.avisos_chamar(text);
--   drop function if exists public.avisos_vapid();
--   drop function if exists public.ia_conexao_salvar(uuid, text, text, text);
--   drop function if exists public.ia_conexao_chave(uuid);
--   drop table if exists public.avisos_enviados;
--   drop table if exists public.push_assinaturas;

-- Aparelhos que aceitaram receber notificação (um registro por aparelho e pessoa).
create table if not exists public.push_assinaturas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  user_id uuid not null default auth.uid(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  aparelho text,
  criado_em timestamptz not null default now(),
  ultimo_envio timestamptz
);
create index if not exists push_assinaturas_emp on public.push_assinaturas (empresa_id);
alter table public.push_assinaturas enable row level security;
-- cada pessoa vê, cadastra e remove só os próprios aparelhos, e só numa empresa da qual é dono ou gerente
create policy push_sel on public.push_assinaturas for select to authenticated using (user_id = auth.uid());
create policy push_ins on public.push_assinaturas for insert to authenticated
  with check (user_id = auth.uid() and app_eh_membro(empresa_id, '{dono,gerente}'));
create policy push_del on public.push_assinaturas for delete to authenticated using (user_id = auth.uid());

-- O que já foi avisado (para não repetir o mesmo aviso no mesmo dia). Só o servidor grava.
create table if not exists public.avisos_enviados (
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  user_id uuid not null,
  chave text not null,
  dia date not null,
  enviado_em timestamptz not null default now(),
  primary key (empresa_id, user_id, chave, dia)
);
alter table public.avisos_enviados enable row level security;

-- Chama a função de avisos no servidor (mesma chave interna da NFC-e, guardada no cofre).
create or replace function public.avisos_chamar(p_acao text)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  perform net.http_post(
    url := 'https://gdnvjpmpfgautrmtkjmx.supabase.co/functions/v1/avisos',
    body := jsonb_build_object('acao', p_acao),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-beep-interno', public.fiscal_chave_interna()),
    timeout_milliseconds := 60000);
end $$;
revoke all on function public.avisos_chamar(text) from public, anon, authenticated;
grant execute on function public.avisos_chamar(text) to service_role;

-- Chave privada das notificações (guardada no cofre fora do código; só o servidor lê).
create or replace function public.avisos_vapid()
returns text language sql security definer set search_path to 'public', 'vault' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'vapid_private'
$$;
revoke all on function public.avisos_vapid() from public, anon, authenticated;
grant execute on function public.avisos_vapid() to service_role;

-- Todo dia às 8h de Fortaleza (11h UTC): resumo da inteligência e contas que vencem.
select cron.unschedule(jobid) from cron.job where jobname = 'avisos-diarios';
select cron.schedule('avisos-diarios', '0 11 * * *', $$select public.avisos_chamar('diario')$$);

-- Conexão com IA (opcional, por cliente). A chave fica só no cofre do banco: o Painel grava, mas nunca lê de volta.
-- No cadastro da empresa ficam só o provedor, o modelo e os 4 últimos caracteres, para mostrar na tela.
create or replace function public.ia_conexao_salvar(p_empresa uuid, p_provedor text, p_modelo text, p_chave text)
returns jsonb language plpgsql security definer set search_path to 'public', 'vault' as $$
declare v_nome text := 'ia_' || p_empresa::text; v_id uuid; v_info jsonb;
begin
  if not app_eh_membro(p_empresa, '{dono}') then raise exception 'só o dono pode mudar a conexão com IA'; end if;
  select id into v_id from vault.secrets where name = v_nome;
  if coalesce(trim(p_chave), '') = '' then
    -- desligar: apaga a chave do cofre e tira a conexão do cadastro
    if v_id is not null then delete from vault.secrets where id = v_id; end if;
    update empresas set inteligencia = coalesce(inteligencia, '{}'::jsonb) - 'ia' where id = p_empresa;
    return jsonb_build_object('ativo', false);
  end if;
  if length(p_chave) > 400 or p_provedor not in ('anthropic', 'openai', 'google', 'outro') then raise exception 'conexão inválida'; end if;
  if v_id is null then perform vault.create_secret(trim(p_chave), v_nome, 'Chave de IA da empresa');
  else perform vault.update_secret(v_id, trim(p_chave)); end if;
  v_info := jsonb_build_object('ativo', true, 'provedor', p_provedor, 'modelo', left(coalesce(p_modelo, ''), 80),
                               'fim', right(trim(p_chave), 4), 'em', now());
  update empresas set inteligencia = coalesce(inteligencia, '{}'::jsonb) || jsonb_build_object('ia', v_info) where id = p_empresa;
  return v_info;
end $$;
revoke all on function public.ia_conexao_salvar(uuid, text, text, text) from public, anon;
grant execute on function public.ia_conexao_salvar(uuid, text, text, text) to authenticated;

-- Só o servidor (funções do Supabase) lê a chave, no dia em que alguma função usar IA.
create or replace function public.ia_conexao_chave(p_empresa uuid)
returns text language sql security definer set search_path to 'public', 'vault' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'ia_' || p_empresa::text
$$;
revoke all on function public.ia_conexao_chave(uuid) from public, anon, authenticated;
grant execute on function public.ia_conexao_chave(uuid) to service_role;
