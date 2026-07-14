/**
 * FASE 2 · PENDIENTES FINALES
 *
 *   BLOQUE 1 · Resolución COMPARTIDA de las CxC duplicadas entre una venta y su factura:
 *              una obligación económica aparece UNA vez en el flujo, en la antigüedad de
 *              cartera y en su exportación, con el MISMO saldo, y los casos que no concilian
 *              se avisan en vez de ocultarse.
 *   BLOQUE 2 · Liquidación de partidas manuales (API que usa la nueva interfaz).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const H = require('./_integrationHelpers');

const svc = require('../services/cashFlowService');
const ctrl = require('../controllers/cashFlowController');
const reports = require('../controllers/accountingReportsController');
const payments = require('../controllers/paymentController');
const {
  resolveReceivableEconomicObligations, canonicalReceivableTarget,
} = require('../services/receivableObligations');

const ChartOfAccount = require('../models/ChartOfAccount');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const JournalEntry = require('../models/JournalEntry');
const CashFlowManualItem = require('../models/CashFlowManualItem');
const Receivable = require('../models/Receivable');
const Invoice = require('../models/Invoice');
const Sale = require('../models/Sale');
const Payment = require('../models/Payment');
const { createEntry } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const { openReceivable } = require('../utils/subledger');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const run = (h, req) => H.runController(h, req);
const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

const HOY = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
const dia = (n) => { const d = new Date(HOY); d.setDate(d.getDate() + n); return d; };
const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const habil = (d) => { const x = new Date(d); while (x.getDay() === 0) x.setDate(x.getDate() + 1); return x; };
const proj = (clinicId, from, to) => svc.buildProjection(clinicId, { from: from || HOY, to: to || dia(30) });
const dayOf = (data, d) => data.days.find((x) => x.date === key(habil(d)));
const celda = (data, d, dir, cat) => dayOf(data, d)?.categorias?.[dir]?.[cat]?.total || 0;
const cuenta = (clinicId, code) => ChartOfAccount.findOne({ clinic: clinicId, code });

let seq = 0;
/**
 * Venta a crédito FACTURADA (vínculo real `Sale.invoice`) con las carteras que se le indiquen.
 * Reproduce el histórico: `migrateCarteraToSubledger` abría las dos.
 */
async function parFacturado(clinicId, {
  total = 400, totalFactura = null,
  cxcVenta = true, cxcFactura = true,
  appliedVenta = 0, appliedFactura = 0,
  saleBalance = null,
} = {}) {
  seq += 1;
  const inv = await Invoice.create({
    clinic: clinicId, claveAcceso: `CLV${Date.now()}${seq}`, secuencial: String(700 + seq).padStart(9, '0'),
    estab: '001', ptoEmi: '001', ambiente: '1', estado: 'AUTORIZADO', fechaEmision: '01/01/2026',
    tipoIdentificacionComprador: '05', identificacionComprador: '0912345678',
    razonSocialComprador: 'Cliente F', totalSinImpuestos: total, totalImpuesto: 0,
    importeTotal: totalFactura ?? total, balance: (totalFactura ?? total) - appliedFactura,
  });
  const sale = await Sale.create({
    clinic: clinicId, saleNumber: `V-${1000 + seq}`, clientName: 'Cliente F',
    paymentMethod: 'credito', status: 'completada',
    subtotal: total, taxAmount: 0, total, balance: saleBalance ?? (total - appliedVenta),
    invoice: inv._id, items: [],
  });
  const cli = await getAccount(clinicId, 'clientes');
  const comun = { clinic: clinicId, party: { model: 'Patient', ref: null, name: 'Cliente F' }, account: cli._id, issueDate: dia(-3), dueDate: dia(6) };
  if (cxcVenta) {
    await openReceivable({
      ...comun, sourceModel: 'Sale', sourceRef: sale._id, docType: 'VENTA',
      number: sale.saleNumber, total, applied: appliedVenta,
    });
  }
  if (cxcFactura) {
    await openReceivable({
      ...comun, sourceModel: 'Invoice', sourceRef: inv._id, docType: 'FACTURA',
      number: inv.secuencial, total: totalFactura ?? total, applied: appliedFactura,
    });
  }
  return { sale, inv };
}

/** Cobro histórico ya aplicado (sin pasar por el controlador): así llegan los datos migrados. */
async function cobroHistorico(clinicId, apps, { status = 'REGISTRADO', total = null } = {}) {
  seq += 1;
  return Payment.create({
    clinic: clinicId, type: 'COBRO', number: `CB-H-${seq}`, date: dia(-2),
    partyModel: 'Patient', partyName: 'Cliente F', method: 'EFECTIVO',
    total: total ?? apps.reduce((s, a) => s + a.amount, 0),
    applications: apps, appliedAmount: apps.reduce((s, a) => s + a.amount, 0), status,
  });
}

const obligacionDe = async (clinicId) => (await resolveReceivableEconomicObligations({ clinicId })).obligations[0];
const aging = async (clinicId, userId) => ok(await run(reports.accountsReceivableAging, H.mockReq(clinicId, userId, {}, { query: {} })));

/** El Excel de cartera se ESCRIBE en el response (stream), no se envía como buffer. */
async function excelDe(handler, req) {
  const { PassThrough } = require('node:stream');
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

/** Filas de DATOS del Excel de cartera (las de resumen van después de una fila en blanco). */
function hojaAging(wb) {
  const ws = wb.getWorksheet('Cuentas por cobrar');
  const cabecera = ws.getRow(1).values;
  const col = (h) => cabecera.indexOf(h);
  const filas = [];
  const resumen = [];
  let enResumen = false;
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const tipo = row.getCell(col('Tipo documento')).value;
    if (!tipo) enResumen = true;
    (enResumen ? resumen : filas).push(row);
  });
  return { ws, col, filas, resumen };
}

// ═══════════════════ BLOQUE 1 · OBLIGACIONES ECONÓMICAS POR COBRAR ═══════════════════

test('1) venta con factura y dos CxC sin pagos: SAFE_DUPLICATE, canónica la venta, se cuenta una vez', async () => {
  const { clinicId } = await H.seedClinic({ date: dia(-5) });
  const { sale } = await parFacturado(clinicId, { total: 400 });

  const o = await obligacionDe(clinicId);
  assert.equal(o.resolution, 'SAFE_DUPLICATE');
  assert.equal(o.canonical.sourceModel, 'Sale');
  assert.equal(String(o.canonical.sourceRef), String(sale._id));
  assert.equal(o.balance, 400);
  assert.equal(o.autoFixable, true, 'sin actividad: consolidable automáticamente');

  const data = await proj(clinicId, HOY, dia(20));
  assert.equal(celda(data, dia(6), 'INGRESO', 'CLIENTES'), 400, 'una obligación = un importe');
});

