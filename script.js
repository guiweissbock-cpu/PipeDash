/* ==========================================================================
   Report Meta Ads + Zoho CRM | PipeLovers
   Pipeline 100% client-side: leitura de planilhas (SheetJS), cruzamento
   Meta Ads x Zoho CRM, métricas, rankings, insights, gráficos (Chart.js)
   e envio de report para o Slack via endpoint serverless /api/send-slack-report.
   ========================================================================== */

// ---------------------------------------------------------------------------
// CONFIGURAÇÃO (fácil de ajustar)
// ---------------------------------------------------------------------------
const CONFIG = {
  // Stages que contam como "Reunião Gerada" (com origem META).
  // Inclui etapas posteriores à reunião: proposta/negociação/assinatura/ativação implicam
  // que houve reunião. "Fechado perdido" é excluído — a maioria das perdas ocorre antes
  // de qualquer reunião; incluir causaria over-count massivo (~9k deals).
  meetingStages: [
    "reuniao agendada",
    "reuniao realizada",
    "reuniao exploratoria realizada",
    "reuniao alinhamento",
    "no show",
    "proposta enviada",
    "negociacao",
    "assinatura realizada",
    "handoff",
    "em ativacao 30 dias",
    "em ativacao 60 dias",
    "membros ativados no mes",
    "agendar reuniao de onboarding individual",
    "reuniao de onboarding agendada",
    "no-show onboarding",
    "pdi",
    "high touch",
    "mid touch",
    "low touch",
    "1 reuniao pos passagem",
    "passagem de bastao onb",
    "reversao de churn",
    "abertura de upsell",
    "churn realizado",
    "churn solicitado",
    "churn b2b",
  ],
  // Stage exato que conta como Assinatura (com origem META)
  signupStageKeywords: ["assinatura realizada"],
  // Quantos itens mostrar nos gráficos de "top N"
  topN: 8,
  // Quantos itens mostrar em cada ranking
  rankingSize: 5,
};

// ---------------------------------------------------------------------------
// ESTADO GLOBAL
// ---------------------------------------------------------------------------
const state = {
  metaRows: [],        // linhas brutas normalizadas da planilha Meta Ads
  zohoRows: [],        // todos os deals do Zoho (API ou CSV) — usado para contagem de leads e cruzamento
  zohoFiltered: [],    // zohoRows após filtro de período
  reunioesRows: [],    // relatório "Reuniões geradas no mês" — fonte oficial de reuniões
  reunioesFiltered: [],// reunioesRows após filtro de período
  campanhaRows: [],    // relatório de campanha (enriquecimento de dados)
  creatives: [],       // dados agregados por criativo (após cruzamento)
  filtered: [],        // `creatives` após aplicar filtros globais
  sort: { key: "valorGasto", dir: "desc" },
  charts: {},
  metaFile: null,
  zohoFile: null,
  isOfficialReunioesData: false, // true quando reunioesRows vem do relatório Zoho Analytics (não filtrar por isMetaOrigin)
  formLeads: [],               // submissões do formulário recebidas via Pluga → /api/webhooks/form-lead
  sheetLeads: [],              // leads da planilha de atribuição → /api/sheets/form-leads
};

// ---------------------------------------------------------------------------
// HELPERS DE NORMALIZACAO / TEXTO
// Os conjuntos de caracteres "invisiveis" e o range de marcas diacriticas
// combinantes (que sobra apos normalize("NFD")) sao montados a partir de
// CODE POINTS NUMERICOS (String.fromCharCode), e nao de caracteres colados
// diretamente no codigo-fonte. Isso evita qualquer ambiguidade de encoding.
// ---------------------------------------------------------------------------
function charFromCode(code) {
  return String.fromCharCode(code);
}
function buildCharRangeRegex(startCode, endCode) {
  return new RegExp("[" + charFromCode(startCode) + "-" + charFromCode(endCode) + "]", "g");
}
function buildCharSetRegex(codePoints, extraPattern) {
  const chars = codePoints.map(charFromCode).join("");
  return new RegExp("[" + chars + (extraPattern || "") + "]", "g");
}

// Combining Diacritical Marks: U+0300 a U+036F.
const COMBINING_DIACRITICS_RE = buildCharRangeRegex(0x0300, 0x036f);
// NBSP(0x00A0), espaco fino(0x2009), ZWSP(0x200B), ZWNJ(0x200C), ZWJ(0x200D), BOM/ZWNBSP(0xFEFF) + \s.
const INVISIBLE_CODE_POINTS = [0x00a0, 0x2009, 0x200b, 0x200c, 0x200d, 0xfeff];
const INVISIBLE_CHARS_RE = buildCharSetRegex(INVISIBLE_CODE_POINTS, "\\s");

function stripAccents(str) {
  return String(str).normalize("NFD").replace(COMBINING_DIACRITICS_RE, "");
}

function normalizeKey(str) {
  if (str === null || str === undefined) return "";
  return stripAccents(String(str))
    .replace(INVISIBLE_CHARS_RE, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function cleanDisplay(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(INVISIBLE_CHARS_RE, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function toNumber(val) {
  if (val === null || val === undefined || val === "") return 0;
  if (typeof val === "number") return isFinite(val) ? val : 0;
  let s = String(val).trim();
  // remove símbolos de moeda e espaços
  s = s.replace(/R\$\s?/gi, "").replace(/%/g, "").trim();
  // formato BR: 1.234,56  -> 1234.56  | formato US: 1,234.56 -> 1234.56
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma && !hasDot) {
    s = s.replace(",", ".");
  }
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

function parseDateValue(val) {
  if (val === null || val === undefined || val === "") return null;
  if (val instanceof Date) return val;
  if (typeof val === "number") {
    // número de série do Excel
    const parsed = XLSX.SSF ? XLSX.SSF.parse_date_code(val) : null;
    if (parsed) return new Date(parsed.y, parsed.m - 1, parsed.d, parsed.H || 0, parsed.M || 0, parsed.S || 0);
  }
  const s = String(val).trim();
  // dd/mm/yyyy ou dd-mm-yyyy
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = "20" + y;
    return new Date(Number(y), Number(mo) - 1, Number(d));
  }
  // yyyy-mm-dd
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const [, y, mo, d] = m;
    return new Date(Number(y), Number(mo) - 1, Number(d));
  }
  const d2 = new Date(s);
  return isNaN(d2.getTime()) ? null : d2;
}

function fmtCurrency(n) {
  if (!isFinite(n)) return "—";
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 });
}
function fmtInt(n) {
  if (!isFinite(n)) return "—";
  return Math.round(n).toLocaleString("pt-BR");
}
function fmtPct(n) {
  if (!isFinite(n)) return "—";
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + "%";
}
function fmtRatio(n, suffix) {
  if (!isFinite(n) || n === 0) return "—";
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + (suffix || "");
}
function safeDiv(a, b) {
  if (!b) return NaN;
  return a / b;
}

// ---------------------------------------------------------------------------
// LEITURA DE PLANILHAS (SheetJS) + DETECÇÃO AUTOMÁTICA DE CABEÇALHO
// ---------------------------------------------------------------------------
async function readWorkbook(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  // matriz bruta (linha por linha), preservando linhas vazias/lixo antes do header
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
  return matrix;
}

// Tenta localizar, dentre as primeiras N linhas, qual é a linha de cabeçalho real,
// comparando cada linha com um conjunto de palavras-chave esperadas.
function detectHeaderRow(matrix, expectedKeywords, maxScanRows = 15) {
  let bestRow = 0;
  let bestScore = -1;
  const limit = Math.min(matrix.length, maxScanRows);
  for (let i = 0; i < limit; i++) {
    const row = matrix[i] || [];
    const normalizedCells = row.map((c) => normalizeKey(c));
    let score = 0;
    expectedKeywords.forEach((kw) => {
      if (normalizedCells.some((c) => c.includes(kw))) score++;
    });
    // linhas com mais células não-vazias também ajudam a desempatar
    const nonEmpty = row.filter((c) => cleanDisplay(c) !== "").length;
    score += nonEmpty * 0.01;
    if (score > bestScore) {
      bestScore = score;
      bestRow = i;
    }
  }
  return bestRow;
}

function matrixToObjects(matrix, headerRowIdx) {
  const headerRow = matrix[headerRowIdx] || [];
  const headers = headerRow.map((h) => cleanDisplay(h));
  const rows = [];
  for (let i = headerRowIdx + 1; i < matrix.length; i++) {
    const raw = matrix[i];
    if (!raw || raw.every((c) => cleanDisplay(c) === "")) continue; // ignora linhas vazias
    const obj = {};
    headers.forEach((h, idx) => {
      if (!h) return;
      obj[h] = raw[idx];
    });
    rows.push(obj);
  }
  return { headers, rows };
}

// Mapeia, de forma flexível, o nome de cabeçalho real para uma chave lógica,
// procurando por aliases normalizados (sem acento, case-insensitive).
function buildHeaderMap(headers, aliasMap) {
  const map = {};
  const normalizedHeaders = headers.map((h) => ({ original: h, norm: normalizeKey(h) }));
  Object.entries(aliasMap).forEach(([logicalKey, aliases]) => {
    const found = normalizedHeaders.find((h) =>
      aliases.some((alias) => h.norm === normalizeKey(alias) || h.norm.includes(normalizeKey(alias)))
    );
    if (found) map[logicalKey] = found.original;
  });
  return map;
}

// ---------------------------------------------------------------------------
// PARSE META ADS
// ---------------------------------------------------------------------------
const META_ALIASES = {
  campanha: ["nome da campanha", "campanha"],
  conjunto: ["nome do conjunto de anuncios", "conjunto de anuncios", "ad set name"],
  anuncio: ["nome do anuncio", "anuncio", "ad name"],
  impressoes: ["impressoes", "impressions"],
  frequencia: ["frequencia", "frequency"],
  valorUsado: ["valor usado (brl)", "valor usado", "amount spent"],
  cliques: ["cliques (todos)", "cliques", "clicks (all)", "link clicks"],
  cpm: ["cpm"],
  ctr: ["ctr"],
  cpc: ["cpc"],
  leads: ["leads", "resultados", "results"],
  dataInicio: ["data inicio", "data de inicio", "reporting starts", "start date"],
  dataFim: ["data fim", "data de termino", "reporting ends", "end date"],
  adId: ["id do anuncio", "ad id", "identificacao do anuncio"],
};

