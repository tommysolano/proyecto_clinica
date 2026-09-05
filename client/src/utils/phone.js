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

/**
 * UN SOLO CAMPO «TELÉFONO» PARA LOS DOS NÚMEROS.
 *
 * El formulario pedía «Teléfono» y «WhatsApp» por separado, y en la práctica es
 * el mismo número: se tecleaba dos veces, o se dejaba el segundo en blanco. Pero
 * los dos campos NO son decorativos — todo el envío del CRM resuelve el destino
 * como `whatsapp || phone` (workflows, campañas, recordatorios) —, así que la
 * gente que sí tiene dos números tenía que poder seguir guardando los dos.
 *
 * La solución es de pantalla, no de datos: un único campo donde caben uno o dos
 * números separados por «/», y estas dos funciones los juntan al abrir y los
 * reparten al guardar. En la base sigue habiendo `phone` y `whatsapp` y nada
 * más abajo cambia.
 */
const SEPARADOR = ' / ';

/** phone + whatsapp → lo que se enseña en el campo (sin repetir si son iguales). */
export const unirTelefonos = (phone, whatsapp) => {
  const a = String(phone || '').trim();
  const b = String(whatsapp || '').trim();
  if (a && b && a !== b) return `${a}${SEPARADOR}${b}`;
  return a || b;
};

/**
 * Lo escrito → { phone, whatsapp }. El PRIMERO es el teléfono y el SEGUNDO el de
 * WhatsApp, que es el orden en que estaban los dos campos de antes: así un
 * paciente que ya tenía dos números distintos se abre y se vuelve a guardar sin
 * que se le crucen.
 *
 * Con un solo número, `whatsapp` se deja VACÍO a propósito en vez de duplicarlo:
 * quien envía ya hace `whatsapp || phone`, y duplicar el dato obliga a acertar en
 * dos sitios cada vez que alguien cambia de número.
 */
export const partirTelefonos = (texto) => {
  const partes = String(texto || '')
    .split(/[/,;|]+|\s+y\s+/i)
    .map((t) => t.trim())
    .filter(Boolean);
  return { phone: partes[0] || '', whatsapp: partes[1] || '' };
};
