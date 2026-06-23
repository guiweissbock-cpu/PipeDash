/**
 * services/figmaService.js
 * Integração com a Figma REST API v1.
 * Autenticação exclusivamente no backend via FIGMA_ACCESS_TOKEN.
 * Token nunca é exposto ao frontend ou logado.
 *
 * Preparado para etapa futura: substituição de texto, imagem e paleta
 * em templates, seguido de exportação PNG para geração de criativos.
 */

const FIGMA_BASE = "https://api.figma.com/v1";

function authHeaders() {
  const token = process.env.FIGMA_ACCESS_TOKEN;
  if (!token) throw new Error("FIGMA_ACCESS_TOKEN não configurado no .env");
  return { "X-Figma-Token": token };
}

async function fetchFigma(path) {
  const resp = await fetch(`${FIGMA_BASE}${path}`, { headers: authHeaders() });
  if (!resp.ok) {
    // Não loga o body completo para evitar vazar detalhes sensíveis
    throw new Error(`Figma API respondeu com status ${resp.status} em ${path}`);
  }
  return resp.json();
}

/**
 * Testa se o token está válido consultando o endpoint /me.
 * Retorna dados públicos do usuário (handle, email).
 */
async function testConnection() {
  const data = await fetchFigma("/me");
  return {
    message: "Conexão com Figma funcionando",
    user:    data.handle || "(sem handle)",
    email:   data.email  || "(sem email)",
  };
}

/**
 * Extrai frames de nível 1 de uma página do documento Figma.
 * Retorna lista com id, nome, dimensões e página de origem.
 */
function extractFrames(document) {
  const frames = [];
  for (const page of document.children || []) {
    if (page.type !== "CANVAS") continue;
    for (const node of page.children || []) {
      if (node.type !== "FRAME") continue;
      frames.push({
        id:     node.id,
        name:   node.name,
        page:   page.name,
        width:  node.absoluteBoundingBox?.width  ?? null,
        height: node.absoluteBoundingBox?.height ?? null,
      });
    }
  }
  return frames;
}

/**
 * Busca metadados completos de um arquivo Figma.
 * Usa depth=2 para obter páginas e frames sem baixar o arquivo inteiro.
 * fileKey pode vir do parâmetro ou da variável FIGMA_FILE_KEY.
 */
async function getFile(fileKey) {
  const key = fileKey || process.env.FIGMA_FILE_KEY;
  if (!key) throw new Error("FIGMA_FILE_KEY não configurado no .env e nenhum fileKey foi informado");

  const data   = await fetchFigma(`/files/${encodeURIComponent(key)}?depth=2`);
  const frames = extractFrames(data.document || {});
  const pages  = (data.document?.children || []).map(page => ({
    id:         page.id,
    name:       page.name,
    frameCount: (page.children || []).filter(n => n.type === "FRAME").length,
  }));

  return {
    name:         data.name,
    lastModified: data.lastModified,
    version:      data.version,
    thumbnailUrl: data.thumbnailUrl || null,
    pages,
    frames,
  };
}

/**
 * Retorna apenas a lista de frames do arquivo.
 * Atalho para o endpoint /api/figma/frames.
 */
async function getFrames(fileKey) {
  const { frames } = await getFile(fileKey);
  return frames;
}

/*
 * ── Preparação para etapa futura: geração de criativos ─────────────────────
 *
 * As funções abaixo ainda NÃO estão implementadas.
 * Servem como contratos da API que será usada quando a feature de
 * criação de criativos estiver pronta.
 *
 * async function duplicateFrame(fileKey, frameId, newName) { ... }
 *   // POST /v1/files/:key — duplica um frame/template para edição
 *
 * async function updateTextNode(fileKey, nodeId, newText) { ... }
 *   // PUT /v1/files/:key/nodes — substitui headline, subheadline ou CTA
 *
 * async function exportFrame(fileKey, nodeId, format = "PNG", scale = 2) { ... }
 *   // GET /v1/images/:key — exporta o frame como PNG 1080×1080
 *   // Retorna uma URL temporária para download (~30min de validade)
 *
 * Paleta PipeLovers para referência futura:
 *   primary:   #7C3AED  (roxo)
 *   secondary: #F59E0B  (âmbar)
 *   bg:        #0F172A  (dark navy)
 *   text:      #F1F5F9  (branco-gelo)
 */

module.exports = { testConnection, getFile, getFrames };
