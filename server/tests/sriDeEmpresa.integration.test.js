/**
 * LA CONFIGURACIÓN SRI ES DE LA EMPRESA (29-10-2026). El caso real: la configuración y
 * la «Caja principal» viven en Central, y la cajera solo trabaja en Laboratorio (misma
 * empresa). Sus cobros quedaban sin factura y sin aviso. Ahora el punto y la configuración
 * de la empresa valen desde cualquiera de sus sucursales; otra empresa sigue con lo suyo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Company = require('../models/Company');
const Clinic = require('../models/Clinic');
const User = require('../models/User');
const Sale = require('../models/Sale');
const InvoicingConfig = require('../models/InvoicingConfig');
const PuntoEmision = require('../models/PuntoEmision');
const CashClosing = require('../models/CashClosing');
const companies = require('../utils/companies');
const svc = require('../services/puntoEmision');
const puntosCtrl = require('../controllers/puntoEmisionController');
const configCtrl = require('../controllers/invoicingConfigController');
const sales = require('../controllers/saleController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); companies.invalidateCompanyCache(); });

async function seed() {
  const shiluv = await Company.create({ name: 'Shiluv', isDefault: true });
  const otra = await Company.create({ name: 'Otra' });
  const { clinicId: centralId } = await H.seedClinic();
  const { clinicId: labId } = await H.seedClinic();
  const { clinicId: norteId } = await H.seedClinic();
  await Clinic.create([
    { _id: centralId, name: 'Central', company: shiluv._id },
    { _id: labId, name: 'Laboratorio', company: shiluv._id },
    { _id: norteId, name: 'Norte', company: otra._id },
  ]);
  await companies.refreshCompanyCache();
  const config = await InvoicingConfig.create({
    clinic: centralId, ruc: '0993404160001', razonSocial: 'Shiluv', direccionMatriz: 'Matriz',
    establecimiento: '001', puntoEmision: '001',
  });
  await InvoicingConfig.create({ clinic: norteId, ruc: '0999999999001', razonSocial: 'Otra', direccionMatriz: 'X' });
  const jeniffer = await User.create({
    name: 'Jeniffer', email: `jen${Date.now()}@t.com`, password: 'secreto123', clinics: [{ clinic: labId, role: 'admin' }],
  });
  return { centralId, labId, norteId, config, jeniffer };
}

test('el punto de la empresa vale en todas sus sucursales y la venta sale con él', async () => {
  const { centralId, labId, norteId, config, jeniffer } = await seed();

  assert.equal(String(await svc.sucursalSri(labId)), String(centralId), 'Laboratorio usa la configuración de Central');
  assert.equal(String(await svc.sucursalSri(norteId)), String(norteId), 'otra empresa conserva la suya');

  // Desde Laboratorio se ve y se edita la configuración de la empresa.
  const cfg = await H.runController(configCtrl.getConfig, H.mockReq(labId, null));
  assert.equal(cfg.payload?.ruc, '0993404160001');

  // Alta del punto desde Laboratorio para una usuaria que solo está en Laboratorio: queda en Central.
  const alta = await H.runController(puntosCtrl.create, H.mockReq(labId, null, {
    establecimiento: '003', codigo: '001', nombre: 'Caja principal', usuario: String(jeniffer._id),
    ambiente: '2', secuencialFactura: 1557,
  }));
  assert.equal(alta.statusCode, 201, JSON.stringify(alta.payload));
  const punto = await PuntoEmision.findById(alta.payload._id);
  assert.equal(String(punto.clinic), String(centralId));

  // La lista de puntos es la misma desde cualquier sucursal de la empresa.
  const lista = await H.runController(puntosCtrl.list, H.mockReq(labId, null));
  assert.deepEqual(lista.payload.puntos.map((p) => p.nombre), ['Caja principal']);
  assert.ok(lista.payload.usuarios.some((u) => String(u._id) === String(jeniffer._id)), 'Jeniffer es elegible');

  // Cobrando en Laboratorio: tiene su punto y factura con 003-001 en producción.
  assert.equal(await svc.sucursalUsaPuntos(labId), true);
  const serie = await svc.serieDelEmisor(labId, jeniffer._id, config);
  assert.deepEqual([serie.estab, serie.ptoEmi, serie.ambiente], ['003', '001', '2']);
  assert.equal(await svc.reservarSecuencial(serie, 'factura', config), '000001557');

  // Con punto se cobra solo con la caja abierta: la abre en Laboratorio, donde cobra.
  await CashClosing.create({ clinic: labId, date: new Date(), openedAt: new Date(), openedBy: jeniffer._id, status: 'ABIERTA' });
  const serv = await H.makeProduct(labId, { category: 'servicio', unlimited: true, salePrice: 25, taxCategory: 'IVA_0' });
  const req = H.mockReq(labId, jeniffer._id, { items: [{ product: String(serv._id), quantity: 1 }], paymentMethod: 'efectivo' });
  req.user = { ...jeniffer.toObject(), _id: jeniffer._id };
  const venta = await H.runController(sales.createSale, req);
  assert.equal(venta.statusCode, 201, JSON.stringify(venta.payload));
  assert.equal(String((await Sale.findById(venta.payload._id)).puntoEmision), String(punto._id));

  // Otra empresa no ve ese punto.
  assert.equal(await svc.puntoDelUsuario(norteId, jeniffer._id), null);
});

// 19-11-2026: Jeniffer (punto 003-001) abrió caja en Extensión y otra en Laboratorio. La caja es
// del PUNTO, no de la sucursal: desde cualquier sucursal ve la misma caja, cobra en ella y la cierra.
test('la caja del punto es la misma desde todas las sucursales de la empresa', async () => {
  const { centralId, labId, jeniffer } = await seed();
  const cashClosing = require('../controllers/cashClosingController');
  await H.runController(puntosCtrl.create, H.mockReq(labId, null, {
    establecimiento: '003', codigo: '001', nombre: 'Caja principal', usuario: String(jeniffer._id), ambiente: '1',
  }));
  const comoJen = (clinic, body = {}, extra = {}) => {
    const r = H.mockReq(clinic, jeniffer._id, body, { role: 'admin', ...extra });
    r.user = { ...jeniffer.toObject(), _id: jeniffer._id };
    return r;
  };

  const abierta = await H.runController(cashClosing.open, comoJen(labId, { openingBalance: 10 }));
  assert.equal(abierta.statusCode, 201);

  // Entra por Central: ve su caja abierta (la misma), no se le ofrece abrir otra.
  const desdeCentral = await H.runController(cashClosing.current, comoJen(centralId));
  assert.equal(String(desdeCentral.payload.open?._id), String(abierta.payload._id));
  const segunda = await H.runController(cashClosing.open, comoJen(centralId, { openingBalance: 0 }));
  assert.equal(segunda.statusCode, 400);
  assert.equal(await CashClosing.countDocuments({ status: 'ABIERTA' }), 1);

  // Cobra en las dos sucursales: todo cae en su única caja.
  const mio = await H.runController(puntosCtrl.mine, comoJen(centralId));
  assert.equal(mio.payload.cajaAbierta, true);
  await assert.doesNotReject(svc.assertCajaAbiertaParaFacturar(centralId, jeniffer._id));
  const vender = async (clinic, precio) => {
    const prod = await H.makeProduct(clinic, { category: 'servicio', unlimited: true, salePrice: precio, taxCategory: 'IVA_0', taxRate: 0, priceIncludesVat: false });
    const v = await H.runController(sales.createSale, comoJen(clinic, { items: [{ product: String(prod._id), quantity: 1, unitPrice: precio }], payments: [{ method: 'efectivo', amount: precio }] }));
    assert.equal(v.statusCode, 201, JSON.stringify(v.payload));
  };
  await vender(labId, 25);
  await vender(centralId, 40);
  const vivo = await H.runController(cashClosing.current, comoJen(centralId));
  assert.equal(vivo.payload.live.totalSales, 65, 'ventas de Laboratorio y de Central en la misma caja');
  assert.equal(vivo.payload.live.expectedCash, 75, 'fondo 10 + 65 en efectivo');

  // La cierra desde Central, cuadrada.
  const cierre = await H.runController(cashClosing.close, comoJen(centralId, { countedCash: 75 }, { params: { id: String(abierta.payload._id) } }));
  assert.equal(cierre.statusCode, 200, JSON.stringify(cierre.payload));
  assert.equal(cierre.payload.difference, 0);
  assert.equal(cierre.payload.salesCount, 2);

  // El detalle (desde cualquier sucursal) muestra las dos ventas con su sucursal.
  const det = await H.runController(cashClosing.detail, comoJen(centralId, {}, { params: { id: String(abierta.payload._id) } }));
  assert.equal(det.statusCode, 200, JSON.stringify(det.payload));
  assert.deepEqual(det.payload.sales.map((s) => s.clinic).sort(), ['Central', 'Laboratorio']);

  // Ya cerrada, la siguiente se abre desde cualquier sucursal.
  assert.equal((await H.runController(cashClosing.open, comoJen(centralId, { openingBalance: 0 }))).statusCode, 201);
});
