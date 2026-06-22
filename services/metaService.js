/**
 * services/metaService.js
 * Integração com a Meta Graph API.
 * Busca insights em nível de anúncio com paginação automática.
 */

const crypto = require("crypto");

const GRAPH_BASE = `https://graph.facebook.com/${process.env.META_API_VERSION || "v23.0"}`;

function appsecretProof(token, secret) {
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}

// onsite_conversion.lead_grouped = formulários Lead Ad (= Meta_Ads_Lead_ID no Zoho CRM)
// "lead" inclui também offsite_conversion.fb_pixel_lead (pixel sem Lead ID)
// Usar lead_grouped alinha com o que o Zoho importa via Make.com
const LEAD_ACTION_TYPES = [
  "onsite_conversion.lead_grouped",
];

function extractLeads(actions = []) {
  return actions
    .filter((a) => LEAD_ACTION_TYPES.includes(a.action_type))
    .reduce((sum, a) => sum + Number(a.value || 0), 0);
}

function buildInsightsUrl(params) {
  const account = process.env.META_AD_ACCOUNT_ID;
  const token   = process.env.META_ACCESS_TOKEN;
  const secret  = process.env.META_APP_SECRET;

  const fields = [
    "campaign_id", "campaign_name",
    "adset_id",    "adset_name",
    "ad_id",       "ad_name",
    "spend", "impressions", "clicks", "cpc", "cpm", "ctr",
    "actions", "cost_per_action_type",
    "date_start", "date_stop",
  ].join(",");

  const qs = new URLSearchParams({
    access_token:    token,
    appsecret_proof: appsecretProof(token, secret),
    level:           params.level || "ad",
    fields,
    limit:           "500",
  });

  if (params.since && params.until) {
    qs.set("time_range", JSON.stringify({ since: params.since, until: params.until }));
  } else if (params.date_preset) {
    qs.set("date_preset", params.date_preset);
  } else {
    qs.set("date_preset", "last_30d");
  }

  // Filtros opcionais
  const filtering = [];
  if (params.campaign_id) filtering.push({ field: "campaign.id", operator: "EQUAL", value: params.campaign_id });
  if (params.adset_id)    filtering.push({ field: "adset.id",    operator: "EQUAL", value: params.adset_id });
  if (params.ad_id)       filtering.push({ field: "ad.id",       operator: "EQUAL", value: params.ad_id });
  if (filtering.length)   qs.set("filtering", JSON.stringify(filtering));

  return `${GRAPH_BASE}/act_${account}/insights?${qs}`;
}

async function fetchAllPages(firstUrl) {
  const token  = process.env.META_ACCESS_TOKEN;
  const secret = process.env.META_APP_SECRET;
  const proof  = appsecretProof(token, secret);

  let url  = firstUrl;
  const all = [];

  while (url) {
    const res  = await fetch(url);
    const json = await res.json();

    if (json.error) throw new Error(`Meta API: [${json.error.code}] ${json.error.message}`);

    (json.data || []).forEach((row) => all.push(row));

    // paging.next não inclui appsecret_proof — re-append obrigatório
    if (json.paging?.next) {
      const next = new URL(json.paging.next);
      next.searchParams.set("appsecret_proof", proof);
      url = next.toString();
    } else {
      url = null;
    }
  }

  return all;
}

async function getInsights(params = {}) {
  const url  = buildInsightsUrl(params);
  const raw  = await fetchAllPages(url);

  return raw.map((row) => ({
    campaign_id:   row.campaign_id   || "",
    campaign_name: row.campaign_name || "",
    adset_id:      row.adset_id      || "",
    adset_name:    row.adset_name    || "",
    ad_id:         row.ad_id         || "",
    ad_name:       row.ad_name       || "",
    spend:         parseFloat(row.spend        || 0),
    impressions:   parseInt(row.impressions    || 0, 10),
    clicks:        parseInt(row.clicks         || 0, 10),
    cpc:           parseFloat(row.cpc          || 0),
    cpm:           parseFloat(row.cpm          || 0),
    ctr:           parseFloat(row.ctr          || 0),
    leads:         extractLeads(row.actions),
    date_start:    row.date_start || "",
    date_stop:     row.date_stop  || "",
  }));
}

