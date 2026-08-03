/**
 * EXPORTACIONES A EXCEL de los reportes contables.
 *
 * El contador pidió poder bajar TODO reporte o consulta en Excel. Lo que se comprueba aquí
 * no es el formato de las celdas, sino las dos cosas que hacen inútil una exportación:
 *
 *   1. que el archivo diga lo MISMO que la pantalla (por eso ambos salen del mismo
 *      controlador vía `captureJson`: si alguien duplicara la consulta, esto lo detecta);
 *   2. que un error NO se descargue como un .xlsx corrupto de 0 bytes, sino como un mensaje
 *      legible — que fue el problema que motivó `downloadFile` en el cliente.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { Writable } = require('node:stream');
const H = require('./_integrationHelpers');

const journal = require('../controllers/journalEntryController');
const reports = require('../controllers/accountingReportsController');
const { captureJson, newWorkbook, addSheet } = require('../utils/excelReport');
const ChartOfAccount = require('../models/ChartOfAccount');
const purchase = require('../controllers/purchaseInvoiceController');
const sale = require('../controllers/saleController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

/**
 * `res` que acumula el .xlsx en memoria para poder abrirlo y leerlo de vuelta.
 * Si el controlador responde JSON (error), se captura igual.
 */
function excelRes() {
  const chunks = [];
  const state = { headers: {}, json: null, statusCode: 200 };
  const res = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
  });
  res.setHeader = (k, v) => { state.headers[k] = v; return res; };
  res.status = (c) => { state.statusCode = c; return res; };
  res.json = (p) => { state.json = p; return res; };
  state.buffer = () => Buffer.concat(chunks);
  return { res, state };
}

/** Ejecuta un endpoint .xlsx y devuelve el libro ya parseado. */
async function runExcel(handler, req) {
  const { res, state } = excelRes();
  await handler(req, res);
  if (state.json) return { state, wb: null };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(state.buffer());
  return { state, wb };
}

/** Todas las celdas de una hoja, como texto plano (para buscar valores sin depender del layout). */
const sheetText = (ws) => {
  const out = [];
  ws.eachRow((row) => row.eachCell((cell) => out.push(String(cell.value ?? ''))));
  return out;
};

async function setup() {
  const { clinicId, userId } = await H.seedClinic();
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const caja = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.01' });
  return { clinicId, userId, gasto, caja };
}

// ─────────────────────────────────────────────────────────────────────────────
test('captureJson devuelve el payload del controlador en vez de enviarlo, y propaga los errores', async () => {
  const ok = await captureJson((req, res) => res.json({ hola: 'mundo' }), {});
  assert.deepEqual(ok, { hola: 'mundo' });

  // Un 4xx del controlador NO puede acabar en un Excel vacío: se propaga como error.
  await assert.rejects(
    () => captureJson((req, res) => res.status(400).json({ message: 'falta la cuenta' }), {}),
    /falta la cuenta/
  );
});

test('addSheet escribe cabecera, filas, totales y congela el encabezado', async () => {
  const wb = newWorkbook();
  addSheet(wb, {
    title: 'Prueba',
    meta: [['Reporte', 'Prueba'], ['Período', 'enero']],
    columns: [
      { header: 'Cuenta', key: 'name', width: 20 },
      { header: 'Débito', key: 'debit', width: 12, money: true },
    ],
    rows: [{ name: 'Caja', debit: 100 }, { name: 'Banco', debit: 50 }],
    totals: { debit: 150 },
  });
  const ws = wb.getWorksheet('Prueba');
  const texto = sheetText(ws);
  assert.ok(texto.includes('Caja'));
  assert.ok(texto.includes('Débito'), 'la cabecera de columnas está');
  assert.ok(texto.includes('TOTALES'));
  // La fila de encabezado va congelada: sin eso un mayor de cientos de filas es ilegible.
  assert.equal(ws.views[0].state, 'frozen');
  assert.equal(ws.views[0].ySplit, 4, 'el encabezado va tras las 2 filas de contexto + 1 en blanco');
});

// ─────────────────────────────────────────────────────────────────────────────
test('LIBRO MAYOR en Excel: mismas filas y mismos totales que la consulta en pantalla', async () => {
  const { clinicId, userId, gasto } = await setup();
  const sup = await H.makeSupplier(clinicId);
  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(0), serie: '001-001-000000301',
    items: [{ description: 'Servicio', lineType: 'GASTO', quantity: 1, unitPrice: 400, ivaRate: 0, subtotal: 400, account: gasto._id }],
  }));

  const query = { account: String(gasto._id), startDate: H.docDate(-5).toISOString().slice(0, 10), endDate: H.docDate(1).toISOString().slice(0, 10) };

  // Lo que ve el usuario en pantalla.
  const pantalla = await H.runController(journal.ledger, H.mockReq(clinicId, userId, {}, { query }));
  assert.equal(pantalla.statusCode, 200, JSON.stringify(pantalla.payload));
  assert.ok(pantalla.payload.rows.length > 0, 'la consulta tiene movimientos');

  // Lo que se descarga.
  const { state, wb } = await runExcel(journal.ledgerExcel, H.mockReq(clinicId, userId, {}, { query }));
  assert.ok(wb, `debía generar un Excel, respondió ${JSON.stringify(state.json)}`);
  assert.match(state.headers['Content-Type'], /spreadsheetml/);
  assert.match(state.headers['Content-Disposition'], /\.xlsx"/);

  const ws = wb.getWorksheet('Libro Mayor');
  assert.ok(ws, 'la hoja del mayor existe');
  const texto = sheetText(ws);

  // El archivo tiene el contexto que hace auditable un Excel suelto.
  assert.ok(texto.includes('Libro Mayor'));
  assert.ok(texto.some((t) => t.includes(gasto.code)), 'aparece la cuenta consultada');

  // Y las MISMAS cifras que la pantalla: el débito total del reporte está en el archivo.
  assert.ok(
    texto.some((t) => Math.abs(Number(t) - pantalla.payload.debit) < 0.005),
    `el débito total (${pantalla.payload.debit}) debe estar en el Excel`
  );
  assert.equal(pantalla.payload.debit, 400);
});

