/**
 * EXPORT DE CARTERA A EXCEL (consulta de la contadora).
 *
 * Verifica, con los CONTROLLERS reales, que el Excel de cuentas por cobrar y por pagar —en sus
 * dos vistas (antigüedad y documentos)— cuadra EXACTAMENTE con lo que devuelve el endpoint de
 * pantalla: mismos tramos, mismo corte y mismos totales. Se siembran documentos con distintos
 * vencimientos: por vencer, vencido 15 días (1-30) y vencido 45 días (31-60).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const H = require('./_integrationHelpers');

const sub = require('../controllers/subledgerController');
const { openReceivable, openPayable } = require('../utils/subledger');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };
const dias = (n) => new Date(Date.now() + n * 86400000);

/** Carga un workbook desde el Buffer que devolvió el controller y da su (única) hoja. */
async function hoja(payload) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(payload);
  return wb.worksheets[0];
}
/** Primera fila cuya celda 1 es exactamente `label` (para localizar una fila por su nombre). */
function filaPorEtiqueta(ws, label) {
  let out = null;
  ws.eachRow((row) => {
    if (out) return;
    if (String(row.getCell(1).value ?? '').trim() === label) out = row;
  });
  return out;
}
const num = (row, col) => Number(row.getCell(col).value || 0);

/** Siembra 3 documentos de un mismo tercero con vencimientos en tres tramos distintos. */
async function seed(side, clinicId) {
  const open = side === 'AP' ? openPayable : openReceivable;
  const party = {
    model: side === 'AP' ? 'Supplier' : 'Patient',
    ref: new H.mongoose.Types.ObjectId(),
    name: side === 'AP' ? 'Proveedor Uno' : 'Cliente Uno',
  };
  const src = side === 'AP' ? 'PurchaseInvoice' : 'Sale';
  const docType = side === 'AP' ? 'COMPRA' : 'VENTA';
  let n = 0;
  const mk = (total, applied, dueDate) => {
    n += 1;
    return open({
      clinic: clinicId, party, sourceModel: src, sourceRef: new H.mongoose.Types.ObjectId(),
      docType, number: `001-001-${String(n).padStart(9, '0')}`, issueDate: dias(-50), dueDate, total, applied,
    });
  };
  await mk(100, 0, dias(10));    // por vencer  → current
  await mk(200, 50, dias(-15));  // vencido 15d → d30 (saldo 150)
  await mk(300, 0, dias(-45));   // vencido 45d → d60 (saldo 300)
  return party;
}

