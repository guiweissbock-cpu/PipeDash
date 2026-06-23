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

// ── Keyword Planner — GenerateKeywordIdeas ───────────────────────────────────
// Retorna ideias de palavras-chave com volume, CPC e score de cliques.
// Tenta automaticamente 3 combinações de customer/login até uma funcionar.

// Cacheia a combinação que funcionou para evitar re-tentar em chamadas posteriores
let _kwComboCache = null;

async function generateKeywordIdeas(seeds, opts = {}) {
  const token      = await getAccessToken();
  const customerId = (process.env.GOOGLE_ADS_CUSTOMER_ID || "").replace(/-/g, "");
  const mccId      = (process.env.GOOGLE_ADS_MCC_ID || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "").replace(/-/g, "");
  const kwOverride = (process.env.GOOGLE_ADS_KW_CUSTOMER_ID || "").replace(/-/g, ""); // override opcional
  const devToken   = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;

  const seedsLimited = seeds.slice(0, 20);
  const body = {
    language:           opts.language    || "languageConstants/1014",
    geoTargetConstants: opts.geoTargets  || ["geoTargetConstants/2076"],
    keywordPlanNetwork: opts.network     || "GOOGLE_SEARCH",
    keywordSeed:        { keywords: seedsLimited },
    pageSize:           Math.min(opts.pageSize || 200, 10000),
  };

  // Combinações a tentar (em ordem). Se GOOGLE_ADS_KW_CUSTOMER_ID definido, começa por ele.
  const combos = [
    // Cache da sessão: pula direto para o que já funcionou
    _kwComboCache,
    // Override explícito via env
    kwOverride ? { urlId: kwOverride, loginId: mccId || null } : null,
    kwOverride && mccId ? { urlId: kwOverride, loginId: null } : null,
    // Padrão: sub-conta na URL + MCC no header (estrutura MCC)
    mccId ? { urlId: customerId, loginId: mccId } : null,
    // Acesso direto: sub-conta na URL sem header MCC
    { urlId: customerId, loginId: null },
    // MCC como customer direto (alguns setups de MCC com acesso Keyword Planner)
    mccId ? { urlId: mccId, loginId: null } : null,
    mccId ? { urlId: mccId, loginId: mccId } : null,
  ].filter((c, i, arr) => {
    if (!c) return false;
    // Remove duplicatas
    return arr.findIndex(x => x && x.urlId === c.urlId && x.loginId === c.loginId) === i;
  });

  for (let i = 0; i < combos.length; i++) {
    const { urlId, loginId } = combos[i];
    const url = `${API_BASE}/customers/${urlId}:generateKeywordIdeas`;
    const headers = {
      "Content-Type":    "application/json",
      "Authorization":   `Bearer ${token}`,
      "developer-token": devToken,
    };
    if (loginId) headers["login-customer-id"] = loginId;

    console.log(`[Keyword Ideas] Combo ${i + 1}/${combos.length}: customers/${urlId} login=${loginId || "—"} seeds=${seedsLimited.length}`);

    const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    const raw  = await resp.text();
    let json;
    try { json = JSON.parse(raw); } catch {
      console.error("[Keyword Ideas] Resposta não-JSON (HTTP", resp.status, "):", raw.slice(0, 400));
      throw new Error(`Google Ads retornou resposta inválida (HTTP ${resp.status}).`);
    }

    if (json.error) {
      // Extrai código de erro Google Ads específico (dentro de details)
      const details   = json.error.details || [];
      const gAdsError = details.find(d => d["@type"]?.includes("GoogleAdsFailure"));
      const errCode   = gAdsError?.errors?.[0]?.errorCode
        ? Object.keys(gAdsError.errors[0].errorCode)[0] + "=" + Object.values(gAdsError.errors[0].errorCode)[0]
        : "sem código adicional";
      console.error(`[Keyword Ideas] Combo ${i + 1} → HTTP ${resp.status} ${json.error.status}: ${json.error.message} | Código: ${errCode}`);
      if (gAdsError?.errors?.[0]) {
        console.error(`[Keyword Ideas] Detalhe:`, JSON.stringify(gAdsError.errors[0], null, 2));
      }

      if (json.error.status === "RESOURCE_EXHAUSTED") {
        throw new Error(`Quota da API atingida — aguarde alguns minutos antes de tentar novamente. (${json.error.message})`);
      }
      if (json.error.status === "PERMISSION_DENIED" && i < combos.length - 1) {
        continue; // tenta próxima combinação
      }
      if (json.error.status === "PERMISSION_DENIED") {
        console.error("[Keyword Ideas] Todas as combinações falharam. Combos tentados:", JSON.stringify(combos));
        throw new Error(
          `Sem permissão para Keyword Planner em nenhuma combinação testada. Código interno: ${errCode}.\n` +
          `→ Verifique GOOGLE_ADS_MCC_ID no .env (${mccId ? "presente: " + mccId : "AUSENTE"}).\n` +
          `→ Verifique se o Developer Token está APROVADO em ads.google.com/aw/apiaccess\n` +
          `→ Erro original: ${json.error.message}`
        );
      }
      throw new Error(json.error.message || JSON.stringify(json.error));
    }

    // ✅ Sucesso — cacheia a combinação para chamadas posteriores
    _kwComboCache = { urlId, loginId };
    if (i > 0) {
      console.log(`[Keyword Ideas] ✅ Combo que funcionou: customers/${urlId} login=${loginId || "—"}`);
      console.log(`[Keyword Ideas] 💡 Para fixar no .env: GOOGLE_ADS_KW_CUSTOMER_ID=${urlId}${loginId ? `\nGOOGLE_ADS_MCC_ID=${loginId}` : ""}`);
    }

    const results = (json.results || []).map(r => {
      const m      = r.keywordIdeaMetrics || {};
      const vol    = Number(m.avgMonthlySearches  || 0);
      const lowCpc = Number(m.lowTopOfPageBidMicros  || 0) / 1_000_000;
      const hiCpc  = Number(m.highTopOfPageBidMicros || 0) / 1_000_000;
      const avgCpc = (lowCpc > 0 && hiCpc > 0) ? (lowCpc + hiCpc) / 2 : (hiCpc || lowCpc || 0);
      return {
        keyword:     r.text || "",
        volume:      vol,
        competition: m.competition || "UNSPECIFIED",
        compIndex:   Number(m.competitionIndex || 0),
        lowCpc,
        hiCpc,
        avgCpc,
        score:       avgCpc > 0 ? Math.round(vol / avgCpc) : 0,
      };
    });
    results.sort((a, b) => b.score - a.score);
    console.log(`[Keyword Ideas] ${results.length} ideias geradas para seeds: ${seeds.slice(0, 3).join(", ")}...`);
    return results;
  }

  throw new Error("generateKeywordIdeas: nenhuma combinação funcionou.");
}

