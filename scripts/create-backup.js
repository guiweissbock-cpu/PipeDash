/**
 * scripts/create-backup.js
 * Gera backup local versionado do projeto (sem node_modules, .git, dist, build).
 * Uso: node scripts/create-backup.js
 */

const fs   = require("fs");
const path = require("path");

// ── Configuração ────────────────────────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, "..");
const BACKUPS_DIR  = path.join(PROJECT_ROOT, "backups");

// Pastas/arquivos que NUNCA entram no backup
const EXCLUDE = new Set([
  "node_modules", ".git", "dist", "build", "backups",
  ".DS_Store", ".vercel", "coverage", ".cache", ".turbo",
  "*.log", "apifolder_test.txt", "test.txt", "_test_creative.js",
]);

// Arquivos .env a copiar para /credentials (nomes exatos)
const ENV_FILES = [".env", ".env.local", ".env.production", ".env.staging"];

// ── Helpers ─────────────────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, "0"); }

function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

function shouldExclude(name) {
  if (EXCLUDE.has(name)) return true;
  // glob-style: *.log
  for (const pat of EXCLUDE) {
    if (pat.startsWith("*") && name.endsWith(pat.slice(1))) return true;
  }
  return false;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (shouldExclude(entry.name)) continue;
    const srcPath  = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function countFiles(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(path.join(dir, entry.name));
    else total++;
  }
  return total;
}

// ── README ───────────────────────────────────────────────────────────────────
function buildReadme(ts, hasCredentials) {
  const now = new Date().toLocaleString("pt-BR");
  return `# Backup do Projeto — Report Meta

**Data e hora:** ${now}
**Pasta:** backup-${ts}
**Projeto:** Report-Meta (Dashboard MetaEdge + Google Ads + Zoho CRM)

---

## Estado do projeto

Dashboard local full-stack com integração Meta Ads, Google Ads API e Zoho CRM.
Backend Express.js rodando em localhost:3000. Frontend vanilla JS + Chart.js.

---

## Features atuais

- Aba **Visão Geral** reformulada como painel executivo principal
- Comparativo Meta Ads × Google Ads × Consolidado (6 cards, tabela 12 métricas, 6 gráficos)
- Aba **Live Meta** com criativos ativos
  - Botão "Ver Criativo" → modal com preview 1080×1080
  - Colunas **Reuniões** e **Assinaturas** por criativo
  - Modal com nomes dos leads/deals por criativo (botão 🔍)
- Aba **Google Ads** restaurada com métricas nativas
  - Resumo: Investimento, Impressões, Cliques, CTR, CPC, Conversões
  - Tabela de campanhas com ordenação
  - Top 10 palavras-chave e Top 10 termos de pesquisa
  - Reuniões e Assinaturas Google Ads via Zoho CRM
- Aba **Tabela Detalhada** (MetaEdge) com cruzamento Zoho
- Botão global **"Buscar via API"** — atualiza todas as abas simultaneamente
  - Meta Ads + Google Ads + Zoho em paralelo
  - Painel de progresso com status em tempo real
- Classificação de reuniões e assinaturas Meta Ads
- Classificação de reuniões e assinaturas Google Ads
  - Regra de origem: Levantada de Mão / Site PipeLovers / WhatsApp PipeLovers
  - Regra de assinatura: stage = "Assinatura Realizada"

---

## Integrações

| Serviço       | Endpoint local                  | Observação                          |
|---------------|---------------------------------|-------------------------------------|
| Meta Ads      | /api/meta/insights, /api/meta/live | Insights + Live por período      |
| Google Ads    | /api/google-ads/*               | account, campaigns, keywords, search-terms |
| Zoho CRM      | /api/zoho/deals, /api/zoho/gads-deals | Cache 5 min server-side       |
| Slack         | /api/report/slack               | Envio de report                     |

---

## Abas do dashboard

1. Upload — carregamento via API global ou upload manual
2. Visão Geral — painel executivo consolidado Meta + Google
3. Live Meta — anúncios ativos com métricas em tempo real
4. Google Ads — métricas nativas Google Ads + Zoho CRM
5. Tabela Detalhada — cruzamento criativo Meta × deals Zoho
6. CRM — visão de negócios Zoho
7. Regras de Reuniões / Assinaturas / Classificações / Integrações / APIs

---

## Stack técnica

- **Backend:** Node.js + Express.js (server.js)
- **Frontend:** Vanilla JS + Chart.js (script.js, index.html, style.css)
- **Serviços:** services/ (metaService, googleAdsService, zohoService, slackService)
- **Config:** config/fieldMap.js — mapeamento de campos Zoho CRM

---

## Observações importantes

- Todas as chamadas de API passam pelo servidor local (localhost:3000) — nunca expostas ao browser diretamente.
- O cache do Zoho é de 5 minutos server-side (getDeals usa cache, getReport não é usado).
- O botão "Buscar via API" usa Promise.allSettled — falha parcial não bloqueia as outras fontes.
${hasCredentials ? `
---

## Credenciais

> **ATENÇÃO:** Este backup contém credenciais locais na pasta \`/credentials\`.
> **Não subir esta pasta para GitHub.**
> **Não compartilhar este backup publicamente.**
> Os arquivos de credenciais são cópias locais apenas para recuperação de emergência.
` : ""}
---

*Backup gerado automaticamente por scripts/create-backup.js*
`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
function run() {
  const ts      = timestamp();
  const destDir = path.join(BACKUPS_DIR, `backup-${ts}`);

  console.log(`\nIniciando backup → ${destDir}\n`);

  // 1. Copia o projeto (excluindo os itens da lista EXCLUDE)
  copyDir(PROJECT_ROOT, destDir);
  console.log("✓ Arquivos do projeto copiados");

  // 2. Copia .env para /credentials (se existir)
  let hasCredentials = false;
  const credDir = path.join(destDir, "credentials");
  for (const envFile of ENV_FILES) {
    const src = path.join(PROJECT_ROOT, envFile);
    if (fs.existsSync(src)) {
      if (!hasCredentials) fs.mkdirSync(credDir, { recursive: true });
      fs.copyFileSync(src, path.join(credDir, envFile));
      hasCredentials = true;
      console.log(`✓ ${envFile} copiado para /credentials`);
    }
  }
  if (!hasCredentials) {
    console.log("  (nenhum arquivo .env encontrado para copiar)");
  }

  // 3. Cria README.md dentro do backup
  const readmePath = path.join(destDir, "BACKUP_README.md");
  fs.writeFileSync(readmePath, buildReadme(ts, hasCredentials), "utf8");
  console.log("✓ BACKUP_README.md criado");

  // 4. Contagem de arquivos
  const total = countFiles(destDir);
  console.log(`✓ Total de arquivos no backup: ${total}`);

  console.log(`\nBackup criado com sucesso em: backups/backup-${ts}\n`);
}

run();