function parseMetaAds(matrix) {
  const headerIdx = detectHeaderRow(matrix, [
    "nome da campanha", "nome do anuncio", "impressoes", "cliques", "leads",
  ]);
  const { headers, rows } = matrixToObjects(matrix, headerIdx);
  const map = buildHeaderMap(headers, META_ALIASES);

  return rows
    .map((r) => {
      const anuncio = cleanDisplay(r[map.anuncio]);
      if (!anuncio) return null;
      return {
        campanha: cleanDisplay(r[map.campanha]) || "(sem campanha)",
        conjunto: cleanDisplay(r[map.conjunto]) || "(sem conjunto)",
        anuncio,
        anuncioKey: normalizeKey(anuncio),
        impressoes: toNumber(r[map.impressoes]),
        frequencia: toNumber(r[map.frequencia]),
        valorGasto: toNumber(r[map.valorUsado]),
        cliques: toNumber(r[map.cliques]),
        leads: toNumber(r[map.leads]),
        dataInicio: map.dataInicio ? parseDateValue(r[map.dataInicio]) : null,
        dataFim: map.dataFim ? parseDateValue(r[map.dataFim]) : null,
        adId: map.adId ? normalizeKey(r[map.adId]) : "",
      };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// PARSE ZOHO CRM
// ---------------------------------------------------------------------------
const ZOHO_ALIASES = {
  id: ["id", "record id", "deal id", "id do negocio", "negocio id"],
  nomeNegocio: ["nome negocios", "nome do negocio", "deal name"],
  nomeContato: ["nome contato", "nome do contato", "contact name"],
  origem: ["origem", "lead source"],
  metaAdsId: ["meta ads - ads id", "meta ads ads id", "ad id"],
  metaAdsAnuncio: ["meta ads - anuncio", "meta ads anuncio"],
  metaAdsCampanha: ["meta ads - campanha", "meta ads campanha"],
  metaAdsLeadId: ["meta ads - lead id", "meta ads lead id"],
  metaAdsCampanhaId: ["meta ads campanha id", "meta ads - campanha id"],
  icp: ["icp"],
  stage: ["stage", "estagio", "etapa"],
  horaCriacao: ["hora de criacao", "data de criacao", "created time"],
};

function parseZohoCRM(matrix) {
  const headerIdx = detectHeaderRow(matrix, [
    "nome negocios", "stage", "origem", "hora de criacao", "meta ads",
  ]);
  const { headers, rows } = matrixToObjects(matrix, headerIdx);
  const map = buildHeaderMap(headers, ZOHO_ALIASES);

  return rows
    .map((r) => {
      const stage = cleanDisplay(r[map.stage]);
      const metaAdsAnuncio = map.metaAdsAnuncio ? cleanDisplay(r[map.metaAdsAnuncio]) : "";
      if (!stage && !metaAdsAnuncio) return null;
      return {
        id: map.id ? cleanDisplay(r[map.id]) : "",
        nomeNegocio: cleanDisplay(r[map.nomeNegocio]),
        nomeContato: cleanDisplay(r[map.nomeContato]),
        origem: cleanDisplay(r[map.origem]),
        metaAdsId: map.metaAdsId ? normalizeKey(r[map.metaAdsId]) : "",
        metaAdsAnuncio,
        metaAdsAnuncioKey: normalizeKey(metaAdsAnuncio),
        metaAdsCampanha: map.metaAdsCampanha ? cleanDisplay(r[map.metaAdsCampanha]) : "",
        metaAdsLeadId: map.metaAdsLeadId ? cleanDisplay(r[map.metaAdsLeadId]) : "",
        metaAdsCampanhaId: map.metaAdsCampanhaId ? cleanDisplay(r[map.metaAdsCampanhaId]) : "",
        icp: map.icp ? cleanDisplay(r[map.icp]) : "",
        stage,
        stageKey: normalizeKey(stage),
        horaCriacao: map.horaCriacao ? parseDateValue(r[map.horaCriacao]) : null,
      };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// REGRAS DE ORIGEM META E STAGE
// ---------------------------------------------------------------------------

// Retorna true se o campo Origem identifica um lead vindo de Meta Ads.
// Normaliza antes de comparar: lowercase, sem acento, sem espaço duplo.
function isMetaOrigin(origem) {
  const text    = normalizeKey(String(origem || ""));
  const noSpace = text.replace(/\s+/g, "");
  return (
    text.includes("aula gratis")    ||
    text.includes("aulas gratis")   ||
    text.includes("meta ads")       ||
    text.includes("meta adds")      ||  // variação de escrita de "Meta Ads"
    noSpace.includes("metaads")     ||
    noSpace.includes("metaadds")    ||  // variação com duplo 'd'
    text.includes("pipelovers")     ||  // Site PipeLovers / WhatsApp PipeLovers
    text.includes("tofu")           ||
    text.includes("bofu")
  );
}

// Google Ads se origem contém: "levantada de mao" | "site pipelovers" | "whatsapp pipelovers"
// E NÃO contém: "metaads" | "meta ads" | "academia b2b"
function isGoogleAdsOrigin(origem) {
  const s = normalizeKey(String(origem || ""));  // remove acentos, lowercase, espaço simples
  const flat = s.replace(/\s/g, "");
  const hasKeyword =
    s.includes("levantada de mao") ||
    s.includes("site pipelovers") ||
    s.includes("whatsapp pipelovers");
  const hasExclusion =
    flat.includes("metaads") ||
    s.includes("academia b2b");
  return hasKeyword && !hasExclusion;
}

// Stages normalizadas para match (substring) contra o campo Stage dos deals.
const META_MEETING_STAGES = CONFIG.meetingStages.map((s) => normalizeKey(s));

// Retorna true se o deal conta como Reunião Gerada META.
function countsAsMetaMeeting(stage, origem) {
  const s = normalizeKey(String(stage || ""));
  return isMetaOrigin(origem) && META_MEETING_STAGES.some((ms) => s.includes(ms));
}

// Retorna true se o deal deve ser contado como Assinatura Gerada da Meta.
function countsAsMetaSignature(stage, origem) {
  return isMetaOrigin(origem) && normalizeKey(String(stage || "")).includes("assinatura realizada");
}

// Calcula reuniões/assinaturas a partir de uma lista de deals.
// Dedup separado para cada métrica: uma empresa pode aparecer com "Reunião Realizada"
// e depois com "Assinatura realizada" — ambos os records devem contribuir,
// mas sem dupla contagem dentro da mesma categoria.
function computeReunioesReport(reunioesRows, { skipOriginFilter = false } = {}) {
  const seenMeet = new Set();
  const seenSign = new Set();
  let reunioes    = 0;
  let assinaturas = 0;
  const discarded = [];

  (reunioesRows || []).forEach((d) => {
    const contactKey = normalizeKey(d.nomeContato || "");
    const baseName   = cleanDealBaseName(d.nomeNegocio);
    const uid = (contactKey && baseName)
      ? `${contactKey}|${baseName}`
      : (contactKey || baseName || d.id || `${d.nomeNegocio}|${String(d.horaCriacao)}`);

    const isMeta  = skipOriginFilter || isMetaOrigin(d.origem);
    const stageOk = META_MEETING_STAGES.some((ms) => normalizeKey(String(d.stage || "")).includes(ms));
    const isMeet  = isMeta && stageOk;
    const isSign  = isMeta && normalizeKey(String(d.stage || "")).includes("assinatura realizada");

    if (!isMeta && !seenMeet.has(uid)) {
      discarded.push({ nome: d.nomeNegocio, razao: `Origem não é META: "${d.origem}"` });
    } else if (isMeta && !isMeet && !isSign && !seenMeet.has(uid)) {
      discarded.push({ nome: d.nomeNegocio, razao: `Stage não é reunião: "${d.stage}"` });
    }

    if (isMeet && !seenMeet.has(uid)) { seenMeet.add(uid); reunioes++; }
    if (isSign && !seenSign.has(uid)) { seenSign.add(uid); assinaturas++; }
  });

  return { reunioes, assinaturas, discarded };
}

// Extrai o nome limpo da conta a partir do Deal_Name do Zoho.
// O Make.com appenda "[CampaignName]" ao nome, gerando duplicatas como
// "Empresa [[TOFU] - Aula Gratis] [[TOFU] - Aula Gratis]".
// Retorna a parte antes do primeiro "[", normalizada.
function cleanDealBaseName(name) {
  const s   = String(name || "");
  const idx = s.indexOf("[");
  return normalizeKey(idx > 0 ? s.substring(0, idx) : s);
}

// Calcula totais META a partir de uma lista de deals do Zoho.
// Deduplicação por nomeContato: webhook duplicates criam dois deals com o mesmo
// contato → conta 1 só. Dois contatos diferentes na mesma empresa → conta cada um.
function computeZohoMetaMetrics(zohoRows) {
  const seen      = new Set();
  let metaTotal   = 0;
  let reunioes    = 0;
  let assinaturas = 0;
  const discarded = [];

  (zohoRows || []).forEach((d) => {
    // Chave de deduplicação: contato+empresa → um único contato em uma empresa
    // é contado uma só vez (evita double-count por webhook duplicado).
    // Dois contatos distintos na mesma empresa geram keys diferentes → ambos contados.
    const contactKey = normalizeKey(d.nomeContato || "");
    const baseName   = cleanDealBaseName(d.nomeNegocio);
    const uid = (contactKey && baseName)
      ? `${contactKey}|${baseName}`
      : (contactKey || baseName || d.id || `${d.nomeNegocio}|${String(d.horaCriacao)}`);
    if (seen.has(uid)) return;
    seen.add(uid);

    if (!isMetaOrigin(d.origem)) {
      discarded.push({ nome: d.nomeNegocio, razao: `Origem não é META: "${d.origem}"` });
      return;
    }
    metaTotal++;
    if (countsAsMetaMeeting(d.stage, d.origem))   reunioes++;
    if (countsAsMetaSignature(d.stage, d.origem)) assinaturas++;
  });

  return { metaTotal, reunioes, assinaturas, discarded };
}

// Calcula reuniões/assinaturas Google Ads a partir de deals do Zoho.
// Presença no relatório = 1 Reunião. Stage "assinatura realizada" = também 1 Assinatura.
// Dedup por: normalizeKey(nomeContato) + "|" + cleanDealBaseName(nomeNegocio)
function isGoogleAdsSignature(stage) {
  return normalizeKey(String(stage || "")).includes("assinatura realizada");
}

function computeGoogleAdsReport(rows) {
  const seenMeet = new Set();
  const seenSign = new Set();
  let reunioes = 0, assinaturas = 0;
  (rows || []).forEach((d) => {
    const contactKey = normalizeKey(d.nomeContato || "");
    const baseName   = cleanDealBaseName(d.nomeNegocio);
    const uid = (contactKey && baseName)
      ? `${contactKey}|${baseName}`
      : (contactKey || baseName || d.id || `${d.nomeNegocio}|${String(d.horaCriacao)}`);
    const stageNorm = normalizeKey(String(d.stage || ""));
    const isMeeting = META_MEETING_STAGES.some(ms => stageNorm.includes(ms));
    if (isMeeting && !seenMeet.has(uid)) {
      seenMeet.add(uid);
      reunioes++;
    }
    if (isGoogleAdsSignature(d.stage) && !seenSign.has(uid)) {
      seenSign.add(uid);
      assinaturas++;
    }
  });
  return { reunioes, assinaturas };
}

// ---------------------------------------------------------------------------
// CRUZAMENTO META ADS x ZOHO CRM
// ---------------------------------------------------------------------------
function buildCreatives(metaRows, zohoRows) {
  // Agrupa linhas do Meta por criativo (campanha + conjunto + anuncio), somando métricas
  const groups = new Map();
  metaRows.forEach((row) => {
    const key = `${normalizeKey(row.campanha)}|${normalizeKey(row.conjunto)}|${row.anuncioKey}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        anuncio: row.anuncio,
        anuncioKey: row.anuncioKey,
        campanha: row.campanha,
        conjunto: row.conjunto,
        adId: row.adId,
        impressoes: 0,
        cliques: 0,
        valorGasto: 0,
        leadsMeta: 0,
        dataInicio: null,
        dataFim: null,
        zohoDeals: [],
      });
    }
    const g = groups.get(key);
    g.impressoes += row.impressoes;
    g.cliques += row.cliques;
    g.valorGasto += row.valorGasto;
    g.leadsMeta += row.leads;
    if (row.adId) g.adId = row.adId;
    if (row.dataInicio && (!g.dataInicio || row.dataInicio < g.dataInicio)) g.dataInicio = row.dataInicio;
    if (row.dataFim && (!g.dataFim || row.dataFim > g.dataFim)) g.dataFim = row.dataFim;
  });

  const creatives = Array.from(groups.values());

  // Índices para cruzamento: por nome de anúncio normalizado e por ID (quando existir)
  const byAnuncioKey = new Map();
  const byAdId = new Map();
  creatives.forEach((c) => {
    if (!byAnuncioKey.has(c.anuncioKey)) byAnuncioKey.set(c.anuncioKey, []);
    byAnuncioKey.get(c.anuncioKey).push(c);
    if (c.adId) {
      if (!byAdId.has(c.adId)) byAdId.set(c.adId, []);
      byAdId.get(c.adId).push(c);
    }
  });

  const unmatchedZoho = [];

  zohoRows.forEach((deal) => {
    let matches = [];
    // Prioridade 1: Nome do anúncio (Meta) == Meta Ads - Anuncio (Zoho)
    if (deal.metaAdsAnuncioKey && byAnuncioKey.has(deal.metaAdsAnuncioKey)) {
      matches = byAnuncioKey.get(deal.metaAdsAnuncioKey);
    }
    // Prioridade 2: Meta Ads - ADs ID, quando existir dos dois lados
    if (matches.length === 0 && deal.metaAdsId && byAdId.has(deal.metaAdsId)) {
      matches = byAdId.get(deal.metaAdsId);
    }
    if (matches.length > 0) {
      // se houver mais de um criativo com o mesmo nome (ex: campanhas diferentes),
      // distribui o negócio para todos eles é incorreto — usamos o primeiro,
      // priorizando o que também combina pela campanha informada no Zoho, se houver.
      let target = matches[0];
      if (matches.length > 1 && deal.metaAdsCampanha) {
        const byCampanha = matches.find((m) => normalizeKey(m.campanha) === normalizeKey(deal.metaAdsCampanha));
        if (byCampanha) target = byCampanha;
      }
      target.zohoDeals.push(deal);
    } else {
      unmatchedZoho.push(deal);
    }
  });

  // Calcula métricas derivadas por criativo
  creatives.forEach((c) => {
    const deals = c.zohoDeals;
    c.leadsZoho   = deals.length;
    c.reunioes    = deals.filter((d) => countsAsMetaMeeting(d.stage, d.origem)).length;
    c.assinaturas = deals.filter((d) => countsAsMetaSignature(d.stage, d.origem)).length;
    c.ctr = safeDiv(c.cliques, c.impressoes) * 100;
    c.cpc = safeDiv(c.valorGasto, c.cliques);
    c.cpm = safeDiv(c.valorGasto, c.impressoes) * 1000;
    c.cplMeta = safeDiv(c.valorGasto, c.leadsMeta);
    c.custoReuniao = safeDiv(c.valorGasto, c.reunioes);
    c.custoAssinatura = safeDiv(c.valorGasto, c.assinaturas);
    c.taxaReuniao = safeDiv(c.reunioes, c.leadsZoho) * 100;
    c.taxaAssinatura = safeDiv(c.assinaturas, c.leadsZoho) * 100;
  });

  return { creatives, unmatchedZoho };
}

// ---------------------------------------------------------------------------
// FILTROS GLOBAIS
// ---------------------------------------------------------------------------
function populateFilterOptions(creatives) {
  const campanhaSel = document.getElementById("filterCampanha");
  const conjuntoSel = document.getElementById("filterConjunto");
  const campanhas = [...new Set(creatives.map((c) => c.campanha))].sort();
  const conjuntos = [...new Set(creatives.map((c) => c.conjunto))].sort();

  campanhaSel.innerHTML = '<option value="">Todas</option>' + campanhas.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  conjuntoSel.innerHTML = '<option value="">Todos</option>' + conjuntos.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
}

function applyFilters() {
  const startVal = document.getElementById("filterStart").value;
  const endVal   = document.getElementById("filterEnd").value;
  const start    = startVal ? new Date(startVal + "T00:00:00") : null;
  const end      = endVal   ? new Date(endVal   + "T23:59:59") : null;
  const campanha       = document.getElementById("filterCampanha").value;
  const conjunto       = document.getElementById("filterConjunto").value;
  const criativoSearch = normalizeKey(document.getElementById("filterCriativo").value);

  const dateFilter = (d) => {
    if (!d.horaCriacao) return true;
    if (start && d.horaCriacao < start) return false;
    if (end   && d.horaCriacao > end)   return false;
    return true;
  };

  // Filtra deals Zoho e relatório de reuniões pelo mesmo intervalo de datas
  const zohoFiltered = (start || end) ? state.zohoRows.filter(dateFilter) : state.zohoRows;

  const { creatives } = buildCreatives(state.metaRows, zohoFiltered);
  state.zohoFiltered    = zohoFiltered;
  state.reunioesFiltered = (start || end)
    ? state.reunioesRows.filter(dateFilter)
    : state.reunioesRows;

  state.filtered = creatives.filter((c) => {
    if (campanha && c.campanha !== campanha) return false;
    if (conjunto && c.conjunto !== conjunto) return false;
    if (criativoSearch && !c.anuncioKey.includes(criativoSearch)) return false;
    return true;
  });

  renderAll();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// RENDERIZAÇÃO: CARDS
// ---------------------------------------------------------------------------
function renderCards(creatives) {
  const sum = (key) => creatives.reduce((acc, c) => acc + (c[key] || 0), 0);
  const valorGasto = sum("valorGasto");
  const impressoes = sum("impressoes");
  const cliques    = sum("cliques");
  const leadsMeta  = sum("leadsMeta");
  const leadsZoho  = sum("leadsZoho");

  // Reuniões/assinaturas: usa o relatório Zoho (fonte oficial) se disponível.
  // Fallback para stage-check quando o relatório não foi carregado (fluxo CSV).
  let reunioes, assinaturas;
  if (state.reunioesFiltered.length > 0) {
    ({ reunioes, assinaturas } = computeReunioesReport(state.reunioesFiltered, { skipOriginFilter: state.isOfficialReunioesData }));
  } else if (state.reunioesRows.length > 0) {
    // Relatório carregado mas filtro de período retornou vazio → 0 no período selecionado
    reunioes = 0;
    assinaturas = 0;
  } else {
    const zohoBase = state.zohoFiltered.length > 0 ? state.zohoFiltered : state.zohoRows;
    ({ reunioes, assinaturas } = computeZohoMetaMetrics(zohoBase));
  }

  document.getElementById("cardInvestimento").textContent    = fmtCurrency(valorGasto);
  document.getElementById("cardImpressoes").textContent      = fmtInt(impressoes);
  document.getElementById("cardCliques").textContent         = fmtInt(cliques);
  document.getElementById("cardLeadsMeta").textContent       = fmtInt(leadsMeta);
  document.getElementById("cardLeadsZoho").textContent       = fmtInt(leadsZoho);
  document.getElementById("cardReunioes").textContent        = fmtInt(reunioes);
  document.getElementById("cardAssinaturas").textContent     = fmtInt(assinaturas);
  document.getElementById("cardCplMeta").textContent         = fmtCurrency(safeDiv(valorGasto, leadsMeta));
  document.getElementById("cardCustoReuniao").textContent    = fmtCurrency(safeDiv(valorGasto, reunioes));
  document.getElementById("cardCustoAssinatura").textContent = fmtCurrency(safeDiv(valorGasto, assinaturas));

  return { valorGasto, impressoes, cliques, leadsMeta, leadsZoho, reunioes, assinaturas };
}

// ---------------------------------------------------------------------------
// RENDERIZAÇÃO: BADGES
// ---------------------------------------------------------------------------
function topBy(creatives, key, tieBreakers = []) {
  if (creatives.length === 0) return null;
  return [...creatives].sort((a, b) => {
    if (b[key] !== a[key]) return b[key] - a[key];
    for (const tb of tieBreakers) {
      const diff = tb.dir === "asc" ? a[tb.key] - b[tb.key] : b[tb.key] - a[tb.key];
      if (diff) return diff;
    }
    return 0;
  })[0];
}

function renderBadges(creatives) {
  const bestAssinaturas = topBy(creatives, "assinaturas", [{ key: "custoAssinatura", dir: "asc" }, { key: "taxaAssinatura", dir: "desc" }]);
  const bestReunioes = topBy(creatives, "reunioes", [{ key: "custoReuniao", dir: "asc" }, { key: "taxaReuniao", dir: "desc" }]);
  const bestLeads = topBy(creatives, "leadsZoho", [{ key: "cplMeta", dir: "asc" }, { key: "ctr", dir: "desc" }]);

  document.getElementById("badgeAssinaturas").textContent = bestAssinaturas && bestAssinaturas.assinaturas > 0
    ? `${bestAssinaturas.anuncio} (${bestAssinaturas.assinaturas})` : "Sem dados ainda";
  document.getElementById("badgeReunioes").textContent = bestReunioes && bestReunioes.reunioes > 0
    ? `${bestReunioes.anuncio} (${bestReunioes.reunioes})` : "Sem dados ainda";
  document.getElementById("badgeLeads").textContent = bestLeads && bestLeads.leadsZoho > 0
    ? `${bestLeads.anuncio} (${bestLeads.leadsZoho})` : "Sem dados ainda";

  return { bestAssinaturas, bestReunioes, bestLeads };
}

// ---------------------------------------------------------------------------
// RENDERIZAÇÃO: RANKINGS
// ---------------------------------------------------------------------------
function renderRankingList(elId, items, primaryKey, primaryFmt) {
  const el = document.getElementById(elId);
  if (items.length === 0) {
    el.innerHTML = `<li><span class="rank-name">Sem dados</span></li>`;
    return;
  }
  el.innerHTML = items
    .map((c, i) => `<li><span class="rank-name">${i + 1}. ${escapeHtml(c.anuncio)}</span><span class="rank-meta">${primaryFmt(c[primaryKey])} · ${escapeHtml(c.campanha)}</span></li>`)
    .join("");
}

function renderRankings(creatives) {
  const ranking1 = [...creatives]
    .sort((a, b) => b.assinaturas - a.assinaturas || a.custoAssinatura - b.custoAssinatura || b.taxaAssinatura - a.taxaAssinatura)
    .slice(0, CONFIG.rankingSize);
  const ranking2 = [...creatives]
    .sort((a, b) => b.reunioes - a.reunioes || a.custoReuniao - b.custoReuniao || b.taxaReuniao - a.taxaReuniao)
    .slice(0, CONFIG.rankingSize);
  const ranking3 = [...creatives]
    .sort((a, b) => b.leadsZoho - a.leadsZoho || a.cplMeta - b.cplMeta || b.ctr - a.ctr)
    .slice(0, CONFIG.rankingSize);

  renderRankingList("ranking1List", ranking1, "assinaturas", (v) => `${fmtInt(v)} assinaturas`);
  renderRankingList("ranking2List", ranking2, "reunioes", (v) => `${fmtInt(v)} reuniões`);
  renderRankingList("ranking3List", ranking3, "leadsZoho", (v) => `${fmtInt(v)} leads`);
}

// ---------------------------------------------------------------------------
// RENDERIZAÇÃO: INSIGHTS AUTOMÁTICOS
// ---------------------------------------------------------------------------
function renderInsights(creatives) {
  const list = document.getElementById("insightsList");
  if (creatives.length === 0) {
    list.innerHTML = "<li>Sem dados suficientes para gerar insights.</li>";
    return;
  }
  const insights = [];

  const maisLeads = topBy(creatives, "leadsZoho");
  const maisReunioes = topBy(creatives, "reunioes");
  const maisAssinaturas = topBy(creatives, "assinaturas");
  const validCustoReuniao = creatives.filter((c) => c.reunioes > 0);
  const validCustoAssinatura = creatives.filter((c) => c.assinaturas > 0);
  const menorCustoReuniao = validCustoReuniao.length ? [...validCustoReuniao].sort((a, b) => a.custoReuniao - b.custoReuniao)[0] : null;
  const menorCustoAssinatura = validCustoAssinatura.length ? [...validCustoAssinatura].sort((a, b) => a.custoAssinatura - b.custoAssinatura)[0] : null;
  const validTaxaReuniao = creatives.filter((c) => c.leadsZoho > 0);
  const melhorTaxaReuniao = validTaxaReuniao.length ? [...validTaxaReuniao].sort((a, b) => b.taxaReuniao - a.taxaReuniao)[0] : null;
  const melhorTaxaAssinatura = validTaxaReuniao.length ? [...validTaxaReuniao].sort((a, b) => b.taxaAssinatura - a.taxaAssinatura)[0] : null;

  if (maisLeads && maisLeads.leadsZoho > 0) insights.push(`O criativo que mais gerou leads foi <strong>${escapeHtml(maisLeads.anuncio)}</strong>, com ${fmtInt(maisLeads.leadsZoho)} leads.`);
  if (maisReunioes && maisReunioes.reunioes > 0) insights.push(`O criativo que mais gerou reuniões foi <strong>${escapeHtml(maisReunioes.anuncio)}</strong>, com ${fmtInt(maisReunioes.reunioes)} reuniões.`);
  if (maisAssinaturas && maisAssinaturas.assinaturas > 0) insights.push(`O criativo que mais gerou assinaturas foi <strong>${escapeHtml(maisAssinaturas.anuncio)}</strong>, com ${fmtInt(maisAssinaturas.assinaturas)} assinaturas.`);
  if (menorCustoReuniao) insights.push(`O menor custo por reunião foi de <strong>${fmtCurrency(menorCustoReuniao.custoReuniao)}</strong>, no criativo ${escapeHtml(menorCustoReuniao.anuncio)}.`);
  if (menorCustoAssinatura) insights.push(`O menor custo por assinatura foi de <strong>${fmtCurrency(menorCustoAssinatura.custoAssinatura)}</strong>, no criativo ${escapeHtml(menorCustoAssinatura.anuncio)}.`);
  if (melhorTaxaReuniao && melhorTaxaReuniao.taxaReuniao > 0) insights.push(`A melhor taxa de Lead → Reunião foi de <strong>${fmtPct(melhorTaxaReuniao.taxaReuniao)}</strong>, no criativo ${escapeHtml(melhorTaxaReuniao.anuncio)}.`);
  if (melhorTaxaAssinatura && melhorTaxaAssinatura.taxaAssinatura > 0) insights.push(`A melhor taxa de Lead → Assinatura foi de <strong>${fmtPct(melhorTaxaAssinatura.taxaAssinatura)}</strong>, no criativo ${escapeHtml(melhorTaxaAssinatura.anuncio)}.`);

  // Melhor / pior campanha (agregando criativos por campanha)
  const porCampanha = new Map();
  creatives.forEach((c) => {
    if (!porCampanha.has(c.campanha)) {
      porCampanha.set(c.campanha, { campanha: c.campanha, assinaturas: 0, reunioes: 0, leadsZoho: 0, valorGasto: 0 });
    }
    const g = porCampanha.get(c.campanha);
    g.assinaturas += c.assinaturas;
    g.reunioes += c.reunioes;
    g.leadsZoho += c.leadsZoho;
    g.valorGasto += c.valorGasto;
  });
  const campanhas = Array.from(porCampanha.values());
  if (campanhas.length > 1) {
    const ordenadas = [...campanhas].sort((a, b) => b.assinaturas - a.assinaturas || b.reunioes - a.reunioes || b.leadsZoho - a.leadsZoho);
    const melhor = ordenadas[0];
    const pior = ordenadas[ordenadas.length - 1];
    insights.push(`A melhor campanha foi <strong>${escapeHtml(melhor.campanha)}</strong> (${fmtInt(melhor.assinaturas)} assinaturas, ${fmtInt(melhor.reunioes)} reuniões, ${fmtInt(melhor.leadsZoho)} leads).`);
    insights.push(`A pior campanha foi <strong>${escapeHtml(pior.campanha)}</strong> (${fmtInt(pior.assinaturas)} assinaturas, ${fmtInt(pior.reunioes)} reuniões, ${fmtInt(pior.leadsZoho)} leads).`);
  }

  list.innerHTML = insights.length ? insights.map((i) => `<li>${i}</li>`).join("") : "<li>Sem dados suficientes para gerar insights.</li>";
  return insights;
}

// ---------------------------------------------------------------------------
// RENDERIZAÇÃO: TABELA
// ---------------------------------------------------------------------------
function renderTable() {
  const search = normalizeKey(document.getElementById("tableSearch").value);
  let rows = state.filtered.filter((c) => !search || c.anuncioKey.includes(search) || normalizeKey(c.campanha).includes(search));

  const { key, dir } = state.sort;
  rows = [...rows].sort((a, b) => {
    let va = a[key], vb = b[key];
    if (typeof va === "string") { va = va.toLowerCase(); vb = String(vb).toLowerCase(); }
    if (va < vb) return dir === "asc" ? -1 : 1;
    if (va > vb) return dir === "asc" ? 1 : -1;
    return 0;
  });

  const tbody = document.getElementById("mainTableBody");
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="15" style="text-align:center;color:var(--text-muted);padding:24px;">Nenhum criativo encontrado com os filtros atuais.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map(
      (c) => `<tr>
        <td>${escapeHtml(c.anuncio)}</td>
        <td>${escapeHtml(c.campanha)}</td>
        <td>${fmtCurrency(c.valorGasto)}</td>
        <td>${fmtInt(c.impressoes)}</td>
        <td>${fmtInt(c.cliques)}</td>
        <td>${fmtPct(c.ctr)}</td>
        <td>${fmtCurrency(c.cpc)}</td>
        <td>${fmtInt(c.leadsMeta)}</td>
        <td>${fmtInt(c.leadsZoho)}</td>
        <td>${fmtInt(c.reunioes)}</td>
        <td>${fmtInt(c.assinaturas)}</td>
        <td>${fmtCurrency(c.custoReuniao)}</td>
        <td>${fmtCurrency(c.custoAssinatura)}</td>
        <td>${fmtPct(c.taxaReuniao)}</td>
        <td>${fmtPct(c.taxaAssinatura)}</td>
      </tr>`
    )
    .join("");

  document.querySelectorAll("#mainTable thead th").forEach((th) => {
    th.classList.remove("sorted-asc", "sorted-desc");
    if (th.dataset.key === key) th.classList.add(dir === "asc" ? "sorted-asc" : "sorted-desc");
  });
}

// ---------------------------------------------------------------------------
// RENDERIZAÇÃO: LEADS POR CANAL
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LEADS POR CANAL — FILTRO / ORDENAÇÃO POR COLUNA (estilo Google Sheets)
// ---------------------------------------------------------------------------
const LC_COLS = [
  { key: "nome",            label: "Nome" },
  { key: "email",           label: "E-mail" },
  { key: "empresa",         label: "Empresa" },
  { key: "nomeNegocio",     label: "Negócio" },
  { key: "stage",           label: "Estágio" },
  { key: "canal",           label: "Canal" },
  { key: "origem",          label: "Origem" },
  { key: "campanha",        label: "Campanha" },
  { key: "keyword",         label: "Palavra-chave" },
  { key: "anuncio",         label: "Anúncio" },
  { key: "nomeFormulario",  label: "Formulário" },
  { key: "paginaConversao", label: "Página" },
  { key: "data",            label: "Data" },
  { key: "gclid",           label: "GCLID" },
  { key: "gbraid",          label: "GBRAID" },
];

const lcFilter = {
  sortCol: null,  // colKey ou null
  sortDir: null,  // "asc" | "desc" | null
  colFilters: {}, // { colKey: Set<string> } — ausente = sem filtro
};

let lcCurrentLeads = [];  // leads após filtro de canal + busca, antes dos filtros de coluna
let lcDdState = null;     // { colKey, tempSelected: Set, allValues: string[] }

function lcVal(lead, key) {
  return String(lead[key] ?? "—");
}

function lcApplyFiltersAndSort(leads) {
  let result = leads;
  for (const [key, sel] of Object.entries(lcFilter.colFilters)) {
    if (!sel || sel.size === 0) continue;
    result = result.filter(l => sel.has(lcVal(l, key)));
  }
  if (lcFilter.sortCol) {
    const key = lcFilter.sortCol;
    const dir = lcFilter.sortDir === "asc" ? 1 : -1;
    result = [...result].sort((a, b) =>
      dir * lcVal(a, key).localeCompare(lcVal(b, key), "pt-BR", { numeric: true, sensitivity: "base" }));
  }
  return result;
}

function updateLCHeaderIndicators() {
  LC_COLS.forEach(({ key }) => {
    const ind = document.getElementById(`lc-ind-${key}`);
    if (!ind) return;
    let html = "";
    if (lcFilter.sortCol === key)
      html += `<span class="lc-th-sort">${lcFilter.sortDir === "asc" ? "↑" : "↓"}</span>`;
    if (lcFilter.colFilters[key]?.size)
      html += `<span class="lc-th-filter">▼</span>`;
    ind.innerHTML = html;
  });
}

function renderLCValueList(search = "") {
  const list = document.getElementById("lc-values-list");
  if (!list || !lcDdState) return;
  const { allValues, tempSelected } = lcDdState;
  const q = search.trim().toLowerCase();
  const visible = q ? allValues.filter(v => v.toLowerCase().includes(q)) : allValues;
  list.innerHTML = visible.map(v =>
    `<label class="lc-value-item">
      <input type="checkbox" value="${escapeHtml(v)}"${tempSelected.has(v) ? " checked" : ""}>
      <span title="${escapeHtml(v)}">${escapeHtml(v)}</span>
    </label>`).join("");
}

function openLCDropdown(colKey, thEl) {
  const dd = document.getElementById("lc-dropdown");
  if (!dd) return;

  // Alterna: clicou na mesma coluna já aberta → fecha
  if (lcDdState?.colKey === colKey) { closeLCDropdown(false); return; }

  const allValues = [...new Set(lcCurrentLeads.map(l => lcVal(l, colKey)))]
    .sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true, sensitivity: "base" }));
  const existing = lcFilter.colFilters[colKey];
  const tempSelected = existing ? new Set(existing) : new Set(allValues);

  lcDdState = { colKey, tempSelected, allValues };

  dd.querySelectorAll(".lc-sort-btn").forEach(btn => {
    btn.classList.toggle("active", lcFilter.sortCol === colKey && lcFilter.sortDir === btn.dataset.dir);
  });
  dd.querySelector(".lc-dd-search").value = "";
  renderLCValueList();

  // Posiciona abaixo do th
  const rect = thEl.getBoundingClientRect();
  dd.style.top  = `${rect.bottom + 4}px`;
  dd.style.left = `${Math.min(rect.left, window.innerWidth - 304)}px`;
  dd.classList.add("open");
}

function closeLCDropdown(apply) {
  const dd = document.getElementById("lc-dropdown");
  if (dd) dd.classList.remove("open");
  if (apply && lcDdState) {
    const { colKey, tempSelected, allValues } = lcDdState;
    if (!tempSelected.size || tempSelected.size >= allValues.length) {
      delete lcFilter.colFilters[colKey];
    } else {
      lcFilter.colFilters[colKey] = new Set(tempSelected);
    }
    updateLCHeaderIndicators();
    renderLeadsByChannel();
  }
  lcDdState = null;
}

function initLeadsChannelFilter() {
  const thead = document.querySelector("#leadsChannelTable thead tr");
  if (!thead || thead.dataset.lcInit) return;
  thead.dataset.lcInit = "1";

  // Substitui conteúdo de cada th por botão com indicador
  thead.querySelectorAll("th").forEach((th, i) => {
    const col = LC_COLS[i];
    if (!col) return;
    th.innerHTML = `<button class="lc-th-btn" data-col="${col.key}">
      <span>${col.label}</span><span class="lc-th-ind" id="lc-ind-${col.key}"></span>
    </button>`;
  });

  // Cria dropdown singleton
  const dd = document.createElement("div");
  dd.id = "lc-dropdown";
  dd.innerHTML = `
    <div class="lc-dd-sort">
      <button class="lc-sort-btn" data-dir="asc">↑&nbsp; Ordem crescente</button>
      <button class="lc-sort-btn" data-dir="desc">↓&nbsp; Ordem decrescente</button>
    </div>
    <div class="lc-dd-values">
      <div class="lc-dd-ctrl">
        <button class="lc-ctrl-btn" id="lc-sel-all">Selecionar tudo</button>
        <button class="lc-ctrl-btn" id="lc-sel-none">Limpar</button>
      </div>
      <input type="text" class="lc-dd-search" placeholder="Buscar valor…" autocomplete="off">
      <div class="lc-values-list" id="lc-values-list"></div>
    </div>
    <div class="lc-dd-footer">
      <button class="lc-btn-cancel" id="lc-btn-cancel">Cancelar</button>
      <button class="lc-btn-ok" id="lc-btn-ok">OK</button>
    </div>`;
  document.body.appendChild(dd);

  // Ordenação
  dd.querySelectorAll(".lc-sort-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      if (!lcDdState) return;
      const dir = btn.dataset.dir;
      const same = lcFilter.sortCol === lcDdState.colKey && lcFilter.sortDir === dir;
      lcFilter.sortCol = same ? null : lcDdState.colKey;
      lcFilter.sortDir = same ? null : dir;
      closeLCDropdown(true);
    });
  });

  // Selecionar tudo / Limpar
  document.getElementById("lc-sel-all").addEventListener("click", e => {
    e.stopPropagation();
    if (!lcDdState) return;
    lcDdState.tempSelected = new Set(lcDdState.allValues);
    renderLCValueList(dd.querySelector(".lc-dd-search").value);
  });
  document.getElementById("lc-sel-none").addEventListener("click", e => {
    e.stopPropagation();
    if (!lcDdState) return;
    lcDdState.tempSelected = new Set();
    renderLCValueList(dd.querySelector(".lc-dd-search").value);
  });

  // Busca dentro do dropdown
  dd.querySelector(".lc-dd-search").addEventListener("input", e => {
    e.stopPropagation();
    renderLCValueList(e.target.value);
  });
  dd.querySelector(".lc-dd-search").addEventListener("click", e => e.stopPropagation());

  // Checkboxes (event delegation)
  document.getElementById("lc-values-list").addEventListener("change", e => {
    if (e.target.type !== "checkbox" || !lcDdState) return;
    e.stopPropagation();
    e.target.checked
      ? lcDdState.tempSelected.add(e.target.value)
      : lcDdState.tempSelected.delete(e.target.value);
  });

  // OK / Cancelar
  document.getElementById("lc-btn-ok").addEventListener("click",     e => { e.stopPropagation(); closeLCDropdown(true);  });
  document.getElementById("lc-btn-cancel").addEventListener("click", e => { e.stopPropagation(); closeLCDropdown(false); });

  // Click no th abre dropdown
  thead.addEventListener("click", e => {
    const btn = e.target.closest(".lc-th-btn");
    if (!btn) return;
    openLCDropdown(btn.dataset.col, btn.closest("th"));
  });

  // Fecha ao clicar fora
  document.addEventListener("click", e => {
    if (!lcDdState) return;
    if (!dd.contains(e.target) && !e.target.closest(".lc-th-btn"))
      closeLCDropdown(false);
  }, true);
}

// ---------------------------------------------------------------------------
// Mapeia o canal classificado pelo formLeadsService para a chave do filtro do frontend.
function canalKey(channel) {
  const c = (channel || "").toLowerCase();
  if (c === "google ads") return "google";
  if (c === "meta ads")   return "meta";
  return "outro";
}

function renderLeadsByChannel() {
  const panel   = document.getElementById("leadsChannelPanel");
  const tbody   = document.getElementById("leadsChannelBody");
  const counter = document.getElementById("leadsChannelCount");
  if (!panel || !tbody) return;

  const channelFilter = (document.getElementById("leadsChannelFilter")?.value || "all");
  const q = normalizeKey(document.getElementById("leadsChannelSearch")?.value || "");

  // ── Fonte primária: planilha de atribuição ─────────────────────────────────
  // Fallback: webhook Pluga → Zoho (sem dados UTM)
  const source = state.sheetLeads?.length  ? "sheet"
               : state.formLeads?.length   ? "form"
               : "zoho";

  if (source === "zoho") {
    const zohoSrc = (state.reunioesFiltered?.length ? state.reunioesFiltered : state.reunioesRows) || [];
    if (!zohoSrc.length) { panel.hidden = true; return; }
  }

  // ── Monta lookup Zoho: nome normalizado → { stage, nomeNegocio } ──────────
  // Usado para enriquecer o estágio e negócio dos leads da planilha
  const zohoByName = new Map();
  for (const r of [...(state.reunioesRows || []), ...(state.zohoRows || [])]) {
    const k = normalizeKey(r.nomeContato || "");
    if (k && !zohoByName.has(k)) zohoByName.set(k, { stage: r.stage || "", nomeNegocio: r.nomeNegocio || "" });
  }

  // ── Gera lista de leads a exibir ──────────────────────────────────────────
  let allLeads = [];

  if (source === "sheet") {
    allLeads = state.sheetLeads.map(lead => {
      const ck    = canalKey(lead.channel);
      const nameK = normalizeKey(lead.nome);
      const zoho  = zohoByName.get(nameK) || null;
      const dataTs = lead.data
        ? (() => { try { const [d,m,yh] = lead.data.split("/"); const y = (yh||"").split(" ")[0]; return new Date(`${y}-${m}-${d}`); } catch(_){return null;} })()
        : null;
      return {
        nome:           lead.nome           || "—",
        email:          lead.email          || "—",
        empresa:        lead.empresa        || "—",
        nomeNegocio:    zoho?.nomeNegocio   || "",
        stage:          zoho?.stage         || "",
        canal:          lead.channel        || "—",
        canalKey:       ck,
        origem:         lead.origem         || "—",
        campanha:       lead.campanha       || "—",
        keyword:        lead.keyword        || "—",
        anuncio:        lead.anuncio        || "—",
        nomeFormulario: lead.nomeFormulario || "—",
        paginaConversao:lead.paginaConversao|| "—",
        data:           lead.data           || "—",
        gclid:          lead.gclid          || "—",
        gbraid:         lead.gbraid         || "—",
        horaCriacao:    dataTs,
      };
    });

  } else if (source === "form") {
    allLeads = state.formLeads.map(lead => {
      const canal = lead.channel || "Direto";
      const nameK = normalizeKey(lead.full_name || "");
      const zoho  = zohoByName.get(nameK) || null;
      return {
        nome:           lead.full_name    || lead.email || "—",
        email:          lead.email        || "—",
        empresa:        lead.company_name || "—",
        nomeNegocio:    zoho?.nomeNegocio || "",
        stage:          zoho?.stage       || "",
        canal,
        canalKey:       canalKey(canal),
        origem:         lead.utm_source   || "—",
        campanha:       lead.utm_campaign || "—",
        keyword:        lead.utm_keyword  || lead.searchterm || "—",
        anuncio:        lead.utm_content  || "—",
        nomeFormulario: lead.form_name    || "—",
        paginaConversao:lead.page_url     || "—",
        data:           lead.received_at  ? lead.received_at.slice(0, 10) : "—",
        gclid:          lead.gclid        || "—",
        gbraid:         lead.gbraid       || "—",
        horaCriacao:    lead.received_at  ? new Date(lead.received_at) : null,
      };
    });

  } else {
    // Fallback Zoho — sem dados UTM
    const zohoSrc = (state.reunioesFiltered?.length ? state.reunioesFiltered : state.reunioesRows) || [];
    allLeads = zohoSrc
      .map(r => {
        const isMeta   = isMetaOrigin(r.origem);
        const isGoogle = isGoogleAdsOrigin(r.origem);
        if (!isMeta && !isGoogle) return null;
        return {
          nome:           r.nomeContato || "—",
          email:          "—",
          empresa:        "—",
          nomeNegocio:    r.nomeNegocio || "",
          stage:          r.stage       || "",
          canal:          isMeta ? "Meta Ads" : "Google Ads",
          canalKey:       isMeta ? "meta" : "google",
          origem:         r.origem || "—",
          campanha:       "—",
          keyword:        "—",
          anuncio:        "—",
          nomeFormulario: "—",
          paginaConversao:"—",
          data:           r.horaCriacao ? r.horaCriacao.toLocaleDateString("pt-BR") : "—",
          gclid:          "—",
          gbraid:         "—",
          horaCriacao:    r.horaCriacao || null,
        };
      })
      .filter(Boolean);
  }

  // Ordena mais recentes primeiro (padrão quando não há ordenação por coluna ativa)
  if (!lcFilter.sortCol) {
    allLeads.sort((a, b) => (b.horaCriacao?.getTime() || 0) - (a.horaCriacao?.getTime() || 0));
  }

  if (!allLeads.length) { panel.hidden = true; return; }

  // Filtra por canal e busca de texto
  const preFiltered = allLeads.filter(l => {
    if (channelFilter !== "all" && l.canalKey !== channelFilter) return false;
    if (!q) return true;
    return normalizeKey(l.nome).includes(q)     ||
           normalizeKey(l.email).includes(q)    ||
           normalizeKey(l.empresa).includes(q)  ||
           normalizeKey(l.campanha).includes(q) ||
           normalizeKey(l.keyword).includes(q)  ||
           normalizeKey(l.anuncio).includes(q)  ||
           normalizeKey(l.canal).includes(q);
  });

  // Disponibiliza para o dropdown de filtro de coluna
  lcCurrentLeads = preFiltered;

  // Aplica filtros e sort por coluna
  const shown = lcApplyFiltersAndSort(preFiltered);

  panel.hidden = false;
  counter.textContent = `${shown.length} lead${shown.length !== 1 ? "s" : ""}`;

  if (!shown.length) {
    tbody.innerHTML = `<tr><td colspan="15" style="text-align:center;color:var(--text-muted);padding:24px">Nenhum lead encontrado.</td></tr>`;
    return;
  }

  const CANAL_BADGE = {
    "Meta Ads":   { bg: "rgba(24,119,242,0.12)", color: "#1877f2" },
    "Google Ads": { bg: "rgba(66,133,244,0.12)", color: "#4285f4" },
    "Orgânico":   { bg: "rgba(46,204,143,0.12)", color: "#2ecc8f" },
  };
  const td  = (val, extra = "") =>
    `<td style="padding:8px 10px;color:var(--text-secondary);font-size:.79rem;white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis${extra}" title="${escapeHtml(String(val || "—"))}">${escapeHtml(String(val || "—"))}</td>`;
  const tdM = (val, extra = "") =>
    `<td style="padding:8px 10px;color:var(--text-muted);font-size:.76rem;white-space:nowrap${extra}" title="${escapeHtml(String(val || "—"))}">${escapeHtml(String(val || "—"))}</td>`;

  tbody.innerHTML = shown.map((l, i) => {
    const cb     = CANAL_BADGE[l.canal] || { bg: "rgba(120,120,120,0.12)", color: "var(--text-muted)" };
    const rowBg  = i % 2 === 0 ? "" : "background:var(--bg)";
    const noBiz  = !l.nomeNegocio;
    return `<tr style="${rowBg};border-bottom:1px solid var(--border)">
      ${td(l.nome, ";font-weight:500;color:var(--text)")}
      ${tdM(l.email)}
      ${td(l.empresa)}
      <td style="padding:8px 10px;font-size:.79rem;color:${noBiz ? "var(--text-muted)" : "var(--text-secondary)"}">
        ${noBiz ? '<span style="font-size:.74rem;color:var(--text-muted);font-style:italic">não encontrado</span>' : escapeHtml(l.nomeNegocio)}
      </td>
      <td style="padding:8px 10px">${gadsLeadStageBadge(l.stage)}</td>
      <td style="padding:8px 10px;white-space:nowrap">
        <span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:600;background:${cb.bg};color:${cb.color}">${escapeHtml(l.canal)}</span>
      </td>
      ${td(l.origem)}
      ${td(l.campanha, ";max-width:220px")}
      ${td(l.keyword,  ";max-width:160px")}
      ${td(l.anuncio,  ";max-width:200px")}
      ${tdM(l.nomeFormulario)}
      ${tdM(l.paginaConversao, ";max-width:160px")}
      ${tdM(l.data)}
      ${tdM(l.gclid  !== "—" ? l.gclid.slice(0, 12) + "…" : "—")}
      ${tdM(l.gbraid !== "—" ? l.gbraid.slice(0, 12) + "…" : "—")}
    </tr>`;
  }).join("");

  updateLCHeaderIndicators();
}

// ---------------------------------------------------------------------------
// RENDERIZAÇÃO: GRÁFICOS (Chart.js)
// ---------------------------------------------------------------------------
const CHART_PALETTE = ["#6c5ce7", "#8b7bff", "#2ecc8f", "#f5b942", "#ff6b6b", "#4fb6e8", "#d98a4b", "#9aa4b8"];

function destroyChart(name) {
  if (state.charts[name]) {
    state.charts[name].destroy();
    delete state.charts[name];
  }
}

function makeBarChart(canvasId, name, labels, data, label, horizontal = true) {
  destroyChart(name);
  const ctx = document.getElementById(canvasId).getContext("2d");
  state.charts[name] = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{ label, data, backgroundColor: CHART_PALETTE, borderRadius: 6 }],
    },
    options: {
      indexAxis: horizontal ? "y" : "x",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#9aa4b8" }, grid: { color: "#232a3b" } },
        y: { ticks: { color: "#9aa4b8" }, grid: { color: "#232a3b" } },
      },
    },
  });
}

function renderCharts(creatives) {
  const byLeads = [...creatives].filter((c) => c.leadsZoho > 0).sort((a, b) => b.leadsZoho - a.leadsZoho).slice(0, CONFIG.topN);
  const byReunioes = [...creatives].filter((c) => c.reunioes > 0).sort((a, b) => b.reunioes - a.reunioes).slice(0, CONFIG.topN);
  const byAssinaturas = [...creatives].filter((c) => c.assinaturas > 0).sort((a, b) => b.assinaturas - a.assinaturas).slice(0, CONFIG.topN);
  const byInvestimento = [...creatives].sort((a, b) => b.valorGasto - a.valorGasto).slice(0, CONFIG.topN);
  const byCpl = [...creatives].filter((c) => c.leadsMeta > 0).sort((a, b) => a.cplMeta - b.cplMeta).slice(0, CONFIG.topN);
  const byCustoReuniao = [...creatives].filter((c) => c.reunioes > 0).sort((a, b) => a.custoReuniao - b.custoReuniao).slice(0, CONFIG.topN);
  const byCustoAssinatura = [...creatives].filter((c) => c.assinaturas > 0).sort((a, b) => a.custoAssinatura - b.custoAssinatura).slice(0, CONFIG.topN);

  makeBarChart("chartLeads", "leads", byLeads.map((c) => c.anuncio), byLeads.map((c) => c.leadsZoho), "Leads Zoho");
  makeBarChart("chartReunioes", "reunioes", byReunioes.map((c) => c.anuncio), byReunioes.map((c) => c.reunioes), "Reuniões");
  makeBarChart("chartAssinaturas", "assinaturas", byAssinaturas.map((c) => c.anuncio), byAssinaturas.map((c) => c.assinaturas), "Assinaturas");
  makeBarChart("chartInvestimento", "investimento", byInvestimento.map((c) => c.anuncio), byInvestimento.map((c) => Number(c.valorGasto.toFixed(2))), "Investimento (R$)");
  makeBarChart("chartCpl", "cpl", byCpl.map((c) => c.anuncio), byCpl.map((c) => Number(c.cplMeta.toFixed(2))), "CPL (R$)");
  makeBarChart("chartCustoReuniao", "custoReuniao", byCustoReuniao.map((c) => c.anuncio), byCustoReuniao.map((c) => Number(c.custoReuniao.toFixed(2))), "Custo/Reunião (R$)");
  makeBarChart("chartCustoAssinatura", "custoAssinatura", byCustoAssinatura.map((c) => c.anuncio), byCustoAssinatura.map((c) => Number(c.custoAssinatura.toFixed(2))), "Custo/Assinatura (R$)");
}

// ---------------------------------------------------------------------------
// AUDITORIA CRUZADA — compara métricas entre Cards e Visão Geral
// ---------------------------------------------------------------------------
function _auditDashboard(cardMetrics) {
  let ovMeet = 0, ovSign = 0;
  if (state.reunioesFiltered.length > 0) {
    ({ reunioes: ovMeet, assinaturas: ovSign } = computeReunioesReport(state.reunioesFiltered, { skipOriginFilter: state.isOfficialReunioesData }));
  } else if (state.reunioesRows.length === 0) {
    const zohoBase = state.zohoFiltered.length > 0 ? state.zohoFiltered : state.zohoRows;
    ({ reunioes: ovMeet, assinaturas: ovSign } = computeZohoMetaMetrics(zohoBase));
  }
  const meetOk = cardMetrics.reunioes === ovMeet;
  const signOk = cardMetrics.assinaturas === ovSign;
  console.group("[Dashboard Audit]");
  console.log(`Reuniões    — Cards: ${cardMetrics.reunioes} | Visão Geral Meta: ${ovMeet} ${meetOk ? "✅" : "⚠️ DIVERGÊNCIA"}`);
  console.log(`Assinaturas — Cards: ${cardMetrics.assinaturas} | Visão Geral Meta: ${ovSign} ${signOk ? "✅" : "⚠️ DIVERGÊNCIA"}`);
  console.log(`Leads Meta (CSV): ${cardMetrics.leadsMeta} | Leads Zoho (CSV): ${cardMetrics.leadsZoho}`);
  if (!meetOk) console.warn("[Dashboard Audit] ⚠️ Reuniões divergem entre Cards e Visão Geral");
  if (!signOk) console.warn("[Dashboard Audit] ⚠️ Assinaturas divergem entre Cards e Visão Geral");
  console.groupEnd();
}

// ---------------------------------------------------------------------------
// RENDER GERAL
// ---------------------------------------------------------------------------
function renderAll() {
  const creatives = state.filtered;
  const cardMetrics = renderCards(creatives);
  renderBadges(creatives);
  renderRankings(creatives);
  renderInsights(creatives);
  renderTable();
  renderLeadsByChannel();
  renderCharts(creatives);

  const hasData = state.creatives.length > 0;
  // cardsGrid/badgesGrid/insightsPanel ficam em wrapper oculto — não alterar visibilidade
  ["filtersPanel", "rankingsGrid", "chartsGrid", "tablePanel"].forEach((id) => {
    document.getElementById(id).hidden = !hasData;
  });
  document.getElementById("exportCsvBtn").disabled = !hasData;
  document.getElementById("exportXlsxBtn").disabled = !hasData;
  document.getElementById("sendReportBtn").disabled = !hasData;
  renderOverview();
  renderInsightsIA();
  renderFinanceiro();
  _auditDashboard(cardMetrics);
}

// ---------------------------------------------------------------------------
// TOAST / FEEDBACK VISUAL
// ---------------------------------------------------------------------------
let toastTimer = null;
function showToast(message, type = "info", duration = 3500) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = `toast show toast--${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), duration);
}

// ---------------------------------------------------------------------------
// UPLOAD HANDLERS
// ---------------------------------------------------------------------------
function checkReadyToUpdate() {
  document.getElementById("updateDashboardBtn").disabled = !(state.metaFile && state.zohoFile);
}

document.getElementById("metaFile").addEventListener("change", (e) => {
  state.metaFile = e.target.files[0] || null;
  const status = document.getElementById("metaFileStatus");
  status.textContent = state.metaFile ? `Selecionado: ${state.metaFile.name}` : "Nenhum arquivo selecionado";
  status.className = state.metaFile ? "file-status ok" : "file-status";
  checkReadyToUpdate();
});

document.getElementById("zohoFile").addEventListener("change", (e) => {
  state.zohoFile = e.target.files[0] || null;
  const status = document.getElementById("zohoFileStatus");
  status.textContent = state.zohoFile ? `Selecionado: ${state.zohoFile.name}` : "Nenhum arquivo selecionado";
  status.className = state.zohoFile ? "file-status ok" : "file-status";
  checkReadyToUpdate();
});

document.getElementById("updateDashboardBtn").addEventListener("click", async () => {
  const processStatus = document.getElementById("processStatus");
  try {
    processStatus.textContent = "Lendo e processando planilhas...";
    processStatus.className = "process-status";

    const [metaMatrix, zohoMatrix] = await Promise.all([
      readWorkbook(state.metaFile),
      readWorkbook(state.zohoFile),
    ]);

    state.metaRows = parseMetaAds(metaMatrix);
    state.zohoRows = parseZohoCRM(zohoMatrix);

    if (state.metaRows.length === 0) throw new Error("Não foi possível identificar linhas válidas na planilha do Meta Ads.");
    if (state.zohoRows.length === 0) throw new Error("Não foi possível identificar linhas válidas na planilha do Zoho CRM.");

    const { creatives, unmatchedZoho } = buildCreatives(state.metaRows, state.zohoRows);
    state.creatives    = creatives;
    state.filtered     = creatives;
    state.zohoFiltered = state.zohoRows;

    populateFilterOptions(creatives);
    renderAll();

    const matchedDeals = state.zohoRows.length - unmatchedZoho.length;
    processStatus.textContent = `Dashboard atualizado: ${creatives.length} criativos, ${matchedDeals}/${state.zohoRows.length} negócios do Zoho cruzados.`;
    processStatus.className = "process-status success";
    showToast("Dashboard atualizado com sucesso.", "success");

    const overviewTabBtn = document.querySelector('.tab-btn[data-tab="overview"]');
    if (overviewTabBtn) overviewTabBtn.click();
  } catch (err) {
    console.error(err);
    processStatus.textContent = `Erro ao processar planilhas: ${err.message}`;
    processStatus.className = "process-status error";
    showToast("Erro ao processar planilhas.", "error");
  }
});

document.getElementById("clearFiltersBtn").addEventListener("click", () => {
  document.getElementById("filterStart").value = "";
  document.getElementById("filterEnd").value = "";
  document.getElementById("filterCampanha").value = "";
  document.getElementById("filterConjunto").value = "";
  document.getElementById("filterCriativo").value = "";
  applyFilters();
});

["filterStart", "filterEnd", "filterCampanha", "filterConjunto"].forEach((id) =>
  document.getElementById(id).addEventListener("change", applyFilters)
);
document.getElementById("filterCriativo").addEventListener("input", debounce(applyFilters, 250));
document.getElementById("tableSearch").addEventListener("input", debounce(renderTable, 200));

document.getElementById("leadsChannelSearch").addEventListener("input",  debounce(renderLeadsByChannel, 200));
document.getElementById("leadsChannelFilter").addEventListener("change", renderLeadsByChannel);
initLeadsChannelFilter();

document.querySelectorAll("#mainTable thead th").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.key;
    if (state.sort.key === key) {
      state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
    } else {
      state.sort.key = key;
      state.sort.dir = "desc";
    }
    renderTable();
  });
});

function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

// ---------------------------------------------------------------------------
// EXPORTAÇÃO CSV / XLSX
// ---------------------------------------------------------------------------
function getExportRows() {
  return state.filtered.map((c) => ({
    "Nome do anúncio": c.anuncio,
    Campanha: c.campanha,
    "Conjunto de anúncios": c.conjunto,
    "Valor gasto": Number(c.valorGasto.toFixed(2)),
    Impressões: c.impressoes,
    Cliques: c.cliques,
    "CTR (%)": Number(c.ctr.toFixed(2)),
    "CPC (R$)": Number((c.cpc || 0).toFixed(2)),
    "Leads Meta": c.leadsMeta,
    "Leads Zoho": c.leadsZoho,
    "Reuniões Geradas": c.reunioes,
    "Assinaturas Realizadas": c.assinaturas,
    "Custo por Reunião (R$)": isFinite(c.custoReuniao) ? Number(c.custoReuniao.toFixed(2)) : "",
    "Custo por Assinatura (R$)": isFinite(c.custoAssinatura) ? Number(c.custoAssinatura.toFixed(2)) : "",
    "Taxa Lead→Reunião (%)": isFinite(c.taxaReuniao) ? Number(c.taxaReuniao.toFixed(2)) : "",
    "Taxa Lead→Assinatura (%)": isFinite(c.taxaAssinatura) ? Number(c.taxaAssinatura.toFixed(2)) : "",
  }));
}

document.getElementById("exportCsvBtn").addEventListener("click", () => {
  const rows = getExportRows();
  const ws = XLSX.utils.json_to_sheet(rows);
  const csv = XLSX.utils.sheet_to_csv(ws);
  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8;" }), "report-meta-zoho.csv");
});

document.getElementById("exportXlsxBtn").addEventListener("click", () => {
  const rows = getExportRows();
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Report");
  XLSX.writeFile(wb, "report-meta-zoho.xlsx");
});

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// ENVIAR REPORT PARA O SLACK
// ---------------------------------------------------------------------------
function isSameDay(d1, d2) {
  if (!d1 || !d2) return false;
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
}

function buildSlackPayload() {
  const today = new Date();
  const all = state.creatives;

  // "Hoje": negócios do Zoho criados hoje (para leads/reuniões/assinaturas),
  // e gasto do Meta cuja janela de datas inclui hoje.
  const dealsToday      = state.zohoRows.filter((d) => isSameDay(d.horaCriacao, today));
  const leadsZohoHoje   = dealsToday.length;
  const reunioesBaseHoje = (state.reunioesRows.length > 0 ? state.reunioesRows : state.zohoRows)
    .filter((d) => isSameDay(d.horaCriacao, today));
  const { reunioes: reunioesHoje, assinaturas: assinaturasHoje } = computeReunioesReport(reunioesBaseHoje, { skipOriginFilter: state.isOfficialReunioesData });
  const metaRowsHoje = state.metaRows.filter(
    (r) => (r.dataInicio && isSameDay(r.dataInicio, today)) || (r.dataFim && isSameDay(r.dataFim, today)) || (!r.dataInicio && !r.dataFim)
  );
  const valorGastoHoje = metaRowsHoje.reduce((acc, r) => acc + r.valorGasto, 0);
  const leadsMetaHoje = metaRowsHoje.reduce((acc, r) => acc + r.leads, 0);

  // Acumulado: totais do período filtrado (reunioesFiltered respeita o seletor de datas).
  // Fallback para Zoho CSV apenas quando o relatório Zoho não foi carregado.
  const { reunioes: reunioesTotais, assinaturas: assinaturaTotais } = state.reunioesFiltered.length > 0
    ? computeReunioesReport(state.reunioesFiltered, { skipOriginFilter: state.isOfficialReunioesData })
    : (state.reunioesRows.length > 0
      ? { reunioes: 0, assinaturas: 0 }
      : computeZohoMetaMetrics(state.zohoRows));
  const acumulado = {
    valorGasto:  all.reduce((a, c) => a + c.valorGasto, 0),
    leadsMeta:   all.reduce((a, c) => a + c.leadsMeta,  0),
    leadsZoho:   all.reduce((a, c) => a + c.leadsZoho,  0),
    reunioes:    reunioesTotais,
    assinaturas: assinaturaTotais,
  };

  const bestAssinaturas = topBy(all, "assinaturas", [{ key: "custoAssinatura", dir: "asc" }]);
  const bestReunioes = topBy(all, "reunioes", [{ key: "custoReuniao", dir: "asc" }]);
  const bestLeads = topBy(all, "leadsZoho", [{ key: "cplMeta", dir: "asc" }]);

  const insightPeriodo = (bestAssinaturas && bestAssinaturas.assinaturas > 0)
    ? `O criativo "${bestAssinaturas.anuncio}" lidera em assinaturas (${bestAssinaturas.assinaturas}), com custo por assinatura de ${fmtCurrency(bestAssinaturas.custoAssinatura)}.`
    : "Ainda não há assinaturas registradas no período carregado.";

  return {
    data: today.toLocaleDateString("pt-BR"),
    resumoDia: {
      valorGasto: valorGastoHoje,
      leadsMeta: leadsMetaHoje,
      leadsZoho: leadsZohoHoje,
      reunioes: reunioesHoje,
      assinaturas: assinaturasHoje,
      cplMeta: safeDiv(valorGastoHoje, leadsMetaHoje),
      custoReuniao: safeDiv(valorGastoHoje, reunioesHoje),
      custoAssinatura: safeDiv(valorGastoHoje, assinaturasHoje),
    },
    acumulado,
    topCriativos: {
      assinaturas: bestAssinaturas ? `${bestAssinaturas.anuncio} (${bestAssinaturas.assinaturas})` : "—",
      reunioes: bestReunioes ? `${bestReunioes.anuncio} (${bestReunioes.reunioes})` : "—",
      leads: bestLeads ? `${bestLeads.anuncio} (${bestLeads.leadsZoho})` : "—",
    },
    insightPeriodo,
  };
}

// Este projeto é 100% estático (GitHub Pages), sem backend e sem webhook
// armazenado no front-end. O envio real para o Slack acontece através do
// conector de Slack já conectado na sessão do Cowork: ao clicar em
// "Enviar Report", o texto da mensagem (no formato oficial do template) é
// copiado para a área de transferência. Basta colar no Slack manualmente,
// ou pedir para o Claude (aqui no Cowork) enviar o texto copiado para você.
function buildSlackMessageText(payload) {
  const r = payload.resumoDia;
  const a = payload.acumulado;
  const t = payload.topCriativos;
  return [
    "📊 Report Meta Ads + Zoho | PipeLovers",
    `Data: ${payload.data}`,
    "",
    "Resumo do Dia",
    `• Valor gasto: ${fmtCurrency(r.valorGasto)} • Leads Meta: ${fmtInt(r.leadsMeta)} • Leads Zoho: ${fmtInt(r.leadsZoho)} • Reuniões geradas: ${fmtInt(r.reunioes)} • Assinaturas realizadas: ${fmtInt(r.assinaturas)} • CPL Meta: ${fmtCurrency(r.cplMeta)} • Custo por reunião: ${fmtCurrency(r.custoReuniao)} • Custo por assinatura: ${fmtCurrency(r.custoAssinatura)}`,
    "",
    "Acumulado",
    `• Investimento total: ${fmtCurrency(a.valorGasto)} • Leads Meta: ${fmtInt(a.leadsMeta)} • Leads Zoho: ${fmtInt(a.leadsZoho)} • Reuniões geradas: ${fmtInt(a.reunioes)} • Assinaturas realizadas: ${fmtInt(a.assinaturas)}`,
    "",
    "Top Criativos",
    `🥇 Mais assinaturas: ${t.assinaturas}`,
    `🥈 Mais reuniões: ${t.reunioes}`,
    `🥉 Mais leads: ${t.leads}`,
    "",
    "Insight do período",
    payload.insightPeriodo,
  ].join("\n");
}

// =============================================================================
// REPORT DIÁRIO DE MÍDIA PAGA
// =============================================================================

// Metas fixas — julho 2026
const RP_ORCAMENTO              = 28000;
const RP_META_REUNIOES_DIA      = 3;   // total (Google + Meta)
const RP_META_FINAL_GOOGLE      = 40;
const RP_META_FINAL_META        = 20;
const RP_GOOGLE_CLIQUES_DIA     = 1200;
const RP_GOOGLE_LEADS_DIA       = 12;
const RP_GOOGLE_REUNIOES_DIA    = 2;
const RP_META_IMPRESSOES_DIA    = 12900;
const RP_META_CLIQUES_DIA       = 215;
const RP_META_LEADS_DIA         = 23;
const RP_META_REUNIOES_DIA_META = 1;

// Período de referência — julho 2026
const RP_JULY_START        = new Date(2026, 6, 1);   // 01/07/2026
const RP_FERIADOS          = [];                       // sem feriados nacionais em julho
const RP_JULHO_DIAS_UTEIS  = 23;                       // dias úteis totais do mês

function rpCountWorkingDays(from, to) {
  let count = 0;
  const cur = new Date(from);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(23, 59, 59, 999);
  while (cur <= end) {
    const dow     = cur.getDay();
    const dateStr = `${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,"0")}-${String(cur.getDate()).padStart(2,"0")}`;
    if (dow !== 0 && dow !== 6 && !RP_FERIADOS.includes(dateStr)) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

function rpSumRows(rows) {
  return {
    spend:       rows.reduce((s, r) => s + (Number(r.spend)       || 0), 0),
    impressions: rows.reduce((s, r) => s + (Number(r.impressions) || 0), 0),
    clicks:      rows.reduce((s, r) => s + (Number(r.clicks)      || 0), 0),
    leads:       rows.reduce((s, r) => s + (Number(r.leads)       || 0), 0),
  };
}

function rpFmtBRL(n) {
  return `R$ ${Math.round(n).toLocaleString("pt-BR")}`;
}

function rpFormatReport({ today, diasUteis, metaToday, metaMonth, gadsToday, gadsMonth, googleMeetToday, googleMeetMonth, metaMeetToday, metaMeetMonth }) {
  const dia = today.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  const fi  = n => Math.round(n).toLocaleString("pt-BR");

  // Resultado geral
  const metaReunioesAcum = RP_META_REUNIOES_DIA * diasUteis;
  const reunioesAtingidas = googleMeetMonth + metaMeetMonth;
  const pctReunioes       = metaReunioesAcum > 0 ? Math.round(reunioesAtingidas / metaReunioesAcum * 100) : 0;
  const gadsLoaded   = gadsMonth && gadsMonth.costBRL != null;
  const investTotal  = (gadsMonth.costBRL || 0) + (metaMonth.spend || 0);
  const pctOrcamento = Math.round(investTotal / RP_ORCAMENTO * 100);

  // Google Ads
  const gCliqDia    = gadsToday.clicks      || 0;
  const gCliqAcum   = gadsMonth.clicks      || 0;
  const gLeadsDia   = gadsToday.conversions || 0;
  const gLeadsAcum  = gadsMonth.conversions || 0;
  const gMeetDia    = googleMeetToday;
  const gMeetAcum   = googleMeetMonth;
  const gSpendDia   = gadsToday.costBRL     || 0;
  const gSpendAcum  = gadsMonth.costBRL     || 0;

  const gCliqMetaAc  = RP_GOOGLE_CLIQUES_DIA  * diasUteis;
  const gLeadsMetaAc = RP_GOOGLE_LEADS_DIA     * diasUteis;
  const gMeetMetaAc  = RP_GOOGLE_REUNIOES_DIA  * diasUteis;

  const pctGCliq  = Math.round(gCliqDia  / RP_GOOGLE_CLIQUES_DIA  * 100);
  const pctGLeads = Math.round(gLeadsDia / RP_GOOGLE_LEADS_DIA    * 100);
  const pctGMeet  = Math.round(gMeetDia  / RP_GOOGLE_REUNIOES_DIA * 100);
  const pctGInvest = Math.round(gSpendAcum / RP_ORCAMENTO * 100);

  // Meta Ads
  const mVisitDia  = metaToday.impressions || 0;
  const mVisitAcum = metaMonth.impressions || 0;
  const mCliqDia   = metaToday.clicks      || 0;
  const mCliqAcum  = metaMonth.clicks      || 0;
  const mLeadsDia  = metaToday.leads       || 0;
  const mLeadsAcum = metaMonth.leads       || 0;
  const mMeetDia   = metaMeetToday;
  const mMeetAcum  = metaMeetMonth;
  const mSpendDia  = metaToday.spend       || 0;
  const mSpendAcum = metaMonth.spend       || 0;

  const mVisitMetaAc = RP_META_IMPRESSOES_DIA    * diasUteis;
  const mCliqMetaAc  = RP_META_CLIQUES_DIA       * diasUteis;
  const mLeadsMetaAc = RP_META_LEADS_DIA         * diasUteis;
  const mMeetMetaAc  = RP_META_REUNIOES_DIA_META * diasUteis;

  const pctMVisit  = Math.round(mVisitDia  / RP_META_IMPRESSOES_DIA    * 100);
  const pctMCliq   = Math.round(mCliqDia   / RP_META_CLIQUES_DIA       * 100);
  const pctMLeads  = Math.round(mLeadsDia  / RP_META_LEADS_DIA         * 100);
  const pctMMeet   = Math.round(mMeetDia   / RP_META_REUNIOES_DIA_META * 100);
  const pctMInvest = Math.round(mSpendAcum / RP_ORCAMENTO * 100);

  return [
    `• Resultado geral - ${dia}`,
    ``,
    `Meta de reuniões: ${fi(metaReunioesAcum)}`,
    `Atingido: ${fi(reunioesAtingidas)} (${pctReunioes}%)`,
    `Orçamento gasto: ${pctOrcamento}%${!gadsLoaded ? ' (sem dados Google Ads)' : ''}`,
    ``,
    `• Google Ads`,
    ``,
    `Visitas no dia: ${fi(gCliqDia)} (${pctGCliq}% da meta do dia) [meta acumulada: ${fi(gCliqMetaAc)} | atingido acumulado: ${fi(gCliqAcum)}]`,
    `Leads gerados no dia: ${fi(gLeadsDia)} (${pctGLeads}% da meta do dia) [meta acumulada: ${fi(gLeadsMetaAc)} | atingido acumulado: ${fi(gLeadsAcum)}]`,
    `Reuniões no dia: ${fi(gMeetDia)} (${pctGMeet}% da meta do dia) [meta acumulada: ${fi(gMeetMetaAc)} | atingido acumulado: ${fi(gMeetAcum)}]`,
    `Investimento diário: ${rpFmtBRL(gSpendDia)} [Investimento Acumulado: ${rpFmtBRL(gSpendAcum)} | % investida total: ${pctGInvest}%]`,
    `Meta Google ADS: ${RP_META_FINAL_GOOGLE}`,
    ``,
    `• META ADS`,
    ``,
    `Visitas no dia: ${fi(mVisitDia)} (${pctMVisit}% da meta do dia) [meta acumulada: ${fi(mVisitMetaAc)} | atingido acumulado: ${fi(mVisitAcum)}]`,
    `Cliques no dia: ${fi(mCliqDia)} (${pctMCliq}% da meta do dia) [meta acumulada: ${fi(mCliqMetaAc)} | atingido acumulado: ${fi(mCliqAcum)}]`,
    `Leads no dia: ${fi(mLeadsDia)} (${pctMLeads}% da meta do dia) [meta acumulada: ${fi(mLeadsMetaAc)} | atingido acumulado: ${fi(mLeadsAcum)}]`,
    `Reuniões: ${fi(mMeetDia)} (${pctMMeet}% da meta do dia) [meta acumulada: ${fi(mMeetMetaAc)} | atingido acumulado: ${fi(mMeetAcum)}]`,
    `Investimento diário: ${rpFmtBRL(mSpendDia)} [Investimento Acumulado: ${rpFmtBRL(mSpendAcum)} | % investida total: ${pctMInvest}%]`,
    `Meta Meta ADS: ${RP_META_FINAL_META}`,
  ].join("\n");
}

async function generateDailyReport() {
  // Usa a data do seletor; fallback = hoje
  const rpDateEl  = document.getElementById("reportDatePicker");
  const todayStr  = rpDateEl?.value || (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  })();

  // Data selecionada como objeto Date (meia-noite local)
  const [sy, sm, sd] = todayStr.split("-").map(Number);
  const today    = new Date(sy, sm - 1, sd);
  const todayEnd = new Date(sy, sm - 1, sd, 23, 59, 59, 999);

  const julyStr   = "2026-07-01";
  const diasUteis = rpCountWorkingDays(RP_JULY_START, today); // dias úteis decorridos até hoje

  // 4 chamadas paralelas: dia selecionado + acumulado julho até dia selecionado
  const [rMetaToday, rMetaMonth, rGadsToday, rGadsMonth] = await Promise.allSettled([
    fetch(`/api/meta/insights?level=account&since=${todayStr}&until=${todayStr}`).then(r => r.json()),
    fetch(`/api/meta/insights?level=account&since=${julyStr}&until=${todayStr}`).then(r => r.json()),
    fetch(`/api/google-ads/account?since=${todayStr}&until=${todayStr}`).then(r => r.json()),
    fetch(`/api/google-ads/account?since=${julyStr}&until=${todayStr}`).then(r => r.json()),
  ]);

  const metaToday = rpSumRows(rMetaToday.status === "fulfilled" ? (rMetaToday.value?.data || []) : []);
  const metaMonth = rpSumRows(rMetaMonth.status === "fulfilled" ? (rMetaMonth.value?.data || []) : []);
  const gadsToday = (rGadsToday.status === "fulfilled" ? rGadsToday.value?.data : null) || {};
  const gadsMonth = (rGadsMonth.status === "fulfilled" ? rGadsMonth.value?.data : null) || {};

  // Reuniões Zoho filtradas pela data selecionada
  const rRowsAll   = state.reunioesRows || [];
  const rRowsToday = rRowsAll.filter(d => d.horaCriacao && isSameDay(d.horaCriacao, today));
  const rRowsMonth = rRowsAll.filter(d => d.horaCriacao && d.horaCriacao >= RP_JULY_START && d.horaCriacao <= todayEnd);

  const gRowsToday      = rRowsToday.filter(d => isGoogleAdsOrigin(d.origem));
  const gRowsMonth      = rRowsMonth.filter(d => isGoogleAdsOrigin(d.origem));
  const googleMeetToday = computeGoogleAdsReport(gRowsToday).reunioes;
  const googleMeetMonth = computeGoogleAdsReport(gRowsMonth).reunioes;

  // Apenas reuniões de origem Meta (exclui Google) para evitar dupla contagem em reunioesAtingidas
  const mRowsToday = rRowsToday.filter(d => !isGoogleAdsOrigin(d.origem));
  const mRowsMonth = rRowsMonth.filter(d => !isGoogleAdsOrigin(d.origem));
  const metaMeetToday = computeReunioesReport(mRowsToday).reunioes;
  const metaMeetMonth = computeReunioesReport(mRowsMonth).reunioes;

  return rpFormatReport({
    today,
    diasUteis,
    metaToday,
    metaMonth,
    gadsToday,
    gadsMonth,
    googleMeetToday,
    googleMeetMonth,
    metaMeetToday,
    metaMeetMonth,
  });
}

// ── Modal do report ──────────────────────────────────────────────────────────

function openReportModal(text) {
  const modal = document.getElementById("reportModal");
  document.getElementById("reportTextArea").value = text;
  document.getElementById("reportActionStatus").textContent = "";
  modal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeReportModal() {
  document.getElementById("reportModal").hidden = true;
  document.body.style.overflow = "";
}

document.getElementById("reportModalClose").addEventListener("click", closeReportModal);
document.getElementById("reportModal").addEventListener("click", e => {
  if (e.target === document.getElementById("reportModal")) closeReportModal();
});

document.getElementById("reportCopyBtn").addEventListener("click", async () => {
  const text   = document.getElementById("reportTextArea").value;
  const status = document.getElementById("reportActionStatus");
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = "✓ Copiado!";
    setTimeout(() => { status.textContent = ""; }, 3000);
  } catch {
    downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8;" }), "report-diario.txt");
    status.textContent = "Arquivo baixado";
  }
});

document.getElementById("reportSlackBtn").addEventListener("click", async () => {
  const text   = document.getElementById("reportTextArea").value;
  const status = document.getElementById("reportActionStatus");
  const btn    = document.getElementById("reportSlackBtn");
  btn.disabled = true;
  status.textContent = "Enviando…";
  try {
    const res  = await fetch("/api/report/slack", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ text }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Erro ao enviar");
    status.textContent = "✓ Enviado para o Slack!";
    setTimeout(() => { status.textContent = ""; }, 4000);
  } catch (err) {
    status.textContent = `Erro: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
});

// ── Botão Visão Geral ────────────────────────────────────────────────────────

async function handleSendReport(triggerBtn) {
  const btn = triggerBtn;
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Gerando…";
  try {
    const text = await generateDailyReport();
    openReportModal(text);
  } catch (err) {
    console.error("[Report]", err);
    showToast(`Erro ao gerar report: ${err.message}`, "error", 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

document.getElementById("ovSendReportBtn").addEventListener("click", function() {
  handleSendReport(this);
});

document.getElementById("sendReportBtn").addEventListener("click", function() {
  handleSendReport(this);
});

// Inicializar data do seletor com o dia atual
(function () {
  const el = document.getElementById("reportDatePicker");
  if (!el) return;
  const d = new Date();
  el.value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
})();

// ---------------------------------------------------------------------------
// INTEGRAÇÃO COM API LOCAL (servidor Express em localhost:3000)
// ---------------------------------------------------------------------------

// Converte resposta do /api/meta/insights para o formato interno do pipeline
function parseLocalDate(str) {
  if (!str) return null;
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d); // meia-noite local, sem offset UTC
}

function metaApiToRows(apiRows) {
  return apiRows.map((r) => ({
    campanha:    cleanDisplay(r.campaign_name) || "(sem campanha)",
    conjunto:    cleanDisplay(r.adset_name)    || "(sem conjunto)",
    anuncio:     cleanDisplay(r.ad_name)       || "",
    anuncioKey:  normalizeKey(r.ad_name),
    impressoes:  Number(r.impressions)  || 0,
    frequencia:  0,
    valorGasto:  Number(r.spend)        || 0,
    cliques:     Number(r.clicks)       || 0,
    leads:       Number(r.leads)        || 0,
    dataInicio:  parseLocalDate(r.date_start),
    dataFim:     parseLocalDate(r.date_stop),
    adId:        normalizeKey(r.ad_id),
  })).filter((r) => r.anuncio);
}

// Converte resposta do /api/zoho/deals para o formato interno do pipeline
function zohoApiToRows(apiRows) {
  return apiRows.map((r) => {
    const stage = cleanDisplay(r.stage) || "";
    return {
      id:                  cleanDisplay(r.id) || "",
      nomeNegocio:         cleanDisplay(r.dealName),
      nomeContato:         cleanDisplay(r.contactName),
      origem:              cleanDisplay(r.leadSource),
      metaAdsId:           normalizeKey(r.metaAdId),
      metaAdsAnuncio:      cleanDisplay(r.metaAdName),
      metaAdsAnuncioKey:   normalizeKey(r.metaAdName),
      metaAdsCampanha:     cleanDisplay(r.metaCampaign),
      metaAdsLeadId:       cleanDisplay(r.metaLeadId),
      metaAdsCampanhaId:   cleanDisplay(r.metaCampaignId),
      icp:                 cleanDisplay(r.icp),
      stage,
      stageKey:            normalizeKey(stage),
      horaCriacao:         r.createdTime ? new Date(r.createdTime) : null,
    };
  }).filter((r) => r.stage || r.metaAdsAnuncio);
}

// Verifica status das integrações no servidor
async function checkApiStatus() {
  const el    = document.getElementById("apiStatus");
  const items = [
    { key: "meta",   label: "Meta API"    },
    { key: "zoho",   label: "Zoho CRM"   },
    { key: "slack",  label: "Slack"       },
    { key: "google", label: "Google Ads"  },
  ];

  // Laranja enquanto verifica
  el.innerHTML = items.map((i) =>
    `<span class="api-badge api-badge--loading" id="apBadge-${i.key}">⟳ ${i.label}</span>`
  ).join("");

  try {
    const res  = await fetch("/api/status");
    if (!res.ok) throw new Error("Servidor não está rodando");
    const json = await res.json();
    items.forEach((i) => {
      const badge = document.getElementById(`apBadge-${i.key}`);
      if (!badge) return;
      if (json[i.key]) {
        badge.className   = "api-badge api-badge--ok";
        badge.textContent = `✓ ${i.label}`;
      } else {
        badge.className   = "api-badge api-badge--off";
        badge.textContent = `✗ ${i.label}`;
      }
    });
  } catch {
    el.innerHTML = `<span class="api-badge api-badge--off">✗ Servidor offline — rode <code>node server.js</code></span>`;
  }
}

// Busca dados via API e atualiza o dashboard
async function fetchAllData() {
  const btn    = document.getElementById("fetchApiBtn");
  const status = document.getElementById("apiLoadingStatus");
  const panel  = document.getElementById("apiProgressPanel");

  const preset = document.getElementById("apiDatePreset").value;
  const since  = document.getElementById("apiSince").value;
  const until  = document.getElementById("apiUntil").value;

  if (preset === "custom" && (!since || !until)) {
    status.textContent = "Selecione data início e fim para período personalizado.";
    status.className   = "process-status error";
    return;
  }

  btn.disabled       = true;
  panel.hidden       = false;
  status.textContent = "Atualizando dados...";
  status.className   = "process-status";

  const params = new URLSearchParams(
    preset === "custom" ? { since, until } : { date_preset: preset }
  ).toString();

  // Utilitário para atualizar cada linha do painel de progresso
  const setStep = (id, state_, text) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className   = `api-step ${state_}`;
    el.textContent = text;
  };

  // Inicia todos os indicadores
  setStep("apStep-meta",    "loading", "Meta Ads — buscando...");
  setStep("apStep-gads",    "loading", "Google Ads — buscando...");
  setStep("apStep-zoho",    "loading", "Zoho CRM — buscando...");
  setStep("apStep-slack",   "loading", "Slack MQL — buscando...");
  setStep("apStep-process", "pending", "Processando dados");
  setStep("apStep-render",  "pending", "Atualizando telas");

  try {
    // ── FASE 1: todas as chamadas em paralelo ─────────────────────────────────
    const [
      metaInsRes, metaLiveRes, zohoDealsRes,
      gadsDealsRes, gadsAccRes, gadsCamRes, gadsKwRes, gadsStRes,
      slackMqlRes, metaDailyRes, reunioesApiRes, formLeadsRes, sheetLeadsRes,
    ] = await Promise.allSettled([
      fetch(`/api/meta/insights?${params}`).then(r => r.json()),
      fetch(`/api/meta/live?${params}`).then(r => r.json()).catch(() => ({ ok: false })),
      fetch("/api/zoho/deals").then(r => r.json()),
      fetch("/api/zoho/gads-deals").then(r => r.json()),
      fetch(`/api/google-ads/account?${params}`).then(r => r.json()).catch(() => ({ ok: false })),
      fetch(`/api/google-ads/campaigns?${params}`).then(r => r.json()).catch(() => ({ ok: false, data: [] })),
      fetch(`/api/google-ads/keywords?${params}`).then(r => r.json()).catch(() => ({ ok: false, data: [] })),
      fetch(`/api/google-ads/search-terms?${params}`).then(r => r.json()).catch(() => ({ ok: false, data: [] })),
      fetch("/api/slack/mql").then(r => r.json()).catch(() => ({ ok: false, data: [] })),
      fetch(`/api/meta/live/daily?${params}`).then(r => r.json()).catch(() => ({ ok: false, data: [] })),
      fetch("/api/zoho/reunioes").then(r => r.json()).catch(() => ({ ok: false, data: [] })),
      fetch("/api/webhooks/form-leads").then(r => r.json()).catch(() => ({ ok: false, data: [] })),
      fetch("/api/sheets/form-leads").then(r => r.json()).catch(() => ({ ok: false, data: [] })),
    ]);

    const settled = (r) => r.status === "fulfilled" ? r.value : { ok: false, error: r.reason?.message, data: [] };
    const metaIns    = settled(metaInsRes);
    const metaLive   = settled(metaLiveRes);
    const zoho       = settled(zohoDealsRes);
    const gadsDeals  = settled(gadsDealsRes);
    const reunioesApi = settled(reunioesApiRes);
    const formLeadsApi  = settled(formLeadsRes);
    const sheetLeadsApi = settled(sheetLeadsRes);
    const gadsAcc   = settled(gadsAccRes);
    const gadsCam   = settled(gadsCamRes);
    const gadsKw    = settled(gadsKwRes);
    const gadsSt    = settled(gadsStRes);
    const slackMql   = settled(slackMqlRes);
    const metaDaily  = settled(metaDailyRes);

    if (slackMql.ok && Array.isArray(slackMql.data)) {
      slackMqlState.leads = slackMql.data;
      const mqlCount  = slackMql.data.length;
      const mqlSim    = slackMql.data.filter(l => l.isMql).length;
      console.log(`[Slack MQL] ${mqlCount} leads carregados · ${mqlSim} com ✅ MQL`);
      console.table(slackMql.data.slice(0, 5).map(l => ({ nome: l.nome, fonte: l.fonte, isMql: l.isMql })));
    } else {
      console.warn("[Slack MQL] Falha ao carregar:", slackMql.error || "resposta inválida");
    }

    // Atualiza indicadores da fase 1
    setStep("apStep-meta",
      metaIns.ok ? "done" : "error",
      metaIns.ok
        ? `Meta Ads — ${(metaIns.data || []).length} registros`
        : `Meta Ads — ${metaIns.error || "erro"}`
    );
    setStep("apStep-gads",
      gadsAcc.ok ? "done" : "error",
      gadsAcc.ok
        ? `Google Ads — ${(gadsCam.data || []).length} campanhas`
        : `Google Ads — parcial (sem dados de investimento)`
    );
    setStep("apStep-zoho",
      zoho.ok ? "done" : "error",
      zoho.ok
        ? `Zoho CRM — ${(zoho.data || []).length} negócios`
        : `Zoho CRM — ${zoho.error || "erro"}`
    );
    const mqlSim = (slackMqlState.leads || []).filter(l => l.isMql).length;
    setStep("apStep-slack",
      slackMql.ok ? "done" : "error",
      slackMql.ok
        ? `Slack MQL — ${slackMqlState.leads.length} leads · ${mqlSim} ✅ MQL`
        : `Slack MQL — ${slackMql.error || "não configurado"}`
    );

    // Lança erro crítico só se Meta E Zoho falharem ao mesmo tempo
    if (!metaIns.ok && !zoho.ok) {
      throw new Error(`Meta: ${metaIns.error || "sem dados"} | Zoho: ${zoho.error || "sem dados"}`);
    }

    // ── FASE 2: processar dados ───────────────────────────────────────────────
    setStep("apStep-process", "loading", "Processando dados...");

    // Meta Ads → linhas normalizadas
    if (metaIns.ok && Array.isArray(metaIns.data) && metaIns.data.length > 0) {
      state.metaRows = metaApiToRows(metaIns.data);
    }

    // Zoho CRM → estado global
    if (zoho.ok && Array.isArray(zoho.data)) {
      const zohoRows      = zohoApiToRows(zoho.data);
      state.zohoRows      = zohoRows;
      state.zohoFiltered  = zohoRows;
      state.reunioesRows  = zohoRows;
      state.isOfficialReunioesData = false;
    }

    // Relatório oficial de reuniões — substitui zohoRows como fonte de verdade para reuniões.
    // Inclui deals [AT CG] com origem Meta Ads / Site PipeLovers excluídos do relatório Zoho.
    if (reunioesApi.ok && Array.isArray(reunioesApi.data) && reunioesApi.data.length > 0) {
      state.reunioesRows = zohoApiToRows(reunioesApi.data);
      state.isOfficialReunioesData = true;
    }

    // Leads do formulário via Pluga (webhook em tempo real)
    if (formLeadsApi.ok && Array.isArray(formLeadsApi.data)) {
      state.formLeads = formLeadsApi.data;
    }

    // Leads da planilha de atribuição (fonte principal de campanha/anúncio/keyword)
    if (sheetLeadsApi.ok && Array.isArray(sheetLeadsApi.data)) {
      state.sheetLeads = sheetLeadsApi.data;
    }

    // Cruzamento Meta × Zoho → criativos
    if (state.metaRows.length > 0) {
      const { creatives, unmatchedZoho } = buildCreatives(state.metaRows, state.zohoRows);
      state.creatives    = creatives;
      state.filtered     = creatives;
      state.zohoFiltered = state.zohoRows;
      populateFilterOptions(creatives);
    }

    // Filtro de período para reuniões/assinaturas
    const dateRange      = presetToDateRange(preset, since, until);
    const filterByPeriod = (rows) => rows.filter(d => {
      if (!d.horaCriacao) return false;
      return d.horaCriacao >= dateRange.start && d.horaCriacao <= dateRange.end;
    });
    const reunioesForPeriod = filterByPeriod(state.reunioesRows);
    state.reunioesFiltered  = reunioesForPeriod;
    const zohoForPeriod     = filterByPeriod(state.zohoRows);

    // Google Ads — reuniões e assinaturas via Zoho (filtrado por período)
    const gadsRows = (gadsDeals.ok ? (gadsDeals.data || []) : []).map(r => ({
      id:          r.id           || "",
      nomeNegocio: r.dealName     || "",
      nomeContato: r.contactName  || "",
      stage:       r.stage        || "",
      horaCriacao: r.createdTime  ? new Date(r.createdTime) : null,
    }));
    const gadsPeriodRows  = gadsRows.filter(r => {
      if (!r.horaCriacao) return false;
      return r.horaCriacao >= dateRange.start && r.horaCriacao <= dateRange.end;
    });
    const { reunioes: gMeet, assinaturas: gSign } = computeGoogleAdsReport(gadsPeriodRows);

    gadsState.reunioes    = gMeet;
    gadsState.assinaturas = gSign;
    gadsState.costBRL     = gadsAcc.ok ? (gadsAcc.data?.costBRL ?? 0) : gadsState.costBRL;
    gadsState.summary     = gadsAcc.ok ? gadsAcc.data    : gadsState.summary;
    gadsState.campaigns   = gadsCam.ok ? (gadsCam.data || []) : gadsState.campaigns;
    gadsState.keywords    = gadsKw.ok  ? (gadsKw.data  || []) : gadsState.keywords;
    gadsState.searchTerms = gadsSt.ok  ? (gadsSt.data  || []) : gadsState.searchTerms;

    // Live Meta — métricas Zoho para a aba Live Meta
    let liveMetrics = null;
    if (metaLive.ok && Array.isArray(metaLive.data)) {
      const { reunioes, assinaturas } = computeReunioesReport(reunioesForPeriod, { skipOriginFilter: state.isOfficialReunioesData });
      const { metaTotal }             = computeZohoMetaMetrics(zohoForPeriod);
      liveMetrics = { metaTotal, reunioes, assinaturas, ads: metaLive.data };
    }

    setStep("apStep-process", "done", "Dados processados");

    // ── FASE 3: renderizar todas as abas ──────────────────────────────────────
    setStep("apStep-render", "loading", "Atualizando telas...");

    // Visão Geral + Live Meta (MetaEdge) + Tabela Detalhada
    renderAll();

    // Google Ads
    renderGadsSummary();
    renderGadsApiSummary();
    renderGadsCampaigns();
    renderGadsKeywords();
    renderGadsSearchTerms();

    // Visão geral (já chamada dentro de renderAll, mas re-renderiza com gadsState atualizado)
    renderOverview();

    // Live Meta
    if (liveMetrics) {
      _lmDailyData     = (metaDaily.ok && Array.isArray(metaDaily.data)) ? metaDaily.data : [];
      _lmCurrentPeriod = { preset, since, until };
      renderLiveMetaMetrics({ metaTotal: liveMetrics.metaTotal, reunioes: liveMetrics.reunioes, assinaturas: liveMetrics.assinaturas });
      renderLiveMeta(liveMetrics.ads);
      renderLmDailyToggles();
      renderLmDailyChart();
    }

    // Insights IA (depende do Live Meta estar renderizado)
    renderInsightsIA();

    // Financeiro
    renderFinanceiro();

    // Visibilidade de seções do Google Ads
    if (gadsState.summary)
      document.getElementById("gadsApiSummary").style.display = "grid";
    if (gadsState.campaigns.length)
      document.getElementById("gadsCampaignsSection").style.display = "";
    if (gadsState.keywords.length || gadsState.searchTerms.length)
      document.getElementById("gadsInsightsSection").style.display = "";

    // Timestamps
    const now     = new Date();
    const nowStr  = now.toLocaleString("pt-BR");
    const nowTime = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    document.getElementById("gadsLastUpdate").textContent = `Atualizado em ${nowTime}`;
    const lmUpd = document.getElementById("liveMetaLastUpdate");
    if (lmUpd) lmUpd.textContent = `Última atualização: ${nowStr}`;

    setStep("apStep-render", "done", "Todas as telas atualizadas");

    status.textContent = `Atualização concluída — ${nowStr}`;
    status.className   = "process-status success";
    showToast("Sistema atualizado com sucesso.", "success");

    // Navega para Visão Geral após atualização completa
    document.querySelector('.tab-btn[data-tab="overview"]')?.click();

  } catch (err) {
    console.error("[fetchAllData]", err);
    status.textContent = `Erro: ${err.message}`;
    status.className   = "process-status error";
    showToast(err.message, "error", 5000);
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("fetchApiBtn").addEventListener("click", fetchAllData);

// Período personalizado — mostra/oculta campos de data
document.getElementById("apiDatePreset").addEventListener("change", (e) => {
  const custom = document.getElementById("apiCustomDates");
  custom.style.display = e.target.value === "custom" ? "flex" : "none";
});

// Atualiza o botão Enviar Report para usar o endpoint do servidor
document.getElementById("sendReportBtn").addEventListener("click", async () => {}, true);
// (override do handler original registrado acima)
(function overrideSendReport() {
  const btn = document.getElementById("sendReportBtn");
  const clone = btn.cloneNode(true);
  btn.parentNode.replaceChild(clone, btn);

  clone.addEventListener("click", async () => {
    clone.disabled = true;
    showToast("Enviando report...", "info", 60000);
    try {
      const payload = buildSlackPayload();
      const res     = await fetch("/api/report/slack", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Erro desconhecido");
      showToast("Report enviado para o Slack com sucesso.", "success", 4000);
    } catch (err) {
      // fallback: copia texto para clipboard
      try {
        const text = buildSlackMessageText(buildSlackPayload());
        await navigator.clipboard.writeText(text);
        showToast("Servidor offline — texto do report copiado. Cole no Slack.", "info", 5000);
      } catch {
        showToast(`Erro ao enviar report: ${err.message}`, "error", 5000);
      }
    } finally {
      clone.disabled = !(state.creatives.length > 0);
    }
  });
})();

// Verifica status na inicialização
checkApiStatus();

// ---------------------------------------------------------------------------
// ABA LIVE META
// ---------------------------------------------------------------------------

function fmtLiveFreq(n) {
  if (!isFinite(n)) return "—";
  return n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function statusClass(s) {
  if (s === "Ativo") return "status-active";
  if (["Pausado", "Campanha pausada", "Conjunto pausado"].includes(s)) return "status-paused";
  if (["Arquivado", "Excluído"].includes(s)) return "status-archived";
  if (["Rejeitado", "Com problemas"].includes(s)) return "status-rejected";
  return "status-other";
}

// ── Live Meta Daily Chart ─────────────────────────────────────────────────────
let _lmDailyData    = [];                         // linhas brutas {date_start, ...} da API
let _lmCurrentPeriod = { preset: "last_30d", since: "", until: "" };
let _lmDailyChart   = null;

const LM_DAILY_METRICS = [
  { key: "leads",       label: "Leads",          color: "#6c5ce7", axis: "yL", group: "conv" },
  { key: "reunioes",    label: "Reuniões",        color: "#2ecc8f", axis: "yL", group: "conv" },
  { key: "assinaturas", label: "Assinaturas",     color: "#f5b942", axis: "yL", group: "conv" },
  { key: "clicks",      label: "Cliques",         color: "#4fb6e8", axis: "yR", group: "media" },
  { key: "impressions", label: "Impressões",      color: "#9aa4b8", axis: "yR", group: "media" },
  { key: "reach",       label: "Alcance",         color: "#d98a4b", axis: "yR", group: "media" },
  { key: "spend",       label: "Custo",           color: "#ff6b6b", axis: "yR", group: "cost" },
  { key: "ctr",         label: "CTR",             color: "#00b894", axis: "yR", group: "cost" },
  { key: "cpc",         label: "CPC",             color: "#fd79a8", axis: "yR", group: "cost" },
];

const _lmActiveMetrics = new Set(["leads", "spend"]); // padrão inicial

function _lmDateKey(d) {
  if (!d) return null;
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function _lmGenerateDates(startStr, endStr) {
  const dates = [];
  const cur   = new Date(startStr + "T12:00:00");
  const end   = new Date(endStr   + "T12:00:00");
  while (cur <= end) {
    dates.push(_lmDateKey(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function _lmFmtLabel(dateStr) { // "2026-06-01" → "01/06"
  const [, m, d] = dateStr.split("-");
  return `${d}/${m}`;
}

function _lmGetPeriodRange() {
  const { preset, since, until } = _lmCurrentPeriod;
  const r = presetToDateRange(preset, since, until);
  // Convert Date → "YYYY-MM-DD"
  const fmt = (d) => _lmDateKey(d);
  return { startStr: fmt(r.start), endStr: fmt(r.end) };
}

function renderLmDailyToggles() {
  const container = document.getElementById("lmDailyToggles");
  if (!container) return;
  container.innerHTML = LM_DAILY_METRICS.map(m => {
    const active = _lmActiveMetrics.has(m.key);
    const bg = active ? m.color : "transparent";
    const border = m.color;
    return `<button class="lm-daily-toggle ${active ? "active" : "inactive"}" data-metric="${m.key}"
        style="background:${bg};border-color:${border};${active ? "" : "color:var(--text)"}">
      <span class="lm-toggle-dot" style="background:${active ? "#fff" : m.color}"></span>
      ${m.label}
    </button>`;
  }).join("");
}

function renderLmDailyChart() {
  const canvas = document.getElementById("lmDailyCanvas");
  const section = document.getElementById("lmDailySection");
  if (!canvas || !section) return;

  // Não mostra se não tem dados
  if (!_lmDailyData.length && !state.reunioesFiltered.length) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";

  // ── Período ──
  const { startStr, endStr } = _lmGetPeriodRange();
  const dates = _lmGenerateDates(startStr, endStr);
  if (!dates.length) return;

  // ── Agrega dados Meta por dia ──
  const metaByDay = {};
  dates.forEach(d => { metaByDay[d] = { leads:0, impressions:0, reach:0, clicks:0, spend:0, ctrSum:0, cpcSum:0, count:0 }; });
  _lmDailyData.forEach(row => {
    const d = row.date_start;
    if (!metaByDay[d]) return;
    const b = metaByDay[d];
    b.leads       += row.leads;
    b.impressions += row.impressions;
    b.reach       += row.reach;
    b.clicks      += row.clicks;
    b.spend       += row.spend;
    b.count++;
  });
  // CTR e CPC: recalcula a partir dos totais (não faz média dos percentuais)
  dates.forEach(d => {
    const b = metaByDay[d];
    b.ctr = b.impressions > 0 ? b.clicks / b.impressions * 100 : 0;
    b.cpc = b.clicks      > 0 ? b.spend  / b.clicks           : 0;
  });

  // ── Agrega Zoho por dia ──
  const meetByDay = {};
  const signByDay = {};
  dates.forEach(d => { meetByDay[d] = 0; signByDay[d] = 0; });
  (state.reunioesFiltered || []).forEach(d => {
    const key = _lmDateKey(d.horaCriacao);
    if (!key) return;
    if (countsAsMetaMeeting(d.stage, d.origem)    && meetByDay[key] !== undefined) meetByDay[key]++;
    if (countsAsMetaSignature(d.stage, d.origem)  && signByDay[key] !== undefined) signByDay[key]++;
  });

  // ── Mapeia métricas → array de valores por data ──
  const valuesMap = {
    leads:       dates.map(d => metaByDay[d].leads),
    impressions: dates.map(d => metaByDay[d].impressions),
    reach:       dates.map(d => metaByDay[d].reach),
    clicks:      dates.map(d => metaByDay[d].clicks),
    spend:       dates.map(d => metaByDay[d].spend),
    ctr:         dates.map(d => metaByDay[d].ctr),
    cpc:         dates.map(d => metaByDay[d].cpc),
    reunioes:    dates.map(d => meetByDay[d]),
    assinaturas: dates.map(d => signByDay[d]),
  };

  // ── Datasets ──
  const datasets = LM_DAILY_METRICS
    .filter(m => _lmActiveMetrics.has(m.key))
    .map(m => ({
      label:           m.label,
      data:            valuesMap[m.key],
      borderColor:     m.color,
      backgroundColor: m.color + "22",
      yAxisID:         m.axis,
      tension:         0.35,
      pointRadius:     dates.length <= 14 ? 4 : 2,
      pointHoverRadius: 6,
      borderWidth:     2,
      fill:            false,
      _metricKey:      m.key,
    }));

  const hasLeft  = datasets.some(ds => ds.yAxisID === "yL");
  const hasRight = datasets.some(ds => ds.yAxisID === "yR");

  // Tooltip formatters por métrica
  const metricFmt = {
    leads: v => fmtInt(v), reunioes: v => fmtInt(v), assinaturas: v => fmtInt(v),
    clicks: v => fmtInt(v), impressions: v => fmtInt(v), reach: v => fmtInt(v),
    spend: v => fmtCurrency(v), ctr: v => fmtPct(v), cpc: v => fmtCurrency(v),
  };

  const config = {
    type: "line",
    data: { labels: dates.map(_lmFmtLabel), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      animation: { duration: 300 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const key = ctx.dataset._metricKey;
              const fmt = metricFmt[key] || (v => v);
              return ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: "rgba(0,0,0,0.05)" },
          ticks: { font: { size: 11 }, maxTicksLimit: 15, maxRotation: 0 },
        },
        yL: {
          type:     "linear",
          position: "left",
          display:  hasLeft,
          title:    { display: hasLeft, text: "Conversões", font: { size: 11 } },
          grid:     { color: "rgba(0,0,0,0.05)" },
          ticks:    { font: { size: 11 }, precision: 0 },
          beginAtZero: true,
        },
        yR: {
          type:     "linear",
          position: "right",
          display:  hasRight,
          title:    { display: hasRight, text: "Mídia / Custo", font: { size: 11 } },
          grid:     { drawOnChartArea: false },
          ticks:    { font: { size: 11 } },
          beginAtZero: true,
        },
      },
    },
  };

  if (_lmDailyChart) { _lmDailyChart.destroy(); _lmDailyChart = null; }
  _lmDailyChart = new Chart(canvas.getContext("2d"), config);
}

// Clique nos toggles
document.getElementById("lmDailyToggles").addEventListener("click", (e) => {
  const btn = e.target.closest(".lm-daily-toggle[data-metric]");
  if (!btn) return;
  const key = btn.dataset.metric;
  if (_lmActiveMetrics.has(key)) {
    if (_lmActiveMetrics.size > 1) _lmActiveMetrics.delete(key); // mínimo 1 ativo
  } else {
    _lmActiveMetrics.add(key);
  }
  renderLmDailyToggles();
  renderLmDailyChart();
});

// Linhas da última atualização do Live Meta (para lookup no modal)
let slackMqlState   = { leads: [] };
let _liveMetaRows   = [];
let _lmDealsStore   = [];  // [{meetDeals, signDeals, mqlLeads}] indexado por linha da Live Meta
let _lmSort         = { col: null, dir: 0 }; // dir: 0=padrão, 1=desc, -1=asc

function _lmSortVal(r, rd, col) {
  switch (col) {
    case "reach":       return r.reach       ?? 0;
    case "impressions": return r.impressions  ?? 0;
    case "frequency":   return r.frequency   ?? 0;
    case "spend":       return r.spend       ?? 0;
    case "clicks":      return r.clicks      ?? 0;
    case "cpm":         return r.cpm         ?? 0;
    case "ctr":         return r.ctr         ?? 0;
    case "cpl":         return r.cost_per_lead ?? -Infinity;
    case "cpc":         return r.cpc         ?? 0;
    case "leads":       return r.leads       ?? 0;
    case "mql":         return (rd.mqlLeads  || []).length;
    case "conv_mql":    return r.leads > 0 ? (rd.mqlLeads || []).length / r.leads : -1;
    case "reunioes":    return (rd.meetDeals || []).length;
    case "assinaturas": return (rd.signDeals || []).length;
    default:            return 0;
  }
}

function _updateLmSortIcons() {
  document.querySelectorAll("#liveMetaTable thead th[data-col]").forEach(th => {
    const col  = th.dataset.col;
    const icon = th.querySelector(".lm-sort-icon");
    th.classList.remove("sort-asc", "sort-desc");
    if (!icon) return;
    if (_lmSort.col === col) {
      if (_lmSort.dir === 1)  { th.classList.add("sort-desc"); icon.textContent = "↓"; }
      if (_lmSort.dir === -1) { th.classList.add("sort-asc");  icon.textContent = "↑"; }
      if (_lmSort.dir === 0)  { icon.textContent = "↕"; }
    } else {
      icon.textContent = "↕";
    }
  });
}

// Retorna leads do Slack cujo campo Fonte: corresponde ao anúncio/conjunto/campanha
function getMqlForAd(row) {
  const adNorm   = iaNorm(row.ad_name);
  const setNorm  = iaNorm(row.adset_name);
  const campNorm = iaNorm(row.campaign_name);
  return (slackMqlState.leads || []).filter(lead => {
    const f = lead.fonteNorm || "";
    if (adNorm   && adNorm.length   > 3 && f.includes(adNorm))   return true;
    if (setNorm  && setNorm.length  > 3 && f.includes(setNorm))  return true;
    if (campNorm && campNorm.length > 3 && f.includes(campNorm)) return true;
    return false;
  });
}

function renderLiveMeta(rows) {
  const tbody = document.getElementById("liveMetaBody");

  _liveMetaRows = rows || [];
  _lmDealsStore = [];

  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="19" class="livemeta-empty">Sem dados para o período selecionado.</td></tr>`;
    _updateLmSortIcons();
    return;
  }

  // Ordem canônica (por leads desc) usada para atribuição de assinaturas
  const sorted = [...rows].sort((a, b) => b.leads - a.leads);

  // ── Assinaturas: usa reunioesFiltered para respeitar o filtro de data ──
  const seenSignUid = new Set();
  const allMetaSign = [];
  (state.reunioesFiltered || state.reunioesRows || []).forEach(d => {
    if (!countsAsMetaSignature(d.stage, d.origem)) return;
    const ck  = normalizeKey(d.nomeContato || "");
    const bn  = cleanDealBaseName(d.nomeNegocio);
    const uid = (ck && bn) ? `${ck}|${bn}` : (ck || bn || d.id || `${d.nomeNegocio}|${String(d.horaCriacao)}`);
    if (seenSignUid.has(uid)) return;
    seenSignUid.add(uid);
    allMetaSign.push({ ...d, _uid: uid });
  });

  const adNameToRowIdx = new Map();
  const adIdToRowIdx   = new Map();
  sorted.forEach((r, i) => {
    const key = normalizeKey(r.ad_name);
    if (key && !adNameToRowIdx.has(key)) adNameToRowIdx.set(key, i);
    if (r.ad_id && !adIdToRowIdx.has(r.ad_id)) adIdToRowIdx.set(r.ad_id, i);
  });

  const rowSignDeals   = sorted.map(() => []);
  const attributedUids = new Set();
  allMetaSign.forEach(d => {
    let rowIdx = -1;
    if (d.metaAdsAnuncioKey && adNameToRowIdx.has(d.metaAdsAnuncioKey))
      rowIdx = adNameToRowIdx.get(d.metaAdsAnuncioKey);
    else if (d.metaAdsId && adIdToRowIdx.has(d.metaAdsId))
      rowIdx = adIdToRowIdx.get(d.metaAdsId);
    if (rowIdx >= 0) { rowSignDeals[rowIdx].push(d); attributedUids.add(d._uid); }
  });

  const unattributedSign = allMetaSign.filter(d => !attributedUids.has(d._uid));
  unattributedSign.forEach(d => {
    console.warn(`[Live Meta] Assinatura Meta sem criativo atribuído: ${d.nomeNegocio || d.nomeContato || "(sem nome)"}`);
  });
  if (unattributedSign.length > 0 || allMetaSign.length > 0) {
    console.log(`[Live Meta] Assinaturas — card: ${allMetaSign.length} | atribuídas: ${attributedUids.size} | sem criativo: ${unattributedSign.length}`);
  }

  // Map ad_id → signDeals (para lookup independente da ordem de renderização)
  const signDealsByAdId = new Map();
  sorted.forEach((r, i) => signDealsByAdId.set(r.ad_id || String(i), rowSignDeals[i]));

  // ── Reuniões por criativo: mesmo matching das assinaturas, a partir de reunioesFiltered ──
  const seenMeetUid = new Set();
  const allMetaMeet = [];
  (state.reunioesFiltered || state.reunioesRows || []).forEach(d => {
    if (!countsAsMetaMeeting(d.stage, d.origem)) return;
    const ck  = normalizeKey(d.nomeContato || "");
    const bn  = cleanDealBaseName(d.nomeNegocio);
    const uid = (ck && bn) ? `${ck}|${bn}` : (ck || bn || d.id || `${d.nomeNegocio}|${String(d.horaCriacao)}`);
    if (seenMeetUid.has(uid)) return;
    seenMeetUid.add(uid);
    allMetaMeet.push({ ...d, _uid: uid });
  });

  const rowMeetDeals = sorted.map(() => []);
  allMetaMeet.forEach(d => {
    let rowIdx = -1;
    if (d.metaAdsAnuncioKey && adNameToRowIdx.has(d.metaAdsAnuncioKey))
      rowIdx = adNameToRowIdx.get(d.metaAdsAnuncioKey);
    else if (d.metaAdsId && adIdToRowIdx.has(d.metaAdsId))
      rowIdx = adIdToRowIdx.get(d.metaAdsId);
    if (rowIdx >= 0) rowMeetDeals[rowIdx].push(d);
  });

  const meetDealsByAdId = new Map();
  sorted.forEach((r, i) => meetDealsByAdId.set(r.ad_id || String(i), rowMeetDeals[i]));

  // ── Pré-computa dados de cada linha ──────────────────────────────────────────
  const rowData = sorted.map(r => {
    const meetDeals = meetDealsByAdId.get(r.ad_id || "") || [];
    const signDeals = signDealsByAdId.get(r.ad_id || "") || [];
    const mqlLeads  = getMqlForAd(r).filter(l => l.isMql);
    return { r, meetDeals, signDeals, mqlLeads };
  });

  // ── Aplica ordenação do usuário ──────────────────────────────────────────────
  let displayRows = [...rowData];
  if (_lmSort.col && _lmSort.dir !== 0) {
    displayRows.sort((a, b) => {
      const va = _lmSortVal(a.r, a, _lmSort.col);
      const vb = _lmSortVal(b.r, b, _lmSort.col);
      if (va === vb) return 0;
      return _lmSort.dir === 1 ? vb - va : va - vb;
    });
  }

  // ── Totais (agregados de todos os criativos, independentes da ordenação) ─────
  const T = rows.reduce((acc, r) => {
    acc.reach       += r.reach;
    acc.impressions += r.impressions;
    acc.spend       += r.spend;
    acc.clicks      += r.clicks;
    acc.leads       += r.leads;
    return acc;
  }, { reach: 0, impressions: 0, spend: 0, clicks: 0, leads: 0 });

  const tReunioes    = rowData.reduce((s, e) => s + e.meetDeals.length, 0);
  const tAssinaturas = rowData.reduce((s, e) => s + e.signDeals.length, 0);
  const tMql         = rowData.reduce((s, e) => s + e.mqlLeads.length, 0);

  const totalMqlDisp = (slackMqlState.leads || []).filter(l => l.isMql).length;
  const semCriativo  = Math.max(0, totalMqlDisp - tMql);
  console.log(`[Slack MQL] ${tMql} atribuídos a criativos | ${semCriativo} sem criativo | ${totalMqlDisp} total ✅`);

  const freq     = T.reach       > 0 ? T.impressions / T.reach        : 0;
  const cpm      = T.impressions > 0 ? T.spend / T.impressions * 1000  : 0;
  const ctr      = T.impressions > 0 ? T.clicks / T.impressions * 100   : 0;
  const cpc      = T.clicks      > 0 ? T.spend / T.clicks               : 0;
  const cpl      = T.leads       > 0 ? T.spend / T.leads                : null;
  const tConvMql = T.leads       > 0 ? fmtPct(totalMqlDisp / T.leads * 100) : "—";

  const totalsHtml = `
    <tr class="lm-totals-row">
      <td colspan="4"><strong>TOTAL GERAL</strong></td>
      <td>${fmtInt(T.reach)}</td>
      <td>${fmtInt(T.impressions)}</td>
      <td>${fmtLiveFreq(freq)}</td>
      <td>${fmtCurrency(T.spend)}</td>
      <td>${fmtInt(T.clicks)}</td>
      <td>${fmtCurrency(cpm)}</td>
      <td>${fmtPct(ctr)}</td>
      <td>${cpl !== null ? fmtCurrency(cpl) : "—"}</td>
      <td>${fmtCurrency(cpc)}</td>
      <td>${fmtInt(T.leads)}</td>
      <td>${fmtInt(totalMqlDisp)}</td>
      <td>${tConvMql}</td>
      <td>${fmtInt(tReunioes)}</td>
      <td>${fmtInt(tAssinaturas)}</td>
      <td>—</td>
    </tr>`;

  // ── Monta célula com count + botão 🔍 quando > 0 ────────────────────────────
  const dealsCell = (deals, idx, type) => {
    if (deals.length === 0) return "0";
    return `${deals.length} <button class="lm-deals-btn" data-idx="${idx}" data-type="${type}" title="Ver leads">🔍</button>`;
  };

  const rowsHtml = displayRows.map(({ r, meetDeals, signDeals, mqlLeads }) => {
    const idx     = _lmDealsStore.length;
    _lmDealsStore.push({ meetDeals, signDeals, mqlLeads });

    const mqlCell = mqlLeads.length > 0
      ? `${mqlLeads.length} <button class="lm-mql-btn" data-idx="${idx}" title="Ver MQLs">🔍</button>`
      : "0";
    const convMql = r.leads > 0 ? fmtPct(mqlLeads.length / r.leads * 100) : "—";

    return `
    <tr>
      <td class="col-criativo">
        <button class="btn-criativo" data-adid="${escapeHtml(r.ad_id)}">
          <span aria-hidden="true">🔍</span> Ver criativo
        </button>
      </td>
      <td>${escapeHtml(r.campaign_name)}</td>
      <td>${escapeHtml(r.adset_name)}</td>
      <td>${escapeHtml(r.ad_name)}</td>
      <td>${fmtInt(r.reach)}</td>
      <td>${fmtInt(r.impressions)}</td>
      <td>${fmtLiveFreq(r.frequency)}</td>
      <td>${fmtCurrency(r.spend)}</td>
      <td>${fmtInt(r.clicks)}</td>
      <td>${fmtCurrency(r.cpm)}</td>
      <td>${fmtPct(r.ctr)}</td>
      <td>${r.cost_per_lead !== null ? fmtCurrency(r.cost_per_lead) : "—"}</td>
      <td>${fmtCurrency(r.cpc)}</td>
      <td>${fmtInt(r.leads)}</td>
      <td class="col-num">${mqlCell}</td>
      <td class="col-num">${convMql}</td>
      <td class="col-num">${dealsCell(meetDeals, idx, "meet")}</td>
      <td class="col-num">${dealsCell(signDeals, idx, "sign")}</td>
      <td><span class="live-status ${statusClass(r.status)}">${escapeHtml(r.status)}</span></td>
    </tr>`;
  }).join("");

  tbody.innerHTML = totalsHtml + rowsHtml;
  _updateLmSortIcons();
}

// ---------------------------------------------------------------------------
// MODAL DE DEALS (reuniões / assinaturas da Live Meta)
// ---------------------------------------------------------------------------
function openDealsModal(title, deals) {
  const modal = document.getElementById("dealsModal");
  document.getElementById("dealsModalTitle").textContent = title;
  const ul = document.getElementById("dealsModalList");
  if (deals.length === 0) {
    ul.innerHTML = "<li>Nenhum lead encontrado.</li>";
  } else {
    ul.innerHTML = deals
      .map(d => `<li>${escapeHtml(d.nomeNegocio || d.nomeContato || "(sem nome)")}</li>`)
      .join("");
  }
  modal.hidden = false;
  document.body.classList.add("modal-open");
}

document.getElementById("dealsModalClose").addEventListener("click", () => {
  document.getElementById("dealsModal").hidden = true;
  document.body.classList.remove("modal-open");
});
document.getElementById("dealsModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.hidden = true;
    document.body.classList.remove("modal-open");
  }
});

// ---------------------------------------------------------------------------
// MODAL DE CRIATIVO
// ---------------------------------------------------------------------------
function openCreativeModal(adId) {
  const row = _liveMetaRows.find((r) => r.ad_id === adId);
  if (!row) return;

  const modal   = document.getElementById("creativeModal");
  const loading = document.getElementById("creativeModalLoading");
  const noImg   = document.getElementById("creativeModalNoImg");
  const preview = document.getElementById("creativeModalPreview");

  // Info do anúncio (imediata)
  document.getElementById("creativeModalCampanha").textContent = row.campaign_name;
  document.getElementById("creativeModalConjunto").textContent = row.adset_name;
  document.getElementById("creativeModalAdName").textContent   = row.ad_name;
  document.getElementById("creativeModalAdId").textContent     = row.ad_id;

  // Reseta área de preview (só o container do iframe — loading e noImg ficam no DOM)
  preview.innerHTML = "";
  noImg.hidden   = true;
  loading.hidden = false;

  modal.hidden = false;
  document.body.classList.add("modal-open");

  fetch(`/api/meta/creative/${encodeURIComponent(adId)}`)
    .then((r) => r.json())
    .then((json) => {
      loading.hidden = true;
      const data = json.data;
      if (data?.iframe_src) {
        const iframe = document.createElement("iframe");
        iframe.src = data.iframe_src;
        iframe.width  = data.width  || 335;
        iframe.height = data.height || 450;
        iframe.setAttribute("scrolling", "yes");
        iframe.setAttribute("allow", "autoplay");
        iframe.style.cssText = "border:none;display:block;max-width:100%;";
        preview.appendChild(iframe);
      } else {
        noImg.hidden = false;
      }
    })
    .catch(() => {
      loading.hidden = true;
      noImg.hidden   = false;
    });
}

function closeCreativeModal() {
  document.getElementById("creativeModal").hidden = true;
  document.body.classList.remove("modal-open");
  // Remove apenas o iframe do container de preview (loading/noImg ficam no DOM)
  document.getElementById("creativeModalPreview").innerHTML = "";
}

// Ordenação por clique no cabeçalho da Live Meta
document.querySelector("#liveMetaTable thead").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-col]");
  if (!th) return;
  const col = th.dataset.col;
  if (_lmSort.col !== col) {
    _lmSort = { col, dir: 1 };         // nova coluna → começa desc
  } else if (_lmSort.dir === 1) {
    _lmSort = { col, dir: -1 };        // segundo clique → asc
  } else if (_lmSort.dir === -1) {
    _lmSort = { col: null, dir: 0 };   // terceiro clique → padrão
  } else {
    _lmSort = { col, dir: 1 };
  }
  if (_liveMetaRows.length > 0) renderLiveMeta(_liveMetaRows);
});

