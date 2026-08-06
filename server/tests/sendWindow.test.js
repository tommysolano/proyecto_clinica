const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isWindowActive, isInsideWindow, nextWindowOpening, describeWindow, normalizeDays,
} = require('../utils/sendWindow');
const { sendWindowHold, windowOfNode } = require('../utils/workflowEngine');

// Fechas en HORA LOCAL del proceso (America/Guayaquil en producción; el cálculo
// de la ventana es local por definición: "de 9 a 6" es la hora de la clínica).
// Referencias: 2026-08-03 lunes · 05 miércoles · 07 viernes · 08 sábado · 09 domingo.
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const LABORAL = { mode: 'specific', days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' };

test('una ventana en modo "any" no restringe nada', () => {
  assert.equal(isWindowActive({ mode: 'any', days: [1], from: '09:00', to: '18:00' }), false);
  assert.equal(isInsideWindow({ mode: 'any' }, at(2026, 8, 9, 3)), true);
});

test('sin días marcados o con horas inválidas la ventana no está activa', () => {
  assert.equal(isWindowActive({ mode: 'specific', days: [], from: '09:00', to: '18:00' }), false);
  assert.equal(isWindowActive({ mode: 'specific', days: [1], from: '25:00', to: '18:00' }), false);
  assert.equal(isWindowActive({ mode: 'specific', days: [1], from: '09:00', to: '' }), false);
  assert.equal(isWindowActive(LABORAL), true);
});

test('normalizeDays limpia repetidos y valores fuera de rango', () => {
  assert.deepEqual(normalizeDays([3, 3, 9, -1, 0, 'x']), [0, 3]);
});

test('dentro / fuera de la franja (fin de franja EXCLUSIVO)', () => {
  assert.equal(isInsideWindow(LABORAL, at(2026, 8, 5, 10)), true); // miércoles 10:00
  assert.equal(isInsideWindow(LABORAL, at(2026, 8, 5, 8, 59)), false);
  assert.equal(isInsideWindow(LABORAL, at(2026, 8, 5, 18)), false);
  assert.equal(isInsideWindow(LABORAL, at(2026, 8, 9, 12)), false); // domingo
});

test('nextWindowOpening devuelve el mismo instante si ya está dentro', () => {
  const now = at(2026, 8, 5, 10);
  assert.equal(nextWindowOpening(LABORAL, now), now);
  assert.equal(nextWindowOpening({ mode: 'any' }, now), now);
});

test('de madrugada abre ese mismo día a las 09:00', () => {
  assert.deepEqual(nextWindowOpening(LABORAL, at(2026, 8, 5, 3)), at(2026, 8, 5, 9));
});

test('viernes a las 23:00 → abre el LUNES a las 09:00 (se salta el fin de semana)', () => {
  assert.deepEqual(nextWindowOpening(LABORAL, at(2026, 8, 7, 23)), at(2026, 8, 10, 9));
});

test('con un solo día habilitado espera a la semana siguiente', () => {
  const soloLunes = { mode: 'specific', days: [1], from: '08:00', to: '09:00' };
  assert.deepEqual(nextWindowOpening(soloLunes, at(2026, 8, 3, 9, 30)), at(2026, 8, 10, 8));
});

test('franja que cruza la medianoche: la noche del lunes llega hasta el martes', () => {
  const noche = { mode: 'specific', days: [1], from: '20:00', to: '06:00' };
  assert.equal(isInsideWindow(noche, at(2026, 8, 3, 22)), true); // lunes 22:00
  assert.equal(isInsideWindow(noche, at(2026, 8, 4, 3)), true); // martes 03:00, viene del lunes
  assert.equal(isInsideWindow(noche, at(2026, 8, 4, 7)), false);
  assert.deepEqual(nextWindowOpening(noche, at(2026, 8, 4, 7)), at(2026, 8, 10, 20));
});

test('describeWindow resume días y horas en texto', () => {
  assert.equal(describeWindow(LABORAL), 'lunes, martes, miércoles, jueves, viernes de 09:00 a 18:00');
  assert.equal(
    describeWindow({ mode: 'specific', days: [0, 1, 2, 3, 4, 5, 6], from: '08:00', to: '20:00' }),
    'todos los días de 08:00 a 20:00'
  );
  assert.equal(describeWindow({ mode: 'any' }), 'sin restricción');
});

test('sendWindowHold retiene los pasos de ENVÍO fuera de la franja', () => {
  const wf = { sendWindow: LABORAL };
  assert.deepEqual(sendWindowHold(wf, 'send_message', at(2026, 8, 7, 23)), at(2026, 8, 10, 9));
  assert.deepEqual(sendWindowHold(wf, 'send_template', at(2026, 8, 9, 12)), at(2026, 8, 10, 9));
  assert.equal(sendWindowHold(wf, 'send_message', at(2026, 8, 5, 10)), null); // dentro
});

test('sendWindowHold NO retiene los pasos que no envían nada', () => {
  const wf = { sendWindow: LABORAL };
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

test('windowOfNode arma la ventana del nodo del diagrama', () => {
  const win = windowOfNode({ windowDays: [6], windowFrom: '10:00', windowTo: '13:00' });
  assert.deepEqual(win, { mode: 'specific', days: [6], from: '10:00', to: '13:00' });
  assert.equal(isInsideWindow(win, at(2026, 8, 8, 11)), true); // sábado
  assert.equal(isInsideWindow(win, at(2026, 8, 7, 11)), false); // viernes
});
