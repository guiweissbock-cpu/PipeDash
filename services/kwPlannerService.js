/**
 * kwPlannerService.js
 * Keyword Planner IA — lógica do planejador iterativo.
 * Gera hipóteses, consulta a API, pontua e repete até atingir a meta.
 */

const googleAdsService = require("./googleAdsService");
const quota            = require("./quotaManager");

// =============================================================================
// CLASSIFICAÇÃO DE INTENÇÃO
// =============================================================================

const INTENT_PATTERNS = {
  "Fundo de funil": [
    "contratar", "contratar treinamento", "empresa de treinamento",
    "melhor treinamento", "consultoria de performance", "consultoria comercial",
    "quanto custa treinamento", "preço treinamento", "investir em treinamento",
    "diagnóstico comercial", "diagnóstico de vendas", "proposta de treinamento",
    "solicitar diagnóstico", "falar com consultor", "contratar consultoria",
    "fechar com", "assinar", "plano de treinamento corporativo",
  ],
  "Meio de funil": [
    "como aumentar", "como melhorar", "como estruturar", "como criar",
    "como montar", "como implementar", "como desenvolver", "como formar",
    "como gerir", "como liderar", "como organizar", "como treinar",
    "melhores práticas", "melhores praticas", "estratégia de vendas",
    "estrategia de vendas", "técnicas de vendas", "tecnicas de vendas",
    "como fazer gestão", "como engajar", "playbook de vendas",
  ],
  "Topo de funil": [
    "o que é", "o que sao", "o que são", "significado", "conceito de",
    "diferença entre", "diferenca entre", "tipos de vendas", "exemplos de",
    "introdução a", "introducao a", "guia de vendas", "como funciona",
    "para que serve", "dicas de vendas", "como começar", "como comecar",
    "o que fazer para", "vantagens de",
  ],
  "Concorrentes": [
    "pipelovers", "pipe lovers", "gustavo pagotto", "academia pipelovers",
    "exact sales", "meetime", "ploomes", "pipedrive treinamento",
    "hubspot vendas", "salesforce training", "rdstation vendas",
    "vs pipelovers", "alternativa ao pipelovers", "concorrente de",
  ],
  "Problema/Dor": [
    "não bate meta", "nao bate meta", "não consigo vender", "nao consigo vender",
    "baixo desempenho", "não vende", "nao vende", "equipe travada",
    "melhorar resultado", "melhorar performance", "vendedores não performam",
    "vendedores nao performam", "não performam", "nao performam",
    "queda em vendas", "perder clientes", "falta de resultado",
    "sem resultado", "time fraco", "vendas caindo", "problema com vendas",
    "dificuldade em vender", "não fecha", "nao fecha",
  ],
  "Solução": [
    "plataforma de vendas", "universidade corporativa", "academia de vendas",
    "pdi para vendedores", "capacitação comercial", "capacitacao comercial",
    "desenvolvimento comercial", "programa de vendas", "metodologia de vendas",
    "processo de vendas", "máquina de vendas", "maquina de vendas",
    "gestão de pipeline", "onboarding comercial", "ramp up de vendedores",
  ],
  "Curso/Treinamento": [
    "treinamento de vendas", "curso de vendas", "workshop de vendas",
    "mentoria de vendas", "capacitação de vendas", "aula de vendas",
    "aprender sobre vendas", "certificação em vendas", "certificacao em vendas",
    "formação em vendas", "formacao em vendas", "treinamento para equipe",
    "curso para vendedores", "treinamento corporativo", "curso de gestão comercial",
    "treinamento de liderança comercial", "curso online de vendas",
  ],
};

function classifyIntent(keyword) {
  const kw = (keyword || "").toLowerCase();
  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    if (patterns.some(p => kw.includes(p))) return intent;
  }
  return "Genérica";
}

// =============================================================================
// GERAÇÃO DE ESTRATÉGIAS (10 tentativas)
// =============================================================================

