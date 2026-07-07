/**
 * services/zohoService.js
 * Integração com Zoho CRM API usando https nativo (compatível com Windows/TLS).
 * Renova o access token automaticamente via refresh token.
 */

const https    = require("https");
const fieldMap = require("../config/fieldMap");

let cachedToken    = null;
let tokenExpiresAt = 0;

function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body.toString();
    const options = {
      hostname,
      path,
      method:  "POST",
      timeout: 15000,
      headers: {
        "Content-Type":   "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error(`JSON inválido: ${raw}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout na requisição Zoho")); });
    req.write(bodyStr);
    req.end();
  });
}

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const options = { hostname, path, method: "GET", headers, timeout: 15000 };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error(`JSON inválido: ${raw}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout na requisição Zoho")); });
    req.end();
  });
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const body = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id:     process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type:    "refresh_token",
  });

  const accountsHost = (process.env.ZOHO_ACCOUNTS_URL || "https://accounts.zoho.com")
    .replace("https://", "");

  const json = await httpsPost(accountsHost, "/oauth/v2/token", body);

  if (json.error) throw new Error(`Zoho token error: ${json.error}`);
  if (!json.access_token) throw new Error("Zoho não retornou access_token");

  cachedToken    = json.access_token;
  tokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000;
  return cachedToken;
}

function extractContactName(value) {
  if (!value) return "";
  if (typeof value === "object") return value.name || "";
  return String(value);
}

function extractContactId(value) {
  if (value && typeof value === "object") return value.id || "";
  return "";
}

async function fetchDealsPage(token, module_, page = 1) {
  const apiHost = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com")
    .replace("https://", "");

  const fields = [
    "Deal_Name", "Contact_Name", "Origem", "Stage", "Created_Time",
    "Meta_Ads_ADs_ID", "Meta_Ads_Anuncio", "Meta_Ads_Campanha",
    "Meta_Ads_Lead_ID", "Meta_Ads_Campanha_ID", "ICP",
  ].join(",");

  const path = `/crm/v2/${module_}?fields=${encodeURIComponent(fields)}&page=${page}&per_page=200`;
  const json = await httpsGet(apiHost, path, { Authorization: `Zoho-oauthtoken ${token}` });

  if (json.status === "error") throw new Error(`Zoho CRM: ${json.message || JSON.stringify(json)}`);
  return json;
}

async function fetchReportPage(token, reportId, page = 1) {
  const apiHost  = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").replace("https://", "");
  const module_  = process.env.ZOHO_MODULE || "Deals";

  // A API de relatórios do Zoho CRM usa o endpoint do módulo com report_id como parâmetro.
  // O endpoint /crm/v2/Analytics/{id} NÃO funciona para buscar dados de relatório.
  const path = `/crm/v2/${module_}?report_id=${reportId}&page=${page}&per_page=200`;
  const json = await httpsGet(apiHost, path, { Authorization: `Zoho-oauthtoken ${token}` });

  if (json.status === "error") throw new Error(`Zoho Report: ${json.message || JSON.stringify(json)}`);
  return json;
}

function normalizeRecord(record) {
  const fm = fieldMap;
  return {
    id:             record.id || "",
    dealName:       record[fm.dealName]              || "",
    contactName:    extractContactName(record[fm.contactName]),
    contactId:      extractContactId(record[fm.contactName]),
    leadSource:     record[fm.leadSource]            || "",
    stage:          record[fm.stage]                 || "",
    createdTime:    record[fm.createdTime]           || "",
    metaAdId:       record[fm.metaAdId]              || "",
    metaAdName:     record[fm.metaAdName]            || "",
    metaCampaign:   record[fm.metaCampaign]          || "",
    metaLeadId:     record[fm.metaLeadId]            || "",
    metaCampaignId: record[fm.metaCampaignId]        || "",
    icp:            record[fm.icp]                   || "",
  };
}

// Normaliza registro do Zoho Analytics (Reports) API.
// Os campos têm os mesmos nomes da API de módulos, mas Contact_Name é string direta.
function normalizeReportRecord(record) {
  return {
    id:             record.id                        || "",
    dealName:       record["Deal_Name"]              || "",
    contactName:    extractContactName(record["Contact_Name"]),
    leadSource:     record["Origem"]                 || record["Lead_Source"] || "",
    stage:          record["Stage"]                  || "",
    createdTime:    record["Created_Time"]           || "",
    metaAdId:       record["Meta_Ads_ADs_ID"]        || "",
    metaAdName:     record["Meta_Ads_Anuncio"]       || "",
    metaCampaign:   record["Meta_Ads_Campanha"]      || "",
    metaLeadId:     record["Meta_Ads_Lead_ID"]       || "",
    metaCampaignId: record["Meta_Ads_Campanha_ID"]   || "",
    icp:            record["ICP"]                    || "",
  };
}

let dealsCache     = null;
let dealsCacheTime = 0;
const DEALS_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

async function getDeals({ forceRefresh = false } = {}) {
  if (!forceRefresh && dealsCache && Date.now() - dealsCacheTime < DEALS_CACHE_TTL) {
    console.log(`[Zoho] Cache hit (${Math.round((Date.now() - dealsCacheTime)/1000)}s atrás)`);
    return dealsCache;
  }

  const token   = await getAccessToken();
  const module_ = process.env.ZOHO_MODULE || "Deals";
  const all     = [];
  let page      = 1;

  while (true) {
    const json = await fetchDealsPage(token, module_, page);
    const data = json.data || [];
    data.forEach((r) => all.push(normalizeRecord(r)));
    if (!json.info?.more_records) break;
    page++;
  }

  dealsCache     = all;
  dealsCacheTime = Date.now();
  console.log(`[Zoho] ${all.length} deals carregados e cacheados`);
  return all;
}

// Busca um relatório do Zoho Analytics (Reports) pelo ID, com paginação automática.
async function getReport(reportId) {
  const token = await getAccessToken();
  const all   = [];
  let page    = 1;

  while (true) {
    const json = await fetchReportPage(token, reportId, page);
    const data = json.data || [];
    data.forEach((r) => all.push(normalizeReportRecord(r)));
    if (!json.info?.more_records) break;
    page++;
  }

  return all;
}

// Cache em memória de contatos (válido até o próximo cold start)
const _contactCache = new Map();

async function getContactById(contactId) {
  if (!contactId) return null;
  if (_contactCache.has(contactId)) return _contactCache.get(contactId);

  const token   = await getAccessToken();
  const apiHost = (process.env.ZOHO_API_DOMAIN || "https://www.zohoapis.com").replace("https://", "");
  const fields  = encodeURIComponent("Email,Phone,Mobile,First_Name,Last_Name");
  const path    = `/crm/v2/Contacts/${contactId}?fields=${fields}`;

  const json = await httpsGet(apiHost, path, { Authorization: `Zoho-oauthtoken ${token}` });

  if (!json.data || !json.data[0]) {
    _contactCache.set(contactId, null);
    return null;
  }

  const r = json.data[0];
  const contact = {
    id:        r.id              || contactId,
    email:     r.Email           || "",
    phone:     r.Phone           || r.Mobile || "",
    firstName: r.First_Name      || "",
    lastName:  r.Last_Name       || "",
  };
  _contactCache.set(contactId, contact);
  return contact;
}

module.exports = { getDeals, getReport, getContactById };
