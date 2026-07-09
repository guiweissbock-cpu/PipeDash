# PipeDash — Instruções para Claude Code

## Regra obrigatória: Rules deve ser atualizado em todo commit de lógica

**Toda alteração que envolva cálculo, filtro, fonte de dados, regra de exibição,
regra de atribuição, integração ou estrutura de módulo DEVE ser acompanhada de
atualização correspondente em `rules_module.js` no mesmo commit.**

Nenhuma alteração de lógica está completa sem a atualização do Rules.

Ao editar `rules_module.js`:
- Localize a entrada com o ID correspondente na constante `RULES_CATALOG`
- Atualize os campos afetados (calculo, filtroData, inclusao, exclusao, observacoes, etc.)
- Se a mudança criar uma nova métrica ou regra, adicione uma nova entrada com o próximo ID sequencial
- Atualize o campo `updatedAt` em `RULES_META`

## Restrições de segurança

- Não subir .env, tokens ou credenciais para o GitHub
- Não fazer deploy manual direto na Vercel sem commit no GitHub
- Não editar código diretamente na Vercel
- .env e todos os arquivos .env* estão no .gitignore — nunca remover essa linha

## Restrições de lógica (não alterar sem aprovação explícita)

- Não alterar Live Meta
- Não alterar Google Ads
- Não alterar MetaEdge
- Não alterar regras de reuniões, MQL ou assinaturas
- Não usar o Zoho como fonte de campanha, palavra-chave ou anúncio
- Não mudar lógicas de cálculo, abas, processos, serviços, integrações ou regras de negócio já validadas

## Fluxo de deploy

Sempre usar: branch → testar local → merge → push → tag
Nunca editar direto na main.

## Stack

- Node.js/Express em Vercel (serverless)
- Frontend: HTML + CSS + JavaScript puro (sem framework)
- Meta Ads API (Graph API v19)
- Zoho CRM API v2 + Analytics Reports
- Google Ads API v14
- Slack Webhooks
