/**
 * config/fieldMap.js
 * Mapeamento dos campos customizados do Zoho CRM.
 * Edite os valores (lado direito) para corresponder aos nomes técnicos
 * dos campos no seu Zoho CRM, sem precisar alterar o restante do código.
 */

module.exports = {
  // Campos padrão
  dealName:    "Deal_Name",
  contactName: "Contact_Name",
  leadSource:  "Lead_Source",
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
