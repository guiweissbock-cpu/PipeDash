/**
 * googleAdsService.js
 * Google Ads REST API v23 — campanha, conta, diário, keywords, search terms.
 */

const ACCESS_TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE         = "https://googleads.googleapis.com/v23";

let _accessToken    = null;
let _accessTokenExp = 0;

async function getAccessToken() {
  if (_accessToken && Date.now() < _accessTokenExp - 60_000) return _accessToken;
  const body = new URLSearchParams({
    client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    grant_type:    "refresh_token",
  });
  const resp = await fetch(ACCESS_TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });
  const json = await resp.json();
  if (json.error) throw new Error(`Google OAuth: ${json.error} — ${json.error_description}`);
  _accessToken    = json.access_token;
  _accessTokenExp = Date.now() + json.expires_in * 1000;
  return _accessToken;
}

function buildDateCond(params) {
  if (params.since && params.until) {
    return `segments.date BETWEEN '${params.since}' AND '${params.until}'`;
  }
  const gaqlPreset = {
    today:      "TODAY",
    yesterday:  "YESTERDAY",
    last_7d:    "LAST_7_DAYS",
    last_14d:   "LAST_14_DAYS",
    last_30d:   "LAST_30_DAYS",
    this_month: "THIS_MONTH",
    last_month: "LAST_MONTH",
  }[params.date_preset || "today"] || "TODAY";
  return `segments.date DURING ${gaqlPreset}`;
}

async function search(query) {
  const token      = await getAccessToken();
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID;
  const mccId      = process.env.GOOGLE_ADS_MCC_ID;
  const devToken   = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const url        = `${API_BASE}/customers/${customerId}/googleAds:search`;
  const headers    = {
    "Content-Type":    "application/json",
    "Authorization":   `Bearer ${token}`,
    "developer-token": devToken,
  };
  if (mccId) headers["login-customer-id"] = mccId;

  let allResults = [];
  let pageToken;
  do {
    const body = { query };
    if (pageToken) body.pageToken = pageToken;
    const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const raw  = await resp.text();
    let json;
    try { json = JSON.parse(raw); }
    catch {
      console.error("[Google Ads] Resposta não-JSON (HTTP", resp.status, "):", raw.slice(0, 300));
      throw new Error(`Google Ads retornou resposta inválida (HTTP ${resp.status}).`);
    }
    if (json.error) {
      console.error("[Google Ads] Erro:", JSON.stringify(json.error?.details || json.error, null, 2));
      throw new Error(json.error.message || JSON.stringify(json.error));
    }
    allResults = allResults.concat(json.results || []);
    pageToken  = json.nextPageToken;
  } while (pageToken);
  return allResults;
}

async function getAccountInsights(params) {
  const dateCond = buildDateCond(params);
  const rows = await search(`
    SELECT metrics.impressions, metrics.clicks, metrics.cost_micros,
           metrics.conversions, metrics.conversions_value
    FROM campaign
    WHERE ${dateCond} AND campaign.status != 'REMOVED'
  `);
  const t = rows.reduce((a, r) => {
    a.impressions += Number(r.metrics?.impressions || 0);
    a.clicks      += Number(r.metrics?.clicks || 0);
    a.costMicros  += Number(r.metrics?.costMicros || 0);
    a.conversions += Number(r.metrics?.conversions || 0);
    a.convValue   += Number(r.metrics?.conversionsValue || 0);
    return a;
  }, { impressions: 0, clicks: 0, costMicros: 0, conversions: 0, convValue: 0 });
  const costBRL = t.costMicros / 1_000_000;
  return {
    impressions: t.impressions,
    clicks:      t.clicks,
    ctr:         t.impressions > 0 ? t.clicks / t.impressions : 0,
    costBRL,
    conversions: t.conversions,
    convValue:   t.convValue,
    cpc:         t.clicks > 0 ? costBRL / t.clicks : 0,
    cpa:         t.conversions > 0 ? costBRL / t.conversions : 0,
    roas:        costBRL > 0 ? t.convValue / costBRL : 0,
  };
}

