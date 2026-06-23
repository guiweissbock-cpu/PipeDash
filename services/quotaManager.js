/**
 * quotaManager.js
 * Controle de quota da Google Ads API — Basic Access (15.000 ops/dia).
 *
 * Regras implementadas:
 *  - Orçamento operacional seguro: 12.000 ops/dia (80% de 15.000)
 *  - Limite por plano: 2.400 ops (5 planos × 2.400 = 12.000)
 *  - Cache de resultados em memória (TTL 12h) para reusar sem custar ops
 *  - Custo fixo por chamada generateKeywordIdeas: 100 ops
 *  - Alerta ao atingir 80% do limite seguro
 *  - Estado persistido em _quota_state.json (reset automático a cada dia)
 */

"use strict";

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

// ─── Constantes ──────────────────────────────────────────────────────────────
const DAILY_LIMIT    = 15_000;
const SAFE_LIMIT     = 12_000;  // 80% — nunca ultrapassar
const PER_PLAN_LIMIT = 2_400;   // 5 planos × 2.400 = 12.000
const COST_PER_CALL  = 100;     // custo fixo por chamada generateKeywordIdeas
const ALERT_PCT      = 0.80;    // alerta ao chegar em 80% do SAFE_LIMIT

const STATE_FILE = path.join(__dirname, "..", "_quota_state.json");

// ─── Estado em memória ────────────────────────────────────────────────────────
let _state = null;        // { date, totalUsed, plans: {planId: opsUsed} }
const _cache = new Map(); // key -> { data, expires }

// ─── Helpers de data ─────────────────────────────────────────────────────────
function _today() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// ─── Persistência do estado ───────────────────────────────────────────────────
function _loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const s   = JSON.parse(raw);
    if (s.date === _today()) return s;
    // Novo dia — zera tudo
    console.log("[Quota] Novo dia detectado — zerando contadores.");
  } catch { /* arquivo não existe ou corrompido */ }
  return { date: _today(), totalUsed: 0, plans: {} };
}

function _saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      date:      _state.date,
      totalUsed: _state.totalUsed,
      plans:     _state.plans,
    }, null, 2));
  } catch (e) {
    console.warn("[Quota] Falha ao salvar estado:", e.message);
  }
}

function _ensureLoaded() {
  if (!_state || _state.date !== _today()) {
    _state = _loadState();
  }
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Retorna status completo da quota.
 * @param {string|null} planId  ID do plano em execução (opcional)
 */
function getStatus(planId = null) {
  _ensureLoaded();
  const planUsed      = planId ? (_state.plans[planId] || 0) : 0;
  const totalRemaining = Math.max(0, SAFE_LIMIT - _state.totalUsed);
  const planRemaining  = Math.max(0, PER_PLAN_LIMIT - planUsed);
  const pctUsed        = _state.totalUsed / SAFE_LIMIT;

  let alertLevel = null;
  if (pctUsed >= 1.0)         alertLevel = "critical";
  else if (pctUsed >= ALERT_PCT) alertLevel = "warning";

  return {
    dailyLimit:      DAILY_LIMIT,
    safeLimit:       SAFE_LIMIT,
    perPlanLimit:    PER_PLAN_LIMIT,
    costPerCall:     COST_PER_CALL,
    totalUsed:       _state.totalUsed,
    totalRemaining,
    pctUsed:         Math.round(pctUsed * 100),
    planId,
    planUsed,
    planRemaining,
    alertLevel,
    cacheEntries:    _cacheSize(),
  };
}

/**
 * Verifica se há orçamento disponível para `cost` operações.
 * Considera tanto o limite diário quanto o limite por plano.
 */
function canAfford(cost = COST_PER_CALL, planId = null) {
  _ensureLoaded();
  const planUsed = planId ? (_state.plans[planId] || 0) : 0;
  const okTotal  = (_state.totalUsed + cost) <= SAFE_LIMIT;
  const okPlan   = !planId || (planUsed + cost) <= PER_PLAN_LIMIT;
  return okTotal && okPlan;
}

/**
 * Registra consumo de `cost` operações.
 * Nunca deixa ultrapassar o limite hard (SAFE_LIMIT).
 */
function consume(cost = COST_PER_CALL, planId = null) {
  _ensureLoaded();
  const effective = Math.min(cost, SAFE_LIMIT - _state.totalUsed); // não passa do teto
  _state.totalUsed = Math.min(_state.totalUsed + effective, SAFE_LIMIT);
  if (planId) {
    _state.plans[planId] = Math.min(
      (_state.plans[planId] || 0) + effective,
      PER_PLAN_LIMIT
    );
  }
  _saveState();

  const s = getStatus(planId);
  console.log(
    `[Quota] +${effective} ops | total=${s.totalUsed}/${SAFE_LIMIT} (${s.pctUsed}%)` +
    (planId ? ` | plano=${s.planUsed}/${PER_PLAN_LIMIT}` : "")
  );
  if (s.alertLevel === "warning")  console.warn("[Quota] ⚠️  Atenção: 80% da quota segura consumida!");
  if (s.alertLevel === "critical") console.error("[Quota] 🚨 CRÍTICO: quota segura esgotada!");
  return s;
}

/**
 * Calcula o pageSize máximo que pode ser solicitado à API
 * dado o orçamento restante (budget - COST_PER_CALL).
 * Nunca excede maxPageSize (padrão 200).
 */
function affordablePageSize(planId = null, maxPageSize = 200) {
  const s = getStatus(planId);
  const headroom = Math.min(s.planRemaining, s.totalRemaining) - COST_PER_CALL;
  if (headroom <= 0) return 0;
  return Math.min(maxPageSize, headroom);
}

// ─── Cache ────────────────────────────────────────────────────────────────────

function _cacheKey(seeds = [], opts = {}) {
  const raw = JSON.stringify({ s: [...seeds].sort(), o: opts });
  return crypto.createHash("md5").update(raw).digest("hex");
}

function _cacheSize() {
  let n = 0;
  const now = Date.now();
  for (const [k, v] of _cache) {
    if (now > v.expires) _cache.delete(k);
    else n++;
  }
  return n;
}

/**
 * Busca resultado em cache.
 * @returns {Array|null}  Array de keyword ideas ou null se ausente/expirado.
 */
function cacheGet(seeds, opts = {}) {
  const key   = _cacheKey(seeds, opts);
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { _cache.delete(key); return null; }
  console.log(`[Quota] Cache HIT — ${entry.data.length} ideias para ${seeds.slice(0,2).join(", ")}...`);
  return entry.data;
}

/**
 * Armazena resultado em cache.
 * @param {number} ttlMs  Tempo de vida em ms (padrão 12h)
 */
function cacheSet(seeds, opts = {}, data, ttlMs = 12 * 60 * 60 * 1000) {
  const key = _cacheKey(seeds, opts);
  _cache.set(key, { data, expires: Date.now() + ttlMs });
  console.log(`[Quota] Cache SET — ${data.length} ideias (TTL ${Math.round(ttlMs / 3600000)}h)`);
}

/**
 * Invalida todo o cache em memória.
 */
function cacheClear() {
  _cache.clear();
  console.log("[Quota] Cache limpo.");
}

// ─── Export ───────────────────────────────────────────────────────────────────
module.exports = {
  getStatus,
  canAfford,
  consume,
  affordablePageSize,
  cacheGet,
  cacheSet,
  cacheClear,
  // Constantes expostas para referência
  DAILY_LIMIT,
  SAFE_LIMIT,
  PER_PLAN_LIMIT,
  COST_PER_CALL,
};
