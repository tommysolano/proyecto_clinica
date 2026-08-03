/**
 * TARIFAS DE IVA DEL SRI (Ecuador) — fuente única del frontend.
 *
 * El 12 % quedó DEROGADO (la tarifa general es el 15 %) y se incorporó el 5 % para sectores
 * específicos. Ofrecer el 12 % en los desplegables llevaba a liquidar mal el IVA y el 104.
 *
 * Las tarifas históricas NO se borran: un comprobante ya emitido conserva la suya, y si el
 * `<select>` no tuviera su valor mostraría una tarifa distinta a la contabilizada. Por eso
 * `vatRateOptions(actual)` añade la vigente del documento cuando no está entre las actuales.
 */

/** Tarifas que se ofrecen al capturar un documento nuevo. */
export const VAT_RATES = [0, 5, 15];

/** Etiquetas de las tarifas que ya no se ofrecen, pero pueden venir en documentos guardados. */
export const LEGACY_VAT_LABEL = {
  8: '8% (histórico)',
  12: '12% (derogado)',
  13: '13% (histórico)',
  14: '14% (histórico)',
};

/** Código de tarifa del SRI (tabla 16). Espejo de `server/utils/tax.js#sriVatCode`. */
export const SRI_VAT_CODE = { 0: '0', 5: '5', 12: '2', 13: '10', 14: '3', 15: '4' };

/**
 * Opciones para un `<select>` de tarifa: las vigentes + la del documento si es histórica.
 * @param {number} current tarifa que ya tiene el documento (o undefined en uno nuevo)
 * @returns {{value:number,label:string,legacy:boolean}[]}
 */
export function vatRateOptions(current) {
  const options = VAT_RATES.map((v) => ({ value: v, label: `${v}%`, legacy: false }));
  const n = Number(current);
  if (Number.isFinite(n) && n >= 0 && !VAT_RATES.includes(n)) {
    options.push({ value: n, label: LEGACY_VAT_LABEL[n] || `${n}%`, legacy: true });
  }
  return options;
}
