/**
 * Unit tests del helper de rango de fechas para reportes SRI (sin DB).
 * Cubre: compat legacy year/month, semestres, anual, rango personalizado,
 * validaciones de error, y las fechas fiscales de ventas/compras.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveReportRange, isMonthlyRange, parseDMY, invoiceFiscalDate, purchaseFiscalDate, inRange,
} = require('../utils/reportDateRange');

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hms = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

// 1) Mensual legacy con year/month (sin periodType).
test('1) mensual legacy (year/month) → 01..fin de mes, tipo MONTHLY', () => {
  const r = resolveReportRange({ year: 2026, month: 3 });
  assert.equal(r.periodType, 'MONTHLY');
  assert.equal(r.month, 3);
  assert.equal(ymd(r.start), '2026-03-01');
  assert.equal(hms(r.start), '00:00:00');
  assert.equal(ymd(r.end), '2026-03-31');
  assert.equal(hms(r.end), '23:59:59');
  assert.equal(r.label, 'Marzo 2026');
  assert.ok(isMonthlyRange(r));
});

// 2) Primer semestre: 01/01 al 30/06.
test('2) primer semestre → 01/01 a 30/06', () => {
  const r = resolveReportRange({ year: 2026, periodType: 'FIRST_SEMESTER' });
  assert.equal(ymd(r.start), '2026-01-01');
  assert.equal(ymd(r.end), '2026-06-30');
  assert.equal(hms(r.end), '23:59:59');
  assert.equal(r.label, 'Primer semestre 2026');
  assert.equal(r.month, null);
  assert.equal(isMonthlyRange(r), false);
});

// 3) Segundo semestre: 01/07 al 31/12.
test('3) segundo semestre → 01/07 a 31/12', () => {
  const r = resolveReportRange({ year: 2026, periodType: 'SECOND_SEMESTER' });
  assert.equal(ymd(r.start), '2026-07-01');
  assert.equal(ymd(r.end), '2026-12-31');
  assert.equal(r.label, 'Segundo semestre 2026');
});

// 4) Anual: 01/01 al 31/12.
test('4) anual → 01/01 a 31/12', () => {
  const r = resolveReportRange({ year: 2026, periodType: 'ANNUAL' });
  assert.equal(ymd(r.start), '2026-01-01');
  assert.equal(ymd(r.end), '2026-12-31');
  assert.equal(r.label, 'Año 2026');
});

// 5) Rango personalizado incluye fecha inicio y fin completas.
test('5) custom → incluye desde 00:00:00 hasta 23:59:59', () => {
  const r = resolveReportRange({ periodType: 'CUSTOM', startDate: '2026-02-10', endDate: '2026-05-20' });
  assert.equal(ymd(r.start), '2026-02-10');
  assert.equal(hms(r.start), '00:00:00');
  assert.equal(ymd(r.end), '2026-05-20');
  assert.equal(hms(r.end), '23:59:59');
  assert.equal(r.label, '10/02/2026 - 20/05/2026');
  assert.equal(r.year, null);
});

// 6) Rangos inválidos fallan con status 400.
test('6a) custom sin fechas falla', () => {
  assert.throws(() => resolveReportRange({ periodType: 'CUSTOM' }), (e) => e.status === 400);
});
test('6b) custom con inicio > fin falla', () => {
  assert.throws(() => resolveReportRange({ periodType: 'CUSTOM', startDate: '2026-06-01', endDate: '2026-01-01' }), (e) => e.status === 400 && /inicio/.test(e.message));
});
test('6c) mes inválido falla', () => {
  assert.throws(() => resolveReportRange({ periodType: 'MONTHLY', year: 2026, month: 13 }), (e) => e.status === 400);
});
test('6d) periodType desconocido falla', () => {
  assert.throws(() => resolveReportRange({ periodType: 'TRIMESTRAL', year: 2026 }), (e) => e.status === 400);
});

// Inferencia legacy: solo año → ANNUAL; startDate/endDate → CUSTOM.
test('inferencia: solo año → ANNUAL', () => {
  assert.equal(resolveReportRange({ year: 2026 }).periodType, 'ANNUAL');
});
test('inferencia: startDate/endDate sin periodType → CUSTOM', () => {
  assert.equal(resolveReportRange({ startDate: '2026-01-01', endDate: '2026-01-31' }).periodType, 'CUSTOM');
});

// 7) Fecha fiscal de VENTAS: fechaEmision 'DD/MM/YYYY' válida; fallback createdAt.
test('7) invoiceFiscalDate usa fechaEmision si es válida', () => {
  const d = invoiceFiscalDate({ fechaEmision: '30/06/2026', createdAt: new Date('2026-07-01T04:00:00.000Z') });
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 5); // junio
  assert.equal(d.getDate(), 30);
});
test('7b) invoiceFiscalDate cae a createdAt si la emisión es inválida', () => {
  const created = new Date('2026-07-01T10:00:00.000Z');
  const d = invoiceFiscalDate({ fechaEmision: 'no-fecha', createdAt: created });
  assert.equal(d.getTime(), created.getTime());
});
test('7c) parseDMY rechaza formatos inválidos', () => {
  assert.equal(parseDMY('32/01/2026'), null);
  assert.equal(parseDMY('2026-01-01'), null);
  assert.equal(parseDMY(''), null);
});

// 8) Fecha fiscal de COMPRAS: fechaEmision (Date); fallback createdAt.
test('8) purchaseFiscalDate usa fechaEmision (Date)', () => {
  const emision = new Date(2026, 5, 30);
  const d = purchaseFiscalDate({ fechaEmision: emision, createdAt: new Date(2026, 6, 5) });
  assert.equal(d.getTime(), emision.getTime());
});
test('8b) purchaseFiscalDate cae a createdAt si no hay emisión', () => {
  const created = new Date(2026, 6, 5);
  assert.equal(purchaseFiscalDate({ fechaEmision: null, createdAt: created }).getTime(), created.getTime());
});

// inRange inclusivo en los bordes.
test('inRange incluye los bordes del período', () => {
  const r = resolveReportRange({ year: 2026, periodType: 'FIRST_SEMESTER' });
  assert.equal(inRange(new Date(2026, 0, 1, 0, 0, 0), r.start, r.end), true);
  assert.equal(inRange(new Date(2026, 5, 30, 23, 59, 59), r.start, r.end), true);
  assert.equal(inRange(new Date(2026, 6, 1, 0, 0, 0), r.start, r.end), false);
});