test('2) cobro solo en la CxC de la VENTA: DIVERGENT resoluble, manda la venta', async () => {
  const { clinicId } = await H.seedClinic({ date: dia(-5) });
  const { sale } = await parFacturado(clinicId, { total: 400, appliedVenta: 150 });
  await cobroHistorico(clinicId, [{ docModel: 'Sale', docRef: sale._id, amount: 150 }]);

  const o = await obligacionDe(clinicId);
  assert.equal(o.resolution, 'DIVERGENT_BUT_RESOLVABLE');
  assert.equal(o.canonical.sourceModel, 'Sale');
  assert.equal(o.applied, 150);
  assert.equal(o.balance, 250);

  const data = await proj(clinicId, HOY, dia(20));
  assert.equal(celda(data, dia(6), 'INGRESO', 'CLIENTES'), 250);
});

test('3) cobro solo en la CxC de la FACTURA: manda la FACTURA (no siempre la venta)', async () => {
  const { clinicId } = await H.seedClinic({ date: dia(-5) });
  const { inv } = await parFacturado(clinicId, { total: 400, appliedFactura: 300, saleBalance: 400 });
  await cobroHistorico(clinicId, [{ docModel: 'Invoice', docRef: inv._id, amount: 300 }]);

  const o = await obligacionDe(clinicId);
  assert.equal(o.resolution, 'DIVERGENT_BUT_RESOLVABLE');
  assert.equal(o.canonical.sourceModel, 'Invoice', 'la actividad real está en la factura');
  assert.equal(o.balance, 100);

  const data = await proj(clinicId, HOY, dia(20));
  assert.equal(celda(data, dia(6), 'INGRESO', 'CLIENTES'), 100, 'no se proyecta el saldo de la venta sin actualizar');
  const dup = data.detalle.find((x) => x.duplicada);
  assert.equal(dup.sourceModel, 'Sale', 'la que sobra es la de la venta, no la de la factura');
});

test('4) cobro parcial en la factura y la venta sin actualizar: saldo económico correcto', async () => {
  const { clinicId } = await H.seedClinic({ date: dia(-5) });
  const { inv } = await parFacturado(clinicId, { total: 1000, appliedFactura: 400, saleBalance: 1000 });
  await cobroHistorico(clinicId, [{ docModel: 'Invoice', docRef: inv._id, amount: 400 }]);

  const o = await obligacionDe(clinicId);
  assert.equal(o.balance, 600, '1000 − 400: la venta desactualizada no manda');
  assert.equal(o.venta.balance, 1000, 'el documento de la venta se conserva tal cual (no se toca)');

  const data = await proj(clinicId, HOY, dia(20));
  assert.equal(data.totales.ingresos, 600);
});

test('5) el MISMO cobro reflejado en las dos CxC se cuenta una sola vez', async () => {
  const { clinicId } = await H.seedClinic({ date: dia(-5) });
  const { sale, inv } = await parFacturado(clinicId, { total: 400, appliedVenta: 100, appliedFactura: 100 });
  await cobroHistorico(clinicId, [
    { docModel: 'Sale', docRef: sale._id, amount: 100 },
    { docModel: 'Invoice', docRef: inv._id, amount: 100 },
  ], { total: 100 });

  const o = await obligacionDe(clinicId);
  assert.equal(o.resolution, 'SAFE_DUPLICATE', 'las dos reflejan el mismo cobro: es demostrable');
  assert.equal(o.cobrosUnicos, 100, 'un cobro, no dos');
  assert.equal(o.balance, 300);
  assert.equal(o.cobros[0].enAmbas, true);
});

test('6) cobros REALES distintos en cada CxC: AMBIGUOUS, no se consolida solo', async () => {
  const { clinicId } = await H.seedClinic({ date: dia(-5) });
  const { sale, inv } = await parFacturado(clinicId, { total: 1000, appliedVenta: 100, appliedFactura: 200 });
  await cobroHistorico(clinicId, [{ docModel: 'Sale', docRef: sale._id, amount: 100 }]);
  await cobroHistorico(clinicId, [{ docModel: 'Invoice', docRef: inv._id, amount: 200 }]);

  const o = await obligacionDe(clinicId);
  assert.equal(o.resolution, 'AMBIGUOUS');
  assert.equal(o.autoFixable, false, 'consolidación automática BLOQUEADA');
  assert.equal(o.cobrosUnicos, 300, 'son dos cobros distintos: suman');
  assert.equal(o.balance, 700, 'política conservadora: el mayor cobro demostrable');
  assert.ok(o.reason.includes('aplicaciones distintas'));

  const data = await proj(clinicId, HOY, dia(20));
  const alerta = data.alertas.find((a) => a.tipo === 'CXC_DUPLICADA_AMBIGUA');
  assert.ok(alerta, 'se avisa');
  assert.ok(alerta.documentos[0].vinculos.venta.id, 'y se muestran las DOS referencias');
  assert.ok(alerta.documentos[0].vinculos.factura.id);
  assert.ok(alerta.documentos[0].motivo, 'con el motivo por el que no pudo resolverse');
});

test('7) anulación reflejada en una sola cartera: AMBIGUOUS (no se inventa la conciliación)', async () => {
  const { clinicId } = await H.seedClinic({ date: dia(-5) });
  // El cobro se anuló, pero la reversión solo llegó a la CxC de la venta: la de la factura
  // sigue con los 100 aplicados. Nadie puede afirmar cuál dice la verdad.
  const { sale, inv } = await parFacturado(clinicId, { total: 400, appliedVenta: 0, appliedFactura: 100 });
  await cobroHistorico(clinicId, [
    { docModel: 'Sale', docRef: sale._id, amount: 100 },
    { docModel: 'Invoice', docRef: inv._id, amount: 100 },
  ], { status: 'ANULADO', total: 100 });

  const o = await obligacionDe(clinicId);
  assert.equal(o.resolution, 'AMBIGUOUS');
  assert.equal(o.cobrosUnicos, 0, 'el cobro está anulado: no hay cobros vigentes');
  assert.equal(o.anulaciones.length, 1);
  assert.equal(o.balance, 300, 'conservador: se descuenta el mayor cobro demostrable (100)');
  assert.equal(await Receivable.countDocuments({ clinic: clinicId }), 2, 'no se toca ninguna aplicación histórica');
});

test('8) importes originales que no concilian: AMBIGUOUS y saldo conservador', async () => {
  const { clinicId } = await H.seedClinic({ date: dia(-5) });
  await parFacturado(clinicId, { total: 400, totalFactura: 350 });

  const o = await obligacionDe(clinicId);
  assert.equal(o.resolution, 'AMBIGUOUS');
  assert.ok(o.reason.includes('no concilian'));
  assert.equal(o.total, 350, 'el menor de los dos: nunca se sobrestima la cartera');
  assert.equal(o.balance, 350);
});

