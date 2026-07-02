/**
 * services/formLeadsService.js
 * Recebe, parseia e armazena leads do formulário Elementor via Pluga.
 *
 * Storage:
 *   - Local dev : persiste em data/form_leads.json (não sobe ao git)
 *   - Vercel    : /tmp (memória por execução — dados perdidos no cold start)
 *   - Produção  : migrar para Supabase substituindo addLead() / getLeads()
 */

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const IS_VERCEL = !!process.env.VERCEL;
const DATA_FILE = IS_VERCEL
  ? "/tmp/form_leads.json"
  : path.join(__dirname, "../data/form_leads.json");

const MAX_LEADS = 1000;

let cache       = null; // null = não carregado ainda

// ── Disco ─────────────────────────────────────────────────────────────────────

function load() {
  if (cache !== null) return;
  try {
    cache = fs.existsSync(DATA_FILE)
      ? JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
      : [];
  } catch (_) {
    cache = [];
  }
}

function persist() {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2), "utf8");
  } catch (err) {
    // Ignora silenciosamente em Vercel quando /tmp está cheio
    if (!IS_VERCEL) console.warn("[FormLeads] Erro ao salvar em disco:", err.message);
  }
}

// ── Parsing do payload Pluga ──────────────────────────────────────────────────

function field(fields, ...keys) {
  for (const k of keys) {
    const v = fields[k]?.value;
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function classifyChannel(r) {
  const src = r.utm_source.toLowerCase();
  const med = r.utm_medium.toLowerCase();

  if (r.gclid || r.gbraid)                                                   return "Google Ads";
  if (src.includes("google") &&
      (med === "cpc" || med.includes("paid") || med.includes("search")))      return "Google Ads";

  if (r.fbclid)                                                               return "Meta Ads";
  if (src.includes("facebook") || src.includes("instagram") ||
      src.includes("meta"))                                                    return "Meta Ads";
  if (med === "paid_social")                                                  return "Meta Ads";

  if (med === "organic" || med === "seo")                                     return "Orgânico";
  if (med === "referral")                                                     return "Referral";
  if (med === "email" || med === "newsletter")                                return "Email";
  if (med === "cpc" || med === "paid")                                        return "Pago";

  return "Direto";
}

function parsePayload(body) {
  const f    = body.fields || {};
  const form = body.form   || {};

  const firstName = field(f, "first_name", "nome");
  const lastName  = field(f, "last_name",  "sobrenome");
  const fullName  = [firstName, lastName].filter(Boolean).join(" ")
                    || field(f, "full_name", "nome_completo", "name");

  const rec = {
    id:           crypto.randomBytes(8).toString("hex"),
    received_at:  body.__plg_received_at || new Date().toISOString(),
    form_id:      form.id   || "",
    form_name:    form.name || "",
    first_name:   firstName,
    last_name:    lastName,
    full_name:    fullName,
    email:        field(f, "email"),
    phone:        field(f, "phone", "telefone", "celular", "whatsapp"),
    company_name: field(f, "company_name", "empresa", "company"),
    job_title:    field(f, "job_title", "cargo"),
    utm_source:   field(f, "utm_source"),
    utm_medium:   field(f, "utm_medium"),
    utm_campaign: field(f, "utm_campaign"),
    utm_content:  field(f, "utm_content"),
    utm_keyword:  field(f, "utm_keyword", "utm_term"),
    searchterm:   field(f, "searchterm", "search_term"),
    utm_group:    field(f, "utm_group"),
    gclid:        field(f, "gclid"),
    gbraid:       field(f, "gbraid"),
    fbclid:       field(f, "fbclid"),
    page_url:     field(f, "page_url", "url"),
    user_agent:   field(f, "user_agent"),
    user_ip:      field(f, "user_ip"),
  };

  rec.channel = classifyChannel(rec);
  return rec;
}

// ── API pública ───────────────────────────────────────────────────────────────

function addLead(body) {
  load();
  const lead = parsePayload(body);
  cache.unshift(lead);
  if (cache.length > MAX_LEADS) cache.length = MAX_LEADS;
  persist();
  return lead;
}

function getLeads(filters = {}) {
  load();
  let result = [...cache];

  if (filters.since) {
    const since = new Date(filters.since);
    result = result.filter(l => new Date(l.received_at) >= since);
  }
  if (filters.until) {
    const until = new Date(filters.until);
    until.setHours(23, 59, 59, 999);
    result = result.filter(l => new Date(l.received_at) <= until);
  }
  if (filters.canal) {
    const canal = filters.canal.toLowerCase();
    result = result.filter(l => (l.channel || "").toLowerCase() === canal);
  }
  if (filters.campanha) {
    const cp = filters.campanha.toLowerCase();
    result = result.filter(l => (l.utm_campaign || "").toLowerCase().includes(cp));
  }
  if (filters.email) {
    const em = filters.email.toLowerCase();
    result = result.filter(l => (l.email || "").toLowerCase().includes(em));
  }

  return result;
}

module.exports = { addLead, getLeads, parsePayload };
