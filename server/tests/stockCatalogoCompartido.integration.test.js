/**
 * STOCK CON CATÁLOGO COMPARTIDO (oct-2026). Todo el catálogo se creó bajo UNA
 * sucursal y lo usan todas. Cobrar «DETOX NUTRI 500ML JARABE» desde otra sucursal
 * fallaba con «Stock insuficiente (cambio durante la operación)» aunque Inventario
 * mostrara 49: el descuento buscaba el producto filtrando por la sucursal activa.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Product = require('../models/Product');
const sales = require('../controllers/saleController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('se vende desde otra sucursal un producto del catálogo compartido, y anular devuelve el stock', async () => {
  const { clinicId: duena } = await H.seedClinic();      // sucursal donde se creó el catálogo
  const { clinicId: activa, userId } = await H.seedClinic(); // sucursal desde la que se cobra
  const jarabe = await H.makeProduct(duena, { name: 'DETOX NUTRI 500ML JARABE', category: 'insumo', stock: 49, price: 20 });

  const r = await H.runController(sales.createSale, H.mockReq(activa, userId, {
    items: [{ product: String(jarabe._id), quantity: 2, unitPrice: 20 }],
    paymentMethod: 'efectivo',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal((await Product.findById(jarabe._id)).stock, 47);
  // Los asientos usan cuentas del plan de la sucursal que VENDE (mismo código que las de
  // la categoría, que son de la sucursal dueña del catálogo).
  const JournalEntry = require('../models/JournalEntry');
  const ChartOfAccount = require('../models/ChartOfAccount');
  const asientos = await JournalEntry.find({ sourceModel: 'Sale', sourceRef: r.payload._id });
  const cuentas = await ChartOfAccount.find({ _id: { $in: asientos.flatMap((a) => a.lines.map((l) => l.account)) } });
  assert.ok(cuentas.length > 0);
  assert.ok(cuentas.every((c) => String(c.clinic) === String(activa)), 'ninguna cuenta de otra sucursal');

  const a = await H.runController(sales.cancelSale, H.mockReq(activa, userId, {}, { params: { id: String(r.payload._id) } }));
  assert.equal(a.statusCode, 200, JSON.stringify(a.payload));
  assert.equal((await Product.findById(jarabe._id)).stock, 49, 'anular devuelve el stock');
});

test('sin stock de verdad, sigue sin dejar vender', async () => {
  const { clinicId: duena } = await H.seedClinic();
  const { clinicId: activa, userId } = await H.seedClinic();
  const jarabe = await H.makeProduct(duena, { name: 'Jarabe', category: 'insumo', stock: 1, price: 20 });
  const r = await H.runController(sales.createSale, H.mockReq(activa, userId, {
    items: [{ product: String(jarabe._id), quantity: 2, unitPrice: 20 }],
    paymentMethod: 'efectivo',
  }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /Stock insuficiente/);
  assert.equal((await Product.findById(jarabe._id)).stock, 1);
});
