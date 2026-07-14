/**
 * BLOQUES G, H, I, K · PRESETS, MÉTODOS DE PAGO, REPORTE Y EXCEL DE VENTAS.
 *
 * El bug de fondo: el reporte agrupaba por `Sale.paymentMethod` (un RESUMEN), así que una venta
 * de 100 pagada 40 en efectivo y 60 con tarjeta aparecía como **100 en "mixto"**. La fuente real
 * es `Sale.payments[]`, y la parte a crédito NO es un cobro: es CxC.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const ExcelJS = require('exceljs');
const H = require('./_integrationHelpers');

const ctrl = require('../controllers/salesReportsController');
const sales = require('../controllers/saleController');
const payments = require('../controllers/paymentController');
const svc = require('../services/salesReportService');
const { normalizeSalePayments } = require('../services/salePayments');

const Sale = require('../models/Sale');
const Product = require('../models/Product');
const CreditCard = require('../models/CreditCard');
const BankAccount = require('../models/BankAccount');
const ChartOfAccount = require('../models/ChartOfAccount');
const ServiceCategory = require('../models/ServiceCategory');
const SalesReportPreset = require('../models/SalesReportPreset');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const run = (h, req) => H.runController(h, req);
const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

async function setup() {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const p1 = await H.makeProduct(clinicId, { code: 'S1', name: 'Botox', salePrice: 100, stock: 100 });
  const p2 = await H.makeProduct(clinicId, { code: 'S2', name: 'Limpieza', salePrice: 50, stock: 100 });
  await Product.updateMany({ clinic: clinicId }, { $set: { categoria: 'Estética', taxCategory: 'IVA_0', taxRate: 0, priceIncludesVat: false } });
  const debito = await CreditCard.create({ clinic: clinicId, name: 'Datafast Débito', brand: 'VISA', accountType: 'DEBITO' });
  const credito = await CreditCard.create({ clinic: clinicId, name: 'Datafast Crédito', brand: 'MASTERCARD', accountType: 'CREDITO' });
  return { clinicId, userId, p1, p2, debito, credito };
}

/** Venta real por el controlador (con su asiento, su cartera y sus pagos). */
const vender = (clinicId, userId, body) => run(sales.createSale, H.mockReq(clinicId, userId, {
  clientName: 'Cliente', ...body,
}));
const linea = (p, qty = 1) => ({ product: String(p._id), quantity: qty, unitPrice: p.salePrice });

async function rep(clinicId, userId, query = {}) {
  return ok(await run(ctrl.report, H.mockReq(clinicId, userId, {}, { query })));
}

/** El Excel se ESCRIBE en el response (stream). */
async function excelDe(handler, req) {
  const salida = new PassThrough();
  const chunks = [];
  salida.on('data', (c) => chunks.push(c));
  salida.setHeader = () => {};
  salida.status = () => ({ json: (p) => { throw new Error(`El export falló: ${p.message}`); } });
  const fin = new Promise((r) => salida.on('end', r));
  await handler(req, salida);
  await fin;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.concat(chunks));
  return wb;
}
const filasDe = (ws) => {
  const cab = ws.getRow(1).values;
  const out = [];
  ws.eachRow((row, i) => { if (i > 1) out.push(row); });
  return { col: (h) => cab.indexOf(h), filas: out };
};

// ══════════════════════ BLOQUE H · MÉTODOS DE PAGO ══════════════════════

test('H1) venta solo en efectivo', async () => {
  const { clinicId, userId, p1 } = await setup();
  ok(await vender(clinicId, userId, { items: [linea(p1)], paymentMethod: 'efectivo' }));
  const r = await rep(clinicId, userId);
  assert.equal(r.resumen.porMetodo.efectivo, 100);
  assert.equal(r.resumen.cobrado, 100);
  assert.equal(r.resumen.pendiente, 0);
  assert.equal(r.resumen.cuadra, true);
});

