-- Contingência pelo caixa que o cliente usou (teste real de Tom em 26/11).
--
-- Problema: a contingência só abria quando NENHUM caixa da loja dava sinal. Se outro aparelho ativado na
-- mesma loja (por exemplo, uma ativação antiga do mesmo tablet) seguia online, o servidor achava que a loja
-- estava normal e o app do cliente não liberava o carrinho, mesmo com o caixa mostrando o QR.
--
-- Agora o QR mostrado pelo caixa sem internet leva o código daquele caixa. Se ESSE caixa está sem sinal há
-- mais de 90 s (e a loja tem a opção 4 ligada), o app libera a compra para quem veio por ele. A regra antiga
-- (loja inteira sem sinal) continua valendo. O histórico registra também qual caixa caiu.
--
-- Para voltar atrás: update locais set contingencia_auto = false;  (desliga tudo; nada é apagado)

alter table public.contingencias add column if not exists dispositivo_id uuid references public.dispositivos(id);
drop index if exists public.contingencias_uma_aberta;
create unique index if not exists contingencias_uma_aberta_loja on public.contingencias (local_id) where fim is null and dispositivo_id is null;
create unique index if not exists contingencias_uma_aberta_caixa on public.contingencias (dispositivo_id) where fim is null and dispositivo_id is not null;

-- loja inteira sem sinal (mesma regra de antes; agora só olha os registros da loja, não os de um caixa)
create or replace function public.loja_contingencia(p_local uuid) returns boolean
language plpgsql security definer set search_path to 'public' as $$
declare
  v_emp uuid; v_auto boolean; v_ult timestamptz; v_on boolean; v_aberta uuid;
  v_lim constant interval := interval '90 seconds';
begin
  select empresa_id, (contingencia_auto and ativo) into v_emp, v_auto from locais where id = p_local and tipo = 'loja';
  if not found then return false; end if;
  select max(ultimo_sinal) into v_ult from dispositivos
   where local_id = p_local and ativo and ultimo_sinal > now() - interval '7 days';
  v_on := coalesce(v_auto, false) and v_ult is not null and v_ult < now() - v_lim;
  select id into v_aberta from contingencias where local_id = p_local and fim is null and dispositivo_id is null;
  if v_on and v_aberta is null then
    insert into contingencias (empresa_id, local_id, inicio, sem_sinal_desde) values (v_emp, p_local, v_ult + v_lim, v_ult)
    on conflict do nothing;
  elsif not v_on and v_aberta is not null then
    update contingencias set fim = now() where id = v_aberta and fim is null;
  end if;
  return v_on;
end $$;

-- um caixa específico sem sinal (o caixa cujo QR o cliente leu)
create or replace function public.caixa_contingencia(p_disp uuid, p_local uuid) returns boolean
language plpgsql security definer set search_path to 'public' as $$
declare
  d dispositivos; v_auto boolean; v_on boolean; v_aberta uuid;
  v_lim constant interval := interval '90 seconds';
begin
  if p_disp is null then return false; end if;
  select * into d from dispositivos where id = p_disp and local_id = p_local and ativo;
  if not found then return false; end if;
  select (contingencia_auto and ativo) into v_auto from locais where id = p_local and tipo = 'loja';
  -- sem sinal há mais de 90 s e há menos de 24 h (caixa desligado há dias não libera nada)
  v_on := coalesce(v_auto, false) and d.ultimo_sinal is not null
          and d.ultimo_sinal < now() - v_lim and d.ultimo_sinal > now() - interval '24 hours';
  select id into v_aberta from contingencias where dispositivo_id = p_disp and fim is null;
  if v_on and v_aberta is null then
    insert into contingencias (empresa_id, local_id, dispositivo_id, inicio, sem_sinal_desde)
    values (d.empresa_id, p_local, p_disp, d.ultimo_sinal + v_lim, d.ultimo_sinal) on conflict do nothing;
  elsif not v_on and v_aberta is not null then
    update contingencias set fim = now() where id = v_aberta and fim is null;
  end if;
  return v_on;
end $$;

-- loja OU o caixa do cliente em contingência
create or replace function public.contingencia_agora(p_local uuid, p_caixa uuid) returns boolean
language sql security definer set search_path to 'public' as $$
  select public.loja_contingencia(p_local) or public.caixa_contingencia(p_caixa, p_local);
$$;

-- permissões do cliente considerando o caixa por onde ele entrou
create or replace function public.app_perm(p_cliente uuid, p_caixa uuid) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare c clientes_app; l locais; v_cont boolean; v_compra boolean;
begin
  select * into c from clientes_app where id = p_cliente and ativo;
  if not found then return null; end if;
  select * into l from locais where id = c.local_id and tipo = 'loja' and ativo;
  if not found then return null; end if;
  v_cont := contingencia_agora(l.id, p_caixa);
  v_compra := l.app_compra or (l.app_selecionados and c.compra_liberada) or v_cont;
  return jsonb_build_object('consulta', true, 'compra', v_compra, 'pendente', l.app_pendente or v_compra,
    'contingencia', v_cont, 'contingencia_auto', l.contingencia_auto);
end $$;

create or replace function public.app_perm(p_cliente uuid) returns jsonb
language sql security definer set search_path to 'public' as $$ select public.app_perm(p_cliente, null::uuid); $$;

-- sinal do caixa: agora devolve também o código do caixa (vai no QR) e fecha a contingência dele
create or replace function public.caixa_sinal(p_token text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid; v_local uuid; v_auto boolean;
begin
  if p_token is null or length(p_token) < 40 or length(p_token) > 200 then return jsonb_build_object('ok', false); end if;
  update dispositivos set ultimo_sinal = now()
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') and ativo
   returning id, local_id into v_id, v_local;
  if v_id is null then return jsonb_build_object('ok', false); end if;
  update contingencias set fim = now() where dispositivo_id = v_id and fim is null;
  perform loja_contingencia(v_local);
  select contingencia_auto into v_auto from locais where id = v_local;
  return jsonb_build_object('ok', true, 'contingencia', coalesce(v_auto, false), 'caixa', v_id);
end $$;

revoke all on function public.caixa_contingencia(uuid, uuid) from public, anon, authenticated;
revoke all on function public.contingencia_agora(uuid, uuid) from public, anon, authenticated;
revoke all on function public.app_perm(uuid, uuid) from public, anon, authenticated;
revoke all on function public.app_perm(uuid) from public, anon, authenticated;
revoke all on function public.loja_contingencia(uuid) from public, anon, authenticated;
grant execute on function public.caixa_contingencia(uuid, uuid) to service_role;
grant execute on function public.contingencia_agora(uuid, uuid) to service_role;
grant execute on function public.app_perm(uuid, uuid) to service_role;
grant execute on function public.app_perm(uuid) to service_role;
grant execute on function public.loja_contingencia(uuid) to service_role;

-- o job de 1 min também fecha contingências de caixa que voltaram (ou passaram de 24 h)
select cron.unschedule(jobid) from cron.job where jobname = 'contingencia';
select cron.schedule('contingencia', '* * * * *', $$
  select public.loja_contingencia(id) from public.locais where tipo = 'loja';
  select public.caixa_contingencia(dispositivo_id, local_id) from public.contingencias where fim is null and dispositivo_id is not null;
$$);
