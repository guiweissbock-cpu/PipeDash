/**
 * utils/calculations.js
 * Regras de funil e fórmulas de negócio.
 * Edite as listas de stages para ajustar sem mudar o restante do código.
 */

const { normalizeKey } = require("./normalize");

// Stages que contam como Reunião Gerada (match exato, normalizado)
const MEETING_STAGES = [
  "reuniao agendada",
  "reuniao realizada",
];

// Palavras-chave que contam como Assinatura (match parcial, normalizado)
const SIGNUP_KEYWORDS = [
  "assinatura",
  "assinado",
  "fechado ganho",
  "ganho",
  "venda realizada",
];

function isMeetingStage(stage) {
  const key = normalizeKey(stage);
  return MEETING_STAGES.some((s) => key === normalizeKey(s));
}

function isSignupStage(stage) {
  const key = normalizeKey(stage);
  return SIGNUP_KEYWORDS.some((kw) => key.includes(normalizeKey(kw)));
}

function safeDiv(a, b) {
  if (!b || !isFinite(b)) return null;
  return a / b;
}

module.exports = { isMeetingStage, isSignupStage, safeDiv, MEETING_STAGES, SIGNUP_KEYWORDS };
