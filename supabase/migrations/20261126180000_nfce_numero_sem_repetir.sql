-- NFC-e: a reserva de número nunca devolve um número que já está em outra nota da mesma série e ambiente.
-- Motivo: em 24/11 o contador voltou para trás e duas vendas de 25/11 pegaram os números 2 e 3, que já eram de outras vendas.
-- Como voltar atrás: rodar de novo a versão antiga da função (supabase/migrations/20261124150000_nfce.sql, fiscal_reservar_numero).
create or replace function public.fiscal_reservar_numero(p_empresa uuid)
returns table (serie integer, numero integer) language sql security definer set search_path to 'public' as $$
  update fiscal_nfce f
     set proximo_numero = greatest(
           f.proximo_numero,
           coalesce((select max(n.numero) from nfce n
                      where n.empresa_id = f.empresa_id and n.ambiente = f.ambiente and n.serie = f.serie), 0) + 1
         ) + 1
   where f.empresa_id = p_empresa
  returning f.serie, f.proximo_numero - 1
$$;
revoke all on function public.fiscal_reservar_numero(uuid) from public, anon, authenticated;
grant execute on function public.fiscal_reservar_numero(uuid) to service_role;
