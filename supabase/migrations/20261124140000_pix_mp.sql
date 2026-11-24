-- Pix de verdade pelo Mercado Pago: usa a mesma tabela e as mesmas travas da cobrança no cartão.
-- O Pix não tem maquininha (terminal_id fica vazio); a venda só é gravada quando o Mercado Pago confirma.
-- Para voltar atrás: as cobranças Pix ficam com forma = 'pix'; basta não chamar mais o Pix no caixa.
alter table public.cobrancas_cartao drop constraint if exists cobrancas_cartao_forma_check;
alter table public.cobrancas_cartao add constraint cobrancas_cartao_forma_check
  check (forma in ('credito', 'debito', 'pix'));
