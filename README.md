# Report Meta Ads + Zoho CRM | PipeLovers

Dashboard local para cruzar dados da Meta Graph API com o Zoho CRM e identificar quais criativos, anúncios e campanhas geram mais **assinaturas**, **reuniões** e **leads**.

---

## Como funciona

O projeto roda localmente em `http://localhost:3000`. Todas as credenciais ficam no arquivo `.env` — **nunca são enviadas ao GitHub ou expostas ao frontend**.

```
Browser → Express (server.js) → Meta Graph API
                              → Zoho CRM API
                              → Slack Webhook
```

---

## Instalação

```bash
git clone https://github.com/jpofrancisco3/Report-Meta.git
cd Report-Meta
npm install
```

---

## Configuração

Copie o `.env.example` e preencha com suas credenciais:

```bash
cp .env.example .env
```

### Meta Graph API

```env
META_ACCESS_TOKEN=EAANt50g...        # Token de usuário (long-lived, 60 dias)
META_APP_SECRET=219080b6...          # App Secret (App-Claude-Pipe, ID 965265046083130)
META_AD_ACCOUNT_ID=652242416740080   # sem o prefixo act_
META_API_VERSION=v23.0
```

Para renovar o token: [developers.facebook.com](https://developers.facebook.com) → App-Claude-Pipe → Tools → Graph API Explorer → gerar User Token com `ads_management` + `ads_read`.

### Zoho CRM API

```env
ZOHO_CLIENT_ID=
ZOHO_CLIENT_SECRET=
ZOHO_REFRESH_TOKEN=
ZOHO_ACCOUNTS_URL=https://accounts.zoho.com
ZOHO_API_DOMAIN=https://www.zohoapis.com
ZOHO_MODULE=Deals
```

Para obter o refresh token: [api-console.zoho.com](https://api-console.zoho.com) → Self Client → gerar token com escopo `ZohoCRM.modules.ALL`.

### Slack

```env
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

Crie um Incoming Webhook em: [api.slack.com/apps](https://api.slack.com/apps).

---

## Como rodar

```bash
node server.js
# ou
npm run dev
```

Acesse: [http://localhost:3000](http://localhost:3000)

O terminal mostrará quais integrações estão configuradas.

---

## Como usar

### Buscar via API (recomendado)

1. Abra o dashboard em `http://localhost:3000`
2. No painel **Buscar via API**, selecione o período
3. Clique em **Buscar via API**
4. Os dados são buscados diretamente da Meta e do Zoho e cruzados automaticamente

### Upload Manual (fallback)

Caso a API não esteja disponível:

1. Exporte a planilha do Meta Ads (nível de anúncio) em `.xlsx`
2. Exporte os registros do Zoho CRM em `.xlsx`
3. Faça upload no painel de upload
4. Clique em **Atualizar Dashboard**

### Enviar Report para o Slack

Clique em **Enviar Report** — o resumo do dia é enviado automaticamente para o canal configurado no webhook. Se o servidor estiver offline, o texto é copiado para a área de transferência.

---

## Campos do Zoho CRM

Os nomes técnicos dos campos customizados ficam em `config/fieldMap.js`. Edite este arquivo se os nomes no seu Zoho forem diferentes:

```js
metaAdId:   "Meta_Ads_ADs_ID",    // Meta Ads - ADs ID
metaAdName: "Meta_Ads_Anuncio",   // Meta Ads - Anuncio
// ...
```

---

## Métricas

| Métrica | Fórmula |
|---------|---------|
| CPL Meta | Gasto ÷ Leads Meta |
| Custo por Reunião | Gasto ÷ Reuniões Geradas |
| Custo por Assinatura | Gasto ÷ Assinaturas Realizadas |
| Taxa Lead → Reunião | Reuniões ÷ Leads Zoho × 100 |
| Taxa Lead → Assinatura | Assinaturas ÷ Leads Zoho × 100 |

---

## Segurança

- `.env` está no `.gitignore` — nunca é commitado
- Tokens nunca aparecem no frontend nem no console do browser
- Todas as chamadas à Meta, Zoho e Slack passam pelo servidor Express local
