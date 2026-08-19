/**
 * Obstetricia: edad gestacional y evaluación nutricional del embarazo.
 *
 * Dos cosas viven aquí:
 *
 *  1. El cálculo de semanas de embarazo a partir de la FUM (fecha de la última
 *     menstruación) y la fecha probable de parto (regla de los 280 días).
 *
 *  2. La curva de IMC / edad gestacional que clasifica a la paciente en bajo
 *     peso · aumento normal · sobrepeso · obesidad.
 *
 * ─── SOBRE LA TABLA DE LA CURVA ────────────────────────────────────────────
 * TABLA_IMC_GESTACIONAL es la curva de ATALAH (Atalah et al., 1997), que es la
 * que recomienda la guía de control prenatal del MSP del Ecuador. Los cortes
 * son datos clínicos, no lógica: si la doctora trabaja con otra tabla (CLAP,
 * Rosso-Mardones, una del MSP más nueva), se cambian SOLO los números de este
 * arreglo y tanto la gráfica como la clasificación se recalculan solas — no
 * hay ningún corte escrito a mano en el resto del código.
 *
 * Lectura de cada fila: `bajo` y `normal` son techos INCLUSIVOS del tramo, o
 * sea IMC < bajo = bajo peso; bajo ≤ IMC ≤ normal = normal; normal < IMC ≤
 * sobrepeso = sobrepeso; IMC > sobrepeso = obesidad.
 */
import { todayEc } from '../utils/date';

// Alto y bajo del eje Y de la gráfica (mismos límites del gráfico impreso).
export const IMC_MIN = 15;
export const IMC_MAX = 40;

// [semana, bajo, normal, sobrepeso]
const FILAS = [
  [10, 20.2, 24.9, 30.1],
  [11, 20.7, 25.3, 30.2],
  [12, 21.3, 25.6, 30.2],
  [13, 21.8, 26.0, 30.3],
  [14, 22.1, 26.3, 30.5],
  [15, 22.3, 26.5, 30.6],
  [16, 22.5, 26.7, 30.8],
  [17, 22.7, 26.9, 30.9],
  [18, 22.9, 27.1, 31.1],
  [19, 23.1, 27.3, 31.2],
  [20, 23.3, 27.5, 31.4],
  [21, 23.5, 27.7, 31.6],
  [22, 23.7, 27.9, 31.7],
  [23, 23.9, 28.1, 31.9],
  [24, 24.1, 28.3, 32.0],
  [25, 24.3, 28.5, 32.2],
  [26, 24.5, 28.7, 32.3],
  [27, 24.7, 28.9, 32.5],
  [28, 24.9, 29.1, 32.6],
  [29, 25.1, 29.3, 32.8],
  [30, 25.3, 29.5, 33.0],
  [31, 25.4, 29.7, 33.1],
  [32, 25.6, 29.8, 33.3],
  [33, 25.8, 30.0, 33.4],
  [34, 25.9, 30.2, 33.6],
  [35, 26.0, 30.3, 33.7],
  [36, 26.1, 30.5, 33.8],
  [37, 26.2, 30.6, 34.0],
  [38, 26.3, 30.7, 34.1],
  [39, 26.3, 30.8, 34.2],
  [40, 26.3, 30.9, 34.3],
  [41, 26.3, 30.9, 34.3],
  [42, 26.3, 30.9, 34.3],
];

export const TABLA_IMC_GESTACIONAL = FILAS.map(([semana, bajo, normal, sobrepeso]) => ({
  semana,
  bajo,
  normal,
  sobrepeso,
}));

export const SEMANA_MIN = TABLA_IMC_GESTACIONAL[0].semana;
export const SEMANA_MAX = TABLA_IMC_GESTACIONAL[TABLA_IMC_GESTACIONAL.length - 1].semana;

// Estados de la curva, en orden de abajo hacia arriba de la gráfica.
export const ESTADOS_IMC = [
  { key: 'bajo', label: 'Bajo peso', color: '#f4a08a', texto: 'text-orange-700', fondo: 'bg-orange-50 border-orange-200' },
  { key: 'normal', label: 'Aumento normal', color: '#9fd8a8', texto: 'text-emerald-700', fondo: 'bg-emerald-50 border-emerald-200' },
  { key: 'sobrepeso', label: 'Sobrepeso', color: '#f4a08a', texto: 'text-orange-700', fondo: 'bg-orange-50 border-orange-200' },
  { key: 'obesidad', label: 'Obesidad', color: '#ef8a72', texto: 'text-rose-700', fondo: 'bg-rose-50 border-rose-200' },
];

const ESTADO_POR_KEY = Object.fromEntries(ESTADOS_IMC.map((e) => [e.key, e]));