// ---------------------------------------------------------------------------
// LIVE META — action types para leads na aba Live Meta
// onsite_conversion.lead_grouped = formulários Lead Ad (= Meta_Ads_Lead_ID no Zoho CRM)
// NÃO usar "lead" (193 hoje) pois inclui offsite_conversion.fb_pixel_lead (73)
// que são conversões pixel sem Lead Form ID — não chegam ao Zoho via Make.com
// ---------------------------------------------------------------------------
const LIVE_LEAD_TYPES = [
  "onsite_conversion.lead_grouped",
];

function extractLiveLeads(actions = []) {
  return actions
    .filter((a) => LIVE_LEAD_TYPES.includes(a.action_type))
    .reduce((sum, a) => sum + Number(a.value || 0), 0);
}

const AD_STATUS_PT = {
  ACTIVE:          "Ativo",
  PAUSED:          "Pausado",
  ARCHIVED:        "Arquivado",
  DISAPPROVED:     "Rejeitado",
  WITH_ISSUES:     "Com problemas",
  IN_PROCESS:      "Em processamento",
  CAMPAIGN_PAUSED: "Campanha pausada",
  ADSET_PAUSED:    "Conjunto pausado",
  DELETED:         "Excluído",
  PENDING_REVIEW:  "Em análise",
  PREAPPROVED:     "Pré-aprovado",
};

async function fetchAdsStatus() {
  const account = process.env.META_AD_ACCOUNT_ID;
  const token   = process.env.META_ACCESS_TOKEN;
  const secret  = process.env.META_APP_SECRET;

  const qs = new URLSearchParams({
    access_token:    token,
    appsecret_proof: appsecretProof(token, secret),
    fields:          "id,name,effective_status,configured_status",
    limit:           "500",
  });

  const url  = `${GRAPH_BASE}/act_${account}/ads?${qs}`;
  const rows = await fetchAllPages(url);

  const map = new Map();
  rows.forEach((ad) => {
    map.set(ad.id, AD_STATUS_PT[ad.effective_status] || ad.effective_status || "—");
  });
  return map;
}

async function getLiveData(params = {}) {
  const account = process.env.META_AD_ACCOUNT_ID;
  const token   = process.env.META_ACCESS_TOKEN;
  const secret  = process.env.META_APP_SECRET;

  const fields = [
    "campaign_name", "adset_name", "ad_id", "ad_name",
    "reach", "impressions", "frequency", "spend", "clicks",
    "cpm", "ctr", "cpc", "actions", "cost_per_action_type",
  ].join(",");

  const qs = new URLSearchParams({
    access_token:    token,
    appsecret_proof: appsecretProof(token, secret),
    level:           "ad",
    fields,
    limit:           "500",
  });

  if (params.since && params.until) {
    qs.set("time_range", JSON.stringify({ since: params.since, until: params.until }));
  } else {
    qs.set("date_preset", params.date_preset || "last_30d");
  }

  const insightsUrl = `${GRAPH_BASE}/act_${account}/insights?${qs}`;

  const [raw, statusMap] = await Promise.all([
    fetchAllPages(insightsUrl),
    fetchAdsStatus(),
  ]);

  return raw.map((row) => {
    const leads       = extractLiveLeads(row.actions);
    const spend       = parseFloat(row.spend        || 0);
    const impressions = parseInt(row.impressions     || 0, 10);
    const reach       = parseInt(row.reach           || 0, 10);
    const clicks      = parseInt(row.clicks          || 0, 10);

    return {
      campaign_name:  row.campaign_name || "",
      adset_name:     row.adset_name    || "",
      ad_id:          row.ad_id         || "",
      ad_name:        row.ad_name       || "",
      reach,
      impressions,
      frequency:      parseFloat(row.frequency || 0),
      spend,
      clicks,
      cpm:            parseFloat(row.cpm || 0),
      ctr:            parseFloat(row.ctr || 0),
      cpc:            parseFloat(row.cpc || 0),
      leads,
      cost_per_lead:  leads > 0 ? spend / leads : null,
      status:         statusMap.get(row.ad_id) || "—",
    };
  });
}