test('H2) tarjeta DÉBITO y tarjeta CRÉDITO se separan por el snapshot de la tarjeta', async () => {
  const { clinicId, userId, p1, p2, debito, credito } = await setup();
  ok(await vender(clinicId, userId, {
    items: [linea(p1)], payments: [{ method: 'tarjeta', amount: 100, creditCard: String(debito._id) }],
  }));
  ok(await vender(clinicId, userId, {
    items: [linea(p2)], payments: [{ method: 'tarjeta', amount: 50, creditCard: String(credito._id) }],
  }));

  const r = await rep(clinicId, userId);
  assert.equal(r.resumen.porMetodo.tarjeta_debito, 100);
  assert.equal(r.resumen.porMetodo.tarjeta_credito, 50);
  assert.equal(r.resumen.porMetodo.tarjeta_sin_tipo, 0);
});

test('H3) cambiar la tarjeta DESPUÉS no altera el reporte histórico (snapshot)', async () => {
  const { clinicId, userId, p1, debito } = await setup();
  ok(await vender(clinicId, userId, {
    items: [linea(p1)], payments: [{ method: 'tarjeta', amount: 100, creditCard: String(debito._id) }],
  }));
  // La tarjeta se reconfigura a CRÉDITO. Lo que se cobró, se cobró como DÉBITO.
  await CreditCard.updateOne({ _id: debito._id }, { $set: { accountType: 'CREDITO' } });

  const r = await rep(clinicId, userId);
  assert.equal(r.resumen.porMetodo.tarjeta_debito, 100, 'el histórico no se mueve');
  assert.equal(r.resumen.porMetodo.tarjeta_credito, 0);
});

test('H4) venta MIXTA: cada método suma lo suyo, nunca el total en "mixto"', async () => {
  const { clinicId, userId, p1, credito } = await setup();
  const v = ok(await vender(clinicId, userId, {
    items: [linea(p1)],
    payments: [
      { method: 'efectivo', amount: 40 },
      { method: 'tarjeta', amount: 60, creditCard: String(credito._id) },
    ],
  }));
  assert.equal(v.paymentMethod, 'mixto', 'el campo resumen sigue diciendo mixto');

  const r = await rep(clinicId, userId);
  assert.equal(r.resumen.porMetodo.efectivo, 40);
  assert.equal(r.resumen.porMetodo.tarjeta_credito, 60);
  assert.equal(r.resumen.cobrado, 100);
  assert.equal(r.resumen.total, 100, 'y NUNCA 100 en efectivo Y 100 en tarjeta');
  assert.equal(r.pagos.length, 2, 'dos filas de pago, una por método');
});

test('H5) crédito parcial: la parte a deber es CxC, no un cobro', async () => {
  const { clinicId, userId, p1 } = await setup();
  ok(await vender(clinicId, userId, {
    items: [linea(p1)],
    payments: [{ method: 'efectivo', amount: 30 }, { method: 'credito', amount: 70 }],
    dueDate: new Date('2026-07-01'),
  }));

  const r = await rep(clinicId, userId);
  assert.equal(r.resumen.cobrado, 30, 'solo lo realmente recibido');
  assert.equal(r.resumen.pendiente, 70, 'y el saldo sale de la CxC');
  assert.equal(r.resumen.porMetodo.credito, 70);
  assert.equal(r.resumen.porMetodo.efectivo, 30);
  assert.equal(r.pagos.length, 1, 'la fila de crédito NO es un pago');
  assert.equal(r.documentos[0].cuadra, true, 'total = cobrado + saldo');
});

