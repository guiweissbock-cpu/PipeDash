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

// Action types que representam leads na Meta
const LEAD_ACTION_TYPES = [
  "lead",
  "onsite_conversion.lead_grouped",
  "offsite_conversion.fb_pixel_lead",
  "leadgen_grouped",
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

module.exports = { getInsights };