function generateStrategies(subject, userSeeds, products) {
  const sub  = (subject || "vendas B2B").trim();
  const base = sub.toLowerCase().replace(/\s+/g, " ");

  const prodSeeds = (products || "")
    .split("\n").map(s => s.trim()).filter(Boolean).slice(0, 6);

  return [
    {
      name:        "Seeds do usuário",
      description: "Consulta as palavras-chave fornecidas diretamente",
      seeds:       userSeeds.length > 0 ? userSeeds : [sub],
    },
    {
      name:        "Variações de Dor",
      description: "Problemas e dificuldades percebidas pelo comprador",
      seeds: [
        `meu time de vendas não bate meta`,
        `minha equipe comercial não vende`,
        `não consigo escalar ${base}`,
        `vendedores não performam`,
        `como melhorar resultado comercial`,
        `equipe de vendas sem resultado`,
        `como resolver baixo desempenho comercial`,
        `dificuldade em ${base}`,
        `problema com ${base}`,
      ],
    },
    {
      name:        "Variações de Desejo",
      description: "Resultados aspirados e metas do comprador",
      seeds: [
        `como vender todos os dias ${base}`,
        `como criar receita recorrente ${base}`,
        `como criar previsibilidade em vendas`,
        `como escalar ${base}`,
        `como aumentar faturamento ${base}`,
        `crescimento previsível em vendas`,
        `alta performance comercial`,
        `dobrar vendas ${base}`,
        `como atingir meta comercial`,
      ],
    },
    {
      name:        "Variações de Solução",
      description: "Ferramentas, plataformas e metodologias",
      seeds: [
        `treinamento para equipe de vendas`,
        `plataforma de treinamento comercial`,
        `universidade corporativa de vendas`,
        `PDI para vendedores`,
        `capacitação comercial ${base}`,
        `programa de desenvolvimento comercial`,
        `como desenvolver equipe comercial`,
        ...prodSeeds,
      ].filter(Boolean),
    },
    {
      name:        "Foco em Gestor Comercial",
      description: "Termos buscados por líderes e gestores de vendas",
      seeds: [
        `como desenvolver líderes comerciais`,
        `como formar gestores de vendas`,
        `como criar rotina de gestão comercial`,
        `como estruturar equipe comercial`,
        `liderança comercial ${base}`,
        `gestão de time de vendas`,
        `como gerir equipe de vendas ${base}`,
      ],
    },
    {
      name:        "Foco em Operação Comercial",
      description: "Estruturação de processos e operação de vendas",
      seeds: [
        `como estruturar operação comercial`,
        `como criar máquina de vendas`,
        `como criar processo comercial previsível`,
        `como organizar equipe de vendas`,
        `operação comercial ${base}`,
        `pipeline de vendas ${base}`,
        `processo de vendas ${base}`,
        `máquina de vendas ${base}`,
      ],
    },
    {
      name:        "Combinações Amplas B2B",
      description: "Termos genéricos mas relevantes para o segmento",
      seeds: [
        `${base}`,
        `gestão comercial b2b`,
        `equipe comercial b2b`,
        `performance comercial b2b`,
        `pipeline de vendas b2b`,
        `vendas b2b`,
        `resultado comercial b2b`,
        `time de vendas b2b`,
      ],
    },
    {
      name:        "Long Tail — Alta Especificidade",
      description: "Combinações específicas com maior intenção de compra",
      seeds: [
        `como aumentar produtividade da equipe de vendas`,
        `como desenvolver vendedores com rotina comercial`,
        `como criar programa de treinamento comercial`,
        `como implementar PDI para equipe de vendas`,
        `como criar playbook de vendas b2b`,
        `como montar universidade corporativa de vendas`,
        `como criar cultura de alta performance em vendas`,
      ],
    },
    {
      name:        "Alta Intenção de Conversão",
      description: "Termos de fundo de funil com maior intenção de contratação",
      seeds: [
        `diagnóstico comercial ${base}`,
        `consultoria de performance comercial`,
        `treinamento corporativo para vendas ${base}`,
        `contratar treinamento de vendas`,
        `melhor plataforma de treinamento comercial`,
        `curso de vendas b2b para equipes`,
        `consultoria em gestão comercial b2b`,
      ],
    },
    {
      name:        "Plano Híbrido",
      description: "Top palavras de todas as tentativas anteriores",
      seeds:       [], // preenchido dinamicamente
    },
  ];
}

// =============================================================================
// SCORING
// =============================================================================

