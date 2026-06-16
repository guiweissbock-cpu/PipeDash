/**
 * services/zohoService.js
 * Integração com Zoho CRM API.
 * Renova o access token automaticamente via refresh token.
 */

const fieldMap = require("../config/fieldMap");

let cachedToken   = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  // Reutiliza o token em cache se ainda válido (margem de 60s)
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const params = new URLSearchParams({
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    client_id:     process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    grant_type:    "refresh_token",
  });

  const res  = await fetch(`${process.env.ZOHO_ACCOUNTS_URL}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const json = await res.json();

  if (json.error) throw new Error(`Zoho token error: ${json.error}`);
  if (!json.access_token) throw new Error("Zoho não retornou access_token");

  cachedToken    = json.access_token;
  tokenExpiresAt = Date.now() + (json.expires_in || 3600) * 1000;
  return cachedToken;
}

async function fetchDealsPage(token, module_, page = 1) {
  const domain  = process.env.ZOHO_API_DOMAIN;
  const fields  = Object.values(fieldMap).join(",");
  const url     = `${domain}/crm/v2/${module_}?fields=${encodeURIComponent(fields)}&page=${page}&per_page=200`;

  const res  = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
  const json = await res.json();

  if (json.status === "error") throw new Error(`Zoho CRM: ${json.message || JSON.stringify(json)}`);
  return json;
}

function normalizeRecord(record) {
  const fm = fieldMap;
  return {
    id:             record.id || "",
    dealName:       record[fm.dealName]    || "",
    contactName:    record[fm.contactName] || "",
    leadSource:     record[fm.leadSource]  || "",
    stage:          record[fm.stage]       || "",
    createdTime:    record[fm.createdTime] || "",
    metaAdId:       record[fm.metaAdId]    || "",
    metaAdName:     record[fm.metaAdName]  || "",
    metaCampaign:   record[fm.metaCampaign]  || "",
    metaLeadId:     record[fm.metaLeadId]    || "",
    metaCampaignId: record[fm.metaCampaignId] || "",
    icp:            record[fm.icp]           || "",
  };
}

async function getDeals() {
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

  return all;
}

module.exports = { getDeals };