/** 'YYYY-MM-DD', ISO o Date -> milisegundos de ese día a medianoche UTC. */
function diaUtc(valor) {
  if (!valor) return null;
  const m = String(valor instanceof Date ? valor.toISOString() : valor).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

const DIA = 86400000;
// Más allá de 45 semanas la FUM ya no describe este embarazo (quedó vieja).
const DIAS_TOPE = 45 * 7;

/**
 * Edad gestacional por FUM. `ref` es la fecha en la que se evalúa (la del
 * seguimiento); por omisión, hoy en Ecuador.
 * Devuelve null si no hay FUM legible.
 */
export function edadGestacional(fum, ref) {
  const inicio = diaUtc(fum);
  const corte = diaUtc(ref || todayEc());
  if (inicio == null || corte == null) return null;
  const dias = Math.round((corte - inicio) / DIA);
  const semanas = Math.floor(dias / 7);
  const resto = ((dias % 7) + 7) % 7;
  return {
    dias,
    semanas,
    resto,
    // 'futura' = FUM posterior a la fecha del control; 'lejana' = FUM caducada.
    problema: dias < 0 ? 'futura' : dias > DIAS_TOPE ? 'lejana' : '',
    texto: textoEdad(semanas, resto),
  };
}

function textoEdad(semanas, resto) {
  const s = `${semanas} ${semanas === 1 ? 'semana' : 'semanas'}`;
  if (!resto) return s;
  return `${s} y ${resto} ${resto === 1 ? 'día' : 'días'}`;
}

/** Fecha probable de parto: FUM + 280 días, como 'YYYY-MM-DD'. */
export function fechaProbableParto(fum) {
  const inicio = diaUtc(fum);
  if (inicio == null) return '';
  return new Date(inicio + 280 * DIA).toISOString().slice(0, 10);
}

/** IMC en kg/m² a partir de peso (kg) y talla (cm). null si falta algo. */
export function imcDe(pesoKg, tallaCm) {
  const p = Number(pesoKg);
  const t = Number(tallaCm);
  if (!Number.isFinite(p) || !Number.isFinite(t) || p <= 0 || t <= 0) return null;
  return p / (t / 100) ** 2;
}

/** Fila de la tabla para una semana; fuera de rango se toma el extremo. */
export function filaSemana(semana) {
  const s = Math.min(SEMANA_MAX, Math.max(SEMANA_MIN, Math.round(Number(semana))));
  if (!Number.isFinite(s)) return null;
  return TABLA_IMC_GESTACIONAL.find((f) => f.semana === s) || null;
}

/**
 * Clasifica un IMC en la semana dada. `dentroDeCurva` avisa cuando la semana
 * cae fuera de la tabla (antes de la 10 o después de la 42): ahí el resultado
 * es orientativo porque se usó el extremo más cercano.
 */
export function clasificarIMC(semana, imc) {
  if (!Number.isFinite(imc) || imc <= 0) return null;
  const fila = filaSemana(semana);
  if (!fila) return null;
  const key = imc < fila.bajo ? 'bajo' : imc <= fila.normal ? 'normal' : imc <= fila.sobrepeso ? 'sobrepeso' : 'obesidad';
  return {
    ...ESTADO_POR_KEY[key],
    fila,
    dentroDeCurva: Number(semana) >= SEMANA_MIN && Number(semana) <= SEMANA_MAX,
  };
}

/**
 * Datos de la gráfica: cada semana con el GROSOR de cada franja, porque
 * recharts apila las áreas desde 0. La franja baja arranca en 0 y el eje se
 * recorta en IMC_MIN, así que por debajo no se ve nada.
 */
export function bandasIMC() {
  return TABLA_IMC_GESTACIONAL.map((f) => ({
    semana: f.semana,
    zBajo: f.bajo,
    zNormal: Number((f.normal - f.bajo).toFixed(2)),
    zSobrepeso: Number((f.sobrepeso - f.normal).toFixed(2)),
    zObesidad: Number((IMC_MAX - f.sobrepeso).toFixed(2)),
  }));
}

/**
 * Ganancia total de peso recomendada para todo el embarazo según el IMC
 * PREGESTACIONAL (Institute of Medicine, 2009). Devuelve kilos mínimo/máximo.
 */
export function gananciaRecomendada(imcPregestacional) {
  const i = Number(imcPregestacional);
  if (!Number.isFinite(i) || i <= 0) return null;
  if (i < 18.5) return { min: 12.5, max: 18, label: 'Bajo peso pregestacional' };
  if (i < 25) return { min: 11.5, max: 16, label: 'Peso normal pregestacional' };
  if (i < 30) return { min: 7, max: 11.5, label: 'Sobrepeso pregestacional' };
  return { min: 5, max: 9, label: 'Obesidad pregestacional' };
}