// Delegação de eventos na tbody (captura cliques no botão independente da linha)
document.getElementById("liveMetaBody").addEventListener("click", (e) => {
  const criativo = e.target.closest(".btn-criativo");
  if (criativo) { openCreativeModal(criativo.dataset.adid); return; }

  const dealsBtn = e.target.closest(".lm-deals-btn");
  if (dealsBtn) {
    const idx   = parseInt(dealsBtn.dataset.idx, 10);
    const type  = dealsBtn.dataset.type;
    const entry = _lmDealsStore[idx];
    if (!entry) return;
    const deals = type === "meet" ? entry.meetDeals : entry.signDeals;
    const title = type === "meet" ? "Reuniões deste criativo" : "Assinaturas deste criativo";
    openDealsModal(title, deals);
    return;
  }

  const mqlBtn = e.target.closest(".lm-mql-btn");
  if (mqlBtn) {
    const idx   = parseInt(mqlBtn.dataset.idx, 10);
    const entry = _lmDealsStore[idx];
    if (!entry) return;
    openMqlModal(entry.mqlLeads || []);
  }
});

function openMqlModal(leads) {
  const modal = document.getElementById("mqlModal");
  const list  = document.getElementById("mqlModalList");
  if (leads.length === 0) {
    list.innerHTML = "<li>Nenhum MQL encontrado.</li>";
  } else {
    list.innerHTML = leads.map(l => {
      const empresa = l.empresa ? `<span class="mql-empresa">${escapeHtml(l.empresa)}</span>` : "";
      const email   = l.email   ? `<span class="mql-email">${escapeHtml(l.email)}</span>`     : "";
      return `<li><strong>${escapeHtml(l.nome || "—")}</strong>${empresa}${email}</li>`;
    }).join("");
  }
  modal.hidden = false;
  document.body.classList.add("modal-open");
}

