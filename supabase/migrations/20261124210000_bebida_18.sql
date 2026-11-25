-- Bebida alcoólica pede confirmação de idade no caixa (aviso + "Tenho 18 anos"; nunca bloqueia a venda).
-- Todo produto que entra ou muda para NCM de bebida alcoólica recebe idade_minima = 18, venha do Painel,
-- da entrada de NF-e ou de importação. 22.07 (álcool etílico, ex.: álcool líquido 70%) fica de fora.
-- Ajuste manual no Painel é respeitado enquanto o NCM não mudar.
-- Para voltar atrás: drop trigger produtos_bebida_18 on public.produtos; drop function public.produto_bebida_18();

create or replace function public.produto_bebida_18() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.ncm ~ '^220[34568]'
     and (tg_op = 'INSERT' or new.ncm is distinct from old.ncm)
     and coalesce(new.idade_minima, 0) < 18 then
    new.idade_minima := 18;
  end if;
  return new;
end $$;

revoke execute on function public.produto_bebida_18() from public, anon, authenticated;

create or replace trigger produtos_bebida_18 before insert or update of ncm on public.produtos
  for each row execute function public.produto_bebida_18();

-- dados de 24/11/2026: 32 bebidas marcadas 18+ (o álcool Tupi, NCM 2207, ficou de fora)
update public.produtos set idade_minima = 18
 where ncm ~ '^220[34568]' and coalesce(idade_minima, 0) < 18;
