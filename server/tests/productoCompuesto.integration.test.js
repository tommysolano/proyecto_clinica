/**
 * PRODUCTO COMPUESTO CON COMPOSICIÓN FIJA (29-10-2026). El caso real: «ÁCIDO ALPHALIPOICO
 * 10 ML» es medio frasco del de 20 ml. No tiene stock propio, así que salía «sin stock»
 * aunque hubiera frascos de 20 ml. Ahora se vende por lo que alcanzan sus componentes y al
 * cobrarlo sale medio frasco de 20 ml (kardex y costo); anular la venta lo devuelve.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Product = require('../models/Product');
const Sale = require('../models/Sale');
const InventoryMovement = require('../models/InventoryMovement');
const Patient = require('../models/Patient');
const sales = require('../controllers/saleController');
const products = require('../controllers/productController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const frasco20 = await H.makeProduct(clinicId, {
    code: 'PTACIALP02', name: 'ACIDO ALPHALIPOICO 20ML MOL', salePrice: 39, stock: 28,
    averageCost: 13.15, purchasePrice: 13.15, taxCategory: 'IVA_0', taxRate: 0,
  });
  const diez = await H.makeProduct(clinicId, {
    code: 'PTACIALP03', name: 'ACIDO ALPHALIPOICO 10ML MOL', salePrice: 29, stock: 0, taxCategory: 'IVA_0', taxRate: 0,
  });
  // La composición se guarda por la ficha (valida y sanea).
  const r = await H.runController(products.updateProduct, H.mockReq(clinicId, userId,
    { isComposite: true, composition: [{ product: String(frasco20._id), quantity: '0.5' }] }, { params: { id: String(diez._id) } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  return { clinicId, userId, frasco20, diez };
}

const vender = (clinicId, userId, product, quantity, extra = {}) => H.runController(sales.createSale, H.mockReq(clinicId, userId, {
  items: [{ product: String(product._id), quantity, ...extra.item }], paymentMethod: 'efectivo', ...extra.body,
}));

test('se vende por lo que alcanzan sus componentes y al cobrarlo sale medio frasco de 20 ml', async () => {
  const { clinicId, userId, frasco20, diez } = await seed();

  // Disponible al cobrar: 28 frascos de 20 ml = 56 de 10 ml. El stock propio sigue en 0.
  const lista = await H.runController(products.getProducts, H.mockReq(clinicId, userId));
  const p10 = lista.payload.find((p) => p.code === 'PTACIALP03');
  assert.equal(p10.compositeAvailable, 56);
  assert.equal(p10.stock, 0, 'el inventario muestra el stock del producto tal cual');
  assert.equal(p10.composition[0].productName, 'ACIDO ALPHALIPOICO 20ML MOL');

  const v = await vender(clinicId, userId, diez, 3);
  assert.equal(v.statusCode, 201, JSON.stringify(v.payload));
  assert.equal(v.payload.total, 87);
  assert.equal((await Product.findById(frasco20._id)).stock, 26.5, '3 de 10 ml = 1,5 frascos de 20 ml');
  assert.equal((await Product.findById(diez._id)).stock, 0, 'el compuesto no mueve stock propio');

  const venta = await Sale.findById(v.payload._id);
  assert.equal(venta.items[0].composite, true);
  assert.deepEqual(venta.items[0].linkedItems.map((l) => [l.productCode, l.quantity, l.fromComposition]), [['PTACIALP02', 1.5, true]]);
  const salidas = await InventoryMovement.find({ sourceRef: venta._id, type: 'salida' }).lean();
  assert.deepEqual(salidas.map((m) => [String(m.product), m.quantity]), [[String(frasco20._id), 1.5]], 'kardex: solo sale el frasco de 20 ml');
  assert.ok(venta.items[0].linkedItems[0].cost > 0, 'el costo de venta es el del componente');

  // No alcanza: 60 de 10 ml piden 30 frascos y hay 26,5.
  const corto = await vender(clinicId, userId, diez, 60);
  assert.equal(corto.statusCode, 400);
  assert.match(corto.payload.message, /Stock insuficiente de «ACIDO ALPHALIPOICO 20ML MOL».*Se necesitan 30 y hay 26.5/);

  // Anular devuelve el medio frasco a cada venta.
  const anular = await H.runController(sales.cancelSale, H.mockReq(clinicId, userId, {}, { params: { id: String(venta._id) } }));
  assert.ok(anular.statusCode < 400, JSON.stringify(anular.payload));
  assert.equal((await Product.findById(frasco20._id)).stock, 28);
  assert.equal((await Product.findById(diez._id)).stock, 0);
});

test('la composición solo lleva productos con stock, sin anidar compuestos; un compuesto no se deja guardado', async () => {
  const { clinicId, userId, frasco20, diez } = await seed();
  const servicio = await H.makeProduct(clinicId, { category: 'servicio', unlimited: true, name: 'Consulta' });
  const editar = (id, body) => H.runController(products.updateProduct, H.mockReq(clinicId, userId, body, { params: { id: String(id) } }));

  const conServicio = await editar(diez._id, { composition: [{ product: String(servicio._id), quantity: 1 }] });
  assert.equal(conServicio.statusCode, 400);
  assert.match(conServicio.payload.message, /es un servicio/);

  const otro = await H.makeProduct(clinicId, { name: 'Kit', stock: 0 });
  const anidado = await editar(otro._id, { isComposite: true, composition: [{ product: String(diez._id), quantity: 1 }] });
  assert.equal(anidado.statusCode, 400);
  assert.match(anidado.payload.message, /también es un compuesto/);

  const sinCantidad = await editar(diez._id, { composition: [{ product: String(frasco20._id), quantity: 0 }] });
  assert.equal(sinCantidad.statusCode, 400);

  const paciente = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405' });
  const guardado = await vender(clinicId, userId, diez, 1, {
    item: { delivery: 'en_clinica' }, body: { patient: String(paciente._id), clientName: 'Ana Pérez', clientCedula: '0102030405' },
  });
  assert.equal(guardado.statusCode, 400);
  assert.match(guardado.payload.message, /no se puede dejar guardado/);
});