document.getElementById("mqlModalClose").addEventListener("click", () => {
  document.getElementById("mqlModal").hidden = true;
  document.body.classList.remove("modal-open");
});
document.getElementById("mqlModal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.hidden = true;
    document.body.classList.remove("modal-open");
  }
});

document.getElementById("creativeModalClose").addEventListener("click", closeCreativeModal);

// Clique no fundo escuro fecha o modal
document.getElementById("creativeModal").addEventListener("click", (e) => {
  if (e.target.id === "creativeModal") closeCreativeModal();
});

// Esc fecha o modal
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("creativeModal").hidden) {
    closeCreativeModal();
  }
});

// Converte o preset do Live Meta em {start, end} para filtrar deals do Zoho pelo período.
function presetToDateRange(preset, since, until) {
  const now   = new Date();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

  if (preset === "custom" && since && until) {
    return { start: new Date(since + "T00:00:00"), end: new Date(until + "T23:59:59") };
  }
  if (preset === "today") {
    return { start: todayStart, end: todayEnd };
  }
  if (preset === "yesterday") {
    return {
      start: new Date(todayStart.getTime() - 86400000),
      end:   new Date(todayEnd.getTime()   - 86400000),
    };
  }
  if (preset === "last_7d") {
    return { start: new Date(todayStart.getTime() - 6 * 86400000), end: todayEnd };
  }
  if (preset === "last_14d") {
    return { start: new Date(todayStart.getTime() - 13 * 86400000), end: todayEnd };
  }
  if (preset === "last_30d") {
    return { start: new Date(todayStart.getTime() - 29 * 86400000), end: todayEnd };
  }
  if (preset === "last_90d") {
    return { start: new Date(todayStart.getTime() - 89 * 86400000), end: todayEnd };
  }
  if (preset === "this_month") {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0), end: todayEnd };
  }
  if (preset === "last_month") {
    return {
      start: new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0),
      end:   new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999),
    };
  }
  // fallback: últimos 30 dias
  return { start: new Date(todayStart.getTime() - 29 * 86400000), end: todayEnd };
}

