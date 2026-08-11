/**
 * DETALLE (drill-down) DE LOS REPORTES GERENCIALES DE VENTAS.
 *
 * El reclamo del usuario: «en ventas por producto sí me sale la información, pero no puedo
 * darle click para ver los detalles de todas las ventas de cada producto, todo con el link
 * de su factura asociada para poder revisar los asientos». Lo mismo en ventas por período,
 * por vendedor, por cajero y en costo por categoría.
 *
 * Lo que se comprueba aquí no es la pantalla, sino lo único que puede volver inútil un
 * drill-down: que el detalle NO sume la fila que se abrió. Si el detalle dijera otra cosa
 * que el total, sería peor que no tenerlo. Además, que cada fila traiga con qué llegar al
 * documento (venta y factura) para poder revisar el asiento.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const ExcelJS = require('exceljs');
const H = require('./_integrationHelpers');

const reports = require('../controllers/accountingReportsController');
const salesCtrl = require('../controllers/saleController');
const salesReports = require('../controllers/salesReportsController');
const legacyReports = require('../controllers/reportController');

const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');
const Product = require('../models/Product');
const User = require('../models/User');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const run = (h, req) => H.runController(h, req);
const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

/** Rango que cubre con holgura las ventas del test (se registran con fecha de hoy). */
const rango = () => {
  const hoy = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const antes = new Date(hoy); antes.setDate(antes.getDate() - 5);
  const despues = new Date(hoy); despues.setDate(despues.getDate() + 5);
  return { startDate: iso(antes), endDate: iso(despues) };
};

async function setup() {
  const { clinicId, userId } = await H.seedClinic();
  const botox = await H.makeProduct(clinicId, {
    code: 'S1', name: 'Botox', salePrice: 100, stock: 500, category: 'servicio',
    unlimited: true, averageCost: 20,
  });
  const limpieza = await H.makeProduct(clinicId, {
    code: 'S2', name: 'Limpieza', salePrice: 50, stock: 500, category: 'insumo',
    averageCost: 10,
  });
  // Sin IVA para que subtotal y total coincidan y las sumas se lean de un vistazo.
  await Product.updateMany({ clinic: clinicId }, { $set: { taxCategory: 'IVA_0', taxRate: 0, priceIncludesVat: false } });
  const otro = await User.create({
    name: 'Vendedora Dos', email: `v2_${Date.now()}@t.com`, password: 'x12345678', role: 'cajero',
  });
  return { clinicId, userId, botox, limpieza, otroId: otro._id };
}

const vender = (clinicId, userId, items, extra = {}) => run(salesCtrl.createSale, H.mockReq(clinicId, userId, {
  clientName: 'Cliente', paymentMethod: 'efectivo', date: H.docDate(), items, ...extra,
}));
const linea = (p, qty = 1) => ({ product: String(p._id), quantity: qty, unitPrice: p.salePrice });

const drill = (clinicId, userId, query) =>
  run(reports.salesDrilldown, H.mockReq(clinicId, userId, {}, { query: { ...rango(), ...query } }));

/** Ejecuta un endpoint .xlsx (escribe en el stream de respuesta) y devuelve el libro. */
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

/* ─────────────────────────────────────────────────────────────────────────── */

