/**
 * server.js
 * Servidor Express local — roda em http://localhost:3000
 * Nunca expõe tokens ao frontend. Todas as chamadas sensíveis passam por aqui.
 */

require("dotenv").config();

const express = require("express");
const path    = require("path");

const metaService  = require("./services/metaService");
const zohoService  = require("./services/zohoService");
const slackService = require("./services/slackService");

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

// ── GET /api/status ───────────────────────────────────────────────────────────
// Verifica quais integrações estão configuradas (sem expor os valores).
app.get("/api/status", (_req, res) => {
  res.json({
    meta:  !!(process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID),
    zoho:  !!(process.env.ZOHO_REFRESH_TOKEN && process.env.ZOHO_CLIENT_ID),
    slack: !!process.env.SLACK_WEBHOOK_URL,
  });
});

app.listen(PORT, () => {
  console.log(`\n✅ Dashboard rodando em http://localhost:${PORT}`);
  console.log(`   Meta:  ${process.env.META_ACCESS_TOKEN ? "✓ configurado" : "✗ META_ACCESS_TOKEN ausente"}`);
  console.log(`   Zoho:  ${process.env.ZOHO_REFRESH_TOKEN ? "✓ configurado" : "✗ ZOHO_REFRESH_TOKEN ausente"}`);
  console.log(`   Slack: ${process.env.SLACK_WEBHOOK_URL ? "✓ configurado" : "✗ SLACK_WEBHOOK_URL ausente"}\n`);
});
