/**
 * SCORE MAMÁ — Ministerio de Salud Pública del Ecuador.
 * Gerencia Institucional de Disminución Acelerada de Muerte Materna.
 *
 * Clasifica la gravedad de una paciente obstétrica sumando un puntaje de 0 a 3
 * por parámetro. Es una herramienta de decisión: el puntaje total dispara la
 * acción (vigilancia, activación de clave, traslado), así que la tabla de cortes
 * NO se toca sin la norma delante.
 *
 * ESTE ARCHIVO ES LA FUENTE ÚNICA y tiene un espejo en
 * client/src/constants/scoreMama.js. El cliente puntúa mientras la ginecóloga
 * escribe (para que vea el total al momento) y el servidor VUELVE A PUNTUAR al
 * guardar: lo que queda en la historia clínica nunca es lo que dijo el navegador.
 *
 * Cada `tramo` se evalúa EN ORDEN y gana el primero cuyo `hasta` alcance al
 * valor; el último, sin `hasta`, es el "o más". Sirve igual para enteros y para
 * decimales (la temperatura corta en 35,5 / 37,2 / 38,4).
 */

const SCORE_MAMA_PARAMETROS = [
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

/** Estado de conciencia: opciones cerradas con su puntaje. */
const SCORE_MAMA_CONCIENCIA = [
  { key: 'alerta', label: 'Alerta', puntaje: 0 },
  { key: 'voz', label: 'Responde a la voz / somnolienta', puntaje: 1 },
  { key: 'confusa', label: 'Confusa / agitada', puntaje: 2 },
  { key: 'dolor', label: 'Responde al dolor / estuporosa', puntaje: 2 },
  { key: 'no_responde', label: 'No responde', puntaje: 3 },
];

/** Proteinuria en tirilla. */
const SCORE_MAMA_PROTEINURIA = [
  { key: 'negativa', label: 'Negativa (−)', puntaje: 0 },
  { key: 'positiva', label: 'Positiva', puntaje: 1 },
];

const SCORE_MAMA_NUMERICOS_KEYS = SCORE_MAMA_PARAMETROS.map((p) => p.key);

/** Puntaje de un parámetro numérico. `null` si no hay valor consignado. */
function puntajeNumerico(key, valor) {
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

/** Puntaje de una opción cerrada (conciencia / proteinuria). */
function puntajeOpcion(lista, key) {
  const op = lista.find((o) => o.key === key);
  return op ? op.puntaje : null;
}

/**
 * Puntúa un Score MAMÁ completo. Devuelve { puntajes, total }.
 *
 * `total` es null cuando no se consignó NINGÚN parámetro: un cero se lee como
 * "paciente estable", y decir eso sin haber medido nada sería peor que no decir
 * nada. Con al menos un parámetro, el total suma solo los consignados.
 */
function calcularScoreMama(datos = {}) {
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

module.exports = {
  SCORE_MAMA_PARAMETROS,
  SCORE_MAMA_CONCIENCIA,
  SCORE_MAMA_PROTEINURIA,
  SCORE_MAMA_NUMERICOS_KEYS,
  calcularScoreMama,
  puntajeNumerico,
};
