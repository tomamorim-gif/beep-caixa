-- Busca das notas de compra pelo GitHub Actions: token próprio (só para a função nfe-entrada).
-- O mesmo valor fica no segredo BEEP_PONTE do GitHub. Para trocar: atualizar o segredo no Vault e no GitHub.
-- Como voltar atrás: select vault.update_secret((select id from vault.secrets where name='dfe_ponte'), encode(gen_random_bytes(32),'hex'));
--   (invalida o token do GitHub) e desligar o workflow "Notas de compra (SEFAZ)".
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'dfe_ponte', 'Token da busca de notas de compra (GitHub Actions)')
where not exists (select 1 from vault.secrets where name = 'dfe_ponte');

create or replace function public.dfe_ponte_token()
returns text language sql security definer set search_path to 'public', 'vault' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'dfe_ponte'
$$;
revoke all on function public.dfe_ponte_token() from public, anon, authenticated;
grant execute on function public.dfe_ponte_token() to service_role;

-- nfe_recebidas_chamar (chamada pelo banco) fica sem uso: quem busca agora é o GitHub, pelo botão do painel

-- botão "Atualizar notas" do painel: a função dispara o workflow do GitHub com um token só de Actions
-- (o próprio Tom cadastra o token: select vault.create_secret('<token>', 'github_dispatch');)
create or replace function public.dfe_github_token()
returns text language sql security definer set search_path to 'public', 'vault' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'github_dispatch'
$$;
revoke all on function public.dfe_github_token() from public, anon, authenticated;
grant execute on function public.dfe_github_token() to service_role;
alter table public.dfe_controle add column if not exists pedido_em timestamptz;
