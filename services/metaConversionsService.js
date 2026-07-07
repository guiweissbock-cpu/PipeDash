/**
 * services/metaConversionsService.js
 * Envia eventos de conversão ("Reunião Agendada") para a Meta Conversions API.
 *
 * Env vars necessárias:
 *   META_PIXEL_ID       — ID do Pixel da Meta
 *   META_ACCESS_TOKEN   — Token de acesso
 *   META_APP_SECRET     — App Secret (appsecret_proof)
 *   META_API_VERSION    — versão (padrão: v23.0)
 */

const crypto  = require("crypto");
const https   = require("https");
const fs      = require("fs");
const path    = require("path");

const zohoService      = require("./zohoService");
const sheetsLogService = require("./sheetsLogService");
const { normalizeKey } = require("../utils/normalize");

// ── Constantes ────────────────────────────────────────────────────────────────

const MEETING_STAGES = new Set(["reuniao agendada", "reuniao realizada"]);

// ── Persistência ──────────────────────────────────────────────────────────────

// Vercel: filesystem read-only exceto /tmp (efêmero entre cold starts)
const DATA_DIR = process.env.VERCEL ? "/tmp" : path.join(__dirname, "..", "data");
const LOG_FILE = path.join(DATA_DIR, "transferencia_log.json");

function ensureDataDir() {
  if (process.env.VERCEL) return; // /tmp já existe
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (_) {}
}

function loadLog() {
  ensureDataDir();
  if (!fs.existsSync(LOG_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(LOG_FILE, "utf8")); }
  catch (_) { return []; }
}

function saveLog(entries) {
  ensureDataDir();
  fs.writeFileSync(LOG_FILE, JSON.stringify(entries, null, 2), "utf8");
}

// Upsert: atualiza entrada existente (incrementa attempts) ou cria nova
function upsertEntry(log, dedupeKey, data) {
  const idx = log.findIndex((e) => e.dedupeKey === dedupeKey);
  if (idx >= 0) {
    const prev = log[idx];
    log[idx] = {
      ...prev,
      ...data,
      attempts:     (prev.attempts || 1) + 1,
      lastAttempt:  data.sentAt || new Date().toISOString(),
      firstAttempt: prev.firstAttempt || prev.sentAt || data.sentAt,
    };
  } else {
    log.push({ ...data, attempts: 1, firstAttempt: data.sentAt, lastAttempt: data.sentAt });
  }
}

function alreadySent(log, dedupeKey) {
  return log.some((e) => e.dedupeKey === dedupeKey && e.status === "success");
}

// ── Hashing PII ───────────────────────────────────────────────────────────────

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function normalizeEmail(v)  { return String(v || "").toLowerCase().trim(); }
function normalizePhone(v)  {
  const d = String(v || "").replace(/\D/g, "");
  return (d.length === 10 || d.length === 11) ? "55" + d : d;
}
function buildUserDataHashes(contact) {
  const r = {};
  if (!contact) return r;
  const email = normalizeEmail(contact.email);
  const phone = normalizePhone(contact.phone);
  if (email)             r.em = [sha256(email)];
  if (phone)             r.ph = [sha256(phone)];
  if (contact.firstName) r.fn = [sha256(normalizeKey(contact.firstName))];
  if (contact.lastName)  r.ln = [sha256(normalizeKey(contact.lastName))];
  return r;
}

function buildMaskedPayload(payload) {
  const m  = JSON.parse(JSON.stringify(payload));
  const ud = m.user_data || {};
  if (ud.em)          ud.em          = ["[SHA256]"];
  if (ud.ph)          ud.ph          = ["[SHA256]"];
  if (ud.fn)          ud.fn          = ["[SHA256]"];
  if (ud.ln)          ud.ln          = ["[SHA256]"];
  if (ud.external_id) ud.external_id = ["[SHA256]"];
  return m;
}

// ── Parsing de erros da Meta API ──────────────────────────────────────────────