test('9) dos documentos iguales SIN vínculo: no se deduplican', async () => {
  const { clinicId } = await H.seedClinic({ date: dia(-5) });
  const cli = await getAccount(clinicId, 'clientes');
  // Venta sin factura + factura suelta, mismo cliente, mismo importe, misma fecha.
  const sale = await Sale.create({
    clinic: clinicId, saleNumber: 'V-SOLA', clientName: 'Cliente F', paymentMethod: 'credito',
    status: 'completada', subtotal: 250, taxAmount: 0, total: 250, balance: 250, items: [],
  });
  await openReceivable({
    clinic: clinicId, party: { model: 'Patient', ref: null, name: 'Cliente F' },
    sourceModel: 'Sale', sourceRef: sale._id, docType: 'VENTA', number: 'V-SOLA',
    issueDate: dia(-3), dueDate: dia(6), total: 250, account: cli._id,
  });
  const inv = await Invoice.create({
    clinic: clinicId, claveAcceso: `CLV-SUELTA-${Date.now()}`, secuencial: '000000999',
    estab: '001', ptoEmi: '001', ambiente: '1', estado: 'AUTORIZADO', fechaEmision: '01/01/2026',
    tipoIdentificacionComprador: '05', identificacionComprador: '0912345678',
    razonSocialComprador: 'Cliente F', totalSinImpuestos: 250, totalImpuesto: 0, importeTotal: 250, balance: 250,
  });
  await openReceivable({
    clinic: clinicId, party: { model: 'Patient', ref: null, name: 'Cliente F' },
    sourceModel: 'Invoice', sourceRef: inv._id, docType: 'FACTURA', number: '000000999',
    issueDate: dia(-3), dueDate: dia(6), total: 250, account: cli._id,
  });

  const res = await resolveReceivableEconomicObligations({ clinicId });
  assert.equal(res.obligations.length, 0, 'sin `Sale.invoice` no hay identidad económica');

  const data = await proj(clinicId, HOY, dia(20));
  assert.equal(celda(data, dia(6), 'INGRESO', 'CLIENTES'), 500, 'son dos obligaciones distintas: suman las dos');
  assert.equal(data.detalle.filter((x) => x.duplicada).length, 0);
});

test('10) el flujo y la antigüedad de cartera muestran el MISMO saldo para la obligación', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const { inv } = await parFacturado(clinicId, { total: 1000, appliedFactura: 400, saleBalance: 1000 });
  await cobroHistorico(clinicId, [{ docModel: 'Invoice', docRef: inv._id, amount: 400 }]);

  const data = await proj(clinicId, HOY, dia(20));
  const ar = await aging(clinicId, userId);

  assert.equal(ar.rows.length, 1, 'una obligación económica = una fila (no la venta Y la factura)');
  assert.equal(ar.rows[0].type, 'Venta + Factura');
  assert.equal(ar.rows[0].balance, 600);
  assert.equal(data.totales.ingresos, 600, 'el mismo saldo que proyecta el flujo');
  assert.ok(ar.rows[0].links.sale && ar.rows[0].links.invoice, 'con los vínculos a los dos documentos');
  assert.equal(ar.rows[0].resolution, 'DIVERGENT_BUT_RESOLVABLE', 'y el estado de resolución');
});

test('11) los totales por rango de edad de la antigüedad concilian con el detalle', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  await parFacturado(clinicId, { total: 400 });                       // par (una fila)
  await parFacturado(clinicId, { total: 900, appliedVenta: 300 });    // par con cobro
  const sale = await Sale.create({                                    // venta suelta
    clinic: clinicId, saleNumber: 'V-X', clientName: 'Otro', paymentMethod: 'credito',
    status: 'completada', subtotal: 50, taxAmount: 0, total: 50, balance: 50, items: [],
  });
  assert.ok(sale._id);

  const ar = await aging(clinicId, userId);
  const suma = ar.rows.reduce((s, r) => s + r.balance, 0);
  assert.equal(+suma.toFixed(2), +ar.totals.total.toFixed(2), 'total = suma del detalle');
  const porBucket = ar.rows.reduce((acc, r) => { acc[r.bucket] = (acc[r.bucket] || 0) + r.balance; return acc; }, {});
  for (const k of Object.keys(porBucket)) {
    assert.equal(+porBucket[k].toFixed(2), +ar.totals[k].toFixed(2), `el rango ${k} concilia`);
  }
  assert.equal(ar.rows.length, 3, 'dos obligaciones venta+factura y una venta suelta');
  assert.equal(+ar.totals.total.toFixed(2), 400 + 600 + 50);
});

test('12) la exportación de la antigüedad usa el mismo resolver que la API', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const { inv } = await parFacturado(clinicId, { total: 1000, appliedFactura: 400, saleBalance: 1000 });
  await cobroHistorico(clinicId, [{ docModel: 'Invoice', docRef: inv._id, amount: 400 }]);

  const ar = await aging(clinicId, userId);
  const wb = await excelDe(reports.arAgingExcel, H.mockReq(clinicId, userId, {}, { query: {} }));
  const ws = wb.getWorksheet('Cuentas por cobrar');

  const { filas, col } = hojaAging(wb);
  assert.equal(filas.length, ar.rows.length, 'el Excel tiene exactamente las filas de la API');
  const sumaExcel = filas.reduce((s, r) => s + Number(r.getCell(col('Total')).value || 0), 0);
  assert.equal(+sumaExcel.toFixed(2), +ar.totals.total.toFixed(2), 'y los mismos saldos');
  assert.equal(+sumaExcel.toFixed(2), 600);
  assert.equal(filas[0].getCell(col('Resolución')).value, 'DIVERGENT_BUT_RESOLVABLE',
    'la exportación expone el estado de resolución');
});

test('13) la venta facturada no genera una SEGUNDA CxC (ni al migrar la cartera)', async () => {
  const { clinicId } = await H.seedClinic({ date: dia(-5) });
  // Venta a crédito con su cartera + factura enlazada, como las crea el sistema vivo.
  const { inv } = await parFacturado(clinicId, { total: 500, cxcFactura: false });
  assert.equal(await Receivable.countDocuments({ clinic: clinicId }), 1);

  const { migrate } = require('../scripts/migrateCarteraToSubledger');
  const rep = await migrate({ commit: true, clinic: clinicId });
  assert.equal(rep.saltadas, 1, 'la factura de la venta se salta explícitamente');

  assert.equal(await Receivable.countDocuments({ clinic: clinicId, sourceModel: 'Invoice', sourceRef: inv._id }), 0,
    'la migración ya no abre cartera para la factura de una venta que ya la tiene');
  const data = await proj(clinicId, HOY, dia(20));
  assert.equal(data.totales.ingresos, 500, 'y la obligación sigue contándose una sola vez');
});

test('14) cobrar DESDE la factura aplica sobre la obligación canónica (la venta)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const { sale, inv } = await parFacturado(clinicId, { total: 400, cxcFactura: false });

  const destino = await canonicalReceivableTarget({ clinicId, sourceModel: 'Invoice', sourceRef: inv._id });
  assert.equal(destino.sourceModel, 'Sale');
  assert.equal(destino.redirected, true);

  ok(await run(payments.create, H.mockReq(clinicId, userId, {
    type: 'COBRO', method: 'EFECTIVO', partyModel: 'Patient', partyName: 'Cliente F',
    date: HOY, applications: [{ docModel: 'Invoice', docRef: inv._id, amount: 150 }],
  })));

  const cxcVenta = await Receivable.findOne({ clinic: clinicId, sourceModel: 'Sale', sourceRef: sale._id });
  assert.equal(cxcVenta.applied, 150, 'el cobro redujo la cartera canónica');
  assert.equal(cxcVenta.balance, 250);
  assert.equal(await Receivable.countDocuments({ clinic: clinicId, sourceModel: 'Invoice' }), 0,
    'y NO se abrió una segunda cartera para la factura');
  assert.equal((await Sale.findById(sale._id)).balance, 250, 'los dos documentos de la obligación no divergen');
  assert.equal((await Invoice.findById(inv._id)).balance, 250);

  // Y el flujo proyecta el resto UNA vez (el cobro ya realizado entra aparte, como movimiento real).
  const data = await proj(clinicId, HOY, dia(20));
  const cxc = data.detalle.filter((x) => x.docModel === 'Receivable' && !x.duplicada);
  assert.equal(cxc.length, 1);
  assert.equal(cxc[0].saldo, 250);
});