function scoreKeyword(k, config, existingKwSet = new Set()) {
  const { maxCpc = 0 } = config;
  const volume = k.volume  || 0;
  const avgCpc = k.avgCpc  || 0;
  const intent = classifyIntent(k.keyword);

  // Volume Score (0-100): escala log para lidar com grandes variações
  const volScore = volume > 0
    ? Math.min(Math.log10(volume + 1) / Math.log10(100001) * 100, 100)
    : 0;

  // Cost Score (0-100): CPC menor = melhor
  let costScore = 50;
  if (avgCpc > 0) {
    const ref = maxCpc > 0 ? maxCpc : 8;
    costScore = Math.max(0, Math.min(100, (1 - (avgCpc / (ref * 1.5))) * 100));
  }

  // Intent Score
  const intentMap = {
    "Fundo de funil":    100,
    "Problema/Dor":       90,
    "Curso/Treinamento":  85,
    "Solução":            80,
    "Concorrentes":       70,
    "Meio de funil":      65,
    "Topo de funil":      50,
    "Genérica":           35,
  };
  const intentScore = intentMap[intent] || 35;

  // History Score
  const kwLower = (k.keyword || "").toLowerCase();
  let historyScore = 50;
  let status = "Nova";
  if (existingKwSet.has(kwLower)) {
    historyScore = 45;
    status = "Já existe na conta";
  }

  // Score final ponderado
  const scoreFinal = (
    volScore    * 0.25 +
    costScore   * 0.20 +
    intentScore * 0.25 +
    historyScore * 0.30
  );

  // Estimativas de cliques e custo
  const buscasDia  = volume / 30.4;
  const ctr3  = Math.round(buscasDia * 0.03 * 10) / 10;
  const ctr5  = Math.round(buscasDia * 0.05 * 10) / 10;
  const ctr8  = Math.round(buscasDia * 0.08 * 10) / 10;
  const custoDia = Math.round(ctr5 * avgCpc * 100) / 100;
  const custoMes = Math.round(custoDia * 30.4 * 100) / 100;

  return {
    ...k,
    intent,
    status,
    scoreVolume:    Math.round(volScore),
    scoreCost:      Math.round(costScore),
    scoreIntencao:  intentScore,
    scoreHistorico: historyScore,
    scoreFinal:     Math.round(scoreFinal * 10) / 10,
    cliquesDay3:    ctr3,
    cliquesDay5:    ctr5,
    cliquesDay8:    ctr8,
    custoDia,
    custoMes,
  };
}

// =============================================================================
// CONSTRUÇÃO DO MELHOR PLANO
// =============================================================================

function buildBestPlan(keywordsMap, config) {
  const { goalClicksDay = 1200, dailyBudget = 1000, maxCpc = 0, maxKeywords = 50 } = config;
  const intents = config.intents || [];
  const hasIntentFilter = intents.length > 0;

  // Filter candidates: must have data, respect CPC limit and selected intents
  let candidates = Array.from(keywordsMap.values())
    .filter(k => k.volume > 0 && k.avgCpc > 0 && k.cliquesDay5 > 0)
    .filter(k => maxCpc <= 0 || k.avgCpc <= maxCpc)
    .filter(k => !hasIntentFilter || intents.includes(k.intent))
    .sort((a, b) => b.scoreFinal - a.scoreFinal);

  // Enforce exact word count — only slice when we have enough
  const exactCount = Number(maxKeywords) || 50;
  candidates = candidates.slice(0, exactCount);

  if (candidates.length === 0) {
    return {
      keywords: [],
      totalVolume: 0,
      avgCpc: 0,
      estimatedClicksDay: 0,
      estimatedCostDay: 0,
      estimatedCostMonth: 0,
      budgetNeeded: 0,
      gap: goalClicksDay,
      viability: "Insuficiente",
      avgScore: 0,
      recommendation: "Nenhuma palavra com dados encontrada.",
    };
  }

  const cpcs    = candidates.map(k => k.avgCpc).filter(Boolean);
  const avgCpc  = cpcs.reduce((s, c) => s + c, 0) / cpcs.length;
  const totalVol = candidates.reduce((s, k) => s + k.volume, 0);

  const estimatedClicksDay   = avgCpc > 0 ? Math.round(dailyBudget / avgCpc) : 0;
  const estimatedCostDay     = Math.round(goalClicksDay * avgCpc * 100) / 100;
  const estimatedCostMonth   = Math.round(estimatedCostDay * 30.4 * 100) / 100;
  const budgetNeeded         = Math.round(goalClicksDay * avgCpc * 100) / 100;
  const gap                  = Math.max(0, goalClicksDay - estimatedClicksDay);
  const avgScore             = Math.round(candidates.reduce((s, k) => s + k.scoreFinal, 0) / candidates.length * 10) / 10;

  const viability =
    estimatedClicksDay >= goalClicksDay        ? "Viável" :
    estimatedClicksDay >= goalClicksDay * 0.8  ? "Próximo da meta" :
    "Insuficiente";

  const recommendation = viability === "Viável"
    ? `Meta atingida. O orçamento de R$ ${dailyBudget}/dia é suficiente para ${estimatedClicksDay.toLocaleString("pt-BR")} cliques/dia.`
    : `Para ${goalClicksDay.toLocaleString("pt-BR")} cliques/dia, o orçamento necessário é R$ ${budgetNeeded.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}/dia (R$ ${(budgetNeeded * 30.4).toLocaleString("pt-BR", { minimumFractionDigits: 0 })}/mês).`;

  return {
    keywords: candidates,
    totalVolume: totalVol,
    avgCpc: Math.round(avgCpc * 100) / 100,
    estimatedClicksDay,
    estimatedCostDay,
    estimatedCostMonth,
    budgetNeeded,
    gap,
    viability,
    avgScore,
    recommendation,
  };
}

