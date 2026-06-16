/**
 * utils/normalize.js
 * Funções de normalização de texto compartilhadas entre frontend e backend.
 */

function stripAccents(str) {
  return String(str).normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function normalizeKey(str) {
  if (str === null || str === undefined) return "";
  return stripAccents(String(str))
    .replace(/[  ​‌‍﻿\s]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function cleanDisplay(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/[  ​‌‍﻿\s]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

module.exports = { normalizeKey, cleanDisplay, stripAccents };
