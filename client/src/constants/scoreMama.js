/**
 * Espejo de server/constants/scoreMama.js — SCORE MAMÁ del MSP de Ecuador.
 *
 * El cliente puntúa mientras la ginecóloga escribe (para que vea el total al
 * momento) y el servidor VUELVE A PUNTUAR al guardar. Si cambias los cortes de
 * la tabla aquí, cámbialos también allá o el total que se ve dejará de ser el
 * que queda en la historia clínica.
 */

export const SCORE_MAMA_PARAMETROS = [
  {
    key: 'fc',
    label: 'FC',
    unidad: 'lpm',
    tramos: [
      { hasta: 50, puntaje: 3 },
      { hasta: 59, puntaje: 1 },
      { hasta: 100, puntaje: 0 },
      { hasta: 110, puntaje: 1 },
      { hasta: 119, puntaje: 2 },
      { puntaje: 3 },
    ],
  },
  {
    key: 'sistolica',
    label: 'Sistólica',
    unidad: 'mmHg',
    tramos: [
      { hasta: 70, puntaje: 3 },
      { hasta: 89, puntaje: 2 },
      { hasta: 139, puntaje: 0 },
      { hasta: 159, puntaje: 2 },
      { puntaje: 3 },
    ],
  },
  {
    key: 'diastolica',
    label: 'Diastólica',
    unidad: 'mmHg',
    tramos: [
      { hasta: 50, puntaje: 3 },
      { hasta: 59, puntaje: 2 },
      { hasta: 85, puntaje: 0 },
      { hasta: 89, puntaje: 1 },
      { hasta: 109, puntaje: 2 },
      { puntaje: 3 },
    ],
  },
  {
    key: 'fr',
    label: 'FR',
    unidad: 'rpm',
    tramos: [
      { hasta: 11, puntaje: 3 },
      { hasta: 22, puntaje: 0 },
      { hasta: 29, puntaje: 2 },
      { puntaje: 3 },
    ],
  },
  {
    key: 'temperatura',
    label: 'T °C',
    unidad: '°C',
    tramos: [
      { hasta: 35.5, puntaje: 2 },
      { hasta: 37.2, puntaje: 0 },
      { hasta: 38.4, puntaje: 1 },
      { puntaje: 3 },
    ],
  },
  {
    key: 'saturacion',
    label: 'Sat',
    unidad: '%',
    tramos: [
      { hasta: 85, puntaje: 3 },
      { hasta: 89, puntaje: 2 },
      { hasta: 93, puntaje: 1 },
      { puntaje: 0 },
    ],
  },
];

export const SCORE_MAMA_CONCIENCIA = [
  { key: 'alerta', label: 'Alerta', puntaje: 0 },
  { key: 'voz', label: 'Responde a la voz / somnolienta', puntaje: 1 },
  { key: 'confusa', label: 'Confusa / agitada', puntaje: 2 },
  { key: 'dolor', label: 'Responde al dolor / estuporosa', puntaje: 2 },
  { key: 'no_responde', label: 'No responde', puntaje: 3 },
];

export const SCORE_MAMA_PROTEINURIA = [
  { key: 'negativa', label: 'Negativa (−)', puntaje: 0 },
  { key: 'positiva', label: 'Positiva', puntaje: 1 },
];

export const SCORE_MAMA_NUMERICOS_KEYS = SCORE_MAMA_PARAMETROS.map((p) => p.key);

/** Puntaje de un parámetro numérico. `null` si no hay valor consignado. */
export function puntajeNumerico(key, valor) {
  const param = SCORE_MAMA_PARAMETROS.find((p) => p.key === key);
  if (!param) return null;
  if (valor === '' || valor == null) return null;
  const n = Number(valor);
  if (!Number.isFinite(n)) return null;
  for (const tramo of param.tramos) {
    if (tramo.hasta == null || n <= tramo.hasta) return tramo.puntaje;
  }
  return null;
}

function puntajeOpcion(lista, key) {
  const op = lista.find((o) => o.key === key);
  return op ? op.puntaje : null;
}

/**
 * Puntúa un Score MAMÁ completo. `total` es null si no se consignó ningún
 * parámetro: un 0 se lee como "paciente estable" y decir eso sin haber medido
 * nada sería peor que no decir nada.
 */
export function calcularScoreMama(datos = {}) {
  const puntajes = {};
  for (const key of SCORE_MAMA_NUMERICOS_KEYS) {
    puntajes[key] = puntajeNumerico(key, datos[key]);
  }
  puntajes.conciencia = puntajeOpcion(SCORE_MAMA_CONCIENCIA, datos.conciencia);
  puntajes.proteinuria = puntajeOpcion(SCORE_MAMA_PROTEINURIA, datos.proteinuria);

  const consignados = Object.values(puntajes).filter((p) => p != null);
  const total = consignados.length ? consignados.reduce((a, b) => a + b, 0) : null;
  return { puntajes, total };
}

/**
 * Color del semáforo según el total. Los cortes son los de la norma: 0 es
 * seguimiento normal, 1-5 obliga a vigilancia y valorar, 6 o más activa la clave
 * obstétrica.
 */
export function scoreMamaTono(total) {
  if (total == null) return 'slate';
  if (total >= 6) return 'red';
  if (total >= 1) return 'amber';
  return 'emerald';
}

/** "120/80" → { sistolica: 120, diastolica: 80 }. Sin barra, no hay nada que leer. */
export function parseTensionArterial(ta) {
  const m = /^\s*(\d{2,3})\s*\/\s*(\d{2,3})\s*$/.exec(String(ta || ''));
  if (!m) return { sistolica: null, diastolica: null };
  return { sistolica: Number(m[1]), diastolica: Number(m[2]) };
}

const numOrNull = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Valores del Score MAMÁ que ya están en los signos vitales del seguimiento.
 *
 * La ginecóloga NO tiene que teclear la frecuencia cardíaca dos veces: el
 * seguimiento ya la pide arriba, y pedirla otra vez es la forma más rápida de
 * que los dos números acaben distintos en la misma consulta.
 */
export function scoreMamaDesdeSignos(vs = {}) {
  const { sistolica, diastolica } = parseTensionArterial(vs.bloodPressure);
  return {
    fc: numOrNull(vs.heartRate),
    sistolica,
    diastolica,
    fr: numOrNull(vs.respiratoryRate),
    temperatura: numOrNull(vs.temperature),
    saturacion: numOrNull(vs.oxygenSaturation),
  };
}

/**
 * Score MAMÁ efectivo: lo escrito a mano MANDA sobre lo que viene de los signos
 * vitales (la toma del score puede ser otra, más tarde o en otro brazo).
 */
export function mezclarScoreMama(scoreMama, vitalSigns) {
  const derivado = scoreMamaDesdeSignos(vitalSigns);
  const propio = scoreMama || {};
  const mezcla = { ...derivado };
  for (const key of SCORE_MAMA_NUMERICOS_KEYS) {
    const v = numOrNull(propio[key]);
    if (v != null) mezcla[key] = v;
  }
  mezcla.conciencia = propio.conciencia || '';
  mezcla.proteinuria = propio.proteinuria || '';
  return mezcla;
}

/** ¿Hay algo que puntuar? Sirve para no guardar un score en blanco. */
export function scoreMamaTieneDatos(sm) {
  if (!sm) return false;
  return (
    SCORE_MAMA_NUMERICOS_KEYS.some((k) => sm[k] != null && sm[k] !== '') ||
    !!sm.conciencia ||
    !!sm.proteinuria
  );
}