test('15) anular ese cobro restaura la MISMA obligación', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const { sale, inv } = await parFacturado(clinicId, { total: 400, cxcFactura: false });
  const pago = ok(await run(payments.create, H.mockReq(clinicId, userId, {
    type: 'COBRO', method: 'EFECTIVO', partyModel: 'Patient', partyName: 'Cliente F',
    date: HOY, applications: [{ docModel: 'Invoice', docRef: inv._id, amount: 150 }],
  })));
  assert.equal(pago.applications[0].appliedTo.sourceModel, 'Sale', 'se recuerda dónde se aplicó');

  ok(await run(payments.void, H.mockReq(clinicId, userId, {}, { params: { id: pago._id } })));

  const cxcVenta = await Receivable.findOne({ clinic: clinicId, sourceModel: 'Sale', sourceRef: sale._id });
  assert.equal(cxcVenta.applied, 0, 'el saldo vuelve a la cartera canónica, no a otra');
  assert.equal(cxcVenta.balance, 400);
  assert.equal((await Sale.findById(sale._id)).balance, 400);
  assert.equal((await Invoice.findById(inv._id)).balance, 400);

  const data = await proj(clinicId, HOY, dia(20));
  const cxc = data.detalle.filter((x) => x.docModel === 'Receivable' && !x.duplicada);
  assert.equal(cxc.length, 1);
  assert.equal(cxc[0].saldo, 400, 'la obligación completa vuelve al flujo');
});

test('16) dos clínicas: la resolución no cruza obligaciones', async () => {
  const a = await H.seedClinic({ date: dia(-5) });
  const b = await H.seedClinic({ date: dia(-5) });
  await parFacturado(a.clinicId, { total: 400 });
  await parFacturado(b.clinicId, { total: 900 });

  const ra = await resolveReceivableEconomicObligations({ clinicId: a.clinicId });
  const rb = await resolveReceivableEconomicObligations({ clinicId: b.clinicId });
  assert.equal(ra.obligations.length, 1);
  assert.equal(rb.obligations.length, 1);
  assert.equal(ra.obligations[0].total, 400);
  assert.equal(rb.obligations[0].total, 900);

  const agA = await aging(a.clinicId, a.userId);
  assert.equal(agA.rows.length, 1);
  assert.equal(agA.totals.total, 400, 'la clínica A no ve nada de la B');
});

// ═══════════════════ BLOQUE 2 · LIQUIDAR PARTIDAS MANUALES ═══════════════════

async function banco(clinicId, code = '1.1.01.03') {
  const acc = await cuenta(clinicId, code);
  return BankAccount.create({
    clinic: clinicId, name: `Cta ${code}`, bank: 'Pichincha',
    accountNumber: String(Math.random()).slice(2, 8), chartAccount: acc._id,
  });
}
async function partida(clinicId, userId, extra = {}) {
  return ok(await run(ctrl.createManualItem, H.mockReq(clinicId, userId, {
    direction: 'EGRESO', category: 'GASTOS_FIJOS', description: 'Arriendo del local',
    amount: 800, plannedDate: key(dia(3)), ...extra,
  })));
}
const settle = (clinicId, userId, id, body, idemKey) => run(
  ctrl.settleManualItem,
  H.mockReq(clinicId, userId, body, { params: { id }, headers: idemKey ? { 'idempotency-key': idemKey } : {} })
);

test('B2·1) el detalle de la celda trae la partida planificada con su estado (la UI ofrece liquidarla)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const p = await partida(clinicId, userId);
  const det = ok(await run(ctrl.cellDetail, H.mockReq(clinicId, userId, {}, {
    query: {
      from: key(HOY), to: key(dia(20)), date: key(habil(dia(3))),
      direction: 'EGRESO', category: 'GASTOS_FIJOS',
    },
  })));
  const fila = det.rows.find((r) => r.id === String(p._id));
  assert.ok(fila, 'la previsión aparece en la celda');
  assert.equal(fila.docModel, 'CashFlowManualItem');
  assert.equal(fila.estado, 'PLANIFICADO', 'con su estado explícito, no solo por color');
});

test('B2·2) CREAR un egreso real: asiento cuadrado, movimiento bancario y estado al final', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const p = await partida(clinicId, userId);
  const bank = await banco(clinicId);
  const gasto = await cuenta(clinicId, '6.1.99');

  const r = ok(await settle(clinicId, userId, p._id, {
    mode: 'CREAR', date: key(HOY), amount: 800,
    bankAccountId: bank._id, counterAccountId: gasto._id, method: 'TRANSFERENCIA', reference: 'TR-1',
  }, 'liq-1'));
  assert.equal(r.status, 'REALIZADO');
  assert.ok(r.journalEntry, 'devuelve el asiento para poder abrirlo');

  const asiento = await JournalEntry.findById(r.journalEntry);
  assert.equal(asiento.totalDebit, asiento.totalCredit, 'asiento cuadrado');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced, 'y el mayor sigue cuadrado');
  assert.equal(asiento.sourceModel, 'CashFlowManualItem');
  const tx = await BankTransaction.findOne({ clinic: clinicId, sourceRef: p._id });
  assert.equal(tx.amount, 800);
  assert.equal(tx.direction, -1);

  // La previsión deja de proyectarse (el movimiento real ocupa su lugar) sin perder historia.
  const data = await proj(clinicId, HOY, dia(20));
  assert.equal(celda(data, dia(3), 'EGRESO', 'GASTOS_FIJOS'), 0);
  assert.equal((await CashFlowManualItem.findById(p._id)).settledByModel, 'BankTransaction');
});

test('B2·3) CREAR un ingreso real: el asiento debita la liquidez', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const p = await partida(clinicId, userId, {
    direction: 'INGRESO', category: 'PRESTAMOS_RECIBIDOS', description: 'Préstamo bancario',
    amount: 5000, origin: 'PRESTAMO',
  });
  const bank = await banco(clinicId);
  const prestamo = await getAccount(clinicId, 'otrosIngresos');

  const r = ok(await settle(clinicId, userId, p._id, {
    mode: 'CREAR', date: key(HOY), amount: 5000,
    bankAccountId: bank._id, counterAccountId: prestamo._id, method: 'TRANSFERENCIA',
  }, 'liq-in'));
  const asiento = await JournalEntry.findById(r.journalEntry);
  assert.equal(asiento.totalDebit, asiento.totalCredit);
  const liq = asiento.lines.find((l) => String(l.account) === String(bank.chartAccount));
  assert.equal(liq.debit, 5000, 'entra dinero: se debita el banco');
  const tx = await BankTransaction.findOne({ clinic: clinicId, sourceRef: p._id });
  assert.equal(tx.direction, 1);
});

