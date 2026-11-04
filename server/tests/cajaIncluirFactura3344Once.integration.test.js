/**
 * Tarea única: la factura 002-001-000003344 se emitió antes de abrir la caja; se adelanta la
 * apertura de la caja abierta para que la venta entre en ella (lista, total y cuadre).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');
const CashClosing = require('../models/CashClosing');
const PuntoEmision = require('../models/PuntoEmision');
const User = require('../models/User');
const Clinic = require('../models/Clinic');
const cashClosing = require('../controllers/cashClosingController');
const tarea = require('../scripts/cajaIncluirFactura3344Once');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const silencio = () => {};

async function seed() {
  const { clinicId } = await H.seedClinic();
  await Clinic.create({ _id: clinicId, name: 'Central' });
  const cajera = await User.create({ name: 'Cajera', email: `caj${Date.now()}@t.com`, password: 'secreto123', clinics: [{ clinic: clinicId, role: 'cajero' }] });
  const punto = await PuntoEmision.create({ clinic: clinicId, establecimiento: '002', codigo: '001', nombre: 'Caja 2', usuario: cajera._id, activo: true, ambiente: '1' });
  const prod = await H.makeProduct(clinicId, { category: 'servicio', salePrice: 40, unlimited: true, taxCategory: 'IVA_0', taxRate: 0 });
  const antes = new Date(Date.now() - 2 * 3600 * 1000);
  // Venta facturada ANTES de abrir caja (y sin punto enlazado, como las anteriores al cambio).
  const venta = await Sale.create({
    clinic: clinicId, saleNumber: 'V-000099', items: [{ product: prod._id, productName: 'Consulta', quantity: 1, unitPrice: 40, lineTotal: 40, subtotal: 40 }],
    subtotal: 40, taxAmount: 0, total: 40, paymentMethod: 'efectivo', createdBy: cajera._id, status: 'completada',
  });
  await Sale.collection.updateOne({ _id: venta._id }, { $set: { createdAt: antes } });
  const inv = await Invoice.create({ clinic: clinicId, sale: venta._id, claveAcceso: 'x'.repeat(49), secuencial: '000003344', estab: '002', ptoEmi: '001', ambiente: '1', fechaEmision: '04/11/2026', estado: 'AUTORIZADO' });
  await Sale.updateOne({ _id: venta._id }, { $set: { invoice: inv._id } });
  const apertura = new Date(Date.now() - 3600 * 1000);
  const caja = await CashClosing.create({ clinic: clinicId, date: apertura, openedAt: apertura, openedBy: cajera._id, puntoEmision: punto._id, status: 'ABIERTA', openingBalance: 10 });
  return { clinicId, cajera, punto, venta, caja, antes };
}

const detalle = (clinicId, cajera, caja) => H.runController(cashClosing.detail, Object.assign(
  H.mockReq(clinicId, cajera._id, {}, { role: 'cajero', params: { id: String(caja._id) } }),
  { user: { ...cajera.toObject(), _id: cajera._id, getRoleForClinic: () => 'cajero' } },
));

test('adelanta la apertura y la venta entra en la caja abierta; no se repite', async () => {
  const { clinicId, cajera, punto, venta, caja, antes } = await seed();
  assert.equal((await detalle(clinicId, cajera, caja)).payload.sales.length, 0, 'antes no aparece');

  // Dry-run no toca nada.
  await tarea.aplicar({ commit: false, log: silencio });
  assert.equal(String((await CashClosing.findById(caja._id)).openedAt), String(caja.openedAt));

  const r = await tarea.runOnce({ log: silencio });
  assert.equal(r.status, 'DONE');
  const ahora = await CashClosing.findById(caja._id);
  assert.ok(ahora.openedAt < antes && antes - ahora.openedAt <= 1000, 'apertura un segundo antes de la venta');
  assert.match(ahora.notes, /000003344/);
  assert.equal(ahora.status, 'ABIERTA');
  assert.equal(String((await Sale.findById(venta._id)).puntoEmision), String(punto._id), 'venta enlazada al punto');

  const d = await detalle(clinicId, cajera, caja);
  assert.deepEqual(d.payload.sales.map((s) => s.saleNumber), ['V-000099']);
  assert.equal(d.payload.sales[0].invoice.number, '002-001-000003344');

  assert.equal((await tarea.runOnce({ log: silencio })).skipped, true, 'segunda vez no hace nada');
});

test('se niega si una caja anterior del punto ya cubre la venta', async () => {
  const { clinicId, cajera, punto, caja, antes } = await seed();
  await CashClosing.create({
    clinic: clinicId, date: antes, openedAt: new Date(antes.getTime() - 60000), closedAt: new Date(antes.getTime() + 60000),
    openedBy: cajera._id, puntoEmision: punto._id, status: 'CERRADO',
  });
  await assert.rejects(tarea.aplicar({ commit: true, log: silencio }), /contaría dos veces/);
  assert.equal(String((await CashClosing.findById(caja._id)).openedAt), String(caja.openedAt), 'no se tocó la caja');
});
