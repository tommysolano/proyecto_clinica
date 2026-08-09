/**
 * VENTANAS HORARIAS: la franja configurada es la de SILENCIO.
 *
 * CASO REAL (ago-2026). Antes el rango era el horario en el que la automatización
 * PODÍA enviar. Nadie lo leyó así: las 15 ventanas configuradas en producción
 * decían `23:00–06:20` — "no molestar de noche" — y el sistema hacía lo
 * contrario, reteniendo los mensajes todo el día para soltarlos a las 23:00
 * (2.061 mensajes de madrugada en 5 días). Aquí se fija el significado nuevo:
 * dentro de la franja se CALLA, fuera se envía, y quien llega en pleno silencio
 * espera a que TERMINE (nunca se descarta).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isWindowActive, isQuietTime, nextAllowedTime, nextAllowedTimeAll, isAlwaysQuiet, describeWindow,
  normalizeDays,
} = require('../utils/sendWindow');
const { sendWindowHold, windowOfNode } = require('../utils/workflowEngine');

// Fechas en HORA LOCAL del proceso (America/Guayaquil en producción; el cálculo
// de la ventana es local por definición: "de 11 a 6" es la hora de la clínica).
// Referencias: 2026-08-03 lunes · 05 miércoles · 07 viernes · 08 sábado · 09 domingo.
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
// La ventana REAL de producción: silencio nocturno todos los días.
const NOCHE = { mode: 'specific', days: [0, 1, 2, 3, 4, 5, 6], from: '23:00', to: '06:20' };
// Silencio en horario de oficina (los agentes atienden; el bot se calla).
const OFICINA = { mode: 'specific', days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' };

test('una ventana en modo "any" no calla nada', () => {
  assert.equal(isWindowActive({ mode: 'any', days: [1], from: '09:00', to: '18:00' }), false);
  assert.equal(isQuietTime({ mode: 'any' }, at(2026, 8, 9, 3)), false);
});

test('sin días marcados o con horas inválidas la ventana no está activa', () => {
  assert.equal(isWindowActive({ mode: 'specific', days: [], from: '09:00', to: '18:00' }), false);
  assert.equal(isWindowActive({ mode: 'specific', days: [1], from: '25:00', to: '18:00' }), false);
  assert.equal(isWindowActive({ mode: 'specific', days: [1], from: '09:00', to: '' }), false);
  assert.equal(isWindowActive(NOCHE), true);
});

test('normalizeDays limpia repetidos y valores fuera de rango', () => {
  assert.deepEqual(normalizeDays([3, 3, 9, -1, 0, 'x']), [0, 3]);
});

test('EL CASO DE PRODUCCIÓN: 23:00–06:20 calla de noche y deja pasar de día', () => {
  assert.equal(isQuietTime(NOCHE, at(2026, 8, 5, 23, 30)), true, 'las 23:30 son silencio');
  assert.equal(isQuietTime(NOCHE, at(2026, 8, 6, 2)), true, 'las 02:00 vienen del silencio de ayer');
  assert.equal(isQuietTime(NOCHE, at(2026, 8, 6, 6, 19)), true, 'hasta las 06:19 aún se calla');
  assert.equal(isQuietTime(NOCHE, at(2026, 8, 6, 6, 20)), false, 'a las 06:20 ya se puede enviar');
  assert.equal(isQuietTime(NOCHE, at(2026, 8, 6, 13)), false, 'a media tarde se envía normal');
  assert.equal(isQuietTime(NOCHE, at(2026, 8, 6, 22, 59)), false, 'hasta las 22:59 se envía');
});

test('quien cae en pleno silencio espera al FINAL de la franja, no al principio', () => {
  // Este es exactamente el fallo que reportó la clínica: antes esperaba a las 23:00.
  assert.deepEqual(nextAllowedTime(NOCHE, at(2026, 8, 6, 2)), at(2026, 8, 6, 6, 20));
  assert.deepEqual(nextAllowedTime(NOCHE, at(2026, 8, 5, 23, 30)), at(2026, 8, 6, 6, 20));
});

test('fuera del silencio se envía en el acto', () => {
  const tarde = at(2026, 8, 5, 15);
  assert.deepEqual(nextAllowedTime(NOCHE, tarde), tarde);
  assert.deepEqual(nextAllowedTime({ mode: 'any' }, tarde), tarde);
});

test('silencio en horario de oficina: el bot cubre noches y fines de semana', () => {
  assert.equal(isQuietTime(OFICINA, at(2026, 8, 5, 10)), true, 'miércoles 10:00: atienden los agentes');
  assert.equal(isQuietTime(OFICINA, at(2026, 8, 5, 20)), false, 'miércoles 20:00: contesta el bot');
  assert.equal(isQuietTime(OFICINA, at(2026, 8, 9, 12)), false, 'domingo: no hay agentes, contesta el bot');
  // Un contacto que llega el miércoles a las 10:00 recibe a las 18:00, al cerrar.
  assert.deepEqual(nextAllowedTime(OFICINA, at(2026, 8, 5, 10)), at(2026, 8, 5, 18));
});

test('silencios diarios encadenados: se saltan hasta encontrar hueco', () => {
  // Silencio de 00:00 a 23:59 de lunes a viernes: el único hueco es el minuto
  // final de cada día… y el fin de semana entero.
  const casiTodo = { mode: 'specific', days: [1, 2, 3, 4, 5], from: '00:00', to: '23:59' };
  assert.deepEqual(nextAllowedTime(casiTodo, at(2026, 8, 5, 10)), at(2026, 8, 5, 23, 59));
});

test('un silencio de 24 h los 7 días es imposible de cumplir: se detecta', () => {
  const siempre = { mode: 'specific', days: [0, 1, 2, 3, 4, 5, 6], from: '08:00', to: '08:00' };
  assert.equal(isAlwaysQuiet(siempre), true);
  assert.equal(nextAllowedTime(siempre, at(2026, 8, 5, 10)), null, 'no hay hueco posible');
  assert.equal(isAlwaysQuiet(NOCHE), false);
  assert.equal(isAlwaysQuiet({ mode: 'any' }), false);
});

test('con un solo día de silencio, el resto de la semana envía', () => {
  const soloLunes = { mode: 'specific', days: [1], from: '08:00', to: '09:00' };
  assert.equal(isQuietTime(soloLunes, at(2026, 8, 3, 8, 30)), true); // lunes
  assert.equal(isQuietTime(soloLunes, at(2026, 8, 4, 8, 30)), false); // martes
  assert.deepEqual(nextAllowedTime(soloLunes, at(2026, 8, 3, 8, 30)), at(2026, 8, 3, 9));
});

test('describeWindow resume días y horas en texto', () => {
  assert.equal(describeWindow(OFICINA), 'lunes, martes, miércoles, jueves, viernes de 09:00 a 18:00');
  assert.equal(describeWindow(NOCHE), 'todos los días de 23:00 a 06:20');
  assert.equal(describeWindow({ mode: 'any' }), 'sin restricción');
});

test('sendWindowHold retiene los pasos de ENVÍO durante el silencio', () => {
  const wf = { sendWindow: NOCHE };
  assert.deepEqual(sendWindowHold(wf, 'send_message', at(2026, 8, 6, 2)), at(2026, 8, 6, 6, 20));
  assert.deepEqual(sendWindowHold(wf, 'send_template', at(2026, 8, 5, 23, 30)), at(2026, 8, 6, 6, 20));
  assert.equal(sendWindowHold(wf, 'send_message', at(2026, 8, 5, 15)), null, 'de tarde no retiene');
});

test('sendWindowHold NO retiene los pasos que no envían nada', () => {
  const wf = { sendWindow: NOCHE };
  const madrugada = at(2026, 8, 9, 3);
  assert.equal(sendWindowHold(wf, 'add_tag', madrugada), null);
  assert.equal(sendWindowHold(wf, 'create_task', madrugada), null);
  assert.equal(sendWindowHold(wf, 'create_opportunity', madrugada), null);
});

test('un workflow sin ventana configurada nunca retiene', () => {
  const madrugada = at(2026, 8, 9, 3);
  assert.equal(sendWindowHold({}, 'send_message', madrugada), null);
  assert.equal(sendWindowHold({ sendWindow: { mode: 'any' } }, 'send_message', madrugada), null);
});

test('una ventana imposible (24 h los 7 días) no deja preso al contacto', () => {
  const wf = { name: 'mal configurado', sendWindow: { mode: 'specific', days: [0, 1, 2, 3, 4, 5, 6], from: '08:00', to: '08:00' } };
  assert.equal(sendWindowHold(wf, 'send_message', at(2026, 8, 5, 10)), null, 'se deja pasar en vez de esperar para siempre');
});

// ───────── varias ventanas a la vez (workflow + nodos ya recorridos) ─────────

test('nextAllowedTimeAll respeta la MÁS restrictiva de varias ventanas', () => {
  // Noche (23:00–06:20) + oficina (L-V 09:00–18:00): a las 03:00 del miércoles la
  // noche calla hasta las 06:20; ahí ya no hay silencio (la oficina empieza a las 9).
  assert.deepEqual(nextAllowedTimeAll([NOCHE, OFICINA], at(2026, 8, 5, 3)), at(2026, 8, 5, 6, 20));
  // A las 17:00 calla la oficina hasta las 18:00, y la noche aún no empieza.
  assert.deepEqual(nextAllowedTimeAll([NOCHE, OFICINA], at(2026, 8, 5, 17)), at(2026, 8, 5, 18));
  // A las 20:00 no calla ninguna: se envía ya.
  assert.deepEqual(nextAllowedTimeAll([NOCHE, OFICINA], at(2026, 8, 5, 20)), at(2026, 8, 5, 20));
});

test('nextAllowedTimeAll: sin ventanas activas devuelve el mismo instante', () => {
  const ahora = at(2026, 8, 5, 3);
  assert.deepEqual(nextAllowedTimeAll([], ahora), ahora);
  assert.deepEqual(nextAllowedTimeAll([{ mode: 'any' }], ahora), ahora);
});

test('la ventana de un nodo ya recorrido sigue callando los envíos posteriores', () => {
  // EL BUG DE AGO-2026: nodo "Ventana horaria 23:02–06:20" → "Esperar 5 h" →
  // "Enviar mensaje". Se pasaba por la ventana a las 22:08 (sin silencio) y el
  // mensaje salía a las 03:08. Ahora la ventana del nodo viaja en el contexto.
  const ctx = { quietWindows: [{ mode: 'specific', days: [0, 1, 2, 3, 4, 5, 6], from: '23:02', to: '06:20' }] };
  const wf = {}; // el workflow NO tiene horario de silencio propio
  assert.deepEqual(sendWindowHold(wf, 'send_message', at(2026, 8, 6, 3, 8), ctx), at(2026, 8, 6, 6, 20));
  assert.equal(sendWindowHold(wf, 'send_message', at(2026, 8, 6, 10), ctx), null, 'de día sí envía');
  assert.equal(sendWindowHold(wf, 'add_tag', at(2026, 8, 6, 3, 8), ctx), null, 'etiquetar no molesta');
});

test('se suman la ventana del workflow y la del nodo recorrido', () => {
  const wf = { sendWindow: OFICINA };
  const ctx = { quietWindows: [NOCHE] };
  assert.deepEqual(sendWindowHold(wf, 'send_message', at(2026, 8, 5, 10), ctx), at(2026, 8, 5, 18), 'calla la del workflow');
  assert.deepEqual(sendWindowHold(wf, 'send_message', at(2026, 8, 5, 2), ctx), at(2026, 8, 5, 6, 20), 'calla la del nodo');
  assert.equal(sendWindowHold(wf, 'send_message', at(2026, 8, 5, 20), ctx), null, 'a las 20:00 no calla ninguna');
});

test('una ventana de nodo imposible no bloquea los envíos', () => {
  const ctx = { quietWindows: [{ mode: 'specific', days: [0, 1, 2, 3, 4, 5, 6], from: '08:00', to: '08:00' }] };
  assert.equal(sendWindowHold({}, 'send_message', at(2026, 8, 5, 10), ctx), null);
});

test('windowOfNode arma la ventana del nodo del diagrama', () => {
  const win = windowOfNode({ windowDays: [6], windowFrom: '10:00', windowTo: '13:00' });
  assert.deepEqual(win, { mode: 'specific', days: [6], from: '10:00', to: '13:00' });
  assert.equal(isQuietTime(win, at(2026, 8, 8, 11)), true); // sábado: callado
  assert.equal(isQuietTime(win, at(2026, 8, 7, 11)), false); // viernes: envía
});