test('D1 · Ventas por producto: la fila abre las ventas que la componen y suma exactamente su total', async () => {
  const { clinicId, userId, botox, limpieza } = await setup();
  await vender(clinicId, userId, [linea(botox, 2)]);
  await vender(clinicId, userId, [linea(botox, 1), linea(limpieza, 3)]);
  await vender(clinicId, userId, [linea(limpieza, 1)]);

  const filas = ok(await run(reports.salesByProduct, H.mockReq(clinicId, userId, {}, { query: rango() })));
  const fila = filas.find((f) => f._id?.name === 'Botox');
  assert.ok(fila, 'el reporte por producto debe traer Botox');

  const d = ok(await drill(clinicId, userId, {
    dimension: 'product', key: String(fila._id.product), name: fila._id.name,
  }));

  assert.equal(d.level, 'line');
  assert.equal(d.rows.length, 2, 'Botox se vendió en dos ventas');
  assert.equal(d.totals.cantidad, fila.qty);
  // El detalle NO puede discrepar del total que se abrió: es la razón de ser del drill-down.
  assert.equal(d.totals.subtotal, +fila.subtotal.toFixed(2));
  // Y trae con qué llegar al documento (la venta) para revisar su asiento.
  assert.ok(d.rows.every((r) => r.saleId && r.venta), 'cada fila debe identificar su venta');
  assert.ok(d.rows.every((r) => r.producto === 'Botox'));
});

test('D2 · Ventas por período: el detalle del mes suma la fila del mes', async () => {
  const { clinicId, userId, botox, limpieza } = await setup();
  await vender(clinicId, userId, [linea(botox, 1)]);
  await vender(clinicId, userId, [linea(limpieza, 2)]);

  const q = { ...rango(), granularity: 'month' };
  const filas = ok(await run(reports.salesByPeriod, H.mockReq(clinicId, userId, {}, { query: q })));
  assert.equal(filas.length, 1, 'las ventas del test caen todas en el mismo mes');

  const d = ok(await drill(clinicId, userId, { dimension: 'period', key: filas[0]._id, granularity: 'month' }));
  assert.equal(d.level, 'sale', 'por período el detalle es una fila por VENTA');
  assert.equal(d.rows.length, filas[0].count);
  assert.equal(d.totals.total, +filas[0].total.toFixed(2));
});

test('D3 · Ventas por vendedor / cajero: solo salen las ventas de esa persona', async () => {
  const { clinicId, userId, botox, otroId } = await setup();
  await vender(clinicId, userId, [linea(botox, 1)]);
  await vender(clinicId, otroId, [linea(botox, 2)]);

  const porVendedor = ok(await run(reports.salesBySeller, H.mockReq(clinicId, userId, {}, { query: rango() })));
  const fila = porVendedor.find((f) => String(f._id?._id) === String(otroId));
  assert.ok(fila, 'el reporte debe traer a la segunda vendedora');

  const d = ok(await drill(clinicId, userId, { dimension: 'seller', key: String(otroId) }));
  assert.equal(d.rows.length, fila.count);
  assert.equal(d.totals.total, +fila.total.toFixed(2));
  assert.equal(d.totals.total, 200, 'dos botox a 100');

  // Y el cajero: las ventas del test no fijan cajero, así que la fila «sin asignar» las trae todas.
  const sinCajero = ok(await drill(clinicId, userId, { dimension: 'cashier', key: '' }));
  assert.equal(sinCajero.rows.length, 2);
});

test('D4 · Costo por categoría: el detalle es línea a línea, con su costo y su utilidad', async () => {
  const { clinicId, userId, botox, limpieza } = await setup();
  await vender(clinicId, userId, [linea(botox, 1), linea(limpieza, 2)]);

  const r = ok(await run(reports.costOfSalesByCategory, H.mockReq(clinicId, userId, {}, { query: rango() })));
  const fila = r.rows.find((f) => f.category === 'servicio');
  assert.ok(fila, 'debe existir la categoría del servicio vendido');

  const d = ok(await drill(clinicId, userId, { dimension: 'category', key: 'servicio' }));
  assert.equal(d.level, 'line');
  assert.equal(d.totals.subtotal, +fila.revenue.toFixed(2));
  assert.equal(d.totals.costo, +fila.cost.toFixed(2));
  assert.equal(d.totals.utilidad, +fila.grossProfit.toFixed(2));
});

