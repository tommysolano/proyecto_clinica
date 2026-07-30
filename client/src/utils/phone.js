// Formateo de teléfonos para MOSTRAR. La normalización de verdad (la que decide
// la identidad del contacto) vive en el servidor: server/utils/phoneNormalize.js.
// Aquí solo se maqueta lo que ya viene en E.164 sin '+'.

/** 593999111222 → +593 99 911 1222 */
export function formatPhone(e164) {
  const s = String(e164 || '').replace(/\D/g, '');
  if (!s) return '';
  if (/^5939\d{8}$/.test(s)) {
    // Móvil ecuatoriano: +593 99 911 1222
    return `+593 ${s.slice(3, 5)} ${s.slice(5, 8)} ${s.slice(8)}`;
  }
  if (/^593\d{8}$/.test(s)) {
    // Fijo ecuatoriano: +593 4 291 1222
    return `+593 ${s.slice(3, 4)} ${s.slice(4, 7)} ${s.slice(7)}`;
  }
  return `+${s}`;
}

// Búsqueda por teléfono para los filtros que se resuelven en el navegador
// (listas ya cargadas). Es el espejo de server/utils/phoneNormalize.js →
// phoneSearchRegex: se comparan DÍGITOS y se prueban las variantes con y sin el
// 0 de marcación nacional y con y sin indicativo, para que 0988535561,
// 098 853 5561 y +593 98 853 5561 encuentren al 593988535561 guardado.
const MIN_SEARCH_DIGITS = 4;
const DEFAULT_COUNTRY = '593';

/** ¿Alguno de estos teléfonos es el que se escribió en el buscador? */
export function phoneMatches(query, phones) {
  let digits = String(query ?? '').replace(/\D/g, '');
  if (digits.length < MIN_SEARCH_DIGITS) return false;
  if (digits.startsWith('00')) digits = digits.slice(2);

  const variants = new Set([digits]);
  const nsn = digits.replace(/^0+/, '');
  if (nsn.length >= MIN_SEARCH_DIGITS) variants.add(nsn);
  if (nsn.startsWith(DEFAULT_COUNTRY)) {
    const local = nsn.slice(DEFAULT_COUNTRY.length);
    if (local.length >= MIN_SEARCH_DIGITS) {
      variants.add(local);
      variants.add(`0${local}`);
    }
  }

  const list = (Array.isArray(phones) ? phones : [phones])
    .filter(Boolean)
    .map((p) => String(p).replace(/\D/g, ''));
  return list.some((p) => [...variants].some((v) => p.includes(v)));
}

/** Nombre a mostrar de un contacto: lo que haya, y si no el teléfono. */
export function contactName(c) {
  if (!c) return '';
  const full = `${c.firstName || ''} ${c.lastName || ''}`.trim();
  return full || c.displayName || formatPhone(c.phone);
}
