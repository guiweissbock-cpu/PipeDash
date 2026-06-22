/**
 * config/fieldMap.js
 * Mapeamento dos campos do Zoho CRM (Deals).
 * Nomes técnicos verificados diretamente via API em 2026-06-16.
 */

module.exports = {
  // Campos padrão
  dealName:    "Deal_Name",
  contactName: "Contact_Name",
  leadSource:  "Origem",
  stage:       "Stage",
  createdTime: "Created_Time",

  // Campos customizados Meta Ads
  metaAdId:       "Meta_Ads_ADs_ID",       // Meta Ads - ADs ID
  metaAdName:     "Meta_Ads_Anuncio",       // Meta Ads - Anuncio
  metaCampaign:   "Meta_Ads_Campanha",      // Meta Ads - Campanha
  metaLeadId:     "Meta_Ads_Lead_ID",       // Meta Ads - Lead ID
  metaCampaignId: "Meta_Ads_Campanha_ID",   // Meta Ads Campanha ID

  // Campo ICP
  icp: "ICP",
};