// =============================================================================
// RUNNER PRINCIPAL
// =============================================================================

async function runIterativePlanner(config, sendEvent) {
  const {
    subject, seeds: rawSeeds, products,
    maxAttempts = 10, goalClicksDay = 1200,
    existingKeywords = [],
  } = config;

  // ── ID único do plano para rastrear quota por plano ────────────────────────
  const planId = `plan-${Date.now()}`;

  // ── Verificação inicial de quota ───────────────────────────────────────────
  const initialQuota = quota.getStatus(planId);
  sendEvent({ type: "quota_status", quota: initialQuota });

  if (!quota.canAfford(quota.COST_PER_CALL, planId)) {
    const msg = initialQuota.alertLevel === "critical"
      ? `Quota diária segura esgotada (${initialQuota.totalUsed}/${initialQuota.safeLimit} ops). Retome amanhã.`
      : `Orçamento do plano esgotado (${initialQuota.planUsed}/${initialQuota.perPlanLimit} ops).`;
    sendEvent({ type: "error", error: msg, quota: initialQuota });
    return;
  }

  const apiOpts = {
    network:    config.network    || "GOOGLE_SEARCH",
    language:   config.language   || "languageConstants/1014",
    geoTargets: config.geoTargets || ["geoTargetConstants/2076"],
  };

  const userSeeds   = (rawSeeds || "").split("\n").map(s => s.trim()).filter(Boolean);
  const existingSet = new Set(existingKeywords.map(k => k.toLowerCase()));
  const strategies  = generateStrategies(subject, userSeeds, products);
  const pool        = new Map();
  let   bestPlan    = null;
  let   goalReached = false;

  const limit = Math.min(Number(maxAttempts) || 10, 10);

  for (let i = 0; i < limit; i++) {
    const attempt  = i + 1;
    const strategy = strategies[i];

    // Estratégia 10: híbrido — usa top palavras do pool como seeds
    if (i === 9) {
      const topSeeds = Array.from(pool.values())
        .filter(k => k.volume > 0)
        .sort((a, b) => b.scoreFinal - a.scoreFinal)
        .slice(0, 15)
        .map(k => k.keyword);
      strategy.seeds       = topSeeds.length > 0 ? topSeeds : userSeeds;
      strategy.description = `Top ${strategy.seeds.length} palavras das tentativas anteriores`;
    }

    if (strategy.seeds.length === 0) continue;

    // ── Verifica orçamento antes de cada chamada ───────────────────────────
    const preStatus = quota.getStatus(planId);
    if (!quota.canAfford(quota.COST_PER_CALL, planId)) {
      console.log(`[KwPlanner] Plano ${planId} sem orçamento após tentativa ${attempt - 1}. Encerrando.`);
      sendEvent({ type: "quota_exceeded", attempt, quota: preStatus });
      break;
    }

    // ── Calcula pageSize que cabe no orçamento restante ────────────────────
    const pageSize = quota.affordablePageSize(planId, 200);

    sendEvent({
      type:         "attempt_start",
      attempt,
      maxAttempts:  limit,
      strategyName: strategy.name,
      strategyDesc: strategy.description,
      seedCount:    strategy.seeds.length,
      quota:        preStatus,
      pageSize,
    });

    let ideas    = [];
    let fromCache = false;

    // ── Tenta cache local antes de chamar a API ────────────────────────────
    const cached = quota.cacheGet(strategy.seeds, apiOpts);
    if (cached) {
      ideas     = cached;
      fromCache = true;
      console.log(`[KwPlanner] Tentativa ${attempt}: cache hit (${ideas.length} ideias, 0 ops)`);
    } else {
      // ── Chamada à API com controle de quota ────────────────────────────
      try {
        ideas = await googleAdsService.generateKeywordIdeas(strategy.seeds, {
          ...apiOpts,
          pageSize,
        });

        // Consome quota: custo fixo por chamada
        const opsUsed    = quota.COST_PER_CALL;
        const postStatus = quota.consume(opsUsed, planId);
        quota.cacheSet(strategy.seeds, apiOpts, ideas);

        // Alerta de quota após consumo
        if (postStatus.alertLevel === "warning") {
          sendEvent({ type: "quota_alert", level: "warning", quota: postStatus,
            message: `⚠️ Atenção: ${postStatus.pctUsed}% da quota segura consumida (${postStatus.totalUsed}/${postStatus.safeLimit} ops)` });
        } else if (postStatus.alertLevel === "critical") {
          sendEvent({ type: "quota_alert", level: "critical", quota: postStatus,
            message: `🚨 Quota segura esgotada! Parando novas consultas.` });
          // Processa o que veio e encerra
          _mergeIdeas(ideas, pool, config, existingSet, attempt, strategy.name);
          bestPlan = _updateBestPlan(pool, config, bestPlan);
          sendEvent(_buildCompleteEvent(attempt, strategy.name, ideas, pool, bestPlan, postStatus, fromCache));
          break;
        }
      } catch (err) {
        console.error(`[KwPlanner] Tentativa ${attempt} falhou:`, err.message);
        const isQuota = err.message.includes("Quota") || err.message.includes("RESOURCE_EXHAUSTED") || err.message.includes("exhausted");
        sendEvent({ type: "attempt_error", attempt, error: err.message, quota: quota.getStatus(planId) });
        if (isQuota) break; // para o loop imediatamente
        continue;
      }
    }

    // ── Pontua e faz merge no pool ─────────────────────────────────────────
    _mergeIdeas(ideas, pool, config, existingSet, attempt, strategy.name);
    bestPlan = _updateBestPlan(pool, config, bestPlan);

    const curStatus = quota.getStatus(planId);
    sendEvent(_buildCompleteEvent(attempt, strategy.name, ideas, pool, bestPlan, curStatus, fromCache));

    // Critério de conclusão: palavras suficientes E meta de cliques atingida
    const targetCount  = Number(config.maxKeywords) || 50;
    const intents      = config.intents || [];
    const hasFilter    = intents.length > 0;
    const qualified    = Array.from(pool.values())
      .filter(k => k.volume > 0 && k.avgCpc > 0 && k.cliquesDay5 > 0)
      .filter(k => !hasFilter || intents.includes(k.intent));
    const enoughWords  = qualified.length >= targetCount;
    const budgetViable = bestPlan?.viability !== "Insuficiente";

    if (enoughWords && budgetViable) {
      goalReached = true;
      sendEvent({ type: "goal_reached", attempt, quota: curStatus });
      break;
    } else if (enoughWords) {
      // Tem palavras suficientes mas orçamento ainda não é viável — emite aviso mas continua
      sendEvent({ type: "goal_reached", attempt, quota: curStatus });
    }

    // Pausa de 1s entre chamadas reais (não necessária para cache)
    if (!fromCache && i < limit - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  const finalPlan  = bestPlan || buildBestPlan(pool, config);
  const finalQuota = quota.getStatus(planId);

  sendEvent({
    type:        "complete",
    goalReached,
    bestPlan:    finalPlan,
    allKeywords: Array.from(pool.values()),
    poolSize:    pool.size,
    quota:       finalQuota,
  });
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

function _mergeIdeas(ideas, pool, config, existingSet, attempt, strategyName) {
  for (const idea of ideas) {
    const scored        = scoreKeyword(idea, config, existingSet);
    scored.attempt      = attempt;
    scored.strategyName = strategyName;
    const prev = pool.get(scored.keyword);
    if (!prev || scored.scoreFinal > prev.scoreFinal) {
      pool.set(scored.keyword, scored);
    }
  }
}

function _updateBestPlan(pool, config, prev) {
  const cur = buildBestPlan(pool, config);
  return (!prev || cur.estimatedClicksDay > (prev.estimatedClicksDay || 0)) ? cur : prev;
}

function _buildCompleteEvent(attempt, strategyName, ideas, pool, bestPlan, quotaStatus, fromCache) {
  const cur = buildBestPlan(pool, { ...bestPlan });
  return {
    type:          "attempt_complete",
    attempt,
    strategyName,
    ideasReturned: ideas.length,
    validIdeas:    ideas.filter(k => k.volume > 0).length,
    newKeywords:   ideas.length,
    poolSize:      pool.size,
    fromCache,
    quota:         quotaStatus,
    planSnapshot: {
      keywordCount:       bestPlan?.keywords?.length || 0,
      estimatedClicksDay: bestPlan?.estimatedClicksDay || 0,
      estimatedCostDay:   bestPlan?.estimatedCostDay || 0,
      avgCpc:             bestPlan?.avgCpc || 0,
      viability:          bestPlan?.viability || "Insuficiente",
      gap:                bestPlan?.gap || 0,
    },
  };
}

module.exports = { runIterativePlanner, classifyIntent, scoreKeyword, buildBestPlan };
