/**
 * pre-deploy-check.js
 * Valida o repositório antes de fazer commit/push para o GitHub.
 * Uso: node scripts/pre-deploy-check.js
 */

const { execSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// Arquivos e pastas que NUNCA devem ser versionados
const BLOCKED = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.staging",
  "node_modules",
  "slack_mql_cache.json",
  "backups/",
  "credentials/",
];

let errors   = [];
let warnings = [];

// ── 1. Verifica se git está disponível ───────────────────────────────────────
try {
  execSync("git rev-parse --git-dir", { cwd: ROOT, stdio: "ignore" });
} catch {
  console.error("✗ Este diretório não é um repositório git.");
  process.exit(1);
}

// ── 2. Coleta arquivos staged (git add) ──────────────────────────────────────
let staged = "";
try {
  staged = execSync("git diff --cached --name-only", { cwd: ROOT }).toString();
} catch {
  warnings.push("Não foi possível ler os arquivos staged (nenhum commit ainda?).");
}

const stagedFiles = staged.split("\n").map(f => f.trim()).filter(Boolean);

// ── 3. Checa arquivos proibidos no stage ─────────────────────────────────────
for (const blocked of BLOCKED) {
  const hit = stagedFiles.find(f =>
    f === blocked || f.startsWith(blocked.replace(/\/$/, "/"))
  );
  if (hit) {
    errors.push(`ARQUIVO SENSÍVEL STAGED: "${hit}" — remova com: git reset HEAD "${hit}"`);
  }
}

// ── 4. Checa se .env existe mas está no .gitignore ───────────────────────────
const fs = require("fs");
const envPath = path.join(ROOT, ".env");
if (fs.existsSync(envPath)) {
  try {
    const ignored = execSync(`git check-ignore -q "${envPath}"`, { cwd: ROOT, stdio: "pipe" });
    // se não lançou erro, está ignorado — ok
  } catch {
    warnings.push(".env existe mas pode não estar sendo ignorado pelo git. Verifique o .gitignore.");
  }
}

// ── 5. Checa se há arquivos não-staged (lembrete) ────────────────────────────
let unstaged = "";
try {
  unstaged = execSync("git diff --name-only", { cwd: ROOT }).toString();
} catch {}
const unstagedFiles = unstaged.split("\n").map(f => f.trim()).filter(Boolean);

// ── 6. Verifica se server.js existe ──────────────────────────────────────────
if (!fs.existsSync(path.join(ROOT, "server.js"))) {
  errors.push("server.js não encontrado na raiz do projeto.");
}
if (!fs.existsSync(path.join(ROOT, "index.html"))) {
  errors.push("index.html não encontrado na raiz do projeto.");
}
if (!fs.existsSync(path.join(ROOT, "vercel.json"))) {
  warnings.push("vercel.json não encontrado — deploy na Vercel pode falhar.");
}

// ── 7. Exibe resultado ───────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════");
console.log("  PRE-DEPLOY CHECK — PipeDash");
console.log("══════════════════════════════════════════\n");

console.log("📁 Arquivos staged para commit:");
if (stagedFiles.length === 0) {
  console.log("   (nenhum arquivo staged — rode: git add <arquivos>)\n");
} else {
  stagedFiles.forEach(f => console.log(`   + ${f}`));
  console.log();
}

if (unstagedFiles.length > 0) {
  console.log("⚠  Arquivos modificados mas NÃO staged:");
  unstagedFiles.forEach(f => console.log(`   ~ ${f}`));
  console.log();
}

if (warnings.length > 0) {
  console.log("⚠  Avisos:");
  warnings.forEach(w => console.log(`   ! ${w}`));
  console.log();
}

if (errors.length > 0) {
  console.log("✗  ERROS — corrija antes de fazer push:");
  errors.forEach(e => console.log(`   ✗ ${e}`));
  console.log("\n══════════════════════════════════════════");
  console.log("  BLOQUEADO — não faça push com esses erros.");
  console.log("══════════════════════════════════════════\n");
  process.exit(1);
}

console.log("✓  Nenhum arquivo sensível detectado.");
console.log("✓  Estrutura do projeto ok.");
console.log("\n══════════════════════════════════════════");
console.log("  APROVADO — seguro para commit e push.");
console.log("══════════════════════════════════════════\n");

console.log("Próximos passos:");
console.log("  git commit -m \"Descrição da alteração\"");
console.log("  git push origin main");
console.log("  → Vercel fará o deploy automaticamente.\n");
