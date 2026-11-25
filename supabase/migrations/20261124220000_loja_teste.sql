-- Loja de testes: só nela o caixa aceita pagamento simulado (a função pdv recusa nas outras).
alter table public.locais add column if not exists teste boolean not null default false;
comment on column public.locais.teste is 'Loja de testes: só aqui o caixa aceita pagamento simulado.';
update public.locais set teste = true where nome = 'Lira Holanda';
