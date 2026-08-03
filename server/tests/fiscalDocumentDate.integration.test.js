/**
 * FECHA DE LOS COMPROBANTES FISCALES.
 *
 * La regla NO es la misma en los dos sentidos, y esa asimetría es justo lo que se comprueba:
 *
 *   · VENTAS  → el comprobante lo emitimos NOSOTROS, y su factura electrónica se emite hoy
 *               (el SRI rechaza una emisión atrasada). Fecha anterior a hoy ⇒ 400.
 *   · COMPRAS → la factura la emite el PROVEEDOR y llega días o semanas después. Su fecha es
 *               un dato del comprobante recibido, no del día en que se digita: se acepta tal
 *               cual, incluso de meses anteriores. Lo que protege el pasado es el PERÍODO
 *               FISCAL (un mes cerrado no admite movimientos).
 *
 * Antes ambas seguían la regla de ventas: no se podían registrar las facturas del mes pasado
 * y el importador del SRI rechazaba meses anteriores, que es justo para lo que sirve.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const purchase = require('../controllers/purchaseInvoiceController');
const sale = require('../controllers/saleController');
const ChartOfAccount = require('../models/ChartOfAccount');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Sale = require('../models/Sale');
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

  assert.throws(() => assertNotPastDocumentDate(H.docDate(-1), { label: 'la venta' }), /anterior a hoy/);
  // Misma fecha que ya tenía el documento ⇒ no se valida (permite corregir un histórico).
  assert.doesNotThrow(() => assertNotPastDocumentDate(H.docDate(-5), { label: 'la venta', current: H.docDate(-5) }));
  // Una fecha vacía no se valida aquí (la obligatoriedad la exige el esquema).
  assert.doesNotThrow(() => assertNotPastDocumentDate(null, { label: 'la venta' }));
});

// ───────────────────────────── VENTAS: sin retroceso ─────────────────────────
test('VENTA con fecha de AYER se rechaza con 400 explicando la regla', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const serv = await H.makeProduct(clinicId, { category: 'servicio', salePrice: 100, unlimited: true, taxCategory: 'IVA_0' });
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: serv._id, quantity: 1 }], paymentMethod: 'efectivo', date: H.docDate(-1),
  }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /anterior a hoy/i);
  assert.equal(await Sale.countDocuments({ clinic: clinicId }), 0, 'no se guardó nada');
});

test('VENTA con fecha de HOY se acepta', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const serv = await H.makeProduct(clinicId, { category: 'servicio', salePrice: 100, unlimited: true, taxCategory: 'IVA_0' });
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: serv._id, quantity: 1 }], paymentMethod: 'efectivo', date: H.docDate(0),
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
});

// ───────────────────── COMPRAS: la fecha es la del proveedor ─────────────────
test('COMPRA con fecha de AYER se acepta: es la fecha del comprobante del proveedor', async () => {
  const { clinicId, userId, gasto, sup } = await setup();
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(-1), serie: '001-001-000000801',
    items: [gastoLine(gasto._id, 100)],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const guardada = await PurchaseInvoice.findOne({ clinic: clinicId, serie: '001-001-000000801' });
  assert.ok(guardada, 'la compra se guardó');
  // Y conserva la fecha REAL del comprobante: reescribirla falsearía el 103/104 y el ATS.
  assert.equal(isPastDocumentDate(guardada.fechaEmision), true, 'no se le reescribió la fecha a hoy');
});

test('COMPRA de un mes anterior se acepta (el caso que bloqueaba registrar las facturas del mes pasado)', async () => {
  const { clinicId, userId, gasto, sup } = await setup();
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(-45), serie: '001-001-000000804',
    items: [gastoLine(gasto._id, 250)],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
});

test('COMPRA con fecha de HOY se acepta', async () => {
  const { clinicId, userId, gasto, sup } = await setup();
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(0), serie: '001-001-000000802',
    items: [gastoLine(gasto._id, 100)],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
});

// ─────────────────────────────────────────────────────────────────────────────
test('editar una compra HISTÓRICA permite corregir su fecha hacia atrás', async () => {
  const { clinicId, userId, gasto, sup } = await setup();
  // Documento histórico creado por fuera del controlador (como los que ya existen en la base).
  const inv = await PurchaseInvoice.create({
    clinic: clinicId, supplier: sup._id, serie: '001-001-000000803',
    fechaEmision: H.docDate(-30), status: 'REGISTRADA', strictAccounts: true,
    items: [gastoLine(gasto._id, 100)], subtotal: 100, total: 100, balance: 100,
  });

  // Editar SIN tocar la fecha.
  const ok = await H.runController(purchase.update, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: inv.fechaEmision, notes: 'corrección de glosa',
    items: [gastoLine(gasto._id, 100)],
  }, { params: { id: String(inv._id) } }));
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.payload));

  // Corregirla a otra fecha pasada (se digitó mal el día del comprobante): permitido.
  const movida = await H.runController(purchase.update, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(-31),
    items: [gastoLine(gasto._id, 100)],
  }, { params: { id: String(inv._id) } }));
  assert.equal(movida.statusCode, 200, JSON.stringify(movida.payload));
});

// ─────────────────────────────────────────────────────────────────────────────
test('importador TXT del SRI: importa también los comprobantes de meses anteriores, con su fecha real', async () => {
  const { clinicId, userId } = await setup();
  const d = (x) => `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
  // Formato del reporte de compras del SRI (mismas columnas que usa parseSriReport).
  const header = 'COMPROBANTE\tSERIE_COMPROBANTE\tRUC_EMISOR\tRAZON_SOCIAL_EMISOR\tCLAVE_ACCESO\tFECHA_EMISION\tFECHA_AUTORIZACION\tTIPO_EMISION\tIDENTIFICACION_RECEPTOR\tVALOR_SIN_IMPUESTOS\tIVA\tIMPORTE_TOTAL';
  const row = (serie, fecha) => `Factura\t${serie}\t0912345678001\tPROVEEDOR X\t\t${d(fecha)}\t${d(fecha)}\tNORMAL\t0999999999001\t100.00\t15.00\t115.00`;
  const atrasado = H.docDate(-40);
  const text = [header, row('001-001-000000901', atrasado), row('001-001-000000902', H.docDate(0))].join('\n');

  const r = await H.runController(purchase.importTxt, H.mockReq(clinicId, userId, { text }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.created, 2, 'entran los dos comprobantes, también el de hace 40 días');
  assert.equal(r.payload.errors.length, 0, JSON.stringify(r.payload.errors));

  // Cada uno conserva su fecha REAL: es la que suman el 103/104 y el ATS.
  const guardadas = await PurchaseInvoice.find({ clinic: clinicId }).sort({ fechaEmision: 1 });
  assert.equal(guardadas.length, 2);
  assert.equal(isPastDocumentDate(guardadas[0].fechaEmision), true, 'el atrasado mantiene su fecha');
  assert.equal(guardadas[0].fechaEmision.getMonth(), atrasado.getMonth());
  assert.equal(isPastDocumentDate(guardadas[1].fechaEmision), false);
});
