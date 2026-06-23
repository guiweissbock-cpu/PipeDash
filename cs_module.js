// =============================================================================
// CREATIVE STUDIO — geração de criativos com dados de performance + Figma
// =============================================================================

const cs = (() => {

  // ── State ───────────────────────────────────────────────────────────────────
  let _frames        = [];
  let _selectedFrame = null;
  let _selectedAsset = null;
  let _assets        = [];
  let _suggestions   = null;
  let _variations    = [];
  let _history       = [];

  const LS_ASSETS  = "cs_assets_v1";
  const LS_HISTORY = "cs_history_v1";

  const ASSET_ICONS  = { ceo:"🧑‍💼", logo:"🏷️", background:"🖼️", mockup:"📱", icon:"✦" };
  const ASSET_LABELS = { ceo:"Foto CEO", logo:"Logo", background:"Fundo", mockup:"Mockup", icon:"Ícone" };

  function $i(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function fmtDate(ts) {
    return new Date(ts).toLocaleString("pt-BR", {
      day:"2-digit", month:"2-digit", year:"2-digit",
      hour:"2-digit", minute:"2-digit",
    });
  }

  // ── Module 1: Figma Templates ───────────────────────────────────────────────

  async function loadFrames() {
    const btn    = $i("csLoadFramesBtn");
    const status = $i("csFigmaStatus");
    const list   = $i("csTemplatesList");
    if (!btn) return;

    btn.disabled = true;
    status.textContent = "Conectando ao Figma...";
    list.innerHTML = `<p class="cs-placeholder">Carregando templates...</p>`;

    try {
      const [testResp, framesResp] = await Promise.all([
        fetch("/api/figma/test"),
        fetch("/api/figma/frames"),
      ]);

      const test   = await testResp.json();
      const frames = await framesResp.json();

      if (!test.ok)   throw new Error(test.error   || "Erro na autenticação Figma");
      if (!frames.ok) throw new Error(frames.error || "Erro ao buscar frames");

      _frames = frames.data || [];
      status.textContent = `${_frames.length} template${_frames.length !== 1 ? "s" : ""} · ${test.user}`;
      renderFrames();
    } catch (err) {
      status.textContent = `Erro: ${err.message}`;
      list.innerHTML = `<p class="cs-placeholder" style="color:var(--danger)">${esc(err.message)}</p>`;
    } finally {
      btn.disabled = false;
    }
  }

  function renderFrames() {
    const list = $i("csTemplatesList");
    if (!list) return;
    if (!_frames.length) {
      list.innerHTML = `<p class="cs-placeholder">Nenhum frame encontrado.</p>`;
      return;
    }

    const sorted = [..._frames].sort((a, b) => {
      const a1 = a.width === 1080 && a.height === 1080;
      const b1 = b.width === 1080 && b.height === 1080;
      return (b1 - a1) || (a.page > b.page ? 1 : -1);
    });

    list.innerHTML = sorted.map(f => {
      const is1080 = f.width === 1080 && f.height === 1080;
      const size   = f.width && f.height ? `${f.width}×${f.height}` : "—";
      const sel    = _selectedFrame?.id === f.id ? " cs-template-card--selected" : "";
      const star   = is1080 ? " cs-template-card--priority" : "";
      return `
        <div class="cs-template-card${sel}${star}" data-fid="${esc(f.id)}">
          <div class="cs-template-info">
            <div class="cs-template-name">${esc(f.name)}</div>
            <div class="cs-template-meta">${esc(f.page)} · ${size}</div>
          </div>
          <button class="btn btn--ghost btn--sm cs-use-btn" tabindex="-1">Usar</button>
        </div>`;
    }).join("");

    list.querySelectorAll(".cs-template-card").forEach(card => {
      card.addEventListener("click", () => {
        const frame = _frames.find(f => f.id === card.dataset.fid);
        if (frame) selectFrame(frame);
      });
    });
  }

  function selectFrame(frame) {
    _selectedFrame = frame;
    renderFrames();
    const banner = $i("csSelectedBanner");
    if (!banner) return;
    banner.hidden = false;
    $i("csSelectedName").textContent = frame.name;
    $i("csSelectedMeta").textContent = frame.width && frame.height
      ? `· ${frame.page} · ${frame.width}×${frame.height}`
      : `· ${frame.page}`;
  }

  // ── Module 2: Briefing ──────────────────────────────────────────────────────

  function getBriefing() {
    return {
      headline:    ($i("csBriefHeadline")?.value    || "").trim(),
      subheadline: ($i("csBriefSubheadline")?.value || "").trim(),
      cta:         ($i("csBriefCta")?.value         || "").trim(),
      oferta:      ($i("csBriefOferta")?.value       || "").trim(),
      publico:     ($i("csBriefPublico")?.value      || "").trim(),
      obs:         ($i("csBriefObs")?.value          || "").trim(),
      categoria:   ($i("csBriefCategory")?.value     || "BOFU"),
    };
  }

  function _fillField(fieldId, value) {
    const el = $i(fieldId);
    if (!el) return;
    el.value = value;
    el.focus();
  }

  // ── Module 3: Sugestões com Live Meta ──────────────────────────────────────

  function extractInsights() {
    const lmRows  = (typeof _liveMetaRows !== "undefined" && Array.isArray(_liveMetaRows))
      ? _liveMetaRows : [];
    const lmDeals = (typeof _lmDealsStore !== "undefined" && Array.isArray(_lmDealsStore))
      ? _lmDealsStore : [];

    if (!lmRows.length) return null;

    const enriched = lmRows.map((r, i) => {
      const d = lmDeals[i] || { meetDeals:[], signDeals:[], mqlLeads:[] };
      const impr = parseInt(r.impressions) || 0;
      const clk  = parseInt(r.clicks)      || 0;
      return {
        name:        r.ad_name      || "",
        campaign:    r.campaign_name || "",
        spend:       parseFloat(r.spend) || 0,
        leads:       parseInt(r.leads)   || 0,
        ctr:         impr > 0 ? clk / impr * 100 : 0,
        reunioes:    d.meetDeals.length,
        assinaturas: d.signDeals.length,
        mql:         d.mqlLeads.length,
      };
    });

    const byReun = [...enriched].filter(a => a.reunioes > 0).sort((a,b) => b.reunioes - a.reunioes);
    const byCtr  = [...enriched].filter(a => a.ctr > 0).sort((a,b) => b.ctr - a.ctr);
    const byMql  = [...enriched].filter(a => a.mql > 0).sort((a,b) => b.mql - a.mql);
    const byAssn = [...enriched].filter(a => a.assinaturas > 0).sort((a,b) => b.assinaturas - a.assinaturas);

    const totalLeads  = enriched.reduce((s,r) => s + r.leads,  0);
    const totalSpend  = enriched.reduce((s,r) => s + r.spend,  0);
    const totalReun   = enriched.reduce((s,r) => s + r.reunioes, 0);

    return {
      headlines:   byReun.slice(0, 4).map(a => ({ text: a.name, metrica: `${a.reunioes} reuniões` })),
      formatos:    byAssn.slice(0, 3).map(a => ({ text: a.name, metrica: `${a.assinaturas} assinaturas` })),
      ctrTop:      byCtr[0]  || null,
      topByReunioes: byReun[0] || null,
      topByMql:      byMql[0]  || null,
      totalLeads, totalSpend, totalReun,
    };
  }

  function renderSuggestions(insights) {
    const list = $i("csSuggestionsList");
    if (!list) return;

    if (!insights) {
      list.innerHTML = `<p class="cs-placeholder">Nenhum dado Live Meta disponível. Atualize a aba Live Meta primeiro.</p>`;
      return;
    }

    const chip = (text, field, label) =>
      `<span class="cs-suggestion-chip" onclick="cs._fillField('${field}',${JSON.stringify(text)})" title="Clique para aplicar">
        ${label ? `<span class="cs-chip-label">${esc(label)}</span>` : ""}
        ${esc(text)}
       </span>`;

    const ctas = [
      { text:"Quero saber mais",        label:"BOFU" },
      { text:"Falar com especialista",  label:"Reunião" },
      { text:"Ver demonstração",        label:"Demo" },
      { text:"Acessar agora",           label:"Direto" },
      { text:"Tenho interesse",         label:"MQL" },
      { text:"Quero aprender",          label:"TOFU" },
    ];
    if (insights.topByReunioes) ctas.unshift({ text:"Quero uma reunião", label:"Top Reuniões" });

    let html = "";

    if (insights.headlines.length) {
      html += `<div class="cs-suggestion-group">
        <div class="cs-suggestion-group-title">Headlines dos criativos vencedores (reuniões)</div>
        <div class="cs-suggestion-chips">
          ${insights.headlines.map(h => chip(h.text, "csBriefHeadline", h.metrica)).join("")}
        </div>
      </div>`;
    }

    html += `<div class="cs-suggestion-group">
      <div class="cs-suggestion-group-title">CTAs recomendados</div>
      <div class="cs-suggestion-chips">
        ${ctas.map(c => chip(c.text, "csBriefCta", c.label)).join("")}
      </div>
    </div>`;

    if (insights.formatos.length) {
      html += `<div class="cs-suggestion-group">
        <div class="cs-suggestion-group-title">Formatos que mais geraram assinaturas</div>
        <div class="cs-suggestion-chips">
          ${insights.formatos.map(f => chip(f.text, "csBriefHeadline", f.metrica)).join("")}
        </div>
      </div>`;
    }

    if (insights.topByReunioes) {
      const t = insights.topByReunioes;
      html += `<div class="cs-suggestion-insight">
        📊 Top criativo por reuniões: <strong>${esc(t.name)}</strong>
        · ${t.reunioes} reuniões · ${t.leads} leads
        · R$ ${t.spend.toLocaleString("pt-BR", { maximumFractionDigits:0 })} investido
      </div>`;
    }
    if (insights.ctrTop) {
      const c = insights.ctrTop;
      html += `<div class="cs-suggestion-insight" style="margin-top:6px">
        📈 Maior CTR: <strong>${esc(c.name)}</strong> · ${c.ctr.toFixed(2)}% CTR
      </div>`;
    }

    list.innerHTML = html;
    _suggestions = insights;
  }

  // ── Module 4: Biblioteca de Assets ─────────────────────────────────────────

  function loadAssets() {
    try { _assets = JSON.parse(localStorage.getItem(LS_ASSETS) || "[]"); }
    catch (_) { _assets = []; }
  }

  function saveAssets() {
    try { localStorage.setItem(LS_ASSETS, JSON.stringify(_assets)); } catch (_) {}
  }

  function renderAssets() {
    const list = $i("csAssetsList");
    if (!list) return;
    if (!_assets.length) {
      list.innerHTML = `<p class="cs-placeholder" style="grid-column:1/-1">Nenhum asset cadastrado.</p>`;
      return;
    }
    list.innerHTML = _assets.map((a, i) => {
      const icon = ASSET_ICONS[a.type] || "📎";
      const img  = a.url
        ? `<img src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy" onerror="this.parentElement.innerHTML='${icon}'">`
        : icon;
      const selStyle = _selectedAsset?.id === a.id ? "border-color:var(--accent);" : "";
      return `
        <div class="cs-asset-card" style="${selStyle}">
          <div class="cs-asset-preview">${img}</div>
          <div class="cs-asset-name" title="${esc(a.name)}">${esc(a.name)}</div>
          <div class="cs-asset-type">${esc(ASSET_LABELS[a.type] || a.type)}</div>
          <div class="cs-asset-actions">
            <button class="cs-asset-use-btn" data-idx="${i}">Usar</button>
            <button class="cs-asset-del-btn" data-idx="${i}">✕</button>
          </div>
        </div>`;
    }).join("");

    list.querySelectorAll(".cs-asset-use-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        _selectedAsset = _assets[parseInt(btn.dataset.idx)];
        renderAssets();
      });
    });
    list.querySelectorAll(".cs-asset-del-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx);
        if (_selectedAsset?.id === _assets[idx]?.id) _selectedAsset = null;
        _assets.splice(idx, 1);
        saveAssets();
        renderAssets();
      });
    });
  }

  function openAssetModal() {
    $i("csAssetModalName").value = "";
    $i("csAssetModalType").value = "ceo";
    $i("csAssetModalUrl").value  = "";
    $i("csAssetModal").hidden = false;
    $i("csAssetModalName").focus();
  }

  function closeAssetModal() {
    $i("csAssetModal").hidden = true;
  }

  function saveAssetFromModal() {
    const name = ($i("csAssetModalName")?.value || "").trim();
    if (!name) { $i("csAssetModalName")?.focus(); return; }
    _assets.push({
      id:   Date.now().toString(),
      name,
      type: $i("csAssetModalType")?.value || "icon",
      url:  ($i("csAssetModalUrl")?.value || "").trim(),
    });
    saveAssets();
    renderAssets();
    closeAssetModal();
  }

  // ── Module 5: Gerar Variações ───────────────────────────────────────────────

  const ARCHETYPES = [
    {
      id:    "dark-premium",
      nome:  "Dark Premium",
      cat:   "BOFU",
      desc:  "Autoridade e resultado — baseado nos criativos com maior número de reuniões",
      h:     (b, ins) => b.headline || ins?.topByReunioes?.name || "Treine seu time de vendas todos os dias",
      sub:   (b)      => b.subheadline || "Método validado. Resultado consistente.",
      cta:   (b)      => b.cta || "Quero saber mais",
    },
    {
      id:    "dor-solucao",
      nome:  "Dor → Solução",
      cat:   "MOFU",
      desc:  "Identifica o problema e apresenta a solução — padrão com melhor taxa de MQL",
      h:     (b, ins) => {
        const base = b.headline || ins?.topByMql?.name || "resultado";
        return `Chega de ${base.toLowerCase().replace(/^(treine?|venda|aumente?)\s+/i,"").replace(/[.!?]+$/,"")}.`;
      },
      sub:   (b)      => b.subheadline || "Descubra o método que está transformando equipes comerciais.",
      cta:   (b)      => b.cta || "Ver solução",
    },
    {
      id:    "prova-social",
      nome:  "Prova Social",
      cat:   "MOFU",
      desc:  "Valida com volume — padrão baseado no total de leads ativos na conta",
      h:     (b, ins) => {
        const n = ins?.totalLeads > 50
          ? `+${Math.floor(ins.totalLeads / 10) * 10}`
          : "+100";
        return `${n} gestores já treinaram seus times com esse método.`;
      },
      sub:   (b)      => b.subheadline || "Veja como estão aumentando as taxas de fechamento.",
      cta:   (b)      => b.cta || "Quero saber mais",
    },
    {
      id:    "direto",
      nome:  "Direto ao Ponto",
      cat:   "BOFU",
      desc:  "Oferta direta — padrão BOFU de maior taxa de assinatura",
      h:     (b, ins) => b.headline || ins?.topByReunioes?.name || "Venda mais. Treine hoje.",
      sub:   (b)      => b.oferta ? `Acesse: ${b.oferta}` : (b.subheadline || "Sem burocracia. Resultado em dias."),
      cta:   (b)      => b.oferta ? `Acessar ${b.oferta}` : (b.cta || "Acessar agora"),
    },
    {
      id:    "curiosidade",
      nome:  "Curiosidade",
      cat:   "TOFU",
      desc:  "Formato pergunta — topo de funil com melhor potencial de CTR",
      h:     (b, ins) => {
        const raw = b.headline || ins?.ctrTop?.name || "seu time de vendas";
        const clean = raw.replace(/[?.!]+$/, "").toLowerCase();
        return `Por que ${clean}?`;
      },
      sub:   (b)      => b.subheadline || "Entenda o método que está mudando equipes comerciais no Brasil.",
      cta:   (b)      => "Quero entender",
    },
  ];

  function generateVariations() {
    const briefing = getBriefing();
    if (!briefing.headline && !_selectedFrame && !briefing.cta) {
      alert("Preencha ao menos Headline ou CTA no briefing para gerar as variações.");
      return;
    }

    const insights = extractInsights();
    _variations = ARCHETYPES.map((a, idx) => ({
      id:            `v_${Date.now()}_${idx}`,
      num:           idx + 1,
      archetype:     a.id,
      nome:          `Variação ${idx + 1} — ${a.nome}`,
      categoria:     briefing.categoria || a.cat,
      justificativa: a.desc,
      headline:      a.h(briefing, insights),
      subheadline:   a.sub(briefing),
      cta:           a.cta(briefing),
      template:      _selectedFrame?.name || "(sem template)",
      templateId:    _selectedFrame?.id   || null,
      asset:         _selectedAsset?.name || "(sem asset)",
      assetUrl:      _selectedAsset?.url  || null,
      publico:       briefing.publico,
      oferta:        briefing.oferta,
      obs:           briefing.obs,
      timestamp:     Date.now(),
      status:        "draft",
    }));

    renderVariations();

    $i("csVariationsSection")?.scrollIntoView({ behavior:"smooth", block:"start" });
  }

  function renderVariations() {
    const list = $i("csVariationsList");
    if (!list) return;
    if (!_variations.length) {
      list.innerHTML = `<p class="cs-placeholder">Preencha o briefing e clique em Gerar variações.</p>`;
      return;
    }
    list.innerHTML = _variations.map(v => `
      <div class="cs-variation-card">
        <div class="cs-variation-header">
          <div>
            <div class="cs-variation-name">${esc(v.nome)}</div>
            <div class="cs-variation-justificativa">${esc(v.justificativa)}</div>
          </div>
          <span class="cs-variation-badge cs-var-badge--${esc(v.categoria)}">${esc(v.categoria)}</span>
        </div>
        <div class="cs-variation-texts">
          ${textRow("Headline",    v.headline)}
          ${textRow("Subheadline", v.subheadline)}
          ${textRow("CTA",         v.cta)}
          ${textRow("Template",    v.template)}
          ${v.asset !== "(sem asset)" ? textRow("Asset", v.asset) : ""}
        </div>
        <div class="cs-variation-footer">
          <button class="btn btn--ghost btn--sm" onclick="cs._saveToHistory('${esc(v.id)}')">✓ Salvar</button>
          <button class="btn btn--ghost btn--sm" onclick="cs._exportJson('${esc(v.id)}')">↓ JSON</button>
          <button class="btn btn--primary btn--sm" onclick="cs._sendToFigma('${esc(v.id)}')">✦ Enviar para Figma</button>
        </div>
      </div>`).join("");
  }

  function textRow(label, value) {
    return `
      <div class="cs-variation-text-row">
        <span class="cs-variation-text-label">${esc(label)}</span>
        <span class="cs-variation-text-value">${esc(value)}</span>
      </div>`;
  }

  // ── Module 6: Exportar / Enviar para Figma ──────────────────────────────────

  function buildPayload(v) {
    return {
      _meta: {
        geradoEm: new Date(v.timestamp).toISOString(),
        sistema:  "PipeDash Creative Studio v2.2.0",
      },
      template: { id: v.templateId, nome: v.template },
      textos: {
        headline:    v.headline,
        subheadline: v.subheadline,
        cta:         v.cta,
        oferta:      v.oferta || null,
        publico:     v.publico || null,
      },
      asset: {
        nome: v.asset !== "(sem asset)" ? v.asset : null,
        url:  v.assetUrl || null,
      },
      variacao: {
        nome:          v.nome,
        categoria:     v.categoria,
        justificativa: v.justificativa,
        archetype:     v.archetype,
      },
    };
  }

  function _exportJson(varId) {
    const v = _variations.find(x => x.id === varId);
    if (!v) return;
    const blob = new Blob([JSON.stringify(buildPayload(v), null, 2)], { type:"application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `criativo-${v.archetype}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    _saveToHistory(varId, "ready");
  }

  async function _sendToFigma(varId) {
    const v = _variations.find(x => x.id === varId);
    if (!v) return;

    try {
      const resp = await fetch("/api/figma/export", {
        method:  "POST",
        headers: { "Content-Type":"application/json" },
        body:    JSON.stringify(buildPayload(v)),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      alert(`Enviado para o Figma!\n${data.message || ""}`);
      _saveToHistory(varId, "exported");
    } catch (_) {
      _exportJson(varId);
      alert(
        "A escrita direta no Figma estará disponível em uma próxima versão.\n\n" +
        "O JSON foi baixado — importe-o em um plugin Figma para aplicar os textos no template selecionado."
      );
    }
  }

  // ── Module 7: Histórico ─────────────────────────────────────────────────────

  function loadHistory() {
    try { _history = JSON.parse(localStorage.getItem(LS_HISTORY) || "[]"); }
    catch (_) { _history = []; }
  }

  function saveHistory() {
    try { localStorage.setItem(LS_HISTORY, JSON.stringify(_history.slice(0, 100))); }
    catch (_) {}
  }

  function _saveToHistory(varId, status = "draft") {
    const v = _variations.find(x => x.id === varId);
    if (!v) return;
    const idx = _history.findIndex(h => h.id === v.id);
    const entry = {
      id:        v.id,
      data:      v.timestamp,
      template:  v.template,
      headline:  v.headline,
      cta:       v.cta,
      categoria: v.categoria,
      archetype: v.archetype,
      status,
      figmaLink: null,
    };
    if (idx >= 0) _history[idx] = entry;
    else          _history.unshift(entry);
    saveHistory();
    renderHistory();
  }

  function renderHistory() {
    const container = $i("csHistoryContainer");
    if (!container) return;
    if (!_history.length) {
      container.innerHTML = `<p class="cs-placeholder">Nenhum criativo gerado ainda.</p>`;
      return;
    }
    const badge = (s) => {
      const map = { draft:"Rascunho", ready:"Pronto", exported:"Exportado" };
      return `<span class="cs-history-status cs-history-status--${esc(s)}">${map[s] || esc(s)}</span>`;
    };
    container.innerHTML = `
      <table class="cs-history-table">
        <thead><tr>
          <th>Data</th><th>Template</th><th>Headline</th>
          <th>CTA</th><th>Categoria</th><th>Status</th>
        </tr></thead>
        <tbody>
          ${_history.map(h => `
            <tr>
              <td>${fmtDate(h.data)}</td>
              <td>${esc(h.template)}</td>
              <td style="max-width:220px">${esc(h.headline)}</td>
              <td>${esc(h.cta)}</td>
              <td><span class="cs-variation-badge cs-var-badge--${esc(h.categoria)}">${esc(h.categoria)}</span></td>
              <td>${badge(h.status)}</td>
            </tr>`).join("")}
        </tbody>
      </table>`;
  }

  function clearHistory() {
    if (!_history.length) return;
    if (!confirm("Limpar todo o histórico de criativos?")) return;
    _history = [];
    saveHistory();
    renderHistory();
  }

  // ── Init ────────────────────────────────────────────────────────────────────

  function init() {
    loadAssets();
    loadHistory();
    renderAssets();
    renderHistory();

    $i("csLoadFramesBtn")     ?.addEventListener("click", loadFrames);
    $i("csGenSuggestionsBtn") ?.addEventListener("click", () => renderSuggestions(extractInsights()));
    $i("csGenVariationsBtn")  ?.addEventListener("click", generateVariations);
    $i("csAddAssetBtn")       ?.addEventListener("click", openAssetModal);
    $i("csAssetCancelBtn")    ?.addEventListener("click", closeAssetModal);
    $i("csAssetSaveBtn")      ?.addEventListener("click", saveAssetFromModal);
    $i("csClearHistoryBtn")   ?.addEventListener("click", clearHistory);
    $i("csDeselectBtn")       ?.addEventListener("click", () => {
      _selectedFrame = null;
      $i("csSelectedBanner").hidden = true;
      renderFrames();
    });

    const modal = $i("csAssetModal");
    if (modal) modal.addEventListener("click", e => { if (e.target === modal) closeAssetModal(); });

    // Enter no modal salva
    $i("csAssetModalUrl")?.addEventListener("keydown", e => { if (e.key === "Enter") saveAssetFromModal(); });

    // Carrega frames automaticamente se Figma estiver configurado
    fetch("/api/status").then(r => r.json()).then(s => {
      if (s.figma && !_frames.length) loadFrames();
    }).catch(() => {});
  }

  return {
    init,
    // Expostos para onclick inline nos cards gerados dinamicamente
    _fillField,
    _exportJson,
    _sendToFigma,
    _saveToHistory,
  };

})();

document.addEventListener("DOMContentLoaded", () => cs.init());
