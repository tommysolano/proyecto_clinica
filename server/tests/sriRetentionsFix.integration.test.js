/**
 * Correcciones SRI (revisión de la contadora):
 *   - casillero 332: fecha del comprobante anclada a mediodía local (no desaparece del mes);
 *     base derivada del desglose si falta el header; NC recibida RESTA del 332.
 *   - numeración de retenciones por SERIE (estab-ptoEmi), automática y atómica.
 *   - periodo fiscal de la retención = mes de la FACTURA SUSTENTO (regla de los 5 días), editable
 *     y validado.
 */
process.env.TZ = 'America/Guayaquil';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const purchase = require('../controllers/purchaseInvoiceController');
const { compute103 } = require('../utils/sriForms/compute103');
const { resolveReportRange } = require('../utils/reportDateRange');
const { invoiceDate } = require('../utils/dates');
const InvoicingConfig = require('../models/InvoicingConfig');
const ChartOfAccount = require('../models/ChartOfAccount');
const PurchaseInvoice = require('../models/PurchaseInvoice');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// Los comprobantes ya no admiten fecha anterior a hoy (utils/fiscalDocumentDate), así que
// estas pruebas trabajan sobre el MES EN CURSO en vez de sobre un mes fijo del calendario.
const NOW = new Date();
const Y = NOW.getFullYear();
const M = NOW.getMonth() + 1;
/** Día `d` del mes en curso, anclado como lo hace el formulario (medianoche UTC). */
const diaDelMes = (d) => new Date(Date.UTC(Y, M - 1, d));

// ─────────────────────────────────────────────────────────────────────────────
test('invoiceDate ancla al mediodía local: una fecha "día 1" NO cae en el mes anterior', () => {
  const d = invoiceDate(new Date('2026-05-01')); // como lo manda el form (medianoche UTC)
  assert.equal(d.getMonth(), 4, 'sigue siendo mayo en hora local');
  assert.equal(d.getDate(), 1);
  assert.equal(d.getHours(), 12, 'mediodía local');
  // Idempotente.
  assert.equal(invoiceDate(d).getTime(), d.getTime());
});

// ─────────────────────────────────────────────────────────────────────────────
test('332: compra del día 1 (guardada como el form) entra en su mes y suma al 332', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const sup = await H.makeSupplier(clinicId);
  // Compra registrada HOY por el formulario (única fecha que el sistema admite).
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: String(sup._id), fechaEmision: H.docDate(), serie: '001-001-000000001',
    items: [{ description: 'Servicio', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: 375, subtotal: 375, ivaRate: 0 }],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  // REGRESIÓN original: un comprobante del DÍA 1 guardado como lo manda el form (medianoche
  // UTC) no puede caer en el mes anterior. Se inserta por modelo porque hoy ya no se puede
  // registrar con fecha atrasada; lo que se comprueba aquí es el ANCLAJE, no el registro.
  await PurchaseInvoice.create({
    clinic: clinicId, supplier: sup._id, fechaEmision: invoiceDate(diaDelMes(1)), serie: '001-001-000000002',
    status: 'REGISTRADA', subtotal: 25, total: 25,
    items: [{ description: 'Servicio del día 1', lineType: 'GASTO', quantity: 1, unitPrice: 25, subtotal: 25, ivaRate: 0 }],
  });
  const range = resolveReportRange({ periodType: 'MONTHLY', year: Y, month: M });
  const res = await compute103({ clinicId, range });
  assert.equal(res.computed[332], 400, 'el 332 incluye la compra de hoy y la del día 1');
  assert.equal(res.snapshot.noSujetos.docs.length, 2);
  assert.ok(res.snapshot.noSujetos.docs.some((d) => d.serie === '001-001-000000002'), 'la del día 1 no se perdió en el mes anterior');
});