function renderLiveMetaMetrics({ metaTotal, reunioes, assinaturas }) {
  const section = document.getElementById("liveMetaMetricsSection");
  if (!section) return;
  document.getElementById("liveMetaLeadsMeta").textContent     = fmtInt(metaTotal);
  document.getElementById("liveMetaReunioes").textContent      = fmtInt(reunioes);
  document.getElementById("liveMetaAssinaturas").textContent   = fmtInt(assinaturas);
  document.getElementById("liveMetaTaxaReuniao").textContent   = metaTotal > 0 ? fmtPct(reunioes / metaTotal * 100) : "—";
  document.getElementById("liveMetaTaxaAssinatura").textContent = reunioes > 0 ? fmtPct(assinaturas / reunioes * 100) : "—";
  section.style.display = "grid";
}

async function fetchLiveMeta() {
  const btn    = document.getElementById("liveMetaRefreshBtn");
  const status = document.getElementById("liveMetaStatus");
  btn.disabled = true;
  status.textContent = "Buscando Meta e Zoho...";
  status.className   = "process-status";

  try {
    const preset = document.getElementById("liveMetaPreset").value;
    const params = new URLSearchParams();

    if (preset === "custom") {
      const since = document.getElementById("liveMetaSince").value;
      const until = document.getElementById("liveMetaUntil").value;
      if (!since || !until) throw new Error("Selecione data início e fim.");
      params.set("since", since);
      params.set("until", until);
    } else {
      params.set("date_preset", preset);
    }

    status.textContent = "Buscando Meta Ads e Zoho CRM...";

    // Uma única chamada Zoho (deals) para todas as métricas.
    // computeReunioesReport() filtra por stage internamente.
    const [metaRes, zohoRes, dailyRes, mqlRes] = await Promise.all([
      fetch(`/api/meta/live?${params}`).then((r) => r.json()),
      fetch("/api/zoho/deals").then((r) => r.json()).catch(() => ({ ok: false })),
      fetch(`/api/meta/live/daily?${params}`).then((r) => r.json()).catch(() => ({ ok: false })),
      fetch("/api/slack/mql").then((r) => r.json()).catch(() => ({ ok: false, data: [] })),
    ]);

    if (!metaRes.ok) throw new Error(metaRes.error || "Erro desconhecido");

    if (zohoRes.ok && Array.isArray(zohoRes.data)) {
      const rows         = zohoApiToRows(zohoRes.data);
      state.zohoRows     = rows;
      state.zohoFiltered = rows;
      state.reunioesRows = rows;
    }

    // Filtra pelo período selecionado
    const dateRange = presetToDateRange(
      preset,
      document.getElementById("liveMetaSince").value,
      document.getElementById("liveMetaUntil").value,
    );

    const filterByPeriod = (rows) => rows.filter((d) => {
      if (!d.horaCriacao) return false;
      return d.horaCriacao >= dateRange.start && d.horaCriacao <= dateRange.end;
    });

    const reunioesForPeriod = filterByPeriod(state.reunioesRows);
    state.reunioesFiltered  = reunioesForPeriod;

    const zohoForPeriod = filterByPeriod(state.zohoRows);

    // Reuniões e assinaturas: relatório Zoho como fonte de verdade
    // Leads META: contagem de todos os deals com origem META no período (denominador para taxas)
    const { reunioes, assinaturas, discarded } = computeReunioesReport(reunioesForPeriod);
    const { metaTotal } = computeZohoMetaMetrics(zohoForPeriod);

    if (discarded.length > 0) {
      console.log(`[Live Meta] ${discarded.length} reuniões sem origem META:`, discarded.slice(0, 5));
    }

    // Armazena dados diários e período para o gráfico
    _lmDailyData    = (dailyRes.ok && Array.isArray(dailyRes.data)) ? dailyRes.data : [];
    _lmCurrentPeriod = { preset, since: document.getElementById("liveMetaSince").value, until: document.getElementById("liveMetaUntil").value };

    // MQL — carrega antes de renderLiveMeta para que getMqlForAd() tenha os dados
    if (mqlRes.ok && Array.isArray(mqlRes.data)) {
      const total    = mqlRes.data.length;
      const aulaRmkt = mqlRes.data.filter(l => { const f = (l.fonte || "").toLowerCase(); return f.includes("aula") || f.includes("rmkt"); }).length;
      const comCheck = mqlRes.data.filter(l => l.isMql).length;
      const comX     = mqlRes.data.filter(l => l.isNotMql).length;
      console.log(`[Slack MQL] ${total} msgs lidas | ${aulaRmkt} AULA/RMKT | ${comCheck} ✅ MQL | ${comX} ❌ não-MQL`);
      slackMqlState.leads = mqlRes.data;
    } else {
      console.warn("[Slack MQL] Não carregado:", mqlRes.error || "resposta inválida");
    }

    renderLiveMetaMetrics({ metaTotal, reunioes, assinaturas });
    renderLiveMeta(metaRes.data || []);
    renderLmDailyToggles();
    renderLmDailyChart();

    const now      = new Date().toLocaleString("pt-BR");
    const adCount  = (metaRes.data || []).length;
    document.getElementById("liveMetaLastUpdate").textContent = `Última atualização: ${now}`;
    status.textContent = `${adCount} anúncios · Leads META: ${metaTotal} · Reuniões: ${reunioes} · Assinaturas: ${assinaturas}.`;
    status.className   = "process-status success";
  } catch (err) {
    console.error(err);
    status.textContent = `Erro: ${err.message}`;
    status.className   = "process-status error";
    showToast(err.message, "error", 5000);
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("liveMetaRefreshBtn").addEventListener("click", fetchLiveMeta);

// Quando preset muda, preenche automaticamente as datas para referência visual
document.getElementById("liveMetaPreset").addEventListener("change", (e) => {
  const preset = e.target.value;
  if (preset !== "custom") {
    const { start, end } = presetToDateRange(preset, "", "");
    document.getElementById("liveMetaSince").value = _lmDateKey(start);
    document.getElementById("liveMetaUntil").value = _lmDateKey(end);
  }
});

// Aplicar filtro: re-filtra dados em memória e re-renderiza toda a aba Live Meta
function applyLmFilter() {
  const hasReunioesData = (state.reunioesRows || []).length > 0;
  const hasLmRows       = (_liveMetaRows || []).length > 0;
  if (!hasReunioesData && !hasLmRows) {
    showToast("Carregue os dados primeiro clicando em \"Atualizar Dados\".", "error");
    return;
  }

  const preset = document.getElementById("liveMetaPreset").value;
  const since  = document.getElementById("liveMetaSince").value;
  const until  = document.getElementById("liveMetaUntil").value;
  if (!since || !until) {
    showToast("Selecione Data início e Data fim.", "error");
    return;
  }

  const dateRange = presetToDateRange("custom", since, until);
  const filterByPeriod = (rows) => rows.filter((d) => {
    if (!d.horaCriacao) return false;
    return d.horaCriacao >= dateRange.start && d.horaCriacao <= dateRange.end;
  });

  // Re-filtra Zoho pelo período selecionado
  state.reunioesFiltered = filterByPeriod(state.reunioesRows);
  const zohoFiltered     = filterByPeriod(state.zohoRows);

  // Recalcula cards
  const { reunioes, assinaturas } = computeReunioesReport(state.reunioesFiltered);
  const { metaTotal }             = computeZohoMetaMetrics(zohoFiltered);
  renderLiveMetaMetrics({ metaTotal, reunioes, assinaturas });

  // Atualiza período do gráfico e re-renderiza
  _lmCurrentPeriod = { preset: "custom", since, until };
  renderLmDailyToggles();
  renderLmDailyChart();

  // Re-renderiza tabela com novos filtros Zoho + MQL
  renderLiveMeta(_liveMetaRows);
}

document.getElementById("lmApplyFilterBtn").addEventListener("click", applyLmFilter);
document.getElementById("liveMetaSince").addEventListener("change", () => {
  document.getElementById("liveMetaPreset").value = "custom";
});
document.getElementById("liveMetaUntil").addEventListener("change", () => {
  document.getElementById("liveMetaPreset").value = "custom";
});

// Pré-preenche as datas com o preset padrão ao carregar a página
(function initLmDates() {
  const { start, end } = presetToDateRange("last_30d", "", "");
  document.getElementById("liveMetaSince").value = _lmDateKey(start);
  document.getElementById("liveMetaUntil").value = _lmDateKey(end);
})();

/* ---------- Navegação por abas ---------- */
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.tab === target);
    });
    document.body.classList.toggle("tab-livemeta-active",  target === "livemeta");
    document.body.classList.toggle("tab-googleads-active", target === "googleads");
    document.body.classList.toggle("tab-overview-active",  target === "overview");
    document.body.classList.toggle("tab-table-active",    target === "table");
    document.body.classList.toggle("tab-rankings-active", target === "rankings");
    document.body.classList.toggle("tab-insights-active", target === "insights");
    document.body.classList.toggle("tab-fin-active",      target === "fin");
  });
});

// =============================================================================
// VISÃO GERAL — DASHBOARD EXECUTIVO
// =============================================================================

function ovDrawChart(canvasId, metaVal, googleVal, fmtFn) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  if (canvas._ovChart) { canvas._ovChart.destroy(); canvas._ovChart = null; }
  canvas._ovChart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels: ["Meta Ads", "Google Ads"],
      datasets: [{
        data: [metaVal, googleVal],
        backgroundColor: ["rgba(0,102,255,0.72)", "rgba(0,184,148,0.72)"],
        borderColor: ["#0066ff", "#00b894"],
        borderWidth: 2,
        borderRadius: 6,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => ` ${fmtFn(ctx.parsed.x)}` } },
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: "rgba(0,0,0,0.04)" },
          ticks: { callback: (v) => fmtFn(v), maxTicksLimit: 4 },
        },
        y: { grid: { display: false } },
      },
    },
  });
}

function renderOverview() {
  const metaLoaded = state.creatives.length > 0;
  const gLoaded    = gadsState.summary !== null;
  const anyLoaded  = metaLoaded || gLoaded;

  const ph  = document.getElementById("ovPlaceholder");
  const ex  = document.getElementById("ovExecSection");
  const cmp = document.getElementById("ovComparisonSection");
  const ch  = document.getElementById("ovChartsSection");
  const ins = document.getElementById("ovInsightsSection");

  if (!anyLoaded) {
    if (ph)  ph.hidden  = false;
    [ex, cmp, ch, ins].forEach(s => { if (s) s.hidden = true; });
    return;
  }
  if (ph)  ph.hidden  = true;
  [ex, cmp, ch, ins].forEach(s => { if (s) s.hidden = false; });

  // ── Meta Ads ────────────────────────────────────────────────────────────────
  const crv  = metaLoaded ? state.filtered : [];
  const mSum = (key) => crv.reduce((a, c) => a + (c[key] || 0), 0);
  const mInvest = mSum("valorGasto");
  const mImpr   = mSum("impressoes");
  const mClicks = mSum("cliques");
  const mLeads  = mSum("leadsMeta");
  let mMeet = 0, mSign = 0;
  if (state.reunioesFiltered.length > 0) {
    ({ reunioes: mMeet, assinaturas: mSign } = computeReunioesReport(state.reunioesFiltered));
  } else if (state.reunioesRows.length === 0) {
    // Sem arquivo reuniões carregado — usa stage-check via Zoho como fallback
    const zohoBase = state.zohoFiltered.length > 0 ? state.zohoFiltered : state.zohoRows;
    ({ reunioes: mMeet, assinaturas: mSign } = computeZohoMetaMetrics(zohoBase));
  }
  // reunioesRows existe mas filtro retornou 0 → mMeet/mSign ficam 0 (alinhado com renderCards)
  const mCtr    = mImpr   > 0 ? mClicks / mImpr   : 0;
  const mCpc    = mClicks > 0 ? mInvest / mClicks  : 0;
  const mCpl    = mMeet   > 0 ? mInvest / mMeet    : 0;
  const mCpa    = mSign   > 0 ? mInvest / mSign    : 0;
  const mConvLM = mLeads  > 0 ? mMeet  / mLeads   : 0;
  const mConvMS = mMeet   > 0 ? mSign  / mMeet    : 0;

  // ── Google Ads ───────────────────────────────────────────────────────────────
  const gInvest = gadsState.costBRL || 0;
  const gImpr   = gadsState.summary?.impressions || 0;
  const gClicks = gadsState.summary?.clicks || 0;
  const gLeads  = gadsState.summary?.conversions || 0;
  const gMeet   = gadsState.reunioes || 0;
  const gSign   = gadsState.assinaturas || 0;
  const gCtr    = gadsState.summary?.ctr || 0;
  const gCpc    = gadsState.summary?.cpc || 0;
  const gCpl    = gMeet > 0 ? gInvest / gMeet : 0;
  const gCpa    = gSign > 0 ? gInvest / gSign : 0;
  const gConvLM = gLeads > 0 ? gMeet / gLeads : 0;
  const gConvMS = gMeet  > 0 ? gSign / gMeet  : 0;

  // ── Totais ────────────────────────────────────────────────────────────────────
  const tInvest = mInvest + gInvest;
  const tImpr   = mImpr   + gImpr;
  const tClicks = mClicks + gClicks;
  const tLeads  = mLeads  + gLeads;
  const tMeet   = mMeet   + gMeet;
  const tSign   = mSign   + gSign;
  const tCtr    = tImpr   > 0 ? tClicks / tImpr   : 0;
  const tCpc    = tClicks > 0 ? tInvest / tClicks  : 0;
  const tCpl    = tMeet   > 0 ? tInvest / tMeet    : 0;
  const tCpa    = tSign   > 0 ? tInvest / tSign    : 0;
  const tConvLM = tLeads  > 0 ? tMeet  / tLeads   : 0;
  const tConvMS = tMeet   > 0 ? tSign  / tMeet    : 0;

  // ── Helpers ───────────────────────────────────────────────────────────────────
  const nvM = (v, fn)     => metaLoaded ? fn(v) : '<span class="ov-td-na">—</span>';
  const nvG = (v, fn)     => gLoaded    ? fn(v) : '<span class="ov-td-na">—</span>';
  const pct = (v)         => fmtPct(v * 100);
  const cur = (v)         => v > 0 ? fmtCurrency(v) : "—";

  // ── Cards executivos ──────────────────────────────────────────────────────────
  [
    ["ovInvestTotal",      fmtCurrency(tInvest)],
    ["ovLeadsTotal",       fmtInt(tLeads)],
    ["ovReunioesTotal",    fmtInt(tMeet)],
    ["ovAssinaturasTotal", fmtInt(tSign)],
    ["ovCpaTotal",         cur(tCpa)],
    ["ovConvTotal",        pct(tConvMS)],
  ].forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = val;
  });

  // ── Tabela comparativa ────────────────────────────────────────────────────────
  const rows = [
    ["Investimento",           nvM(mInvest, fmtCurrency), nvG(gInvest, fmtCurrency), fmtCurrency(tInvest)],
    ["Impressões",             nvM(mImpr,   fmtInt),      nvG(gImpr,   fmtInt),      fmtInt(tImpr)],
    ["Cliques",                nvM(mClicks, fmtInt),      nvG(gClicks, fmtInt),      fmtInt(tClicks)],
    ["CTR",                    nvM(mCtr,    pct),         nvG(gCtr,    pct),         pct(tCtr)],
    ["CPC Médio",              nvM(mCpc,    cur),         nvG(gCpc,    cur),         cur(tCpc)],
    ["Leads",                  nvM(mLeads,  fmtInt),      nvG(gLeads,  fmtInt),      fmtInt(tLeads)],
    ["Reuniões",               nvM(mMeet,   fmtInt),      nvG(gMeet,   fmtInt),      fmtInt(tMeet)],
    ["Assinaturas",            nvM(mSign,   fmtInt),      nvG(gSign,   fmtInt),      fmtInt(tSign)],
    ["Conv. Lead → Reunião",   nvM(mConvLM, pct),        nvG(gConvLM, pct),        pct(tConvLM)],
    ["Conv. Reunião → Assin.", nvM(mConvMS, pct),        nvG(gConvMS, pct),        pct(tConvMS)],
    ["Custo por Reunião",      nvM(mCpl,    cur),         nvG(gCpl,    cur),         cur(tCpl)],
    ["CPA (custo/assinatura)", nvM(mCpa,    cur),         nvG(gCpa,    cur),         cur(tCpa)],
  ];
  const tbody = document.getElementById("ovComparisonBody");
  if (tbody) {
    tbody.innerHTML = rows.map(([label, meta, google, total]) =>
      `<tr><td>${label}</td><td class="ov-td-meta">${meta}</td><td class="ov-td-google">${google}</td><td class="ov-td-total">${total}</td></tr>`
    ).join("");
  }

  // ── Gráficos ──────────────────────────────────────────────────────────────────
  ovDrawChart("ovChartInvest",      mInvest, gInvest, fmtCurrency);
  ovDrawChart("ovChartReunioes",    mMeet,   gMeet,   fmtInt);
  ovDrawChart("ovChartAssinaturas", mSign,   gSign,   fmtInt);
  ovDrawChart("ovChartCpl",         mCpl,    gCpl,    cur);
  ovDrawChart("ovChartCpa",         mCpa,    gCpa,    cur);
  ovDrawChart("ovChartConv",        mConvMS * 100, gConvMS * 100, (v) => v.toFixed(1) + "%");

  // ── Insights ──────────────────────────────────────────────────────────────────
  const li  = (txt)  => `<li class="ov-insight-item">${txt}</li>`;
  const val = (v)    => `<span class="ov-insight-value">${v}</span>`;
  const win = (v)    => `<span class="ov-insight-winner">${v}</span>`;

  // Meta insights
  const metaIns = [];
  if (metaLoaded && crv.length > 0) {
    const byCamp = {};
    crv.forEach(c => {
      if (!byCamp[c.campanha]) byCamp[c.campanha] = { reunioes: 0, assinaturas: 0, valorGasto: 0, leadsMeta: 0 };
      const b = byCamp[c.campanha];
      b.reunioes    += c.reunioes    || 0;
      b.assinaturas += c.assinaturas || 0;
      b.valorGasto  += c.valorGasto  || 0;
      b.leadsMeta   += c.leadsMeta   || 0;
    });
    const camps = Object.entries(byCamp).map(([name, v]) => ({ name, ...v }));
    const bestMeet = camps.filter(c => c.reunioes > 0).sort((a, b) => b.reunioes - a.reunioes)[0];
    if (bestMeet) metaIns.push(li(`Campanha com mais reuniões: ${val(bestMeet.name)} (${val(fmtInt(bestMeet.reunioes))})`));
    const bestCpl = camps.filter(c => c.reunioes > 0 && c.valorGasto > 0)
      .sort((a, b) => (a.valorGasto / a.reunioes) - (b.valorGasto / b.reunioes))[0];
    if (bestCpl) metaIns.push(li(`Menor C/Reunião por campanha: ${val(bestCpl.name)} — ${val(fmtCurrency(bestCpl.valorGasto / bestCpl.reunioes))}`));
    const bestCpa = camps.filter(c => c.assinaturas > 0 && c.valorGasto > 0)
      .sort((a, b) => (a.valorGasto / a.assinaturas) - (b.valorGasto / b.assinaturas))[0];
    if (bestCpa) metaIns.push(li(`Melhor CPA por campanha: ${val(bestCpa.name)} — ${val(fmtCurrency(bestCpa.valorGasto / bestCpa.assinaturas))}`));
    if (mCpl > 0) metaIns.push(li(`Custo/Reunião médio Meta: ${val(fmtCurrency(mCpl))}`));
    if (mCpa > 0) metaIns.push(li(`CPA médio Meta: ${val(fmtCurrency(mCpa))}`));
    if (mMeet > 0) metaIns.push(li(`Taxa Conv. Reunião→Assin. Meta: ${val(pct(mConvMS))}`));
  } else {
    metaIns.push(li("Carregue o relatório Meta Ads para ver os insights."));
  }

  // Google insights
  const googleIns = [];
  if (gLoaded) {
    const bestGCamp = (gadsState.campaigns || [])
      .filter(c => c.costBRL > 0)
      .sort((a, b) => b.costBRL - a.costBRL)[0];
    if (bestGCamp) googleIns.push(li(`Campanha com maior investimento: ${val(bestGCamp.name)} — ${val(fmtCurrency(bestGCamp.costBRL))}`));
    const bestGCtr = (gadsState.campaigns || [])
      .filter(c => c.ctr > 0)
      .sort((a, b) => b.ctr - a.ctr)[0];
    if (bestGCtr) googleIns.push(li(`Maior CTR por campanha: ${val(bestGCtr.name)} — ${val(fmtGadsCtr(bestGCtr.ctr))}`));
    if (gCpl > 0) googleIns.push(li(`Custo/Reunião Google Ads: ${val(fmtCurrency(gCpl))}`));
    if (gCpa > 0) googleIns.push(li(`CPA Google Ads (custo/assinatura): ${val(fmtCurrency(gCpa))}`));
    const bestKw = (gadsState.keywords || []).find(k => k.clicks > 0);
    if (bestKw) googleIns.push(li(`Top palavra-chave: ${val(bestKw.keyword)} — ${val(fmtInt(bestKw.clicks))} cliques`));
    const bestSt = (gadsState.searchTerms || []).find(t => t.clicks > 0);
    if (bestSt) googleIns.push(li(`Top termo de pesquisa: ${val(bestSt.searchTerm)} — ${val(fmtInt(bestSt.clicks))} cliques`));
    if (gMeet > 0) googleIns.push(li(`Taxa Conv. Reunião→Assin. Google: ${val(pct(gConvMS))}`));
  } else {
    googleIns.push(li("Atualize a aba Google Ads para ver os insights."));
  }

  // Insights consolidados
  const totIns = [];
  if (metaLoaded && gLoaded) {
    if (mCpl > 0 || gCpl > 0) {
      const betterCpl = (mCpl > 0 && gCpl > 0) ? (mCpl <= gCpl ? "Meta" : "Google") : (mCpl > 0 ? "Meta" : "Google");
      const betterCplVal = betterCpl === "Meta" ? mCpl : gCpl;
      totIns.push(li(`Canal com menor Custo/Reunião: ${win(betterCpl)} (${val(fmtCurrency(betterCplVal))})`));
    }
    if (mCpa > 0 || gCpa > 0) {
      const betterCpa = (mCpa > 0 && gCpa > 0) ? (mCpa <= gCpa ? "Meta" : "Google") : (mCpa > 0 ? "Meta" : "Google");
      const betterCpaVal = betterCpa === "Meta" ? mCpa : gCpa;
      totIns.push(li(`Canal com melhor CPA: ${win(betterCpa)} (${val(fmtCurrency(betterCpaVal))})`));
    }
    totIns.push(li(`Canal com mais reuniões: ${win(mMeet >= gMeet ? "Meta" : "Google")} (Meta: ${fmtInt(mMeet)}, Google: ${fmtInt(gMeet)})`));
    if (tSign > 0)
      totIns.push(li(`Canal com mais assinaturas: ${win(mSign >= gSign ? "Meta" : "Google")} (Meta: ${fmtInt(mSign)}, Google: ${fmtInt(gSign)})`));
    if (tMeet > 0) {
      const betterConv = mConvMS >= gConvMS ? "Meta" : "Google";
      totIns.push(li(`Maior taxa de conversão: ${win(betterConv)} (Meta: ${pct(mConvMS)}, Google: ${pct(gConvMS)})`));
    }
    totIns.push(li(`Investimento consolidado total: ${val(fmtCurrency(tInvest))}`));
    totIns.push(li(`Reuniões totais: ${val(fmtInt(tMeet))} · Assinaturas totais: ${val(fmtInt(tSign))}`));
  } else if (metaLoaded) {
    totIns.push(li("Atualize a aba Google Ads para ver o comparativo consolidado."));
    totIns.push(li(`Meta: ${val(fmtInt(mMeet))} reuniões · ${val(fmtInt(mSign))} assinaturas`));
  } else {
    totIns.push(li("Carregue o relatório Meta Ads para ver o comparativo consolidado."));
    totIns.push(li(`Google: ${val(fmtInt(gMeet))} reuniões · ${val(fmtInt(gSign))} assinaturas`));
  }

  document.getElementById("ovInsightsMeta").innerHTML   = metaIns.join("");
  document.getElementById("ovInsightsGoogle").innerHTML = googleIns.join("");
  document.getElementById("ovInsightsTotal").innerHTML  = totIns.join("");
}

// =============================================================================
// GOOGLE ADS TAB
// Fonte de verdade: Zoho CRM (leads com Origem = googleads) + Google Ads API (gasto)
// =============================================================================

const gadsState = {
  reunioes:    0,
  assinaturas: 0,
  costBRL:     0,
  summary:     null,
  campaigns:   [],
  keywords:    [],
  searchTerms: [],
  leads:       [],
  sortKey:     "costBRL",
  sortDir:     -1,
};

function fmtGadsCtr(n) { return isFinite(n) && n > 0 ? fmtPct(n * 100) : "0,00%"; }
function fmtGadsCpc(n) { return isFinite(n) && n > 0 ? fmtCurrency(n) : "—"; }
function fmtGadsCpa(n) { return isFinite(n) && n > 0 ? fmtCurrency(n) : "—"; }

function renderGadsSummary() {
  const { reunioes, assinaturas, costBRL } = gadsState;
  const conv = reunioes > 0 ? assinaturas / reunioes : 0;
  const cpl  = reunioes > 0 ? costBRL / reunioes : 0;
  const cpa  = assinaturas > 0 ? costBRL / assinaturas : 0;
  const cards = [
    { label: "Reuniões Geradas",                 value: fmtInt(reunioes) },
    { label: "Assinaturas Geradas",              value: fmtInt(assinaturas) },
    { label: "Conversão (Reunião → Assinatura)", value: fmtPct(conv) },
    { label: "Custo por Reunião",                 value: cpl > 0 ? fmtCurrency(cpl) : "—" },
    { label: "CPA (Custo por Assinatura)",       value: cpa > 0 ? fmtCurrency(cpa) : "—" },
  ];
  const grid = document.getElementById("gadsSummary");
  if (!grid) return;
  grid.innerHTML = cards
    .map(c => `<div class="metric-card metric-card--highlight"><span class="metric-label">${c.label}</span><span class="metric-value">${c.value}</span></div>`)
    .join("");
  grid.style.display = "grid";
}

function renderGadsOverview() {
  const { reunioes, assinaturas, costBRL } = gadsState;
  const conv = reunioes > 0 ? assinaturas / reunioes : 0;
  const cpl  = reunioes > 0 ? costBRL / reunioes : 0;
  const cpa  = assinaturas > 0 ? costBRL / assinaturas : 0;
  const section = document.getElementById("gadsOverviewSection");
  const grid    = document.getElementById("gadsOverviewCards");
  if (!section || !grid) return;
  const items = [
    { label: "Reuniões Google Ads",    value: fmtInt(reunioes) },
    { label: "Assinaturas Google Ads", value: fmtInt(assinaturas) },
    { label: "Conversão Google Ads",   value: fmtPct(conv) },
    { label: "Custo/Reunião Google Ads", value: cpl > 0 ? fmtCurrency(cpl) : "—" },
    { label: "CPA Google Ads",         value: cpa > 0 ? fmtCurrency(cpa) : "—" },
  ];
  grid.innerHTML = items
    .map(i => `<div class="metric-card"><span class="metric-label">${i.label}</span><span class="metric-value">${i.value}</span></div>`)
    .join("");
  section.hidden = false;
}

