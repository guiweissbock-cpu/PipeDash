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

// Extrai todos os parâmetros de uma URL completa ou query string.
// Usa new URL() quando possível — URLSearchParams decodifica %XX automaticamente (ex: %20 → espaço).
function parseUrlParams(raw) {
  const out = {};
  if (!raw) return out;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://dummy.invalid/?${raw}`);
    for (const [k, v] of url.searchParams) out[k] = v;
  } catch (_) {}
  return out;
}

function classifyChannel(row, p = {}) {
  const gclid          = col(row, C.GCLID)  || p.gclid  || "";
  const gbraid         = col(row, C.GBRAID) || p.gbraid || "";
  const fbclid         = col(row, C.FBCLID);
  const origem         = (col(row, C.ORIGEM) || p.utm_source || "").toLowerCase();
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

  // Tenta extrair parâmetros da URL completa.
  // Prioridade: coluna N → coluna M → coluna O (a que contiver URL completa vence).
  const rawN = col(row, C.NOME_FORMULARIO);  // coluna N — contém URL para Google Ads
  const rawM = col(row, C.PAGINA_CONVERSAO); // coluna M
  const rawO = col(row, C.UTM_ID_LEAD);      // coluna O — pode ter URL ou Meta Lead ID
  const urlSource = rawN.startsWith("http") ? rawN
                  : rawM.startsWith("http") ? rawM
                  : rawO.startsWith("http") ? rawO
                  : (rawN || rawM || rawO);
  const p = parseUrlParams(urlSource);

  const channel = classifyChannel(row, p);

  // Campanha: utm_campaign (URL) → coluna K → Meta Campanha
  const campanha = p.utm_campaign || col(row, C.CAMPANHA) || col(row, C.META_CAMPANHA);

  // Anúncio: Meta Ads coluna → utm_content (URL) → Tag
  const anuncio = col(row, C.META_ANUNCIO) || p.utm_content || p.ad_name || p.ad || col(row, C.TAG);

  // Palavra-chave: utm_term → utm_keyword → keyword → searchterm → coluna Q
  const keyword = p.utm_term || p.utm_keyword || p.keyword || p.searchterm || col(row, C.KEYWORD);

  // GCLID / GBRAID: URL tem prioridade sobre colunas dedicadas
  const gclid  = p.gclid  || col(row, C.GCLID);
  const gbraid = p.gbraid || col(row, C.GBRAID);

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
    origem:          p.utm_source || col(row, C.ORIGEM),
    paginaConversao: col(row, C.PAGINA_CONVERSAO),
    nomeFormulario:  rawN.startsWith("http") ? "" : rawN, // se col N for URL, não mostra como nome
    tag:             col(row, C.TAG),
    gclid,
    gbraid,
    fbclid:          col(row, C.FBCLID),
    metaAdsId:       col(row, C.META_ADS_ID),
    metaLeadsId:     col(row, C.META_LEADS_ID),
    metaCampanha:    col(row, C.META_CAMPANHA),
    metaAnuncio:     col(row, C.META_ANUNCIO),
    gadCampaignId:   p.gad_campaignid || "",
    gadSource:       p.gad_source     || "",
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
