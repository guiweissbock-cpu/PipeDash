/**
 * services/slackService.js
 * Envia report resumido para Slack via Incoming Webhook.
 */

function fmtBRL(n) {
  if (!isFinite(n) || n === null || n === undefined) return "R$ 0,00";
  return Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });
}

function fmtInt(n) {
  if (!isFinite(n) || n === null || n === undefined) return "0";
  return Math.round(Number(n)).toLocaleString("pt-BR");
}

function buildMessage(payload) {
  const { data, resumoDia, acumulado, topCriativos, insightPeriodo } = payload;

  return (
    `📊 *Report Meta Ads + Zoho* | PipeLovers\n` +
    `Data: ${data}\n\n` +
    `*Resumo do Dia*\n` +
    `• Valor gasto: ${fmtBRL(resumoDia.valorGasto)}\n` +
    `• Leads Meta: ${fmtInt(resumoDia.leadsMeta)}\n` +
    `• Leads Zoho: ${fmtInt(resumoDia.leadsZoho)}\n` +
    `• Reuniões geradas: ${fmtInt(resumoDia.reunioes)}\n` +
    `• Assinaturas realizadas: ${fmtInt(resumoDia.assinaturas)}\n` +
    `• CPL Meta: ${fmtBRL(resumoDia.cplMeta)}\n` +
    `• Custo por reunião: ${fmtBRL(resumoDia.custoReuniao)}\n` +
    `• Custo por assinatura: ${fmtBRL(resumoDia.custoAssinatura)}\n\n` +
    `*Acumulado*\n` +
    `• Investimento total: ${fmtBRL(acumulado.valorGasto)}\n` +
    `• Leads Meta: ${fmtInt(acumulado.leadsMeta)}\n` +
    `• Leads Zoho: ${fmtInt(acumulado.leadsZoho)}\n` +
    `• Reuniões geradas: ${fmtInt(acumulado.reunioes)}\n` +
    `• Assinaturas realizadas: ${fmtInt(acumulado.assinaturas)}\n\n` +
    `*Top Criativos*\n` +
    `🥇 Mais assinaturas: ${topCriativos.assinaturas || "—"}\n` +
    `🥈 Mais reuniões: ${topCriativos.reunioes || "—"}\n` +
    `🥉 Mais leads: ${topCriativos.leads || "—"}\n\n` +
    `*Insight rápido*\n` +
    `${insightPeriodo || "Sem insights disponíveis."}`
  );
}

async function sendReport(payload) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) throw new Error("SLACK_WEBHOOK_URL não configurada no .env");

  const text = buildMessage(payload);
  const res  = await fetch(webhookUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ text }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Slack respondeu ${res.status}: ${err}`);
  }
  return { ok: true };
}

module.exports = { sendReport };