test('H6) cobro POSTERIOR de la CxC: entra al reporte con su método y su fecha', async () => {
  const { clinicId, userId, p1 } = await setup();
  const v = ok(await vender(clinicId, userId, {
    items: [linea(p1)],
    payments: [{ method: 'efectivo', amount: 30 }, { method: 'credito', amount: 70 }],
  }));
  const acc = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.03' });
  const bank = await BankAccount.create({
    clinic: clinicId, name: 'Cta', bank: 'Pichincha', accountNumber: '123', chartAccount: acc._id,
  });
  ok(await run(payments.create, H.mockReq(clinicId, userId, {
    type: 'COBRO', method: 'TRANSFERENCIA', partyModel: 'Patient', partyName: 'Cliente',
    date: new Date('2026-06-20'), bankAccount: String(bank._id),
    applications: [{ docModel: 'Sale', docRef: String(v._id), amount: 40 }],
  })));

  const r = await rep(clinicId, userId);
  assert.equal(r.resumen.cobrado, 70, '30 al contado + 40 cobrados después');
  assert.equal(r.resumen.pendiente, 30);
  assert.equal(r.resumen.porMetodo.transferencia, 40, 'el cobro posterior tiene su método real');
  assert.equal(r.documentos[0].cuadra, true);
  const cobro = r.pagos.find((p) => p.origen === 'COBRO_CXC');
  assert.ok(cobro, 'y se ve como cobro de CxC, no como pago de la venta');
});

test('H7) venta LEGACY sin desglose: se deduce del método resumen y se MARCA', async () => {
  const { clinicId, userId, p1 } = await setup();
  // Venta anterior al pago dividido: sin `payments[]`.
  await Sale.create({
    clinic: clinicId, saleNumber: 'V-LEG', clientName: 'Antiguo', paymentMethod: 'tarjeta',
    status: 'completada', subtotal: 100, taxAmount: 0, total: 100, balance: 0, paid: true,
    items: [{ product: p1._id, productName: 'Botox', quantity: 1, unitPrice: 100, subtotal: 100, lineTotal: 100 }],
  });

  const r = await rep(clinicId, userId);
  assert.equal(r.resumen.legacy, 1);
  assert.equal(r.resumen.porMetodo.tarjeta_sin_tipo, 100,
    'no se inventa si fue débito o crédito: no hay evidencia');
  assert.equal(r.resumen.porMetodo.tarjeta_debito, 0);
  assert.ok(r.alertas.some((a) => a.tipo === 'PAGOS_LEGACY'));
  assert.equal(r.pagos[0].legacy, true);
});

test('H8) el normalizador concilia siempre: total = cobrado + saldo', () => {
  const venta = {
    _id: 'x', total: 100, balance: 70, status: 'completada', createdAt: new Date(),
    payments: [{ method: 'efectivo', amount: 30 }, { method: 'credito', amount: 70 }],
  };
  const n = normalizeSalePayments(venta, []);
  assert.equal(n.cobrado, 30);
  assert.equal(n.saldo, 70);
  assert.equal(n.cuadra, true);
  assert.equal(n.rows.filter((r) => !r.esCredito).length, 1);
});

// ══════════════════════ BLOQUE I · REPORTE CONCILIABLE ══════════════════════

test('I1) una venta con VARIAS líneas no duplica el total del documento', async () => {
  const { clinicId, userId, p1, p2 } = await setup();
  ok(await vender(clinicId, userId, { items: [linea(p1, 2), linea(p2, 1)], paymentMethod: 'efectivo' }));

  const r = await rep(clinicId, userId);
  assert.equal(r.documentos.length, 1);
  assert.equal(r.documentos[0].total, 250, '2×100 + 50');
  assert.equal(r.detalle.length, 2, 'dos líneas (la cantidad 2 es UNA línea, no dos filas)');
  assert.equal(r.resumen.total, 250, 'el total general suma la venta UNA vez');
  const sumaLineas = r.detalle.reduce((s, l) => s + l.totalLinea, 0);
  assert.equal(+sumaLineas.toFixed(2), 250, 'Σ líneas = total del documento');
  assert.equal(r.documentos[0].detalleCuadra, true);
});

test('I2) una venta ANULADA se ve pero no suma', async () => {
  const { clinicId, userId, p1 } = await setup();
  const v = ok(await vender(clinicId, userId, { items: [linea(p1)], paymentMethod: 'efectivo' }));
  ok(await run(sales.cancelSale, H.mockReq(clinicId, userId, {}, { params: { id: String(v._id) } })));

  const r = await rep(clinicId, userId);
  assert.equal(r.documentos.length, 1);
  assert.equal(r.documentos[0].estado, 'anulada');
  assert.equal(r.resumen.total, 0, 'no suma al total');
  assert.equal(r.resumen.cobrado, 0);
  assert.equal(r.resumen.anuladas, 1);
});

