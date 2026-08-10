/**
 * Catálogo CIE-10 (Clasificación Internacional de Enfermedades, 10.ª revisión)
 * en español, completo: 14.212 códigos entre categorías de 3 dígitos (E11) y
 * subcategorías de 4 (E11.9).
 *
 * Vive en el repositorio (`data/cie10.json`) y se carga UNA vez en memoria al
 * arrancar el backend: no hay que sembrar nada en la base ni depende de Mongo,
 * así el buscador del doctor responde al instante.
 *
 * La búsqueda ignora tildes, mayúsculas y el punto del código, y acepta varias
 * palabras (todas deben aparecer): "diabetes pie" encuentra "Diabetes mellitus
 * … con complicaciones circulatorias periféricas".
 */
const CATALOG = require('../data/cie10.json');

// Quita tildes/diacríticos para que "cefalea" y "céfalea" encuentren lo mismo.
// El rango va por escape (no con el carácter literal) para no depender de que
// el archivo se guarde en UTF-8.
const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');
const normalize = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase();

// Índice precalculado (código sin punto + descripción normalizada) para no
// re-normalizar 14 mil descripciones en cada pulsación de tecla.
const INDEX = CATALOG.map((c) => ({
  code: c.code,
  description: c.description,
  codeKey: c.code.replace(/\./g, '').toLowerCase(),
  descKey: normalize(c.description),
}));

/**
 * Busca en el catálogo y devuelve `[{ code, description }]` ordenado por
 * relevancia: código exacto → código que empieza igual → la descripción empieza
 * por el texto → coincide por palabra completa → coincide en cualquier parte.
 */
function searchCie10(query, limit = 50) {
  const raw = String(query || '').trim();
  const max = Math.min(Math.max(Number(limit) || 50, 1), 200);
  // Sin texto: primeros códigos del catálogo (el buscador abre con algo visible).
  if (!raw) return CATALOG.slice(0, max).map(({ code, description }) => ({ code, description }));

  const q = normalize(raw);
  const codeQ = q.replace(/[^a-z0-9]/g, '');
  const terms = q.split(/\s+/).filter(Boolean);

  const scored = [];
  for (const item of INDEX) {
    let score = null;
    if (codeQ && item.codeKey === codeQ) score = 0;
    else if (codeQ && item.codeKey.startsWith(codeQ)) score = 1;
    else if (terms.every((t) => item.descKey.includes(t))) {
      if (item.descKey.startsWith(q)) score = 2;
      else if (terms.every((t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(item.descKey))) score = 3;
      else score = 4;
    }
    if (score !== null) scored.push({ score, code: item.code, description: item.description });
  }

  scored.sort((a, b) => a.score - b.score || (a.code < b.code ? -1 : 1));
  return scored.slice(0, max).map(({ code, description }) => ({ code, description }));
}

/** Descripción oficial de un código (o '' si no existe en el catálogo). */
function describeCie10(code) {
  const key = String(code || '').replace(/\./g, '').toLowerCase();
  return INDEX.find((i) => i.codeKey === key)?.description || '';
}

module.exports = { searchCie10, describeCie10, count: CATALOG.length };
