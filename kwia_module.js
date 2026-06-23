// =============================================================================
// KEYWORD PLANNER IA
// =============================================================================

const kwia = (() => {

  // State
  let _running     = false;
  let _abortCtrl   = null;
  let _allKeywords = [];
  let _bestPlan    = null;
  let _sortKey     = "scoreFinal";
  let _sortAsc     = false;
  let _filterText  = "";

  function $i(id) { return document.getElementById(id); }

  function fmtR(v) {
    if (v == null || isNaN(v)) return "—";
    return "R$ " + Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtN(v) {
    if (v == null || isNaN(v)) return "—";
    return Number(v).toLocaleString("pt-BR");
  }
  function fmtScore(v) {
    if (v == null || isNaN(v)) return "—";
    return Number(v).toFixed(1);
  }

  const COMP_LABEL = { LOW: "Baixa", MEDIUM: "Média", HIGH: "Alta", UNSPECIFIED: "—", UNKNOWN: "—" };

  function intentBadge(intent) {
    var slug = (intent || "")
      .replace(/\/+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/[^\w-]/g, function(c) {
        var map = { "á":"a","à":"a","ã":"a","â":"a","é":"e","ê":"e","í":"i","ó":"o","õ":"o","ô":"o","ú":"u","ç":"c" };
        return map[c] || "";
      });
    return '<span class="kwia-intent-badge kwia-intent--' + slug + '">' + escHtml(intent) + "</span>";
  }
  function statusBadge(status) {
    const cls = status === "Nova" ? "kwia-status--Nova"
              : status.includes("existe") ? "kwia-status--exist"
              : status.includes("resultado") ? "kwia-status--bad"
              : "kwia-status--Nova";
    return '<span class="kwia-status-badge ' + cls + '">' + status + "</span>";
  }
  function viabilityBadge(v) {
    return v === "Viável" ? "kwia-badge--viable"
         : v === "Próximo da meta" ? "kwia-badge--close"
         : "kwia-badge--bad";
  }

  function escHtml(str) {
    return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  // Config
  function getConfig() {
    return {
      subject:      ($i("kwiaSubject") || {}).value || "Vendas B2B",
      seeds:        ($i("kwiaSeeds")   || {}).value || "",
      products:     ($i("kwiaProducts")|| {}).value || "",
      url:          ($i("kwiaUrl")     || {}).value || "",
      geoTargets:   [($i("kwiaCountry") || {}).value  || "geoTargetConstants/2076"],
      language:     ($i("kwiaLanguage")|| {}).value || "languageConstants/1014",
      network:      ($i("kwiaNetwork") || {}).value || "GOOGLE_SEARCH",
      goalClicksDay:  Number(($i("kwiaGoalClicks")  || {}).value) || 1200,
      dailyBudget:    Number(($i("kwiaDailyBudget") || {}).value) || 1000,
      maxCpc:         Number(($i("kwiaMaxCpc")      || {}).value) || 0,
      matchType:    ($i("kwiaMatchType") || {}).value || "BROAD",
      intents: (function() {
        var checks = document.querySelectorAll(".kwia-intent-check:checked");
        return Array.prototype.map.call(checks, function(c) { return c.value; });
      })(),
      maxAttempts:    Number(($i("kwiaMaxAttempts") || {}).value) || 10,
      maxKeywords:    Number(($i("kwiaMaxKeywords") || {}).value) || 50,
      existingKeywords: (typeof state !== "undefined" && state.gadsKeywords || [])
        .map(function(k) { return (k.keyword || "").toLowerCase(); }).filter(Boolean),
    };
  }

  // Progress
  function updateProgress(evt) {
    if (evt.type === "attempt_start") {
      $i("kwiaProgAttempt").textContent  = evt.attempt + " / " + evt.maxAttempts;
      $i("kwiaProgStrategy").textContent = evt.strategyName;
      $i("kwiaProgStatus").textContent   = "Consultando API… (" + evt.seedCount + " seeds)";
      $i("kwiaProgressBar").style.width  = ((evt.attempt - 1) / evt.maxAttempts * 100) + "%";
      return;
    }
    if (evt.type === "attempt_error") {
      appendLog(evt.attempt, null, evt.error, null, true);
      return;
    }
    if (evt.type === "attempt_complete") {
      var snap = evt.planSnapshot || {};
      var cfg  = getConfig();
      $i("kwiaProgPool").textContent   = fmtN(evt.poolSize);
      $i("kwiaProgClicks").textContent = fmtN(snap.estimatedClicksDay);
      $i("kwiaProgGoal").textContent   = fmtN(cfg.goalClicksDay);
      $i("kwiaProgGap").textContent    = snap.gap > 0 ? fmtN(snap.gap) : "✅ 0";
      $i("kwiaProgCpc").textContent    = snap.avgCpc ? fmtR(snap.avgCpc) : "—";
      $i("kwiaProgStatus").textContent = snap.viability || "Calculando…";
      $i("kwiaProgressBar").style.width = (evt.attempt / evt.maxAttempts * 100) + "%";
      appendLog(evt.attempt, evt.strategyName, null, snap, false);
      return;
    }
    if (evt.type === "goal_reached") {
      $i("kwiaProgressBadge").textContent = "Meta atingida!";
      $i("kwiaProgressBadge").className   = "kwia-badge kwia-badge--viable";
      $i("kwiaProgStatus").textContent    = "Meta atingida!";
      return;
    }
    if (evt.type === "complete") {
      $i("kwiaProgressBar").style.width    = "100%";
      $i("kwiaProgressBadge").textContent  = evt.goalReached ? "Concluído ✅" : "Concluído";
      $i("kwiaProgressBadge").className    = "kwia-badge " + (evt.goalReached ? "kwia-badge--viable" : "kwia-badge--done");
    }
  }

  function appendLog(attempt, name, error, snap, isError) {
    var log = $i("kwiaAttemptLog");
    if (!log) return;
    var row = document.createElement("div");
    row.className = "kwia-attempt-row";
    if (isError) {
      row.innerHTML = '<span class="kwia-att-num">' + attempt + '</span>'
        + '<span class="kwia-att-name">' + escHtml(name || "Erro") + '</span>'
        + '<span class="kwia-att-err">' + escHtml(error) + '</span>';
    } else {
      var viab = (snap && snap.viability) || "";
      row.innerHTML = '<span class="kwia-att-num">' + attempt + '</span>'
        + '<span class="kwia-att-name">' + escHtml(name || "") + '</span>'
        + '<span class="kwia-att-stat">' + fmtN((snap && snap.estimatedClicksDay) || 0) + ' cli/dia · CPC ' + fmtR((snap && snap.avgCpc) || 0) + '</span>'
        + '<span class="' + (viab === "Viável" ? "kwia-att-ok" : "kwia-att-stat") + '">' + escHtml(viab) + '</span>';
    }
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  // Quota UI
  function updateQuotaUI(q) {
    if (!q) return;
    var panel = $i("kwiaQuotaPanel");
    if (panel) panel.hidden = false;

    var pctDaily = Math.min(100, q.pctUsed || 0);
    var barDaily = $i("kwiaQuotaBarDaily");
    if (barDaily) {
      barDaily.style.width = pctDaily + "%";
      barDaily.classList.remove("kwia-quota-bar-fill--warning", "kwia-quota-bar-fill--critical");
      if (q.alertLevel === "critical")     barDaily.classList.add("kwia-quota-bar-fill--critical");
      else if (q.alertLevel === "warning") barDaily.classList.add("kwia-quota-bar-fill--warning");
    }
    var countDaily = $i("kwiaQuotaCountDaily");
    if (countDaily) countDaily.textContent = fmtN(q.totalUsed || 0) + " / " + fmtN(q.safeLimit || 12000) + " ops";

    var pctPlan = q.perPlanLimit ? Math.min(100, Math.round((q.planUsed || 0) / q.perPlanLimit * 100)) : 0;
    var barPlan = $i("kwiaQuotaBarPlan");
    if (barPlan) {
      barPlan.style.width = pctPlan + "%";
      barPlan.classList.remove("kwia-quota-bar-fill--warning", "kwia-quota-bar-fill--critical");
      if (q.alertLevel === "critical")     barPlan.classList.add("kwia-quota-bar-fill--critical");
      else if (q.alertLevel === "warning") barPlan.classList.add("kwia-quota-bar-fill--warning");
    }
    var countPlan = $i("kwiaQuotaCountPlan");
    if (countPlan) countPlan.textContent = fmtN(q.planUsed || 0) + " / " + fmtN(q.perPlanLimit || 2400) + " ops";

    var alertEl = $i("kwiaQuotaAlert");
    if (alertEl) {
      if (q.alertLevel) {
        alertEl.hidden    = false;
        alertEl.className = "kwia-quota-alert kwia-quota-alert--" + q.alertLevel;
        alertEl.textContent = q.alertLevel === "critical" ? "🚨 Quota crítica!" : "⚠️ 80% da quota";
      } else {
        alertEl.hidden = true;
      }
    }

    var metaEl = $i("kwiaQuotaMeta");
    if (metaEl) {
      var n = q.cacheEntries || 0;
      metaEl.textContent = "Cache: " + n + " entr" + (n === 1 ? "ada" : "adas")
        + " · " + fmtN(q.totalRemaining || 0) + " ops restantes hoje";
    }
  }

  async function loadInitialQuota() {
    try {
      var r = await fetch("/api/keyword-planner/ia/quota").then(function(rr) { return rr.json(); });
      if (r.ok) updateQuotaUI(r);
    } catch (_) {}
  }

  // Render best plan
  function renderBestPlan(plan) {
    if (!plan) return;
    _bestPlan = plan;
    $i("kwiaBestPlanSection").hidden = false;
    $i("kwiaSavePlanBtn").disabled   = false;
    $i("kwiaExportBtn").disabled     = false;

    var badge = $i("kwiaPlanViabilityBadge");
    badge.textContent = plan.viability;
    badge.className   = "kwia-badge " + viabilityBadge(plan.viability);

    var cfg = getConfig();
    var cards = [
      { label: "Palavras no plano",      value: fmtN(plan.keywords && plan.keywords.length || 0) },
      { label: "Volume mensal total",    value: fmtN(plan.totalVolume), cls: "kwia-plan-card--accent" },
      { label: "Cliques estimados/dia",  value: fmtN(plan.estimatedClicksDay), cls: "kwia-plan-card--accent" },
      { label: "Meta de cliques/dia",    value: fmtN(cfg.goalClicksDay) },
      { label: "Gap de cliques",         value: plan.gap > 0 ? fmtN(plan.gap) : "✅ 0", cls: plan.gap > 0 ? "" : "kwia-plan-card--green" },
      { label: "CPC médio",              value: fmtR(plan.avgCpc) },
      { label: "Custo estimado/dia",     value: fmtR(plan.estimatedCostDay) },
      { label: "Custo estimado/mês",     value: fmtR(plan.estimatedCostMonth) },
      { label: "Orçamento necessário/dia", value: fmtR(plan.budgetNeeded) },
      { label: "Score médio",            value: fmtScore(plan.avgScore) },
    ];

    $i("kwiaPlanCards").innerHTML = cards.map(function(c) {
      return '<div class="kwia-plan-card ' + (c.cls || "") + '">'
        + '<span class="kwia-plan-card__label">' + c.label + '</span>'
        + '<span class="kwia-plan-card__value">' + c.value + '</span>'
        + '</div>';
    }).join("");

    $i("kwiaPlanRecommendation").textContent = plan.recommendation || "";
  }

  // Render table
  function renderTable(kws) {
    var section = $i("kwiaTableSection");
    var tbody   = $i("kwiaTableBody");
    var counter = $i("kwiaTableCount");
    if (!kws || !kws.length) { section.hidden = true; return; }
    section.hidden = false;

    var text = _filterText.toLowerCase();
    var visible = text ? kws.filter(function(k) { return (k.keyword || "").toLowerCase().indexOf(text) >= 0; }) : kws.slice();

    var checkedIntents = Array.prototype.map.call(
      document.querySelectorAll(".kwia-intent-check:checked"),
      function(c) { return c.value; }
    );
    if (checkedIntents.length > 0) {
      visible = visible.filter(function(k) { return checkedIntents.indexOf(k.intent) >= 0; });
    }

    visible = visible.sort(function(a, b) {
      var av = a[_sortKey] != null ? a[_sortKey] : 0;
      var bv = b[_sortKey] != null ? b[_sortKey] : 0;
      if (typeof av === "string") return _sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      return _sortAsc ? av - bv : bv - av;
    });

    counter.textContent = visible.length + " de " + kws.length + " palavras";

    tbody.innerHTML = visible.map(function(k) {
      var noData = !k.volume && !k.avgCpc;
      return "<tr>"
        + '<td style="text-align:center"><input type="checkbox" class="kwia-kw-check" data-kw="' + escHtml(k.keyword) + '" /></td>'
        + '<td style="font-weight:600;max-width:220px;word-break:break-word">' + escHtml(k.keyword) + "</td>"
        + '<td style="text-align:center">' + intentBadge(k.intent || "Genérica") + "</td>"
        + '<td style="text-align:center;font-size:.72rem;color:var(--text-muted)">' + (getConfig().matchType || "—") + "</td>"
        + '<td style="text-align:right">' + (noData ? '<span style="color:var(--text-muted)">sem dados</span>' : fmtN(k.volume)) + "</td>"
        + '<td style="text-align:right;font-weight:600;color:var(--accent)">' + (noData ? "—" : fmtN(k.cliquesDay5)) + "</td>"
        + '<td style="text-align:center;font-size:.75rem">' + (COMP_LABEL[k.competition] || "—") + "</td>"
        + '<td style="text-align:right">' + (k.lowCpc  ? fmtR(k.lowCpc)  : "—") + "</td>"
        + '<td style="text-align:right">' + (k.highCpc ? fmtR(k.highCpc) : "—") + "</td>"
        + '<td style="text-align:right;font-weight:600">' + (k.avgCpc ? fmtR(k.avgCpc) : "—") + "</td>"
        + '<td style="text-align:right">' + (noData ? "—" : fmtN(k.cliquesDay3)) + "</td>"
        + '<td style="text-align:right;font-weight:600">' + (noData ? "—" : fmtN(k.cliquesDay5)) + "</td>"
        + '<td style="text-align:right">' + (noData ? "—" : fmtN(k.cliquesDay8)) + "</td>"
        + '<td style="text-align:right">' + (noData ? "—" : fmtR(k.custoDia)) + "</td>"
        + '<td style="text-align:right">' + (noData ? "—" : fmtR(k.custoMes)) + "</td>"
        + '<td style="text-align:right">' + (k.scoreVolume    != null ? k.scoreVolume    : "—") + "</td>"
        + '<td style="text-align:right">' + (k.scoreCost      != null ? k.scoreCost      : "—") + "</td>"
        + '<td style="text-align:right">' + (k.scoreIntencao  != null ? k.scoreIntencao  : "—") + "</td>"
        + '<td style="text-align:right">' + (k.scoreHistorico != null ? k.scoreHistorico : "—") + "</td>"
        + '<td style="text-align:right;font-weight:700;color:var(--accent)">' + fmtScore(k.scoreFinal) + "</td>"
        + '<td style="text-align:center">' + statusBadge(k.status || "Nova") + "</td>"
        + '<td style="text-align:center;font-size:.72rem;color:var(--text-muted)">' + (k.attempt || 1) + "</td>"
        + "</tr>";
    }).join("");

    updatePublishBtn();
  }

  // Simulator
  function renderSimulator() {
    var section = $i("kwiaSimSection");
    if (!_allKeywords.length) { section.hidden = true; return; }
    section.hidden = false;
    recalcSim();
  }

  function recalcSim() {
    var budget = Number(($i("kwiaSimBudget") || {}).value) || 1000;
    var maxCpc = Number(($i("kwiaSimMaxCpc") || {}).value) || 0;
    var goal   = Number(($i("kwiaSimGoal")   || {}).value) || 1200;

    var selected = getSelectedKeywords();
    var pool = selected.length > 0 ? selected : _allKeywords;
    var candidates = pool.filter(function(k) {
      return k.volume > 0 && k.avgCpc > 0 && (maxCpc <= 0 || k.avgCpc <= maxCpc);
    });

    if (!candidates.length) {
      $i("kwiaSimResults").innerHTML = '<p style="color:var(--text-muted);font-size:.85rem">Nenhuma palavra com dados suficientes.</p>';
      return;
    }

    var avgCpc    = candidates.reduce(function(s, k) { return s + k.avgCpc; }, 0) / candidates.length;
    var totalVol  = candidates.reduce(function(s, k) { return s + k.volume; }, 0);
    var clicksDay = Math.round(budget / avgCpc);
    var costDay   = Math.round(goal * avgCpc * 100) / 100;
    var costMonth = Math.round(costDay * 30.4);
    var gap       = Math.max(0, goal - clicksDay);
    var viability = clicksDay >= goal ? "Viável"
                  : clicksDay >= goal * 0.8 ? "Próximo da meta" : "Insuficiente";

    var items = [
      { label: "Palavras selecionadas", value: fmtN(candidates.length) },
      { label: "Volume mensal total",   value: fmtN(totalVol) },
      { label: "CPC médio",             value: fmtR(avgCpc) },
      { label: "Cliques estimados/dia", value: fmtN(clicksDay) },
      { label: "Meta de cliques/dia",   value: fmtN(goal) },
      { label: "Gap de cliques",        value: gap > 0 ? fmtN(gap) : "✅ 0" },
      { label: "Custo p/ meta/dia",     value: fmtR(costDay) },
      { label: "Custo mensal",          value: fmtR(costMonth) },
      { label: "Viabilidade",           value: viability },
    ];

    $i("kwiaSimResults").innerHTML = items.map(function(i) {
      return '<div class="kwia-sim-card">'
        + '<div class="kwia-sim-card__label">' + i.label + "</div>"
        + '<div class="kwia-sim-card__value">' + i.value + "</div>"
        + "</div>";
    }).join("");
  }

  // Export CSV
  function exportCSV() {
    if (!_allKeywords.length) return;
    var headers = ["keyword","intencao","status","volume_mensal","cliques_dia","concorrencia",
      "cpc_min","cpc_max","cpc_medio","cliques_dia_3pct","cliques_dia_5pct","cliques_dia_8pct",
      "custo_dia","custo_mes","score_volume","score_custo","score_intencao","score_historico","score_final",
      "tentativa","estrategia"];
    var rows = _allKeywords.map(function(k) {
      return [k.keyword, k.intent, k.status, k.volume, k.cliquesDay5,
        COMP_LABEL[k.competition] || k.competition,
        k.lowCpc, k.highCpc, k.avgCpc,
        k.cliquesDay3, k.cliquesDay5, k.cliquesDay8,
        k.custoDia, k.custoMes,
        k.scoreVolume, k.scoreCost, k.scoreIntencao, k.scoreHistorico, k.scoreFinal,
        k.attempt, k.strategyName];
    });
    var csv = [headers].concat(rows).map(function(r) {
      return r.map(function(v) { return '"' + String(v != null ? v : "").replace(/"/g, '""') + '"'; }).join(",");
    }).join("\n");
    var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "keyword_planner_ia_" + new Date().toISOString().slice(0,10) + ".csv";
    a.click();
  }

  // Selection helpers
  function getSelectedKeywords() {
    var checks   = document.querySelectorAll(".kwia-kw-check:checked");
    var selected = new Set(Array.prototype.map.call(checks, function(c) { return c.dataset.kw; }));
    return _allKeywords.filter(function(k) { return selected.has(k.keyword); });
  }

  function updatePublishBtn() {
    var count = document.querySelectorAll(".kwia-kw-check:checked").length;
    var btn   = $i("kwiaPublishBtn");
    if (!btn) return;
    btn.disabled    = count === 0;
    btn.textContent = count > 0 ? ("+ Adicionar ao Google Ads (" + count + ")") : "+ Adicionar ao Google Ads";
  }

  // History
  var HISTORY_KEY = "kwia_history_v1";

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); }
    catch (_) { return []; }
  }
  function saveHistory(plans) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(plans.slice(0,20))); }
    catch (_) {}
  }

  function savePlan() {
    if (!_bestPlan) return;
    var cfg = getConfig();
    var plan = {
      id:          Date.now(),
      date:        new Date().toLocaleString("pt-BR"),
      subject:     cfg.subject,
      goalClicks:  cfg.goalClicksDay,
      budget:      cfg.dailyBudget,
      maxCpc:      cfg.maxCpc,
      intent:      cfg.intent,
      matchType:   cfg.matchType,
      totalWords:  _bestPlan.keywords && _bestPlan.keywords.length || 0,
      clicksEst:   _bestPlan.estimatedClicksDay,
      costEst:     _bestPlan.estimatedCostDay,
      viability:   _bestPlan.viability,
      recommendation: _bestPlan.recommendation,
      allKeywords: _allKeywords,
      bestPlan:    _bestPlan,
    };
    var history = loadHistory();
    history.unshift(plan);
    saveHistory(history);
    renderHistoryList();
    if (typeof showToast === "function") showToast("Plano salvo no histórico.", "success");
  }

  function renderHistoryList() {
    var list    = $i("kwiaHistoryList");
    var history = loadHistory();
    if (!history.length) {
      list.innerHTML = '<p style="color:var(--text-muted);font-size:.85rem;text-align:center;padding:20px">Nenhum plano salvo.</p>';
      return;
    }
    list.innerHTML = history.map(function(p) {
      return '<div class="kwia-history-item">'
        + '<div class="kwia-history-item__meta">'
        + '<div class="kwia-history-item__name">' + escHtml(p.subject) + "</div>"
        + '<div class="kwia-history-item__details">'
        + p.date + " · " + fmtN(p.totalWords) + " palavras · " + fmtN(p.clicksEst) + " cli/dia · "
        + fmtR(p.costEst) + "/dia · <strong>" + escHtml(p.viability) + "</strong>"
        + "</div></div>"
        + '<div class="kwia-history-item__actions">'
        + '<button class="btn btn--secondary" style="font-size:.75rem;padding:5px 10px" onclick="kwia._loadHistoryItem(' + p.id + ')">Abrir</button>'
        + '<button class="btn btn--secondary" style="font-size:.75rem;padding:5px 10px" onclick="kwia._exportHistoryItem(' + p.id + ')">CSV</button>'
        + '<button class="btn btn--secondary" style="font-size:.75rem;padding:5px 10px;color:var(--danger)" onclick="kwia._deleteHistoryItem(' + p.id + ')">✕</button>'
        + "</div></div>";
    }).join("");
  }

  function _loadHistoryItem(id) {
    var plan = loadHistory().filter(function(p) { return p.id === id; })[0];
    if (!plan) return;
    _allKeywords = plan.allKeywords || [];
    _bestPlan    = plan.bestPlan    || null;
    renderTable(_allKeywords);
    renderBestPlan(_bestPlan);
    renderSimulator();
    if (typeof showToast === "function") showToast("Plano carregado.", "success");
  }

  function _exportHistoryItem(id) {
    var plan = loadHistory().filter(function(p) { return p.id === id; })[0];
    if (!plan || !plan.allKeywords) return;
    var backup = _allKeywords;
    _allKeywords = plan.allKeywords;
    exportCSV();
    _allKeywords = backup;
  }

  function _deleteHistoryItem(id) {
    saveHistory(loadHistory().filter(function(p) { return p.id !== id; }));
    renderHistoryList();
  }

  // Publish modal
  async function openPublishModal() {
    var selected = getSelectedKeywords();
    if (!selected.length) {
      if (typeof showToast === "function") showToast("Selecione ao menos uma palavra-chave.", "error");
      return;
    }
    $i("kwiaModalCount").textContent = selected.length + " palavra" + (selected.length > 1 ? "s" : "") + " selecionada" + (selected.length > 1 ? "s" : "") + ".";
    $i("kwiaModalResult").style.display = "none";
    $i("kwiaModalConfirmBtn").disabled  = true;

    var campSel = $i("kwiaModalCampaign");
    campSel.innerHTML = '<option value="">Carregando…</option>';
    try {
      var r = await fetch("/api/keyword-planner/ia/campaigns").then(function(r) { return r.json(); });
      if (r.ok) {
        campSel.innerHTML = '<option value="">Selecione uma campanha</option>'
          + r.data.map(function(c) { return '<option value="' + c.id + '">' + escHtml(c.name) + " (" + c.status + ")</option>"; }).join("");
      } else {
        campSel.innerHTML = '<option value="">Erro: ' + (r.error || "desconhecido") + "</option>";
      }
    } catch (_) { campSel.innerHTML = '<option value="">Erro ao carregar campanhas</option>'; }

    updateModalConfirm(selected.length);
    $i("kwiaPublishModal").hidden = false;
  }

  function updateModalConfirm(kwCount) {
    var adGroup = ($i("kwiaModalAdGroup") || {}).value;
    var match   = ($i("kwiaModalMatch")   || {}).value;
    var status  = ($i("kwiaModalStatus")  || {}).value;
    var cpc     = ($i("kwiaModalCpc")     || {}).value;
    var ok      = !!adGroup;
    $i("kwiaModalConfirmBtn").disabled = !ok;
    $i("kwiaModalConfirm").innerHTML = ok
      ? "Você está prestes a adicionar <strong>" + kwCount + "</strong> palavra" + (kwCount > 1 ? "s" : "") + " ao Google Ads.<br>Correspondência: <strong>" + match + "</strong> · CPC máx: <strong>R$ " + cpc + "</strong> · Status: <strong>" + status + "</strong>."
      : "Selecione uma campanha e um grupo de anúncio para continuar.";
  }

  async function confirmPublish() {
    var selected  = getSelectedKeywords();
    var adGroupId = ($i("kwiaModalAdGroup") || {}).value;
    var matchType = ($i("kwiaModalMatch")   || {}).value;
    var cpcMaxBRL = Number(($i("kwiaModalCpc")    || {}).value) || 5;
    var status    = ($i("kwiaModalStatus")  || {}).value || "PAUSED";
    if (!adGroupId || !selected.length) return;

    $i("kwiaModalConfirmBtn").disabled = true;
    var resultEl = $i("kwiaModalResult");
    resultEl.style.display = "block";
    resultEl.style.color   = "var(--text-secondary)";
    resultEl.textContent   = "Adicionando palavras…";

    try {
      var r = await fetch("/api/keyword-planner/ia/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adGroupId: adGroupId, keywords: selected.map(function(k) { return k.keyword; }), cpcMaxBRL: cpcMaxBRL, matchType: matchType, status: status }),
      }).then(function(r) { return r.json(); });

      if (r.ok) {
        resultEl.style.color = "var(--green)";
        resultEl.textContent = "✅ " + r.added + " palavra" + (r.added > 1 ? "s" : "") + " adicionada" + (r.added > 1 ? "s" : "") + " com sucesso!";
        if (typeof showToast === "function") showToast(r.added + " palavras adicionadas ao Google Ads (pausadas).", "success");
        setTimeout(function() { $i("kwiaPublishModal").hidden = true; }, 2000);
      } else {
        throw new Error(r.error || "Erro desconhecido");
      }
    } catch (err) {
      resultEl.style.color = "var(--danger)";
      resultEl.textContent = "Erro: " + err.message;
      $i("kwiaModalConfirmBtn").disabled = false;
    }
  }

  // Main runner
  async function run() {
    if (_running) return;
    _running     = true;
    _allKeywords = [];
    _bestPlan    = null;
    _abortCtrl   = new AbortController();

    $i("kwiaRunBtn").disabled    = true;
    $i("kwiaStopBtn").disabled   = false;
    $i("kwiaSavePlanBtn").disabled = true;
    $i("kwiaExportBtn").disabled   = true;
    $i("kwiaPublishBtn").disabled  = true;

    $i("kwiaProgressSection").hidden  = false;
    $i("kwiaBestPlanSection").hidden  = true;
    $i("kwiaTableSection").hidden     = true;
    $i("kwiaSimSection").hidden       = true;
    $i("kwiaProgressBar").style.width = "0%";
    $i("kwiaProgressBadge").textContent = "Em andamento";
    $i("kwiaProgressBadge").className   = "kwia-badge kwia-badge--running";
    $i("kwiaAttemptLog").innerHTML      = "";
    // Reset plan bar for new execution
    if ($i("kwiaQuotaBarPlan"))  $i("kwiaQuotaBarPlan").style.width  = "0%";
    if ($i("kwiaQuotaCountPlan")) $i("kwiaQuotaCountPlan").textContent = "0 / 2.400 ops";
    if ($i("kwiaQuotaPanel"))    $i("kwiaQuotaPanel").hidden = false;

    var config = getConfig();

    try {
      var resp = await fetch("/api/keyword-planner/ia/run", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(config),
        signal:  _abortCtrl.signal,
      });

      if (!resp.ok) {
        var body = await resp.text().catch(function() { return ""; });
        var errMsg;
        try { errMsg = JSON.parse(body).error; } catch (_) {}
        if (!errMsg) {
          errMsg = resp.status === 404
            ? "Endpoint não encontrado — reinicie o servidor com: node server.js"
            : "HTTP " + resp.status + (body ? ": " + body.slice(0, 120) : "");
        }
        throw new Error(errMsg);
      }

      var reader  = resp.body.getReader();
      var decoder = new TextDecoder();
      var buf     = "";

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        var lines = buf.split("\n");
        buf = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (!line.startsWith("data: ")) continue;
          var raw = line.slice(6).trim();
          if (raw === "[DONE]") break;
          try { handleEvent(JSON.parse(raw)); } catch (_) {}
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        if (typeof showToast === "function") showToast("Erro: " + err.message, "error");
        console.error("[KwIA]", err);
      }
    } finally {
      _running = false;
      $i("kwiaRunBtn").disabled  = false;
      $i("kwiaStopBtn").disabled = true;
    }
  }

  function handleEvent(evt) {
    updateProgress(evt);
    if (evt.type === "quota_status") {
      updateQuotaUI(evt.quota);
      return;
    }
    if (evt.type === "quota_alert") {
      updateQuotaUI(evt.quota);
      var msg = evt.message || (evt.level === "critical" ? "Quota crítica — operações esgotadas!" : "80% da quota diária consumida.");
      if (typeof showToast === "function") showToast((evt.level === "critical" ? "🚨 " : "⚠️ ") + msg, evt.level === "critical" ? "error" : "warning");
      return;
    }
    if (evt.type === "quota_exceeded") {
      updateQuotaUI(evt.quota);
      if (typeof showToast === "function") showToast("Quota do plano esgotada. Aguarde até amanhã ou use resultados do cache.", "error");
      return;
    }
    if (evt.type === "error") {
      if (typeof showToast === "function") showToast("Erro na API: " + evt.error, "error");
      console.error("[KwIA] Erro do servidor:", evt.error);
    }
    if (evt.type === "complete") {
      _allKeywords = evt.allKeywords || [];
      _bestPlan    = evt.bestPlan    || null;
      if (evt.quota) updateQuotaUI(evt.quota);
      if (_allKeywords.length === 0) {
        if (typeof showToast === "function") showToast("Nenhuma palavra retornada. Verifique as credenciais Google Ads no console do servidor.", "error");
      }
      renderBestPlan(_bestPlan);
      renderTable(_allKeywords);
      renderSimulator();
    }
  }

  function stop() {
    if (_abortCtrl) _abortCtrl.abort();
    if (typeof showToast === "function") showToast("Execução interrompida.", "info");
  }

  // Mostra confirmação se houver dados não salvos; se não houver, limpa direto.
  function clear() {
    if (_allKeywords.length > 0 || _bestPlan) {
      $i("kwiaClearModal").hidden = false;
    } else {
      _executeClear();
    }
  }

  // Reset total — sem reaproveitamento de contexto entre planos.
  async function _executeClear() {
    // Fecha modal se aberto
    var modal = $i("kwiaClearModal");
    if (modal) modal.hidden = true;

    // Para execução em andamento
    if (_abortCtrl) _abortCtrl.abort();
    _running  = false;

    // ── 1. Zera estado em memória ─────────────────────────────────────────
    _allKeywords = [];
    _bestPlan    = null;
    _filterText  = "";
    _sortKey     = "scoreFinal";
    _sortAsc     = false;

    // ── 2. Limpa campos de texto e textarea ───────────────────────────────
    ["kwiaSubject", "kwiaUrl"].forEach(function(id) {
      var el = $i(id);
      if (el) el.value = "";
    });
    ["kwiaSeeds", "kwiaProducts"].forEach(function(id) {
      var el = $i(id);
      if (el) el.value = "";
    });

    // ── 3. Restaura números para o default do HTML ─────────────────────────
    ["kwiaGoalClicks", "kwiaDailyBudget", "kwiaMaxCpc",
     "kwiaMaxAttempts", "kwiaMaxKeywords"].forEach(function(id) {
      var el = $i(id);
      if (el) el.value = el.defaultValue;
    });

    // ── 4. Restaura selects para a primeira opção ─────────────────────────
    ["kwiaCountry", "kwiaLanguage", "kwiaNetwork", "kwiaMatchType"].forEach(function(id) {
      var el = $i(id);
      if (el) el.selectedIndex = 0;
    });

    // ── 5. Desmarca todas as intenções ────────────────────────────────────
    document.querySelectorAll(".kwia-intent-check").forEach(function(c) {
      c.checked = false;
    });

    // ── 6. Zera simulador ─────────────────────────────────────────────────
    ["kwiaSimBudget", "kwiaSimMaxCpc", "kwiaSimGoal"].forEach(function(id) {
      var el = $i(id);
      if (el) el.value = el.defaultValue;
    });
    var simMatch = $i("kwiaSimMatch");
    if (simMatch) simMatch.selectedIndex = 0;
    if ($i("kwiaSimResults")) $i("kwiaSimResults").innerHTML = "";

    // ── 7. Limpa cache do servidor (sem herdar resultado de plano anterior)
    try { await fetch("/api/keyword-planner/ia/quota?clearCache=1"); } catch (_) {}

    // ── 8. Oculta seções de resultado ─────────────────────────────────────
    $i("kwiaProgressSection").hidden = true;
    $i("kwiaBestPlanSection").hidden = true;
    $i("kwiaTableSection").hidden    = true;
    $i("kwiaSimSection").hidden      = true;

    // ── 9. Reseta UI de progresso ─────────────────────────────────────────
    if ($i("kwiaAttemptLog")) $i("kwiaAttemptLog").innerHTML = "";
    if ($i("kwiaProgressBar")) $i("kwiaProgressBar").style.width = "0%";
    if ($i("kwiaProgressBadge")) {
      $i("kwiaProgressBadge").textContent = "Em andamento";
      $i("kwiaProgressBadge").className   = "kwia-badge kwia-badge--running";
    }

    // ── 10. Reseta barra de plano da quota (diária permanece) ─────────────
    if ($i("kwiaQuotaBarPlan"))   $i("kwiaQuotaBarPlan").style.width   = "0%";
    if ($i("kwiaQuotaCountPlan")) $i("kwiaQuotaCountPlan").textContent = "— / 2.400 ops";

    // ── 11. Reseta botões ─────────────────────────────────────────────────
    if ($i("kwiaRunBtn"))    $i("kwiaRunBtn").disabled    = false;
    if ($i("kwiaStopBtn"))   $i("kwiaStopBtn").disabled   = true;
    if ($i("kwiaExportBtn")) $i("kwiaExportBtn").disabled = true;
    if ($i("kwiaSavePlanBtn")) $i("kwiaSavePlanBtn").disabled = true;
    if ($i("kwiaPublishBtn")) $i("kwiaPublishBtn").disabled  = true;
    if ($i("kwiaCheckAll"))  $i("kwiaCheckAll").checked   = false;

    if (typeof showToast === "function") showToast("Plano limpo. Pronto para um novo processamento.", "success");
  }

  // Init
  function init() {
    if ($i("kwiaRunBtn")) $i("kwiaRunBtn").addEventListener("click", run);
    if ($i("kwiaStopBtn")) $i("kwiaStopBtn").addEventListener("click", stop);
    if ($i("kwiaClearBtn")) $i("kwiaClearBtn").addEventListener("click", clear);
    if ($i("kwiaExportBtn")) $i("kwiaExportBtn").addEventListener("click", exportCSV);
    if ($i("kwiaSavePlanBtn")) $i("kwiaSavePlanBtn").addEventListener("click", savePlan);
    if ($i("kwiaPublishBtn")) $i("kwiaPublishBtn").addEventListener("click", openPublishModal);

    if ($i("kwiaHistoryClearBtn")) {
      $i("kwiaHistoryClearBtn").addEventListener("click", function() {
        localStorage.removeItem(HISTORY_KEY);
        renderHistoryList();
      });
    }

    if ($i("kwiaTableSort")) {
      $i("kwiaTableSort").addEventListener("change", function(e) {
        _sortKey = e.target.value;
        _sortAsc = _sortKey === "avgCpc";
        renderTable(_allKeywords);
      });
    }

    if ($i("kwiaTableSearch")) {
      $i("kwiaTableSearch").addEventListener("input", function(e) {
        _filterText = e.target.value;
        renderTable(_allKeywords);
      });
    }

    if ($i("kwiaIntentGroup")) {
      $i("kwiaIntentGroup").addEventListener("change", function() {
        renderTable(_allKeywords);
      });
    }

    if ($i("kwiaCheckAll")) {
      $i("kwiaCheckAll").addEventListener("change", function(e) {
        document.querySelectorAll(".kwia-kw-check").forEach(function(c) { c.checked = e.target.checked; });
        updatePublishBtn();
      });
    }

    if ($i("kwiaTableBody")) {
      $i("kwiaTableBody").addEventListener("change", function(e) {
        if (e.target.classList.contains("kwia-kw-check")) updatePublishBtn();
      });
    }

    ["kwiaSimBudget","kwiaSimMaxCpc","kwiaSimMatch","kwiaSimGoal"].forEach(function(id) {
      if ($i(id)) $i(id).addEventListener("input", recalcSim);
    });

    if ($i("kwiaSelectAllBtn")) {
      $i("kwiaSelectAllBtn").addEventListener("click", function() {
        document.querySelectorAll(".kwia-kw-check").forEach(function(c) { c.checked = true; });
        if ($i("kwiaCheckAll")) $i("kwiaCheckAll").checked = true;
        updatePublishBtn();
      });
    }

    if ($i("kwiaModalClose")) $i("kwiaModalClose").addEventListener("click", function() { $i("kwiaPublishModal").hidden = true; });
    if ($i("kwiaModalCancelBtn")) $i("kwiaModalCancelBtn").addEventListener("click", function() { $i("kwiaPublishModal").hidden = true; });
    if ($i("kwiaModalConfirmBtn")) $i("kwiaModalConfirmBtn").addEventListener("click", confirmPublish);

    // Modal de confirmação para limpar plano
    if ($i("kwiaClearCancelBtn"))  $i("kwiaClearCancelBtn").addEventListener("click", function() { $i("kwiaClearModal").hidden = true; });
    if ($i("kwiaClearConfirmBtn")) $i("kwiaClearConfirmBtn").addEventListener("click", function() { _executeClear(); });
    // Fechar clicando no backdrop
    if ($i("kwiaClearModal")) {
      $i("kwiaClearModal").addEventListener("click", function(e) {
        if (e.target === $i("kwiaClearModal")) $i("kwiaClearModal").hidden = true;
      });
    }

    // Aviso ao fechar/atualizar a página com plano não salvo
    window.addEventListener("beforeunload", function(e) {
      if (_allKeywords.length > 0 || _bestPlan) {
        e.preventDefault();
        e.returnValue = "";
      }
    });

    if ($i("kwiaModalCampaign")) {
      $i("kwiaModalCampaign").addEventListener("change", async function(e) {
        var campId = e.target.value;
        var agSel  = $i("kwiaModalAdGroup");
        var count  = getSelectedKeywords().length;
        agSel.innerHTML = '<option value="">Carregando grupos…</option>';
        $i("kwiaModalConfirmBtn").disabled = true;
        if (!campId) { agSel.innerHTML = '<option value="">Selecione uma campanha primeiro</option>'; return; }
        try {
          var r = await fetch("/api/keyword-planner/ia/adgroups?campaignId=" + campId).then(function(r) { return r.json(); });
          agSel.innerHTML = r.ok
            ? '<option value="">Selecione um grupo</option>' + r.data.map(function(g) { return '<option value="' + g.id + '">' + escHtml(g.name) + "</option>"; }).join("")
            : '<option value="">Erro: ' + (r.error || "desconhecido") + "</option>";
        } catch (_) { agSel.innerHTML = '<option value="">Erro ao carregar grupos</option>'; }
        updateModalConfirm(count);
      });
    }

    ["kwiaModalAdGroup","kwiaModalMatch","kwiaModalStatus"].forEach(function(id) {
      if ($i(id)) $i(id).addEventListener("change", function() { updateModalConfirm(getSelectedKeywords().length); });
    });

    var kwiaTabBtn = document.querySelector('.tab-btn[data-tab="kwia"]');
    if (kwiaTabBtn) {
      kwiaTabBtn.addEventListener("click", function() {
        document.body.classList.add("tab-kwia-active");
        loadInitialQuota();
      });
    }

    // Load quota if kwia tab is already active on page load
    if (document.body.classList.contains("tab-kwia-active")) loadInitialQuota();

    renderHistoryList();
  }

  return {
    init: init,
    _loadHistoryItem:   _loadHistoryItem,
    _exportHistoryItem: _exportHistoryItem,
    _deleteHistoryItem: _deleteHistoryItem,
  };
})();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", function() { kwia.init(); });
} else {
  kwia.init();
}
