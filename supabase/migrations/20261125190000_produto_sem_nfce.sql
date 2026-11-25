-- Produto que não emite nota fiscal (NFC-e).
-- O dono marca no cadastro (Painel › Produtos › Fiscal). Na venda, os itens marcados ficam fora da NFC-e;
-- se todos os itens da venda estiverem marcados, nenhuma nota é emitida (a nota fica como "dispensada").
-- Só acrescenta uma coluna com padrão "falso": nada muda para os produtos que já existem.
-- Para voltar atrás: alter table public.produtos drop column sem_nfce;
alter table public.produtos add column if not exists sem_nfce boolean not null default false;
comment on column public.produtos.sem_nfce is 'true = o produto não entra na NFC-e da venda';