test('B2·4) reintento con la MISMA clave: no contabiliza dos veces', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const p = await partida(clinicId, userId);
  const bank = await banco(clinicId);
  const gasto = await cuenta(clinicId, '6.1.99');
  const body = {
    mode: 'CREAR', date: key(HOY), amount: 800,
    bankAccountId: bank._id, counterAccountId: gasto._id, method: 'TRANSFERENCIA',
  };
  ok(await settle(clinicId, userId, p._id, body, 'reintento'));
  const r2 = ok(await settle(clinicId, userId, p._id, body, 'reintento'));
  assert.equal(r2.idempotentReplay, true);
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'CashFlowManualItem' }), 1);
  assert.equal(await BankTransaction.countDocuments({ clinic: clinicId, sourceRef: p._id }), 1);
});

test('B2·5) misma clave con OTRO contenido: 409 (no se liquida otra cosa)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const p = await partida(clinicId, userId);
  const bank = await banco(clinicId);
  const gasto = await cuenta(clinicId, '6.1.99');
  ok(await settle(clinicId, userId, p._id, {
    mode: 'CREAR', date: key(HOY), amount: 800,
    bankAccountId: bank._id, counterAccountId: gasto._id, method: 'TRANSFERENCIA',
  }, 'misma-clave'));

  const r = await settle(clinicId, userId, p._id, {
    mode: 'CREAR', date: key(HOY), amount: 500,      // otro importe con la misma clave
    bankAccountId: bank._id, counterAccountId: gasto._id, method: 'TRANSFERENCIA',
  }, 'misma-clave');
  assert.equal(r.statusCode, 409);
  assert.ok(!/E11000|duplicate key/i.test(r.payload.message), 'nunca un error crudo de Mongo');
});

test('B2·6) VINCULAR un movimiento real existente: no contabiliza nada nuevo', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const p = await partida(clinicId, userId);
  const bank = await banco(clinicId);
  const acc = await cuenta(clinicId, '1.1.01.03');
  const gasto = await cuenta(clinicId, '6.1.99');
  const entry = await createEntry({
    clinicId, date: HOY, description: 'Arriendo pagado', userId,
    sourceModel: 'BankTransaction', sourceRef: bank._id, sourceAction: 'MANUAL',
    lines: [{ account: gasto._id, debit: 800, credit: 0 }, { account: acc._id, debit: 0, credit: 800 }],
  });
  const tx = await BankTransaction.create({
    clinic: clinicId, bankAccount: bank._id, date: HOY, type: 'PAGO', amount: 800, direction: -1,
    description: 'Arriendo', journalEntry: entry._id, createdBy: userId,
  });

  // El buscador lo ofrece como candidato compatible.
  const cand = ok(await run(ctrl.settlementCandidates, H.mockReq(clinicId, userId, {}, {
    query: { itemId: String(p._id) },
  })));
  const fila = cand.rows.find((c) => c.id === String(tx._id));
  assert.ok(fila, 'aparece en la búsqueda');
  assert.equal(fila.compatible, true);
  assert.equal(fila.yaVinculado, null);

  const asientosAntes = await JournalEntry.countDocuments({ clinic: clinicId });
  const r = ok(await settle(clinicId, userId, p._id, {
    mode: 'VINCULAR', settledByModel: 'BankTransaction', settledByRef: tx._id,
  }));
  assert.equal(r.status, 'REALIZADO');
  assert.equal(String(r.journalEntry), String(entry._id), 'devuelve el asiento del movimiento enlazado');
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId }), asientosAntes, 'no crea un segundo asiento');
});

test('B2·7) un movimiento que ya respalda otra partida: 409 y el buscador lo marca', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const p1 = await partida(clinicId, userId);
  const p2 = await partida(clinicId, userId, { description: 'Otro arriendo' });
  const bank = await banco(clinicId);
  const tx = await BankTransaction.create({
    clinic: clinicId, bankAccount: bank._id, date: HOY, type: 'PAGO', amount: 800, direction: -1,
    description: 'Arriendo', createdBy: userId,
  });
  ok(await settle(clinicId, userId, p1._id, { mode: 'VINCULAR', settledByModel: 'BankTransaction', settledByRef: tx._id }));

  const r = await settle(clinicId, userId, p2._id, { mode: 'VINCULAR', settledByModel: 'BankTransaction', settledByRef: tx._id });
  assert.equal(r.statusCode, 409);
  assert.ok(/no puede liquidar dos previsiones/i.test(r.payload.message));

  const cand = ok(await run(ctrl.settlementCandidates, H.mockReq(clinicId, userId, {}, { query: { itemId: String(p2._id) } })));
  assert.equal(cand.rows.find((c) => c.id === String(tx._id)).yaVinculado, 'Arriendo del local',
    'el buscador dice a QUÉ partida pertenece en vez de esconderlo');
});

test('B2·8) cancelar ANTES de liquidar: deja de proyectarse y conserva su historial', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const p = await partida(clinicId, userId);
  const r = ok(await run(ctrl.cancelManualItem, H.mockReq(clinicId, userId, { reason: 'Ya no se paga' }, { params: { id: p._id } })));
  assert.equal(r.status, 'CANCELADO');
  assert.equal(r.history.at(-1).reason, 'Ya no se paga');

  const data = await proj(clinicId, HOY, dia(20));
  assert.equal(celda(data, dia(3), 'EGRESO', 'GASTOS_FIJOS'), 0, 'una cancelada no aparece en la proyección');
});

test('B2·9) cancelar DESPUÉS de liquidar: bloqueado (no se borra un movimiento contable)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const p = await partida(clinicId, userId);
  const bank = await banco(clinicId);
  const gasto = await cuenta(clinicId, '6.1.99');
  ok(await settle(clinicId, userId, p._id, {
    mode: 'CREAR', date: key(HOY), amount: 800,
    bankAccountId: bank._id, counterAccountId: gasto._id, method: 'TRANSFERENCIA',
  }, 'liq-9'));

  const r = await run(ctrl.cancelManualItem, H.mockReq(clinicId, userId, { reason: 'me arrepiento' }, { params: { id: p._id } }));
  assert.equal(r.statusCode, 400);
  assert.ok(/no puede borrar ni reversar/i.test(r.payload.message));
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'CashFlowManualItem' }), 1,
    'el asiento sigue vivo');
});

test('B2·10) la partida liquidada trae su asiento y su movimiento bancario (trazabilidad)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const p = await partida(clinicId, userId);
  const bank = await banco(clinicId);
  const gasto = await cuenta(clinicId, '6.1.99');
  ok(await settle(clinicId, userId, p._id, {
    mode: 'CREAR', date: key(HOY), amount: 800,
    bankAccountId: bank._id, counterAccountId: gasto._id, method: 'TRANSFERENCIA',
  }, 'liq-10'));

  const lista = ok(await run(ctrl.listManualItems, H.mockReq(clinicId, userId, {}, { query: {} })));
  const item = lista.find((x) => String(x._id) === String(p._id));
  assert.equal(item.status, 'REALIZADO');
  assert.ok(item.journalEntry, 'se puede abrir el asiento');
  assert.ok(item.numeroAsiento);
  assert.ok(item.bankTransaction, 'y el movimiento bancario');
});

