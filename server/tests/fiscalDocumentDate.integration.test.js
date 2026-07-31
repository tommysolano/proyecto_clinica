/**
 * FECHA AUTOMÁTICA SIN RETROCESO en los comprobantes fiscales.
 *
 * Regla pedida por la administración: la fecha de emisión es automática (hoy) y el sistema
 * NO registra un comprobante con fecha anterior a hoy — tampoco importándolo desde el SRI.
 * Se comprueba en las tres vías: registro manual, edición e importación.
 *
 * El único matiz (y es lo que hace la regla usable): editar un documento que YA existía con
 * fecha anterior no la exige de nuevo; lo que se prohíbe es FIJAR una fecha pasada.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const purchase = require('../controllers/purchaseInvoiceController');
const ChartOfAccount = require('../models/ChartOfAccount');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const { isPastDocumentDate, assertNotPastDocumentDate } = require('../utils/fiscalDocumentDate');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const gastoLine = (account, val = 100) => ({
  description: 'Servicio', lineType: 'GASTO', quantity: 1, unitPrice: val, ivaRate: 0, subtotal: val, account,
});

async function setup() {
  const { clinicId, userId } = await H.seedClinic();
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const sup = await H.makeSupplier(clinicId);
  return { clinicId, userId, gasto, sup };
}

// ─────────────────────────────────────────────────────────────────────────────
test('utilidad: ayer es fecha pasada, hoy no; y una fecha que no cambia no se vuelve a validar', () => {
  assert.equal(isPastDocumentDate(H.docDate(-1)), true);
  assert.equal(isPastDocumentDate(H.docDate(0)), false);
  assert.equal(isPastDocumentDate(H.docDate(1)), false);

  assert.throws(() => assertNotPastDocumentDate(H.docDate(-1), { label: 'la compra' }), /anterior a hoy/);
  // Misma fecha que ya tenía el documento ⇒ no se valida (permite corregir un histórico).
  assert.doesNotThrow(() => assertNotPastDocumentDate(H.docDate(-5), { label: 'la compra', current: H.docDate(-5) }));
  // Una fecha vacía no se valida aquí (la obligatoriedad la exige el esquema).
  assert.doesNotThrow(() => assertNotPastDocumentDate(null, { label: 'la compra' }));
});

// ─────────────────────────────────────────────────────────────────────────────
test('registrar una compra con fecha de AYER se rechaza con 400 explicando la regla', async () => {
  const { clinicId, userId, gasto, sup } = await setup();
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(-1), serie: '001-001-000000801',
    items: [gastoLine(gasto._id, 100)],
  }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /anterior a hoy/i);
  assert.equal(await PurchaseInvoice.countDocuments({ clinic: clinicId }), 0, 'no se guardó nada');
});

// ─────────────────────────────────────────────────────────────────────────────
test('registrar una compra con fecha de HOY se acepta', async () => {
  const { clinicId, userId, gasto, sup } = await setup();
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(0), serie: '001-001-000000802',
    items: [gastoLine(gasto._id, 100)],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
});

// ─────────────────────────────────────────────────────────────────────────────
test('editar una compra HISTÓRICA conserva su fecha, pero no se la puede mover más atrás', async () => {
  const { clinicId, userId, gasto, sup } = await setup();
  // Documento histórico creado por fuera del controlador (como los que ya existen en la base).
  const inv = await PurchaseInvoice.create({
    clinic: clinicId, supplier: sup._id, serie: '001-001-000000803',
    fechaEmision: H.docDate(-30), status: 'REGISTRADA', strictAccounts: true,
    items: [gastoLine(gasto._id, 100)], subtotal: 100, total: 100, balance: 100,
  });

  // Editar SIN tocar la fecha: permitido (si no, un histórico sería incorregible).
  const ok = await H.runController(purchase.update, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: inv.fechaEmision, notes: 'corrección de glosa',
    items: [gastoLine(gasto._id, 100)],
  }, { params: { id: String(inv._id) } }));
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.payload));

  // Moverla AÚN más atrás: rechazado.
  const bad = await H.runController(purchase.update, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(-60),
    items: [gastoLine(gasto._id, 100)],
  }, { params: { id: String(inv._id) } }));
  assert.equal(bad.statusCode, 400, JSON.stringify(bad.payload));
  assert.match(bad.payload.message, /anterior a hoy/i);
});

// ─────────────────────────────────────────────────────────────────────────────
test('importador TXT del SRI: rechaza las filas atrasadas SIN reescribirles la fecha', async () => {
  const { clinicId, userId } = await setup();
  const d = (x) => `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
  // Formato del reporte de compras del SRI (mismas columnas que usa parseSriReport).
  const header = 'COMPROBANTE\tSERIE_COMPROBANTE\tRUC_EMISOR\tRAZON_SOCIAL_EMISOR\tCLAVE_ACCESO\tFECHA_EMISION\tFECHA_AUTORIZACION\tTIPO_EMISION\tIDENTIFICACION_RECEPTOR\tVALOR_SIN_IMPUESTOS\tIVA\tIMPORTE_TOTAL';
  const row = (serie, fecha) => `Factura\t${serie}\t0912345678001\tPROVEEDOR X\t\t${d(fecha)}\t${d(fecha)}\tNORMAL\t0999999999001\t100.00\t15.00\t115.00`;
  const text = [header, row('001-001-000000901', H.docDate(-40)), row('001-001-000000902', H.docDate(0))].join('\n');

  const r = await H.runController(purchase.importTxt, H.mockReq(clinicId, userId, { text }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.created, 1, 'solo entra el comprobante de hoy');
  assert.equal(r.payload.errors.length, 1, 'el atrasado se reporta como error, no se importa');
  assert.match(r.payload.errors[0].error, /anterior a hoy/i);

  // Y el que sí entró conserva su fecha REAL (nunca se le inventa otra).
  const guardadas = await PurchaseInvoice.find({ clinic: clinicId });
  assert.equal(guardadas.length, 1);
  assert.equal(isPastDocumentDate(guardadas[0].fechaEmision), false);
});
