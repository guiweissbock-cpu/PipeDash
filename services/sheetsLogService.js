/**
 * services/sheetsLogService.js
 * Persiste o log de transferência numa aba do Google Sheets via Service Account.
 *
 * Env vars necessárias:
 *   GOOGLE_SHEETS_CLIENT_EMAIL  — e-mail da service account
 *   GOOGLE_SHEETS_PRIVATE_KEY   — chave privada RSA (PEM, \n escapados como \\n no .env)
 *
 * Env vars opcionais (têm padrão):
 *   GOOGLE_SHEETS_LOG_SHEET_ID  — ID da planilha   (padrão: mesma planilha dos leads)
 *   GOOGLE_SHEETS_LOG_GID       — gid da aba        (padrão: 1018969286)
 */

const crypto = require("crypto");
const https  = require("https");

const SHEET_ID   = process.env.GOOGLE_SHEETS_LOG_SHEET_ID || "1q8ak31BfhH0DySk5dFbtNLSQQkenb7u_VtdD6Hcb1ak";
const TARGET_GID = process.env.GOOGLE_SHEETS_LOG_GID       || "0";
const SCOPE      = "https://www.googleapis.com/auth/spreadsheets";

// Colunas do log
const HEADERS = [
  "Data/Hora Envio", "Nome Negócio", "Nome Contato",
  "E-mail", "Telefone", "Lead ID", "Meta Ads ID", "Form ID",
  "Campanha", "Anúncio", "Stage Zoho", "Data Zoho",
  "Evento Meta", "Event ID", "Status",
  "Meta Events Recebidos", "Trace ID", "Tentativas",
  "Cód. Erro", "Campo Erro", "Mensagem Erro", "Sugestão", "Pode Reenviar",
];

// ── Helpers de mascaramento ───────────────────────────────────────────────────

function maskEmail(v) {
  if (!v) return "";
  const [u, d] = v.split("@");
  return (u || "").slice(0, 2) + "***@" + (d || "");
}
function maskPhone(v) {
  if (!v) return "";
  return v.slice(0, 3) + "****" + v.slice(-2);
}

// ── Converte entrada do log em linha da planilha ──────────────────────────────

function entryToRow(e) {
  return [
    e.sentAt        || "",
    e.nomeNegocio   || "",
    e.nomeContato   || "",
    maskEmail(e.email),
    maskPhone(e.telefone),
    e.leadId        || "",
    e.metaAdsId     || "",
    e.formId        || "",
    e.campanha      || "",
    e.anuncio       || "",
    e.stage         || "",
    e.dataZoho      || "",
    e.eventName     || "Schedule",
    e.eventId       || e.dedupeKey || "",
    e.status        || "",
    e.metaEvents    != null ? String(e.metaEvents) : "",
    e.metaTraceId   || "",
    String(e.attempts || 1),
    e.errorCode     || "",
    e.errorField    || "",
    e.errorMessage  || "",
    e.errorSuggestion || "",
    e.canRetry      ? "Sim" : "Não",
  ];
}

// ── Auth: Service Account JWT → access token ──────────────────────────────────

let _tokenCache    = null;
let _tokenExpiresAt = 0;

function buildJWT(clientEmail, privateKey) {
  const now     = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: clientEmail, scope: SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  })).toString("base64url");

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(privateKey, "base64url");
  return `${header}.${payload}.${sig}`;
}

function httpsPost(hostname, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const buf  = Buffer.from(body);
    const opts = {
      hostname, path, method: "POST", timeout: 10000,
      headers: { "Content-Length": buf.length, ...headers },
    };
    const req = https.request(opts, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (_) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(buf);
    req.end();
  });
}

function httpsGet(hostname, path, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname, path, method: "GET", timeout: 10000,
      headers: { Authorization: `Bearer ${token}` },
    };
    const req = https.request(opts, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (_) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

async function getAccessToken() {
  if (_tokenCache && Date.now() < _tokenExpiresAt) return _tokenCache;

  const clientEmail = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
  const privateKey  = (process.env.GOOGLE_SHEETS_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!clientEmail || !privateKey)
    throw new Error("GOOGLE_SHEETS_CLIENT_EMAIL ou GOOGLE_SHEETS_PRIVATE_KEY não configurados no .env");

  const jwt  = buildJWT(clientEmail, privateKey);
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString();
  const res  = await httpsPost("oauth2.googleapis.com", "/token", body, { "Content-Type": "application/x-www-form-urlencoded" });

  if (!res.body.access_token)
    throw new Error(`Falha ao obter access token: ${JSON.stringify(res.body)}`);

  _tokenCache     = res.body.access_token;
  _tokenExpiresAt = Date.now() + 55 * 60 * 1000; // 55 min
  return _tokenCache;
}

// ── Sheets API helpers ────────────────────────────────────────────────────────

// Busca o nome da aba pelo gid (precisa do access token)
let _sheetNameCache = null;

async function getSheetName(token) {
  if (_sheetNameCache) return _sheetNameCache;
  const res = await httpsGet(
    "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties`,
    token
  );
  if (res.status !== 200) throw new Error(`Sheets metadata: ${JSON.stringify(res.body)}`);
  const sheet = (res.body.sheets || []).find((s) => String(s.properties.sheetId) === String(TARGET_GID));
  if (!sheet) throw new Error(`Aba com gid=${TARGET_GID} não encontrada na planilha`);
  _sheetNameCache = sheet.properties.title;
  return _sheetNameCache;
}

// Lê todas as linhas da aba
async function readRows(token, sheetName) {
  const range = encodeURIComponent(`${sheetName}`);
  const res   = await httpsGet(
    "sheets.googleapis.com",
    `/v4/spreadsheets/${SHEET_ID}/values/${range}`,
    token
  );
  if (res.status !== 200) throw new Error(`Erro ao ler planilha: ${JSON.stringify(res.body)}`);
  return res.body.values || [];
}

// Escreve o cabeçalho na primeira linha se a aba estiver vazia
async function ensureHeaders(token, sheetName) {
  const rows = await readRows(token, sheetName);
  if (rows.length > 0) return; // já tem dados
  await appendRows(token, sheetName, [HEADERS]);
}

// Adiciona linhas ao final
async function appendRows(token, sheetName, rows) {
  const range = encodeURIComponent(`${sheetName}`);
  const body  = JSON.stringify({ values: rows });
  const path  = `/v4/spreadsheets/${SHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  return new Promise((resolve, reject) => {
    const buf  = Buffer.from(body);
    const opts = {
      hostname: "sheets.googleapis.com",
      path, method: "POST", timeout: 15000,
      headers: {
        Authorization:  `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": buf.length,
      },
    };
    const req = https.request(opts, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(raw);
          if (res.statusCode >= 400) reject(new Error(json.error?.message || raw.slice(0, 200)));
          else resolve(json);
        } catch (_) { reject(new Error(raw.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(buf);
    req.end();
  });
}