test('B2·11) al liquidar, el importe pasa de la proyección a los movimientos reales', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const p = await partida(clinicId, userId);
  const bank = await banco(clinicId);
  const gasto = await cuenta(clinicId, '6.1.99');

  const antes = await proj(clinicId, HOY, dia(20));
  assert.equal(celda(antes, dia(3), 'EGRESO', 'GASTOS_FIJOS'), 800, 'previsto');
  assert.equal((await svc.realMovements(clinicId, { from: HOY, to: dia(20) })).totalOut, 0);

  ok(await settle(clinicId, userId, p._id, {
    mode: 'CREAR', date: key(HOY), amount: 800,
    bankAccountId: bank._id, counterAccountId: gasto._id, method: 'TRANSFERENCIA',
  }, 'liq-11'));

  const despues = await proj(clinicId, HOY, dia(20));
  assert.equal(celda(despues, dia(3), 'EGRESO', 'GASTOS_FIJOS'), 0, 'ya no se proyecta');
  assert.equal(despues.totales.egresos, 800, 'ahora es un movimiento REAL del día que se pagó');
  const movs = await svc.realMovements(clinicId, { from: HOY, to: dia(20) });
  assert.equal(movs.totalOut, 800);
  assert.equal(movs.rows.length, 1, 'y no se duplica por tener asiento y movimiento bancario');
});

// ═══════════════ BLOQUE 3 · ANULAR UN COBRO LEGACY (sin `appliedTo`) ═══════════════
//
// Los cobros históricos no dicen sobre qué cartera se aplicaron. El destino NO puede deducirse
// recalculando el canónico con los saldos de hoy (ya incluyen el efecto del cobro que se anula):
// se reconstruye por EVIDENCIA, y si no puede demostrarse, se BLOQUEA.

/** Cobro histórico: contabilizado y aplicado a mano, SIN `applications[].appliedTo`. */
async function cobroLegacy(clinicId, userId, { invoice, monto, aplicarEn = [] }) {
  const caja = await cuenta(clinicId, '1.1.01.01');
  const cli = await getAccount(clinicId, 'clientes');
  seq += 1;
  const entry = await createEntry({
    clinicId, date: dia(-2), description: 'Cobro histórico', userId,
    sourceModel: 'Payment', sourceRef: invoice._id, sourceAction: `LEGACY:${seq}`,
    lines: [{ account: caja._id, debit: monto, credit: 0 }, { account: cli._id, debit: 0, credit: monto }],
  });
  const pago = await Payment.create({
    clinic: clinicId, type: 'COBRO', number: `CB-LEG-${seq}`, date: dia(-2),
    partyModel: 'Patient', partyName: 'Cliente F', method: 'EFECTIVO', total: monto,
    applications: [{ docModel: 'Invoice', docRef: invoice._id, amount: monto }],   // sin appliedTo
    appliedAmount: monto, journalEntry: entry._id,
  });
  // Se "aplica" en las carteras que indique el escenario (así llegaron los datos migrados).
  for (const { sourceModel, sourceRef, amount } of aplicarEn) {
    const cxc = await Receivable.findOne({ clinic: clinicId, sourceModel, sourceRef });
    cxc.applied = +(Number(cxc.applied) + Number(amount)).toFixed(2);
    await cxc.save();
  }
  return pago;
}
const anular = (clinicId, userId, id) => run(payments.void, H.mockReq(clinicId, userId, {}, { params: { id } }));
const cxcDe = (clinicId, sourceModel, sourceRef) => Receivable.findOne({ clinic: clinicId, sourceModel, sourceRef });

test('L1) cobro legacy aplicado SOLO en la CxC de la venta: se des-aplica ahí', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const { sale, inv } = await parFacturado(clinicId, { total: 400 });
  const pago = await cobroLegacy(clinicId, userId, {
    invoice: inv, monto: 150, aplicarEn: [{ sourceModel: 'Sale', sourceRef: sale._id, amount: 150 }],
  });

  ok(await anular(clinicId, userId, pago._id));
  assert.equal((await cxcDe(clinicId, 'Sale', sale._id)).applied, 0, 'vuelve a la que lo tenía');
  assert.equal((await cxcDe(clinicId, 'Invoice', inv._id)).applied, 0, 'la otra no se toca');
});

test('L2) cobro legacy aplicado SOLO en la CxC de la factura: se des-aplica ahí', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const { sale, inv } = await parFacturado(clinicId, { total: 400 });
  const pago = await cobroLegacy(clinicId, userId, {
    invoice: inv, monto: 150, aplicarEn: [{ sourceModel: 'Invoice', sourceRef: inv._id, amount: 150 }],
  });

  ok(await anular(clinicId, userId, pago._id));
  assert.equal((await cxcDe(clinicId, 'Invoice', inv._id)).applied, 0);
  assert.equal((await cxcDe(clinicId, 'Sale', sale._id)).applied, 0, 'no se le inventa un saldo a la venta');
  assert.equal((await cxcDe(clinicId, 'Sale', sale._id)).balance, 400);
});

test('L3) el MISMO cobro legacy espejado en las dos: se devuelve a las dos y el efecto económico es UNO', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const { sale, inv } = await parFacturado(clinicId, { total: 400 });
  const pago = await cobroLegacy(clinicId, userId, {
    invoice: inv,
    monto: 150,
    aplicarEn: [
      { sourceModel: 'Sale', sourceRef: sale._id, amount: 150 },
      { sourceModel: 'Invoice', sourceRef: inv._id, amount: 150 },
    ],
  });
  const antes = await obligacionDe(clinicId);
  assert.equal(antes.balance, 250, 'antes de anular, la obligación debe 250');

  ok(await anular(clinicId, userId, pago._id));
  assert.equal((await cxcDe(clinicId, 'Sale', sale._id)).applied, 0);
  assert.equal((await cxcDe(clinicId, 'Invoice', inv._id)).applied, 0);

  const despues = await obligacionDe(clinicId);
  assert.equal(despues.balance, 400, 'el saldo económico sube 150 UNA vez, no 300');
  assert.notEqual(despues.resolution, 'AMBIGUOUS', 'y no se fabrica una ambigüedad nueva');
});

test('L4) aplicaciones incompatibles en ambas: se BLOQUEA la anulación', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const { sale, inv } = await parFacturado(clinicId, { total: 400 });
  // Ninguna cartera refleja 150: la venta tiene 70 y la factura 30 sin explicar.
  const pago = await cobroLegacy(clinicId, userId, {
    invoice: inv,
    monto: 150,
    aplicarEn: [
      { sourceModel: 'Sale', sourceRef: sale._id, amount: 70 },
      { sourceModel: 'Invoice', sourceRef: inv._id, amount: 30 },
    ],
  });

  const r = await anular(clinicId, userId, pago._id);
  assert.equal(r.statusCode, 409);
  assert.ok(/no se puede demostrar/i.test(r.payload.message), 'error contable controlado');
  assert.ok(/a mano/i.test(r.payload.message), 'y pide conciliación manual');
  assert.ok(!/E11000|MongoServerError/i.test(r.payload.message), 'nunca un error interno');
  // Nada se movió: ni el pago, ni el asiento, ni las carteras, ni la factura.
  assert.equal((await Payment.findById(pago._id)).status, 'REGISTRADO');
  assert.equal((await cxcDe(clinicId, 'Sale', sale._id)).applied, 70);
  assert.equal((await cxcDe(clinicId, 'Invoice', inv._id)).applied, 30);
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceAction: 'REVERSA' }), 0);
});