function renderGadsApiSummary() {
  const s = gadsState.summary;
  if (!s) return;
  const cards = [
    { label: "Investimento",        value: fmtCurrency(s.costBRL || 0) },
    { label: "Impressões",          value: fmtInt(s.impressions || 0) },
    { label: "Cliques",             value: fmtInt(s.clicks || 0) },
    { label: "CTR",                 value: fmtGadsCtr(s.ctr) },
    { label: "CPC Médio",           value: fmtGadsCpc(s.cpc) },
    { label: "Conversões",          value: s.conversions > 0 ? s.conversions.toFixed(1) : "0" },
    { label: "Custo por Conversão", value: fmtGadsCpa(s.cpa) },
  ];
  const grid = document.getElementById("gadsApiSummary");
  if (!grid) return;
  grid.innerHTML = cards
    .map(c => `<div class="metric-card"><span class="metric-label">${c.label}</span><span class="metric-value">${c.value}</span></div>`)
    .join("");
  grid.style.display = "grid";
}

function renderGadsCampaigns() {
  const search = (document.getElementById("gadsCampaignSearch")?.value || "").toLowerCase();
  let data = gadsState.campaigns.filter(c =>
    !search || c.name.toLowerCase().includes(search)
  );
  data = [...data].sort((a, b) => {
    const av = a[gadsState.sortKey] ?? 0;
    const bv = b[gadsState.sortKey] ?? 0;
    return typeof av === "string"
      ? av.localeCompare(bv) * gadsState.sortDir
      : (av - bv) * gadsState.sortDir;
  });
  const tbody = document.getElementById("gadsCampaignsBody");
  if (!tbody) return;
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="livemeta-empty">Nenhuma campanha encontrada.</td></tr>`;
  } else {
    tbody.innerHTML = data.map(c => `
      <tr>
        <td>${c.name}</td>
        <td class="col-num">${fmtCurrency(c.costBRL)}</td>
        <td class="col-num">${fmtInt(c.impressions)}</td>
        <td class="col-num">${fmtInt(c.clicks)}</td>
        <td class="col-num">${fmtGadsCtr(c.ctr)}</td>
        <td class="col-num">${fmtGadsCpc(c.cpc)}</td>
        <td class="col-num">${c.conversions > 0 ? c.conversions.toFixed(1) : "0"}</td>
        <td class="col-num">${fmtGadsCpa(c.cpa)}</td>
      </tr>
    `).join("");
  }
  document.querySelectorAll("#gadsCampaignsTable .gads-sortable").forEach(th => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.key === gadsState.sortKey) {
      th.classList.add(gadsState.sortDir === 1 ? "sort-asc" : "sort-desc");
    }
  });
}

function renderGadsKeywords() {
  const kw    = (gadsState.keywords || []).slice(0, 10);
  const tbody = document.getElementById("gadsKeywordsBody");
  if (!tbody) return;
  if (!kw.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="livemeta-empty">Sem dados de keywords para este período.</td></tr>`;
    return;
  }
  tbody.innerHTML = kw.map(k => `
    <tr>
      <td>${k.keyword}</td>
      <td class="col-num">${fmtInt(k.impressions)}</td>
      <td class="col-num">${fmtInt(k.clicks)}</td>
      <td class="col-num">${fmtGadsCtr(k.ctr)}</td>
      <td class="col-num">${fmtGadsCpc(k.cpc)}</td>
      <td class="col-num">${k.conversions > 0 ? k.conversions.toFixed(1) : "0"}</td>
    </tr>
  `).join("");
}

function renderGadsSearchTerms() {
  const st    = (gadsState.searchTerms || []).slice(0, 10);
  const tbody = document.getElementById("gadsSearchTermsBody");
  if (!tbody) return;
  if (!st.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="livemeta-empty">Sem dados de termos para este período.</td></tr>`;
    return;
  }
  tbody.innerHTML = st.map(t => `
    <tr>
      <td>${t.searchTerm}</td>
      <td class="col-num">${fmtInt(t.impressions)}</td>
      <td class="col-num">${fmtInt(t.clicks)}</td>
      <td class="col-num">${fmtGadsCtr(t.ctr)}</td>
      <td class="col-num">${t.conversions > 0 ? t.conversions.toFixed(1) : "0"}</td>
    </tr>
  `).join("");
}

function gadsLeadStageBadge(stage) {
  const s = (stage || "").toLowerCase();
  let bg = "rgba(120,120,120,0.12)", color = "var(--text-muted)";
  if (s.includes("assinatura"))                         { bg = "rgba(31,174,120,0.15)";  color = "var(--green)"; }
  else if (s.includes("reuniao realizada") || s.includes("reunião realizada")) { bg = "rgba(0,184,217,0.15)"; color = "#00b8d9"; }
  else if (s.includes("reuniao agendada")  || s.includes("reunião agendada"))  { bg = "rgba(255,171,0,0.15)"; color = "#e6a817"; }
  else if (s.includes("negociacao")        || s.includes("negociação"))        { bg = "rgba(255,128,0,0.15)"; color = "#e07030"; }
  else if (s.includes("proposta"))                      { bg = "rgba(108,92,231,0.15)"; color = "var(--accent)"; }
  else if (s.includes("mql"))                           { bg = "rgba(66,133,244,0.15)"; color = "#4285f4"; }
  else if (s.includes("perdido") || s.includes("cancelado") || s.includes("fechado")) { bg = "rgba(220,60,60,0.15)"; color = "#dc3c3c"; }
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:600;background:${bg};color:${color};white-space:nowrap">${stage || "—"}</span>`;
}

function renderGadsLeadsTable(filter) {
  const section = document.getElementById("gadsLeadsSection");
  const tbody   = document.getElementById("gadsLeadsBody");
  const empty   = document.getElementById("gadsLeadsEmpty");
  const counter = document.getElementById("gadsLeadsCount");
  if (!section || !tbody) return;

  const leads = gadsState.leads || [];
  const q     = (filter || "").toLowerCase().trim();
  const shown = q
    ? leads.filter(l =>
        (l.nomeContato  || "").toLowerCase().includes(q) ||
        (l.nomeNegocio  || "").toLowerCase().includes(q) ||
        (l.stage        || "").toLowerCase().includes(q) ||
        (l.origem       || "").toLowerCase().includes(q)
      )
    : leads;

  if (!shown.length) {
    tbody.innerHTML = "";
    empty.style.display   = "";
    section.style.display = "";
    counter.textContent   = "";
    return;
  }

  empty.style.display   = "none";
  section.style.display = "";
  counter.textContent   = `${shown.length} lead${shown.length !== 1 ? "s" : ""}`;

  tbody.innerHTML = shown.map((l, i) => {
    const dt = l.horaCriacao
      ? l.horaCriacao.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" })
      : "—";
    const rowBg = i % 2 === 0 ? "" : "background:var(--bg)";
    return `
      <tr style="${rowBg};border-bottom:1px solid var(--border)">
        <td style="padding:9px 10px;color:var(--text)">${l.nomeContato || "—"}</td>
        <td style="padding:9px 10px;color:var(--text-secondary)">${l.nomeNegocio || "—"}</td>
        <td style="padding:9px 10px">${gadsLeadStageBadge(l.stage)}</td>
        <td style="padding:9px 10px;color:var(--text-secondary);font-size:.79rem">${l.origem || "—"}</td>
        <td style="padding:9px 10px;text-align:right;color:var(--text-muted);white-space:nowrap">${dt}</td>
      </tr>`;
  }).join("");
}

async function fetchGoogleAds() {
  const btn    = document.getElementById("gadsRefreshBtn");
  const status = document.getElementById("gadsStatus");
  const preset = document.getElementById("gadsPreset")?.value || "last_30d";
  const since  = document.getElementById("gadsSince")?.value;
  const until  = document.getElementById("gadsUntil")?.value;

  btn.disabled    = true;
  btn.textContent = "Carregando…";
  status.textContent = "Buscando dados…";
  status.className   = "process-status";

  try {
    const apiParams = new URLSearchParams(
      preset === "custom" && since && until ? { since, until } : { date_preset: preset }
    ).toString();

    const [gadsRes, accRes, camRes, kwRes, stRes] = await Promise.all([
      fetch("/api/zoho/gads-deals").then(r => r.json()),
      fetch(`/api/google-ads/account?${apiParams}`).then(r => r.json()).catch(() => ({ ok: false })),
      fetch(`/api/google-ads/campaigns?${apiParams}`).then(r => r.json()).catch(() => ({ ok: false, data: [] })),
      fetch(`/api/google-ads/keywords?${apiParams}`).then(r => r.json()).catch(() => ({ ok: false, data: [] })),
      fetch(`/api/google-ads/search-terms?${apiParams}`).then(r => r.json()).catch(() => ({ ok: false, data: [] })),
    ]);

    if (!gadsRes.ok) throw new Error(gadsRes.error || "Erro ao buscar leads Zoho Google Ads");

    // ── Zoho: reuniões e assinaturas ─────────────────────────────────────────
    const { start, end } = presetToDateRange(preset, since, until);
    const rows = (gadsRes.data || []).map(r => ({
      id:          r.id || "",
      nomeNegocio: r.dealName || "",
      nomeContato: r.contactName || "",
      origem:      r.leadSource || "",
      stage:       r.stage || "",
      horaCriacao: r.createdTime ? new Date(r.createdTime) : null,
    }));
    const periodRows = rows.filter(r => {
      if (!r.horaCriacao) return false;
      return r.horaCriacao >= start && r.horaCriacao <= end;
    });
    const { reunioes, assinaturas } = computeGoogleAdsReport(periodRows);
    const costBRL = accRes.ok ? (accRes.data?.costBRL ?? 0) : 0;

    // ── Google Ads API ────────────────────────────────────────────────────────
    gadsState.reunioes    = reunioes;
    gadsState.assinaturas = assinaturas;
    gadsState.costBRL     = costBRL;
    gadsState.summary     = accRes.ok ? accRes.data : null;
    gadsState.campaigns   = camRes.ok ? (camRes.data || []) : [];
    gadsState.keywords    = kwRes.ok  ? (kwRes.data  || []) : [];
    gadsState.searchTerms = stRes.ok  ? (stRes.data  || []) : [];
    gadsState.leads       = periodRows.slice().sort((a, b) => {
      const ta = a.horaCriacao ? a.horaCriacao.getTime() : 0;
      const tb = b.horaCriacao ? b.horaCriacao.getTime() : 0;
      return tb - ta;
    });

    renderGadsSummary();
    renderOverview();
    renderGadsApiSummary();
    renderGadsCampaigns();
    renderGadsKeywords();
    renderGadsSearchTerms();
    renderGadsLeadsTable();

    if (gadsState.summary) document.getElementById("gadsApiSummary").style.display = "grid";
    if (gadsState.campaigns.length) document.getElementById("gadsCampaignsSection").style.display = "";
    if (gadsState.keywords.length || gadsState.searchTerms.length) {
      document.getElementById("gadsInsightsSection").style.display = "";
    }

    const now = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    document.getElementById("gadsLastUpdate").textContent = `Atualizado em ${now}`;
    const convPct = reunioes > 0 ? ((assinaturas / reunioes) * 100).toFixed(1) : "0";
    status.textContent = `${reunioes} reuniões · ${assinaturas} assinaturas · ${convPct}% conv. · ${gadsState.campaigns.length} campanhas`;
    status.className   = "process-status success";
  } catch (err) {
    status.textContent = `Erro: ${err.message}`;
    status.className   = "process-status error";
    console.error("[Google Ads]", err);
  } finally {
    btn.disabled    = false;
    btn.textContent = "Atualizar Dados";
  }
}

// ── Event listeners Google Ads ────────────────────────────────────────────────

document.getElementById("gadsRefreshBtn").addEventListener("click", fetchGoogleAds);

document.getElementById("gadsPreset").addEventListener("change", (e) => {
  document.getElementById("gadsCustomDates").style.display =
    e.target.value === "custom" ? "flex" : "none";
});

document.getElementById("gadsCampaignSearch").addEventListener("input", renderGadsCampaigns);

document.getElementById("gadsLeadsSearch").addEventListener("input", (e) => {
  renderGadsLeadsTable(e.target.value);
});

document.querySelectorAll("#gadsCampaignsTable .gads-sortable").forEach(th => {
  th.addEventListener("click", () => {
    const key = th.dataset.key;
    if (gadsState.sortKey === key) {
      gadsState.sortDir *= -1;
    } else {
      gadsState.sortKey = key;
      gadsState.sortDir = key === "name" ? 1 : -1;
    }
    renderGadsCampaigns();
  });
});

// =============================================================================
// KEYWORD PLANNER — Geração de ideias com máximo de cliques
// =============================================================================

let _kwResults = [];

const COMP_LABEL = { LOW: "Baixa", MEDIUM: "Média", HIGH: "Alta", UNSPECIFIED: "—" };
const COMP_COLOR = { LOW: "#2ecc8f", MEDIUM: "#f5b942", HIGH: "#ff6b6b", UNSPECIFIED: "#9aa4b8" };

function renderKwResults(data) {
  const tbody   = document.getElementById("kwResultsBody");
  const wrap    = document.getElementById("kwResultsWrap");
  const count   = document.getElementById("kwResultCount");
  const exportBtn = document.getElementById("kwExportBtn");

  if (!data || data.length === 0) {
    wrap.style.display = "none";
    return;
  }

  _kwResults = data;
  count.textContent = `${data.length} palavras-chave encontradas — ordenadas por potencial de cliques`;
  exportBtn.disabled = false;
  wrap.style.display = "";

  const maxScore = data[0]?.score || 1;
  tbody.innerHTML = data.map((k, i) => {
    const barW  = maxScore > 0 ? Math.round(k.score / maxScore * 60) : 0;
    const cComp = COMP_COLOR[k.competition] || "#9aa4b8";
    const lComp = COMP_LABEL[k.competition] || "—";
    return `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:6px 10px;color:var(--text-muted);font-size:.75rem">${i + 1}</td>
      <td style="padding:6px 10px;font-weight:500">${escapeHtml(k.keyword)}</td>
      <td style="padding:6px 10px;text-align:right">${k.volume.toLocaleString("pt-BR")}</td>
      <td style="padding:6px 10px;text-align:center">
        <span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:.75rem;background:${cComp}22;color:${cComp};font-weight:600">${lComp}</span>
      </td>
      <td style="padding:6px 10px;text-align:right">${k.lowCpc > 0 ? "R$ " + k.lowCpc.toFixed(2) : "—"}</td>
      <td style="padding:6px 10px;text-align:right">${k.hiCpc  > 0 ? "R$ " + k.hiCpc.toFixed(2)  : "—"}</td>
      <td style="padding:6px 10px;text-align:right">
        <div style="display:flex;align-items:center;gap:6px;justify-content:flex-end">
          <div style="width:${barW}px;height:6px;background:#6c5ce7;border-radius:3px;min-width:2px"></div>
          <span style="font-weight:600;color:#6c5ce7">${k.score.toLocaleString("pt-BR")}</span>
        </div>
      </td>
    </tr>`;
  }).join("");
}

async function generateKeywordIdeas() {
  const btn    = document.getElementById("kwGenerateBtn");
  const status = document.getElementById("kwPlannerStatus");

  const raw = (document.getElementById("kwSeeds").value || "").trim();
  if (!raw) { showToast("Digite ao menos uma palavra-chave semente.", "error"); return; }

  const seeds     = raw.split("\n").map(s => s.trim()).filter(Boolean);
  const minVolume = parseInt(document.getElementById("kwMinVolume").value || "0", 10);
  const network   = document.getElementById("kwNetwork").value;

  btn.disabled       = true;
  status.textContent = "Buscando ideias...";
  status.className   = "process-status";

  try {
    const res = await fetch("/api/google-ads/keyword-ideas", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ seeds, minVolume, network }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "Erro desconhecido");

    renderKwResults(json.data || []);
    status.textContent = `${json.count} palavras-chave — Score = vol/CPC (maior = mais cliques por real)`;
    status.className   = "process-status success";
  } catch (err) {
    status.textContent = `Erro: ${err.message}`;
    status.className   = "process-status error";
    showToast(err.message, "error", 6000);
  } finally {
    btn.disabled = false;
  }
}

function exportKwCsv() {
  if (!_kwResults.length) return;
  const header = ["#", "Palavra-chave", "Volume/mês", "Concorrência", "Índice", "CPC mín (R$)", "CPC máx (R$)", "Score cliques"];
  const rows   = _kwResults.map((k, i) => [
    i + 1,
    `"${k.keyword.replace(/"/g, '""')}"`,
    k.volume,
    COMP_LABEL[k.competition] || k.competition,
    k.compIndex,
    k.lowCpc.toFixed(2),
    k.hiCpc.toFixed(2),
    k.score,
  ]);
  const csv  = [header, ...rows].map(r => r.join(",")).join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), { href: url, download: "keyword-ideas.csv" });
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById("kwGenerateBtn").addEventListener("click", generateKeywordIdeas);
document.getElementById("kwExportBtn").addEventListener("click", exportKwCsv);

// =============================================================================
// INSIGHTS IA — Análise automática dos criativos da Live Meta
// =============================================================================

// ─── Taxonomy maps ────────────────────────────────────────────────────────────
const IA_TOPIC_MAP = [
  { id:"vendas",         label:"Treinamento de Vendas",      kw:["vendas","venda","vendedor","sales","time comercial","treinamento comercial"] },
  { id:"gestao",         label:"Gestão Comercial",           kw:["gestao comercial","gestão comercial","gestor","gerente comercial","diretor comercial"] },
  { id:"universidade",   label:"Universidade Corporativa",   kw:["universidade","academy","academia"] },
  { id:"ia",             label:"IA para Vendas",             kw:["ia para","ia em","inteligencia artificial","chatgpt","automac"] },
  { id:"produtividade",  label:"Produtividade",              kw:["produtividade","rotina comercial","eficiencia","performance"] },
  { id:"prospeccao",     label:"Prospecção / SDR",           kw:["prospeccao","prospecção","sdr","bdr","outbound","cold call"] },
  { id:"pipeline",       label:"Pipeline",                   kw:["pipeline","previsibilidade","forecast"] },
  { id:"lideranca",      label:"Liderança",                  kw:["lideranca","liderança","lider","líder"] },
  { id:"playbook",       label:"Playbook / Processo",        kw:["playbook","metodologia","processo de vendas"] },
];

const IA_OFFER_MAP = [
  { id:"aula",           label:"Aula Gratuita",         kw:["aula gratuita","aula gratis","aula grátis","aula online gratis"] },
  { id:"curso",          label:"Curso Gratuito",         kw:["curso gratuito","curso gratis","curso grátis","minicurso","mini curso"] },
  { id:"diagnostico",    label:"Diagnóstico",            kw:["diagnostico","diagnóstico","assessment"] },
  { id:"especializacao", label:"Especialização",         kw:["especializacao","especialização"] },
  { id:"universidade",   label:"Universidade Corp.",     kw:["universidade"] },
  { id:"webinar",        label:"Webinar / Live",         kw:["webinar","webinário","ao vivo"] },
  { id:"ebook",          label:"Material Gratuito",      kw:["ebook","e-book","guia","planilha"] },
  { id:"comunidade",     label:"Comunidade",             kw:["comunidade","grupo"] },
];