test('BALANCE DE COMPROBACIÓN en Excel sale del mismo controlador que la pantalla', async () => {
  const { clinicId, userId, gasto } = await setup();
  const sup = await H.makeSupplier(clinicId);
  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(0), serie: '001-001-000000302',
    items: [{ description: 'Servicio', lineType: 'GASTO', quantity: 1, unitPrice: 250, ivaRate: 0, subtotal: 250, account: gasto._id }],
  }));
  const query = { startDate: H.docDate(-5).toISOString().slice(0, 10), endDate: H.docDate(1).toISOString().slice(0, 10) };

  const pantalla = await H.runController(journal.trialBalance, H.mockReq(clinicId, userId, {}, { query }));
  const { wb } = await runExcel(journal.trialBalanceExcel, H.mockReq(clinicId, userId, {}, { query }));
  const texto = sheetText(wb.getWorksheet('Balance de comprobación'));

  assert.ok(pantalla.payload.rows.length > 0);
  for (const r of pantalla.payload.rows) {
    assert.ok(texto.includes(r.code), `la cuenta ${r.code} de la pantalla debe estar en el Excel`);
  }
  assert.ok(texto.some((t) => Math.abs(Number(t) - pantalla.payload.totals.debit) < 0.005), 'el total de débitos coincide');
});

test('LIBRO DIARIO en Excel exporta una fila POR LÍNEA de asiento y cuadra debe = haber', async () => {
  const { clinicId, userId, gasto } = await setup();
  const sup = await H.makeSupplier(clinicId);
  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(0), serie: '001-001-000000303',
    items: [{ description: 'Servicio', lineType: 'GASTO', quantity: 1, unitPrice: 100, ivaRate: 15, subtotal: 100, account: gasto._id }],
  }));
  const query = { startDate: H.docDate(-5).toISOString().slice(0, 10), endDate: H.docDate(1).toISOString().slice(0, 10) };

  const { wb } = await runExcel(journal.journalExcel, H.mockReq(clinicId, userId, {}, { query }));
  const ws = wb.getWorksheet('Libro Diario');
  const texto = sheetText(ws);
  assert.ok(texto.includes('Libro Diario'));

  // La fila de TOTALES debe cuadrar: en el diario, débitos = créditos siempre.
  let totalRow = null;
  ws.eachRow((row) => { if (String(row.getCell(1).value || '') === 'TOTALES') totalRow = row; });
  assert.ok(totalRow, 'hay fila de totales');
  const debe = Number(totalRow.getCell(9).value) || 0;
  const haber = Number(totalRow.getCell(10).value) || 0;
  assert.ok(debe > 0, 'hay movimientos');
  assert.ok(Math.abs(debe - haber) < 0.005, `el libro diario debe cuadrar: ${debe} vs ${haber}`);
});

test('ESTADO DE RESULTADOS y BALANCE GENERAL en Excel traen sus hojas de resumen y cuadre', async () => {
  const { clinicId, userId } = await setup();
  const serv = await H.makeProduct(clinicId, { category: 'servicio', salePrice: 300, unlimited: true, taxCategory: 'IVA_0' });
  await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: serv._id, quantity: 1 }], paymentMethod: 'efectivo', date: H.docDate(0),
  }));
  const query = { startDate: H.docDate(-5).toISOString().slice(0, 10), endDate: H.docDate(1).toISOString().slice(0, 10) };

  const pyg = await runExcel(reports.incomeStatementExcel, H.mockReq(clinicId, userId, {}, { query }));
  assert.ok(pyg.wb, JSON.stringify(pyg.state.json));
  assert.ok(pyg.wb.getWorksheet('Estado de Resultados'), 'hoja del detalle');
  const resumen = sheetText(pyg.wb.getWorksheet('Resumen'));
  assert.ok(resumen.includes('(=) UTILIDAD NETA'), 'incluye la cascada tributaria');
  assert.ok(resumen.some((t) => Math.abs(Number(t) - 300) < 0.005), 'el ingreso de 300 está en el resumen');

  const bg = await runExcel(reports.balanceSheetExcel, H.mockReq(clinicId, userId, {}, { query: { date: query.endDate } }));
  assert.ok(bg.wb, JSON.stringify(bg.state.json));
  for (const hoja of ['Activos', 'Pasivos', 'Patrimonio', 'Cuadre']) {
    assert.ok(bg.wb.getWorksheet(hoja), `falta la hoja ${hoja}`);
  }
  const cuadre = sheetText(bg.wb.getWorksheet('Cuadre'));
  assert.ok(cuadre.includes('DESCUADRE (debe ser 0)'), 'el Excel comprueba la ecuación contable');
});

test('un reporte que falla NO se descarga como Excel corrupto: responde el mensaje del error', async () => {
  const { clinicId, userId } = await setup();
  // El mayor exige `account`: sin él, el controlador responde 400.
  const { state, wb } = await runExcel(journal.ledgerExcel, H.mockReq(clinicId, userId, {}, { query: {} }));
  assert.equal(wb, null, 'no debe generarse ningún archivo');
  assert.equal(state.statusCode, 400);
  assert.match(state.json.message, /account/i);
});
