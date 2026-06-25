/**
 * server.js
 * Servidor Express local — roda em http://localhost:3000
 * Nunca expõe tokens ao frontend. Todas as chamadas sensíveis passam por aqui.
 */

// Windows: Node.js não usa o CA store do sistema — bypass necessário localmente.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

require("dotenv").config();

const express = require("express");
const path    = require("path");

const metaService       = require("./services/metaService");
const zohoService       = require("./services/zohoService");
const slackService      = require("./services/slackService");
const googleAdsService  = require("./services/googleAdsService");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── GET /api/meta/insights ────────────────────────────────────────────────────
// Busca dados de criativos diretamente da Meta Graph API.
// Query params: since, until, date_preset, level, campaign_id, adset_id, ad_id
app.get("/api/meta/insights", async (req, res) => {
  try {
    if (!process.env.META_ACCESS_TOKEN || !process.env.META_AD_ACCOUNT_ID) {
      return res.status(500).json({ error: "META_ACCESS_TOKEN ou META_AD_ACCOUNT_ID não configurados no .env" });
    }
    const data = await metaService.getInsights(req.query);
    res.json({ ok: true, data });
  } catch (err) {
    console.error("[Meta]", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/zoho/deals ───────────────────────────────────────────────────────
// Busca negócios/deals do Zoho CRM com renovação automática de token.
app.get("/api/zoho/deals", async (req, res) => {
  try {
    if (!process.env.ZOHO_REFRESH_TOKEN || !process.env.ZOHO_CLIENT_ID) {
      return res.status(500).json({ error: "Credenciais Zoho não configuradas no .env" });
    }
    const data = await zohoService.getDeals();
    res.json({ ok: true, data });
  } catch (err) {
    console.error("[Zoho]", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/zoho/reunioes ────────────────────────────────────────────────────
// Busca o relatório "Reuniões geradas no mês" do Zoho Analytics e suplementa
// com deals do mesmo mês que tenham origem em Meta Ads / Site PipeLovers mas
// foram excluídos do relatório por filtro incorreto (ex: [AT CG] no nome).
// ID configurável via ZOHO_REUNIOES_REPORT_ID no .env.
app.get("/api/zoho/reunioes", async (req, res) => {
  try {
    if (!process.env.ZOHO_REFRESH_TOKEN || !process.env.ZOHO_CLIENT_ID) {
      return res.status(500).json({ error: "Credenciais Zoho não configuradas no .env" });
    }

    const reportId  = process.env.ZOHO_REUNIOES_REPORT_ID || "6959700000006160005";
    const [reportData, allDeals] = await Promise.all([
      zohoService.getReport(reportId),
      zohoService.getDeals(),
    ]);

    // Palavras-chave de origem que indicam lead do funil Meta Ads / Site PipeLovers
    const ORIGIN_KW = [
      "pipelovers", "tofu", "bofu",
      "aula gratis", "aula grátis", "aulas gratis", "aulas grátis",
      "levantada de mão", "levantada de mao",
      "meta ads", "meta adds", "metaads",
    ];

    const normalize = (s) =>
      String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

    const hasOrigin = (leadSource) => {
      const src = normalize(leadSource);
      return ORIGIN_KW.some((kw) => src.includes(kw));
    };

    // Primeiro dia do mês corrente (considera o mês do último registro do relatório se disponível)
    const refDate     = reportData.length ? new Date(reportData[0].createdTime) : new Date();
    const firstOfMonth = new Date(refDate.getFullYear(), refDate.getMonth(), 1);
    const lastOfMonth  = new Date(refDate.getFullYear(), refDate.getMonth() + 1, 0, 23, 59, 59);

    const reportIds = new Set(reportData.map((r) => r.id));

    const missing = allDeals.filter((d) => {
      if (reportIds.has(d.id)) return false;
      const created = new Date(d.createdTime);
      if (created < firstOfMonth || created > lastOfMonth) return false;
      return hasOrigin(d.leadSource);
    });

    if (missing.length) {
      console.log(`[Zoho Reuniões] +${missing.length} deal(s) adicionados por origem (excluídos do relatório):`, missing.map((d) => d.dealName));
    }

    res.json({ ok: true, data: [...reportData, ...missing] });
  } catch (err) {
    console.error("[Zoho Reuniões]", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/zoho/campanha ────────────────────────────────────────────────────
// Busca o relatório de dados de campanha/anúncio do Zoho Analytics.
// Usado para enriquecer as reuniões com dados de campanha, conjunto e anúncio.
// ID configurável via ZOHO_CAMPANHA_REPORT_ID no .env.
app.get("/api/zoho/campanha", async (req, res) => {
  try {
    if (!process.env.ZOHO_REFRESH_TOKEN || !process.env.ZOHO_CLIENT_ID) {
      return res.status(500).json({ error: "Credenciais Zoho não configuradas no .env" });
    }
    const reportId = process.env.ZOHO_CAMPANHA_REPORT_ID || "6959700000017363001";
    const data     = await zohoService.getReport(reportId);
    res.json({ ok: true, data });
  } catch (err) {
    console.error("[Zoho Campanha]", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── POST /api/report/slack ────────────────────────────────────────────────────
// Envia o resumo calculado pelo frontend para o Slack.
app.post("/api/report/slack", async (req, res) => {
  try {
    if (!process.env.SLACK_WEBHOOK_URL) {
      return res.status(500).json({ error: "SLACK_WEBHOOK_URL não configurada no .env" });
    }
    await slackService.sendReport(req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error("[Slack]", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/meta/creative/:adId ─────────────────────────────────────────
// Retorna a URL da imagem do criativo do anúncio. Resultado é cacheado em memória.
app.get("/api/meta/creative/:adId", async (req, res) => {
  try {
    if (!process.env.META_ACCESS_TOKEN) {
      return res.status(500).json({ error: "META_ACCESS_TOKEN não configurado" });
    }
    const data = await metaService.getAdCreative(req.params.adId);
    res.json({ ok: true, data });
  } catch (err) {
    console.error("[Meta Creative]", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/meta/live ────────────────────────────────────────────────────
// Relatório ao vivo por anúncio: insights + status de veiculação.
// Query params: date_preset | since + until
app.get("/api/meta/live", async (req, res) => {
  try {
    if (!process.env.META_ACCESS_TOKEN || !process.env.META_AD_ACCOUNT_ID) {
      return res.status(500).json({ error: "META_ACCESS_TOKEN ou META_AD_ACCOUNT_ID não configurados no .env" });
    }
    const data = await metaService.getLiveData(req.query);
    res.json({ ok: true, data });
  } catch (err) {
    console.error("[Meta Live]", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/meta/live/daily ──────────────────────────────────────────────────
// Retorna dados por anúncio com breakdown diário (time_increment=1).
// Usado pelo gráfico de evolução diária da aba Live Meta.
app.get("/api/meta/live/daily", async (req, res) => {
  try {
    if (!process.env.META_ACCESS_TOKEN || !process.env.META_AD_ACCOUNT_ID) {
      return res.status(500).json({ error: "META_ACCESS_TOKEN ou META_AD_ACCOUNT_ID não configurados" });
    }
    const data = await metaService.getLiveDailyData(req.query);
    res.json({ ok: true, data });
  } catch (err) {
    console.error("[Meta Live Daily]", err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ── GET /api/meta/actions-debug ──────────────────────────────────────────────
// Retorna todos os action_types brutos da Meta API para o período, agrupados e somados.
// Útil para verificar quais tipos de lead estão sendo rastreados e evitar dupla contagem.
app.get("/api/meta/actions-debug", async (req, res) => {
  try {
    const account = process.env.META_AD_ACCOUNT_ID;
    const token   = process.env.META_ACCESS_TOKEN;
    const secret  = process.env.META_APP_SECRET;
    const version = process.env.META_API_VERSION || "v23.0";
    const crypto  = require("crypto");
    const proof   = crypto.createHmac("sha256", secret).update(token).digest("hex");

    const qs = new URLSearchParams({
      access_token:    token,
      appsecret_proof: proof,
      level:           "account",
      fields:          "actions,cost_per_action_type",
      limit:           "1",
    });
    if (req.query.since && req.query.until) {
      qs.set("time_range", JSON.stringify({ since: req.query.since, until: req.query.until }));
    } else {
      qs.set("date_preset", req.query.date_preset || "today");
    }

    const url  = `https://graph.facebook.com/${version}/act_${account}/insights?${qs}`;
    const resp = await fetch(url);
    const json = await resp.json();
    if (json.error) return res.status(502).json({ error: json.error.message });

    const actions = (json.data?.[0]?.actions || [])
      .sort((a, b) => Number(b.value) - Number(a.value));
    res.json({ ok: true, period: req.query.date_preset || "today", actions });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/google-ads/campaigns ────────────────────────────────────────────
// Métricas por campanha Google Ads.
// Query params: since + until | date_preset
app.get("/api/google-ads/campaigns", async (req, res) => {
  try {
    if (!process.env.GOOGLE_ADS_REFRESH_TOKEN || !process.env.GOOGLE_ADS_CUSTOMER_ID) {
      return res.status(500).json({ error: "Credenciais Google Ads não configuradas no .env" });
    }
    const data = await googleAdsService.getCampaignInsights(req.query);
    res.json({ ok: true, data });
  } catch (err) {
    console.error("[Google Ads Campaigns]", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/google-ads/account ───────────────────────────────────────────────
// Totais da conta Google Ads.
// Query params: since + until | date_preset
app.get("/api/google-ads/account", async (req, res) => {
  try {
    if (!process.env.GOOGLE_ADS_REFRESH_TOKEN || !process.env.GOOGLE_ADS_CUSTOMER_ID) {
      return res.status(500).json({ error: "Credenciais Google Ads não configuradas no .env" });
    }
    const data = await googleAdsService.getAccountInsights(req.query);
    res.json({ ok: true, data });
  } catch (err) {
    console.error("[Google Ads Account]", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/zoho/gads-deals ─────────────────────────────────────────────────
// Leads do Zoho CRM com origem Google Ads (filtro server-side, usa cache de 5 min).
// Regra: origem contém "levantada de mao" | "site pipelovers" | "whatsapp pipelovers"
//        E NÃO contém "metaads" | "meta ads" | "academia b2b"
app.get("/api/zoho/gads-deals", async (req, res) => {
  try {
    const all = await zohoService.getDeals();
    const filtered = all.filter(d => {
      const s = String(d.leadSource || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const flat = s.replace(/\s/g, "");
      const hasKeyword =
        s.includes("levantada de mao") ||
        s.includes("site pipelovers") ||
        s.includes("whatsapp pipelovers");
      const hasExclusion =
        flat.includes("metaads") ||
        s.includes("academia b2b");
      return hasKeyword && !hasExclusion;
    });
    res.json({ ok: true, count: filtered.length, data: filtered });
  } catch (err) {
    console.error("[Zoho gads-deals]", err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});


// ── GET /api/google-ads/daily ─────────────────────────────────────────────────
// Métricas diárias para gráfico de evolução.
app.get("/api/google-ads/daily", async (req, res) => {
  try {
    if (!process.env.GOOGLE_ADS_REFRESH_TOKEN || !process.env.GOOGLE_ADS_CUSTOMER_ID) {
      return res.status(500).json({ error: "Credenciais Google Ads não configuradas" });
    }
    const data = await googleAdsService.getDailyMetrics(req.query);
    res.json({ ok: true, data });
  } catch (err) {
    console.error("[Google Ads Daily]", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/google-ads/keywords ──────────────────────────────────────────────
// Top palavras-chave. Param opcional: campaignId.
app.get("/api/google-ads/keywords", async (req, res) => {
  try {
    if (!process.env.GOOGLE_ADS_REFRESH_TOKEN || !process.env.GOOGLE_ADS_CUSTOMER_ID) {
      return res.status(500).json({ error: "Credenciais Google Ads não configuradas" });
    }
    const { campaignId, ...params } = req.query;
    const data = await googleAdsService.getTopKeywords(params, campaignId || null);
    res.json({ ok: true, data });
  } catch (err) {
    console.error("[Google Ads Keywords]", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/google-ads/search-terms ─────────────────────────────────────────
// Top termos de pesquisa. Param opcional: campaignId.
app.get("/api/google-ads/search-terms", async (req, res) => {
  try {
    if (!process.env.GOOGLE_ADS_REFRESH_TOKEN || !process.env.GOOGLE_ADS_CUSTOMER_ID) {
      return res.status(500).json({ error: "Credenciais Google Ads não configuradas" });
    }
    const { campaignId, ...params } = req.query;
    const data = await googleAdsService.getTopSearchTerms(params, campaignId || null);
    res.json({ ok: true, data });
  } catch (err) {
    console.error("[Google Ads Search Terms]", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/google-ads/debug ─────────────────────────────────────────────────
// Diagnostica qual versão da API Google Ads está disponível.
app.get("/api/google-ads/debug", async (req, res) => {
  try {
    // Pega token
    const body = new URLSearchParams({
      client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type:    "refresh_token",
    });
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const tokenJson = await tokenResp.json();
    if (tokenJson.error) return res.json({ error: `Token: ${tokenJson.error}` });
    const token = tokenJson.access_token;

    const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID;
    const mccId      = "6109276847";
    const devToken   = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    const query      = '{"query":"SELECT campaign.id, campaign.name FROM campaign LIMIT 1"}';
    const results    = {};

    for (const ver of ["v23","v22","v21","v20","v19","v18","v17"]) {
      for (const cid of [customerId, mccId]) {
        const url = `https://googleads.googleapis.com/${ver}/customers/${cid}/googleAds:search`;
        const r = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization":     `Bearer ${token}`,
            "developer-token":   devToken,
            "login-customer-id": mccId,
            "Content-Type":      "application/json",
          },
          body: query,
        });
        const text = await r.text();
        const key  = `${ver}/cid-${cid}`;
        results[key] = { status: r.status, body: text.slice(0, 300) };
        if (r.ok) { results[key].ok = true; break; }
      }
      if (Object.values(results).some((v) => v.ok)) break;
    }
    res.json({ token: token.slice(0, 20) + "...", results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/google-auth-callback ─────────────────────────────────────────────
// Captura o code do OAuth Google e troca pelo refresh token.
app.get("/api/google-auth-callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("Erro: code não recebido.");

  try {
    const params = new URLSearchParams({
      code,
      client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      redirect_uri:  "http://localhost:3000/api/google-auth-callback",
      grant_type:    "authorization_code",
    });
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    params.toString(),
    });
    const json = await resp.json();
    if (json.error) return res.send(`Erro: ${json.error} — ${json.error_description}`);

    console.log("\n✅ Google Ads refresh_token:", json.refresh_token);
    res.send(`
      <h2>✅ Autorizado!</h2>
      <p>Adicione ao <code>.env</code>:</p>
      <pre>GOOGLE_ADS_REFRESH_TOKEN=${json.refresh_token}</pre>
      <p>Pode fechar esta aba.</p>
    `);
  } catch (err) {
    res.send(`Erro: ${err.message}`);
  }
});

// ── POST /api/google-ads/keyword-ideas ───────────────────────────────────────
// Gera ideias de palavras-chave com volume, CPC estimado e score de cliques.
// Body: { seeds: ["palavra1", "palavra2"], minVolume: 100, network: "GOOGLE_SEARCH" }
app.post("/api/google-ads/keyword-ideas", async (req, res) => {
  try {
    const { seeds, minVolume = 0, network, language, geoTargets } = req.body || {};
    if (!Array.isArray(seeds) || seeds.filter(Boolean).length === 0) {
      return res.status(400).json({ ok: false, error: "Envie ao menos uma palavra-chave semente em 'seeds'." });
    }
    const cleanSeeds = seeds.map(s => String(s).trim()).filter(Boolean);
    const ideas      = await googleAdsService.generateKeywordIdeas(cleanSeeds, { network, language, geoTargets });
    const filtered   = minVolume > 0 ? ideas.filter(k => k.volume >= minVolume) : ideas;
    res.json({ ok: true, count: filtered.length, data: filtered });
  } catch (err) {
    console.error("[Keyword Ideas]", err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ── GET /api/slack/mql ────────────────────────────────────────────────────────
// Retorna leads MQL do canal #inside-sales-novo-lead.
// Tenta SLACK_BOT_TOKEN; se falhar, usa slack_mql_cache.json (populado pelo Claude via MCP).
app.get("/api/slack/mql", async (req, res) => {
  try {
    const slackMqlService = require("./services/slackMqlService");
    const channel = req.query.channel || "C05G0BZ904W";
    const limit   = Math.min(parseInt(req.query.limit || "200", 10), 200);
    const data    = await slackMqlService.getMqlLeads(channel, limit);
    const cache   = slackMqlService.readCache();
    res.json({ ok: true, count: data.length, data, updatedAt: cache.updatedAt });
  } catch (err) {
    console.error("[Slack MQL]", err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ── POST /api/keyword-planner/ia/run ─────────────────────────────────────────
// Executa o planejador iterativo. Responde via SSE (stream).
// Body: { subject, seeds, products, goalClicksDay, dailyBudget, maxCpc,
//         maxAttempts, maxKeywords, network, matchType, intent, existingKeywords }
app.post("/api/keyword-planner/ia/run", async (req, res) => {
  if (!process.env.GOOGLE_ADS_REFRESH_TOKEN || !process.env.GOOGLE_ADS_CUSTOMER_ID) {
    return res.status(500).json({ error: "Credenciais Google Ads não configuradas no .env" });
  }

  // SSE headers
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const sendEvent = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); }
    catch (_) { /* client disconnected */ }
  };

  try {
    const kwPlannerService = require("./services/kwPlannerService");
    await kwPlannerService.runIterativePlanner(req.body || {}, sendEvent);
  } catch (err) {
    console.error("[KwPlanner IA]", err.message);
    sendEvent({ type: "error", error: err.message });
  }

  res.write("data: [DONE]\n\n");
  res.end();
});

// ── GET /api/keyword-planner/ia/campaigns ─────────────────────────────────────
// Lista campanhas da conta para o modal de publicação.
app.get("/api/keyword-planner/ia/campaigns", async (req, res) => {
  try {
    if (!process.env.GOOGLE_ADS_REFRESH_TOKEN || !process.env.GOOGLE_ADS_CUSTOMER_ID) {
      return res.status(500).json({ error: "Credenciais Google Ads não configuradas" });
    }
    const data = await googleAdsService.getCampaignsList();
    res.json({ ok: true, data });
  } catch (err) {
    console.error("[KwPlanner Campaigns]", err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ── GET /api/keyword-planner/ia/adgroups ─────────────────────────────────────
// Lista grupos de anúncio de uma campanha. Query: campaignId
app.get("/api/keyword-planner/ia/adgroups", async (req, res) => {
  try {
    const { campaignId } = req.query;
    if (!campaignId) return res.status(400).json({ ok: false, error: "campaignId obrigatório" });
    const data = await googleAdsService.getAdGroupsByCampaign(campaignId);
    res.json({ ok: true, data });
  } catch (err) {
    console.error("[KwPlanner AdGroups]", err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ── POST /api/keyword-planner/ia/publish ──────────────────────────────────────
// Adiciona keywords selecionadas a um grupo de anúncio no Google Ads.
// Body: { adGroupId, keywords, cpcMaxBRL, matchType, status }
app.post("/api/keyword-planner/ia/publish", async (req, res) => {
  try {
    if (!process.env.GOOGLE_ADS_REFRESH_TOKEN || !process.env.GOOGLE_ADS_CUSTOMER_ID) {
      return res.status(500).json({ error: "Credenciais Google Ads não configuradas" });
    }
    const { adGroupId, keywords, cpcMaxBRL = 5, matchType = "BROAD", status = "PAUSED" } = req.body || {};
    if (!adGroupId)                               return res.status(400).json({ ok: false, error: "adGroupId obrigatório" });
    if (!Array.isArray(keywords) || !keywords.length) return res.status(400).json({ ok: false, error: "keywords[] obrigatório" });

    const result = await googleAdsService.addKeywordsToAdGroup({ adGroupId, keywords, cpcMaxBRL, matchType, status });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[KwPlanner Publish]", err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

// ── GET /api/keyword-planner/ia/quota ────────────────────────────────────────
// Retorna status atual da quota diária e cache em memória.
// Aceita query: ?clearCache=1 para invalidar cache, ?resetQuota=1 (dev only)
app.get("/api/keyword-planner/ia/quota", (req, res) => {
  try {
    const quotaManager = require("./services/quotaManager");
    if (req.query.clearCache === "1") {
      quotaManager.cacheClear();
    }
    const status = quotaManager.getStatus();
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/keyword-planner/ia/test ─────────────────────────────────────────
// Diagnóstico: testa generateKeywordIdeas com 1 seed e retorna resultado + combinação que funcionou.
app.get("/api/keyword-planner/ia/test", async (req, res) => {
  const seed        = req.query.seed || "treinamento de vendas";
  const customerId  = (process.env.GOOGLE_ADS_CUSTOMER_ID || "").replace(/-/g, "");
  const mccId       = (process.env.GOOGLE_ADS_MCC_ID || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "").replace(/-/g, "");
  const kwOverride  = (process.env.GOOGLE_ADS_KW_CUSTOMER_ID || "").replace(/-/g, "");
  console.log("[KwPlanner Test] customerId:", customerId, "| mccId:", mccId || "N/A", "| kwOverride:", kwOverride || "N/A");
  try {
    const ideas = await googleAdsService.generateKeywordIdeas([seed], {
      language:   "languageConstants/1014",
      geoTargets: ["geoTargetConstants/2076"],
      network:    "GOOGLE_SEARCH",
      pageSize:   10,
    });
    res.json({
      ok: true, seed,
      count: ideas.length,
      sample: ideas.slice(0, 5),
      config: { customerId, mccId: mccId || null, kwOverride: kwOverride || null },
      hint: ideas.length === 0 ? "API retornou 0 resultados. As seeds podem não ter dados para essa região/idioma." : null,
    });
  } catch (err) {
    console.error("[KwPlanner Test] Falhou:", err.message);
    res.status(502).json({
      ok: false, seed,
      error: err.message,
      config: { customerId, mccId: mccId || null, kwOverride: kwOverride || null },
      hint: !mccId
        ? "GOOGLE_ADS_MCC_ID não está no .env. Se sua conta é sub-conta de um MCC, adicione: GOOGLE_ADS_MCC_ID=<seu-mcc-id>"
        : "Veja o console do servidor para detalhes do erro por combinação.",
    });
  }
});

// ── GET /api/status ───────────────────────────────────────────────────────────
// Verifica quais integrações estão configuradas (sem expor os valores).
app.get("/api/status", (_req, res) => {
  const fs   = require("fs");
  const path = require("path");
  const cacheFile = path.join(__dirname, "slack_mql_cache.json");
  const hasSlack  = !!process.env.SLACK_BOT_TOKEN || fs.existsSync(cacheFile);
  res.json({
    meta:       !!(process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID),
    zoho:       !!(process.env.ZOHO_REFRESH_TOKEN && process.env.ZOHO_CLIENT_ID),
    slack:      hasSlack,
    google:     !!(process.env.GOOGLE_ADS_REFRESH_TOKEN && process.env.GOOGLE_ADS_CUSTOMER_ID),
    googleMcc:  !!(process.env.GOOGLE_ADS_MCC_ID || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
  });
});

// ── GET /api/version ─────────────────────────────────────────────────────────
// Retorna versão, commit hash e ambiente para o footer do dashboard.
// Em produção usa VERCEL_GIT_COMMIT_SHA (injetado automaticamente pela Vercel).
// Em desenvolvimento usa git rev-parse para obter o hash local.
app.get("/api/version", (req, res) => {
  const { execSync } = require("child_process");
  const pkg = require("./package.json");

  let commit = process.env.VERCEL_GIT_COMMIT_SHA
    ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7)
    : null;

  if (!commit) {
    try {
      commit = execSync("git rev-parse --short HEAD", { stdio: ["pipe", "pipe", "ignore"] })
        .toString().trim();
    } catch (_) {
      commit = "local";
    }
  }

  res.json({
    version: pkg.version,
    commit,
    env: process.env.VERCEL_ENV || "development",
  });
});

app.listen(PORT, () => {
  console.log(`\n✅ Dashboard rodando em http://localhost:${PORT}`);
  console.log(`   Meta:  ${process.env.META_ACCESS_TOKEN ? "✓ configurado" : "✗ META_ACCESS_TOKEN ausente"}`);
  console.log(`   Zoho:  ${process.env.ZOHO_REFRESH_TOKEN ? "✓ configurado" : "✗ ZOHO_REFRESH_TOKEN ausente"}`);
  console.log(`   Slack: ${process.env.SLACK_WEBHOOK_URL ? "✓ configurado" : "✗ SLACK_WEBHOOK_URL ausente"}\n`);
});