test('I3) filtros por categoría, método y preset', async () => {
  const { clinicId, userId, p1, p2, debito } = await setup();
  ok(await vender(clinicId, userId, { items: [linea(p1)], payments: [{ method: 'tarjeta', amount: 100, creditCard: String(debito._id) }] }));
  ok(await vender(clinicId, userId, { items: [linea(p2)], paymentMethod: 'efectivo' }));

  // Filtro por método (una venta de tarjeta débito).
  const porMetodo = await rep(clinicId, userId, { method: 'tarjeta_debito' });
  assert.equal(porMetodo.documentos.length, 1);
  assert.equal(porMetodo.resumen.total, 100);

  // Selección por productos.
  const porProducto = await rep(clinicId, userId, { products: String(p2._id) });
  assert.equal(porProducto.documentos.length, 1);
  assert.equal(porProducto.resumen.total, 50);
});

test('I4) dos clínicas: los reportes no se cruzan', async () => {
  const a = await setup();
  const b = await setup();
  ok(await vender(a.clinicId, a.userId, { items: [linea(a.p1)], paymentMethod: 'efectivo' }));
  ok(await vender(b.clinicId, b.userId, { items: [linea(b.p2)], paymentMethod: 'efectivo' }));

  const ra = await rep(a.clinicId, a.userId);
  assert.equal(ra.documentos.length, 1);
  assert.equal(ra.resumen.total, 100, 'la clínica A no ve las ventas de la B');
});

// ══════════════════════ BLOQUE G · PRESETS ══════════════════════

test('G1) preset por categoría, con exclusión e inclusión externa', async () => {
  const { clinicId, userId, p1, p2 } = await setup();
  const extra = await H.makeProduct(clinicId, { code: 'S3', name: 'Masaje', salePrice: 20, stock: 10 });
  await Product.updateOne({ _id: extra._id }, { $set: { taxCategory: 'IVA_0', taxRate: 0, priceIncludesVat: false } });
  const cat = await ServiceCategory.create({
    clinic: clinicId, name: 'Estética', products: [p1._id, p2._id], createdBy: userId,
  });

  // Preset: la categoría entera, MENOS la limpieza, MÁS el masaje (que no está en la categoría).
  const preset = ok(await run(ctrl.createPreset, H.mockReq(clinicId, userId, {
    name: 'Estética sin limpieza',
    includeCategories: [String(cat._id)],
    excludeProducts: [String(p2._id)],
    includeProducts: [String(extra._id)],
  })));

  const seleccion = await svc.resolveSelection(clinicId, { preset: await SalesReportPreset.findById(preset._id).lean() });
  assert.equal(seleccion.length, 2);
  assert.ok(seleccion.includes(String(p1._id)));
  assert.ok(seleccion.includes(String(extra._id)));
  assert.ok(!seleccion.includes(String(p2._id)), 'la exclusión manda sobre la categoría');

  ok(await vender(clinicId, userId, { items: [linea(p1)], paymentMethod: 'efectivo' }));
  ok(await vender(clinicId, userId, { items: [linea(p2)], paymentMethod: 'efectivo' }));
  const r = await rep(clinicId, userId, { preset: String(preset._id) });
  assert.equal(r.documentos.length, 1, 'solo la venta del producto seleccionado');
  assert.equal(r.resumen.total, 100);
  assert.equal(r.preset.name, 'Estética sin limpieza', 'el reporte dice qué preset aplicó');
});

test('G2) nombre duplicado: 409 controlado, nunca un E11000 crudo', async () => {
  const { clinicId, userId } = await setup();
  ok(await run(ctrl.createPreset, H.mockReq(clinicId, userId, { name: 'Mensual' })));
  const r = await run(ctrl.createPreset, H.mockReq(clinicId, userId, { name: '  mensual ' }));
  assert.equal(r.statusCode, 409);
  assert.ok(/Ya existe un preset/i.test(r.payload.message));
  assert.ok(!/E11000/i.test(r.payload.message));
});