async function getCampaignInsights(params) {
  const dateCond = buildDateCond(params);
  const rows = await search(`
    SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
           metrics.impressions, metrics.clicks, metrics.cost_micros,
           metrics.conversions, metrics.conversions_value
    FROM campaign
    WHERE ${dateCond} AND campaign.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
  `);
  return rows.map((r) => {
    const imp  = Number(r.metrics?.impressions || 0);
    const clk  = Number(r.metrics?.clicks || 0);
    const cost = Number(r.metrics?.costMicros || 0) / 1_000_000;
    const conv = Number(r.metrics?.conversions || 0);
    const val  = Number(r.metrics?.conversionsValue || 0);
    return {
      id:          r.campaign?.id,
      name:        r.campaign?.name,
      status:      r.campaign?.status,
      channelType: r.campaign?.advertisingChannelType,
      impressions: imp,
      clicks:      clk,
      ctr:         imp > 0 ? clk / imp : 0,
      costBRL:     cost,
      conversions: conv,
      convRate:    clk > 0 ? conv / clk : 0,
      cpc:         clk > 0 ? cost / clk : 0,
      cpa:         conv > 0 ? cost / conv : 0,
      convValue:   val,
      roas:        cost > 0 ? val / cost : 0,
    };
  });
}

async function getDailyMetrics(params) {
  const dateCond = buildDateCond(params);
  const rows = await search(`
    SELECT segments.date, metrics.impressions, metrics.clicks,
           metrics.cost_micros, metrics.conversions
    FROM campaign
    WHERE ${dateCond} AND campaign.status != 'REMOVED'
    ORDER BY segments.date ASC
  `);
  const byDate = {};
  for (const r of rows) {
    const d = r.segments?.date;
    if (!d) continue;
    if (!byDate[d]) byDate[d] = { date: d, impressions: 0, clicks: 0, costBRL: 0, conversions: 0 };
    byDate[d].impressions += Number(r.metrics?.impressions || 0);
    byDate[d].clicks      += Number(r.metrics?.clicks || 0);
    byDate[d].costBRL     += Number(r.metrics?.costMicros || 0) / 1_000_000;
    byDate[d].conversions += Number(r.metrics?.conversions || 0);
  }
  return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
}

async function getTopKeywords(params, campaignId = null) {
  const dateCond   = buildDateCond(params);
  const camFilter  = campaignId ? `AND campaign.id = '${campaignId}'` : "";
  const limitN     = campaignId ? 5 : 10;
  try {
    const rows = await search(`
      SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
             campaign.id, campaign.name,
             metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM keyword_view
      WHERE ${dateCond} AND campaign.status != 'REMOVED'
            AND ad_group_criterion.status != 'REMOVED' ${camFilter}
      ORDER BY metrics.conversions DESC, metrics.clicks DESC, metrics.impressions DESC
      LIMIT ${limitN}
    `);
    return rows.map(r => {
      const imp  = Number(r.metrics?.impressions || 0);
      const clk  = Number(r.metrics?.clicks || 0);
      const cost = Number(r.metrics?.costMicros || 0) / 1_000_000;
      return {
        keyword:     r.adGroupCriterion?.keyword?.text || "",
        matchType:   r.adGroupCriterion?.keyword?.matchType || "",
        campaignId:  r.campaign?.id,
        campaign:    r.campaign?.name || "",
        impressions: imp,
        clicks:      clk,
        ctr:         imp > 0 ? clk / imp : 0,
        cpc:         clk > 0 ? cost / clk : 0,
        costBRL:     cost,
        conversions: Number(r.metrics?.conversions || 0),
      };
    });
  } catch {
    return [];
  }
}

async function getTopSearchTerms(params, campaignId = null) {
  const dateCond  = buildDateCond(params);
  const camFilter = campaignId ? `AND campaign.id = '${campaignId}'` : "";
  const limitN    = campaignId ? 5 : 10;
  try {
    const rows = await search(`
      SELECT search_term_view.search_term, campaign.id, campaign.name,
             metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
      FROM search_term_view
      WHERE ${dateCond} AND campaign.status != 'REMOVED' ${camFilter}
      ORDER BY metrics.conversions DESC, metrics.clicks DESC, metrics.impressions DESC
      LIMIT ${limitN}
    `);
    return rows.map(r => {
      const imp = Number(r.metrics?.impressions || 0);
      const clk = Number(r.metrics?.clicks || 0);
      return {
        searchTerm:  r.searchTermView?.searchTerm || "",
        campaignId:  r.campaign?.id,
        campaign:    r.campaign?.name || "",
        impressions: imp,
        clicks:      clk,
        ctr:         imp > 0 ? clk / imp : 0,
        costBRL:     Number(r.metrics?.costMicros || 0) / 1_000_000,
        conversions: Number(r.metrics?.conversions || 0),
      };
    });
  } catch {
    return [];
  }
}

module.exports = {
  getAccountInsights,
  getCampaignInsights,
  getDailyMetrics,
  getTopKeywords,
  getTopSearchTerms,
};
