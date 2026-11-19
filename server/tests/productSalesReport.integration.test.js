/**
 * REPORTE DE VENTAS DE UN PRODUCTO (nov-2026), réplica del de Contífico: el resumen general es de
 * las LÍNEAS del producto; los cobros y la cantidad de documentos, de los DOCUMENTOS completos que
 * lo incluyen.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const sale = require('../controllers/saleController');
const reports = require('../controllers/salesReportsController');
const Sale = require('../models/Sale');
const Clinic = require('../models/Clinic');
const Company = require('../models/Company');
const CostCenter = require('../models/CostCenter');
const { invalidateCompanyCache } = require('../utils/companies');
const accountingScope = require('../middleware/accountingScope');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('resumen del producto: líneas para el total, documentos para los cobros', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const servicio = (name, precio) => H.makeProduct(clinicId, { name, category: 'servicio', salePrice: precio, unlimited: true, taxCategory: 'IVA_0', taxRate: 0, priceIncludesVat: false });
  const A = await servicio('Balanc Fem', 30);
  const B = await servicio('Consulta', 70);
  const vender = async (items, payments) => {
    const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, { items, payments }, { role: 'admin' }));
    assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
    return r.payload;
  };
  await vender([{ product: A._id, quantity: 2, unitPrice: 30 }], [{ method: 'efectivo', amount: 60 }]);
  await vender([{ product: A._id, quantity: 1, unitPrice: 30 }, { product: B._id, quantity: 1, unitPrice: 70 }],
    [{ method: 'tarjeta', amount: 50 }, { method: 'transferencia', amount: 50 }]);
  await vender([{ product: B._id, quantity: 1, unitPrice: 70 }], [{ method: 'efectivo', amount: 70 }]);
  const anulada = await vender([{ product: A._id, quantity: 1, unitPrice: 30 }], [{ method: 'efectivo', amount: 30 }]);
  await Sale.updateOne({ _id: anulada._id }, { $set: { status: 'anulada' } });

  const r = await H.runController(reports.productReport, H.mockReq(clinicId, userId, {}, { query: { product: String(A._id) } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const d = r.payload;

  // Lo vendido del producto: 3 unidades, $90 (no cuenta la consulta ni la anulada).
  assert.equal(d.general.cantidad, 3);
  assert.equal(d.general.subtotal0, 90);
  assert.equal(d.general.subtotalIva, 0);
  assert.equal(d.general.total, 90);

  // Cómo se cobraron los documentos que lo llevan: 60 + 100 (la venta mixta completa).
  assert.equal(d.cobros.efectivo, 60);
  assert.equal(d.cobros.tarjeta, 50);
  assert.equal(d.cobros.transferencia, 50);
  assert.equal(d.cobros.total, 160);
  assert.equal(d.cobros.cobrado, 160);
  assert.deepEqual(d.documentos, { cobrados: 2, pendientes: 0, anulados: 1, total: 3, promedio: 80 });

  // Por hora suma los documentos; el gráfico por producto, solo el producto.
  assert.equal(d.porHora.reduce((s, h) => s + h.total, 0), 160);
  assert.deepEqual(d.grafico.map((g) => [g.label, g.total]), [['Balanc Fem', 90]]);
  assert.equal(d.detalle.length, 3);
  assert.deepEqual(d.filtros.productos.map((p) => p.name), ['Balanc Fem']);

  // Por cliente con filtro de cliente que no existe: nada.
  const vacio = await H.runController(reports.productReport, H.mockReq(clinicId, userId, {}, { query: { product: String(A._id), client: 'Nadie Nunca' } }));
  assert.equal(vacio.payload.general.total, 0);
  assert.equal(vacio.payload.documentos.total, 0);
});

test('con IVA: subtotal IVA + IVA = total de las líneas del producto', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const P = await H.makeProduct(clinicId, { name: 'Jarabe', category: 'servicio', salePrice: 11.5, unlimited: true, taxCategory: 'IVA_15', taxRate: 15, priceIncludesVat: true });
  const v = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: P._id, quantity: 2, unitPrice: 11.5 }], payments: [{ method: 'efectivo', amount: 23 }],
  }, { role: 'admin' }));
  assert.equal(v.statusCode, 201, JSON.stringify(v.payload));
  const d = (await H.runController(reports.productReport, H.mockReq(clinicId, userId, {}, { query: { product: String(P._id) } }))).payload;
  assert.equal(d.general.subtotal0, 0);
  assert.equal(d.general.subtotalIva, 20);
  assert.equal(d.general.iva, 3);
  assert.equal(d.general.total, 23);
  assert.equal(d.cobros.total, 23);
});

test('el detalle abre consolidado desde cualquier sucursal y respeta el centro elegido', async () => {
  const { clinicId: central, userId } = await H.seedClinic();
  const { ObjectId } = H.mongoose.Types;
  const lab = new ObjectId();
  const ajena = new ObjectId();
  const empresa = await Company.create({ name: 'Empresa' });
  const otraEmpresa = await Company.create({ name: 'Otra empresa' });
  const ccCentral = new ObjectId();
  const ccLab = new ObjectId();
  await CostCenter.collection.insertMany([
    { _id: ccCentral, clinic: central, code: '01', name: 'Central' },
    { _id: ccLab, clinic: central, code: '02', name: 'Laboratorio' },
  ]);
  await Clinic.collection.insertMany([
    { _id: central, name: 'Central', company: empresa._id, accountingCostCenter: ccCentral },
    { _id: lab, name: 'Laboratorio', company: empresa._id, accountingCostCenter: ccLab, accountingDataClinic: central },
    { _id: ajena, name: 'Otra empresa', company: otraEmpresa._id },
  ]);
  invalidateCompanyCache();
  const producto = await H.makeProduct(central, { category: 'servicio', unlimited: true });
  const venta = (clinic, costCenter, amount) => ({
    clinic, costCenter, status: 'completada', total: amount, createdAt: new Date(),
    items: [{ product: producto._id, productName: producto.name, quantity: 1, taxBase: amount, lineTotal: amount, taxAmount: 0 }],
    payments: [{ method: 'efectivo', amount }],
  });
  await Sale.collection.insertMany([
    venta(central, ccCentral, 10), venta(central, ccLab, 20),
    venta(lab, ccLab, 30), venta(lab, null, 40), venta(ajena, ccLab, 500),
  ]);

  const consultar = async (clinic, costCenter) => {
    const req = H.mockReq(String(clinic), userId, {}, { query: {
      product: String(producto._id), ...(costCenter ? { costCenter: String(costCenter) } : {}),
    } });
    req.method = 'GET'; req.path = '/product';
    await new Promise((resolve, reject) => accountingScope()(req, {}, (err) => err ? reject(err) : resolve()));
    const out = await H.runController(reports.productReport, req);
    assert.equal(out.statusCode, 200, JSON.stringify(out.payload));
    return out.payload;
  };
  for (const clinic of [central, lab]) {
    const total = await consultar(clinic);
    assert.equal(total.general.total, 100, 'incluye ambas sucursales y las ventas sin centro, no otra empresa');
    assert.equal(total.documentos.total, 4);
    assert.equal((await consultar(clinic, ccCentral)).general.total, 10);
    assert.equal((await consultar(clinic, ccLab)).general.total, 50);
  }
});