test('G3) duplicar un preset genera un nombre libre y conserva la selección', async () => {
  const { clinicId, userId, p1 } = await setup();
  const base = ok(await run(ctrl.createPreset, H.mockReq(clinicId, userId, {
    name: 'Mensual', includeProducts: [String(p1._id)], filters: { method: 'efectivo' },
  })));
  const copia = ok(await run(ctrl.duplicatePreset, H.mockReq(clinicId, userId, {}, { params: { id: String(base._id) } })));
  assert.equal(copia.name, 'Mensual (copia)');
  assert.deepEqual(copia.includeProducts.map(String), [String(p1._id)]);
  assert.equal(copia.filters.method, 'efectivo', 'el preset restaura también los filtros');

  const otra = ok(await run(ctrl.duplicatePreset, H.mockReq(clinicId, userId, {}, { params: { id: String(base._id) } })));
  assert.equal(otra.name, 'Mensual (copia 2)', 'no choca con la copia anterior');
});

test('G4) dos clínicas pueden tener un preset con el mismo nombre', async () => {
  const a = await setup();
  const b = await setup();
  ok(await run(ctrl.createPreset, H.mockReq(a.clinicId, a.userId, { name: 'Mensual' })));
  const r = await run(ctrl.createPreset, H.mockReq(b.clinicId, b.userId, { name: 'Mensual' }));
  assert.equal(r.statusCode, 201);
  const lista = ok(await run(ctrl.listPresets, H.mockReq(a.clinicId, a.userId, {}, { query: {} })));
  assert.equal(lista.length, 1, 'y no se ven entre clínicas');
});

// ══════════════════════ BLOQUE K · EXCEL ══════════════════════

test('K1) el Excel tiene las 4 hojas y CONCILIA con la API', async () => {
  const { clinicId, userId, p1, p2, credito } = await setup();
  ok(await vender(clinicId, userId, {
    items: [linea(p1), linea(p2)],
    payments: [{ method: 'efectivo', amount: 100 }, { method: 'tarjeta', amount: 50, creditCard: String(credito._id) }],
  }));
  ok(await vender(clinicId, userId, {
    items: [linea(p2)],
    payments: [{ method: 'efectivo', amount: 20 }, { method: 'credito', amount: 30 }],
  }));

  const api = await rep(clinicId, userId);
  const wb = await excelDe(ctrl.exportReportExcel, H.mockReq(clinicId, userId, {}, { query: {} }));

  const ventas = filasDe(wb.getWorksheet('Ventas'));
  assert.equal(ventas.filas.length, api.documentos.length);
  const totalExcel = ventas.filas.reduce((s, r) => s + Number(r.getCell(ventas.col('Total')).value || 0), 0);
  assert.equal(+totalExcel.toFixed(2), api.resumen.total, 'Σ Ventas.total = total general');

  const det = filasDe(wb.getWorksheet('Detalle'));
  assert.equal(det.filas.length, api.detalle.length);
  const totalLineas = det.filas.reduce((s, r) => s + Number(r.getCell(det.col('Total línea')).value || 0), 0);
  assert.equal(+totalLineas.toFixed(2), api.resumen.total, 'Σ Detalle.totalLinea = total documental');

  const pg = filasDe(wb.getWorksheet('Pagos'));
  assert.equal(pg.filas.length, api.pagos.length);
  const totalPagos = pg.filas.reduce((s, r) => s + Number(r.getCell(pg.col('Importe')).value || 0), 0);
  assert.equal(+totalPagos.toFixed(2), api.resumen.cobrado, 'Σ Pagos.importe = cobrado');
  assert.equal(+(api.resumen.cobrado + api.resumen.pendiente).toFixed(2), api.resumen.total,
    'cobrado + pendiente = total');

  assert.ok(wb.getWorksheet('Resumen'), 'y existe la hoja de resumen');
});