// Atualiza uma linha específica (por índice 0-based, linha 1 = header)
async function updateRow(token, sheetName, rowIndex, rowData) {
  const range = encodeURIComponent(`${sheetName}!A${rowIndex + 1}`);
  const body  = JSON.stringify({ values: [rowData] });
  const path  = `/v4/spreadsheets/${SHEET_ID}/values/${range}?valueInputOption=USER_ENTERED`;

  return new Promise((resolve, reject) => {
    const buf  = Buffer.from(body);
    const opts = {
      hostname: "sheets.googleapis.com",
      path, method: "PUT", timeout: 15000,
      headers: {
        Authorization:    `Bearer ${token}`,
        "Content-Type":   "application/json",
        "Content-Length": buf.length,
      },
    };
    const req = https.request(opts, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(raw);
          if (res.statusCode >= 400) reject(new Error(json.error?.message || raw.slice(0, 200)));
          else resolve(json);
        } catch (_) { reject(new Error(raw.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(buf);
    req.end();
  });
}

// ── API pública ───────────────────────────────────────────────────────────────

// Verifica se as credenciais estão configuradas
function isConfigured() {
  return !!(process.env.GOOGLE_SHEETS_CLIENT_EMAIL && process.env.GOOGLE_SHEETS_PRIVATE_KEY);
}

/**
 * Grava (ou atualiza) uma entrada do log na planilha.
 * - Busca linha com mesmo Event ID (coluna N, índice 13)
 * - Se encontrar: atualiza a linha (para refletir tentativas/retry)
 * - Se não encontrar: adiciona nova linha
 */
async function upsertEntry(entry) {
  const token     = await getAccessToken();
  const sheetName = await getSheetName(token);
  await ensureHeaders(token, sheetName);

  const rows      = await readRows(token, sheetName);
  const eventId   = entry.eventId || entry.dedupeKey || "";
  const EVENT_ID_COL = 13; // coluna N (0-based)

  // Procura linha existente (pula cabeçalho na linha 0)
  const existingIdx = rows.findIndex((r, i) => i > 0 && (r[EVENT_ID_COL] || "") === eventId);

  const newRow = entryToRow(entry);

  if (existingIdx >= 0) {
    await updateRow(token, sheetName, existingIdx, newRow);
  } else {
    await appendRows(token, sheetName, [newRow]);
  }
}

/**
 * Retorna todas as entradas do log como objetos (parse das linhas).
 */
async function getLog() {
  const token     = await getAccessToken();
  const sheetName = await getSheetName(token);
  const rows      = await readRows(token, sheetName);

  if (rows.length < 2) return []; // sem dados além do cabeçalho

  return rows.slice(1).map((r) => ({
    sentAt:           r[0]  || "",
    nomeNegocio:      r[1]  || "",
    nomeContato:      r[2]  || "",
    email:            r[3]  || "",
    telefone:         r[4]  || "",
    leadId:           r[5]  || "",
    metaAdsId:        r[6]  || "",
    formId:           r[7]  || "",
    campanha:         r[8]  || "",
    anuncio:          r[9]  || "",
    stage:            r[10] || "",
    dataZoho:         r[11] || "",
    eventName:        r[12] || "",
    eventId:          r[13] || "",
    dedupeKey:        r[13] || "",
    status:           r[14] || "",
    metaEvents:       r[15] ? Number(r[15]) : null,
    metaTraceId:      r[16] || "",
    attempts:         r[17] ? Number(r[17]) : 1,
    errorCode:        r[18] || "",
    errorField:       r[19] || "",
    errorMessage:     r[20] || "",
    errorSuggestion:  r[21] || "",
    canRetry:         r[22] === "Sim",
  }));
}

module.exports = { isConfigured, upsertEntry, getLog, HEADERS };