// ─────────────────────────────────────────────────────────────────────────────
test('332: base derivada del desglose cuando el header subtotal quedó en 0', async () => {
  const { clinicId } = await H.seedClinic();
  const sup = await H.makeSupplier(clinicId);
  // Compra insertada directo con subtotal de cabecera en 0 pero desglose 15% = 200 (vía "rota").
  await PurchaseInvoice.create({
    clinic: clinicId, supplier: sup._id, fechaEmision: invoiceDate(diaDelMes(1)), serie: '001-001-000000050',
    status: 'REGISTRADA', subtotal: 0, subtotal15: 200, iva: 30, total: 230,
    items: [{ description: 'X', lineType: 'GASTO', quantity: 1, unitPrice: 200, subtotal: 200, ivaRate: 15 }],
  });
  const range = resolveReportRange({ periodType: 'MONTHLY', year: Y, month: M });
  const res = await compute103({ clinicId, range });
  assert.equal(res.computed[332], 200, 'deriva la base del desglose 15%');
});

// ─────────────────────────────────────────────────────────────────────────────
test('332: una NOTA DE CRÉDITO recibida RESTA su base del 332', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const sup = await H.makeSupplier(clinicId);
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: String(sup._id), fechaEmision: H.docDate(), serie: '001-001-000000001',
    items: [{ description: 'Compra', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: 500, subtotal: 500, ivaRate: 0 }],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  // NC recibida por 100 (docType NOTA_CREDITO_REC), en el mismo mes.
  await PurchaseInvoice.create({
    clinic: clinicId, supplier: sup._id, fechaEmision: invoiceDate(diaDelMes(1)), serie: '001-001-000000002',
    docType: 'NOTA_CREDITO_REC', status: 'REGISTRADA', subtotal: 100, total: 100,
    items: [{ description: 'Devolución', lineType: 'GASTO', quantity: 1, unitPrice: 100, subtotal: 100, ivaRate: 0 }],
  });
  const range = resolveReportRange({ periodType: 'MONTHLY', year: Y, month: M });
  const res = await compute103({ clinicId, range });
  assert.equal(res.computed[332], 400, 'NC resta: 500 - 100');
});

// ─────────────────────────────────────────────────────────────────────────────
test('numeración de retenciones POR SERIE: automática, independiente y continua', async () => {
  const { clinicId } = await H.seedClinic();
  await InvoicingConfig.create({
    clinic: clinicId, ruc: '0993404160001', razonSocial: 'Clínica', direccionMatriz: 'Dir',
    establecimiento: '001', puntoEmision: '001', ambiente: '1', retentionSequential: 5,
    establishments: [
      { estab: '001', name: 'Matriz', puntosEmision: ['001'] },
      { estab: '002', name: 'Sucursal', puntosEmision: ['001'] },
    ],
  });
  // Serie por defecto 001-001: siembra desde retentionSequential=5.
  const a1 = await InvoicingConfig.reserveRetentionSeries(clinicId, '001', '001');
  const a2 = await InvoicingConfig.reserveRetentionSeries(clinicId, '001', '001');
  assert.equal(a1, '000000005');
  assert.equal(a2, '000000006', 'continúa la secuencia del par por defecto');
  // Serie 002-001: arranca en 1, independiente.
  const b1 = await InvoicingConfig.reserveRetentionSeries(clinicId, '002', '001');
  const b2 = await InvoicingConfig.reserveRetentionSeries(clinicId, '002', '001');
  assert.equal(b1, '000000001');
  assert.equal(b2, '000000002');
  // La serie por defecto no se vio afectada por la otra.
  const a3 = await InvoicingConfig.reserveRetentionSeries(clinicId, '001', '001');
  assert.equal(a3, '000000007');
});

// ─────────────────────────────────────────────────────────────────────────────
test('numeración por serie es ATÓMICA bajo concurrencia (sin duplicados)', async () => {
  const { clinicId } = await H.seedClinic();
  await InvoicingConfig.create({
    clinic: clinicId, ruc: '0993404160001', razonSocial: 'Clínica', direccionMatriz: 'Dir',
    establecimiento: '001', puntoEmision: '001', ambiente: '1', retentionSequential: 1,
  });
  const reservas = await Promise.all(
    Array.from({ length: 20 }, () => InvoicingConfig.reserveRetentionSeries(clinicId, '001', '001'))
  );
  const unicos = new Set(reservas);
  assert.equal(unicos.size, 20, 'las 20 reservas concurrentes son únicas');
});
