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

test('cobra un servicio de otra sucursal aunque falte su cuenta de ingreso personalizada', async () => {
  const { clinicId: duena } = await H.seedClinic();
  const { clinicId: activa, userId } = await H.seedClinic();
  const ChartOfAccount = require('../models/ChartOfAccount');
  const InventoryCategory = require('../models/InventoryCategory');
  const JournalEntry = require('../models/JournalEntry');
  const Sale = require('../models/Sale');

  const parent = await ChartOfAccount.findOne({ clinic: duena, code: '4.1' });
  const ingreso = await ChartOfAccount.create({
    clinic: duena, code: '4.1.12', name: 'Ventas de Laboratorio',
    type: 'INGRESO', nature: 'CREDITO', parent: parent._id, level: 3,
  });
  const categoria = await InventoryCategory.create({
    clinic: duena, code: 'LAB', name: 'EXAMENES DE LABORATORIO',
    kind: 'SERVICIO', incomeAccount: ingreso._id,
  });
  const servicio = await H.makeProduct(duena, {
    name: 'EXAMENES DE LABORATORIO', category: 'servicio',
    salePrice: 48.80, taxCategory: 'IVA_0', taxRate: 0,
    inventoryCategory: categoria._id, incomeAccount: ingreso._id,
  });
  assert.equal(await ChartOfAccount.countDocuments({ clinic: activa, code: '4.1.12' }), 0);

  const r = await H.runController(sales.createSale, H.mockReq(activa, userId, {
    items: [{ product: String(servicio._id), quantity: 1, unitPrice: 48.80 }],
    paymentMethod: 'efectivo',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const local = await ChartOfAccount.findOne({ clinic: activa, code: '4.1.12' });
  assert.ok(local, 'la sucursal que cobra tiene la cuenta personalizada');
  assert.equal(local.name, 'Ventas de Laboratorio');
  assert.notEqual(String(local._id), String(ingreso._id));
  const asientos = await JournalEntry.find({ clinic: activa, sourceModel: 'Sale', sourceRef: r.payload._id });
  assert.ok(asientos.some((a) => a.lines.some((l) => String(l.account) === String(local._id) && l.credit === 48.80)));
  assert.equal(await Sale.countDocuments({ clinic: activa, _id: r.payload._id }), 1);
  assert.equal(await ChartOfAccount.countDocuments({ clinic: duena, code: '4.1.12' }), 1);

  // Otra sucursal puede empezar sin plan propio: también necesita los padres de la cuenta.
  const { clinicId: sinPlan, userId: userSinPlan } = await H.seedClinic();
  await ChartOfAccount.deleteMany({ clinic: sinPlan });
  const segunda = await H.runController(sales.createSale, H.mockReq(sinPlan, userSinPlan, {
    items: [{ product: String(servicio._id), quantity: 1, unitPrice: 48.80 }],
    paymentMethod: 'efectivo',
  }));
  assert.equal(segunda.statusCode, 201, JSON.stringify(segunda.payload));
  const cuentaSinPlan = await ChartOfAccount.findOne({ clinic: sinPlan, code: '4.1.12' });
  const padreSinPlan = await ChartOfAccount.findById(cuentaSinPlan?.parent);
  assert.equal(padreSinPlan?.code, '4.1');
  assert.equal(String(padreSinPlan.clinic), String(sinPlan));
  assert.equal((await ChartOfAccount.findById(padreSinPlan.parent))?.code, '4');
});

test('sin stock suficiente se vende igual (29-10-2026): avisa, descuenta lo que hay y anular devuelve eso', async () => {
  const { clinicId: duena } = await H.seedClinic();
  const { clinicId: activa, userId } = await H.seedClinic();
  const jarabe = await H.makeProduct(duena, { name: 'Jarabe', category: 'insumo', stock: 1, price: 20 });
  const r = await H.runController(sales.createSale, H.mockReq(activa, userId, {
    items: [{ product: String(jarabe._id), quantity: 2, unitPrice: 20 }],
    paymentMethod: 'efectivo',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.ok((r.payload.warnings || []).some((w) => /Jarabe.*se vendieron 2 y el inventario tenía 1/.test(w)));
  assert.equal((await Product.findById(jarabe._id)).stock, 0, 'nunca queda negativo');

  const anular = await H.runController(sales.cancelSale, H.mockReq(activa, userId, {}, { params: { id: String(r.payload._id) } }));
  assert.ok(anular.statusCode < 400, JSON.stringify(anular.payload));
  assert.equal((await Product.findById(jarabe._id)).stock, 1, 'devuelve solo lo que salió');
});
