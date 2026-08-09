const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSchedule, workingMsBetween, isWorkingAt } = require('../utils/agentSchedule');

// Construye un instante a partir de hora Ecuador (UTC-5 fijo).
const ec = (isoLocal) => new Date(`${isoLocal}-05:00`);
const schedule = (days) => normalizeSchedule({ enabled: true, days });

test('workingMsBetween descuenta noches y fin de semana', () => {
  const weekdays = Array.from({ length: 7 }, (_, day) => ({
    day, enabled: day >= 1 && day <= 5, start: '09:00', end: '18:00',
  }));
  // Viernes 17:00 -> lunes 10:00 = 1 h del viernes + 1 h del lunes.
  const ms = workingMsBetween(
    ec('2026-08-07T17:00:00'),
    ec('2026-08-10T10:00:00'),
    schedule(weekdays)
  );
  assert.equal(ms / 60000, 120);
});

test('sin horario activo conserva la medición 24/7', () => {
  const from = ec('2026-08-07T17:00:00');
  const to = ec('2026-08-10T10:00:00');
  assert.equal(workingMsBetween(from, to, { enabled: false }), to - from);
});

test('admite turnos nocturnos que cruzan medianoche', () => {
  const days = Array.from({ length: 7 }, (_, day) => ({
    day, enabled: day === 1, start: '22:00', end: '06:00',
  }));
  const work = schedule(days);
  assert.equal(
    workingMsBetween(ec('2026-08-03T23:00:00'), ec('2026-08-04T03:00:00'), work) / 60000,
    240
  );
  assert.equal(isWorkingAt(work, ec('2026-08-04T03:00:00')), true);
  assert.equal(isWorkingAt(work, ec('2026-08-04T10:00:00')), false);
});

test('admite varias franjas en un mismo dia sin contar el descanso intermedio', () => {
  const days = [{
    day: 1,
    enabled: true,
    intervals: [
      { start: '08:00', end: '12:00' },
      { start: '16:00', end: '21:00' },
    ],
  }];
  const work = schedule(days);

  assert.deepEqual(work.days[1].intervals, [
    { start: '08:00', end: '12:00' },
    { start: '16:00', end: '21:00' },
  ]);
  assert.equal(
    workingMsBetween(ec('2026-08-03T08:00:00'), ec('2026-08-03T21:00:00'), work) / 60000,
    540,
    'solo cuenta 4 horas de manana y 5 horas de tarde'
  );
  assert.equal(isWorkingAt(work, ec('2026-08-03T10:00:00')), true);
  assert.equal(isWorkingAt(work, ec('2026-08-03T14:00:00')), false);
  assert.equal(isWorkingAt(work, ec('2026-08-03T18:00:00')), true);
});

test('los horarios antiguos de inicio y fin se migran al leerlos', () => {
  const work = schedule([{ day: 2, enabled: true, start: '07:30', end: '11:45' }]);
  assert.deepEqual(work.days[2].intervals, [{ start: '07:30', end: '11:45' }]);
  assert.equal(isWorkingAt(work, ec('2026-08-04T08:00:00')), true);
});