// ─────────────────────────────────────────────────────────────────────────────
for (const side of ['AR', 'AP']) {
  const etiqueta = side === 'AP' ? 'CxP' : 'CxC';

  test(`${etiqueta}: el Excel de ANTIGÜEDAD cuadra con el endpoint de aging`, async () => {
    const { clinicId, userId } = await H.seedClinic();
    const party = await seed(side, clinicId);

    // Pantalla
    const aging = ok(await H.runController(sub.aging, H.mockReq(clinicId, userId, {}, { query: { side } })));
    const fila = aging.rows.find((r) => r.partyName === party.name);
    assert.ok(fila, 'el aging trae la fila del tercero');
    // Los tramos esperados (saldo, no total): current 100, d30 150, d60 300.
    assert.deepEqual(
      { current: fila.current, d30: fila.d30, d60: fila.d60, d90: fila.d90, d90plus: fila.d90plus, total: fila.total },
      { current: 100, d30: 150, d60: 300, d90: 0, d90plus: 0, total: 550 },
    );
    assert.equal(aging.totals.total, 550);

    // Excel (mismos filtros)
    const r = await H.runController(sub.exportExcel, H.mockReq(clinicId, userId, {}, { query: { side, view: 'aging' } }));
    assert.match(r.headers['Content-Disposition'] || '', /\.xlsx"?$/);
    const ws = await hoja(r.payload);

    const xf = filaPorEtiqueta(ws, party.name);
    assert.ok(xf, 'el Excel trae la fila del tercero');
    assert.deepEqual(
      [num(xf, 2), num(xf, 3), num(xf, 4), num(xf, 5), num(xf, 6), num(xf, 7)],
      [fila.current, fila.d30, fila.d60, fila.d90, fila.d90plus, fila.total],
      'los tramos del Excel = los del aging de pantalla',
    );
    const xt = filaPorEtiqueta(ws, 'TOTAL');
    assert.ok(xt, 'el Excel tiene fila de totales');
    assert.deepEqual(
      [num(xt, 2), num(xt, 3), num(xt, 4), num(xt, 5), num(xt, 6), num(xt, 7)],
      [aging.totals.current, aging.totals.d30, aging.totals.d60, aging.totals.d90, aging.totals.d90plus, aging.totals.total],
      'los totales del Excel = los del aging de pantalla',
    );
  });

  test(`${etiqueta}: el Excel de DOCUMENTOS cuadra con el endpoint por documento (y con el aging)`, async () => {
    const { clinicId, userId } = await H.seedClinic();
    await seed(side, clinicId);

    // Pantalla (documentos)
    const docs = ok(await H.runController(sub.list, H.mockReq(clinicId, userId, {}, { query: { side } })));
    assert.equal(docs.length, 3);
    const totOriginal = docs.reduce((s, d) => s + d.total, 0);
    const totAbonos = docs.reduce((s, d) => s + d.applied, 0);
    const totSaldo = docs.reduce((s, d) => s + d.balance, 0);
    assert.deepEqual([totOriginal, totAbonos, totSaldo], [600, 50, 550]);

    // Excel de documentos
    const r = await H.runController(sub.exportExcel, H.mockReq(clinicId, userId, {}, { query: { side, view: 'documents' } }));
    const ws = await hoja(r.payload);
    const xt = filaPorEtiqueta(ws, 'TOTAL');
    assert.ok(xt, 'el Excel de documentos tiene fila de totales');
    assert.deepEqual(
      [num(xt, 6), num(xt, 7), num(xt, 8)],
      [totOriginal, totAbonos, totSaldo],
      'valor original / abonos / saldo del Excel = suma de los documentos de pantalla',
    );

    // Cuadre entre vistas: el saldo total de documentos = el total del aging.
    const aging = ok(await H.runController(sub.aging, H.mockReq(clinicId, userId, {}, { query: { side } })));
    assert.equal(num(xt, 8), aging.totals.total, 'el saldo total de documentos cuadra con el total del aging');
  });

  test(`${etiqueta}: el filtro por nombre (q) se respeta igual en pantalla y en Excel`, async () => {
    const { clinicId, userId } = await H.seedClinic();
    await seed(side, clinicId);
    // Un segundo tercero que NO debe salir al filtrar por el primero.
    const otro = side === 'AP' ? openPayable : openReceivable;
    await otro({
      clinic: clinicId,
      party: { model: side === 'AP' ? 'Supplier' : 'Patient', ref: new H.mongoose.Types.ObjectId(), name: 'Otro Tercero' },
      sourceModel: side === 'AP' ? 'PurchaseInvoice' : 'Sale', sourceRef: new H.mongoose.Types.ObjectId(),
      docType: side === 'AP' ? 'COMPRA' : 'VENTA', number: '001-001-000000999', issueDate: dias(-5), dueDate: dias(-5), total: 999, applied: 0,
    });

    const query = { side, q: 'Uno' };
    const aging = ok(await H.runController(sub.aging, H.mockReq(clinicId, userId, {}, { query })));
    assert.equal(aging.rows.length, 1, 'el aging filtra por nombre');
    assert.equal(aging.totals.total, 550, 'y no incluye al otro tercero');

    const r = await H.runController(sub.exportExcel, H.mockReq(clinicId, userId, {}, { query: { ...query, view: 'aging' } }));
    const ws = await hoja(r.payload);
    assert.ok(!filaPorEtiqueta(ws, 'Otro Tercero'), 'el Excel tampoco incluye al otro tercero');
    assert.equal(num(filaPorEtiqueta(ws, 'TOTAL'), 7), 550, 'el total del Excel filtrado = el del aging filtrado');
  });
}
