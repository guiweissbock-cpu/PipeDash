const fs   = require("fs");
const path = require("path");

const CACHE_FILE = path.join(__dirname, "..", "slack_mql_cache.json");
const SLACK_API  = "https://slack.com/api";

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseLeadMessage(text) {
  const get = (label) => {
    const m = text.match(new RegExp(`${label}:\\s*(.+)`));
    return m ? m[1].trim() : "";
  };
  return {
    nome:     get("Nome"),
    empresa:  get("Empresa"),
    email:    get("E-mail"),
    telefone: get("Telefone"),
    cargo:    get("Cargo"),
    fonte:    get("Fonte"),
  };
}

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    const data = JSON.parse(raw);
    return { ok: true, leads: data.leads || [], updatedAt: data.updatedAt };
  } catch {
    return { ok: false, leads: [], updatedAt: null };
  }
}

async function slackGet(method, params) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN não configurado");
  const qs  = new URLSearchParams({ ...params, token });
  const res = await fetch(`${SLACK_API}/${method}?${qs}`);
  const json = await res.json();
  if (!json.ok) throw new Error(`Slack ${method}: ${json.error}`);
  return json;
}

async function getMqlLeads(channelId = "C05G0BZ904W", limit = 200) {
  // Tenta API live primeiro; se falhar, usa cache local
  const token = process.env.SLACK_BOT_TOKEN;
  if (token) {
    try {
      const history = await slackGet("conversations.history", {
        channel: channelId,
        limit:   Math.min(limit, 200),
      });
      const leads = [];
      for (const msg of (history.messages || [])) {
        const t = norm(msg.text || "");
        if (!t.includes("aula gratis") && !t.includes("rmkt")) continue;
        const parsed    = parseLeadMessage(msg.text || "");
        const reactions = msg.reactions || [];
        leads.push({
          ts:        msg.ts,
          nome:      parsed.nome,
          empresa:   parsed.empresa,
          email:     parsed.email,
          telefone:  parsed.telefone,
          cargo:     parsed.cargo,
          fonte:     parsed.fonte,
          fonteNorm: norm(parsed.fonte),
          isMql:     reactions.some(r => r.name === "white_check_mark"),
          isNotMql:  reactions.some(r => r.name === "x"),
        });
      }
      return leads;
    } catch (e) {
      console.warn("[Slack MQL] API falhou, usando cache:", e.message);
    }
  }

  // Fallback: arquivo de cache populado pelo Claude via MCP
  const cache = readCache();
  if (!cache.ok) throw new Error("Sem SLACK_BOT_TOKEN e cache não encontrado");
  return cache.leads;
}

module.exports = { getMqlLeads, readCache };
