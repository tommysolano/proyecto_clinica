/**
 * Puntos de emisión / puntos de venta (oct-2026).
 *
 * Cada caja es una serie estab-ptoEmi con numeración propia y UN usuario. Verifica:
 *  - alta/edición: un punto por usuario, serie única (también entre sucursales del mismo RUC),
 *    la numeración nunca baja de lo ya emitido y el primer punto continúa la serie anterior;
 *  - emisión: cada usuario numera desde su punto, sin duplicados en concurrencia; sin punto
 *    (habiendo puntos) no se emite; sin puntos en la sucursal sigue la serie de la config;
 *  - caja: cada usuario abre/cierra la de su punto y su esperado cuenta solo lo suyo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const H = require('./_integrationHelpers');

const ctrl = require('../controllers/puntoEmisionController');
const sale = require('../controllers/saleController');
const cashClosing = require('../controllers/cashClosingController');
const PuntoEmision = require('../models/PuntoEmision');
const InvoicingConfig = require('../models/InvoicingConfig');
const Invoice = require('../models/Invoice');
const Sale = require('../models/Sale');
const User = require('../models/User');
const svc = require('../services/puntoEmision');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

let n = 0;
async function makeUser(clinicId, role, name) {
  n += 1;
  return User.create({
    name: name || `${role} ${n}`,
    email: `u${n}-${Date.now()}@test.local`,
    password: 'secreto123',
    clinics: [{ clinic: clinicId, role }],
  });
}

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const config = await InvoicingConfig.create({
    clinic: clinicId,
    ruc: '0999999999001',
    razonSocial: 'Clínica Test',
    direccionMatriz: 'Matriz',
    establecimiento: '001',
    puntoEmision: '001',
    secuencial: 50,
    creditNoteSequential: 7,
  });
  const cajeroA = await makeUser(clinicId, 'cajero', 'Ana');
  const cajeroB = await makeUser(clinicId, 'cajero', 'Beto');
  const admin = await makeUser(clinicId, 'admin', 'Admin');
  return { clinicId, userId, config, cajeroA, cajeroB, admin };
}

// El ambiente es obligatorio al crear (oct-2026); los tests que no hablan de él usan pruebas.
const crear = (clinicId, body) => H.runController(ctrl.create, H.mockReq(clinicId, null, { ambiente: '1', ...body }));
const editar = (clinicId, id, body) => H.runController(ctrl.update, H.mockReq(clinicId, null, body, { params: { id: String(id) } }));

// ─────────────────────────────────────────────────────────────────────────────
test('1) el primer punto continúa la serie de la config; los siguientes arrancan en 1', async () => {
  const { clinicId, cajeroA, cajeroB } = await seed();
  const r1 = await crear(clinicId, { establecimiento: '001', codigo: '001', nombre: 'Caja 1', usuario: String(cajeroA._id) });
  assert.equal(r1.statusCode, 201, JSON.stringify(r1.payload));
  assert.equal(r1.payload.secuencialFactura, 50, 'continúa la factura 50 de la config');
  assert.equal(r1.payload.secuencialNotaCredito, 7, 'continúa la N/C 7 de la config');

  const r2 = await crear(clinicId, { establecimiento: '1', codigo: '2', nombre: 'Caja 2', usuario: String(cajeroB._id) });
  assert.equal(r2.statusCode, 201, JSON.stringify(r2.payload));
  assert.equal(r2.payload.codigo, '002', 'normaliza a 3 dígitos');
  assert.equal(r2.payload.secuencialFactura, 1);
});

test('2) un punto por usuario, serie única y usuario elegible', async () => {
  const { clinicId, cajeroA } = await seed();
  await crear(clinicId, { codigo: '001', usuario: String(cajeroA._id) });

  const otroPunto = await crear(clinicId, { codigo: '002', usuario: String(cajeroA._id) });
  assert.equal(otroPunto.statusCode, 400);
  assert.match(otroPunto.payload.message, /solo puede tener un punto/);

  const repetida = await crear(clinicId, { codigo: '001' });
  assert.equal(repetida.statusCode, 400);
  assert.match(repetida.payload.message, /Ya existe el punto 001-001/);

  const doctor = await makeUser(clinicId, 'doctor');
  const noElegible = await crear(clinicId, { codigo: '003', usuario: String(doctor._id) });
  assert.equal(noElegible.statusCode, 400);
});

test('3) la numeración no puede bajar de lo ya emitido con esa serie', async () => {
  const { clinicId } = await seed();
  const r = await crear(clinicId, { codigo: '002' });
  await Invoice.create({
    clinic: clinicId, claveAcceso: `CLV${Date.now()}`.padEnd(49, '0'), secuencial: '000000010',
    estab: '001', ptoEmi: '002', ambiente: '1', fechaEmision: '01/10/2026', importeTotal: 10,
  });
  const baja = await editar(clinicId, r.payload._id, { secuencialFactura: 5 });
  assert.equal(baja.statusCode, 400);
  assert.match(baja.payload.message, /al menos 11/);
  const ok = await editar(clinicId, r.payload._id, { secuencialFactura: 11 });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.payload));
  assert.equal(ok.payload.secuencialFactura, 11);
});

test('4) otra sucursal con el mismo RUC ya usa la serie → se rechaza', async () => {
  const { clinicId } = await seed();
  await InvoicingConfig.create({
    clinic: new mongoose.Types.ObjectId(), ruc: '0999999999001', establecimiento: '001', puntoEmision: '003',
  });
  const r = await crear(clinicId, { codigo: '003' });
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /mismo RUC/);
});

// ─────────────────────────────────────────────────────────────────────────────
test('5) emisión: serie del emisor, sin punto no emite, numeración atómica por punto', async () => {
  const { clinicId, config, cajeroA, cajeroB, admin } = await seed();

  // Sin puntos en la sucursal: serie de la config (modo anterior).
  const legacy = await svc.serieDelEmisor(clinicId, admin._id, config);
  assert.equal(legacy.punto, null);
  assert.equal(`${legacy.estab}-${legacy.ptoEmi}`, '001-001');

  await crear(clinicId, { codigo: '001', usuario: String(cajeroA._id) });
  await crear(clinicId, { codigo: '002', usuario: String(cajeroB._id), direccionEstablecimiento: 'Av. Caja 2' });

  await assert.rejects(svc.serieDelEmisor(clinicId, admin._id, config), (e) => e.code === 'SIN_PUNTO_EMISION' && e.status === 400);

  const serieB = await svc.serieDelEmisor(clinicId, cajeroB._id, config);
  assert.equal(`${serieB.estab}-${serieB.ptoEmi}`, '001-002');
  assert.equal(serieB.dirEstablecimiento, 'Av. Caja 2');

  // 20 facturas a la vez en la caja B: 20 números distintos y consecutivos.
  const nums = await Promise.all(Array.from({ length: 20 }, () => svc.reservarSecuencial(serieB, 'factura', config)));
  assert.equal(new Set(nums).size, 20);
  assert.deepEqual([...nums].sort(), Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(9, '0')));

  // La caja A no se ve afectada y sigue en 50; la N/C numera aparte.
  const serieA = await svc.serieDelEmisor(clinicId, cajeroA._id, config);
  assert.equal(await svc.reservarSecuencial(serieA, 'factura', config), '000000050');
  assert.equal(await svc.reservarSecuencial(serieA, 'notaCredito', config), '000000007');
});

test('6) serie única de la config: reserva atómica sin duplicados', async () => {
  const { config } = await seed();
  const nums = await Promise.all(Array.from({ length: 15 }, () => config.reserveSequential()));
  assert.equal(new Set(nums).size, 15);
  const fresh = await InvoicingConfig.findById(config._id);
  assert.equal(fresh.secuencial, 65);
  assert.equal(fresh.invoiceCount, 15);
});

test('7) retenciones: las series disponibles incluyen los puntos activos', async () => {
  const { clinicId, config } = await seed();
  await crear(clinicId, { codigo: '002' });
  await crear(clinicId, { establecimiento: '002', codigo: '001' });
  const inactivo = await crear(clinicId, { codigo: '009' });
  await editar(clinicId, inactivo.payload._id, { activo: false });
  const series = await svc.seriesDisponibles(clinicId, config);
  assert.deepEqual(series.map((s) => [s.estab, s.puntosEmision]), [['001', ['002']], ['002', ['001']]]);
});

// ─────────────────────────────────────────────────────────────────────────────
test('8) caja por punto: cada usuario cuadra solo sus ventas; sin punto no abre caja', async () => {
  const { clinicId, cajeroA, cajeroB, admin } = await seed();
  const pA = await crear(clinicId, { codigo: '001', usuario: String(cajeroA._id) });
  await crear(clinicId, { codigo: '002', usuario: String(cajeroB._id) });
  const servicio = (precio) => H.makeProduct(clinicId, { category: 'servicio', salePrice: precio, unlimited: true, taxCategory: 'IVA_0', taxRate: 0, priceIncludesVat: false });
  const prods = { 100: await servicio(100), 40: await servicio(40) };

  const abrir = (u) => H.runController(cashClosing.open, H.mockReq(clinicId, u._id, { openingBalance: 10 }, { role: 'cajero' }));
  assert.equal((await abrir(cajeroA)).statusCode, 201);
  assert.equal((await abrir(cajeroB)).statusCode, 201);
  const sinPunto = await abrir(admin);
  assert.equal(sinPunto.statusCode, 400);
  assert.equal(sinPunto.payload.code, 'SIN_PUNTO_EMISION');

  const vender = (u, monto) => H.runController(sale.createSale, H.mockReq(clinicId, u._id, {
    items: [{ product: prods[monto]._id, quantity: 1, unitPrice: monto }],
    payments: [{ method: 'efectivo', amount: monto }],
  }, { role: 'cajero' }));
  const vA = await vender(cajeroA, 100);
  assert.equal(vA.statusCode, 201, JSON.stringify(vA.payload));
  assert.equal(String((await Sale.findById(vA.payload._id)).puntoEmision), String(pA.payload._id));
  const vB = await vender(cajeroB, 40);
  assert.equal(vB.statusCode, 201, JSON.stringify(vB.payload));

  const actual = async (u) => (await H.runController(cashClosing.current, H.mockReq(clinicId, u._id, {}, { role: 'cajero' }))).payload;
  const cA = await actual(cajeroA);
  const cB = await actual(cajeroB);
  assert.equal(cA.live.totalSales, 100);
  assert.equal(cA.live.expectedCash, 110, 'fondo 10 + 100 propios, sin los 40 de B');
  assert.equal(cB.live.totalSales, 40);
  assert.equal(cB.live.expectedCash, 50);

  // B no puede cerrar la caja de A; A la cierra cuadrada.
  const ajena = await H.runController(cashClosing.close, H.mockReq(clinicId, cajeroB._id, { countedCash: 110 }, { role: 'cajero', params: { id: String(cA.open._id) } }));
  assert.equal(ajena.statusCode, 403);
  const cierre = await H.runController(cashClosing.close, H.mockReq(clinicId, cajeroA._id, { countedCash: 110 }, { role: 'cajero', params: { id: String(cA.open._id) } }));
  assert.equal(cierre.statusCode, 200, JSON.stringify(cierre.payload));
  assert.equal(cierre.payload.difference, 0);

  // Con la caja de B abierta su punto no se puede reasignar.
  const pB = await PuntoEmision.findOne({ clinic: clinicId, codigo: '002' });
  const reasignar = await editar(clinicId, pB._id, { usuario: String(admin._id) });
  assert.equal(reasignar.statusCode, 400);
  assert.match(reasignar.payload.message, /caja abierta/);
});

test('9) el ambiente (pruebas/producción) es del punto de emisión', async () => {
  const { clinicId, config, cajeroA, cajeroB } = await seed();
  await InvoicingConfig.updateOne({ _id: config._id }, { $set: { ambiente: '2' } });
  const cfg = await InvoicingConfig.findById(config._id);

  // Al crear un punto hay que decir el ambiente.
  const sin = await H.runController(ctrl.create, H.mockReq(clinicId, null, { codigo: '003' }));
  assert.equal(sin.statusCode, 400);
  assert.match(sin.payload.message, /Pruebas o de Producción/);
  const malo = await crear(clinicId, { codigo: '003', ambiente: '7' });
  assert.equal(malo.statusCode, 400);

  const a = await crear(clinicId, { codigo: '001', usuario: String(cajeroA._id), ambiente: '1' });
  assert.equal(a.payload.ambiente, '1');
  const serieA = await svc.serieDelEmisor(clinicId, cajeroA._id, cfg);
  assert.equal(serieA.ambiente, '1', 'la caja A factura en pruebas aunque la configuración diga producción');

  // Un punto creado antes del cambio (sin ambiente) sigue con el de la configuración:
  // nadie que facturaba en producción pasa a pruebas sin que lo decidan.
  const viejo = await PuntoEmision.create({ clinic: clinicId, establecimiento: '001', codigo: '002', usuario: cajeroB._id });
  assert.equal(viejo.ambiente, undefined);
  assert.equal((await svc.serieDelEmisor(clinicId, cajeroB._id, cfg)).ambiente, '2');
  const lista = await H.runController(ctrl.list, H.mockReq(clinicId, null));
  const fila = lista.payload.puntos.find((p) => p.codigo === '002');
  assert.equal(fila.ambienteEfectivo, '2');
  assert.equal(fila.ambienteHeredado, true);

  // Editarlo sin tocar el ambiente no lo cambia; escogerlo lo fija.
  await editar(clinicId, viejo._id, { nombre: 'Caja vieja' });
  assert.equal((await PuntoEmision.findById(viejo._id)).ambiente, undefined);
  await editar(clinicId, viejo._id, { ambiente: '1' });
  assert.equal((await svc.serieDelEmisor(clinicId, cajeroB._id, cfg)).ambiente, '1');

  // Retenciones: el ambiente de la serie elegida.
  assert.equal(await svc.ambienteDeSerie(clinicId, '001', '001', cfg), '1');
  assert.equal(await svc.ambienteDeSerie(clinicId, '009', '009', cfg), '2', 'serie sin punto: el de la configuración');
});

test('10) en producción, los números gastados en pruebas no cuentan como emitidos', async () => {
  const { clinicId } = await seed();
  const factura = (secuencial, ambiente) => Invoice.create({
    clinic: clinicId, claveAcceso: `121020260109934041600${ambiente}${secuencial}`.padEnd(49, '7'), secuencial,
    estab: '003', ptoEmi: '001', ambiente, fechaEmision: '12/10/2026', importeTotal: 10,
  });
  await factura('000001388', '2'); // la última de producción (Contífico)
  await factura('000001389', '1'); // una prueba con el número siguiente

  const r = await crear(clinicId, { establecimiento: '003', codigo: '001', ambiente: '1' });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.secuencialFactura, 1390, 'en pruebas sí cuenta la prueba');

  const enPruebas = await editar(clinicId, r.payload._id, { secuencialFactura: 1389 });
  assert.equal(enPruebas.statusCode, 400);
  assert.match(enPruebas.payload.message, /al menos 1390/);

  const prod = await editar(clinicId, r.payload._id, { ambiente: '2', secuencialFactura: 1389 });
  assert.equal(prod.statusCode, 200, JSON.stringify(prod.payload));
  assert.equal(prod.payload.secuencialFactura, 1389);

  const debajo = await editar(clinicId, r.payload._id, { secuencialFactura: 1388 });
  assert.equal(debajo.statusCode, 400);
  assert.match(debajo.payload.message, /003-001-000001388: el próximo número debe ser al menos 1389/);
});
