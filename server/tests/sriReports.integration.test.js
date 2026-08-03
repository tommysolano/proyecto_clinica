/**
 * Reportes SRI por período flexible (mensual/semestral/anual/rango) sobre los
 * controllers reales. Verifica:
 *  - las ventas se filtran por fecha FISCAL (Invoice.fechaEmision), no por createdAt;
 *  - las compras se filtran por fechaEmision;
 *  - Form 103 lee SOLO las retenciones de cabecera (sin doble conteo con línea);
 *  - Form 104 suma ventas/compras del rango;
 *  - ATS visual toma compras/ventas del rango;
 *  - los XML mensuales (103/104: borradores técnicos, no oficiales; y ATS) siguen
 *    funcionando por mes y BLOQUEAN rangos.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const reports = require('../controllers/accountingReportsController');
const sriXml = require('../controllers/sriSuperciasReportsController');
const Invoice = require('../models/Invoice');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Employee = require('../models/Employee');
const Payroll = require('../models/Payroll');
const PayrollConcept = require('../models/PayrollConcept');
const PayrollDepartment = require('../models/PayrollDepartment');
const PayrollPosition = require('../models/PayrollPosition');
const PayrollIncomeTaxTable = require('../models/PayrollIncomeTaxTable');
const { DEFAULT_IR_RANGES_2024 } = require('../utils/payrollTax');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

let seq = 0;
async function makeInvoice(clinicId, { fechaEmision, createdAt, base = 100, iva = 15, estado = 'AUTORIZADO', ident = '1790012345001', razon = 'Cliente SA', taxBreakdown } = {}) {
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
    // Snapshot por tarifa (facturas nuevas). Si se omite, el reporte deriva por fallback.
    ...(taxBreakdown ? { taxBreakdown: { computed: true, ...taxBreakdown } } : {}),
  });
  if (createdAt) { await Invoice.updateOne({ _id: inv._id }, { $set: { createdAt } }); }
  return inv;
}

async function makePurchase(clinicId, supplierId, { fechaEmision, createdAt, subtotal = 100, iva = 15, retentions = [], items = [], deductible = true, vatCreditAmount } = {}) {
  const retentionTotal = retentions.reduce((s, r) => s + (r.amount || 0), 0);
  const credit = vatCreditAmount != null ? vatCreditAmount : (deductible === false ? 0 : iva);
  const pi = await PurchaseInvoice.create({
    clinic: clinicId, supplier: supplierId, docType: 'FACTURA',
    estab: '001', ptoEmi: '001', secuencial: String(++seq).padStart(9, '0'),
    serie: `001-001-${String(seq).padStart(9, '0')}`,
    fechaEmision, subtotal, subtotal15: subtotal, iva, total: subtotal + iva - retentionTotal,
    deductible, vatCreditAmount: credit, vatNonCreditAmount: iva - credit,
    retentions, retentionTotal, balance: subtotal + iva - retentionTotal,
    status: 'REGISTRADA', items,
  });
  if (createdAt) { await PurchaseInvoice.updateOne({ _id: pi._id }, { $set: { createdAt } }); }
  return pi;
}

async function makePayrollOrg(clinicId) {
  const dept = await PayrollDepartment.create({ clinic: clinicId, name: `Admin ${seq++}`, type: 'ADMINISTRATIVO' });
  const position = await PayrollPosition.create({ clinic: clinicId, name: `Cargo ${seq++}`, department: dept._id });
  return { dept, position };
}

async function makeRdepEmployee(clinicId, overrides = {}) {
  const org = overrides.org || await makePayrollOrg(clinicId);
  seq += 1;
  return Employee.create({
    clinic: clinicId,
    code: overrides.code || `RDEP-${seq}`,
    identificacion: overrides.identificacion || `17${String(seq).padStart(8, '0')}`,
    firstName: overrides.firstName || 'Ana',
    lastName: overrides.lastName || `Rdep${seq}`,
    hireDate: overrides.hireDate || new Date('2024-01-15'),
    baseSalary: overrides.baseSalary ?? 1000,
    departmentRef: overrides.departmentRef ?? org.dept._id,
    positionRef: overrides.positionRef ?? org.position._id,
    ...overrides,
    org: undefined,
  });
}

async function makeRdepConcept(clinicId, overrides = {}) {
  seq += 1;
  return PayrollConcept.create({
    clinic: clinicId,
    code: overrides.code || `RDEP-CON-${seq}`,
    name: overrides.name || `Concepto ${seq}`,
    type: overrides.type || 'INGRESO',
    ...overrides,
  });
}

async function makeRdepPayroll(clinicId, employee, { year = 2026, month = 1, status = 'CERRADO', item = {} } = {}) {
  const baseItem = {
    employee: employee._id,
    employeeName: `${employee.firstName} ${employee.lastName}`,
    identificacion: employee.identificacion || '',
    departmentRef: employee.departmentRef || null,
    daysWorked: 30,
    monthlySalary: item.monthlySalary ?? item.baseSalary ?? employee.baseSalary ?? 0,
    baseSalary: item.baseSalary ?? employee.baseSalary ?? 0,
    iessPersonal: item.iessPersonal ?? 94.5,
    iessPatronal: item.iessPatronal ?? 111.5,
    impuestoRenta: item.impuestoRenta ?? 12,
    totalIngresos: item.totalIngresos ?? ((item.baseSalary ?? employee.baseSalary ?? 0) + (item.decimoTercero || 0) + (item.decimoCuarto || 0) + (item.fondosReserva || 0) + (item.vacaciones || 0) + (item.otherIncome || 0) + (item.earnings || []).reduce((s, x) => s + (x.amount || 0), 0)),
    totalEgresos: item.totalEgresos ?? ((item.iessPersonal ?? 94.5) + (item.impuestoRenta ?? 12) + (item.otherDeductions || 0) + (item.deductions || []).reduce((s, x) => s + (x.amount || 0), 0)),
    netoPagar: item.netoPagar ?? 0,
    ...item,
  };
  baseItem.netoPagar = baseItem.netoPagar || +(baseItem.totalIngresos - baseItem.totalEgresos).toFixed(2);
  return Payroll.create({
    clinic: clinicId,
    code: `ROL-RDEP-${year}${String(month).padStart(2, '0')}-${seq++}`,
    year,
    month,
    period: `${year}-${String(month).padStart(2, '0')}`,
    status,
    items: [baseItem],
    totalIngresos: baseItem.totalIngresos,
    totalEgresos: baseItem.totalEgresos,
    totalNeto: baseItem.netoPagar,
  });
}

async function ensureRdepTaxTable(clinicId, year = 2026) {
  return PayrollIncomeTaxTable.create({ clinic: clinicId, year, periodType: 'ANNUAL', active: true, ranges: DEFAULT_IR_RANGES_2024 });
}

test('RDEP: incluye solo nominas cerradas/pagadas, excluye borradores y agrupa por empleado', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-01-01') });
  await ensureRdepTaxTable(clinicId, 2026);
  const emp = await makeRdepEmployee(clinicId, { firstName: 'Ana', lastName: 'Contable', baseSalary: 1000 });

  await makeRdepPayroll(clinicId, emp, {
    month: 1,
    status: 'CERRADO',
    item: { baseSalary: 1000, decimoTercero: 100, iessPersonal: 94.5, impuestoRenta: 10, totalIngresos: 1100, totalEgresos: 104.5 },
  });
  await makeRdepPayroll(clinicId, emp, {
    month: 2,
    status: 'PAGADO',
    item: { baseSalary: 500, iessPersonal: 47.25, impuestoRenta: 5, totalIngresos: 500, totalEgresos: 52.25 },
  });
  await makeRdepPayroll(clinicId, emp, {
    month: 3,
    status: 'BORRADOR',
    item: { baseSalary: 9999, iessPersonal: 999, impuestoRenta: 999, totalIngresos: 9999, totalEgresos: 1998 },
  });

  const r = await H.runController(reports.rdep, H.mockReq(clinicId, userId, {}, { query: { year: 2026 } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.empleados.length, 1);
  assert.equal(r.payload.payrolls.included, 2);
  assert.equal(r.payload.payrolls.draftExcluded, 1);
  assert.equal(r.payload.empleados[0].sueldoBase, 1500);
  assert.equal(r.payload.empleados[0].ingresosGravados, 1500);
  assert.equal(r.payload.empleados[0].decimoTercero, 100);
  assert.equal(r.payload.empleados[0].aporteIessPersonal, 141.75);
  assert.equal(r.payload.empleados[0].impuestoRenta, 15);
  assert.ok(r.payload.warnings.some((w) => w.code === 'DRAFT_PAYROLLS_EXCLUDED'));

  const xml = await H.runController(reports.rdep, H.mockReq(clinicId, userId, {}, { query: { year: 2026, format: 'xml' } }));
  assert.equal(xml.statusCode, 200);
  assert.match(String(xml.payload), /<rdep preliminar="true">/);
  assert.match(String(xml.payload), /<impuestoRentaRetenido>15\.00<\/impuestoRentaRetenido>/);
});

test('RDEP: clasifica ingresos gravados, no gravados, IESS personal, IR y conceptos sin clasificar', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-01-01') });
  await ensureRdepTaxTable(clinicId, 2026);
  const emp = await makeRdepEmployee(clinicId, { baseSalary: 1000 });
  const taxable = await makeRdepConcept(clinicId, { code: 'RDEP-TAX', name: 'Bono gravado', isTaxableIncome: true, affectsIncomeTax: true });
  const nonTaxable = await makeRdepConcept(clinicId, { code: 'RDEP-NOTAX', name: 'Reembolso', isNonTaxableIncome: true, isReimbursement: true });
  const discount = await makeRdepConcept(clinicId, { code: 'RDEP-DESC', name: 'Descuento', type: 'EGRESO', isDiscount: true });

  await makeRdepPayroll(clinicId, emp, {
    item: {
      baseSalary: 1000,
      decimoTercero: 100,
      iessPersonal: 100,
      impuestoRenta: 15,
      earnings: [
        { concept: taxable._id, code: taxable.code, name: taxable.name, amount: 200 },
        { concept: nonTaxable._id, code: nonTaxable.code, name: nonTaxable.name, amount: 50 },
        { code: 'SIN-CLAS', name: 'Sin clasificar', amount: 25 },
      ],
      deductions: [{ concept: discount._id, code: discount.code, name: discount.name, amount: 30 }],
      totalIngresos: 1375,
      totalEgresos: 145,
    },
  });

  const r = await H.runController(reports.rdep, H.mockReq(clinicId, userId, {}, { query: { year: 2026 } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const e = r.payload.empleados[0];
  assert.equal(e.ingresosGravados, 1200);
  assert.equal(e.ingresosNoGravados, 150);
  assert.equal(e.otrosIngresos, 25);
  assert.equal(e.aporteIessPersonal, 100);
  assert.equal(e.aporteIessPatronal, 111.5);
  assert.equal(e.impuestoRenta, 15);
  assert.equal(e.otrosDescuentos, 30);
  assert.ok(r.payload.warnings.some((w) => w.code === 'UNCLASSIFIED_CONCEPTS'));
});

test('RDEP: advierte empleado sin identificacion y anio sin nominas cerradas', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-01-01') });
  await ensureRdepTaxTable(clinicId, 2026);
  const emp = await makeRdepEmployee(clinicId);
  await Employee.updateOne({ _id: emp._id }, { $unset: { identificacion: '' } });
  await makeRdepPayroll(clinicId, emp, { item: { identificacion: '', baseSalary: 600, totalIngresos: 600, totalEgresos: 60, iessPersonal: 60, impuestoRenta: 0 } });

  const r = await H.runController(reports.rdep, H.mockReq(clinicId, userId, {}, { query: { year: 2026 } }));
  assert.equal(r.statusCode, 200);
  assert.ok(r.payload.warnings.some((w) => w.code === 'EMPLOYEE_MISSING_ID'));

  const empty = await H.runController(reports.rdep, H.mockReq(clinicId, userId, {}, { query: { year: 2027 } }));
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.payload.empleados.length, 0);
  assert.ok(empty.payload.warnings.some((w) => w.code === 'YEAR_WITHOUT_DATA'));
});

test('RDEP: roles antiguos sin desglose no rompen y conservan totales con advertencia', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-01-01') });
  await ensureRdepTaxTable(clinicId, 2026);
  const emp = await makeRdepEmployee(clinicId);
  await makeRdepPayroll(clinicId, emp, {
    item: { baseSalary: 0, iessPersonal: 0, impuestoRenta: 0, totalIngresos: 800, totalEgresos: 120, netoPagar: 680 },
  });

  const r = await H.runController(reports.rdep, H.mockReq(clinicId, userId, {}, { query: { year: 2026 } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.empleados[0].totalIngresos, 800);
  assert.equal(r.payload.empleados[0].otrosIngresos, 800);
  assert.equal(r.payload.empleados[0].otrosDescuentos, 120);
  assert.ok(r.payload.warnings.some((w) => w.code === 'LEGACY_TOTALS_DERIVED'));
});

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
  // Campos con el nombre del ATS: `_retIva`/`_retRenta` son los auxiliares de pantalla.
  assert.equal(r.payload.compras[0]._retIva, 22.5);
  assert.equal(r.payload.compras[0]._retRenta, 10);
  assert.equal(r.payload.compras[0].valRetServ100, 22.5, 'la retención de IVA va al tramo del ATS');
  assert.equal(r.payload.compras[0].air.length, 1, 'la retención en la fuente va en <air>');
  assert.equal(r.payload.compras[0].air[0].codRetAir, '312');
  assert.equal(r.payload.ventas.length, 1);
  assert.equal(r.payload.totals.ventasBase, 100);
  assert.equal(r.payload.totals.comprasRetRenta, 10);
  assert.equal(r.payload.monthlyXmlAvailable, false, 'anual: XML no disponible');
});

// ── 13) XML mensual sigue funcionando con year/month ──────────────────────────
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

  // El ATS avisa de los datos que el SRI rechazaría; estos comprobantes de prueba no traen
  // autorización, así que se pide `force` para comprobar solo la GENERACIÓN del XML.
  const ats = await H.runController(reports.ats, H.mockReq(clinicId, userId, {}, {
    query: { ...q.query, force: 'true' },
  }));
  assert.equal(ats.statusCode, 200, JSON.stringify(ats.payload));
  assert.match(String(ats.payload), /<iva>/);
  assert.match(String(ats.payload), /<codigoOperativo>IVA<\/codigoOperativo>/);
  assert.match(ats.headers['Content-Disposition'], /AT062026\.xml/, 'nombre oficial ATmmaaaa.xml');
});

// ── 13b) legacy: year/month sin periodType sigue siendo mensual ────────────────
test('13b) XML 104 legacy (year/month sin periodType) funciona', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  await makeInvoice(clinicId, { fechaEmision: '10/06/2026', base: 50, iva: 7.5 });
  const r = await H.runController(sriXml.form104Xml, H.mockReq(clinicId, userId, {}, { query: { year: 2026, month: 6 } }));
  assert.equal(r.statusCode, 200);
  assert.match(String(r.payload), /<periodoFiscal>06\/2026<\/periodoFiscal>/);
});

// ── 14) el XML mensual BLOQUEA un rango no mensual ────────────────────────────
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
  assert.match(ats.payload.message, /MES/i, 'el ATS se declara por mes');
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

// ── F104: visual y XML netean el MISMO IVA crédito (compra no deducible) ───────
test('F104: visual y XML usan el mismo IVA crédito; el IVA no deducible NO da crédito', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const sup = await H.makeSupplier(clinicId);
  await makeInvoice(clinicId, { fechaEmision: '10/06/2026', base: 200, iva: 30 }); // venta: IVA generado 30
  await makePurchase(clinicId, sup._id, { fechaEmision: new Date(2026, 5, 5), subtotal: 100, iva: 15, deductible: true });  // crédito 15
  await makePurchase(clinicId, sup._id, { fechaEmision: new Date(2026, 5, 6), subtotal: 100, iva: 15, deductible: false }); // sin crédito
  const q = { query: { periodType: 'MONTHLY', year: 2026, month: 6 } };

  const visual = await H.runController(reports.form104, H.mockReq(clinicId, userId, {}, q));
  assert.equal(visual.statusCode, 200, JSON.stringify(visual.payload));
  assert.equal(visual.payload.compras.ivaCredito, 15, 'solo la compra deducible da crédito');
  assert.equal(visual.payload.compras.ivaNoCredito, 15);
  assert.equal(visual.payload.ivaPorPagar, 15, '30 IVA ventas - 15 crédito - 0 ret');

  const xml = await H.runController(sriXml.form104Xml, H.mockReq(clinicId, userId, {}, q));
  assert.equal(xml.statusCode, 200);
  const s = String(xml.payload);
  const grab = (tag) => Number((s.match(new RegExp(`<${tag}>([\\d.]+)</${tag}>`)) || [])[1]);
  assert.equal(grab('ivaCreditoTributario'), 15, 'el XML usa el mismo IVA crédito que el visual');
  assert.equal(grab('ivaPorPagar'), 15, 'el XML netea igual (no toma el IVA no deducible como crédito)');
  assert.equal(grab('ivaPorPagar'), visual.payload.ivaPorPagar, 'visual == XML');
});

// ── F103: agrupa DOS códigos distintos por separado ───────────────────────────
test('form103 agrupa dos códigos SRI distintos por separado', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const sup = await H.makeSupplier(clinicId);
  await makePurchase(clinicId, sup._id, {
    fechaEmision: new Date(2026, 5, 10), subtotal: 1000, iva: 150,
    retentions: [
      { type: 'RENTA', code: '312', description: 'Bienes', baseAmount: 1000, percentage: 1.75, amount: 17.5 },
      { type: 'RENTA', code: '307', description: 'Servicios', baseAmount: 500, percentage: 2, amount: 10 },
    ],
  });
  const r = await H.runController(reports.form103, H.mockReq(clinicId, userId, {}, { query: { periodType: 'MONTHLY', year: 2026, month: 6 } }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.payload.rows.length, 2, 'dos códigos distintos');
  const byCode = Object.fromEntries(r.payload.rows.map((x) => [x.code, x]));
  assert.equal(byCode['312'].amount, 17.5);
  assert.equal(byCode['307'].amount, 10);
  assert.equal(r.payload.total, 27.5);
});

// ── Ventas NO autorizadas: no entran al reporte y se cuentan como pendientes ───
test('ventas NO autorizadas no entran al reporte SRI y se informan como pendientes', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  await makeInvoice(clinicId, { fechaEmision: '10/06/2026', base: 100, iva: 15, estado: 'AUTORIZADO' });
  await makeInvoice(clinicId, { fechaEmision: '11/06/2026', base: 999, iva: 150, estado: 'EN_PROCESO' }); // no autorizada
  await makeInvoice(clinicId, { fechaEmision: '12/06/2026', base: 500, iva: 75, estado: 'ANULADA' });      // anulada: no cuenta
  const q = { query: { periodType: 'MONTHLY', year: 2026, month: 6 } };
  const r = await H.runController(reports.purchaseSalesList, H.mockReq(clinicId, userId, {}, q));
  assert.equal(r.statusCode, 200);
  assert.equal(r.payload.ventas.length, 1, 'solo la autorizada');
  assert.equal(r.payload.ventas[0].totalSinImpuestos, 100);
  assert.equal(r.payload.salesPending, 1, 'la EN_PROCESO cuenta como pendiente; la ANULADA no');
  const f = await H.runController(reports.form104, H.mockReq(clinicId, userId, {}, q));
  assert.equal(f.payload.ventas.base, 100, 'F104 tampoco incluye la no autorizada');
});

// ── Rango personalizado (CUSTOM) ──────────────────────────────────────────────
test('rango personalizado (CUSTOM) devuelve compras y ventas solo del rango', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-01-01') });
  const sup = await H.makeSupplier(clinicId);
  await makeInvoice(clinicId, { fechaEmision: '15/03/2026', base: 100, iva: 15 });
  await makeInvoice(clinicId, { fechaEmision: '20/07/2026', base: 999, iva: 150 }); // fuera del rango
  await makePurchase(clinicId, sup._id, { fechaEmision: new Date(2026, 2, 18), subtotal: 80, iva: 12 });
  const r = await H.runController(reports.purchaseSalesList, H.mockReq(clinicId, userId, {}, { query: { periodType: 'CUSTOM', startDate: '2026-03-01', endDate: '2026-03-31' } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.ventas.length, 1, 'solo marzo');
  assert.equal(r.payload.compras.length, 1);
  assert.match(r.payload.period.label, /01\/03\/2026 - 31\/03\/2026/);
});

// ── período inválido en endpoint JSON → 400 ───────────────────────────────────
test('form104 con custom sin fechas → 400', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const r = await H.runController(reports.form104, H.mockReq(clinicId, userId, {}, { query: { periodType: 'CUSTOM' } }));
  assert.equal(r.statusCode, 400);
});

// ═══════════════ Ventas separadas por tarifa (0% vs 15%) ═══════════════════════

const { breakdownFromSale, breakdownFromItems } = require('../utils/invoiceTaxBreakdown');
const monthQ = { query: { periodType: 'MONTHLY', year: 2026, month: 6 } };

// ── util: desglose por tarifa desde ítems (fuente de emisión) ─────────────────
test('util: breakdownFromItems separa 0% y 15% y detalla por tarifa', async () => {
  const tb = breakdownFromItems([
    { taxCategory: 'IVA_0', taxRate: 0, taxBase: 100, taxAmount: 0, taxCodeSri: '0' },
    { taxCategory: 'IVA_15', taxRate: 15, taxBase: 200, taxAmount: 30, taxCodeSri: '4' },
  ]);
  assert.equal(tb.base0, 100);
  assert.equal(tb.baseGravada, 200);
  assert.equal(tb.iva, 30);
  assert.equal(tb.baseTotal, 300);
  assert.equal(tb.rates.length, 2);
});

// ── util: desglose desde una venta sin ítems (usa totales resumidos) ──────────
test('util: breakdownFromSale deriva la base gravada restando 0%/exento/no objeto', async () => {
  const tb = breakdownFromSale({ subtotal0: 100, subtotalExento: 0, subtotalNoObjeto: 0, taxableSubtotal: 300, taxAmount: 30 });
  assert.equal(tb.base0, 100);
  assert.equal(tb.baseGravada, 200, '300 total - 100 (0%) = 200 gravada');
  assert.equal(tb.iva, 30);
});

// ── F104 visual: factura SOLO 0% ──────────────────────────────────────────────
test('F104 visual: factura solo tarifa 0% reporta base0 y sin IVA', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  await makeInvoice(clinicId, { fechaEmision: '10/06/2026', base: 100, iva: 0, taxBreakdown: { base0: 100, baseGravada: 0, iva: 0 } });
  const r = await H.runController(reports.form104, H.mockReq(clinicId, userId, {}, monthQ));
  assert.equal(r.payload.ventas.base0, 100);
  assert.equal(r.payload.ventas.baseGravada, 0);
  assert.equal(r.payload.ventas.base, 100);
  assert.equal(r.payload.ventas.iva, 0);
});

// ── F104 visual: factura SOLO 15% ─────────────────────────────────────────────
test('F104 visual: factura solo tarifa 15% reporta base gravada e IVA', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  await makeInvoice(clinicId, { fechaEmision: '10/06/2026', base: 200, iva: 30, taxBreakdown: { base0: 0, baseGravada: 200, iva: 30 } });
  const r = await H.runController(reports.form104, H.mockReq(clinicId, userId, {}, monthQ));
  assert.equal(r.payload.ventas.base0, 0);
  assert.equal(r.payload.ventas.baseGravada, 200);
  assert.equal(r.payload.ventas.iva, 30);
});

// ── F104 visual: factura MIXTA 0% + 15% ───────────────────────────────────────
test('F104 visual: factura mixta separa base 0% y base gravada', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  await makeInvoice(clinicId, { fechaEmision: '10/06/2026', base: 300, iva: 30, taxBreakdown: { base0: 100, baseGravada: 200, iva: 30 } });
  const r = await H.runController(reports.form104, H.mockReq(clinicId, userId, {}, monthQ));
  assert.equal(r.payload.ventas.base0, 100, 'ventas 0% = 100');
  assert.equal(r.payload.ventas.baseGravada, 200, 'ventas 15% = 200');
  assert.equal(r.payload.ventas.base, 300, 'base total = 300');
  assert.equal(r.payload.ventas.iva, 30, 'IVA generado = 30');
});

// ── F104 XML: factura mixta ───────────────────────────────────────────────────
test('F104 XML: factura mixta emite baseTarifa0 y baseGravada separadas', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  await makeInvoice(clinicId, { fechaEmision: '10/06/2026', base: 300, iva: 30, taxBreakdown: { base0: 100, baseGravada: 200, iva: 30 } });
  const r = await H.runController(sriXml.form104Xml, H.mockReq(clinicId, userId, {}, monthQ));
  assert.equal(r.statusCode, 200);
  const s = String(r.payload);
  const grab = (tag) => Number((s.match(new RegExp(`<${tag}>([\\d.]+)</${tag}>`)) || [])[1]);
  assert.equal(grab('baseTarifa0'), 100);
  assert.equal(grab('baseGravada'), 200);
  // El IVA de ventas aparece dentro de <ventas>…<iva>30</iva>
  assert.match(s, /<ventas>[\s\S]*<iva>30\.00<\/iva>[\s\S]*<\/ventas>/);
});

// ── ATS XML: factura mixta separa base 0% (baseImponible) de gravada ──────────
test('ATS XML: factura mixta pone base 0% en baseImponible y gravada en baseImpGrav', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  await makeInvoice(clinicId, { fechaEmision: '10/06/2026', base: 300, iva: 30, taxBreakdown: { base0: 100, baseGravada: 200, iva: 30 } });
  const r = await H.runController(reports.ats, H.mockReq(clinicId, userId, {}, { query: { ...monthQ.query, force: 'true' } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const s = String(r.payload);
  const dv = s.match(/<detalleVentas>[\s\S]*?<\/detalleVentas>/)[0];
  assert.match(dv, /<baseImponible>100\.00<\/baseImponible>/, '0% va en baseImponible');
  assert.match(dv, /<baseImpGrav>200\.00<\/baseImpGrav>/, 'gravada va en baseImpGrav');
  assert.match(dv, /<montoIva>30\.00<\/montoIva>/);
});

// ── ATS visual: factura mixta expone base0/baseGrav por cliente y en totales ──
test('ATS visual: factura mixta separa base0 y baseGrav en ventas y totales', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  await makeInvoice(clinicId, { fechaEmision: '10/06/2026', base: 300, iva: 30, ident: '0102030405', taxBreakdown: { base0: 100, baseGravada: 200, iva: 30 } });
  const r = await H.runController(reports.atsPreview, H.mockReq(clinicId, userId, {}, monthQ));
  assert.equal(r.statusCode, 200);
  // Nombres del ATS: `baseImponible` es la base 0% y `baseImpGrav` la gravada.
  assert.equal(r.payload.ventas[0].baseImponible, 100);
  assert.equal(r.payload.ventas[0].baseImpGrav, 200);
  assert.equal(r.payload.totals.ventasBase0, 100);
  assert.equal(r.payload.totals.ventasBaseGrav, 200);
  assert.equal(r.payload.totals.ventasBase, 300, 'base total sigue disponible');
});

// ── purchase-sales list: cada venta trae su desglose por tarifa ───────────────
test('VC: cada venta incluye taxBreakdown (0%/gravada) para la lista', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  await makeInvoice(clinicId, { fechaEmision: '10/06/2026', base: 300, iva: 30, taxBreakdown: { base0: 100, baseGravada: 200, iva: 30 } });
  const r = await H.runController(reports.purchaseSalesList, H.mockReq(clinicId, userId, {}, monthQ));
  assert.equal(r.statusCode, 200);
  assert.equal(r.payload.ventas[0].taxBreakdown.base0, 100);
  assert.equal(r.payload.ventas[0].taxBreakdown.baseGravada, 200);
});

// ── Fallback: factura ANTIGUA sin snapshot con IVA>0 ⇒ toda la base es gravada ─
test('fallback: factura sin snapshot con IVA>0 asume base gravada', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  await makeInvoice(clinicId, { fechaEmision: '10/06/2026', base: 150, iva: 22.5 }); // sin taxBreakdown
  const r = await H.runController(reports.form104, H.mockReq(clinicId, userId, {}, monthQ));
  assert.equal(r.payload.ventas.base0, 0);
  assert.equal(r.payload.ventas.baseGravada, 150, 'sin snapshot y con IVA: toda la base es gravada');
  assert.equal(r.payload.ventas.iva, 22.5);
});

// ── Fallback: factura ANTIGUA sin snapshot y sin IVA ⇒ toda la base es 0% ──────
test('fallback: factura sin snapshot y sin IVA asume base 0%', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  await makeInvoice(clinicId, { fechaEmision: '10/06/2026', base: 80, iva: 0 }); // sin taxBreakdown
  const r = await H.runController(reports.form104, H.mockReq(clinicId, userId, {}, monthQ));
  assert.equal(r.payload.ventas.base0, 80, 'sin snapshot y sin IVA: toda la base es 0%');
  assert.equal(r.payload.ventas.baseGravada, 0);
  assert.equal(r.payload.ventas.iva, 0);
});
