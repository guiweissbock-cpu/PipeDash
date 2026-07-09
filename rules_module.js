/* ==========================================================================
   rules_module.js — Módulo Rules: documentação técnica oficial das regras
   de negócio, cálculo e exibição do PipeDash.

   REGRA OBRIGATÓRIA: Toda alteração de lógica, filtro, fonte de dados,
   regra de exibição, atribuição, integração ou estrutura de módulo deve
   ser acompanhada de atualização deste arquivo no mesmo commit.
   Nenhuma alteração está completa sem a atualização correspondente no Rules.
   ========================================================================== */

(function () {
  "use strict";

  /* -------------------------------------------------------------------------
     METADADOS
  ------------------------------------------------------------------------- */
  const RULES_META = {
    version:   "1.0.0",
    updatedAt: "2026-07-09",
    authors:   "PipeLovers Engineering"
  };

  /* -------------------------------------------------------------------------
     CATÁLOGO DE REGRAS
     Cada entrada documenta uma métrica/componente com os 15 campos obrigatórios.
  ------------------------------------------------------------------------- */
  const RULES_CATALOG = [

    // =====================================================================
    // SISTEMA GERAL
    // =====================================================================

    {
      id: "GERAL-01",
      name: "Identificação de Origem Meta (isMetaOrigin)",
      module: "Sistema Geral",
      moduleId: "geral",
      type: "regra-calculo",
      fonte:        "Zoho CRM — campo Origem (Lead_Source)",
      endpoint:     "getDeals() · getReport(ZOHO_REUNIOES_REPORT_ID)",
      campo:        "d.origem → normalizeKey(d.origem)",
      calculo:      "Retorna true se normalizeKey(origem) contém ao menos uma de: 'tofu', 'bofu', 'aula gratis', 'meta ads', 'pipelovers'. Exclusão explícita de origens como 'google ads', 'organic'.",
      filtroData:   "Nenhum — predicado de classificação, não filtro temporal.",
      inclusao:     "Origem que contenha ao menos uma das keywords Meta após normalização.",
      exclusao:     "Origens que não contenham nenhuma keyword Meta. 'Fechado Perdido' não é excluído aqui — é excluído por ausência do stage em META_MEETING_STAGES.",
      dedup:        "Não se aplica — função booleana pura aplicada por registro.",
      atribuicao:   "Não se aplica.",
      agrupamento:  "Não se aplica.",
      exibicao:     "Não exibida diretamente. Usada como filtro interno em todas as contagens de métricas Meta.",
      dependencias: "countsAsMetaMeeting · countsAsMetaSignature · computeReunioesReport · computeZohoMetaMetrics · renderLiveMeta",
      observacoes:  "normalizeKey() remove acentos, pontuação e converte para minúsculas. Qualquer nova origem Meta deve ser adicionada à lista de keywords em isMetaOrigin() E documentada aqui."
    },

    {
      id: "GERAL-02",
      name: "Estágios de Reunião Meta (META_MEETING_STAGES)",
      module: "Sistema Geral",
      moduleId: "geral",
      type: "regra-negocio",
      fonte:        "Configuração interna — CONFIG.meetingStages (script.js:16)",
      endpoint:     "Não consome API — lista estática em código",
      campo:        "d.stage (Stage do deal Zoho) comparado via substring após normalizeKey()",
      calculo:      "Estágio é válido se normalizeKey(stage).includes(ms) para algum ms na lista de 25 estágios.",
      filtroData:   "Não se aplica.",
      inclusao:     "25 estágios: reuniao agendada, reuniao realizada, reuniao exploratoria realizada, reuniao alinhamento, no show, proposta enviada, negociacao, assinatura realizada, handoff, em ativacao 30 dias, em ativacao 60 dias, membros ativados no mes, agendar reuniao de onboarding individual, reuniao de onboarding agendada, no-show onboarding, pdi, high touch, mid touch, low touch, 1 reuniao pos passagem, passagem de bastao onb, reversao de churn, abertura de upsell, churn realizado, churn solicitado, churn b2b.",
      exclusao:     "'Fechado Perdido' excluído por decisão explícita — over-count massivo (~9k deals) pois a maioria das perdas ocorre antes de qualquer reunião.",
      dedup:        "Não se aplica a esta regra.",
      atribuicao:   "Match por substring (includes), não exato — estágios com sufixo são capturados.",
      agrupamento:  "Não se aplica.",
      exibicao:     "Indiretamente: controla o total dos cards REUNIÕES e ASSINATURAS.",
      dependencias: "countsAsMetaMeeting · computeReunioesReport · computeGoogleAdsReport",
      observacoes:  "Estágios pós-reunião (proposta, negociação, assinatura, handoff, ativação) contam como reunião porque pressupostamente houve uma reunião antes. Qualquer novo estágio do CRM que indique reunião prévia deve ser adicionado aqui."
    },

    {
      id: "GERAL-03",
      name: "Chave de Deduplicação de Deals (uid)",
      module: "Sistema Geral",
      moduleId: "geral",
      type: "regra-calculo",
      fonte:        "Zoho CRM — campos Deal_Name e Contact_Name",
      endpoint:     "getDeals() · getReport()",
      campo:        "d.nomeContato · d.nomeNegocio",
      calculo:      "uid = (contactKey && baseName) ? `${contactKey}|${baseName}` : (contactKey || baseName || d.id || `${d.nomeNegocio}|${d.horaCriacao}`). Onde contactKey=normalizeKey(d.nomeContato) e baseName=cleanDealBaseName(d.nomeNegocio).",
      filtroData:   "Não se aplica — aplicada sobre o conjunto já filtrado por período.",
      inclusao:     "Todo deal processa a chave. O primeiro deal com uma chave é contado; os subsequentes com a mesma chave são descartados.",
      exclusao:     "Deals com chave repetida dentro da mesma categoria (reunião ou assinatura) são ignorados.",
      dedup:        "Set separado para seenMeet e seenSign — um deal pode contar como reunião em seenMeet e assintatura em seenSign sem colisão.",
      atribuicao:   "A chave é composta por contato + empresa, garantindo que o mesmo contato em duas empresas diferentes gere chaves distintas.",
      agrupamento:  "Não se aplica.",
      exibicao:     "Não exibida. Afeta os totais de REUNIÕES e ASSINATURAS em todos os módulos.",
      dependencias: "computeReunioesReport · computeZohoMetaMetrics · computeGoogleAdsReport",
      observacoes:  "Dois contatos distintos na mesma empresa geram keys diferentes → ambos contados. Webhook duplicado do mesmo contato → contado uma vez. Make.com pode criar deals duplicados via webhook; a deduplicação por contactKey|baseName é o mecanismo de proteção."
    },

    {
      id: "GERAL-04",
      name: "Normalização do Nome do Negócio (cleanDealBaseName)",
      module: "Sistema Geral",
      moduleId: "geral",
      type: "regra-calculo",
      fonte:        "Zoho CRM — campo Deal_Name",
      endpoint:     "getDeals() · getReport()",
      campo:        "d.nomeNegocio (Deal_Name)",
      calculo:      "Remove tudo a partir do primeiro '[' no nome, depois aplica normalizeKey(). Ex: 'Empresa [[TOFU] - Aula Gratis]' → 'empresa'.",
      filtroData:   "Não se aplica.",
      inclusao:     "Qualquer nome de deal.",
      exclusao:     "Sufixos de campanha adicionados pelo Make.com entre colchetes.",
      dedup:        "Parte da chave uid usada para deduplicação.",
      atribuicao:   "Não se aplica.",
      agrupamento:  "Não se aplica.",
      exibicao:     "Não exibida diretamente.",
      dependencias: "uid (GERAL-03) · computeReunioesReport · computeZohoMetaMetrics",
      observacoes:  "O Make.com appenda '[CampaignName]' ao Deal_Name ao criar o deal via webhook, resultando em variações como 'Empresa [[TOFU] - Aula Gratis] [[TOFU] - Aula Gratis]'. A limpeza é necessária para deduplicação correta."
    },

    {
      id: "GERAL-05",
      name: "Filtro de Período (filterByPeriod)",
      module: "Sistema Geral",
      moduleId: "geral",
      type: "regra-filtro",
      fonte:        "Zoho CRM — campo Created_Time (horaCriacao)",
      endpoint:     "getDeals() · getReport()",
      campo:        "d.horaCriacao (ISO 8601 string)",
      calculo:      "Retém rows onde new Date(d.horaCriacao) >= start E <= end. start/end vêm de presetToDateRange(preset, since, until) ou dos inputs de data manual.",
      filtroData:   "O próprio filtro — aplica o intervalo selecionado pelo usuário.",
      inclusao:     "Deals criados dentro do período selecionado (inclusive nas bordas).",
      exclusao:     "Deals criados antes do início ou após o fim do período.",
      dedup:        "Não se aplica — aplicada antes da deduplicação.",
      atribuicao:   "Não se aplica.",
      agrupamento:  "Não se aplica.",
      exibicao:     "O período ativo é exibido no seletor de datas. Todos os cards e tabelas refletem o filtro.",
      dependencias: "fetchAllData · fetchLiveMeta · applyLmFilter · reunioesFiltered · zohoFiltered",
      observacoes:  "IMPORTANTE: O relatório do Zoho Analytics (getReport) retorna TODOS os registros históricos, não apenas do mês corrente. O filtro de data do painel do Zoho é um filtro de exibição e NÃO é aplicado via API. Portanto, filterByPeriod SEMPRE deve ser aplicado sobre reunioesRows, independente da flag isOfficialReunioesData."
    },

    {
      id: "GERAL-06",
      name: "Cache de Deals Zoho (getDeals)",
      module: "Sistema Geral",
      moduleId: "geral",
      type: "regra-performance",
      fonte:        "Zoho CRM API v2 — /crm/v2/Deals (paginado)",
      endpoint:     "getDeals({ forceRefresh }) em zohoService.js",
      campo:        "Todos os campos: Deal_Name, Contact_Name, Origem, Stage, Created_Time, Meta_Ads_ADs_ID, Meta_Ads_Anuncio, Meta_Ads_Campanha, Meta_Ads_Lead_ID, Meta_Ads_Campanha_ID, ICP",
      calculo:      "Busca paginada (200/page) até more_records=false. Armazena em dealsCache com timestamp.",
      filtroData:   "TTL: 5 minutos. Após expiração, nova busca na API.",
      inclusao:     "Todos os deals do módulo Zoho (env: ZOHO_MODULE, padrão 'Deals').",
      exclusao:     "Nenhuma exclusão na busca. Filtros são aplicados em memória pelo cliente.",
      dedup:        "Não há deduplicação no cache — os dados brutos são armazenados.",
      atribuicao:   "Não se aplica.",
      agrupamento:  "Não se aplica.",
      exibicao:     "Não exibido. Impacta o tempo de carregamento da primeira busca.",
      dependencias: "fetchAllData · fetchLiveMeta · normalizeRecord",
      observacoes:  "forceRefresh=true ignora o cache e força nova busca. Usado no botão 'Buscar via API'. O cache é em memória — cold start (novo deploy) sempre busca da API."
    },

    {
      id: "GERAL-07",
      name: "Cache do Relatório Zoho (getReport)",
      module: "Sistema Geral",
      moduleId: "geral",
      type: "regra-performance",
      fonte:        "Zoho Analytics Reports API — /crm/v2/Deals?report_id=ZOHO_REUNIOES_REPORT_ID",
      endpoint:     "getReport(reportId, { forceRefresh }) em zohoService.js",
      campo:        "Campos disponíveis no relatório: Deal_Name, Contact_Name, Origem, Stage, Created_Time, Meta_Ads_ADs_ID, Meta_Ads_Anuncio, etc.",
      calculo:      "Busca paginada (200/page). Cache por reportId em Map reportCache com timestamp.",
      filtroData:   "TTL: 5 minutos.",
      inclusao:     "Todos os registros retornados pelo relatório (filtro do relatório no Zoho UI define o escopo, mas via API retorna histórico completo).",
      exclusao:     "Nenhuma exclusão no cache.",
      dedup:        "Não há deduplicação no cache.",
      atribuicao:   "Não se aplica.",
      agrupamento:  "Não se aplica.",
      exibicao:     "Indiretamente: alimento state.reunioesRows → base para cards de Reuniões e Assinaturas.",
      dependencias: "GERAL-05 (filterByPeriod) · GERAL-08 (fonte oficial) · fetchAllData · fetchLiveMeta",
      observacoes:  "O endpoint correto é /crm/v2/{MODULE}?report_id={ID}. O endpoint /crm/v2/Analytics/{ID} NÃO funciona para buscar dados."
    },

    {
      id: "GERAL-08",
      name: "Fonte Oficial de Reuniões (isOfficialReunioesData)",
      module: "Sistema Geral",
      moduleId: "geral",
      type: "regra-fonte",
      fonte:        "Zoho Analytics — relatório configurado em ZOHO_REUNIOES_REPORT_ID",
      endpoint:     "getReport(process.env.ZOHO_REUNIOES_REPORT_ID)",
      campo:        "state.reunioesRows (registros brutos) · state.reunioesFiltered (após filterByPeriod)",
      calculo:      "Se ZOHO_REUNIOES_REPORT_ID está configurado e a busca é bem-sucedida, state.isOfficialReunioesData=true e reunioesRows vem do relatório. Caso contrário, fallback para state.zohoRows.",
      filtroData:   "filterByPeriod() SEMPRE aplicado sobre reunioesRows — independente de isOfficialReunioesData.",
      inclusao:     "Todos os registros do relatório Zoho.",
      exclusao:     "Registros sem stage E sem metaAdsAnuncio são descartados por zohoApiToRows().",
      dedup:        "Deduplicação aplicada por computeReunioesReport() após o filtro de período.",
      atribuicao:   "Relatório curado pelo time de operações no Zoho. Inclui apenas deals relevantes para contagem de reuniões.",
      agrupamento:  "Não se aplica na fonte.",
      exibicao:     "Cards: Reuniões Geradas Meta, Assinaturas Geradas Meta (Dashboard Principal e Live Meta).",
      dependencias: "GERAL-05 · GERAL-06 · GERAL-07 · renderCards · renderLiveMetaMetrics",
      observacoes:  "O relatório é a fonte de maior confiabilidade pois é curado manualmente no Zoho. O fallback para zohoRows é menos preciso. NUNCA remover o filterByPeriod sobre reunioesRows — o relatório retorna histórico completo via API."
    },

    // =====================================================================
    // DASHBOARD PRINCIPAL (Meta Ads)
    // =====================================================================

    {
      id: "DASH-01",
      name: "Investimento Total Meta Ads",
      module: "Dashboard Principal",
      moduleId: "dashboard",
      type: "metrica-financeira",
      fonte:        "Meta Ads API — insights por anúncio",
      endpoint:     "/api/meta-insights (server.js) → Graph API /v19.0/{adAccountId}/insights",
      campo:        "spend (por anúncio/ad) — somado sobre todos os ads do período",
      calculo:      "SUM(c.valorGasto) para todos os criativos no período. Sem deduplicação — cada linha da planilha Meta é um ad com gasto único.",
      filtroData:   "Período passado diretamente à Graph API (time_range: {since, until}). Dados já chegam filtrados.",
      inclusao:     "Todos os anúncios da conta Meta Ads no período selecionado.",
      exclusao:     "Anúncios com spend=0 não são excluídos (podem ter impressões).",
      dedup:        "Não se aplica — cada ad_id é único na resposta da API.",
      atribuicao:   "Não se aplica — investimento é proprietário de cada anúncio.",
      agrupamento:  "Pode ser agrupado por campanha, conjunto ou criativo nas abas Rankings/Tabela.",
      exibicao:     "Card 'Investimento' em Visão Geral. Formatado como moeda BRL (R$ X.XXX,XX).",
      dependencias: "CPL Meta (DASH-10) · Custo/Reunião (DASH-12) · Custo/Assinatura (DASH-13)",
      observacoes:  "A API Meta retorna spend em USD ou BRL dependendo da configuração da conta. Verificar moeda da conta antes de comparar com dados financeiros internos."
    },

    {
      id: "DASH-02",
      name: "Impressões Meta Ads",
      module: "Dashboard Principal",
      moduleId: "dashboard",
      type: "metrica-alcance",
      fonte:        "Meta Ads API — campo impressions",
      endpoint:     "/api/meta-insights → Graph API insights",
      campo:        "impressions (por ad)",
      calculo:      "SUM(c.impressoes) para todos os criativos.",
      filtroData:   "Período via time_range na Graph API.",
      inclusao:     "Todos os anúncios com impressões no período.",
      exclusao:     "Nenhuma.",
      dedup:        "Não se aplica.",
      atribuicao:   "Não se aplica.",
      agrupamento:  "Por campanha/conjunto/criativo nos rankings.",
      exibicao:     "Card 'Impressões' em Visão Geral. Formatado como inteiro com separador de milhar.",
      dependencias: "CTR (DASH-04) · CPM (DASH-05)",
      observacoes:  "Impressão ≠ alcance único. A mesma pessoa pode ver o anúncio várias vezes."
    },

    {
      id: "DASH-03",
      name: "Cliques Meta Ads",
      module: "Dashboard Principal",
      moduleId: "dashboard",
      type: "metrica-engajamento",
      fonte:        "Meta Ads API — campo clicks",
      endpoint:     "/api/meta-insights → Graph API insights",
      campo:        "clicks (por ad)",
      calculo:      "SUM(c.cliques) para todos os criativos.",
      filtroData:   "Período via time_range na Graph API.",
      inclusao:     "Todos os cliques no período.",
      exclusao:     "Nenhuma.",
      dedup:        "Não se aplica.",
      atribuicao:   "Não se aplica.",
      agrupamento:  "Por campanha/conjunto/criativo nos rankings.",
      exibicao:     "Card 'Cliques' em Visão Geral.",
      dependencias: "CTR (DASH-04) · CPC",
      observacoes:  "Cliques de link vs. cliques totais — verificar qual métrica a API está retornando (link_clicks vs. clicks)."
    },

    {
      id: "DASH-04",
      name: "CTR (Taxa de Clique)",
      module: "Dashboard Principal",
      moduleId: "dashboard",
      type: "metrica-eficiencia",
      fonte:        "Calculado — Meta Ads API",
      endpoint:     "Derivado de cliques e impressões",
      campo:        "cliques / impressoes × 100",
      calculo:      "safeDiv(c.cliques, c.impressoes) × 100. safeDiv retorna 0 se denominador=0.",
      filtroData:   "Herdado dos dados filtrados.",
      inclusao:     "Todos os criativos com impressões > 0.",
      exclusao:     "Criativos sem impressões (CTR=0).",
      dedup:        "Não se aplica.",
      atribuicao:   "Não se aplica.",
      agrupamento:  "Por criativo, campanha ou conjunto.",
      exibicao:     "Exibido com 2 casas decimais + '%'. Tabela Detalhada e Rankings.",
      dependencias: "DASH-02 · DASH-03",
      observacoes:  "CTR agregado (total cliques / total impressões) pode esconder variações entre criativos. Usar rankings para análise individual."
    },

    {
      id: "DASH-05",
      name: "CPM (Custo por Mil Impressões)",
      module: "Dashboard Principal",
      moduleId: "dashboard",
      type: "metrica-financeira",
      fonte:        "Calculado — Meta Ads API",
      endpoint:     "Derivado de valorGasto e impressoes",
      campo:        "valorGasto / impressoes × 1000",
      calculo:      "safeDiv(c.valorGasto, c.impressoes) × 1000.",
      filtroData:   "Herdado.",
      inclusao:     "Todos os criativos.",
      exclusao:     "Criativos sem impressões.",
      dedup:        "Não se aplica.",
      atribuicao:   "Não se aplica.",
      agrupamento:  "Por criativo/conjunto/campanha.",
      exibicao:     "Formatado como moeda BRL. Tabela Detalhada.",
      dependencias: "DASH-01 · DASH-02",
      observacoes:  "CPM alto pode indicar público muito segmentado ou criativo pouco relevante."
    },

    {
      id: "DASH-06",
      name: "Leads Meta (do CRM)",
      module: "Dashboard Principal",
      moduleId: "dashboard",
      type: "metrica-leads",
      fonte:        "Meta Ads API — campo leads (form_leads ou actions)",
      endpoint:     "/api/meta-insights → Graph API insights",
      campo:        "leads (por ad) — campo 'leads' ou action_type='lead' na resposta",
      calculo:      "SUM(c.leadsMeta) — total de leads registrados pela Meta (side-Meta, não CRM).",
      filtroData:   "Período via Graph API.",
      inclusao:     "Todos os leads registrados como eventos de lead pela Meta.",
      exclusao:     "Nenhuma.",
      dedup:        "A Meta já agrega por ad_id — não há deduplicação adicional.",
      atribuicao:   "Lead é atribuído ao anúncio que gerou o formulário preenchido.",
      agrupamento:  "Por campanha/conjunto/criativo.",
      exibicao:     "Card 'Leads Meta' em Visão Geral.",
      dependencias: "CPL Meta (DASH-10)",
      observacoes:  "Este número pode diferir de Leads Zoho (DASH-07) por atraso de sincronização, leads inválidos ou problemas de integração webhook."
    },

    {
      id: "DASH-07",
      name: "Leads Zoho CRM",
      module: "Dashboard Principal",
      moduleId: "dashboard",
      type: "metrica-leads",
      fonte:        "Zoho CRM — getDeals() filtrado por isMetaOrigin e período",
      endpoint:     "/api/zoho-deals → getDeals()",
      campo:        "d.origem · d.horaCriacao · d.nomeContato · d.nomeNegocio",
      calculo:      "count(deals com isMetaOrigin=true, horaCriacao no período) após deduplicação por uid (GERAL-03).",
      filtroData:   "filterByPeriod() sobre zohoRows → zohoFiltered.",
      inclusao:     "Deals com origem Meta (isMetaOrigin=true) criados no período selecionado.",
      exclusao:     "Deals com origem não-Meta. Deals fora do período.",
      dedup:        "Por uid = contactKey|baseName — mesmo contato na mesma empresa conta uma vez.",
      atribuicao:   "Lead é atribuído por origem (Lead_Source) no Zoho.",
      agrupamento:  "Por criativo via cruzamento com Meta Ads por ad_id ou nome do anúncio.",
      exibicao:     "Card 'Leads Zoho' em Visão Geral.",
      dependencias: "GERAL-01 (isMetaOrigin) · GERAL-05 (filterByPeriod) · CPL Zoho (DASH-11)",
      observacoes:  "Leads Zoho é o número de leads que efetivamente chegaram ao CRM. Normalmente menor que Leads Meta por leads inválidos ou falhados na integração webhook/Make.com."
    },

    {
      id: "DASH-08",
      name: "Reuniões Geradas Meta (Dashboard)",
      module: "Dashboard Principal",
      moduleId: "dashboard",
      type: "metrica-reunioes",
      fonte:        "Zoho Analytics Report (preferencial) ou getDeals() (fallback)",
      endpoint:     "getReport(ZOHO_REUNIOES_REPORT_ID) ou getDeals()",
      campo:        "d.stage · d.origem · d.nomeContato · d.nomeNegocio · d.horaCriacao",
      calculo:      "computeReunioesReport(state.reunioesFiltered).reunioes — count de deals com isMetaOrigin E stage em META_MEETING_STAGES, após deduplicação.",
      filtroData:   "filterByPeriod() aplicado sobre reunioesRows antes de chamar computeReunioesReport().",
      inclusao:     "isMetaOrigin(origem)=true E stage contém ao menos um dos 25 stages em META_MEETING_STAGES.",
      exclusao:     "Deals fora do período. Deals sem origem Meta. Deals com stage não listado. Duplicatas por uid.",
      dedup:        "seenMeet Set — por uid (GERAL-03). Dedup separado do Set de assinaturas.",
      atribuicao:   "Reunião atribuída à origem Meta do deal.",
      agrupamento:  "Total no card. Por criativo na tabela Live Meta.",
      exibicao:     "Card 'Reuniões' em Visão Geral (Dashboard Principal).",
      dependencias: "GERAL-01 · GERAL-02 · GERAL-03 · GERAL-05 · GERAL-08 · Custo/Reunião (DASH-12)",
      observacoes:  "Se reunioesRows vier do relatório Zoho, inclui registros históricos filtrados por período. Se vier de getDeals(), pode ter escopo diferente. A fonte oficial é sempre o relatório."
    },

    {
      id: "DASH-09",
      name: "Assinaturas Geradas Meta (Dashboard)",
      module: "Dashboard Principal",
      moduleId: "dashboard",
      type: "metrica-conversao",
      fonte:        "Zoho Analytics Report (preferencial) ou getDeals() (fallback)",
      endpoint:     "getReport(ZOHO_REUNIOES_REPORT_ID) ou getDeals()",
      campo:        "d.stage · d.origem",
      calculo:      "computeReunioesReport(state.reunioesFiltered).assinaturas — count de deals com isMetaOrigin E stage='assinatura realizada', após deduplicação por seenSign.",
      filtroData:   "filterByPeriod() sobre reunioesRows.",
      inclusao:     "isMetaOrigin(origem)=true E normalizeKey(stage).includes('assinatura realizada').",
      exclusao:     "Todos os demais stages. Deals sem origem Meta. Duplicatas por uid.",
      dedup:        "seenSign Set separado de seenMeet — um deal pode ser reunião E assinatura sem conflito.",
      atribuicao:   "Assinatura atribuída à origem Meta.",
      agrupamento:  "Total no card. Por criativo na tabela Live Meta.",
      exibicao:     "Card 'Assinaturas' em Visão Geral (Dashboard Principal).",
      dependencias: "GERAL-01 · GERAL-03 · GERAL-05 · GERAL-08 · Custo/Assinatura (DASH-13)",
      observacoes:  "Stage exato: 'assinatura realizada' (normalizado). Qualquer variação de nome de stage no Zoho quebraria a contagem. Monitorar mudanças de nomenclatura no pipeline."
    },

    {
      id: "DASH-10",
      name: "CPL Meta (Custo por Lead Meta)",
      module: "Dashboard Principal",
      moduleId: "dashboard",
      type: "metrica-financeira",
      fonte:        "Calculado — Meta Ads API",
      endpoint:     "Derivado",
      campo:        "valorGasto / leadsMeta",
      calculo:      "safeDiv(c.valorGasto, c.leadsMeta). Por criativo ou total.",
      filtroData:   "Herdado do período.",
      inclusao:     "Criativos com leads > 0.",
      exclusao:     "Criativos sem leads (CPL=0 ou infinito, retorna 0 por safeDiv).",
      dedup:        "Não se aplica.",
      atribuicao:   "Investimento / leads atribuídos ao mesmo anúncio.",
      agrupamento:  "Por criativo/campanha/conjunto.",
      exibicao:     "Formatado como moeda BRL. Card 'CPL Meta' em Visão Geral.",
      dependencias: "DASH-01 · DASH-06",
      observacoes:  "CPL Meta usa leads registrados pela plataforma Meta — pode diferir do CPL Zoho por falhas de integração."
    },

    {
      id: "DASH-11",
      name: "CPL Zoho (Custo por Lead no CRM)",
      module: "Dashboard Principal",
      moduleId: "dashboard",
      type: "metrica-financeira",
      fonte:        "Calculado — Meta Ads API + Zoho CRM",
      endpoint:     "Cruzamento: creatives.forEach → c.leadsZoho",
      campo:        "valorGasto (Meta) / leadsZoho (Zoho, após cruzamento)",
      calculo:      "safeDiv(c.valorGasto, c.leadsZoho) por criativo, depois agregado.",
      filtroData:   "Período de dados Meta + filterByPeriod em zohoRows.",
      inclusao:     "Criativos com leadsZoho > 0.",
      exclusao:     "Criativos sem match no Zoho.",
      dedup:        "leadsZoho usa deduplicação por uid (GERAL-03).",
      atribuicao:   "Lead Zoho atribuído ao criativo por: 1) nome do anúncio (Meta_Ads_Anuncio=ad_name), 2) Meta_Ads_ADs_ID=ad_id. Prioridade 1.",
      agrupamento:  "Por criativo, depois campanha/conjunto.",
      exibicao:     "Card 'CPL Zoho' em Visão Geral. Formatado como moeda BRL.",
      dependencias: "DASH-01 · DASH-07 · Cruzamento Meta×Zoho",
      observacoes:  "CPL Zoho é mais fiel à realidade do pipeline — representa custo por lead que efetivamente entrou no CRM."
    },

    {
      id: "DASH-12",
      name: "Custo por Reunião",
      module: "Dashboard Principal",
      moduleId: "dashboard",
      type: "metrica-financeira",
      fonte:        "Calculado — Meta Ads + Zoho CRM",
      endpoint:     "Derivado",
      campo:        "valorGasto / reunioes",
      calculo:      "safeDiv(valorGasto_total, reunioes_total). Usa o total de reuniões do período (DASH-08).",
      filtroData:   "Herdado.",
      inclusao:     "Apenas se reunioes > 0.",
      exclusao:     "Se reunioes=0, exibe R$ 0.",
      dedup:        "Usa total de reuniões já deduplicado.",
      atribuicao:   "Divisão simples — investimento total / reuniões totais.",
      agrupamento:  "Disponível por criativo na Tabela Detalhada.",
      exibicao:     "Card 'Custo/Reunião' em Visão Geral. Formatado como moeda BRL.",
      dependencias: "DASH-01 · DASH-08",
      observacoes:  "Custo agregado — não granular por criativo no card principal. Use Tabela Detalhada para análise por criativo."
    },

    {
      id: "DASH-13",
      name: "Custo por Assinatura",
      module: "Dashboard Principal",
      moduleId: "dashboard",
      type: "metrica-financeira",
      fonte:        "Calculado — Meta Ads + Zoho CRM",
      endpoint:     "Derivado",
      campo:        "valorGasto / assinaturas",
      calculo:      "safeDiv(valorGasto_total, assinaturas_total).",
      filtroData:   "Herdado.",
      inclusao:     "Apenas se assinaturas > 0.",
      exclusao:     "Se assinaturas=0, exibe R$ 0.",
      dedup:        "Usa total de assinaturas já deduplicado.",
      atribuicao:   "Divisão simples.",
      agrupamento:  "Disponível por criativo na Tabela Detalhada.",
      exibicao:     "Card 'Custo/Assinatura' em Visão Geral.",
      dependencias: "DASH-01 · DASH-09",
      observacoes:  "Métrica de eficiência final — quanto custou cada novo cliente Meta."
    },

    // =====================================================================
    // LIVE META
    // =====================================================================

    {
      id: "LM-01",
      name: "Leads Meta no CRM (Live Meta — card)",
      module: "Live Meta",
      moduleId: "livemeta",
      type: "metrica-leads",
      fonte:        "Zoho CRM — getDeals() filtrado por isMetaOrigin e período Live Meta",
      endpoint:     "/api/zoho-deals → state.zohoRows",
      campo:        "d.origem · d.horaCriacao",
      calculo:      "computeZohoMetaMetrics(lmZohoBase).metaTotal — count de deals com isMetaOrigin=true no período Live Meta, com dedup por uid.",
      filtroData:   "Período próprio do Live Meta (seletor 'De/Até' no painel Live Meta), independente do filtro global.",
      inclusao:     "isMetaOrigin(origem)=true, horaCriacao no período Live Meta.",
      exclusao:     "Deals sem origem Meta. Deals fora do período.",
      dedup:        "Por uid (GERAL-03).",
      atribuicao:   "Não se aplica — métrica de volume.",
      agrupamento:  "Total no card.",
      exibicao:     "Card superior 'Leads Meta no CRM' em Live Meta. Cor: azul.",
      dependencias: "GERAL-01 · GERAL-03 · applyLmFilter · renderLiveMetaMetrics",
      observacoes:  "O período Live Meta é independente do filtro global. Pode ser diferente do período selecionado nos outros módulos."
    },

    {
      id: "LM-02",
      name: "Reuniões Geradas Meta (Live Meta — card)",
      module: "Live Meta",
      moduleId: "livemeta",
      type: "metrica-reunioes",
      fonte:        "Zoho Analytics Report (preferencial) — state.reunioesFiltered",
      endpoint:     "getReport(ZOHO_REUNIOES_REPORT_ID)",
      campo:        "d.stage · d.origem · d.nomeContato · d.nomeNegocio · d.horaCriacao",
      calculo:      "computeReunioesReport(state.reunioesFiltered).reunioes",
      filtroData:   "filterByPeriod() sobre reunioesRows usando período Live Meta. applyLmFilter() recalcula state.reunioesFiltered ao mudar período.",
      inclusao:     "isMetaOrigin=true E stage in META_MEETING_STAGES E horaCriacao no período.",
      exclusao:     "Deals fora do período. Duplicatas. Origem não-Meta. Stage não listado.",
      dedup:        "seenMeet por uid.",
      atribuicao:   "Por origem Meta do deal.",
      agrupamento:  "Total no card. Detalhado por criativo na tabela abaixo.",
      exibicao:     "Card 'Reuniões Geradas Meta' em Live Meta. Cor: verde.",
      dependencias: "GERAL-01 à GERAL-08 · applyLmFilter · fetchLiveMeta",
      observacoes:  "Este valor deve bater com o total da coluna Reuniões da tabela Live Meta quando somados os criativos. Verificar discrepância se houver deals com reunião mas sem criativo identificável."
    },

    {
      id: "LM-03",
      name: "Assinaturas Geradas Meta (Live Meta — card)",
      module: "Live Meta",
      moduleId: "livemeta",
      type: "metrica-conversao",
      fonte:        "Zoho Analytics Report — state.reunioesFiltered",
      endpoint:     "getReport(ZOHO_REUNIOES_REPORT_ID)",
      campo:        "d.stage · d.origem",
      calculo:      "computeReunioesReport(state.reunioesFiltered).assinaturas",
      filtroData:   "filterByPeriod() sobre reunioesRows usando período Live Meta.",
      inclusao:     "isMetaOrigin=true E stage='assinatura realizada'.",
      exclusao:     "Todos os demais. Duplicatas por seenSign.",
      dedup:        "seenSign Set independente de seenMeet.",
      atribuicao:   "Por origem Meta.",
      agrupamento:  "Total no card. Detalhado por criativo na tabela.",
      exibicao:     "Card 'Assinaturas Geradas Meta' em Live Meta.",
      dependencias: "GERAL-01 · GERAL-03 · GERAL-05 · GERAL-08",
      observacoes:  "Um deal pode contar como reunião (em seenMeet) E como assinatura (em seenSign) na mesma execução de computeReunioesReport() — os Sets são independentes."
    },

    {
      id: "LM-04",
      name: "Conversão Lead → Reunião (%)",
      module: "Live Meta",
      moduleId: "livemeta",
      type: "metrica-conversao",
      fonte:        "Calculado — Zoho CRM",
      endpoint:     "Derivado",
      campo:        "reunioes / leadsZoho × 100",
      calculo:      "safeDiv(reunioes, leadsZoho) × 100",
      filtroData:   "Período Live Meta.",
      inclusao:     "leadsZoho > 0.",
      exclusao:     "Se leadsZoho=0, exibe 0%.",
      dedup:        "Usa totais já deduplicados.",
      atribuicao:   "Não se aplica.",
      agrupamento:  "Taxa global no card.",
      exibicao:     "Card em Live Meta. Formatado como 'XX.X%'.",
      dependencias: "LM-01 · LM-02",
      observacoes:  "Denomidador é Leads Zoho (não Leads Meta) para medir conversão real no pipeline."
    },

    {
      id: "LM-05",
      name: "Conversão Reunião → Assinatura (%)",
      module: "Live Meta",
      moduleId: "livemeta",
      type: "metrica-conversao",
      fonte:        "Calculado — Zoho CRM",
      endpoint:     "Derivado",
      campo:        "assinaturas / reunioes × 100",
      calculo:      "safeDiv(assinaturas, reunioes) × 100",
      filtroData:   "Período Live Meta.",
      inclusao:     "reunioes > 0.",
      exclusao:     "Se reunioes=0, exibe 0%.",
      dedup:        "Usa totais já deduplicados.",
      atribuicao:   "Não se aplica.",
      agrupamento:  "Taxa global no card.",
      exibicao:     "Card em Live Meta.",
      dependencias: "LM-02 · LM-03",
      observacoes:  "Taxa de fechamento: quantas reuniões resultam em assinatura. Meta de referência: verificar com time comercial."
    },

    {
      id: "LM-06",
      name: "Tabela de Reuniões por Criativo (Live Meta)",
      module: "Live Meta",
      moduleId: "livemeta",
      type: "tabela",
      fonte:        "Meta Ads API + Zoho CRM — cruzamento em renderLiveMeta()",
      endpoint:     "Cruzamento: metaRows × reunioesFiltered",
      campo:        "Meta: ad_id, ad_name, spend, leads. Zoho: stage, origem, metaAdsAnuncio, metaAdsId",
      calculo:      "Para cada anúncio Meta: conta deals Zoho onde countsAsMetaMeeting=true e deal foi atribuído ao anúncio via meetDealsByAdId.",
      filtroData:   "Período Live Meta — usado no fetchLiveMeta() e applyLmFilter().",
      inclusao:     "Anúncios Meta com gasto > 0 ou reuniões > 0 no período.",
      exclusao:     "Anúncios sem gasto e sem reunião (linha irrelevante). Deals sem criativo identificável vão para 'Não atribuídos'.",
      dedup:        "meetDealsByAdId construído com chave ad_id (ou __idx_i como fallback). Deals atribuídos a exatamente um criativo.",
      atribuicao:   "Prioridade 1: Meta_Ads_Anuncio (Zoho) == ad_name (Meta). Prioridade 2: Meta_Ads_ADs_ID (Zoho) == ad_id (Meta). Prioridade de campanha para desambiguar quando múltiplos criativos com mesmo nome.",
      agrupamento:  "Uma linha por anúncio Meta único (ad_id).",
      exibicao:     "Tabela em Live Meta com colunas: Criativo, Leads Meta, Leads CRM, Reuniões, Assinaturas, Invest., CPL, Custo/Reunião.",
      dependencias: "GERAL-01 à GERAL-08 · fetchLiveMeta · applyLmFilter · BUG-03 (fallback __idx_i)",
      observacoes:  "meetDealsByAdId e signDealsByAdId usam fallback __idx_${i} quando ad_id está ausente para manter consistência de chave entre build e lookup. Deals sem meta_ad_id nem meta_ad_name são 'não atribuídos' e impactam totais mas não aparecem por criativo."
    },

    {
      id: "LM-07",
      name: "Regra de Atribuição Reunião → Criativo",
      module: "Live Meta",
      moduleId: "livemeta",
      type: "regra-atribuicao",
      fonte:        "Zoho CRM — campos Meta_Ads_Anuncio e Meta_Ads_ADs_ID",
      endpoint:     "Cruzamento em renderLiveMeta()",
      campo:        "deal.metaAdsAnuncio (Meta_Ads_Anuncio) · deal.metaAdsId (Meta_Ads_ADs_ID)",
      calculo:      "byAnuncioKey: chave=normalizeKey(ad_name). byAdId: chave=ad_id. Lookup: 1) byAnuncioKey.get(deal.metaAdsAnuncioKey), 2) byAdId.get(deal.metaAdsId). Se múltiplos matches: desambigua por campanha.",
      filtroData:   "Não se aplica à atribuição em si — opera sobre dados já filtrados.",
      inclusao:     "Deals com metaAdsAnuncio ou metaAdsId preenchido.",
      exclusao:     "Deals sem metaAdsAnuncio e sem metaAdsId ficam como 'não atribuídos'.",
      dedup:        "Cada deal é atribuído a no máximo um criativo (first match wins).",
      atribuicao:   "Hierarquia: nome do anúncio > ad_id. Desambiguação por campanha quando nomes iguais em campanhas diferentes.",
      agrupamento:  "Um deal → um criativo.",
      exibicao:     "Refletida na tabela Live Meta — cada linha de criativo acumula os deals atribuídos.",
      dependencias: "LM-06 · normalizeRecord · normalizeReportRecord",
      observacoes:  "Meta_Ads_Anuncio é preenchido pelo webhook Meta Lead Ads via Make.com. Se o webhook não enviar o campo, o deal não será atribuído por nome. Meta_Ads_ADs_ID é o fallback. Deals do relatório Zoho podem não ter esses campos exportados — enriquecimento server-side é necessário."
    },

    // =====================================================================
    // VISÃO GERAL
    // =====================================================================

    {
      id: "OV-01",
      name: "Reuniões Hoje (Visão Geral)",
      module: "Visão Geral",
      moduleId: "overview",
      type: "metrica-reunioes",
      fonte:        "Zoho CRM — state.reunioesRows ou state.zohoRows",
      endpoint:     "getReport() ou getDeals()",
      campo:        "d.stage · d.origem · d.horaCriacao",
      calculo:      "computeReunioesReport(rowsToday).reunioes onde rowsToday = registros com horaCriacao == hoje (data local).",
      filtroData:   "Hoje (data local do servidor/cliente no momento da renderização).",
      inclusao:     "isMetaOrigin=true E stage in META_MEETING_STAGES E horaCriacao=hoje.",
      exclusao:     "Deals de outros dias. Duplicatas.",
      dedup:        "Por uid (GERAL-03).",
      atribuicao:   "Por origem Meta.",
      agrupamento:  "Total no card.",
      exibicao:     "Card 'Reuniões Hoje' em Visão Geral.",
      dependencias: "GERAL-01 · GERAL-02 · GERAL-03 · GERAL-08",
      observacoes:  "NOTA (BUG-05 — deferido): 'Hoje' usa horaCriacao (data de criação do lead/deal) e não a data real da reunião agendada. Um deal criado hoje com reunião amanhã conta para hoje. Um deal criado no mês passado com reunião hoje NÃO é contado. Correto seria usar o campo de data da reunião no Zoho, mas o campo precisa ser validado. Implementação atual é conservadora."
    },

    {
      id: "OV-02",
      name: "Reuniões do Período (Visão Geral)",
      module: "Visão Geral",
      moduleId: "overview",
      type: "metrica-reunioes",
      fonte:        "Zoho Analytics Report / getDeals() — state.reunioesFiltered",
      endpoint:     "getReport(ZOHO_REUNIOES_REPORT_ID)",
      campo:        "d.stage · d.origem · d.horaCriacao",
      calculo:      "computeReunioesReport(state.reunioesFiltered).reunioes",
      filtroData:   "Período do filtro global.",
      inclusao:     "isMetaOrigin=true E stage in META_MEETING_STAGES.",
      exclusao:     "Fora do período. Duplicatas.",
      dedup:        "Por uid.",
      atribuicao:   "Por origem Meta.",
      agrupamento:  "Total.",
      exibicao:     "Card em Visão Geral.",
      dependencias: "GERAL-01 à GERAL-08",
      observacoes:  "Equivalente a DASH-08 — mesma função, mesma fonte."
    },

    // =====================================================================
    // GOOGLE ADS
    // =====================================================================

    {
      id: "GA-01",
      name: "Dados Google Ads (campanhas, keywords, termos)",
      module: "Google Ads",
      moduleId: "googleads",
      type: "modulo",
      fonte:        "Google Ads API v14 — via MCC (Login Customer ID)",
      endpoint:     "/api/google-ads-report (server.js) → Google Ads API GAQL queries",
      campo:        "metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, campaign.name, ad_group_criterion.keyword.text",
      calculo:      "Custo: cost_micros / 1_000_000. Queries GAQL separadas para campanhas, ad groups, keywords, search terms.",
      filtroData:   "Período passado como segments.date BETWEEN 'YYYY-MM-DD' AND 'YYYY-MM-DD' nas queries GAQL.",
      inclusao:     "Todas as campanhas da conta MCC no período.",
      exclusao:     "Nenhuma exclusão adicional — API já filtra por conta e período.",
      dedup:        "Não se aplica — cada row da API é uma combinação única de dimensões.",
      atribuicao:   "Não se aplica na aba Google Ads — dados são da plataforma.",
      agrupamento:  "Por campanha, por ad group, por keyword, por search term.",
      exibicao:     "Aba 'Google Ads' — tabelas separadas por tipo de dado.",
      dependencias: "MCC ID via env GOOGLE_ADS_MCC_ID (SEG-02). Developer Token via GOOGLE_ADS_DEVELOPER_TOKEN.",
      observacoes:  "Não usar Zoho como fonte de campanha, keyword ou anúncio Google Ads — fonte exclusiva é a Google Ads API."
    },

    {
      id: "GA-02",
      name: "Reuniões Google Ads",
      module: "Google Ads",
      moduleId: "googleads",
      type: "metrica-reunioes",
      fonte:        "Zoho CRM — deals com origem Google Ads cruzados com relatório",
      endpoint:     "computeGoogleAdsReport(rows)",
      campo:        "d.stage · d.origem · d.nomeContato · d.nomeNegocio",
      calculo:      "count(deals no relatório Zoho de Google Ads com stage em META_MEETING_STAGES — mas origin filter diferente). Presença no relatório = 1 Reunião.",
      filtroData:   "Período filtrado antes da chamada.",
      inclusao:     "Deals no relatório Google Ads (relatório curado separado do Meta).",
      exclusao:     "Deals sem stage de reunião. Duplicatas.",
      dedup:        "Por uid — seenMeet e seenSign separados.",
      atribuicao:   "Por presença no relatório Google Ads do Zoho.",
      agrupamento:  "Total na aba Google Ads.",
      exibicao:     "Card ou tabela na aba Google Ads.",
      dependencias: "GERAL-02 · GERAL-03 · computeGoogleAdsReport",
      observacoes:  "Lógica similar a computeReunioesReport mas sem filtro de isMetaOrigin — usa relatório curado específico para Google Ads como substituto do filtro de origem."
    },

    // =====================================================================
    // TRANSFERÊNCIA
    // =====================================================================

    {
      id: "TRF-01",
      name: "Meta Conversions API (Transferência)",
      module: "Transferência",
      moduleId: "transferencia",
      type: "modulo-integracao",
      fonte:        "Zoho CRM — deals elegíveis para envio de eventos à Meta CAPI",
      endpoint:     "/api/transfer-meta (server.js) → Meta Conversions API",
      campo:        "d.metaLeadId · d.contactName · d.stage",
      calculo:      "Para cada deal elegível: constrói payload CAPI com event_name=Lead/Purchase, event_time, user_data (email hash, phone hash), custom_data.",
      filtroData:   "Definido pela seleção do usuário na aba Transferência.",
      inclusao:     "Deals com Meta Lead ID preenchido E com stage elegível (configurado pela aba).",
      exclusao:     "Deals sem Meta Lead ID. Deals já enviados (rastreamento interno).",
      dedup:        "Por Meta Lead ID — evita reenvio.",
      atribuicao:   "Evento atribuído ao pixel Meta via Meta Lead ID.",
      agrupamento:  "Batch de eventos por execução.",
      exibicao:     "Tabela de preview e log de envio na aba Transferência.",
      dependencias: "Zoho CRM · Meta Pixel ID · Meta CAPI Access Token (envs)",
      observacoes:  "Dados de PII (email, telefone) são hasheados (SHA-256) antes do envio. Nunca enviar dados brutos de PII à Meta CAPI."
    },

    // =====================================================================
    // FINANCEIRO
    // =====================================================================

    {
      id: "FIN-01",
      name: "Dados Financeiros (Financeiro)",
      module: "Financeiro",
      moduleId: "fin",
      type: "modulo",
      fonte:        "A definir — módulo em construção ou integração não documentada nesta versão.",
      endpoint:     "A definir",
      campo:        "A definir",
      calculo:      "A definir",
      filtroData:   "A definir",
      inclusao:     "A definir",
      exclusao:     "A definir",
      dedup:        "A definir",
      atribuicao:   "A definir",
      agrupamento:  "A definir",
      exibicao:     "Aba 'Financeiro'",
      dependencias: "A definir",
      observacoes:  "Este módulo precisa ser documentado na próxima revisão do Rules. Adicionar regras quando a implementação for validada."
    },

    // =====================================================================
    // KEYWORD PLANNER IA
    // =====================================================================

    {
      id: "KW-01",
      name: "Keyword Planner IA",
      module: "Keyword Planner IA",
      moduleId: "kwia",
      type: "modulo",
      fonte:        "Google Ads Keyword Planner API + IA (análise)",
      endpoint:     "/api/kw-planner (server.js) → kwPlannerService",
      campo:        "keyword, avg_monthly_searches, competition, low_bid, high_bid",
      calculo:      "Busca ideias de keywords via API do Google Ads Keyword Planner. IA analisa e prioriza.",
      filtroData:   "Período de referência configurado na busca.",
      inclusao:     "Keywords relevantes para o nicho/query informada.",
      exclusao:     "Keywords fora do escopo ou com volume insuficiente.",
      dedup:        "Por keyword text.",
      atribuicao:   "Não se aplica.",
      agrupamento:  "Por volume, competição ou relevância.",
      exibicao:     "Aba 'Keyword Planner IA'.",
      dependencias: "Google Ads API credentials · kwPlannerService.js",
      observacoes:  "Módulo de suporte à estratégia de mídia. Dados são de planejamento — não afetam métricas de performance."
    },

    // =====================================================================
    // INSIGHTS IA
    // =====================================================================

    {
      id: "INS-01",
      name: "Insights IA",
      module: "Insights IA",
      moduleId: "insights",
      type: "modulo",
      fonte:        "Dados do dashboard (criativos, métricas) + LLM (análise)",
      endpoint:     "/api/insights (server.js) → chamada LLM",
      campo:        "creatives[], metricas globais do período",
      calculo:      "Serializa dados do dashboard e envia ao LLM para análise e recomendações.",
      filtroData:   "Período selecionado no filtro global.",
      inclusao:     "Top criativos por gasto/leads/reuniões.",
      exclusao:     "Dados brutos de PII.",
      dedup:        "Não se aplica.",
      atribuicao:   "Não se aplica.",
      agrupamento:  "Por categoria de insight (oportunidade, risco, recomendação).",
      exibicao:     "Aba 'Insights IA' — texto gerado pelo LLM.",
      dependencias: "Dados do dashboard · API key LLM (env)",
      observacoes:  "Insights são gerados por IA e devem ser validados pelo time antes de qualquer decisão. Não substituem análise humana."
    }

  ];

  /* -------------------------------------------------------------------------
     RENDERER
  ------------------------------------------------------------------------- */

  const MODULE_LABELS = {
    geral:       "Sistema Geral",
    dashboard:   "Dashboard Principal",
    livemeta:    "Live Meta",
    overview:    "Visão Geral",
    googleads:   "Google Ads",
    transferencia: "Transferência",
    fin:         "Financeiro",
    kwia:        "Keyword Planner IA",
    insights:    "Insights IA"
  };

  const MODULE_ORDER = ["geral","dashboard","livemeta","overview","googleads","transferencia","fin","kwia","insights"];

  const TYPE_LABELS = {
    "regra-calculo":     "Cálculo",
    "regra-negocio":     "Negócio",
    "regra-filtro":      "Filtro",
    "regra-fonte":       "Fonte",
    "regra-atribuicao":  "Atribuição",
    "regra-performance": "Performance",
    "metrica-financeira":"Financeiro",
    "metrica-leads":     "Leads",
    "metrica-reunioes":  "Reuniões",
    "metrica-conversao": "Conversão",
    "metrica-alcance":   "Alcance",
    "metrica-engajamento":"Engajamento",
    "metrica-eficiencia":"Eficiência",
    "tabela":            "Tabela",
    "modulo":            "Módulo",
    "modulo-integracao": "Integração"
  };

  const FIELD_LABELS = [
    ["fonte",        "1. Fonte de dados"],
    ["endpoint",     "2. Endpoint / origem"],
    ["campo",        "3. Campo de origem"],
    ["calculo",      "4. Fórmula / lógica"],
    ["filtroData",   "5. Filtros de data"],
    ["inclusao",     "6. Critérios de inclusão"],
    ["exclusao",     "7. Critérios de exclusão"],
    ["dedup",        "8. Deduplicação"],
    ["atribuicao",   "9. Atribuição"],
    ["agrupamento",  "10. Agrupamento"],
    ["exibicao",     "11. Exibição"],
    ["dependencias", "12. Dependências"],
    ["observacoes",  "13–15. Observações técnicas"]
  ];

  function esc(str) {
    return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  function buildRulesHTML(filter) {
    const q = (filter || "").toLowerCase().trim();

    const matched = RULES_CATALOG.filter((r) => {
      if (!q) return true;
      const haystack = [r.id, r.name, r.module, r.type,
        ...Object.values(r)].join(" ").toLowerCase();
      return haystack.includes(q);
    });

    if (matched.length === 0) {
      return `<div class="rules-empty">Nenhuma regra encontrada para "<strong>${esc(filter)}</strong>".</div>`;
    }

    const byModule = {};
    MODULE_ORDER.forEach((m) => { byModule[m] = []; });
    matched.forEach((r) => {
      const mId = r.moduleId || "geral";
      if (!byModule[mId]) byModule[mId] = [];
      byModule[mId].push(r);
    });

    let html = "";

    MODULE_ORDER.forEach((mId) => {
      const rules = byModule[mId];
      if (!rules || rules.length === 0) return;

      html += `
        <section class="rules-module-section" data-module="${esc(mId)}">
          <h2 class="rules-module-heading">${esc(MODULE_LABELS[mId] || mId)}</h2>
          <div class="rules-cards">
      `;

      rules.forEach((r) => {
        const typeLabel = TYPE_LABELS[r.type] || r.type;
        html += `
          <article class="rules-card" data-id="${esc(r.id)}">
            <header class="rules-card__header">
              <div class="rules-card__meta">
                <span class="rules-card__id">${esc(r.id)}</span>
                <span class="rules-card__type rules-card__type--${esc(r.type)}">${esc(typeLabel)}</span>
              </div>
              <h3 class="rules-card__name">${esc(r.name)}</h3>
            </header>
            <dl class="rules-card__fields">
        `;

        FIELD_LABELS.forEach(([key, label]) => {
          const val = r[key] || r.fields?.[key] || "—";
          html += `
              <div class="rules-field">
                <dt class="rules-field__label">${esc(label)}</dt>
                <dd class="rules-field__value">${esc(val)}</dd>
              </div>
          `;
        });

        html += `
            </dl>
          </article>
        `;
      });

      html += `</div></section>`;
    });

    return html;
  }

  function buildNavHTML() {
    const counts = {};
    MODULE_ORDER.forEach((m) => { counts[m] = 0; });
    RULES_CATALOG.forEach((r) => {
      const mId = r.moduleId || "geral";
      if (counts[mId] !== undefined) counts[mId]++;
    });

    return MODULE_ORDER.map((mId) => `
      <button class="rules-nav__btn" data-module="${mId}">
        ${esc(MODULE_LABELS[mId] || mId)}
        <span class="rules-nav__count">${counts[mId]}</span>
      </button>
    `).join("");
  }

  function initRulesTab() {
    const container = document.getElementById("rulesTabContent");
    if (!container || container.dataset.initialized) return;
    container.dataset.initialized = "1";

    container.innerHTML = `
      <style>
        /* ── Rules module: tokens próprios (independentes do tema pai) ─────── */

        /* DARK — padrão */
        #rulesTabContent {
          --rt:       #e2e8f0;        /* texto principal   */
          --rt-muted: #94a3b8;        /* texto secundário  */
          --rt-faint: #64748b;        /* texto terciário   */
          --rt-accent:#7aadff;        /* azul destaque     */
          --rt-card:  rgba(255,255,255,.05);
          --rt-hdr:   rgba(59,123,255,.08);
          --rt-bdr:   rgba(255,255,255,.09);
          --rt-bdr2:  rgba(255,255,255,.05);
          --rt-nbg:   rgba(59,123,255,.18);
          --rt-cnt:   rgba(255,255,255,.09);
          --rt-inp:   rgba(255,255,255,.07);
          --rt-inp-b: rgba(255,255,255,.14);

          font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
          color: var(--rt);
          padding: 0 0 48px;
        }

        /* LIGHT via media query */
        @media (prefers-color-scheme: light) {
          #rulesTabContent {
            --rt:       #1e293b;
            --rt-muted: #475569;
            --rt-faint: #94a3b8;
            --rt-accent:#1d4ed8;
            --rt-card:  #ffffff;
            --rt-hdr:   #eff6ff;
            --rt-bdr:   #e2e8f0;
            --rt-bdr2:  #f1f5f9;
            --rt-nbg:   rgba(59,123,255,.1);
            --rt-cnt:   #f1f5f9;
            --rt-inp:   #ffffff;
            --rt-inp-b: #cbd5e1;
          }
        }

        /* LIGHT via toggle do app */
        :root[data-theme="light"] #rulesTabContent {
          --rt:       #1e293b;
          --rt-muted: #475569;
          --rt-faint: #94a3b8;
          --rt-accent:#1d4ed8;
          --rt-card:  #ffffff;
          --rt-hdr:   #eff6ff;
          --rt-bdr:   #e2e8f0;
          --rt-bdr2:  #f1f5f9;
          --rt-nbg:   rgba(59,123,255,.1);
          --rt-cnt:   #f1f5f9;
          --rt-inp:   #ffffff;
          --rt-inp-b: #cbd5e1;
        }

        /* DARK via toggle do app (garante escuro mesmo com OS em light) */
        :root[data-theme="dark"] #rulesTabContent {
          --rt:       #e2e8f0;
          --rt-muted: #94a3b8;
          --rt-faint: #64748b;
          --rt-accent:#7aadff;
          --rt-card:  rgba(255,255,255,.05);
          --rt-hdr:   rgba(59,123,255,.08);
          --rt-bdr:   rgba(255,255,255,.09);
          --rt-bdr2:  rgba(255,255,255,.05);
          --rt-nbg:   rgba(59,123,255,.18);
          --rt-cnt:   rgba(255,255,255,.09);
          --rt-inp:   rgba(255,255,255,.07);
          --rt-inp-b: rgba(255,255,255,.14);
        }

        /* ── Layout ────────────────────────────────────────────────────────── */
        .rules-header {
          display: flex;
          flex-wrap: wrap;
          align-items: flex-start;
          gap: 12px;
          padding: 24px 0 20px;
          border-bottom: 1px solid var(--rt-bdr);
          margin-bottom: 24px;
        }
        .rules-header__title { flex: 1; min-width: 200px; }
        .rules-header__title h1 {
          font-size: 1.35rem;
          font-weight: 700;
          letter-spacing: -.01em;
          margin: 0 0 4px;
          color: var(--rt);
        }
        .rules-header__title p {
          font-size: .78rem;
          color: var(--rt-faint);
          margin: 0;
        }
        .rules-search { flex: 1; min-width: 220px; max-width: 360px; }
        .rules-search input {
          width: 100%;
          box-sizing: border-box;
          padding: 9px 14px;
          border-radius: 8px;
          border: 1px solid var(--rt-inp-b);
          background: var(--rt-inp);
          color: var(--rt);
          font-size: .875rem;
          outline: none;
          transition: border-color .2s;
        }
        .rules-search input:focus { border-color: #3B7BFF; }
        .rules-search input::placeholder { color: var(--rt-faint); }

        .rules-layout {
          display: grid;
          grid-template-columns: 200px 1fr;
          gap: 24px;
          align-items: start;
        }
        @media (max-width: 640px) {
          .rules-layout { grid-template-columns: 1fr; }
          .rules-nav { display: flex; flex-wrap: wrap; gap: 6px; position: static; }
        }

        /* ── Navegação lateral ──────────────────────────────────────────────── */
        .rules-nav {
          position: sticky;
          top: 60px;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .rules-nav__label {
          font-size: .68rem;
          text-transform: uppercase;
          letter-spacing: .08em;
          color: var(--rt-faint);
          margin: 0 0 6px 10px;
        }
        .rules-nav__btn {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 12px;
          border-radius: 7px;
          border: none;
          background: transparent;
          color: var(--rt-muted);
          font-size: .8rem;
          cursor: pointer;
          text-align: left;
          transition: background .15s, color .15s;
        }
        .rules-nav__btn:hover { background: var(--rt-nbg); color: var(--rt); }
        .rules-nav__btn.active { background: var(--rt-nbg); color: var(--rt-accent); }
        .rules-nav__count {
          font-size: .68rem;
          background: var(--rt-cnt);
          color: var(--rt-muted);
          border-radius: 10px;
          padding: 1px 6px;
        }

        /* ── Cards ──────────────────────────────────────────────────────────── */
        .rules-content { min-width: 0; }
        .rules-module-section { margin-bottom: 40px; }
        .rules-module-heading {
          font-size: 1rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: .06em;
          color: var(--rt-accent);
          margin: 0 0 16px;
          padding-bottom: 8px;
          border-bottom: 1px solid var(--rt-bdr);
        }
        .rules-cards { display: flex; flex-direction: column; gap: 14px; }
        .rules-card {
          background: var(--rt-card);
          border: 1px solid var(--rt-bdr);
          border-radius: 10px;
          overflow: hidden;
        }
        .rules-card__header {
          padding: 14px 18px 12px;
          background: var(--rt-hdr);
          border-bottom: 1px solid var(--rt-bdr2);
        }
        .rules-card__meta {
          display: flex;
          gap: 8px;
          align-items: center;
          margin-bottom: 6px;
        }
        .rules-card__id {
          font-family: monospace;
          font-size: .72rem;
          background: rgba(59,123,255,.18);
          color: var(--rt-accent);
          padding: 2px 8px;
          border-radius: 4px;
          font-weight: 600;
        }
        .rules-card__type {
          font-size: .68rem;
          padding: 2px 8px;
          border-radius: 4px;
          background: var(--rt-cnt);
          color: var(--rt-muted);
          text-transform: uppercase;
          letter-spacing: .04em;
        }
        .rules-card__type--metrica-reunioes  { background: rgba(34,197,94,.15); color: #16a34a; }
        .rules-card__type--metrica-conversao  { background: rgba(168,85,247,.15); color: #7c3aed; }
        .rules-card__type--metrica-financeira { background: rgba(202,138,4,.15);  color: #b45309; }
        .rules-card__type--metrica-leads      { background: rgba(59,130,246,.15); color: #1d4ed8; }
        .rules-card__type--regra-calculo      { background: rgba(236,72,153,.12); color: #be185d; }
        .rules-card__type--regra-negocio      { background: rgba(20,184,166,.12); color: #0f766e; }
        .rules-card__type--regra-filtro       { background: rgba(99,102,241,.15); color: #4338ca; }
        /* dark variants via token — restaura contraste em fundo escuro */
        :root[data-theme="dark"] .rules-card__type--metrica-reunioes  { color: #4ade80; }
        :root[data-theme="dark"] .rules-card__type--metrica-conversao  { color: #c084fc; }
        :root[data-theme="dark"] .rules-card__type--metrica-financeira { color: #fbbf24; }
        :root[data-theme="dark"] .rules-card__type--metrica-leads      { color: #60a5fa; }
        :root[data-theme="dark"] .rules-card__type--regra-calculo      { color: #f472b6; }
        :root[data-theme="dark"] .rules-card__type--regra-negocio      { color: #2dd4bf; }
        :root[data-theme="dark"] .rules-card__type--regra-filtro       { color: #a5b4fc; }
        @media (prefers-color-scheme: dark) {
          .rules-card__type--metrica-reunioes  { color: #4ade80; }
          .rules-card__type--metrica-conversao  { color: #c084fc; }
          .rules-card__type--metrica-financeira { color: #fbbf24; }
          .rules-card__type--metrica-leads      { color: #60a5fa; }
          .rules-card__type--regra-calculo      { color: #f472b6; }
          .rules-card__type--regra-negocio      { color: #2dd4bf; }
          .rules-card__type--regra-filtro       { color: #a5b4fc; }
        }
        .rules-card__name {
          font-size: .9rem;
          font-weight: 600;
          margin: 0;
          line-height: 1.4;
          color: var(--rt);
        }
        .rules-card__fields {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: 0;
          margin: 0;
          padding: 0;
        }
        .rules-field {
          padding: 10px 18px;
          border-bottom: 1px solid var(--rt-bdr2);
          border-right: 1px solid var(--rt-bdr2);
        }
        .rules-field:last-child { border-bottom: none; }
        .rules-field__label {
          font-size: .67rem;
          text-transform: uppercase;
          letter-spacing: .06em;
          color: var(--rt-faint);
          margin-bottom: 3px;
          font-weight: 600;
        }
        .rules-field__value {
          font-size: .78rem;
          line-height: 1.55;
          margin: 0;
          color: var(--rt);
          word-break: break-word;
        }
        .rules-empty {
          padding: 48px;
          text-align: center;
          color: var(--rt-muted);
          font-size: .9rem;
        }
        .rules-stats {
          font-size: .75rem;
          color: var(--rt-faint);
          margin-bottom: 16px;
        }
      </style>

      <div class="rules-header">
        <div class="rules-header__title">
          <h1>📘 Rules — Documentação Técnica Oficial</h1>
          <p>v${RULES_META.version} · atualizado em ${RULES_META.updatedAt} · ${RULES_CATALOG.length} regras documentadas</p>
        </div>
        <div class="rules-search">
          <input id="rulesSearchInput" type="search" placeholder="Buscar regra, métrica, campo…" autocomplete="off" />
        </div>
      </div>

      <div class="rules-layout">
        <nav class="rules-nav" aria-label="Módulos">
          <div class="rules-nav__label">Módulos</div>
          ${buildNavHTML()}
        </nav>
        <div class="rules-content">
          <div class="rules-stats" id="rulesStats">${RULES_CATALOG.length} regras em ${MODULE_ORDER.length} módulos</div>
          <div id="rulesBody">${buildRulesHTML()}</div>
        </div>
      </div>
    `;

    // Search
    const searchInput = container.querySelector("#rulesSearchInput");
    const body        = container.querySelector("#rulesBody");
    const stats       = container.querySelector("#rulesStats");
    let debounceTimer;

    searchInput.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const q = searchInput.value.trim();
        body.innerHTML = buildRulesHTML(q);
        const count = RULES_CATALOG.filter((r) => {
          if (!q) return true;
          return [r.id, r.name, r.module, r.type, ...Object.values(r)].join(" ").toLowerCase().includes(q.toLowerCase());
        }).length;
        stats.textContent = q
          ? `${count} de ${RULES_CATALOG.length} regras para "${q}"`
          : `${RULES_CATALOG.length} regras em ${MODULE_ORDER.length} módulos`;
        highlightActiveModule();
      }, 200);
    });

    // Nav module scroll / highlight
    function highlightActiveModule() {
      const sections = body.querySelectorAll(".rules-module-section");
      const navBtns  = container.querySelectorAll(".rules-nav__btn");

      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            navBtns.forEach((b) => b.classList.remove("active"));
            const mId = entry.target.dataset.module;
            const btn = container.querySelector(`.rules-nav__btn[data-module="${mId}"]`);
            if (btn) btn.classList.add("active");
          }
        });
      }, { threshold: 0.15 });

      sections.forEach((s) => observer.observe(s));
    }

    container.querySelectorAll(".rules-nav__btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mId = btn.dataset.module;
        const section = body.querySelector(`.rules-module-section[data-module="${mId}"]`);
        if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
        container.querySelectorAll(".rules-nav__btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
      });
    });

    highlightActiveModule();
  }

  /* -------------------------------------------------------------------------
     INICIALIZAÇÃO — ativa ao clicar na aba Rules
  ------------------------------------------------------------------------- */
  document.addEventListener("DOMContentLoaded", () => {
    const rulesBtn = document.querySelector('.tab-btn[data-tab="rules"]');
    if (rulesBtn) {
      rulesBtn.addEventListener("click", () => {
        // Pequeno delay para o DOM da aba se tornar visível
        requestAnimationFrame(() => initRulesTab());
      });
    }
  });

  // Expõe para inspeção/testes
  window.__RULES_CATALOG__ = RULES_CATALOG;
  window.__RULES_META__    = RULES_META;

})();
