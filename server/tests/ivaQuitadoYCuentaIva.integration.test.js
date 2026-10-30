/**
 * IVA QUITADO DESDE LA FICHA Y CUENTA DE IVA SIN MARCA (30-10-2026). Caso real: a un ítem
 * importado de Contífico (IVA_15) le pusieron 0 % en la ficha y al cobrar seguía llevando
 * IVA; y la sucursal, con el plan de Contífico, no tenía cuenta marcada IVA_VENTAS, así que
 * la venta fallaba con «Cuenta contable no encontrada: IVA_VENTAS».
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Product = require('../models/Product');
const ChartOfAccount = require('../models/ChartOfAccount');
const sales = require('../controllers/saleController');
const products = require('../controllers/productController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const vender = (clinicId, userId, product) => H.runController(sales.createSale, H.mockReq(clinicId, userId, {
  items: [{ product: String(product._id), quantity: 1 }], paymentMethod: 'efectivo',
}));

test('poner 0 % en la ficha quita el IVA de un producto importado como IVA_15', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const crema = await H.makeProduct(clinicId, {
    name: 'Crema', salePrice: 23, stock: 5, taxCategory: 'IVA_15', taxRate: 15, taxCodeSri: '4',
  });
  const r = await H.runController(products.updateProduct, H.mockReq(clinicId, userId, { taxRate: 0 }, { params: { id: String(crema._id) } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const guardado = await Product.findById(crema._id).lean();
  assert.deepEqual([guardado.taxCategory, guardado.taxRate, guardado.taxCodeSri], ['IVA_0', 0, '0']);

  const v = await vender(clinicId, userId, crema);
  assert.equal(v.statusCode, 201, JSON.stringify(v.payload));
  assert.equal(v.payload.taxAmount, 0);
  assert.equal(v.payload.items[0].taxCodeSri, '0');
});

test('un producto que quedó IVA_15 con tasa 0 (guardado antes del arreglo) se cobra sin IVA', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const viejo = await H.makeProduct(clinicId, {
    name: 'Viejo', salePrice: 16, stock: 5, taxCategory: 'IVA_15', taxRate: 0, taxCodeSri: '4',
  });
  const v = await vender(clinicId, userId, viejo);
  assert.equal(v.statusCode, 201, JSON.stringify(v.payload));
  assert.equal(v.payload.taxAmount, 0);
  assert.equal(v.payload.items[0].taxCodeSri, '0');
});

test('sin cuenta marcada IVA_VENTAS, la venta con IVA usa la cuenta «IVA cobrado» del plan y la marca', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await ChartOfAccount.updateMany({ clinic: clinicId, taxCode: 'IVA_VENTAS' }, { $set: { taxCode: null, code: '2.1.07.01', name: 'IVA COBRADO EN VENTAS' } });
  const gravado = await H.makeProduct(clinicId, {
    name: 'Gravado', salePrice: 11.5, stock: 5, taxCategory: 'IVA_15', taxRate: 15, taxCodeSri: '4',
  });
  const v = await vender(clinicId, userId, gravado);
  assert.equal(v.statusCode, 201, JSON.stringify(v.payload));
  assert.equal(v.payload.taxAmount, 1.5);
  const iva = await ChartOfAccount.findOne({ clinic: clinicId, taxCode: 'IVA_VENTAS' }).lean();
  assert.equal(iva?.code, '2.1.07.01', 'queda marcada para la próxima venta');
});
