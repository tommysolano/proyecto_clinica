/**
 * Normaliza teléfonos a E.164 sin '+' (solo dígitos: 593999111222), que es como
 * WhatsApp identifica a un destinatario y como el CRM guarda `Conversation.phone`.
 *
 * Es la pieza de la que depende todo el importador: si un número no se normaliza
 * igual siempre, ni se deduplica (entra dos veces) ni se puede enviar.
 *
 * Un Excel de contactos ecuatoriano trae de todo:
 *   0999111222      → móvil local con 0        → 593999111222
 *   099 911 1222    → con espacios             → 593999111222
 *   +593 99 911 1222→ ya internacional         → 593999111222
 *   593999111222    → ya normalizado           → 593999111222
 *   999111222       → móvil sin 0 ni país      → 593999111222
 *   042345678       → fijo de Guayaquil        → 59342345678
 *   +57 311 3380263 → extranjero (Colombia)    → 573113380263
 *   00593999111222  → prefijo internacional 00 → 593999111222
 *
 * El país por defecto es Ecuador (593) y solo se aplica a números SIN indicativo.
 */

const DEFAULT_COUNTRY = '593';

// Longitud del número nacional (sin país) en Ecuador: móvil 9 (9XXXXXXXX) y
// fijo 8 (XXXXXXXX con código de provincia de 1 dígito).
const EC_MOBILE_NSN = 9;
const EC_LANDLINE_NSN = 8;

/**
 * @returns {{ ok: boolean, phone?: string, reason?: string }}
 *   `phone` en E.164 sin '+'. `reason` explica por qué se descartó, para poder
 *   enseñárselo al usuario en el informe de errores de la importación.
 */
function normalizePhone(raw, { defaultCountry = DEFAULT_COUNTRY } = {}) {
  const input = String(raw ?? '').trim();
  if (!input) return { ok: false, reason: 'vacío' };

  // Notación científica de Excel: una celda numérica larga puede llegar como
  // 5.93999e+11 y perdería el número. Mejor rechazar que guardar basura.
  if (/e\+?\d/i.test(input)) {
    return { ok: false, reason: 'la celda vino en notación científica: formatéala como texto en Excel' };
  }

  const hadPlus = input.startsWith('+');
  let digits = input.replace(/\D/g, '');
  if (!digits) return { ok: false, reason: 'no contiene dígitos' };

  // Prefijo internacional marcado con 00 (España/LatAm) → equivale a '+'.
  let international = hadPlus;
  if (!international && digits.startsWith('00')) {
    digits = digits.slice(2);
    international = true;
  }

  // Ya viene con indicativo explícito: se respeta tal cual (puede ser extranjero).
  if (international) {
    if (digits.length < 8 || digits.length > 15) {
      return { ok: false, reason: `longitud inválida (${digits.length} dígitos)` };
    }
    return { ok: true, phone: digits };
  }

  // Sin '+': puede traer ya el país pegado (593...) o ser un número local.
  if (digits.startsWith(defaultCountry)) {
    const nsn = digits.slice(defaultCountry.length);
    // Ojo: un fijo local "5932345678" empieza por 593 por casualidad. Solo se
    // trata como internacional si lo que queda es un número nacional plausible.
    if (nsn.length === EC_MOBILE_NSN || nsn.length === EC_LANDLINE_NSN) {
      return { ok: true, phone: digits };
    }
  }

  // Número local: se le quita el 0 de marcación nacional.
  const nsn = digits.replace(/^0+/, '');
  if (!nsn) return { ok: false, reason: 'no contiene dígitos' };
  if (nsn.length !== EC_MOBILE_NSN && nsn.length !== EC_LANDLINE_NSN) {
    return {
      ok: false,
      reason: `no parece un número de Ecuador (${nsn.length} dígitos); si es del extranjero escríbelo con +indicativo`,
    };
  }
  return { ok: true, phone: `${defaultCountry}${nsn}` };
}

/** ¿Es un móvil ecuatoriano? Solo a estos se les puede escribir por WhatsApp. */
function isEcuadorMobile(e164) {
  return /^5939\d{8}$/.test(String(e164 || ''));
}

/** Formato legible para la UI: +593 99 911 1222 */
function formatPhone(e164) {
  const d = String(e164 || '');
  if (!d) return '';
  if (isEcuadorMobile(d)) {
    return `+${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  }
  return `+${d}`;
}

module.exports = { normalizePhone, isEcuadorMobile, formatPhone, DEFAULT_COUNTRY };