const IA_CREATIVE_PATTERN_MAP = [
  { id:"gustavo",   label:"Com Gustavo Pagoto",     kw:["gustavo","pagoto","gp"] },
  { id:"numeros",   label:"Com Números / Dados",    kw:["empresas","lideres","times","horas","dias","percent","porcento"] },
  { id:"gratuito",  label:"Oferta Gratuita",        kw:["gratis","gratuito","gratuita","grátis","free","0800"] },
  { id:"prova",     label:"Prova Social",           kw:["depoimento","testemunho","testimonial","resultado","cliente","cases","case"] },
  { id:"video",     label:"Vídeo",                  kw:["video","vid","vídeo","talking","reels","reel"] },
  { id:"mockup",    label:"Mockup / Plataforma",    kw:["mockup","plataforma","tela","screenshot","print","interface"] },
  { id:"urgencia",  label:"Urgência / Escassez",    kw:["vagas","limited","limitado","ultimas","ultimo","urgencia","urgente"] },
  { id:"dor",       label:"Foco na Dor",            kw:["problema","dor","desafio","dificuldade","erro","falha","perde"] },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function iaNorm(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function iaMatchesKw(text, kws) {
  const n = iaNorm(text);
  return kws.some(k => n.includes(iaNorm(k)));
}

// Group data items by a map, aggregating metrics. An item can match multiple groups.
function iaGroupByMap(items, map, textFn) {
  const stats = {};
  for (const m of map) {
    stats[m.id] = { id: m.id, label: m.label, count: 0, spend: 0, impressions: 0, clicks: 0, leads: 0, reunioes: 0, assinaturas: 0 };
  }
  const OTHER_ID = "_outros";
  stats[OTHER_ID] = { id: OTHER_ID, label: "Outros", count: 0, spend: 0, impressions: 0, clicks: 0, leads: 0, reunioes: 0, assinaturas: 0 };

  for (const d of items) {
    const text    = textFn(d);
    let matched   = false;
    for (const m of map) {
      if (iaMatchesKw(text, m.kw)) {
        const s = stats[m.id];
        s.count++; s.spend += d.spend || 0; s.impressions += d.impressions || 0;
        s.clicks += d.clicks || 0; s.leads += d.leads || 0;
        s.reunioes += d.reunioes || 0; s.assinaturas += d.assinaturas || 0;
        matched = true;
      }
    }
    if (!matched) {
      const s = stats[OTHER_ID];
      s.count++; s.spend += d.spend || 0; s.impressions += d.impressions || 0;
      s.clicks += d.clicks || 0; s.leads += d.leads || 0;
      s.reunioes += d.reunioes || 0; s.assinaturas += d.assinaturas || 0;
    }
  }
  return Object.values(stats)
    .filter(s => s.count > 0)
    .sort((a,b) => (b.reunioes * 3 + b.assinaturas * 5 + b.leads) - (a.reunioes * 3 + a.assinaturas * 5 + a.leads));
}

// ─── Topics ───────────────────────────────────────────────────────────────────
function iaRenderIntelTopics(data) {
  const el = document.getElementById("iaTopics");
  if (!el) return;
  if (!data.length) { el.innerHTML = `<p class="ia-empty-note">Carregue dados via API para analisar assuntos.</p>`; return; }

  const topicStats = iaGroupByMap(data, IA_TOPIC_MAP, d => `${d.adName} ${d.campaign} ${d.adset}`);
  if (!topicStats.length) { el.innerHTML = `<p class="ia-empty-note">Nenhum assunto detectado nos nomes dos criativos.</p>`; return; }

  const maxScore = Math.max(...topicStats.map(t => t.reunioes * 3 + t.assinaturas * 5 + t.leads), 1);
  el.innerHTML = `
    <div class="ia-intel-table-wrap">
      <table class="ia-intel-table">
        <thead><tr>
          <th>Assunto</th><th class="ia-th-r">Criativos</th><th class="ia-th-r">Investido</th>
          <th class="ia-th-r">Cliques</th><th class="ia-th-r">Leads</th>
          <th class="ia-th-r">Reuniões</th><th class="ia-th-r">Assinaturas</th>
          <th class="ia-th-r">CPR</th><th>Potencial</th>
        </tr></thead>
        <tbody>${topicStats.map((t, i) => {
          const cpr   = t.reunioes > 0 ? fmtCurrency(t.spend / t.reunioes) : "—";
          const score = t.reunioes * 3 + t.assinaturas * 5 + t.leads;
          const pct   = Math.round(score / maxScore * 100);
          return `<tr class="${i === 0 ? "ia-tr-winner" : ""}">
            <td class="ia-td-label">${i === 0 ? "🏆 " : ""}${t.label}</td>
            <td class="ia-td-r">${t.count}</td>
            <td class="ia-td-r">${fmtCurrency(t.spend)}</td>
            <td class="ia-td-r">${fmtInt(t.clicks)}</td>
            <td class="ia-td-r">${t.leads}</td>
            <td class="ia-td-r ia-bold">${t.reunioes}</td>
            <td class="ia-td-r ia-bold">${t.assinaturas}</td>
            <td class="ia-td-r">${cpr}</td>
            <td><div class="ia-score-bar"><div class="ia-score-fill" style="width:${pct}%"></div></div></td>
          </tr>`;
        }).join("")}</tbody>
      </table>
    </div>
    <p class="ia-intel-note">Potencial = reuniões ×3 + assinaturas ×5 + leads. Criativos podem se enquadrar em mais de um assunto.</p>`;
}

// ─── Offers ───────────────────────────────────────────────────────────────────
function iaRenderIntelOffers(data) {
  const el = document.getElementById("iaOffers");
  if (!el) return;
  if (!data.length) { el.innerHTML = `<p class="ia-empty-note">Carregue dados via API para analisar ofertas.</p>`; return; }

  const offerStats = iaGroupByMap(data, IA_OFFER_MAP, d => `${d.adName} ${d.campaign}`);
  if (!offerStats.length) { el.innerHTML = `<p class="ia-empty-note">Nenhuma oferta detectada nos nomes dos criativos.</p>`; return; }

  el.innerHTML = `<div class="ia-offers-grid">${offerStats.map((o, i) => {
    const ctr    = o.impressions > 0 ? (o.clicks / o.impressions * 100).toFixed(1) : 0;
    const cpc    = o.clicks  > 0 ? o.spend / o.clicks   : 0;
    const cpr    = o.reunioes    > 0 ? o.spend / o.reunioes    : 0;
    const cpa    = o.assinaturas > 0 ? o.spend / o.assinaturas : 0;
    const taxaR  = o.leads  > 0 ? (o.reunioes / o.leads * 100).toFixed(0) : 0;
    return `<div class="ia-offer-card${i === 0 ? " ia-offer-card--top" : ""}">
      <div class="ia-offer-header">
        <span class="ia-offer-name">${i === 0 ? "🏆 " : ""}${o.label}</span>
        <span class="ia-offer-count">${o.count} criativo${o.count !== 1 ? "s" : ""}</span>
      </div>
      <div class="ia-offer-metrics">
        <div class="ia-offer-metric"><span class="ia-offer-metric-label">CTR</span><span class="ia-offer-metric-val">${ctr}%</span></div>
        <div class="ia-offer-metric"><span class="ia-offer-metric-label">CPC</span><span class="ia-offer-metric-val">${cpc > 0 ? fmtCurrency(cpc) : "—"}</span></div>
        <div class="ia-offer-metric"><span class="ia-offer-metric-label">Leads</span><span class="ia-offer-metric-val ia-accent">${o.leads}</span></div>
        <div class="ia-offer-metric"><span class="ia-offer-metric-label">Reuniões</span><span class="ia-offer-metric-val ia-accent">${o.reunioes}</span></div>
        <div class="ia-offer-metric"><span class="ia-offer-metric-label">Assinaturas</span><span class="ia-offer-metric-val ia-accent">${o.assinaturas}</span></div>
        <div class="ia-offer-metric"><span class="ia-offer-metric-label">Taxa reunião</span><span class="ia-offer-metric-val">${taxaR}%</span></div>
        <div class="ia-offer-metric"><span class="ia-offer-metric-label">CPR</span><span class="ia-offer-metric-val">${cpr > 0 ? fmtCurrency(cpr) : "—"}</span></div>
        <div class="ia-offer-metric"><span class="ia-offer-metric-label">CPA Ass.</span><span class="ia-offer-metric-val">${cpa > 0 ? fmtCurrency(cpa) : "—"}</span></div>
      </div>
    </div>`;
  }).join("")}</div>`;
}

// ─── Funnels ──────────────────────────────────────────────────────────────────
function iaRenderIntelFunnels(data) {
  const el = document.getElementById("iaFunnels");
  if (!el) return;
  if (!data.length) { el.innerHTML = `<p class="ia-empty-note">Carregue dados via API.</p>`; return; }

  const offerStats = iaGroupByMap(data, IA_OFFER_MAP, d => `${d.adName} ${d.campaign}`);
  const bestOffer  = offerStats.find(o => o.reunioes > 0) || offerStats[0];

  const stageStats = {};
  data.forEach(d => {
    if (!stageStats[d.stage]) stageStats[d.stage] = { count: 0, reunioes: 0, assinaturas: 0, spend: 0 };
    stageStats[d.stage].count++;
    stageStats[d.stage].reunioes    += d.reunioes;
    stageStats[d.stage].assinaturas += d.assinaturas;
    stageStats[d.stage].spend       += d.spend;
  });

  const funnels = [];

  if (bestOffer && bestOffer.reunioes > 0) {
    const cpr = fmtCurrency(bestOffer.spend / bestOffer.reunioes);
    funnels.push({
      icon: "🥇", label: "Funil Principal (Maior Conversão)", priority: "Escalar", color: "green",
      steps: ["Anúncio Meta", bestOffer.label, "Reunião com Consultor", "Proposta → Assinatura"],
      insight: `${bestOffer.label} é a oferta com mais reuniões (${bestOffer.reunioes}) e CPR de ${cpr}. Priorize mais criativos neste formato.`,
    });
  } else if (offerStats.length > 0 && offerStats[0]) {
    funnels.push({
      icon: "🎯", label: `Funil ${offerStats[0].label}`, priority: "Testar conversão", color: "blue",
      steps: ["Anúncio Meta", offerStats[0].label, "Lead Qualificado", "Reunião"],
      insight: `${offerStats[0].label} é a oferta mais usada (${offerStats[0].count} criativos) mas sem dados de reunião. Acione os dados de CRM para ver CPR real.`,
    });
  }

  if (stageStats["TOFU"] && stageStats["BOFU"]) {
    funnels.push({
      icon: "🔄", label: "Funil Completo TOFU → BOFU", priority: "Manter", color: "blue",
      steps: ["TOFU (Conscientização)", "BOFU (Decisão)", "Reunião", "Assinatura"],
      insight: `TOFU tem ${stageStats["TOFU"].count} criativos e BOFU tem ${stageStats["BOFU"].count}. Verifique se o retargeting conecta quem viu TOFU aos anúncios BOFU.`,
    });
  }

  if (stageStats["RMKT"]) {
    const rmkt = stageStats["RMKT"];
    const cprRmkt = rmkt.reunioes > 0 ? fmtCurrency(rmkt.spend / rmkt.reunioes) : null;
    funnels.push({
      icon: "🔁", label: "Funil RMKT (Recuperação de Leads)", priority: rmkt.reunioes > 0 ? "Escalar" : "Otimizar", color: rmkt.reunioes > 0 ? "green" : "yellow",
      steps: ["Lead existente (pixel/lista)", "Anúncio RMKT específico", "Reunião"],
      insight: `RMKT com ${rmkt.count} criativo${rmkt.count !== 1 ? "s" : ""}, ${rmkt.reunioes} reunião${rmkt.reunioes !== 1 ? "ões" : ""} e CPR ${cprRmkt || "sem dados"}. ${rmkt.reunioes > 0 ? "Boa performance — aumente budget." : "Revise a segmentação e o copy."}`,
    });
  }

  if (!funnels.length) { el.innerHTML = `<p class="ia-empty-note">Dados insuficientes para gerar recomendações de funil.</p>`; return; }

  el.innerHTML = `<div class="ia-funnels-grid">${funnels.map(f => `
    <div class="ia-funnel-card">
      <div class="ia-funnel-header">
        <span class="ia-funnel-icon">${f.icon}</span>
        <div><div class="ia-funnel-label">${f.label}</div>
          <span class="ia-funnel-priority ia-priority--${f.color}">${f.priority}</span></div>
      </div>
      <div class="ia-funnel-flow">
        ${f.steps.map((s, i) => `<div class="ia-funnel-step">${s}</div>${i < f.steps.length - 1 ? `<div class="ia-funnel-arrow">↓</div>` : ""}`).join("")}
      </div>
      <div class="ia-funnel-insight">${f.insight}</div>
    </div>`).join("")}</div>`;
}

// ─── Messages ─────────────────────────────────────────────────────────────────
function iaRenderIntelMessages(data) {
  const el = document.getElementById("iaMessages");
  if (!el) return;
  if (!data.length) { el.innerHTML = `<p class="ia-empty-note">Carregue dados via API.</p>`; return; }

  const STOP = new Set([
    "de","do","da","dos","das","para","com","que","em","se","no","na","ao","as","um","uma",
    "o","a","e","ou","os","por","mais","mas","nao","sim","como","quando","onde","seu","sua",
    "este","essa","isso","esse","aqui","ali","qual","ser","ter","num","numa","pelo","pela",
    "v1","v2","v3","v4","ads","meta","new","novo","nova","ativo","test","teste","br","pt",
  ]);

  function wordFreq(ads) {
    const freq = {};
    for (const d of ads) {
      const words = iaNorm(`${d.adName} ${d.campaign} ${d.adset}`)
        .split(" ")
        .filter(w => w.length > 3 && !STOP.has(w) && !/^\d+$/.test(w));
      for (const w of words) freq[w] = (freq[w] || 0) + 1;
    }
    return Object.entries(freq)
      .filter(([,c]) => c >= 1)
      .sort((a,b) => b[1] - a[1])
      .slice(0, 22)
      .map(([word, count]) => ({ word, count }));
  }

  const winners = data.filter(d => d.reunioes > 0 || d.assinaturas > 0);
  const losers  = data.filter(d => d.reunioes === 0 && d.assinaturas === 0 && d.spend > 30);
  const winWords = wordFreq(winners);
  const loseSet  = new Set(wordFreq(losers).map(w => w.word));
  const diffs    = winWords.filter(w => !loseSet.has(w.word)).slice(0, 14);
  const maxCount = Math.max(...winWords.map(w => w.count), 1);

  if (!winners.length) {
    el.innerHTML = `<p class="ia-empty-note">Sem criativos com reuniões para análise de mensagens. Verifique se os dados de CRM estão carregados.</p>`;
    return;
  }

  el.innerHTML = `
    <div class="ia-messages-grid">
      <div>
        <h4 class="ia-messages-col-title">🏆 Palavras dos criativos que geraram reuniões (${winners.length} criativos)</h4>
        ${winWords.length ? `<div class="ia-wordcloud">${winWords.map(w => {
          const size = Math.round(11 + (w.count / maxCount) * 12);
          return `<span class="ia-word" style="font-size:${size}px" title="${w.count}× nos vencedores">${w.word}</span>`;
        }).join("")}</div>` : `<p class="ia-empty-note">Sem palavras identificadas.</p>`}
      </div>
      ${diffs.length ? `
      <div>
        <h4 class="ia-messages-col-title">💡 Diferenciais exclusivos dos vencedores</h4>
        <p class="ia-intel-note">Palavras nos criativos com reunião que não aparecem nos sem reunião.</p>
        <ul class="ia-diff-list">${diffs.map(w => `<li><span class="ia-diff-word">${w.word}</span></li>`).join("")}</ul>
      </div>` : ""}
    </div>`;
}

// ─── Creative patterns ────────────────────────────────────────────────────────
function iaRenderIntelCreativePatterns(data) {
  const el = document.getElementById("iaCreativePatterns");
  if (!el) return;
  if (!data.length) { el.innerHTML = `<p class="ia-empty-note">Carregue dados via API.</p>`; return; }

  const ps = iaGroupByMap(data, IA_CREATIVE_PATTERN_MAP, d => `${d.adName} ${d.campaign} ${d.adset}`);
  if (!ps.length) { el.innerHTML = `<p class="ia-empty-note">Nenhum padrão detectado nos nomes dos criativos.</p>`; return; }

  el.innerHTML = `
    <div class="ia-intel-table-wrap">
      <table class="ia-intel-table">
        <thead><tr>
          <th>Padrão</th><th class="ia-th-r">Criativos</th><th class="ia-th-r">CTR médio</th>
          <th class="ia-th-r">CPC médio</th><th class="ia-th-r">Leads</th>
          <th class="ia-th-r">Reuniões</th><th class="ia-th-r">Assinaturas</th><th class="ia-th-r">CPR</th>
        </tr></thead>
        <tbody>${ps.map((p, i) => {
          const ctr = p.impressions > 0 ? (p.clicks / p.impressions * 100).toFixed(1) + "%" : "—";
          const cpc = p.clicks  > 0 ? fmtCurrency(p.spend / p.clicks)   : "—";
          const cpr = p.reunioes > 0 ? fmtCurrency(p.spend / p.reunioes) : "—";
          return `<tr class="${i === 0 ? "ia-tr-winner" : ""}">
            <td class="ia-td-label">${i === 0 ? "🏆 " : ""}${p.label}</td>
            <td class="ia-td-r">${p.count}</td>
            <td class="ia-td-r">${ctr}</td>
            <td class="ia-td-r">${cpc}</td>
            <td class="ia-td-r">${p.leads}</td>
            <td class="ia-td-r ia-bold">${p.reunioes}</td>
            <td class="ia-td-r ia-bold">${p.assinaturas}</td>
            <td class="ia-td-r">${cpr}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>
    </div>
    <p class="ia-intel-note">Padrões detectados a partir dos nomes dos criativos. Criativos podem se enquadrar em mais de um padrão.</p>`;
}

// ─── Google Ads intelligence ──────────────────────────────────────────────────
function iaRenderIntelGads() {
  const el = document.getElementById("iaGadsIntel");
  if (!el) return;
  const kws  = gadsState.keywords    || [];
  const sts  = gadsState.searchTerms || [];
  const cps  = gadsState.campaigns   || [];

  if (!kws.length && !sts.length) {
    el.innerHTML = `<p class="ia-empty-note">Carregue dados do Google Ads via API para ver análise de palavras-chave.</p>`;
    return;
  }

  const topKws      = [...kws].filter(k => k.conversions > 0).sort((a,b) => b.conversions - a.conversions);
  const pauseKws    = kws.filter(k => k.clicks > 5 && k.conversions === 0 && k.costBRL > 30).sort((a,b) => b.costBRL - a.costBRL);
  const lowCtrKws   = kws.filter(k => k.impressions > 100 && k.ctr < 0.02).sort((a,b) => b.impressions - a.impressions);
  const convSts     = sts.filter(st => st.conversions > 0).sort((a,b) => b.conversions - a.conversions);
  const noConvSts   = sts.filter(st => st.clicks > 5 && st.conversions === 0).sort((a,b) => b.clicks - a.clicks);
  const avgCtr      = cps.length > 0 ? cps.reduce((s,c) => s + c.ctr, 0) / cps.length : 0;
  const scaleCps    = cps.filter(c => c.conversions > 0 && c.ctr >= avgCtr).sort((a,b) => b.conversions - a.conversions).slice(0,3);
  const pauseCps    = cps.filter(c => c.costBRL > 50 && c.conversions === 0 && c.ctr < avgCtr).sort((a,b) => b.costBRL - a.costBRL).slice(0,3);

  function kwRow(k) {
    const term = k.keyword || k.searchTerm || "";
    return `<tr>
      <td>${escapeHtml(term)}</td>
      <td class="ia-td-r">${fmtInt(k.impressions)}</td>
      <td class="ia-td-r">${fmtInt(k.clicks)}</td>
      <td class="ia-td-r">${(k.ctr * 100).toFixed(1)}%</td>
      <td class="ia-td-r">${k.costBRL > 0 ? fmtCurrency(k.costBRL) : "—"}</td>
      <td class="ia-td-r">${k.conversions > 0 ? k.conversions.toFixed(0) : "0"}</td>
    </tr>`;
  }

  function block(title, note, rows) {
    if (!rows.length) return "";
    return `<div class="ia-gads-block">
      <h4 class="ia-gads-block-title">${title}</h4>
      ${note ? `<p class="ia-intel-note">${note}</p>` : ""}
      <div class="ia-intel-table-wrap"><table class="ia-intel-table ia-intel-table--sm">
        <thead><tr><th>Termo / Palavra-chave</th><th class="ia-th-r">Impr.</th><th class="ia-th-r">Cliques</th><th class="ia-th-r">CTR</th><th class="ia-th-r">Custo</th><th class="ia-th-r">Conv.</th></tr></thead>
        <tbody>${rows.map(kwRow).join("")}</tbody>
      </table></div>
    </div>`;
  }

  const campsHtml = (scaleCps.length || pauseCps.length) ? `
    <div class="ia-gads-block">
      <h4 class="ia-gads-block-title">📊 Gestão de Campanhas</h4>
      <div class="ia-gads-camps">
        ${scaleCps.map(c => `<div class="ia-gads-camp ia-gads-camp--scale">
          <span class="ia-gads-camp-icon">🚀 Escalar</span>
          <span class="ia-gads-camp-name">${escapeHtml(c.name.length > 40 ? c.name.slice(0,40)+"…" : c.name)}</span>
          <span>${c.conversions.toFixed(0)} conv · CTR ${(c.ctr*100).toFixed(1)}% · ${fmtCurrency(c.costBRL)}</span>
        </div>`).join("")}
        ${pauseCps.map(c => `<div class="ia-gads-camp ia-gads-camp--pause">
          <span class="ia-gads-camp-icon">⛔ Pausar</span>
          <span class="ia-gads-camp-name">${escapeHtml(c.name.length > 40 ? c.name.slice(0,40)+"…" : c.name)}</span>
          <span>${fmtCurrency(c.costBRL)} investido · 0 conv · CTR ${(c.ctr*100).toFixed(1)}%</span>
        </div>`).join("")}
      </div>
    </div>` : "";

  el.innerHTML = `<div class="ia-gads-grid">
    ${block("✅ Palavras-chave com Conversões", "Mantenha ou aumente o lance — já provaram que convertem.", topKws)}
    ${block("⛔ Candidatas a Pausa (gasto sem conversão)", "Palavras com cliques e custo relevante mas sem conversão registrada.", pauseKws)}
    ${block("📉 Palavras com CTR Baixo (< 2%)", "CTR abaixo de 2% com volume alto — revise os anúncios ou a correspondência.", lowCtrKws)}
    ${block("💡 Termos para Adicionar como Palavra-chave Exata", "Termos que já converteram — adicione como correspondência exata: [termo].", convSts)}
    ${block("🚫 Termos Candidatos a Negativação", "Cliques sem conversão — adicione como palavras-chave negativas.", noConvSts)}
    ${campsHtml}
  </div>`;
}

// ─── Growth opportunities ──────────────────────────────────────────────────────
function iaRenderIntelGrowth(data) {
  const el = document.getElementById("iaGrowth");
  if (!el) return;
  if (!data.length) { el.innerHTML = `<p class="ia-empty-note">Carregue dados via API para ver oportunidades.</p>`; return; }

  const totalSpend    = data.reduce((s,d) => s + d.spend, 0);
  const totalReunoes  = data.reduce((s,d) => s + d.reunioes, 0);
  const overallCpr    = totalReunoes > 0 ? totalSpend / totalReunoes : Infinity;

  const scale = [], test = [], pause = [];

  // Scale: ads with CPR below average and spend below 30% of total
  data.filter(d => d.reunioes > 0).forEach(d => {
    const cpr = d.spend / d.reunioes;
    if (cpr < overallCpr * 0.9 && d.spend < totalSpend * 0.3 && d.spend > 10) {
      scale.push({ label: d.adName, reason: `CPR ${fmtCurrency(cpr)} abaixo da média (${fmtCurrency(overallCpr)}) — bom candidato a escalar.` });
    }
  });

  // Test: offer types with no data
  const offerStats = iaGroupByMap(data, IA_OFFER_MAP, d => `${d.adName} ${d.campaign}`);
  const activeOff  = new Set(offerStats.map(o => o.id));
  IA_OFFER_MAP.filter(o => !activeOff.has(o.id)).slice(0,3).forEach(o => {
    test.push({ label: o.label, reason: "Oferta não testada — potencial canal inexplorado de geração de reuniões." });
  });

  // Pause: ads with spend > R$100 and 0 results
  data.filter(d => d.spend > 100 && d.reunioes === 0 && d.assinaturas === 0).forEach(d => {
    pause.push({ label: d.adName, reason: `${fmtCurrency(d.spend)} investido sem reunião ou assinatura.` });
  });

  // Top opportunities
  const opps = [];
  const bestMeta = [...data].filter(d => d.reunioes > 0).sort((a,b) => a.spend/a.reunioes - b.spend/b.reunioes)[0];
  if (bestMeta) {
    const cpr = fmtCurrency(bestMeta.spend / bestMeta.reunioes);
    opps.push(`🏆 Menor CPR do período: <strong>${bestMeta.adName.length > 45 ? bestMeta.adName.slice(0,45)+"…" : bestMeta.adName}</strong> — CPR ${cpr}. Escalar este criativo tem o maior retorno por real investido.`);
  }
  const gBest = (gadsState.campaigns || []).filter(c => c.conversions > 0).sort((a,b) => b.conversions - a.conversions)[0];
  if (gBest) {
    opps.push(`📈 Melhor campanha Google: <strong>${gBest.name.length > 40 ? gBest.name.slice(0,40)+"…" : gBest.name}</strong> — ${gBest.conversions.toFixed(0)} conv. Considere aumentar o budget.`);
  }

  function renderList(items, icon, color) {
    if (!items.length) return `<p class="ia-empty-note">Nenhum item identificado com os dados atuais.</p>`;
    return `<ul class="ia-growth-list">${items.slice(0,5).map(item => `
      <li class="ia-growth-item ia-growth-item--${color}">
        <span class="ia-growth-icon">${icon}</span>
        <div>
          <div class="ia-growth-label">${item.label.length > 52 ? item.label.slice(0,52)+"…" : item.label}</div>
          <div class="ia-growth-reason">${item.reason}</div>
        </div>
      </li>`).join("")}</ul>`;
  }

  el.innerHTML = `
    <div class="ia-growth-grid">
      <div class="ia-growth-block"><h4 class="ia-growth-block-title ia-growth-title--scale">🚀 O que Escalar</h4>${renderList(scale,"🚀","scale")}</div>
      <div class="ia-growth-block"><h4 class="ia-growth-block-title ia-growth-title--test">🧪 O que Testar</h4>${renderList(test,"🧪","test")}</div>
      <div class="ia-growth-block"><h4 class="ia-growth-block-title ia-growth-title--pause">⛔ O que Pausar</h4>${renderList(pause,"⛔","pause")}</div>
    </div>
    ${opps.length ? `<div class="ia-growth-opps"><h4 class="ia-growth-block-title" style="margin-bottom:10px;">💎 Maior Oportunidade Atual</h4>${opps.map(o => `<div class="ia-opp-item">${o}</div>`).join("")}</div>` : ""}`;
}

// ─── Google Ads suggestions ────────────────────────────────────────────────────
function iaRenderIntelGadsSuggestions() {
  const el = document.getElementById("iaGadsSuggestions");
  if (!el) return;
  const kws = gadsState.keywords    || [];
  const sts = gadsState.searchTerms || [];
  const cps = gadsState.campaigns   || [];

  if (!kws.length && !sts.length && !cps.length) {
    el.innerHTML = `<p class="ia-empty-note">Carregue dados do Google Ads via API para ver sugestões.</p>`;
    return;
  }

  // Promote converting search terms to exact match keywords
  const newKws = sts.filter(st => st.conversions > 0).map(st => ({
    keyword: st.searchTerm,
    reason:  `${st.conversions.toFixed(0)} conv. · CTR ${(st.ctr*100).toFixed(1)}% · ${fmtCurrency(st.costBRL)} — adicionar como [${st.searchTerm}]`,
  }));

  // Topics not yet covered in keywords or search terms
  const kwText = [...kws.map(k => k.keyword || ""), ...sts.map(st => st.searchTerm || "")].join(" ");
  const newThemes = IA_TOPIC_MAP
    .filter(t => !iaMatchesKw(kwText, t.kw))
    .slice(0, 4)
    .map(t => ({
      theme:    t.label,
      keywords: t.kw.slice(0,3).map(k => `"${k}"`).join(", "),
      reason:   `Tema não coberto nas campanhas atuais — potencial não explorado de captura de intenção.`,
    }));

  // Budget reallocation
  const avgCpa = cps.filter(c => c.conversions > 0).reduce((s,c) => s + c.cpa, 0) / Math.max(cps.filter(c => c.conversions > 0).length, 1);
  const budgetRecs = [];
  cps.forEach(c => {
    if (c.conversions > 0 && avgCpa > 0 && c.cpa < avgCpa * 0.8) {
      budgetRecs.push({ name: c.name, action: "Aumentar budget", up: true, reason: `CPA ${fmtCurrency(c.cpa)} abaixo da média (${fmtCurrency(avgCpa)}) — melhor retorno por real.` });
    }
    if (c.conversions === 0 && c.costBRL > 50) {
      budgetRecs.push({ name: c.name, action: "Reduzir / Pausar", up: false, reason: `${fmtCurrency(c.costBRL)} sem conversão — redirecione para campanhas eficientes.` });
    }
  });

  el.innerHTML = `<div class="ia-gads-sugg-grid">
    ${newKws.length ? `<div class="ia-gads-block">
      <h4 class="ia-gads-block-title">🔑 Adicionar como Palavras-chave Exatas</h4>
      <p class="ia-intel-note">Termos que já converteram nos anúncios de pesquisa. Adicione como correspondência exata para reduzir custo e aumentar relevância.</p>
      <ul class="ia-gads-kw-list">${newKws.map(k => `<li>
        <code class="ia-kw-code">[${escapeHtml(k.keyword)}]</code>
        <span class="ia-kw-reason">${k.reason}</span>
      </li>`).join("")}</ul>
    </div>` : ""}
    ${newThemes.length ? `<div class="ia-gads-block">
      <h4 class="ia-gads-block-title">💡 Novos Grupos de Anúncios por Tema</h4>
      <p class="ia-intel-note">Temas com alta intenção de compra ainda não cobertos nas campanhas atuais.</p>
      <div class="ia-gads-themes">${newThemes.map(t => `<div class="ia-gads-theme">
        <div class="ia-gads-theme-name">${t.theme}</div>
        <div class="ia-gads-theme-kws">Palavras sugeridas: ${t.keywords}</div>
        <div class="ia-gads-theme-reason">${t.reason}</div>
      </div>`).join("")}</div>
    </div>` : ""}
    ${budgetRecs.length ? `<div class="ia-gads-block">
      <h4 class="ia-gads-block-title">💰 Realocação de Budget</h4>
      <ul class="ia-gads-budget-list">${budgetRecs.map(r => `<li>
        <span class="ia-budget-action ${r.up ? "ia-budget-up" : "ia-budget-down"}">${r.up ? "↑" : "↓"} ${r.action}</span>
        <strong>${escapeHtml(r.name.length > 38 ? r.name.slice(0,38)+"…" : r.name)}</strong>
        <span class="ia-kw-reason">${r.reason}</span>
      </li>`).join("")}</ul>
    </div>` : ""}
  </div>`;
}

function iaExtractTags(n) {
  const tags = [];
  if (n.includes("tofu"))                                                        tags.push("TOFU");
  else if (n.includes("bofu"))                                                   tags.push("BOFU");
  else if (n.includes("rmkt") || n.includes("remarketing"))                      tags.push("RMKT");
  if (n.includes("aula grat"))                                                   tags.push("Aula Gratuita");
  else if (n.includes("curso grat"))                                             tags.push("Curso Gratuito");
  else if (n.includes("diagnostico"))                                            tags.push("Diagnóstico");
  else if (n.includes("universidade"))                                           tags.push("Universidade");
  else if (n.includes("especializacao") || n.includes("especializaçao"))        tags.push("Especialização");
  if (n.includes(" ia ") || n.includes("inteligencia artificial"))              tags.push("IA");
  return tags;
}

function iaSafeAvg(arr) {
  const valid = arr.filter(v => isFinite(v) && v >= 0);
  return valid.length ? valid.reduce((s, v) => s + v, 0) / valid.length : 0;
}

function iaGroupStats(items) {
  return {
    count:       items.length,
    spend:       items.reduce((s, d) => s + d.spend, 0),
    impressions: items.reduce((s, d) => s + d.impressions, 0),
    clicks:      items.reduce((s, d) => s + d.clicks, 0),
    leads:       items.reduce((s, d) => s + d.leads, 0),
    reunioes:    items.reduce((s, d) => s + d.reunioes, 0),
    assinaturas: items.reduce((s, d) => s + d.assinaturas, 0),
    avgCtr:      iaSafeAvg(items.map(d => d.ctr)),
    avgCpc:      iaSafeAvg(items.filter(d => d.cpc > 0).map(d => d.cpc)),
  };
}

function iaBuildData() {
  if (!_liveMetaRows || !_liveMetaRows.length) return [];

  // Signature attribution — mesma lógica que renderLiveMeta
  const seenSignUid = new Set();
  const allMetaSign = [];
  (state.reunioesRows || []).forEach(d => {
    if (!countsAsMetaSignature(d.stage, d.origem)) return;
    const ck  = normalizeKey(d.nomeContato || "");
    const bn  = cleanDealBaseName(d.nomeNegocio);
    const uid = (ck && bn) ? `${ck}|${bn}` : (ck || bn || `${d.nomeNegocio}|${String(d.horaCriacao)}`);
    if (seenSignUid.has(uid)) return;
    seenSignUid.add(uid);
    allMetaSign.push({ ...d });
  });

  return _liveMetaRows.map(r => {
    const creative  = state.creatives.find(c => c.adId && c.adId === r.ad_id);
    const allDeals  = creative ? creative.zohoDeals : [];
    const meetDeals = allDeals.filter(d => countsAsMetaMeeting(d.stage, d.origem));

    const adNameKey = normalizeKey(r.ad_name || "");
    const signDeals = allMetaSign.filter(d =>
      (d.metaAdsAnuncioKey && d.metaAdsAnuncioKey === adNameKey) ||
      (d.metaAdsId && r.ad_id && d.metaAdsId === r.ad_id)
    );

    const n     = normalizeKey(`${r.ad_name || ""} ${r.campaign_name || ""} ${r.adset_name || ""}`);
    const tags  = iaExtractTags(n);
    const stage = tags.find(t => ["TOFU","BOFU","RMKT"].includes(t)) || "Outros";

    return {
      adId:        r.ad_id,
      adName:      r.ad_name || "(sem nome)",
      campaign:    r.campaign_name || "",
      adset:       r.adset_name || "",
      spend:       r.spend || 0,
      impressions: r.impressions || 0,
      clicks:      r.clicks || 0,
      ctr:         r.ctr || 0,
      cpc:         r.cpc || 0,
      leads:       r.leads || 0,
      reunioes:    meetDeals.length,
      assinaturas: signDeals.length,
      tags,
      stage,
    };
  });
}

function iaRankingList(items, valueFn) {
  if (!items.length) return `<p class="ia-empty-note">Nenhum dado disponível.</p>`;
  const medals = ["🥇","🥈","🥉","4.","5."];
  return `<ul class="ia-rank-list">${items.map((d, i) => {
    const name = d.adName.length > 32 ? d.adName.slice(0, 32) + "…" : d.adName;
    return `<li class="ia-rank-item">
      <span class="ia-rank-medal">${medals[i]}</span>
      <span class="ia-rank-name" title="${d.adName}">${name}</span>
      <span class="ia-rank-val">${valueFn(d)}</span>
    </li>`;
  }).join("")}</ul>`;
}

function iaRenderPatterns(groups, overall) {
  const stageOrder = ["TOFU","BOFU","RMKT","Outros"];
  const active = stageOrder.filter(s => groups[s]);
  if (!active.length) return `<p class="ia-empty-note">Nenhum padrão detectado.</p>`;

  return `<div class="ia-patterns-grid">${active.map(s => {
    const g       = groups[s];
    const ctrDiff = overall.avgCtr > 0 ? (g.avgCtr - overall.avgCtr) / overall.avgCtr * 100 : 0;
    const cls     = ctrDiff > 5 ? "ia-pos" : ctrDiff < -5 ? "ia-neg" : "";
    return `<div class="ia-pattern-card">
      <div class="ia-pattern-title">${s}</div>
      <div class="ia-pattern-sub">${g.count} criativo${g.count !== 1 ? "s" : ""}</div>
      <div class="ia-pattern-metrics">
        <div class="ia-pm"><span class="ia-pm-label">CTR médio</span><span class="ia-pm-val ${cls}">${fmtPct(g.avgCtr)}</span></div>
        <div class="ia-pm"><span class="ia-pm-label">CPC médio</span><span class="ia-pm-val">${g.avgCpc > 0 ? fmtCurrency(g.avgCpc) : "—"}</span></div>
        <div class="ia-pm"><span class="ia-pm-label">Reuniões</span><span class="ia-pm-val">${fmtInt(g.reunioes)}</span></div>
        <div class="ia-pm"><span class="ia-pm-label">Investimento</span><span class="ia-pm-val">${fmtCurrency(g.spend)}</span></div>
      </div>
    </div>`;
  }).join("")}</div>`;
}

function iaGenerateLearnings(data, overall, groups) {
  const learnings = [];

  // Criativo campeão em reuniões
  const topMeet = [...data].filter(d => d.reunioes > 0).sort((a,b) => b.reunioes - a.reunioes)[0];
  if (topMeet) {
    learnings.push(`O criativo com mais reuniões é <strong>${topMeet.adName}</strong> com ${topMeet.reunioes} reunião${topMeet.reunioes !== 1 ? "ões" : ""} — principal referência de copy e oferta do período.`);
  }

  // % criativos com reuniões
  const withMeet = data.filter(d => d.reunioes > 0).length;
  if (data.length > 0) {
    const pct = (withMeet / data.length * 100).toFixed(0);
    learnings.push(`${withMeet} de ${data.length} criativo${data.length !== 1 ? "s" : ""} (${pct}%) gerou pelo menos 1 reunião — os demais podem precisar de ajuste de copy ou segmentação.`);
  }

  // Comparação de CTR entre funis
  const stageItems = ["TOFU","BOFU","RMKT"].map(s => groups[s] ? { stage: s, ...groups[s] } : null).filter(Boolean).filter(g => g.count > 0);
  if (stageItems.length >= 2) {
    const sorted = [...stageItems].sort((a,b) => b.avgCtr - a.avgCtr);
    const best   = sorted[0];
    const worst  = sorted[sorted.length - 1];
    if (best.avgCtr > 0 && worst.avgCtr > 0) {
      const diff = ((best.avgCtr - worst.avgCtr) / worst.avgCtr * 100).toFixed(0);
      learnings.push(`Criativos <strong>${best.stage}</strong> têm CTR médio ${diff}% superior aos de <strong>${worst.stage}</strong> (${fmtPct(best.avgCtr)} vs ${fmtPct(worst.avgCtr)}).`);
    }
  }

  // Concentração de reuniões no top 3
  if (overall.reunioes > 0) {
    const top3 = [...data].sort((a,b) => b.reunioes - a.reunioes).slice(0, 3);
    const top3Total = top3.reduce((s,d) => s + d.reunioes, 0);
    if (top3Total < overall.reunioes) {
      const pct = (top3Total / overall.reunioes * 100).toFixed(0);
      learnings.push(`Os 3 criativos com mais reuniões concentram ${pct}% do total — oportunidade de escalar esses formatos ou criar variações diretas.`);
    }
  }

  // CPC: criativos com reunião vs sem
  const withMeetData  = data.filter(d => d.reunioes > 0 && d.cpc > 0);
  const noMeetData    = data.filter(d => d.reunioes === 0 && d.cpc > 0 && d.spend > 30);
  if (withMeetData.length > 0 && noMeetData.length > 0) {
    const cpcMeet   = iaSafeAvg(withMeetData.map(d => d.cpc));
    const cpcNoMeet = iaSafeAvg(noMeetData.map(d => d.cpc));
    if (cpcMeet > 0 && cpcNoMeet > 0) {
      const diff = ((cpcNoMeet - cpcMeet) / cpcMeet * 100).toFixed(0);
      if (Math.abs(Number(diff)) > 10) {
        learnings.push(`Criativos que geraram reuniões têm CPC médio de ${fmtCurrency(cpcMeet)}, enquanto os demais chegam a ${fmtCurrency(cpcNoMeet)} — sinal de que eficiência de clique não é suficiente para gerar reunião.`);
      }
    }
  }

  return learnings.slice(0, 5);
}

function iaGenerateRecs(data, topByMeet, topByCtr) {
  const recs = [];

  // Rec 1: escalar o campeão de reuniões
  if (topByMeet.length > 0) {
    const best = topByMeet[0];
    recs.push({
      numero: "01",
      titulo: "Escalar o criativo campeão",
      subtitulo: "Maior volume de reuniões no período",
      referencia: best.adName,
      elementos: [
        { label: "Funil",        valor: best.stage },
        { label: "Reuniões",     valor: String(best.reunioes) },
        { label: "CTR",          valor: fmtPct(best.ctr) },
        { label: "CPC",          valor: fmtCurrency(best.cpc) },
        { label: "Investimento", valor: fmtCurrency(best.spend) },
      ],
      acao: `Aumente o budget em 20–30% e monitore o CPL. Se mantiver eficiência após 3 dias, continue escalando em blocos de 20%.`,
    });
  }

  // Rec 2: explorar o criativo de maior CTR (com spend mínimo)
  const topCtrFiltered = topByCtr.filter(d => d.spend > 30);
  if (topCtrFiltered.length > 0) {
    const best = topCtrFiltered[0];
    recs.push({
      numero: "02",
      titulo: "Explorar o criativo de alta captura",
      subtitulo: "Maior CTR com investimento relevante",
      referencia: best.adName,
      elementos: [
        { label: "Funil",   valor: best.stage },
        { label: "CTR",     valor: fmtPct(best.ctr) },
        { label: "CPC",     valor: fmtCurrency(best.cpc) },
        { label: "Leads",   valor: fmtInt(best.leads) },
        { label: "Reuniões",valor: String(best.reunioes) },
      ],
      acao: `Este criativo captura atenção com eficiência. Teste uma variação do copy de fechamento (CTA ou página de destino) para converter mais leads em reuniões.`,
    });
  }

  // Rec 3: nova variação de funil complementar ao campeão
  if (topByMeet.length > 0) {
    const best    = topByMeet[0];
    const altStage = best.stage === "TOFU" ? "BOFU" : best.stage === "BOFU" ? "RMKT" : "TOFU";
    recs.push({
      numero: "03",
      titulo: `Nova variação — funil ${altStage}`,
      subtitulo: "Baseado no copy do criativo campeão",
      referencia: best.adName,
      elementos: [
        { label: "Funil alvo",       valor: altStage },
        { label: "Referência",       valor: "Ângulo do campeão atual" },
        { label: "Diferencial",      valor: "Objeções do próximo estágio" },
        { label: "Formato sugerido", valor: "Vídeo 30–60s ou estático" },
      ],
      acao: `Crie uma versão ${altStage} com o mesmo ângulo de copy do criativo campeão, adaptando a CTA para o próximo passo da jornada do lead.`,
    });
  }

  return recs;
}

function iaRenderRec(rec) {
  return `<div class="ia-rec-card">
    <div class="ia-rec-number">${rec.numero}</div>
    <div>
      <div class="ia-rec-title">${rec.titulo}</div>
      <div class="ia-rec-sub">${rec.subtitulo}</div>
    </div>
    <div class="ia-rec-ref">
      <span class="ia-rec-ref-label">Criativo base</span>
      <span class="ia-rec-ref-name" title="${rec.referencia}">${rec.referencia.length > 44 ? rec.referencia.slice(0,44)+"…" : rec.referencia}</span>
    </div>
    <div class="ia-rec-elements">
      ${rec.elementos.map(e => `<div class="ia-rec-el"><span class="ia-rec-el-label">${e.label}</span><span class="ia-rec-el-val">${e.valor}</span></div>`).join("")}
    </div>
    <div class="ia-rec-acao">
      <span class="ia-rec-acao-label">Próximo passo</span>
      ${rec.acao}
    </div>
  </div>`;
}

function iaRenderIdeas() {
  const ideas = {
    headlines: [
      "Como treinar um time de vendas B2B em 30 dias (sem contratar mais)",
      "O método que 500+ líderes usam para levar times ao topo das metas",
      "Gestão de Vendas B2B: o que separa times mediocres de alta performance",
      "Por que 3 em 4 times B2B não batem meta — e o que fazer a partir de segunda",
      "Aula gratuita: as 3 alavancas que todo gestor B2B precisa dominar",
    ],
    subheadlines: [
      "Para líderes, diretores e gerentes de vendas B2B que querem resultado real",
      "Conteúdo direto ao ponto — o que funciona no campo, sem teoria vazia",
      "10 horas de aulas com quem já gerenciou mais de R$50M em vendas B2B",
      "Aplicável na semana seguinte — sem precisar parar a operação do seu time",
      "Acesso 100% gratuito por tempo limitado — vagas se esgotam rápido",
    ],
    ctas: [
      "Quero Treinar Meu Time",
      "Garantir Minha Vaga Grátis",
      "Assistir as Aulas Agora",
      "Ver a Metodologia Completa",
      "Entrar na Lista Prioritária",
    ],
    conceitos: [
      { titulo: "Âncora de preço + gratuidade", descricao: "Fundo azul marinho. Preço original (R$1.979) riscado em destaque. Badge 'GRATUITO'. Headline curta em caixa alta. CTA em botão contrastante. Apresentador no canto inferior." },
      { titulo: "Prova social numérica", descricao: "Número grande em destaque ('500+ empresas treinadas'). Fundo claro. Depoimento visual ou foto de grupo. Headline focada no resultado coletivo." },
      { titulo: "Problema real do gestor B2B", descricao: "Abertura com cena de meta não batida. Voz over identificando a dor. Transição para a solução PipeLovers. CTA para aula gratuita." },
      { titulo: "Mockup da plataforma", descricao: "Print da tela do curso em notebook ou tablet. Headline 'Comece agora, é grátis'. Lista rápida dos 3 principais benefícios. CTA simples e direto." },
      { titulo: "Talking head — autoridade B2B", descricao: "Apresentador falando diretamente para câmera. Legenda em destaque com dado de impacto. Sem texto de fundo — foco na pessoa e na mensagem." },
    ],
  };

  const colsHtml = [
    { titulo: "Headlines", items: ideas.headlines },
    { titulo: "Subheadlines", items: ideas.subheadlines },
    { titulo: "CTAs", items: ideas.ctas },
  ].map(c => `
    <div class="ia-ideas-col">
      <h4 class="ia-ideas-col-title">${c.titulo}</h4>
      <ul class="ia-ideas-list">
        ${c.items.map((item, i) => `<li><span class="ia-ideas-num">${i+1}</span>${item}</li>`).join("")}
      </ul>
    </div>`).join("");

  const conceitosHtml = `
    <div class="ia-ideas-conceitos">
      <h4 class="ia-ideas-col-title" style="margin-bottom:12px;">Conceitos Visuais</h4>
      <div class="ia-conceitos-grid">
        ${ideas.conceitos.map((c, i) => `
          <div class="ia-conceito-card">
            <div class="ia-conceito-num">${i+1}</div>
            <div>
              <div class="ia-conceito-title">${c.titulo}</div>
              <div class="ia-conceito-desc">${c.descricao}</div>
            </div>
          </div>`).join("")}
      </div>
    </div>`;

  return `<div class="ia-ideas-grid">${colsHtml}</div>${conceitosHtml}`;
}

function renderInsightsIA() {
  const content     = document.getElementById("iaContent");
  const placeholder = document.getElementById("iaPlaceholder");
  if (!content || !placeholder) return;

  const data = iaBuildData();

  if (!data.length) {
    content.hidden     = true;
    placeholder.hidden = false;
    return;
  }

  content.hidden     = false;
  placeholder.hidden = true;

  const overall = iaGroupStats(data);

  // Grupos por funil
  const groups = {};
  data.forEach(d => {
    if (!groups[d.stage]) groups[d.stage] = [];
    groups[d.stage].push(d);
  });
  const groupStats = {};
  Object.keys(groups).forEach(k => { groupStats[k] = iaGroupStats(groups[k]); });

  // Rankings
  const topByCtr  = [...data].filter(d => d.spend >= 10).sort((a,b) => b.ctr  - a.ctr).slice(0, 5);
  const topByMeet = [...data].filter(d => d.reunioes  > 0).sort((a,b) => b.reunioes  - a.reunioes).slice(0, 5);
  const topBySign = [...data].filter(d => d.assinaturas > 0).sort((a,b) => b.assinaturas - a.assinaturas).slice(0, 5);

  document.getElementById("iaTopCtr").innerHTML  = iaRankingList(topByCtr,  d => fmtPct(d.ctr));
  document.getElementById("iaTopMeet").innerHTML = iaRankingList(topByMeet, d => `${d.reunioes} reunião${d.reunioes !== 1 ? "ões" : ""}`);
  document.getElementById("iaTopSign").innerHTML = iaRankingList(topBySign, d => `${d.assinaturas} assinatura${d.assinaturas !== 1 ? "s" : ""}`);

  // Padrões
  document.getElementById("iaPatterns").innerHTML = iaRenderPatterns(groupStats, overall);

  // O que aprendemos
  const learnings = iaGenerateLearnings(data, overall, groupStats);
  document.getElementById("iaLearnings").innerHTML = learnings.length
    ? `<ul class="ia-learnings-list">${learnings.map(l => `<li>${l}</li>`).join("")}</ul>`
    : `<p class="ia-empty-note">Dados insuficientes para gerar aprendizados automáticos.</p>`;

  // Recomendações
  const recs = iaGenerateRecs(data, topByMeet, topByCtr);
  document.getElementById("iaRecs").innerHTML = recs.length
    ? `<div class="ia-recs-grid">${recs.map(iaRenderRec).join("")}</div>`
    : `<p class="ia-empty-note">Adicione dados de reuniões no Live Meta para ver recomendações.</p>`;

  // Novas ideias
  document.getElementById("iaIdeas").innerHTML = iaRenderIdeas();

  // ── Extended intelligence ──────────────────────────────────────────────────
  iaRenderIntelTopics(data);
  iaRenderIntelOffers(data);
  iaRenderIntelFunnels(data);
  iaRenderIntelMessages(data);
  iaRenderIntelCreativePatterns(data);
  iaRenderIntelGads();
  iaRenderIntelGrowth(data);
  iaRenderIntelGadsSuggestions();

  // Timestamp
  const tsEl = document.getElementById("iaLastUpdate");
  if (tsEl) tsEl.textContent = `Atualizado: ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
}

// ===========================================================================
// FINANCEIRO TAB
// ===========================================================================

const FIN_STORAGE_KEY = "finConfig_v2";

const FIN_DEFAULT_CONFIG = {
  budgetMeta:   18000,
  budgetGoogle: 11000,
  initiatives: [
    { id: "init_aula", name: "Aula Gratis",      budget: 11000 },
    { id: "init_bofu", name: "Meta ads BOFU",     budget:  7000 },
    { id: "init_gads", name: "Google Ads - Busca", budget: 11000 },
  ],
  campaignInit: {},
};

function finGetConfig() {
  try {
    const raw = localStorage.getItem(FIN_STORAGE_KEY);
    if (raw) {
      const cfg = JSON.parse(raw);
      if (!cfg.initiatives)  cfg.initiatives  = FIN_DEFAULT_CONFIG.initiatives.map(i => ({ ...i }));
      if (!cfg.campaignInit) cfg.campaignInit = {};
      if (cfg.budgetMeta   === undefined) cfg.budgetMeta   = FIN_DEFAULT_CONFIG.budgetMeta;
      if (cfg.budgetGoogle === undefined) cfg.budgetGoogle = FIN_DEFAULT_CONFIG.budgetGoogle;
      return cfg;
    }
  } catch (_) {}
  return {
    budgetMeta:   FIN_DEFAULT_CONFIG.budgetMeta,
    budgetGoogle: FIN_DEFAULT_CONFIG.budgetGoogle,
    initiatives:  FIN_DEFAULT_CONFIG.initiatives.map(i => ({ ...i })),
    campaignInit: {},
  };
}

function finSaveConfig(cfg) {
  try { localStorage.setItem(FIN_STORAGE_KEY, JSON.stringify(cfg)); } catch (_) {}
}

function finGetAllCampaigns(cfg) {
  const campaigns = [];

  // ── Meta: group state.creatives by campanha (CSV/Zoho data for meetings) ──
  const metaByCsv = {};
  for (const c of state.creatives) {
    const key = c.campanha || "(sem campanha)";
    if (!metaByCsv[key]) {
      metaByCsv[key] = { spend: 0, impressions: 0, clicks: 0, leads: 0, reunioes: 0, assinaturas: 0 };
    }
    const g = metaByCsv[key];
    g.spend       += c.valorGasto   || 0;
    g.impressions += c.impressoes   || 0;
    g.clicks      += c.cliques      || 0;
    g.leads       += c.leadsMeta    || 0;
    g.reunioes    += c.reunioes     || 0;
    g.assinaturas += c.assinaturas  || 0;
  }

  // ── Meta: group _liveMetaRows by campaign_name (API spend data) ──
  const metaByLive = {};
  for (const r of _liveMetaRows) {
    const key = r.campaign_name || "(sem campanha)";
    if (!metaByLive[key]) metaByLive[key] = { spend: 0, impressions: 0, clicks: 0, leads: 0 };
    const g = metaByLive[key];
    g.spend       += parseFloat(r.spend)     || 0;
    g.impressions += parseInt(r.impressions) || 0;
    g.clicks      += parseInt(r.clicks)      || 0;
    g.leads       += parseInt(r.leads)       || 0;
  }

  const allMetaNames = new Set([...Object.keys(metaByCsv), ...Object.keys(metaByLive)]);
  for (const name of allMetaNames) {
    const csv  = metaByCsv[name]  || { spend: 0, impressions: 0, clicks: 0, leads: 0, reunioes: 0, assinaturas: 0 };
    const live = metaByLive[name] || null;
    const spend       = live ? live.spend       : csv.spend;
    const impressions = live ? live.impressions : csv.impressions;
    const clicks      = live ? live.clicks      : csv.clicks;
    const leads       = live ? live.leads       : csv.leads;
    const { reunioes, assinaturas } = csv;
    if (spend === 0 && impressions === 0 && reunioes === 0) continue;
    const ctr       = impressions > 0 ? clicks / impressions     : 0;
    const cpc       = clicks  > 0 ? spend / clicks               : 0;
    const cpl       = leads   > 0 ? spend / leads                : 0;
    const cpaR      = reunioes    > 0 ? spend / reunioes         : 0;
    const cpaA      = assinaturas > 0 ? spend / assinaturas      : 0;
    campaigns.push({
      platform: "Meta", name, spend, impressions, clicks, leads, reunioes, assinaturas,
      ctr, cpc, cpl, cpaReuniao: cpaR, cpaAssn: cpaA,
      initId: cfg.campaignInit[`Meta|${name}`] || "",
    });
  }

  // ── Google: use gadsState.campaigns ──
  for (const c of gadsState.campaigns) {
    const spend = c.costBRL || 0;
    const leads = c.conversions || 0;
    campaigns.push({
      platform: "Google", name: c.name,
      spend, impressions: c.impressions, clicks: c.clicks, leads,
      reunioes: 0, assinaturas: 0,
      ctr: c.ctr, cpc: c.cpc,
      cpl:       leads > 0 ? spend / leads : 0,
      cpaReuniao: 0, cpaAssn: 0,
      initId: cfg.campaignInit[`Google|${c.name}`] || "",
    });
  }

  return campaigns;
}

function finGetTimeInfo() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const monthEnd           = new Date(2026, 6, 31);
  const tomorrow           = new Date(today.getTime() + 86400000);
  const diasUteis          = rpCountWorkingDays(RP_JULY_START, today);
  const diasUteisRestantes = rpCountWorkingDays(tomorrow, monthEnd);
  const diasUteisTotal     = RP_JULHO_DIAS_UTEIS; // 23 fixos — garante consistência com o reporte
  return { diasUteis, diasUteisRestantes, diasUteisTotal };
}

// ─── Chart instances ─────────────────────────────────────────────────────────
let _finChartPlatform = null;
let _finChartInit     = null;

// ─── Main render ─────────────────────────────────────────────────────────────
function renderFinanceiro() {
  const content     = document.getElementById("finContent");
  const placeholder = document.getElementById("finPlaceholder");
  if (!content || !placeholder) return;

  const cfg       = finGetConfig();
  const campaigns = finGetAllCampaigns(cfg);
  const time      = finGetTimeInfo();

  const hasData = campaigns.length > 0;
  if (!hasData) {
    content.hidden = true;
    placeholder.hidden = false;
    return;
  }
  content.hidden = false;
  placeholder.hidden = true;

  finRenderAlerts(campaigns, cfg, time);
  finRenderSummary(campaigns, cfg, time);
  finRenderPlatform(campaigns, cfg, time);
  finRenderInitiatives(campaigns, cfg, time);
  finRenderCampaignTable(campaigns, cfg);
  finRenderCharts(campaigns, cfg);
}

function finRenderAlerts(campaigns, cfg, time) {
  const totalBudget = cfg.budgetMeta + cfg.budgetGoogle;
  const totalSpend  = campaigns.reduce((s, c) => s + c.spend, 0);
  const { diasUteis, diasUteisTotal } = time;
  const alerts = [];

  if (diasUteis > 0 && diasUteisTotal > 0 && totalBudget > 0) {
    const mediaDiaria = totalSpend / diasUteis;
    const projecao    = mediaDiaria * diasUteisTotal;
    if (projecao > totalBudget * 1.1) {
      alerts.push({ type: "danger", msg: `⚠️ Ritmo acima do orçamento — projeção: ${fmtCurrency(projecao)} vs planejado: ${fmtCurrency(totalBudget)}.` });
    } else if (projecao < totalBudget * 0.75) {
      alerts.push({ type: "warn", msg: `📉 Ritmo abaixo do esperado — projeção: ${fmtCurrency(projecao)}. Pode sobrar orçamento no mês.` });
    }
  }

  const noMeet = campaigns.filter(c => c.platform === "Meta" && c.spend > 100 && c.reunioes === 0);
  if (noMeet.length) {
    alerts.push({ type: "info", msg: `🔍 ${noMeet.length} campanha${noMeet.length > 1 ? "s" : ""} Meta com gasto > R$100 e 0 reuniões.` });
  }

  const withMeet = campaigns.filter(c => c.cpaReuniao > 0);
  if (withMeet.length > 1) {
    const avgCpa  = withMeet.reduce((s, c) => s + c.cpaReuniao, 0) / withMeet.length;
    const highCpa = withMeet.filter(c => c.cpaReuniao > avgCpa * 2);
    if (highCpa.length) {
      alerts.push({ type: "warn", msg: `💸 ${highCpa.length} campanha${highCpa.length > 1 ? "s" : ""} com CPA reunião acima de 2× a média (${fmtCurrency(avgCpa)}).` });
    }
  }

  const el = document.getElementById("finAlerts");
  if (el) el.innerHTML = alerts.map(a => `<div class="fin-alert fin-alert--${a.type}">${a.msg}</div>`).join("");
}

function finRenderSummary(campaigns, cfg, time) {
  const totalBudget  = cfg.budgetMeta + cfg.budgetGoogle;
  const totalSpend   = campaigns.reduce((s, c) => s + c.spend, 0);
  const restante     = totalBudget - totalSpend;
  const pctConsumed  = totalBudget > 0 ? totalSpend / totalBudget : 0;
  const { diasUteis, diasUteisRestantes, diasUteisTotal } = time;
  const mediaDiaria  = diasUteis > 0 ? totalSpend / diasUteis : 0;
  const necessarioDia = diasUteisRestantes > 0 ? restante / diasUteisRestantes : 0;
  const projecao     = diasUteis > 0 && diasUteisTotal > 0 ? mediaDiaria * diasUteisTotal : totalSpend;
  const totalReunoes = campaigns.reduce((s, c) => s + c.reunioes, 0) + (gadsState.reunioes || 0);
  const totalLeads   = campaigns.reduce((s, c) => s + c.leads, 0);
  const totalAssn    = campaigns.reduce((s, c) => s + c.assinaturas, 0);

  const cards = [
    { label: "Orçamento Total",        value: fmtCurrency(totalBudget),   sub: "Meta Ads + Google Ads",                    color: "" },
    { label: "Investido no Mês",       value: fmtCurrency(totalSpend),    sub: fmtPct(pctConsumed * 100) + " do orçamento", color: pctConsumed > 1.05 ? "danger" : "" },
    { label: "Restante",               value: fmtCurrency(Math.max(0, restante)), sub: fmtPct(Math.max(0, 1 - pctConsumed) * 100) + " do orçamento", color: restante < 0 ? "danger" : "" },
    { label: "Média / Dia Útil",       value: fmtCurrency(mediaDiaria),   sub: diasUteis + " dias úteis decorridos",        color: "" },
    { label: "Necessário / Dia Útil",  value: fmtCurrency(Math.max(0, necessarioDia)), sub: diasUteisRestantes + " dias úteis restantes", color: necessarioDia > mediaDiaria * 1.4 ? "warn" : "" },
    { label: "Projeção Final Mês",     value: fmtCurrency(projecao),      sub: "vs " + fmtCurrency(totalBudget) + " planejado", color: projecao > totalBudget * 1.05 ? "danger" : projecao < totalBudget * 0.85 ? "warn" : "ok" },
    { label: "Reuniões",               value: String(totalReunoes),        sub: "CPR: " + (totalReunoes > 0 ? fmtCurrency(totalSpend / totalReunoes) : "—"), color: "" },
    { label: "Assinaturas",            value: String(totalAssn),           sub: "CPA: " + (totalAssn > 0 ? fmtCurrency(totalSpend / totalAssn) : "—"),    color: "" },
  ];

  const el = document.getElementById("finSummaryCards");
  if (el) el.innerHTML = cards.map(c => `
    <div class="fin-card${c.color ? ` fin-card--${c.color}` : ""}">
      <div class="fin-card-label">${c.label}</div>
      <div class="fin-card-value">${c.value}</div>
      <div class="fin-card-sub">${c.sub}</div>
    </div>`).join("");
}

function finRenderPlatform(campaigns, cfg, time) {
  const el = document.getElementById("finPlatformWrap");
  if (!el) return;
  const { diasUteis, diasUteisTotal } = time;

  const metaCamps   = campaigns.filter(c => c.platform === "Meta");
  const googleCamps = campaigns.filter(c => c.platform === "Google");
  const metaSpend   = metaCamps.reduce((s, c) => s + c.spend, 0);
  const googleSpend = googleCamps.reduce((s, c) => s + c.spend, 0);
  const metaReun    = metaCamps.reduce((s, c) => s + c.reunioes, 0);
  const googleReun  = gadsState.reunioes || 0;

  const rows = [
    { name: "Meta Ads",   budget: cfg.budgetMeta,   spend: metaSpend,   reunioes: metaReun,   field: "budgetMeta" },
    { name: "Google Ads", budget: cfg.budgetGoogle, spend: googleSpend, reunioes: googleReun, field: "budgetGoogle" },
  ];
  const totalBudget = cfg.budgetMeta + cfg.budgetGoogle;
  const totalSpend  = metaSpend + googleSpend;
  const totalReun   = metaReun + googleReun;

  function rowHtml(r) {
    const remaining = r.budget - r.spend;
    const pct       = r.budget > 0 ? r.spend / r.budget : 0;
    const proj      = diasUteis > 0 && diasUteisTotal > 0 ? (r.spend / diasUteis) * diasUteisTotal : r.spend;
    const cpr       = r.reunioes > 0 ? r.spend / r.reunioes : 0;
    const projMeet  = cpr > 0 && r.budget > 0 ? Math.round(r.budget / cpr) : 0;
    return `<tr>
      <td class="fin-td-name">${r.name}</td>
      <td class="fin-td-num fin-budget-cell" data-field="${r.field}" data-val="${r.budget}">${fmtCurrency(r.budget)} <span class="fin-edit-icon">✏️</span></td>
      <td class="fin-td-num">${fmtCurrency(r.spend)}</td>
      <td class="fin-td-num ${remaining < 0 ? "fin-neg" : ""}">${fmtCurrency(remaining)}</td>
      <td class="fin-td-num">${fmtPct(pct * 100)}</td>
      <td class="fin-td-num">${fmtCurrency(proj)}</td>
      <td class="fin-td-num">${r.reunioes}</td>
      <td class="fin-td-num">${cpr > 0 ? fmtCurrency(cpr) : "—"}</td>
      <td class="fin-td-num">${projMeet > 0 ? projMeet : "—"}</td>
    </tr>`;
  }

  const totalPct  = totalBudget > 0 ? totalSpend / totalBudget : 0;
  const totalProj = diasUteis > 0 && diasUteisTotal > 0 ? (totalSpend / diasUteis) * diasUteisTotal : totalSpend;
  el.innerHTML = `
    <table class="fin-table">
      <thead><tr>
        <th>Plataforma</th><th class="fin-th-num">Orçamento</th><th class="fin-th-num">Gasto</th>
        <th class="fin-th-num">Restante</th><th class="fin-th-num">% Consumido</th>
        <th class="fin-th-num">Projeção Final</th><th class="fin-th-num">Reuniões</th>
        <th class="fin-th-num">CPR</th><th class="fin-th-num">Reuniões Proj.</th>
      </tr></thead>
      <tbody>
        ${rows.map(rowHtml).join("")}
        <tr class="fin-tr-total">
          <td>Total</td>
          <td class="fin-td-num">${fmtCurrency(totalBudget)}</td>
          <td class="fin-td-num">${fmtCurrency(totalSpend)}</td>
          <td class="fin-td-num ${totalSpend > totalBudget ? "fin-neg" : ""}">${fmtCurrency(totalBudget - totalSpend)}</td>
          <td class="fin-td-num">${fmtPct(totalPct * 100)}</td>
          <td class="fin-td-num">${fmtCurrency(totalProj)}</td>
          <td class="fin-td-num">${totalReun}</td>
          <td class="fin-td-num">—</td><td class="fin-td-num">—</td>
        </tr>
      </tbody>
    </table>`;

  el.querySelectorAll(".fin-budget-cell").forEach(cell => {
    cell.style.cursor = "pointer";
    cell.addEventListener("click", () => finInlineEditNumber(cell, cell.dataset.field, null, renderFinanceiro));
  });
}

function finRenderInitiatives(campaigns, cfg, time) {
  const el = document.getElementById("finInitWrap");
  if (!el) return;
  const { diasUteis, diasUteisTotal } = time;

  const initStats = { "": { name: "Sem Iniciativa", budget: 0, spend: 0, leads: 0, reunioes: 0, assinaturas: 0 } };
  for (const i of cfg.initiatives) {
    initStats[i.id] = { name: i.name, budget: i.budget || 0, spend: 0, leads: 0, reunioes: 0, assinaturas: 0 };
  }
  for (const c of campaigns) {
    const id = (c.initId && initStats[c.initId]) ? c.initId : "";
    initStats[id].spend       += c.spend;
    initStats[id].leads       += c.leads;
    initStats[id].reunioes    += c.reunioes;
    initStats[id].assinaturas += c.assinaturas;
  }

  function initRowHtml(id, stat) {
    const cpr      = stat.reunioes > 0 ? stat.spend / stat.reunioes : 0;
    const projMeet = cpr > 0 && stat.budget > 0 ? Math.round(stat.budget / cpr) : 0;
    const pct      = stat.budget > 0 ? stat.spend / stat.budget : 0;
    const proj     = diasUteis > 0 && diasUteisTotal > 0 ? (stat.spend / diasUteis) * diasUteisTotal : stat.spend;
    const isNone   = id === "";
    return `<tr class="${isNone ? "fin-tr-muted" : ""}">
      <td class="fin-td-name">
        ${isNone
          ? stat.name
          : `<span class="fin-init-name" data-initid="${escapeHtml(id)}">${escapeHtml(stat.name)} <span class="fin-edit-icon">✏️</span></span>`}
      </td>
      <td class="fin-td-num ${isNone ? "" : "fin-budget-init-cell"}" data-initid="${escapeHtml(id)}" data-val="${stat.budget}">
        ${isNone ? "—" : `${fmtCurrency(stat.budget)} <span class="fin-edit-icon">✏️</span>`}
      </td>
      <td class="fin-td-num">${fmtCurrency(stat.spend)}</td>
      <td class="fin-td-num">${stat.budget > 0 ? fmtPct(pct * 100) : "—"}</td>
      <td class="fin-td-num">${fmtCurrency(proj)}</td>
      <td class="fin-td-num">${stat.reunioes}</td>
      <td class="fin-td-num">${stat.assinaturas}</td>
      <td class="fin-td-num">${cpr > 0 ? fmtCurrency(cpr) : "—"}</td>
      <td class="fin-td-num">${projMeet > 0 ? projMeet : "—"}</td>
      <td>${isNone ? "" : `<button class="fin-del-init-btn btn btn--ghost btn--xs" data-initid="${escapeHtml(id)}">🗑️</button>`}</td>
    </tr>`;
  }

  el.innerHTML = `
    <table class="fin-table">
      <thead><tr>
        <th>Iniciativa</th><th class="fin-th-num">Orçamento</th><th class="fin-th-num">Gasto</th>
        <th class="fin-th-num">% Consumido</th><th class="fin-th-num">Projeção Final</th>
        <th class="fin-th-num">Reuniões</th><th class="fin-th-num">Assinaturas</th>
        <th class="fin-th-num">CPR</th><th class="fin-th-num">Reuniões Proj.</th><th></th>
      </tr></thead>
      <tbody>
        ${cfg.initiatives.map(i => initRowHtml(i.id, initStats[i.id] || { name: i.name, budget: i.budget || 0, spend: 0, leads: 0, reunioes: 0, assinaturas: 0 })).join("")}
        ${initRowHtml("", initStats[""])}
      </tbody>
    </table>
    <div class="fin-init-actions">
      <button id="finAddInitBtn" class="btn btn--ghost btn--sm">+ Nova Iniciativa</button>
    </div>`;

  el.querySelectorAll(".fin-init-name").forEach(span => {
    span.style.cursor = "pointer";
    span.addEventListener("click", () => {
      const id   = span.dataset.initid;
      const cfg2 = finGetConfig();
      const init = cfg2.initiatives.find(i => i.id === id);
      if (!init) return;
      const input = document.createElement("input");
      input.type  = "text";
      input.value = init.name;
      input.className = "fin-inline-input";
      span.replaceWith(input);
      input.focus(); input.select();
      const save = () => { const v = input.value.trim(); if (v) { init.name = v; finSaveConfig(cfg2); } renderFinanceiro(); };
      input.addEventListener("blur", save);
      input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } if (e.key === "Escape") renderFinanceiro(); });
    });
  });

  el.querySelectorAll(".fin-budget-init-cell").forEach(cell => {
    cell.style.cursor = "pointer";
    cell.addEventListener("click", () => finInlineEditNumber(cell, null, cell.dataset.initid, renderFinanceiro));
  });

  el.querySelectorAll(".fin-del-init-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id   = btn.dataset.initid;
      const cfg2 = finGetConfig();
      cfg2.initiatives = cfg2.initiatives.filter(i => i.id !== id);
      for (const k of Object.keys(cfg2.campaignInit)) {
        if (cfg2.campaignInit[k] === id) delete cfg2.campaignInit[k];
      }
      finSaveConfig(cfg2); renderFinanceiro();
    });
  });

  const addBtn = document.getElementById("finAddInitBtn");
  if (addBtn) {
    addBtn.addEventListener("click", () => {
      const cfg2 = finGetConfig();
      cfg2.initiatives.push({ id: `init_${Date.now()}`, name: "Nova Iniciativa", budget: 0 });
      finSaveConfig(cfg2); renderFinanceiro();
    });
  }
}

