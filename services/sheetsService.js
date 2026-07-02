/**
 * services/sheetsService.js
 * Busca e parseia a planilha de atribuição do Google Sheets.
 *
 * A planilha deve estar com "Qualquer pessoa com o link pode visualizar".
 * Usa a URL do Google Visualization API (sem API key para sheets públicas).
 *
 * Env vars opcionais:
 *   LEADS_SHEET_ID  — ID da planilha (padrão: ID atual)
 *   LEADS_SHEET_GID — gid da aba (padrão: 419082496)
 */

const https = require("https");
const http  = require("http");

const SHEET_ID  = process.env.LEADS_SHEET_ID  || "1SiSx3Wg608N80Gie47-GtYwUOUa8gGQjznx7Vv375m4";
const SHEET_GID = process.env.LEADS_SHEET_GID || "419082496";
const CACHE_TTL = 5 * 60 * 1000; // 5 min

let cache     = null;
let cacheTime = 0;

// Índices de coluna (0-based) — verificados via leitura da planilha em 2026-07-02
const C = {
  EMAIL:            0,
  NOME:             1,
  EMPRESA:          2,
  CARGO:            3,
  SITE:             4,
  TELEFONE:         5,
  DATA:             8,
  FONTE:            9,
  CAMPANHA:         10,
  ORIGEM:           11,
  PAGINA_CONVERSAO: 12,
  NOME_FORMULARIO:  13,
  UTM_ID_LEAD:      14,
  TAG:              15,
  KEYWORD:          16,
  TAG2:             17,
  GCLID:            18,
  GBRAID:           19,
  FBCLID:           22,
  META_CAMPANHA:    23,
  META_ANUNCIO:     24,
  META_ADS_ID:      25,
  META_LEADS_ID:    26,
};

function col(row, idx) {
  return (row[idx] || "").trim();
}

// Extrai parâmetros UTM de uma string que pode ser URL completa ou query string
function parseUtmString(raw) {
  const out = { utmCampaign: "", utmContent: "", utmKeyword: "", utmSource: "", utmMedium: "", gclid: "", gbraid: "" };
  if (!raw || (!raw.includes("utm_") && !raw.includes("gclid") && !raw.includes("gbraid"))) return out;
  try {
    let qs = raw.includes("?") ? raw.split("?")[1] : raw;
    const p = new URLSearchParams(qs);
    out.utmCampaign = p.get("utm_campaign") || p.get("campaign") || "";
    out.utmContent  = p.get("utm_content")  || p.get("ad") || p.get("ad_name") || p.get("creative") || "";
    out.utmKeyword  = p.get("utm_term") || p.get("utm_keyword") || p.get("keyword") || p.get("searchterm") || "";
    out.utmSource   = p.get("utm_source") || "";
    out.utmMedium   = p.get("utm_medium") || "";
    out.gclid       = p.get("gclid") || "";
    out.gbraid      = p.get("gbraid") || "";
  } catch (_) {}
  return out;
}

function classifyChannel(row) {
  const gclid          = col(row, C.GCLID);
  const gbraid         = col(row, C.GBRAID);
  const fbclid         = col(row, C.FBCLID);
  const origem         = col(row, C.ORIGEM).toLowerCase();
  const tag            = (col(row, C.TAG) + " " + col(row, C.TAG2)).toLowerCase();
  const nomeFormulario = col(row, C.NOME_FORMULARIO).toLowerCase();
  const metaAdsId      = col(row, C.META_ADS_ID);
  const metaLeadsId    = col(row, C.META_LEADS_ID);

  // Google Ads — qualquer condição abaixo
  if (gclid || gbraid)                                                           return "Google Ads";
  if (nomeFormulario.includes("whatsapp"))                                       return "Google Ads";
  if (origem.includes("google ads") || origem.includes("g-ads") ||
      origem.includes("google_ads"))                                              return "Google Ads";
  if (tag.includes("google ads")    || tag.includes("g-ads"))                   return "Google Ads";

  // Meta Ads
  if (fbclid || metaAdsId || metaLeadsId)                                        return "Meta Ads";
  if (origem.includes("meta ads")   || origem.includes("meta add") ||
      origem.includes("facebook")   || origem.includes("instagram"))             return "Meta Ads";

  // Orgânico por padrão
  return "Orgânico";
}