test('D5 · Cada fila trae su factura (link al documento) y una dimensión inventada se rechaza', async () => {
  const { clinicId, userId, botox } = await setup();
  const venta = ok(await vender(clinicId, userId, [linea(botox, 1)]));
  const sale = await Sale.findById(venta._id);
  const factura = await Invoice.create({
    clinic: clinicId, sale: sale._id, numero: '001-001-000000123', estado: 'AUTORIZADO',
    claveAcceso: `CLV${Date.now()}${Math.random().toString().slice(2, 8)}`,
    estab: '001', ptoEmi: '001', secuencial: '000000123', ambiente: '1',
    fechaEmision: new Date().toLocaleDateString('es-EC').split('/').map((x) => x.padStart(2, '0')).join('/'),
    tipoIdentificacionComprador: '07', identificacionComprador: '9999999999',
    razonSocialComprador: 'Cliente',
    totalSinImpuestos: sale.subtotal, totalImpuesto: sale.taxAmount || 0, importeTotal: sale.total,
  });

  const d = ok(await drill(clinicId, userId, { dimension: 'seller', key: String(userId) }));
  assert.equal(String(d.rows[0].invoiceId), String(factura._id));
  assert.equal(d.rows[0].factura, '001-001-000000123');

  const malo = await drill(clinicId, userId, { dimension: 'inventada', key: 'x' });
  assert.equal(malo.statusCode, 400);
});

test('D6 · El Excel del detalle sale del MISMO controlador que la pantalla', async () => {
  const { clinicId, userId, botox } = await setup();
  await vender(clinicId, userId, [linea(botox, 2)]);
  await vender(clinicId, userId, [linea(botox, 1)]);

  const query = { ...rango(), dimension: 'product', key: String(botox._id), name: 'Botox' };
  const pantalla = ok(await drill(clinicId, userId, { dimension: 'product', key: String(botox._id), name: 'Botox' }));
  const wb = await excelDe(reports.salesDrilldownExcel, H.mockReq(clinicId, userId, {}, { query }));
  const ws = wb.worksheets[0];

  // Cabecera de contexto (4 líneas + blanco) + encabezado + una fila por línea + totales.
  const textos = [];
  ws.eachRow((row) => row.eachCell((c) => textos.push(String(c.value ?? ''))));
  assert.ok(textos.includes('Producto / servicio'), 'el detalle por producto lleva la columna del producto');
  assert.equal(
    textos.filter((t) => pantalla.rows.some((r) => t === r.venta)).length,
    pantalla.rows.length,
    'el Excel trae las mismas ventas que la pantalla',
  );
});

test('D7 · Reportes de Ventas descarga el MISMO Excel que la pantalla de Ventas', async () => {
  const { clinicId, userId, botox, limpieza } = await setup();
  await vender(clinicId, userId, [linea(botox, 1)]);
  await vender(clinicId, userId, [linea(limpieza, 2)]);

  const query = rango();
  const desdeVentas = await excelDe(legacyReports.exportSales, H.mockReq(clinicId, userId, {}, { query }));
  const desdeReporte = await excelDe(salesReports.exportSalesSheetExcel, H.mockReq(clinicId, userId, {}, { query }));

  const plano = (wb) => {
    const out = [];
    wb.worksheets[0].eachRow((row) => out.push(row.values.map((v) => String(v ?? ''))));
    return out;
  };
  const a = plano(desdeVentas);
  const b = plano(desdeReporte);

  assert.deepEqual(b[0], a[0], 'las columnas deben ser idénticas (mismo formato para el contador)');
  assert.equal(b.length, a.length, 'y las mismas ventas');
  assert.ok(a[0].includes('Tarjeta crédito') && a[0].includes('Crédito (CxC)'),
    'es la planilla desglosada por forma de pago, no otra');

  // El filtro por producto del reporte SÍ acota la planilla (es lo que se está mirando).
  const soloBotox = await excelDe(salesReports.exportSalesSheetExcel,
    H.mockReq(clinicId, userId, {}, { query: { ...query, products: String(botox._id) } }));
  assert.equal(plano(soloBotox).length, 2, 'cabecera + la única venta con Botox');
});