function finRenderCampaignTable(campaigns, cfg) {
  const el = document.getElementById("finCampsWrap");
  if (!el) return;
  const initOptions = [{ id: "", name: "— Sem Iniciativa —" }, ...cfg.initiatives];
  const totalSpend  = campaigns.reduce((s, c) => s + c.spend, 0);

  function campRow(c) {
    const pctOrc = totalSpend > 0 ? c.spend / totalSpend : 0;
    const selOpts = initOptions.map(o =>
      `<option value="${escapeHtml(o.id)}" ${c.initId === o.id ? "selected" : ""}>${escapeHtml(o.name)}</option>`
    ).join("");
    return `<tr>
      <td class="fin-td-platform fin-badge--${c.platform === "Meta" ? "meta" : "google"}">${c.platform}</td>
      <td class="fin-td-campname" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</td>
      <td><select class="fin-init-select" data-campkey="${escapeHtml(c.platform + "|" + c.name)}">${selOpts}</select></td>
      <td class="fin-td-num">${fmtCurrency(c.spend)}</td>
      <td class="fin-td-num">${fmtInt(c.impressions)}</td>
      <td class="fin-td-num">${fmtInt(c.clicks)}</td>
      <td class="fin-td-num">${fmtPct(c.ctr * 100)}</td>
      <td class="fin-td-num">${c.cpc > 0 ? fmtCurrency(c.cpc) : "—"}</td>
      <td class="fin-td-num">${c.leads > 0 ? c.leads : "0"}</td>
      <td class="fin-td-num">${c.reunioes}</td>
      <td class="fin-td-num">${c.assinaturas}</td>
      <td class="fin-td-num">${c.cpl > 0 ? fmtCurrency(c.cpl) : "—"}</td>
      <td class="fin-td-num">${c.cpaReuniao > 0 ? fmtCurrency(c.cpaReuniao) : "—"}</td>
      <td class="fin-td-num">${c.cpaAssn > 0 ? fmtCurrency(c.cpaAssn) : "—"}</td>
      <td class="fin-td-num">${fmtPct(pctOrc * 100)}</td>
    </tr>`;
  }

  el.innerHTML = `
    <table class="fin-table">
      <thead><tr>
        <th>Plataforma</th><th>Campanha</th><th>Iniciativa</th>
        <th class="fin-th-num">Gasto</th><th class="fin-th-num">Impressões</th>
        <th class="fin-th-num">Cliques</th><th class="fin-th-num">CTR</th>
        <th class="fin-th-num">CPC</th><th class="fin-th-num">Leads</th>
        <th class="fin-th-num">Reuniões</th><th class="fin-th-num">Assinaturas</th>
        <th class="fin-th-num">CPL</th><th class="fin-th-num">CPA Reunião</th>
        <th class="fin-th-num">CPA Ass.</th><th class="fin-th-num">% Gasto</th>
      </tr></thead>
      <tbody>${[...campaigns].sort((a, b) => b.spend - a.spend).map(campRow).join("")}</tbody>
    </table>`;

  el.querySelectorAll(".fin-init-select").forEach(sel => {
    sel.addEventListener("change", () => {
      const cfg2 = finGetConfig();
      const key  = sel.dataset.campkey;
      if (sel.value) { cfg2.campaignInit[key] = sel.value; }
      else           { delete cfg2.campaignInit[key]; }
      finSaveConfig(cfg2); renderFinanceiro();
    });
  });
}

function finRenderCharts(campaigns, cfg) {
  const metaSpend   = campaigns.filter(c => c.platform === "Meta").reduce((s, c) => s + c.spend, 0);
  const googleSpend = campaigns.filter(c => c.platform === "Google").reduce((s, c) => s + c.spend, 0);

  const canvP = document.getElementById("finChartPlatform");
  if (canvP) {
    if (_finChartPlatform) { _finChartPlatform.destroy(); _finChartPlatform = null; }
    if (metaSpend > 0 || googleSpend > 0) {
      _finChartPlatform = new Chart(canvP, {
        type: "doughnut",
        data: {
          labels: ["Meta Ads", "Google Ads"],
          datasets: [{ data: [metaSpend, googleSpend], backgroundColor: ["#1877f2", "#34a853"], borderWidth: 2, borderColor: "rgba(255,255,255,.8)" }]
        },
        options: {
          plugins: { legend: { position: "bottom" }, tooltip: { callbacks: { label: ctx => ` ${fmtCurrency(ctx.raw)}` } } },
          cutout: "62%",
        }
      });
    }
  }

  const initData = { "": { name: "Sem Iniciativa", spend: 0 } };
  for (const i of cfg.initiatives) initData[i.id] = { name: i.name, spend: 0 };
  for (const c of campaigns) {
    const id = (c.initId && initData[c.initId]) ? c.initId : "";
    initData[id].spend += c.spend;
  }
  const nonZero   = Object.values(initData).filter(d => d.spend > 0);
  const initLabels = nonZero.map(d => d.name);
  const initValues = nonZero.map(d => d.spend);
  const colors     = ["#6366f1", "#f59e0b", "#10b981", "#3b82f6", "#ef4444", "#8b5cf6", "#f97316"];

  const canvI = document.getElementById("finChartInit");
  if (canvI) {
    if (_finChartInit) { _finChartInit.destroy(); _finChartInit = null; }
    if (initValues.length) {
      _finChartInit = new Chart(canvI, {
        type: "bar",
        data: {
          labels: initLabels,
          datasets: [{ label: "Investimento", data: initValues, backgroundColor: initLabels.map((_, i) => colors[i % colors.length]), borderRadius: 4 }]
        },
        options: {
          indexAxis: "y",
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${fmtCurrency(ctx.raw)}` } } },
          scales: { x: { ticks: { callback: v => fmtCurrency(v) }, grid: { color: "rgba(0,0,0,.05)" } } }
        }
      });
    }
  }
}

// ─── Helper: inline number edit on a table cell ───────────────────────────────
// field: budgetMeta/budgetGoogle (platform budget) OR initId (initiative budget)
function finInlineEditNumber(cell, field, initId, onSave) {
  const curVal = parseFloat(cell.dataset.val) || 0;
  const input  = document.createElement("input");
  input.type = "number"; input.value = curVal; input.min = "0"; input.step = "100";
  input.className = "fin-inline-input";
  cell.innerHTML = ""; cell.appendChild(input);
  input.focus(); input.select();
  const save = () => {
    const newVal = parseFloat(input.value);
    if (isNaN(newVal) || newVal < 0) { onSave(); return; }
    const cfg2 = finGetConfig();
    if (field) {
      cfg2[field] = newVal;
    } else if (initId) {
      const init = cfg2.initiatives.find(i => i.id === initId);
      if (init) init.budget = newVal;
    }
    finSaveConfig(cfg2); onSave();
  };
  input.addEventListener("blur", save);
  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } if (e.key === "Escape") onSave(); });
}

// ── Versão no footer ──────────────────────────────────────────────────────────
fetch("/api/version")
  .then(r => r.json())
  .then(({ version, commit, env }) => {
    const el = document.getElementById("app-version");
    if (el) el.textContent = `v${version} · ${commit} · ${env}`;
  })
  .catch(() => {});
