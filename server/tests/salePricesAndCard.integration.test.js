/**
 * LISTA DE PRECIOS DE VENTA y TIPO DE TARJETA.
 *
 * Dos cambios pedidos para el punto de cobro:
 *
 *  1. Un producto puede tener VARIOS precios de venta (público, corporativo, promoción…) con
 *     uno marcado como ACTIVO. `salePrice` sigue siendo ese activo —lo lee todo el sistema—,
 *     así que la invariante «salePrice = el precio activo de la lista» es lo que hay que
 *     proteger: si se rompiera, se facturaría a un precio que nadie eligió.
 *     Al vender se puede escoger otro precio, pero SOLO uno de la lista del producto: aceptar
 *     cualquier importe del navegador convertiría la lista de precios en una sugerencia.
 *
 *  2. La tarjeta se cobra como DÉBITO o CRÉDITO, y eso lo elige el cajero. Antes se deducía de
 *     la configuración de la tarjeta, así que un mismo adquirente (Datafast) que procesa las
 *     dos metía todo en la misma columna del reporte.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const products = require('../controllers/productController');
const sale = require('../controllers/saleController');
const Product = require('../models/Product');
const CreditCard = require('../models/CreditCard');
const ChartOfAccount = require('../models/ChartOfAccount');
const { normalizeSalePayments } = require('../services/salePayments');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const nuevoProducto = (over = {}) => ({
  name: 'Consulta', category: 'servicio', unlimited: true, taxCategory: 'IVA_0', taxRate: 0,
  ...over,
});

// ───────────────────────────── Lista de precios ──────────────────────────────
test('un producto con varios precios deja salePrice sincronizado con el ACTIVO', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const r = await H.runController(products.createProduct, H.mockReq(clinicId, userId, nuevoProducto({
    salePrices: [
      { name: 'Público', price: 100, active: false },
      { name: 'Corporativo', price: 80, active: true },
      { name: 'Promoción', price: 60, active: false },
    ],
  })));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.salePrice, 80, 'salePrice = el precio marcado como activo');
  assert.equal(r.payload.salePrices.length, 3);
  assert.equal(r.payload.salePrices.filter((p) => p.active).length, 1, 'exactamente un activo');
});

test('si llegan varios activos (o ninguno), el backend deja UNO solo', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const varios = await H.runController(products.createProduct, H.mockReq(clinicId, userId, nuevoProducto({
    code: 'P-VARIOS',
    salePrices: [{ name: 'A', price: 10, active: true }, { name: 'B', price: 20, active: true }],
  })));
  assert.equal(varios.payload.salePrices.filter((p) => p.active).length, 1);
  assert.equal(varios.payload.salePrice, 10, 'gana el primero marcado');

  const ninguno = await H.runController(products.createProduct, H.mockReq(clinicId, userId, nuevoProducto({
    code: 'P-NINGUNO',
    salePrices: [{ name: 'A', price: 30 }, { name: 'B', price: 40 }],
  })));
  assert.equal(ninguno.payload.salePrices[0].active, true, 'sin marca, el primero es el activo');
  assert.equal(ninguno.payload.salePrice, 30);
});

test('un producto con un solo precio (alta sencilla) sigue funcionando igual que antes', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const r = await H.runController(products.createProduct, H.mockReq(clinicId, userId, nuevoProducto({ salePrice: 45 })));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.salePrice, 45);
  assert.equal(r.payload.salePrices.length, 1, 'se sintetiza la lista con su único precio');
  assert.equal(r.payload.salePrices[0].active, true);
});

test('cambiar el precio activo al editar mueve salePrice con él', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const creado = await H.runController(products.createProduct, H.mockReq(clinicId, userId, nuevoProducto({
    salePrices: [{ name: 'Público', price: 100, active: true }, { name: 'Corporativo', price: 80, active: false }],
  })));
  const editado = await H.runController(products.updateProduct, H.mockReq(clinicId, userId, {
    salePrices: [{ name: 'Público', price: 100, active: false }, { name: 'Corporativo', price: 80, active: true }],
  }, { params: { id: String(creado.payload._id) } }));
  assert.equal(editado.statusCode, 200, JSON.stringify(editado.payload));
  assert.equal(editado.payload.salePrice, 80, 'el activo pasó a ser el corporativo');
});

// ─────────────────── El precio elegido al vender se valida ────────────────────
test('vender con OTRO precio de la lista usa ese precio', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await H.runController(products.createProduct, H.mockReq(clinicId, userId, nuevoProducto({
    salePrices: [{ name: 'Público', price: 100, active: true }, { name: 'Corporativo', price: 80, active: false }],
  })));

  const v = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: p.payload._id, quantity: 1, priceName: 'Corporativo' }],
    paymentMethod: 'efectivo', date: H.docDate(0),
  }));
  assert.equal(v.statusCode, 201, JSON.stringify(v.payload));
  assert.equal(v.payload.total, 80, 'se cobró el precio corporativo');
  assert.equal(v.payload.items[0].unitPrice, 80);
});

test('sin indicar precio se cobra el ACTIVO', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await H.runController(products.createProduct, H.mockReq(clinicId, userId, nuevoProducto({
    salePrices: [{ name: 'Público', price: 100, active: false }, { name: 'Corporativo', price: 80, active: true }],
  })));
  const v = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: p.payload._id, quantity: 1 }], paymentMethod: 'efectivo', date: H.docDate(0),
  }));
  assert.equal(v.statusCode, 201, JSON.stringify(v.payload));
  assert.equal(v.payload.total, 80);
});

test('un precio INVENTADO desde el cliente se rechaza (la lista es una política, no una sugerencia)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await H.runController(products.createProduct, H.mockReq(clinicId, userId, nuevoProducto({
    salePrices: [{ name: 'Público', price: 100, active: true }, { name: 'Corporativo', price: 80, active: false }],
  })));

  const porImporte = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: p.payload._id, quantity: 1, unitPrice: 1 }],
    paymentMethod: 'efectivo', date: H.docDate(0),
  }));
  assert.equal(porImporte.statusCode, 400, JSON.stringify(porImporte.payload));
  assert.match(porImporte.payload.message, /no está en la lista/i);

  const porNombre = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: p.payload._id, quantity: 1, priceName: 'Regalado' }],
    paymentMethod: 'efectivo', date: H.docDate(0),
  }));
  assert.equal(porNombre.statusCode, 400);
  assert.match(porNombre.payload.message, /no existe en la lista/i);
});

test('un producto ANTIGUO (sin lista) solo admite su salePrice', async () => {
  const { clinicId, userId } = await H.seedClinic();
  // Creado por fuera del controlador, como los que ya existen en la base.
  const legacy = await Product.create({
    clinic: clinicId, code: 'LEGACY-1', name: 'Servicio viejo', category: 'servicio',
    unlimited: true, salePrice: 55, taxCategory: 'IVA_0', taxRate: 0,
  });
  const ok = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: legacy._id, quantity: 1, unitPrice: 55 }], paymentMethod: 'efectivo', date: H.docDate(0),
  }));
  assert.equal(ok.statusCode, 201, JSON.stringify(ok.payload));
  assert.equal(ok.payload.total, 55);

  const malo = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: legacy._id, quantity: 1, unitPrice: 5 }], paymentMethod: 'efectivo', date: H.docDate(0),
  }));
  assert.equal(malo.statusCode, 400);
});

// ───────────────────────── Tipo de tarjeta: débito / crédito ─────────────────
test('el tipo de tarjeta que elige el cajero manda sobre la configuración de la tarjeta', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const tarjAcc = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.02.03' })
    || await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.01' });
  // Un ÚNICO registro de adquirente que en la configuración figura como CREDITO,
  // pero que en la práctica procesa también débito: el caso que rompía el reporte.
  const card = await CreditCard.create({
    clinic: clinicId, name: 'Datafast', brand: 'VISA', accountType: 'CREDITO', chartAccount: tarjAcc?._id || null,
  });
  const p = await H.runController(products.createProduct, H.mockReq(clinicId, userId, nuevoProducto({ salePrice: 100 })));

  const v = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: p.payload._id, quantity: 1 }],
    payments: [{ method: 'tarjeta', amount: 100, creditCard: card._id, cardType: 'DEBITO' }],
    date: H.docDate(0),
  }));
  assert.equal(v.statusCode, 201, JSON.stringify(v.payload));
  assert.equal(v.payload.payments[0].cardTypeSnapshot, 'DEBITO', 'manda lo que eligió el cajero');

  // Y el reporte lo separa en la columna correcta.
  const norm = normalizeSalePayments(v.payload, []);
  assert.equal(norm.rows[0].method, 'tarjeta_debito');
});

test('sin tipo elegido se conserva el de la tarjeta configurada (ventas de clientes antiguos)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const card = await CreditCard.create({ clinic: clinicId, name: 'Datafast', brand: 'VISA', accountType: 'CREDITO' });
  const p = await H.runController(products.createProduct, H.mockReq(clinicId, userId, nuevoProducto({ salePrice: 100 })));

  const v = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: p.payload._id, quantity: 1 }],
    payments: [{ method: 'tarjeta', amount: 100, creditCard: card._id }],
    date: H.docDate(0),
  }));
  assert.equal(v.statusCode, 201, JSON.stringify(v.payload));
  assert.equal(v.payload.payments[0].cardTypeSnapshot, 'CREDITO');
});

test('un tipo de tarjeta inventado no se guarda: se cae al de la tarjeta', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const card = await CreditCard.create({ clinic: clinicId, name: 'Datafast', brand: 'VISA', accountType: 'CREDITO' });
  const p = await H.runController(products.createProduct, H.mockReq(clinicId, userId, nuevoProducto({ salePrice: 100 })));

  const v = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: p.payload._id, quantity: 1 }],
    payments: [{ method: 'tarjeta', amount: 100, creditCard: card._id, cardType: 'REGALO' }],
    date: H.docDate(0),
  }));
  assert.equal(v.statusCode, 201, JSON.stringify(v.payload));
  assert.equal(v.payload.payments[0].cardTypeSnapshot, 'CREDITO', 'no se acepta un tipo fuera del catálogo');
});
