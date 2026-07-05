/**
 * Reportes SRI por período flexible (mensual/semestral/anual/rango) sobre los
 * controllers reales. Verifica:
 *  - las ventas se filtran por fecha FISCAL (Invoice.fechaEmision), no por createdAt;
 *  - las compras se filtran por fechaEmision;
 *  - Form 103 lee SOLO las retenciones de cabecera (sin doble conteo con línea);
 *  - Form 104 suma ventas/compras del rango;
 *  - ATS visual toma compras/ventas del rango;
 *  - los XML oficiales (103/104/ATS) siguen funcionando mensual y BLOQUEAN rangos.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const reports = require('../controllers/accountingReportsController');
const sriXml = require('../controllers/sriSuperciasReportsController');
const Invoice = require('../models/Invoice');
const PurchaseInvoice = require('../models/PurchaseInvoice');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

let seq = 0;
async function makeInvoice(clinicId, { fechaEmision, createdAt, base = 100, iva = 15, estado = 'AUTORIZADO', ident = '1790012345001', razon = 'Cliente SA' } = {}) {
  seq += 1;
  const inv = await Invoice.create({
    clinic: clinicId,
    claveAcceso: `CLV${Date.now()}${seq}${Math.floor(Math.random() * 1e6)}`,
    secuencial: String(seq).padStart(9, '0'),
    estab: '001', ptoEmi: '001', ambiente: '1',
    fechaEmision,
    estado,
    tipoIdentificacionComprador: '04',
    identificacionComprador: ident,
    razonSocialComprador: razon,
    subtotal: base, iva, total: base + iva,
    totalSinImpuestos: base, totalImpuesto: iva, importeTotal: base + iva,
  });
  if (createdAt) { await Invoice.updateOne({ _id: inv._id }, { $set: { createdAt } }); }
  return inv;
}

async function makePurchase(clinicId, supplierId, { fechaEmision, createdAt, subtotal = 100, iva = 15, retentions = [], items = [] } = {}) {
  const retentionTotal = retentions.reduce((s, r) => s + (r.amount || 0), 0);
  const pi = await PurchaseInvoice.create({
    clinic: clinicId, supplier: supplierId, docType: 'FACTURA',
    estab: '001', ptoEmi: '001', secuencial: String(++seq).padStart(9, '0'),
    serie: `001-001-${String(seq).padStart(9, '0')}`,
    fechaEmision, subtotal, subtotal15: subtotal, iva, total: subtotal + iva - retentionTotal,
    vatCreditAmount: iva,
    retentions, retentionTotal, balance: subtotal + iva - retentionTotal,
    status: 'REGISTRADA', items,
  });
  if (createdAt) { await PurchaseInvoice.updateOne({ _id: pi._id }, { $set: { createdAt } }); }
  return pi;
}

// ── 7) Ventas por fecha fiscal (fechaEmision), no createdAt ────────────────────
test('7) ventas: se filtran por fechaEmision, no por createdAt', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  // Emitida el 30/06 pero registrada (createdAt) en julio (cruce de mes por TZ/registro).
  await makeInvoice(clinicId, { fechaEmision: '30/06/2026', createdAt: new Date('2026-07-02T05:00:00Z'), base: 200, iva: 30 });

  const june = await H.runController(reports.form104, H.mockReq(clinicId, userId, {}, { query: { periodType: 'MONTHLY', year: 2026, month: 6 } }));
  assert.equal(june.statusCode, 200, JSON.stringify(june.payload));
  assert.equal(june.payload.ventas.base, 200, 'junio incluye la factura por fecha fiscal');
  assert.equal(june.payload.ventas.iva, 30);

  const july = await H.runController(reports.form104, H.mockReq(clinicId, userId, {}, { query: { periodType: 'MONTHLY', year: 2026, month: 7 } }));
  assert.equal(july.payload.ventas.base, 0, 'julio NO la incluye aunque createdAt sea de julio');
});

// ── 8) Compras por fecha fiscal (fechaEmision) ─────────────────────────────────
test('8) compras: se filtran por fechaEmision', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const sup = await H.makeSupplier(clinicId);
  await makePurchase(clinicId, sup._id, { fechaEmision: new Date(2026, 5, 30), createdAt: new Date(2026, 6, 3), subtotal: 100, iva: 15 });

  const june = await H.runController(reports.form104, H.mockReq(clinicId, userId, {}, { query: { periodType: 'MONTHLY', year: 2026, month: 6 } }));
  assert.equal(june.payload.compras.base, 100);
  assert.equal(june.payload.compras.iva, 15);

  const july = await H.runController(reports.form104, H.mockReq(clinicId, userId, {}, { query: { periodType: 'MONTHLY', year: 2026, month: 7 } }));
  assert.equal(july.payload.compras.base, 0);
});

// ── 9) Form 103 toma retenciones (cabecera derivada de línea) en rango ─────────
test('9) form103 agrupa retenciones RENTA de cabecera en el rango', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const sup = await H.makeSupplier(clinicId);
  await makePurchase(clinicId, sup._id, {
    fechaEmision: new Date(2026, 5, 10), subtotal: 1000, iva: 150,
    retentions: [{ type: 'RENTA', code: '312', description: 'Bienes', baseAmount: 1000, percentage: 2, amount: 20 }],
  });
  await makePurchase(clinicId, sup._id, {
    fechaEmision: new Date(2026, 5, 20), subtotal: 500, iva: 75,
    retentions: [{ type: 'RENTA', code: '312', description: 'Bienes', baseAmount: 500, percentage: 2, amount: 10 }],
  });
  const r = await H.runController(reports.form103, H.mockReq(clinicId, userId, {}, { query: { periodType: 'MONTHLY', year: 2026, month: 6 } }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.payload.rows.length, 1, 'un solo código 312 agrupado');
  assert.equal(r.payload.rows[0].code, '312');
  assert.equal(r.payload.rows[0].base, 1500);
  assert.equal(r.payload.rows[0].amount, 30);
  assert.equal(r.payload.total, 30);
});

// ── 10) Form 103 NO duplica: retenciones de cabecera + por línea ───────────────
test('10) form103 no duplica retenciones legacy(cabecera) + por línea', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const sup = await H.makeSupplier(clinicId);
  // La misma retención existe en cabecera Y en la línea. El reporte debe contar SOLO la cabecera.
  await makePurchase(clinicId, sup._id, {
    fechaEmision: new Date(2026, 5, 15), subtotal: 1000, iva: 150,
    retentions: [{ type: 'RENTA', code: '312', description: 'Bienes', baseAmount: 1000, percentage: 2, amount: 20 }],
    items: [{
      description: 'Bien', quantity: 1, unitPrice: 1000, subtotal: 1000, lineType: 'GASTO',
      retentions: [{ type: 'RENTA', code: '312', description: 'Bienes', rate: 2, base: 1000, amount: 20, baseAmount: 1000, percentage: 2 }],
    }],
  });
  const r = await H.runController(reports.form103, H.mockReq(clinicId, userId, {}, { query: { periodType: 'MONTHLY', year: 2026, month: 6 } }));
  assert.equal(r.payload.total, 20, 'no suma 40; solo la cabecera');
  assert.equal(r.payload.rows[0].amount, 20);
});

// ── 11) Form 104 suma ventas/compras del rango (semestre) ──────────────────────
test('11) form104 suma ventas y compras del semestre', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-01-01') });
  const sup = await H.makeSupplier(clinicId);
  await makeInvoice(clinicId, { fechaEmision: '15/02/2026', base: 100, iva: 15 });
  await makeInvoice(clinicId, { fechaEmision: '10/05/2026', base: 300, iva: 45 });
  await makeInvoice(clinicId, { fechaEmision: '10/08/2026', base: 999, iva: 100 }); // fuera del 1er semestre
  await makePurchase(clinicId, sup._id, { fechaEmision: new Date(2026, 2, 3), subtotal: 200, iva: 30 });

  const r = await H.runController(reports.form104, H.mockReq(clinicId, userId, {}, { query: { periodType: 'FIRST_SEMESTER', year: 2026 } }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.payload.ventas.base, 400, 'solo feb + may');
  assert.equal(r.payload.ventas.iva, 60);
  assert.equal(r.payload.compras.base, 200);
  assert.equal(r.payload.period.label, 'Primer semestre 2026');
  // IVA por pagar = ventasIva - ivaCredito - retIva = 60 - 30 - 0 = 30
  assert.equal(r.payload.ivaPorPagar, 30);
});

// ── 12) ATS visual toma compras/ventas del rango ──────────────────────────────
test('12) ats-preview (visual) toma compras/ventas del rango anual', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-01-01') });
  const sup = await H.makeSupplier(clinicId, { ruc: '1790012345001', razonSocial: 'Prov SA' });
  await makeInvoice(clinicId, { fechaEmision: '15/03/2026', base: 100, iva: 15, ident: '0102030405', razon: 'Cli A' });
  await makePurchase(clinicId, sup._id, {
    fechaEmision: new Date(2026, 4, 10), subtotal: 500, iva: 75,
    retentions: [{ type: 'IVA', code: '721', baseAmount: 75, percentage: 30, amount: 22.5 }, { type: 'RENTA', code: '312', baseAmount: 500, percentage: 2, amount: 10 }],
  });
  const r = await H.runController(reports.atsPreview, H.mockReq(clinicId, userId, {}, { query: { periodType: 'ANNUAL', year: 2026 } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.compras.length, 1);
  assert.equal(r.payload.compras[0].retIva, 22.5);
  assert.equal(r.payload.compras[0].retRenta, 10);
  assert.equal(r.payload.ventas.length, 1);
  assert.equal(r.payload.totals.ventasBase, 100);
  assert.equal(r.payload.totals.comprasRetRenta, 10);
  assert.equal(r.payload.monthlyXmlAvailable, false, 'anual: XML no disponible');
});

// ── 13) XML oficial mensual sigue funcionando con year/month ──────────────────
test('13) XML 104/103/ATS mensual generan XML válido', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const sup = await H.makeSupplier(clinicId);
  await makeInvoice(clinicId, { fechaEmision: '10/06/2026', base: 100, iva: 15 });
  await makePurchase(clinicId, sup._id, {
    fechaEmision: new Date(2026, 5, 12), subtotal: 200, iva: 30,
    retentions: [{ type: 'RENTA', code: '312', baseAmount: 200, percentage: 2, amount: 4 }],
  });
  const q = { query: { periodType: 'MONTHLY', year: 2026, month: 6 } };

  const f104 = await H.runController(sriXml.form104Xml, H.mockReq(clinicId, userId, {}, q));
  assert.equal(f104.statusCode, 200);
  assert.match(String(f104.payload), /<form104>/);
  assert.match(String(f104.payload), /<periodoFiscal>06\/2026<\/periodoFiscal>/);

  const f103 = await H.runController(sriXml.form103Xml, H.mockReq(clinicId, userId, {}, q));
  assert.equal(f103.statusCode, 200);
  assert.match(String(f103.payload), /<form103>/);
  assert.match(String(f103.payload), /<codigo>312<\/codigo>/);

  const ats = await H.runController(reports.ats, H.mockReq(clinicId, userId, {}, q));
  assert.equal(ats.statusCode, 200);
  assert.match(String(ats.payload), /<iva>/);
});

// ── 13b) legacy: year/month sin periodType sigue siendo mensual ────────────────
test('13b) XML 104 legacy (year/month sin periodType) funciona', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  await makeInvoice(clinicId, { fechaEmision: '10/06/2026', base: 50, iva: 7.5 });
  const r = await H.runController(sriXml.form104Xml, H.mockReq(clinicId, userId, {}, { query: { year: 2026, month: 6 } }));
  assert.equal(r.statusCode, 200);
  assert.match(String(r.payload), /<periodoFiscal>06\/2026<\/periodoFiscal>/);
});

// ── 14) XML oficial BLOQUEA rango no mensual ──────────────────────────────────
test('14) XML 104/103/ATS bloquean período no mensual con mensaje claro', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const annual = { query: { periodType: 'ANNUAL', year: 2026 } };

  const f104 = await H.runController(sriXml.form104Xml, H.mockReq(clinicId, userId, {}, annual));
  assert.equal(f104.statusCode, 400);
  assert.match(f104.payload.message, /por mes/);

  const f103 = await H.runController(sriXml.form103Xml, H.mockReq(clinicId, userId, {}, annual));
  assert.equal(f103.statusCode, 400);
  assert.match(f103.payload.message, /por mes/);

  const ats = await H.runController(reports.ats, H.mockReq(clinicId, userId, {}, annual));
  assert.equal(ats.statusCode, 400);
  assert.match(ats.payload.message, /reporte visual/);
});

// ── purchase-sales list (VC): rango + etiqueta ────────────────────────────────
test('VC: purchases-sales devuelve ventas/compras del rango + etiqueta', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const sup = await H.makeSupplier(clinicId);
  await makeInvoice(clinicId, { fechaEmision: '05/06/2026', base: 100, iva: 15 });
  await makePurchase(clinicId, sup._id, { fechaEmision: new Date(2026, 5, 6), subtotal: 80, iva: 12 });
  const r = await H.runController(reports.purchaseSalesList, H.mockReq(clinicId, userId, {}, { query: { periodType: 'MONTHLY', year: 2026, month: 6 } }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.payload.ventas.length, 1);
  assert.equal(r.payload.compras.length, 1);
  assert.equal(r.payload.period.label, 'Junio 2026');
});

// ── período inválido en endpoint JSON → 400 ───────────────────────────────────
test('form104 con custom sin fechas → 400', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const r = await H.runController(reports.form104, H.mockReq(clinicId, userId, {}, { query: { periodType: 'CUSTOM' } }));
  assert.equal(r.statusCode, 400);
});
