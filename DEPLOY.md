# Fluxo de Deploy — PipeDash

Repositório: https://github.com/jpofrancisco2/pipedash.git  
Produção:    https://pipedash.vercel.app  
Projeto local: `C:\Users\jpofr\OneDrive\Documentos\Nativo\Report-Meta`

---

## Fluxo obrigatório

```
Alteração local → teste local → aprovação → commit → push GitHub → deploy automático Vercel
```

Nunca fazer push sem validar localmente primeiro.

---

## Passo a passo

### 1. Fazer a alteração

Edite os arquivos no projeto local:
```
C:\Users\jpofr\OneDrive\Documentos\Nativo\Report-Meta
```

---

### 2. Rodar localmente

```bash
npm start
```

Abrir no navegador: http://localhost:3000

---

### 3. Validar visualmente

Checar antes de qualquer commit:

- [ ] Página abre sem erro
- [ ] Aba Live Meta carrega
- [ ] Aba Google Ads carrega
- [ ] Aba Visão Geral carrega
- [ ] Aba Insights carrega
- [ ] Aba Financeiro carrega
- [ ] Alteração solicitada apareceu corretamente
- [ ] Nenhum erro crítico no console do navegador (F12)
- [ ] Botões principais funcionando

---

### 4. Rodar verificação de segurança

```bash
node scripts/pre-deploy-check.js
```

O script verifica se nenhum arquivo sensível está staged.  
Se retornar **BLOQUEADO**, corrigir antes de continuar.

---

### 5. Apresentar resumo para aprovação

Antes de fazer push, apresentar ao usuário:

```
Alterações realizadas:
- item 1
- item 2

Arquivos alterados:
- script.js
- style.css

Teste local:
- servidor local rodando ✓
- página abriu ✓
- funcionalidade validada ✓
- sem erros críticos no console ✓

Pronto para deploy?
```

Só após aprovação explícita, fazer commit e push.

---

### 6. Commit e push

```bash
git status
git add <arquivos específicos>
git commit -m "Descrição clara da alteração"
git push origin main
```

**Nunca usar `git add .` sem revisar o `git status` antes.**

---

### 7. Deploy automático

A Vercel detecta o push no GitHub e inicia o deploy automaticamente.  
Acompanhar em: https://vercel.com/dashboard → projeto `pipedash`

Aguardar 1-2 minutos e testar em produção: https://pipedash.vercel.app

---

## Arquivos que NUNCA devem ser versionados

| Arquivo / Pasta         | Motivo                              |
|-------------------------|-------------------------------------|
| `.env`                  | Contém tokens e credenciais reais   |
| `.env.local`            | Variante do env                     |
| `.env.production`       | Variante do env                     |
| `node_modules/`         | Dependências (instalar via npm)     |
| `slack_mql_cache.json`  | Dados sensíveis de leads            |
| `backups/`              | Backups locais                      |
| `credentials/`          | Arquivos de credenciais             |

Todos estão no `.gitignore`. Verificar com `git status` antes de qualquer commit.

---

## Variáveis de ambiente na Vercel

As variáveis do `.env` local devem ser configuradas manualmente na Vercel:

**Vercel Dashboard → pipedash → Settings → Environment Variables**

| Variável                    | Descrição                     |
|-----------------------------|-------------------------------|
| `META_ACCESS_TOKEN`         | Token da Meta Graph API       |
| `META_AD_ACCOUNT_ID`        | ID da conta de anúncios       |
| `META_APP_SECRET`           | Secret do app Meta            |
| `ZOHO_CLIENT_ID`            | Client ID do Zoho             |
| `ZOHO_CLIENT_SECRET`        | Client Secret do Zoho         |
| `ZOHO_REFRESH_TOKEN`        | Refresh Token do Zoho         |
| `ZOHO_ACCOUNT_ID`           | Account ID do Zoho            |
| `GOOGLE_ADS_DEVELOPER_TOKEN`| Developer Token Google Ads    |
| `GOOGLE_ADS_CLIENT_ID`      | Client ID OAuth2 Google       |
| `GOOGLE_ADS_CLIENT_SECRET`  | Client Secret OAuth2 Google   |
| `GOOGLE_ADS_REFRESH_TOKEN`  | Refresh Token OAuth2 Google   |
| `GOOGLE_ADS_CUSTOMER_ID`    | Customer ID Google Ads        |
| `SLACK_BOT_TOKEN`           | Token do bot Slack            |

Após adicionar ou alterar variáveis: fazer **Redeploy** manual na Vercel.

---

## Diagrama do fluxo

```
Local (edição)
     ↓
npm start → http://localhost:3000 (validação visual)
     ↓
node scripts/pre-deploy-check.js (segurança)
     ↓
Aprovação do usuário
     ↓
git add + git commit + git push origin main
     ↓
GitHub (jpofrancisco2/pipedash)
     ↓
Vercel (deploy automático)
     ↓
https://pipedash.vercel.app (produção)
```