function parseRow(row) {
  if (row.length < 2) return null;
  const email = col(row, C.EMAIL);
  // Pula linha vazia ou cabeçalho
  if (!email || email.toLowerCase() === "e-mail" || email === "Email") return null;

  const utmRaw = col(row, C.UTM_ID_LEAD);
  const utm    = parseUtmString(utmRaw);
  const channel = classifyChannel(row);

  // Campanha: coluna Campanha → utm_campaign → Meta Ads Campanha
  const campanha = col(row, C.CAMPANHA) || utm.utmCampaign || col(row, C.META_CAMPANHA);

  // Anúncio: Meta Ads - Anuncio → utm_content → Tag
  const anuncio = col(row, C.META_ANUNCIO) || utm.utmContent || col(row, C.TAG);

  // Palavra-chave: KEYWORD → utm_term/keyword
  const keyword = col(row, C.KEYWORD) || utm.utmKeyword;

  return {
    email,
    nome:            col(row, C.NOME),
    empresa:         col(row, C.EMPRESA),
    cargo:           col(row, C.CARGO),
    telefone:        col(row, C.TELEFONE),
    data:            col(row, C.DATA),
    fonte:           col(row, C.FONTE),
    campanha,
    anuncio,
    keyword,
    origem:          col(row, C.ORIGEM),
    paginaConversao: col(row, C.PAGINA_CONVERSAO),
    nomeFormulario:  col(row, C.NOME_FORMULARIO),
    tag:             col(row, C.TAG),
    gclid:           col(row, C.GCLID) || utm.gclid,
    gbraid:          col(row, C.GBRAID) || utm.gbraid,
    fbclid:          col(row, C.FBCLID),
    metaAdsId:       col(row, C.META_ADS_ID),
    metaLeadsId:     col(row, C.META_LEADS_ID),
    metaCampanha:    col(row, C.META_CAMPANHA),
    metaAnuncio:     col(row, C.META_ANUNCIO),
    channel,
  };
}

// CSV parser com suporte a campos entre aspas e vírgulas internas
function parseCsv(text) {
  const rows  = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = [];
    let inQuote = false;
    let cell    = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && !inQuote)  { inQuote = true;  continue; }
      if (ch === '"' && inQuote)   {
        if (line[i + 1] === '"')   { cell += '"'; i++; } // aspas duplas escapadas
        else inQuote = false;
        continue;
      }
      if (ch === "," && !inQuote)  { row.push(cell.trim()); cell = ""; continue; }
      cell += ch;
    }
    row.push(cell.trim());
    rows.push(row);
  }
  return rows;
}

// Fetch com suporte a redirecionamentos
function fetchText(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error("Muitos redirecionamentos"));
    const proto = url.startsWith("https") ? https : http;
    proto.get(url, { timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location, depth + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Sheets retornou HTTP ${res.statusCode}`));
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    }).on("error", reject).on("timeout", function () {
      this.destroy();
      reject(new Error("Timeout ao buscar planilha"));
    });
  });
}

async function getLeads({ forceRefresh = false } = {}) {
  if (!forceRefresh && cache && Date.now() - cacheTime < CACHE_TTL) {
    return cache;
  }

  // Google Visualization API — funciona para sheets com "Qualquer pessoa com o link pode visualizar"
  const url  = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${SHEET_GID}`;
  const csv  = await fetchText(url);
  const rows = parseCsv(csv);

  // Primeira linha = cabeçalho — pular
  const leads = rows.slice(1).map(parseRow).filter(Boolean);

  cache     = leads;
  cacheTime = Date.now();
  console.log(`[Sheets] ${leads.length} leads carregados da planilha`);
  return leads;
}

module.exports = { getLeads };
