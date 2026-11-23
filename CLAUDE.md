# CLAUDE.md — Beep Caixa (autoatendimento)

## O que é
Sistema próprio de autoatendimento dos mercadinhos Beep. Roda primeiro nas lojas Beep e depois será vendido como produto, com opção de marca própria do cliente (white label). O nome é sempre "Beep", nunca "Bip".

## Estrutura do repositório
- `index.html` — caixa (PWA) usado no tablet/celular da loja. `sw.js` e `manifest.webmanifest` cuidam do modo app e offline.
- `gestao/` — painel de gestão (cadastros, estoque, lojas).
- `cliente/` — app do cliente, instalável pelo QR da loja.
- `relatorio/` — relatórios.
- `termos/` — termos de uso.
- `supabase/functions/` — funções do servidor: `pdv`, `cartao`, `pagamento-config`.
- `android/` — app Android (Kotlin) que faz a ponte com a maquininha. Build pelo workflow `.github/workflows/android.yml`.
- Hospedagem: GitHub Pages (`.nojekyll`). Banco: Supabase.

## Como funciona hoje
- Tablet de 10" fixo, leitor de código de barras externo e maquininha só no pagamento.
- Maquininha: saindo da PagBank, indo para a Mercado Pago Point Smart 2. Cartão é obrigatório; Pix na tela também.
- Venda guiada por voz. Tela final verde (finalizada) ou vermelha (cancelada/não finalizada), visível nas câmeras.
- Câmera frontal: gravação opcional por cliente (tudo ou só intercorrências).
- Produtos importados do SAC Varejo. NCM e dados fiscais gravados no cadastro, com lista para o contador revisar.
- A loja Lira Holanda é só de testes.

## Pendências
- Parte fiscal e tela de entrada de NF-e (listar notas do CNPJ, baixar XML, revisar, alerta de aumento de custo, dar entrada no CD).
- Conexão com a Point Smart 2.
- Categorias e subcategorias no cadastro de produtos.
- Cadastro de usuários e de fornecedores.
- **Módulo de abastecimento:**
  - Quantidade mínima e máxima de cada produto por loja.
  - Três modos: pelo mínimo (ex.: máx 10, mín 4, tem 2 → leva 2), pelo máximo (completa até 10) ou pelo que foi vendido.
  - Reposição avulsa sempre disponível: bipa o que levou, informa a quantidade, sai do CD e entra na loja.
  - Ao bipar o produto na loja, a tela mostra o padrão dele e quanto deveria haver na prateleira.
  - Diferença marcada na hora vira perda (ou sobra), com produto, loja e data, gerando relatório por loja e por produto. Sem contagem da loja inteira.
  - Não usar o termo "pick list".

## Regras
- O sistema é independente do SAC Varejo.
- Foco em reduzir furtos e em funcionar mesmo com internet instável.
- Este repositório é público: nunca colocar chaves secretas, senhas ou dados de clientes no código. Segredos ficam só nas funções do Supabase.
- Padrão premium: visual profissional e vendável, nada genérico, nada com cara de IA; layout intuitivo; revisar alinhamento e padronização antes de entregar.
- O dono não é programador: antes de mudança grande, explicar o que muda, o risco e como voltar atrás. Corrigir um problema de cada vez e dizer como testar.
- Nunca apagar dados reais sem confirmação.

## O que revisar primeiro
Segurança dos dados e do pagamento (incluindo regras de acesso no Supabase), falhas que travam o caixa e capacidade para várias lojas ao mesmo tempo.