// ---------------------------------------------------------------------------
// CREATIVE — busca URL da imagem de um anúncio (com cache em memória)
// ---------------------------------------------------------------------------
const _creativeCache = new Map();

async function getAdCreative(adId) {
  if (_creativeCache.has(adId)) return _creativeCache.get(adId);

  const token  = process.env.META_ACCESS_TOKEN;
  const secret = process.env.META_APP_SECRET;

  // /adpreviews retorna o HTML do anúncio real (suporta todos os tipos de criativo)
  const qs = new URLSearchParams({
    access_token:    token,
    appsecret_proof: appsecretProof(token, secret),
    ad_format:       "MOBILE_FEED_STANDARD",
  });

  const res  = await fetch(`${GRAPH_BASE}/${adId}/previews?${qs}`);
  const json = await res.json();
  if (json.error) throw new Error(`Meta API: ${json.error.message}`);

  const html = json.data?.[0]?.body || "";
  let iframeSrc = null, width = 335, height = 450;

  if (html) {
    const srcMatch = html.match(/src="([^"]+)"/);
    const wMatch   = html.match(/width="(\d+)"/);
    const hMatch   = html.match(/height="(\d+)"/);
    if (srcMatch) iframeSrc = srcMatch[1].replace(/&amp;/g, "&");
    if (wMatch)   width     = parseInt(wMatch[1], 10);
    if (hMatch)   height    = parseInt(hMatch[1], 10);
  }

  const result = { iframe_src: iframeSrc, width, height };
  _creativeCache.set(adId, result);
  return result;
}

// ---------------------------------------------------------------------------
// LIVE DAILY — mesmos dados do getLiveData mas com time_increment=1 (por dia)
// ---------------------------------------------------------------------------
async function getLiveDailyData(params = {}) {
  const account = process.env.META_AD_ACCOUNT_ID;
  const token   = process.env.META_ACCESS_TOKEN;
  const secret  = process.env.META_APP_SECRET;

  const fields = [
    "campaign_name", "adset_name", "ad_id", "ad_name",
    "date_start", "reach", "impressions", "spend", "clicks",
    "ctr", "cpc", "actions",
  ].join(",");

  const qs = new URLSearchParams({
    access_token:    token,
    appsecret_proof: appsecretProof(token, secret),
    level:           "ad",
    fields,
    time_increment:  "1",
    limit:           "500",
  });

  if (params.since && params.until) {
    qs.set("time_range", JSON.stringify({ since: params.since, until: params.until }));
  } else {
    qs.set("date_preset", params.date_preset || "last_30d");
  }

  const raw = await fetchAllPages(`${GRAPH_BASE}/act_${account}/insights?${qs}`);

  return raw.map((row) => ({
    date_start:    row.date_start     || "",
    campaign_name: row.campaign_name  || "",
    adset_name:    row.adset_name     || "",
    ad_id:         row.ad_id          || "",
    ad_name:       row.ad_name        || "",
    reach:         parseInt(row.reach        || 0, 10),
    impressions:   parseInt(row.impressions  || 0, 10),
    clicks:        parseInt(row.clicks       || 0, 10),
    spend:         parseFloat(row.spend      || 0),
    ctr:           parseFloat(row.ctr        || 0),
    cpc:           parseFloat(row.cpc        || 0),
    leads:         extractLiveLeads(row.actions),
  }));
}

module.exports = { getInsights, getLiveData, getLiveDailyData, getAdCreative };