// ── Campanha e grupos para o modal de publicação ─────────────────────────────

async function getCampaignsList() {
  const rows = await search(`
    SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type
    FROM campaign
    WHERE campaign.status IN ('ENABLED','PAUSED')
    ORDER BY campaign.name ASC
    LIMIT 200
  `);
  return rows.map(r => ({
    id:     r.campaign?.id,
    name:   r.campaign?.name,
    status: r.campaign?.status,
    type:   r.campaign?.advertisingChannelType,
  }));
}

async function getAdGroupsByCampaign(campaignId) {
  const rows = await search(`
    SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id
    FROM ad_group
    WHERE campaign.id = '${campaignId}'
      AND ad_group.status IN ('ENABLED','PAUSED')
    ORDER BY ad_group.name ASC
    LIMIT 200
  `);
  return rows.map(r => ({
    id:         r.adGroup?.id,
    name:       r.adGroup?.name,
    status:     r.adGroup?.status,
    campaignId: r.campaign?.id,
  }));
}

async function addKeywordsToAdGroup({ adGroupId, keywords, cpcMaxBRL = 5, matchType = "BROAD", status = "PAUSED" }) {
  const token      = await getAccessToken();
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID;
  const mccId      = process.env.GOOGLE_ADS_MCC_ID;
  const devToken   = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const url        = `${API_BASE}/customers/${customerId}/adGroupCriteria:mutate`;

  const headers = {
    "Content-Type":    "application/json",
    "Authorization":   `Bearer ${token}`,
    "developer-token": devToken,
  };
  if (mccId) headers["login-customer-id"] = mccId;

  const matchMap = { BROAD: "BROAD", PHRASE: "PHRASE", EXACT: "EXACT", Ampla: "BROAD", Frase: "PHRASE", Exata: "EXACT" };
  const mt       = matchMap[matchType] || "BROAD";
  const cpcMicros = Math.round(Number(cpcMaxBRL) * 1_000_000);
  const adGroupRn = `customers/${customerId}/adGroups/${adGroupId}`;

  const operations = keywords.map(kw => ({
    create: {
      adGroup:       adGroupRn,
      status:        status === "PAUSED" ? "PAUSED" : "ENABLED",
      cpcBidMicros:  String(cpcMicros),
      keyword: { text: kw.trim(), matchType: mt },
    },
  }));

  const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify({ operations }) });
  const raw  = await resp.text();
  let json;
  try { json = JSON.parse(raw); }
  catch { throw new Error(`Google Ads resposta inválida (HTTP ${resp.status}): ${raw.slice(0, 200)}`); }

  if (json.error) {
    console.error("[addKeywords] Erro:", JSON.stringify(json.error?.details || json.error, null, 2));
    throw new Error(json.error.message || JSON.stringify(json.error));
  }

  const added   = (json.results   || []).length;
  const errors  = (json.partialFailureError?.details || []);
  console.log(`[addKeywords] ${added} keywords adicionadas ao grupo ${adGroupId}. Erros parciais: ${errors.length}`);
  return { added, errors, results: json.results || [] };
}

module.exports = {
  getAccountInsights,
  getCampaignInsights,
  getDailyMetrics,
  getTopKeywords,
  getTopSearchTerms,
  generateKeywordIdeas,
  getCampaignsList,
  getAdGroupsByCampaign,
  addKeywordsToAdGroup,
};