test('L5) ninguna cartera refleja el cobro: se anula sin tocar la cartera', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  // El bug histórico: cobrar una factura no aplicaba a su CxC. No hay nada que devolver.
  const { sale, inv } = await parFacturado(clinicId, { total: 400 });
  const pago = await cobroLegacy(clinicId, userId, { invoice: inv, monto: 150, aplicarEn: [] });

  ok(await anular(clinicId, userId, pago._id));
  assert.equal((await Payment.findById(pago._id)).status, 'ANULADO');
  assert.equal((await cxcDe(clinicId, 'Sale', sale._id)).applied, 0, 'no se inventa una des-aplicación');
  assert.equal((await cxcDe(clinicId, 'Invoice', inv._id)).applied, 0);
});

test('L6) un cobro NUEVO (con appliedTo) conserva el comportamiento: vuelve a su cartera', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const { sale, inv } = await parFacturado(clinicId, { total: 400, cxcFactura: false });
  const pago = ok(await run(payments.create, H.mockReq(clinicId, userId, {
    type: 'COBRO', method: 'EFECTIVO', partyModel: 'Patient', partyName: 'Cliente F',
    date: HOY, applications: [{ docModel: 'Invoice', docRef: inv._id, amount: 150 }],
  })));
  assert.equal(pago.applications[0].appliedTo.sourceModel, 'Sale');

  ok(await anular(clinicId, userId, pago._id));
  assert.equal((await cxcDe(clinicId, 'Sale', sale._id)).applied, 0);
  assert.equal((await Sale.findById(sale._id)).balance, 400, 'y el documento de la venta también');
});

test('L7) el bloqueo deja la transacción intacta también con varios cobros vigentes', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const { sale, inv } = await parFacturado(clinicId, { total: 1000 });
  // Un cobro vigente (explicado) + uno legacy que no cuadra con lo que queda sin explicar.
  await cobroHistorico(clinicId, [{ docModel: 'Sale', docRef: sale._id, amount: 200 }]);
  const legacy = await cobroLegacy(clinicId, userId, {
    invoice: inv,
    monto: 300,
    aplicarEn: [
      { sourceModel: 'Sale', sourceRef: sale._id, amount: 200 },   // el del cobro vigente
      { sourceModel: 'Sale', sourceRef: sale._id, amount: 120 },   // residuo 120 ≠ 300
      { sourceModel: 'Invoice', sourceRef: inv._id, amount: 45 },
    ],
  });

  const r = await anular(clinicId, userId, legacy._id);
  assert.equal(r.statusCode, 409);
  assert.equal((await Payment.findById(legacy._id)).status, 'REGISTRADO');
  assert.equal((await cxcDe(clinicId, 'Sale', sale._id)).applied, 320, 'la cartera no se movió');
  assert.equal((await cxcDe(clinicId, 'Invoice', inv._id)).applied, 45);
  assert.equal((await Invoice.findById(inv._id)).balance, 1000, 'ni el documento');
});

test('L8) dos clínicas: la evidencia no cruza de una a otra', async () => {
  const a = await H.seedClinic({ date: dia(-5) });
  const b = await H.seedClinic({ date: dia(-5) });
  const parA = await parFacturado(a.clinicId, { total: 400 });
  await parFacturado(b.clinicId, { total: 400 });
  // En B hay una CxC con 150 aplicados; no debe servir de evidencia para el cobro de A.
  const cxcB = await Receivable.findOne({ clinic: b.clinicId, sourceModel: 'Sale' });
  cxcB.applied = 150;
  await cxcB.save();

  const pagoA = await cobroLegacy(a.clinicId, a.userId, {
    invoice: parA.inv, monto: 150,
    aplicarEn: [{ sourceModel: 'Invoice', sourceRef: parA.inv._id, amount: 150 }],
  });
  ok(await anular(a.clinicId, a.userId, pagoA._id));
  assert.equal((await cxcDe(a.clinicId, 'Invoice', parA.inv._id)).applied, 0);
  assert.equal((await Receivable.findById(cxcB._id)).applied, 150, 'la clínica B no se toca');
});

// ═══════════ BLOQUE 4 · CARTERA CONFIRMADA vs AMBIGUA ESTIMADA ═══════════

/** Par ambiguo: dos carteras con aplicaciones distintas y sin cobros que las expliquen. */
const parAmbiguo = (clinicId, total, av, af) =>
  parFacturado(clinicId, { total, appliedVenta: av, appliedFactura: af });

test('P1) solo obligaciones seguras: confirmado = operativo y ambiguo = 0', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  await parFacturado(clinicId, { total: 400 });

  const ar = await aging(clinicId, userId);
  assert.equal(ar.summary.confirmedBalance, 400);
  assert.equal(ar.summary.ambiguousEstimatedBalance, 0);
  assert.equal(ar.summary.operationalBalance, 400);
  assert.equal(ar.summary.ambiguousCount, 0);
  assert.equal(ar.summary.warning, null);
  assert.equal(ar.rows[0].requiresReview, false);
});

test('P2) un caso ambiguo: se separa de lo confirmado y NO se llama SAFE_DUPLICATE', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  await parFacturado(clinicId, { total: 400 });                    // confirmada
  await parAmbiguo(clinicId, 1000, 100, 250);                      // ambigua → estimado 750

  const ar = await aging(clinicId, userId);
  assert.equal(ar.summary.confirmedBalance, 400);
  assert.equal(ar.summary.ambiguousEstimatedBalance, 750);
  assert.equal(ar.summary.operationalBalance, 1150);
  assert.equal(ar.summary.ambiguousCount, 1);
  assert.ok(/ESTIMACIÓN|estimación/i.test(ar.summary.warning));

  const fila = ar.rows.find((r) => r.requiresReview);
  assert.equal(fila.resolution, 'AMBIGUOUS');
  assert.notEqual(fila.resolution, 'SAFE_DUPLICATE');
  assert.equal(fila.confirmedBalance, 0, 'no cuenta como cartera confirmada');
  assert.equal(fila.ambiguousEstimatedBalance, 750);
  assert.ok(fila.formula.includes('ESTIMADO'), 'muestra la fórmula usada');
  assert.ok(fila.warning, 'y el motivo de la ambigüedad');
  assert.ok(fila.links.sale && fila.links.invoice, 'conserva los vínculos a los documentos');
  assert.ok(fila.links.receivableSale && fila.links.receivableInvoice, 'y a las dos carteras');
});