function parseMetaError(errorMessage) {
  const msg  = String(errorMessage || "").toLowerCase();
  const code = (() => {
    const m = String(errorMessage || "").match(/\(#?(\d+)\)/);
    return m ? m[1] : null;
  })();

  if (msg.includes("access token") || msg.includes("oauth") || code === "190" || code === "102") {
    return {
      errorCode:    code || "190",
      errorField:   "META_ACCESS_TOKEN",
      suggestion:   "Access Token inválido ou expirado. Atualize META_ACCESS_TOKEN no .env",
      canRetry:     true,
    };
  }
  if (msg.includes("pixel") || msg.includes("dataset") || code === "100") {
    return {
      errorCode:    code || "100",
      errorField:   "META_PIXEL_ID",
      suggestion:   "Pixel ID inválido. Verifique META_PIXEL_ID no .env (não é o Ad Account ID)",
      canRetry:     true,
    };
  }
  if (msg.includes("duplicate") || msg.includes("dedup")) {
    return {
      errorCode:    "dedup",
      errorField:   "event_id",
      suggestion:   "Evento duplicado. A Meta já recebeu este event_id anteriormente",
      canRetry:     false,
    };
  }
  if (msg.includes("user_data") || msg.includes("required")) {
    return {
      errorCode:    "missing_data",
      errorField:   "user_data",
      suggestion:   "Dados obrigatórios ausentes. O lead precisa ter ao menos email ou telefone",
      canRetry:     false,
    };
  }
  if (msg.includes("email") || msg.includes("em")) {
    return {
      errorCode:    "invalid_email",
      errorField:   "user_data.em",
      suggestion:   "E-mail ausente ou inválido. Revise o cadastro do lead na planilha",
      canRetry:     true,
    };
  }
  if (msg.includes("phone") || msg.includes("ph")) {
    return {
      errorCode:    "invalid_phone",
      errorField:   "user_data.ph",
      suggestion:   "Telefone ausente ou inválido. Corrija o telefone no cadastro do lead",
      canRetry:     true,
    };
  }
  if (msg.includes("permission") || code === "200") {
    return {
      errorCode:    code || "200",
      errorField:   "permissions",
      suggestion:   "Sem permissão para enviar eventos. Verifique as permissões do App na Meta",
      canRetry:     false,
    };
  }
  if (msg.includes("timeout")) {
    return {
      errorCode:    "timeout",
      errorField:   "network",
      suggestion:   "Timeout na conexão com a Meta. Tente novamente em alguns minutos",
      canRetry:     true,
    };
  }
  return {
    errorCode:    code || "unknown",
    errorField:   null,
    suggestion:   "Erro desconhecido. Verifique os logs e tente novamente",
    canRetry:     true,
  };
}

// ── Classificadores ───────────────────────────────────────────────────────────

function isMeetingStage(stage) {
  return MEETING_STAGES.has(normalizeKey(String(stage || "")));
}

// ── Payload builder ───────────────────────────────────────────────────────────

// contact = { email, phone, firstName, lastName } — vem do Zoho Contacts API
function buildPayload(contact, deal) {
  const hashes   = buildUserDataHashes(contact);
  const userData = { ...hashes };

  if (deal.metaLeadId) userData.lead_id     = deal.metaLeadId;
  if (deal.id)         userData.external_id  = [sha256(String(deal.id))];

  const eventTime = deal.createdTime
    ? Math.floor(new Date(deal.createdTime).getTime() / 1000)
    : Math.floor(Date.now() / 1000);

  const dedupeKey = `zoho_${deal.id}_reuniao`;

  return {
    event_name:    "Schedule",
    event_time:    eventTime,
    action_source: "system_generated",
    event_id:      dedupeKey,
    user_data:     userData,
    custom_data: {
      currency:        "BRL",
      value:           1,
      conversion_type: "reuniao_agendada",
      lead_status:     deal.stage,
      source:          "Meta Ads",
      campanha:        deal.metaCampaign || "",
      anuncio:         deal.metaAdName   || "",
    },
  };
}

// ── POST Meta Conversions API ─────────────────────────────────────────────────

function appsecretProof(token, secret) {
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}

function postToMeta(pixelId, payload) {
  return new Promise((resolve, reject) => {
    const token  = process.env.META_ACCESS_TOKEN;
    const secret = process.env.META_APP_SECRET;
    const proof  = appsecretProof(token, secret);

    const body = JSON.stringify({
      data:            [payload],
      access_token:    token,
      appsecret_proof: proof,
    });

    const opts = {
      hostname: "graph.facebook.com",
      path:     `/${process.env.META_API_VERSION || "v23.0"}/${pixelId}/events`,
      method:   "POST",
      timeout:  15000,
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };

    const req = https.request(opts, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(raw);
          if (res.statusCode >= 400) reject(new Error(json.error?.message || raw.slice(0, 300)));
          else resolve({ statusCode: res.statusCode, body: json });
        } catch (_) { reject(new Error(raw.slice(0, 300))); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout na Meta API")); });
    req.write(body);
    req.end();
  });
}

// ── Orquestrador ──────────────────────────────────────────────────────────────
// Fonte de dados: Zoho CRM (deals + contacts).
// A planilha de log serve apenas para: verificar já-enviados, registrar resultados.

async function run({ dryRun = false, targetDedupeKey = null, since = null, until = null } = {}) {
  const pixelId = process.env.META_PIXEL_ID;

  if (!dryRun) {
    if (!pixelId) throw new Error("META_PIXEL_ID não configurado no .env");
    if (!process.env.META_ACCESS_TOKEN || !process.env.META_APP_SECRET)
      throw new Error("META_ACCESS_TOKEN ou META_APP_SECRET não configurados no .env");
  }

  // Zoho e log em paralelo
  const [zohoDeals, log] = await Promise.all([
    zohoService.getDeals(),
    getLog(),
  ]);

  // Elegíveis: stage + (metaAdName OU metaLeadId preenchido)
  let pairs = zohoDeals
    .filter(d => isMeetingStage(d.stage) && !!(d.metaAdName || d.metaLeadId))
    .map(deal => ({ deal }));

  // Filtro de período (data de criação do deal no Zoho)
  if (since || until) {
    const sinceDate = since ? new Date(since) : null;
    const untilDate = until ? new Date(until + "T23:59:59") : null;
    pairs = pairs.filter(({ deal }) => {
      if (!deal.createdTime) return true;
      const d = new Date(deal.createdTime);
      if (sinceDate && d < sinceDate) return false;
      if (untilDate && d > untilDate) return false;
      return true;
    });
  }

  // Modo retry: filtra apenas o deal alvo
  if (targetDedupeKey) {
    pairs = pairs.filter(({ deal }) => `zoho_${deal.id}_reuniao` === targetDedupeKey);
    if (!pairs.length) throw new Error(`Deal não encontrado ou não é elegível: ${targetDedupeKey}`);
  }

  // Pré-carrega contatos do Zoho para todos os deals elegíveis (paralelizado)
  const contactIds = [...new Set(pairs.map(p => p.deal.contactId).filter(Boolean))];
  const contactMap = {};
  await Promise.all(
    contactIds.map(id =>
      zohoService.getContactById(id)
        .then(c => { if (c) contactMap[id] = c; })
        .catch(e => console.warn(`[Zoho Contact ${id}]`, e.message))
    )
  );

  const summary = {
    totalElegiveis: pairs.length,
    enviados: 0, duplicatas: 0, semPii: 0, erros: 0, pendentes: 0,
    items: [],
  };

  for (const { deal } of pairs) {
    const dedupeKey = `zoho_${deal.id}_reuniao`;
    const now       = new Date().toISOString();
    const contact   = deal.contactId ? (contactMap[deal.contactId] || null) : null;

    const baseItem = {
      dedupeKey,
      nomeNegocio:  deal.dealName     || "",
      nomeContato:  contact
        ? `${contact.firstName} ${contact.lastName}`.trim() || deal.contactName
        : deal.contactName || "",
      email:        contact?.email    || "",
      telefone:     contact?.phone    || "",
      leadId:       deal.metaLeadId   || "",
      metaAdsId:    deal.metaAdId     || "",
      formId:       "",
      campanha:     deal.metaCampaign || "",
      anuncio:      deal.metaAdName   || "",
      stage:        deal.stage,
      dataZoho:     deal.createdTime  || "",
      eventName:    "Schedule",
      eventId:      dedupeKey,
      sentAt:       now,
    };

    // Preview: mostra todos com status real do log
    if (dryRun) {
      const logEntry = log.find(e => e.dedupeKey === dedupeKey);
      const status = !logEntry
        ? "pendente"
        : logEntry.status === "success" ? "enviado_sucesso" : logEntry.status;
      summary.items.push({
        ...baseItem, status,
        ...(logEntry ? {
          attempts:        logEntry.attempts,
          sentAt:          logEntry.sentAt || baseItem.sentAt,
          errorMessage:    logEntry.errorMessage    || null,
          errorCode:       logEntry.errorCode       || null,
          errorField:      logEntry.errorField      || null,
          errorSuggestion: logEntry.errorSuggestion || null,
          canRetry:        logEntry.canRetry        || false,
        } : { attempts: 0, canRetry: false }),
      });
      if (status === "enviado_sucesso") summary.duplicatas++;
      else if (status === "erro")       summary.erros++;
      else if (status === "sem_pii")    summary.semPii++;
      else                              summary.pendentes++;
      continue;
    }

    // Send: pula leads já enviados com sucesso
    if (!targetDedupeKey && alreadySent(log, dedupeKey)) {
      summary.duplicatas++;
      continue;
    }

    // PII do contato Zoho — fonte oficial
    if (!contact || (!contact.email && !contact.phone)) {
      const entry = {
        ...baseItem, status: "sem_pii",
        errorMessage:    "Lead elegível no Zoho CRM, mas sem e-mail ou telefone disponível para envio.",
        errorCode:       "missing_pii",
        errorField:      "user_data",
        errorSuggestion: "Adicione e-mail ou telefone no contato do Zoho CRM",
        canRetry:        true,
      };
      upsertEntry(log, dedupeKey, entry);
      if (sheetsLogService.isConfigured()) {
        const se = log.find(e => e.dedupeKey === dedupeKey) || entry;
        sheetsLogService.upsertEntry(se).catch(e => console.warn("[SheetsLog]", e.message));
      }
      summary.semPii++;
      summary.items.push(entry);
      continue;
    }

    const payload       = buildPayload(contact, deal);
    const maskedPayload = buildMaskedPayload(payload);

    try {
      const apiRes = await postToMeta(pixelId, payload);
      const entry  = {
        ...baseItem,
        status:          "success",
        maskedPayload,
        metaResponse:    apiRes.body,
        metaEvents:      apiRes.body?.events_received ?? null,
        metaTraceId:     apiRes.body?.fbtrace_id || null,
        errorMessage:    null, errorCode: null,
        errorField:      null, errorSuggestion: null,
        canRetry:        false,
      };
      upsertEntry(log, dedupeKey, entry);
      if (sheetsLogService.isConfigured()) {
        const se = log.find(e => e.dedupeKey === dedupeKey) || entry;
        sheetsLogService.upsertEntry(se).catch(e => console.warn("[SheetsLog]", e.message));
      }
      summary.enviados++;
      summary.items.push(entry);
    } catch (err) {
      const parsed = parseMetaError(err.message);
      const entry  = {
        ...baseItem,
        status:       "erro",
        maskedPayload,
        metaResponse: null, metaEvents: null, metaTraceId: null,
        errorMessage: err.message,
        ...parsed,
      };
      upsertEntry(log, dedupeKey, entry);
      if (sheetsLogService.isConfigured()) {
        const se = log.find(e => e.dedupeKey === dedupeKey) || entry;
        sheetsLogService.upsertEntry(se).catch(e => console.warn("[SheetsLog]", e.message));
      }
      summary.erros++;
      summary.items.push(entry);
    }
  }

  if (!dryRun) saveLog(log);
  return summary;
}

// ── Retry de uma entrada específica ──────────────────────────────────────────

async function retry(dedupeKey) {
  return run({ dryRun: false, targetDedupeKey: dedupeKey });
}

// ── Stats a partir do log ─────────────────────────────────────────────────────

async function getStats() {
  const log  = await getLog();
  const now  = new Date();
  const todayStart  = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart   = new Date(+todayStart - 6 * 86400000);
  const monthStart  = new Date(now.getFullYear(), now.getMonth(), 1);

  const stats = {
    hoje: 0, semana: 0, mes: 0,
    total: 0, sucessos: 0, erros: 0, semPii: 0, duplicatas: 0,
    taxa: 0,
    porDia: {},
  };

  for (const e of log) {
    if (!e.sentAt) continue;
    const d       = new Date(e.sentAt);
    const dateKey = e.sentAt.slice(0, 10);

    if (d >= todayStart) stats.hoje++;
    if (d >= weekStart)  stats.semana++;
    if (d >= monthStart) stats.mes++;

    stats.total++;
    if (e.status === "success")   stats.sucessos++;
    else if (e.status === "erro") stats.erros++;
    else if (e.status === "sem_pii") stats.semPii++;
    else if (e.status === "duplicata") stats.duplicatas++;

    if (!stats.porDia[dateKey]) stats.porDia[dateKey] = { success: 0, erro: 0, total: 0 };
    stats.porDia[dateKey].total++;
    if (e.status === "success") stats.porDia[dateKey].success++;
    else if (e.status === "erro") stats.porDia[dateKey].erro++;
  }

  stats.taxa = stats.total > 0
    ? Math.round((stats.sucessos / stats.total) * 100)
    : 0;

  return stats;
}

async function getLog() {
  if (sheetsLogService.isConfigured()) {
    try { return await sheetsLogService.getLog(); }
    catch (err) { console.error("[SheetsLog] Fallback para arquivo local:", err.message); }
  }
  return loadLog();
}

function examplePayload() {
  const fakeContact = {
    email: "joao.silva@exemplo.com", phone: "11987654321",
    firstName: "João", lastName: "Silva",
  };
  const fakeDeal = {
    id: "zoho_deal_abc123", dealName: "João Silva - PipeLovers",
    contactName: "João Silva", contactId: "contact_abc123",
    stage: "Reunião Agendada", createdTime: new Date().toISOString(),
    metaLeadId: "1234567890", metaAdId: "23854321098760143",
    metaAdName: "Video Aula Grátis 30s",
    metaCampaign: "PipeLovers - TOFU", metaCampaignId: "6509876543210",
  };
  return buildMaskedPayload(buildPayload(fakeContact, fakeDeal));
}

module.exports = { run, retry, getLog, getStats, examplePayload };
