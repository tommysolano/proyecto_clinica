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