test('P3) varios ambiguos en rangos de antigüedad distintos: cada rango dice cuánto es estimado', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-60) });
  const viejo = await parAmbiguo(clinicId, 500, 100, 50);
  const nuevo = await parAmbiguo(clinicId, 300, 30, 10);
  // Se separan en el tiempo para que caigan en rangos distintos.
  await Receivable.updateMany({ clinic: clinicId, sourceRef: { $in: [viejo.sale._id, viejo.inv._id] } },
    { $set: { dueDate: dia(-45) } });
  await Receivable.updateMany({ clinic: clinicId, sourceRef: { $in: [nuevo.sale._id, nuevo.inv._id] } },
    { $set: { dueDate: dia(-5) } });

  const ar = await aging(clinicId, userId);
  assert.equal(ar.summary.ambiguousCount, 2);
  assert.equal(ar.summary.confirmedBalance, 0);
  assert.equal(ar.summary.ambiguousEstimatedBalance, 400 + 270);
  const buckets = ar.rows.map((r) => r.bucket);
  assert.equal(new Set(buckets).size, 2, 'caen en rangos de edad distintos');
  for (const r of ar.rows) {
    assert.equal(ar.totals.ambiguous[r.bucket], r.balance, `el rango ${r.bucket} declara su saldo estimado`);
    assert.equal(ar.totals.confirmed[r.bucket] || 0, 0);
  }
});

test('P4) los totales del aging siguen conciliando con su detalle', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  await parFacturado(clinicId, { total: 400 });
  await parAmbiguo(clinicId, 1000, 100, 250);
  await Sale.create({
    clinic: clinicId, saleNumber: 'V-Z', clientName: 'Otro', paymentMethod: 'credito',
    status: 'completada', subtotal: 60, taxAmount: 0, total: 60, balance: 60, items: [],
  });

  const ar = await aging(clinicId, userId);
  const suma = ar.rows.reduce((s, r) => s + r.balance, 0);
  assert.equal(+suma.toFixed(2), +ar.totals.total.toFixed(2));
  assert.equal(+suma.toFixed(2), ar.summary.operationalBalance);
  assert.equal(
    +(ar.summary.confirmedBalance + ar.summary.ambiguousEstimatedBalance).toFixed(2),
    ar.summary.operationalBalance,
    'confirmado + estimado = operativo'
  );
  const sumaConf = ar.rows.reduce((s, r) => s + r.confirmedBalance, 0);
  assert.equal(+sumaConf.toFixed(2), ar.summary.confirmedBalance);
});

test('P5) el Excel concilia con la API en los TRES totales', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  await parFacturado(clinicId, { total: 400 });
  await parAmbiguo(clinicId, 1000, 100, 250);

  const ar = await aging(clinicId, userId);
  const wb = await excelDe(reports.arAgingExcel, H.mockReq(clinicId, userId, {}, { query: {} }));
  const { filas, resumen, col } = hojaAging(wb);
  assert.equal(filas.length, ar.rows.length);

  const suma = (h) => +filas.reduce((s, r) => s + Number(r.getCell(col(h)).value || 0), 0).toFixed(2);
  assert.equal(suma('Saldo confirmado'), ar.summary.confirmedBalance);
  assert.equal(suma('Saldo ambiguo estimado'), ar.summary.ambiguousEstimatedBalance);
  assert.equal(suma('Saldo operativo'), ar.summary.operationalBalance);

  const ambigua = filas.find((r) => r.getCell(col('Resolución')).value === 'AMBIGUOUS');
  assert.ok(String(ambigua.getCell(col('Requiere revisión')).value).startsWith('SÍ'));
  assert.ok(ambigua.getCell(col('Motivo')).value, 'exporta el motivo');
  // Y la sección de resumen repite los tres totales.
  const etiquetas = resumen.map((r) => String(r.getCell(1).value || ''));
  assert.ok(etiquetas.some((t) => t.includes('Total confirmado')));
  assert.ok(etiquetas.some((t) => t.includes('Estimación ambigua')));
  assert.ok(etiquetas.some((t) => t.includes('Total operativo')));
});

test('P6) el flujo usa el saldo operativo, lo marca ESTIMADO y levanta la alerta', async () => {
  const { clinicId } = await H.seedClinic({ date: dia(-5) });
  await parFacturado(clinicId, { total: 400 });
  await parAmbiguo(clinicId, 1000, 100, 250);

  const data = await proj(clinicId, HOY, dia(20));
  assert.equal(celda(data, dia(6), 'INGRESO', 'CLIENTES'), 1150, 'proyecta el saldo operativo');
  assert.equal(data.totales.ingresosEstimados, 750, 'y dice cuánto de eso es una estimación');

  const fila = data.detalle.find((x) => x.estimado && x.day);
  assert.equal(fila.requiresReview, true, 'la fila no se presenta como cobro confirmado');
  assert.ok(fila.vinculos.venta.id && fila.vinculos.factura.id, 'se pueden abrir las dos referencias');
  assert.ok(fila.vinculos.carteraVenta && fila.vinculos.carteraFactura, 'y las dos carteras');

  const alerta = data.alertas.find((a) => a.tipo === 'CXC_DUPLICADA_AMBIGUA');
  assert.equal(alerta.estimado, 750);
  assert.ok(alerta.documentos[0].formula);
});

test('P7) dos clínicas: los resúmenes no se mezclan', async () => {
  const a = await H.seedClinic({ date: dia(-5) });
  const b = await H.seedClinic({ date: dia(-5) });
  await parAmbiguo(a.clinicId, 1000, 100, 250);
  await parFacturado(b.clinicId, { total: 400 });

  const arA = await aging(a.clinicId, a.userId);
  const arB = await aging(b.clinicId, b.userId);
  assert.equal(arA.summary.ambiguousCount, 1);
  assert.equal(arA.summary.confirmedBalance, 0);
  assert.equal(arB.summary.ambiguousCount, 0, 'la clínica B no hereda la ambigüedad de la A');
  assert.equal(arB.summary.confirmedBalance, 400);
  assert.equal(arB.summary.ambiguousEstimatedBalance, 0);
});

test('B2·12) dos usuarios liquidando a la vez: un solo asiento', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const p = await partida(clinicId, userId);
  const bank = await banco(clinicId);
  const gasto = await cuenta(clinicId, '6.1.99');
  const body = {
    mode: 'CREAR', date: key(HOY), amount: 800,
    bankAccountId: bank._id, counterAccountId: gasto._id, method: 'TRANSFERENCIA',
  };

  const rs = await Promise.allSettled([
    settle(clinicId, userId, p._id, body, 'concurrente-A'),
    settle(clinicId, userId, p._id, body, 'concurrente-B'),
  ]);
  const oks = rs.map((r) => (r.status === 'fulfilled' ? r.value : null)).filter((r) => r && r.statusCode < 400);
  assert.ok(oks.length >= 1, 'al menos una liquida');
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'CashFlowManualItem' }), 1,
    'nunca dos asientos para la misma partida');
  assert.equal(await BankTransaction.countDocuments({ clinic: clinicId, sourceRef: p._id }), 1);
  assert.equal((await CashFlowManualItem.findById(p._id)).status, 'REALIZADO');
});
