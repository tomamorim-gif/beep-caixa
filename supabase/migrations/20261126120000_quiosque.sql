-- Modo quiosque por caixa (app Android do PagNow).
-- O Painel liga/desliga e define o PIN; o caixa recebe junto com o catálogo (função pdv).
-- O PIN nunca é guardado: só o hash sha256("pagnow-quiosque:" || id do caixa || ":" || pin),
-- o mesmo cálculo que o app faz no tablet para conferir o PIN sem internet.
alter table public.dispositivos add column if not exists quiosque jsonb;

create or replace function public.caixa_quiosque(p_dispositivo uuid, p_ligado boolean, p_pin text default null, p_pagina text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d record; v_hash text; v_pag text; v_q jsonb;
begin
  select id, empresa_id, quiosque into d from dispositivos where id = p_dispositivo and ativo;
  if not found or not app_eh_membro(d.empresa_id, '{dono,gerente}') then raise exception 'Caixa não encontrado'; end if;
  if p_pin is not null and p_pin <> '' then
    if p_pin !~ '^[0-9]{4,6}$' then raise exception 'O PIN tem de 4 a 6 números'; end if;
    v_hash := encode(sha256(convert_to('pagnow-quiosque:' || d.id::text || ':' || p_pin, 'UTF8')), 'hex');
  else
    v_hash := d.quiosque->>'pin_hash';
  end if;
  if p_ligado and v_hash is null then raise exception 'Defina o PIN para ligar o quiosque'; end if;
  v_pag := coalesce(nullif(p_pagina, ''), d.quiosque->>'pagina', 'caixa');
  if v_pag not in ('caixa', 'vendedor') then raise exception 'Tela inválida'; end if;
  v_q := jsonb_build_object('ligado', p_ligado, 'pin_hash', v_hash, 'tem_pin', v_hash is not null, 'pagina', v_pag,
    'atualizado', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'por', auth.uid());
  update dispositivos set quiosque = v_q where id = d.id;
  return v_q - 'pin_hash' - 'por';
end $$;

revoke all on function public.caixa_quiosque(uuid, boolean, text, text) from public, anon;
grant execute on function public.caixa_quiosque(uuid, boolean, text, text) to authenticated;
