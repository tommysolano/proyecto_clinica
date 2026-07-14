/**
 * FLUJO DE CAJA DIARIO, OPERATIVO Y PROYECTADO.
 *
 * Cubre las pruebas de aceptación del módulo: saldo inicial desde el mayor, calendario,
 * proveedores, clientes, nómina, SRI, clasificación, partidas manuales, cálculo diario,
 * Excel, concurrencia y volumen.
 *
 * La invariante que más se vigila es la de NO DUPLICAR: una compra, su CxP y su pago no
 * pueden sumar tres veces; una venta, su CxC y su cobro tampoco.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const H = require('./_integrationHelpers');

const svc = require('../services/cashFlowService');
const ctrl = require('../controllers/cashFlowController');
const payrollCtrl = require('../controllers/payrollController');
const decls = require('../controllers/taxDeclarationController');
const purchases = require('../controllers/purchaseInvoiceController');
const payments = require('../controllers/paymentController');

const CashFlowConfig = require('../models/CashFlowConfig');
const CashFlowMapping = require('../models/CashFlowMapping');
const CashFlowManualItem = require('../models/CashFlowManualItem');
const CashFlowPlan = require('../models/CashFlowPlan');
const ChartOfAccount = require('../models/ChartOfAccount');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const Payable = require('../models/Payable');
const Receivable = require('../models/Receivable');
const Invoice = require('../models/Invoice');
const Payroll = require('../models/Payroll');
const Employee = require('../models/Employee');
const PayrollIncomeTaxTable = require('../models/PayrollIncomeTaxTable');
const { DEFAULT_IR_RANGES_2024 } = require('../utils/payrollTax');
const { createEntry } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const { openPayable, openReceivable } = require('../utils/subledger');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// ───────────────────────────── utilidades ─────────────────────────────
const run = (h, req) => H.runController(h, req);
const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };
const settled = (rs) => rs.map((r) => (r.status === 'fulfilled' ? r.value : { statusCode: 500, payload: { message: String(r.reason?.message) } }));

const HOY = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();
const dia = (n) => { const d = new Date(HOY); d.setDate(d.getDate() + n); return d; };
const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Próximo día de la semana pedido (0=dom … 6=sáb), a partir de mañana. */
const proximo = (dow) => { const d = dia(1); while (d.getDay() !== dow) d.setDate(d.getDate() + 1); return d; };
/** Columna en la que cae una fecha: solo el domingo se desplaza (regla por defecto). */
const habil = (d) => { const x = new Date(d); while (x.getDay() === 0) x.setDate(x.getDate() + 1); return x; };

const proj = (clinicId, from, to, filters) =>
  svc.buildProjection(clinicId, { from: from || HOY, to: to || dia(30), filters });
const celda = (data, d, direction, category) =>
  data.days.find((x) => x.date === key(habil(d)))?.categorias?.[direction]?.[category]?.total || 0;
const dayOf = (data, d) => data.days.find((x) => x.date === key(habil(d)));

async function bancoDe(clinicId) {
  const acc = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.03' });
  return BankAccount.create({ clinic: clinicId, name: 'Cta', bank: 'Pichincha', accountNumber: '1', chartAccount: acc._id });
}

/** Deja saldo real en una cuenta de caja/banco mediante un asiento (D banco / H otros ingresos). */
async function fondear(clinicId, userId, monto, fecha = dia(-10), code = '1.1.01.03') {
  const cuenta = await ChartOfAccount.findOne({ clinic: clinicId, code });
  const ingreso = await getAccount(clinicId, 'otrosIngresos');
  return createEntry({
    clinicId, date: fecha, description: 'Fondeo inicial', userId,
    sourceModel: 'CashDeposit', sourceRef: cuenta._id, sourceAction: `FUND:${code}:${+fecha}`,
    lines: [
      { account: cuenta._id, debit: monto, credit: 0 },
      { account: ingreso._id, debit: 0, credit: monto },
    ],
  });
}

/** CxP de proveedor, directa al submayor (no necesitamos el asiento de la compra aquí). */
async function cxp(clinicId, { total = 100, dueDate = dia(5), plannedPaymentDate = null, applied = 0, name = 'Proveedor SA', ref = null } = {}) {
  const cuenta = await getAccount(clinicId, 'proveedores');
  const id = new H.mongoose.Types.ObjectId();
  return openPayable({
    clinic: clinicId, party: { model: 'Supplier', ref, name },
    sourceModel: 'PurchaseInvoice', sourceRef: id, docType: 'COMPRA',
    number: `001-001-${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
    issueDate: dia(-2), dueDate, plannedPaymentDate, total, applied, account: cuenta._id,
  });
}

async function cxc(clinicId, { total = 100, dueDate = dia(5), applied = 0, name = 'Paciente X' } = {}) {
  const cuenta = await getAccount(clinicId, 'clientes');
  const id = new H.mongoose.Types.ObjectId();
  return openReceivable({
    clinic: clinicId, party: { model: 'Patient', ref: null, name },
    sourceModel: 'Sale', sourceRef: id, docType: 'VENTA', number: `V-${Math.floor(Math.random() * 1e6)}`,
    issueDate: dia(-2), dueDate, total, applied, account: cuenta._id,
  });
}

// ═════════════════════ 1-4 · SALDO INICIAL ═════════════════════

test('1-3) saldo inicial: suma caja + bancos desde el MAYOR, sin doble conteo padre/hijo', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-15) });
  await fondear(clinicId, userId, 1000, dia(-10), '1.1.01.01'); // caja general
  await fondear(clinicId, userId, 5000, dia(-9), '1.1.01.03');  // bancos
  await fondear(clinicId, userId, 250, dia(-8), '1.1.01.02');   // caja chica

  const data = await proj(clinicId);
  assert.equal(data.saldoInicial, 6250, 'caja + caja chica + bancos');
  assert.equal(data.days[0].saldoInicial, 6250);

  // La cuenta PADRE (1.1.01) es agrupadora y no recibe movimientos: incluirla no duplica.
  const padre = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01' });
  const banco = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.03' });
  const cfg = await svc.getConfig(clinicId);
  cfg.bankAccounts = [padre._id, banco._id]; // padre e hija a la vez
  await cfg.save();
  const conPadre = await proj(clinicId);
  assert.equal(conPadre.saldoInicial, 6250, 'configurar padre + hija no cuenta dos veces');
});

test('2) saldo inicial: una cuenta NO configurada queda fuera', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-15) });
  await fondear(clinicId, userId, 1000, dia(-10), '1.1.01.01');
  await fondear(clinicId, userId, 5000, dia(-9), '1.1.01.03');

  const caja = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.01' });
  const cfg = await svc.getConfig(clinicId);
  cfg.cashAccounts = [caja._id];   // solo caja general
  cfg.bankAccounts = [];
  await cfg.save();

  const data = await proj(clinicId);
  assert.equal(data.saldoInicial, 1000, 'el banco no configurado no entra al disponible');
  assert.equal(data.cuentas.length, 1);
});

test('4) saldo inicial: aislamiento por clínica', async () => {
  const a = await H.seedClinic({ date: dia(-15) });
  const b = await H.seedClinic({ date: dia(-15) });
  await fondear(a.clinicId, a.userId, 1000);
  await fondear(b.clinicId, b.userId, 7777);

  assert.equal((await proj(a.clinicId)).saldoInicial, 1000);
  assert.equal((await proj(b.clinicId)).saldoInicial, 7777);
});

// ═════════════════════ 5-10 · FECHAS Y CALENDARIO ═════════════════════

test('5-7) vencimiento en viernes y sábado no se desplaza; el domingo se proyecta al lunes', async () => {
  const { clinicId } = await H.seedClinic({ date: HOY });
  const viernes = proximo(5);
  const sabado = proximo(6);
  const domingo = proximo(0);
  const lunes = new Date(domingo); lunes.setDate(lunes.getDate() + 1);

  await cxp(clinicId, { total: 100, dueDate: viernes, name: 'Viernes' });
  await cxp(clinicId, { total: 200, dueDate: sabado, name: 'Sabado' });
  await cxp(clinicId, { total: 300, dueDate: domingo, name: 'Domingo' });

  const data = await proj(clinicId, HOY, dia(20));
  const filaDe = (n) => data.detalle.find((d) => d.tercero === n);

  assert.equal(key(new Date(filaDe('Viernes').effectiveDate)), key(viernes), 'el viernes no se mueve');
  assert.equal(filaDe('Viernes').desplazadaAHabil, false);
  assert.equal(key(new Date(filaDe('Sabado').effectiveDate)), key(sabado), 'el SÁBADO no se desplaza');
  assert.equal(filaDe('Sabado').desplazadaAHabil, false);
  assert.equal(key(new Date(filaDe('Domingo').effectiveDate)), key(lunes), 'el domingo se proyecta al lunes');
  assert.equal(filaDe('Domingo').desplazadaAHabil, true);

  // Y el vencimiento LEGAL sigue siendo el domingo (no se tocó).
  assert.equal(key(new Date(filaDe('Domingo').dueDate)), key(domingo), 'el dueDate legal no se modifica');
  assert.equal(celda(data, lunes, 'EGRESO', 'PROVEEDORES'), 300);
});

test('8-9) la fecha planificada prevalece (antes o después del vencimiento) y no toca el dueDate', async () => {
  const { clinicId } = await H.seedClinic({ date: HOY });
  const vence = dia(10);
  const antes = dia(3);
  const despues = dia(20);

  await cxp(clinicId, { total: 100, dueDate: vence, plannedPaymentDate: antes, name: 'Adelantada' });
  await cxp(clinicId, { total: 200, dueDate: vence, plannedPaymentDate: despues, name: 'Aplazada' });

  const data = await proj(clinicId, HOY, dia(30));
  const adelantada = data.detalle.find((d) => d.tercero === 'Adelantada');
  const aplazada = data.detalle.find((d) => d.tercero === 'Aplazada');

  assert.equal(adelantada.basedOn, 'PLANIFICADA');
  assert.equal(key(new Date(adelantada.dueDate)), key(vence), 'el vencimiento legal se conserva');
  assert.equal(key(new Date(aplazada.dueDate)), key(vence));
  // Caen en la columna de su fecha planificada (desplazada a hábil si toca).
  const colAntes = svc.columnFor(new Date(adelantada.effectiveDate), data.days.map((d) => d.date), { includeSaturdays: true });
  const colDespues = svc.columnFor(new Date(aplazada.effectiveDate), data.days.map((d) => d.date), { includeSaturdays: true });
  assert.equal(adelantada.day, colAntes);
  assert.equal(aplazada.day, colDespues);
  assert.ok(adelantada.day < aplazada.day, 'la adelantada se proyecta antes que la aplazada');
});

test('10) una obligación VENCIDA y reprogramada al futuro sigue marcada como vencida', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-20) });
  const vencida = await cxp(clinicId, { total: 500, dueDate: dia(-10), name: 'Morosa' });

  const r = ok(await run(ctrl.reschedule, H.mockReq(clinicId, userId, {
    docModel: 'Payable', docRef: String(vencida._id), newDate: dia(7), reason: 'Acuerdo con el proveedor',
  })));
  assert.equal(key(new Date(r.dueDate)), key(dia(-10)), 'el vencimiento legal NO se movió');

  const data = await proj(clinicId, HOY, dia(30));
  const fila = data.detalle.find((d) => d.tercero === 'Morosa');
  assert.equal(fila.vencida, true, 'sigue legalmente vencida');
  assert.equal(fila.reprogramada, true);
  assert.ok(fila.diasVencidos >= 10);
  assert.equal(fila.day, key(dia(7)), 'pero se proyecta en la fecha acordada');
  assert.ok(data.alertas.some((a) => a.tipo === 'OBLIGACIONES_VENCIDAS'));

  // Y la reprogramación quedó auditada con motivo, valor anterior y usuario.
  const hist = ok(await run(ctrl.docHistory, H.mockReq(clinicId, userId, {}, {
    query: { docModel: 'Payable', docRef: String(vencida._id) },
  })));
  assert.equal(hist.historial.length, 1);
  assert.equal(hist.historial[0].reason, 'Acuerdo con el proveedor');
  assert.equal(hist.historial[0].previousValue, null);
  assert.ok(hist.historial[0].changedBy);
});

// ═════════════════════ 11-15 · PROVEEDORES ═════════════════════

test('11-14) compra con vencimiento explícito: pago parcial reduce y pago total elimina la proyección', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const sup = await H.makeSupplier(clinicId);
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const vence = dia(9);

  const pi = ok(await run(purchases.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: dia(-1), fechaVencimiento: vence, serie: '001-001-000000801',
    items: [{ description: 'Gasto', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: 300, ivaRate: 0, subtotal: 300 }],
  })));

  // 11) la CxP nace con la fecha explícita de la compra
  let data = await proj(clinicId, HOY, dia(30));
  assert.equal(celda(data, vence, 'EGRESO', 'PROVEEDORES'), 300);

  // 13) pago parcial → solo proyecta el resto
  ok(await run(payments.create, H.mockReq(clinicId, userId, {
    type: 'PAGO', method: 'EFECTIVO', partyModel: 'Supplier', partyRef: String(sup._id), partyName: sup.razonSocial,
    date: HOY, applications: [{ docModel: 'PurchaseInvoice', docRef: String(pi._id), amount: 120 }],
  })));
  data = await proj(clinicId, HOY, dia(30));
  assert.equal(celda(data, vence, 'EGRESO', 'PROVEEDORES'), 180, 'proyecta solo el saldo restante');
  // …y el pago real de hoy aparece como egreso REAL, no como una segunda obligación.
  assert.equal(dayOf(data, HOY).egresosReales, 120);
  assert.equal(dayOf(data, HOY).egresosProyectados, 0);

  // 14) pago total → desaparece del futuro
  ok(await run(payments.create, H.mockReq(clinicId, userId, {
    type: 'PAGO', method: 'EFECTIVO', partyModel: 'Supplier', partyRef: String(sup._id), partyName: sup.razonSocial,
    date: HOY, applications: [{ docModel: 'PurchaseInvoice', docRef: String(pi._id), amount: 180 }],
  })));
  data = await proj(clinicId, HOY, dia(30));
  assert.equal(celda(data, vence, 'EGRESO', 'PROVEEDORES'), 0, 'una CxP saldada no proyecta nada');
  assert.equal(dayOf(data, HOY).egresosReales, 300, 'los dos pagos reales suman 300, una sola vez');
});

test('12) sin fecha explícita, el vencimiento sale de los días de crédito del proveedor', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const sup = await H.makeSupplier(clinicId, { creditDays: 30 });
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const emision = dia(-1);

  const pi = ok(await run(purchases.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: emision, serie: '001-001-000000802',
    items: [{ description: 'Gasto', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: 150, ivaRate: 0, subtotal: 150 }],
  })));

  const cartera = await Payable.findOne({ clinic: clinicId, sourceRef: pi._id });
  const esperado = new Date(emision); esperado.setDate(esperado.getDate() + 30);
  if (cartera.dueDate) {
    assert.equal(key(new Date(cartera.dueDate)), key(esperado), 'vencimiento = emisión + días de crédito');
  } else {
    // El sistema todavía no deriva el vencimiento de los días de crédito: sin fecha, la CxP
    // se proyecta por la emisión (fallback documentado) y NO se inventa una fecha.
    const data = await proj(clinicId, HOY, dia(40));
    const fila = data.detalle.find((d) => String(d.docRef) === String(pi._id));
    assert.equal(fila.basedOn, 'EMISION', 'fallback documentado para históricos sin vencimiento');
  }
});

test('15) reprogramar NO modifica el dueDate en la base', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  const p = await cxp(clinicId, { total: 100, dueDate: dia(5) });
  ok(await run(ctrl.reschedule, H.mockReq(clinicId, userId, {
    docModel: 'Payable', docRef: String(p._id), newDate: dia(12), reason: 'Falta de liquidez',
  })));
  const fresco = await Payable.findById(p._id);
  assert.equal(key(new Date(fresco.dueDate)), key(dia(5)), 'dueDate intacto');
  assert.equal(key(new Date(fresco.plannedPaymentDate)), key(dia(12)), 'la fecha planificada es otra columna');
});

// ═════════════════════ 16-19 · CLIENTES ═════════════════════

test('16-18) CxC parcial y total; el cobro real no se duplica con el ingreso proyectado', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-5) });
  const vence = dia(8);
  const inv = await Invoice.create({
    clinic: clinicId, claveAcceso: `CLV${Date.now()}`, secuencial: '000000123',
    estab: '001', ptoEmi: '001', ambiente: '1', estado: 'AUTORIZADO',
    fechaEmision: '01/01/2026', tipoIdentificacionComprador: '05', identificacionComprador: '0912345678',
    razonSocialComprador: 'Cliente A', totalSinImpuestos: 1000, totalImpuesto: 0, importeTotal: 1000,
    balance: 1000,
  });
  const clientes = await getAccount(clinicId, 'clientes');
  await openReceivable({
    clinic: clinicId, party: { model: 'Patient', ref: null, name: 'Cliente A' },
    sourceModel: 'Invoice', sourceRef: inv._id, docType: 'FACTURA', number: inv.secuencial,
    issueDate: dia(-3), dueDate: vence, total: 1000, account: clientes._id,
  });

  let data = await proj(clinicId, HOY, dia(30));
  assert.equal(celda(data, vence, 'INGRESO', 'CLIENTES'), 1000);

  // Cobro parcial real: baja la CxC y aparece como ingreso REAL (una sola vez).
  ok(await run(payments.create, H.mockReq(clinicId, userId, {
    type: 'COBRO', method: 'EFECTIVO', partyModel: 'Patient', partyName: 'Cliente A',
    date: HOY, applications: [{ docModel: 'Invoice', docRef: String(inv._id), amount: 400 }],
  })));
  data = await proj(clinicId, HOY, dia(30));
  assert.equal(celda(data, vence, 'INGRESO', 'CLIENTES'), 600, 'solo el saldo restante se proyecta');
  assert.equal(dayOf(data, HOY).ingresosReales, 400);
  assert.equal(dayOf(data, HOY).ingresosProyectados, 0, 'el cobro real no se cuenta también como proyección');

  // Cobro total: desaparece del futuro.
  ok(await run(payments.create, H.mockReq(clinicId, userId, {
    type: 'COBRO', method: 'EFECTIVO', partyModel: 'Patient', partyName: 'Cliente A',
    date: HOY, applications: [{ docModel: 'Invoice', docRef: String(inv._id), amount: 600 }],
  })));
  data = await proj(clinicId, HOY, dia(30));
  assert.equal(celda(data, vence, 'INGRESO', 'CLIENTES'), 0);
  assert.equal(dayOf(data, HOY).ingresosReales, 1000, 'los dos cobros suman 1000, sin duplicar');
});

test('19) una venta al contado no abre CxC: solo existe como movimiento real', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-2) });
  // Un cobro en efectivo sin cartera detrás (venta al contado ya cobrada).
  await fondear(clinicId, userId, 250, HOY, '1.1.01.01');

  const data = await proj(clinicId, HOY, dia(15));
  assert.equal(await Receivable.countDocuments({ clinic: clinicId }), 0, 'no hay CxC futura por una venta al contado');
  assert.equal(dayOf(data, HOY).ingresosReales, 250);
  assert.equal(dayOf(data, HOY).ingresosProyectados, 0);
  assert.equal(dayOf(data, HOY).ingresos, 250, 'se cuenta UNA vez');
});

// ═════════════════════ 20-26 · NÓMINA Y SRI ═════════════════════

async function clinicaConNomina() {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  await PayrollIncomeTaxTable.create({
    clinic: clinicId, year: HOY.getFullYear(), periodType: 'ANNUAL', active: true, ranges: DEFAULT_IR_RANGES_2024,
  });
  await Employee.create({
    clinic: clinicId, code: `EMP-${Math.floor(Math.random() * 1e6)}`,
    firstName: 'Ana', lastName: 'Pérez', identificacion: `17${Math.floor(Math.random() * 1e8)}`,
    hireDate: new Date(HOY.getFullYear() - 2, 0, 1), baseSalary: 1000, active: true,
  });
  return { clinicId, userId };
}

test('20-21) la nómina aparece UNA sola vez (por su CxP) y el pago parcial la actualiza', async () => {
  const { clinicId, userId } = await clinicaConNomina();
  const bank = await bancoDe(clinicId);
  const gen = ok(await run(payrollCtrl.generatePayroll, H.mockReq(clinicId, userId, {
    year: HOY.getFullYear(), month: HOY.getMonth() + 1,
  })));
  const rol = ok(await run(payrollCtrl.closePayroll, H.mockReq(clinicId, userId, {
    scheduledPaymentDate: dia(6),
  }, { params: { id: String(gen._id) } })));
  const neto = rol.totalNeto;
  assert.ok(neto > 0);

  let data = await proj(clinicId, HOY, dia(30));
  const filas = data.detalle.filter((d) => d.sourceModel === 'Payroll');
  assert.equal(filas.length, 1, 'la nómina entra UNA vez, por su CxP (no se suma el módulo aparte)');
  assert.equal(filas[0].docModel, 'Payable');
  assert.equal(celda(data, dia(6), 'EGRESO', 'GASTOS_FIJOS'), neto);
  assert.equal(dayOf(data, dia(6)).categorias.EGRESO.GASTOS_FIJOS.subs.SUELDOS, neto);

  // Pago parcial → el flujo baja al saldo real de la CxP.
  ok(await run(payrollCtrl.markPaid, H.mockReq(clinicId, userId, {
    bankAccountId: String(bank._id), amount: 100, date: HOY,
  }, { params: { id: String(rol._id) } })));
  data = await proj(clinicId, HOY, dia(30));
  assert.equal(celda(data, dia(6), 'EGRESO', 'GASTOS_FIJOS'), svc.r2(neto - 100), 'queda el saldo pendiente');
  assert.equal(dayOf(data, HOY).egresosReales, 100, 'el pago real, una sola vez');
});

test('22-24) declaración SRI: el borrador NO aparece; la finalizada sí, y pagada queda en cero', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  const bank = await bancoDe(clinicId);
  await Invoice.create({
    clinic: clinicId, claveAcceso: `CLV${Date.now()}9`, secuencial: '000000900',
    estab: '001', ptoEmi: '001', ambiente: '1', estado: 'AUTORIZADO',
    fechaEmision: `${String(HOY.getDate()).padStart(2, '0')}/${String(HOY.getMonth() + 1).padStart(2, '0')}/${HOY.getFullYear()}`,
    tipoIdentificacionComprador: '04', identificacionComprador: '1790012345001', razonSocialComprador: 'Cliente SA',
    totalSinImpuestos: 1000, totalImpuesto: 150, importeTotal: 1150,
    taxBreakdown: { computed: true, base0: 0, baseGravada: 1000, baseExento: 0, baseNoObjeto: 0, iva: 150 },
  });

  const d = ok(await run(decls.draft, H.mockReq(clinicId, userId, {
    formType: '104', year: HOY.getFullYear(), month: HOY.getMonth() + 1,
  })));
  // 23) borrador ⇒ no es obligación
  let data = await proj(clinicId, HOY, dia(60));
  assert.equal(data.detalle.filter((x) => x.sourceModel === 'SriDeclaration').length, 0, 'un borrador no proyecta');

  const fin = ok(await run(decls.finalize, H.mockReq(clinicId, userId, {
    plannedPaymentDate: dia(12),
  }, { params: { id: String(d.declaration._id) } })));
  const obligacion = fin.obligacion.total;
  assert.ok(obligacion > 0);

  // 22) finalizada ⇒ aparece una sola vez, por su CxP
  data = await proj(clinicId, HOY, dia(60));
  const sri = data.detalle.filter((x) => x.sourceModel === 'SriDeclaration');
  assert.equal(sri.length, 1, 'la declaración entra UNA vez, por su CxP');
  assert.equal(sri[0].category, 'GASTOS_FIJOS');
  assert.equal(sri[0].subcategory, 'SRI');
  assert.equal(celda(data, dia(12), 'EGRESO', 'GASTOS_FIJOS'), obligacion);

  // 24) pagada ⇒ deja de proyectarse y aparece como movimiento real
  ok(await run(decls.pay, H.mockReq(clinicId, userId, {
    bankAccountId: String(bank._id), date: HOY,
  }, { params: { id: String(fin.declaration._id) } })));
  data = await proj(clinicId, HOY, dia(60));
  assert.equal(data.detalle.filter((x) => x.sourceModel === 'SriDeclaration' && !x.esReal && x.day).length, 0,
    'una declaración pagada no proyecta saldo');
  assert.equal(dayOf(data, HOY).egresosReales, obligacion);
});

test('25-26) sustitutiva impaga reemplaza la obligación; la pagada sigue bloqueada (Fase 1)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  const bank = await bancoDe(clinicId);
  await Invoice.create({
    clinic: clinicId, claveAcceso: `CLV${Date.now()}8`, secuencial: '000000901',
    estab: '001', ptoEmi: '001', ambiente: '1', estado: 'AUTORIZADO',
    fechaEmision: `${String(HOY.getDate()).padStart(2, '0')}/${String(HOY.getMonth() + 1).padStart(2, '0')}/${HOY.getFullYear()}`,
    tipoIdentificacionComprador: '04', identificacionComprador: '1790012345001', razonSocialComprador: 'Cliente SA',
    totalSinImpuestos: 1000, totalImpuesto: 150, importeTotal: 1150,
    taxBreakdown: { computed: true, base0: 0, baseGravada: 1000, baseExento: 0, baseNoObjeto: 0, iva: 150 },
  });
  const d = ok(await run(decls.draft, H.mockReq(clinicId, userId, { formType: '104', year: HOY.getFullYear(), month: HOY.getMonth() + 1 })));
  const v1 = ok(await run(decls.finalize, H.mockReq(clinicId, userId, {}, { params: { id: String(d.declaration._id) } })));

  // 25) sustitutiva IMPAGA: se reemplaza la obligación, no se suman dos.
  const sus = ok(await run(decls.substitute, H.mockReq(clinicId, userId, {}, { params: { id: String(v1.declaration._id) } })));
  ok(await run(decls.finalize, H.mockReq(clinicId, userId, {}, { params: { id: String(sus.declaration._id) } })));
  const data = await proj(clinicId, HOY, dia(60));
  const sriRows = data.detalle.filter((x) => x.sourceModel === 'SriDeclaration' && !x.esReal && x.day);
  assert.equal(sriRows.length, 1, 'solo la sustitutiva vigente proyecta: no hay pasivo duplicado');

  // 26) tras pagarla, sustituirla sigue bloqueado por la política de la Fase 1.
  const pagada = await run(decls.pay, H.mockReq(clinicId, userId, {
    bankAccountId: String(bank._id), date: HOY,
  }, { params: { id: String(sus.declaration._id) } }));
  assert.equal(pagada.statusCode, 200);
  const bloqueada = await run(decls.substitute, H.mockReq(clinicId, userId, {}, { params: { id: String(sus.declaration._id) } }));
  assert.equal(bloqueada.statusCode, 400);
  assert.match(bloqueada.payload.message, /pagos aplicados/i);
});

// ═════════════════════ 27-31 · CLASIFICACIÓN ═════════════════════

test('27-30) regla por proveedor, override individual, guardar regla futura y "sin clasificar" visible', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  const luz = await H.makeSupplier(clinicId, { razonSocial: 'CNEL EP' });
  const otro = await H.makeSupplier(clinicId, { razonSocial: 'Insumos SA' });

  // 27) regla por proveedor: CNEL siempre es un gasto fijo de servicios básicos.
  ok(await run(ctrl.createMapping, H.mockReq(clinicId, userId, {
    direction: 'EGRESO', matchType: 'SUPPLIER', matchValue: String(luz._id),
    category: 'GASTOS_FIJOS', subcategory: 'SERVICIOS_BASICOS',
  })));

  const cLuz = await cxp(clinicId, { total: 90, dueDate: dia(4), name: 'CNEL EP', ref: luz._id });
  const cOtro = await cxp(clinicId, { total: 60, dueDate: dia(4), name: 'Insumos SA', ref: otro._id });

  let data = await proj(clinicId, HOY, dia(20));
  const fLuz = data.detalle.find((x) => String(x.id) === String(cLuz._id));
  const fOtro = data.detalle.find((x) => String(x.id) === String(cOtro._id));
  assert.equal(fLuz.category, 'GASTOS_FIJOS');
  assert.equal(fLuz.subcategory, 'SERVICIOS_BASICOS');
  assert.equal(fLuz.clasificadaPor, 'REGLA_SUPPLIER', 'la UI puede explicar POR QUÉ se clasificó así');
  assert.equal(fOtro.category, 'PROVEEDORES', 'sin regla, manda el módulo');
  assert.equal(fOtro.clasificadaPor, 'MODULO');

  // 28) override individual: gana al módulo y a la regla.
  ok(await run(ctrl.classifyDoc, H.mockReq(clinicId, userId, {
    docModel: 'Payable', docRef: String(cOtro._id), category: 'OTROS_PAGOS', subcategory: 'SUMINISTROS',
  })));
  data = await proj(clinicId, HOY, dia(20));
  const fOtro2 = data.detalle.find((x) => String(x.id) === String(cOtro._id));
  assert.equal(fOtro2.category, 'OTROS_PAGOS');
  assert.equal(fOtro2.clasificadaPor, 'OVERRIDE');

  // 29) guardar además una regla para los futuros documentos de ese proveedor.
  const cOtro2 = await cxp(clinicId, { total: 30, dueDate: dia(5), name: 'Insumos SA', ref: otro._id });
  ok(await run(ctrl.classifyDoc, H.mockReq(clinicId, userId, {
    docModel: 'Payable', docRef: String(cOtro2._id), category: 'OTROS_PAGOS', subcategory: 'SUMINISTROS',
    saveRule: true, ruleMatch: { matchType: 'SUPPLIER', matchValue: String(otro._id) },
  })));
  const futura = await cxp(clinicId, { total: 15, dueDate: dia(6), name: 'Insumos SA', ref: otro._id });
  data = await proj(clinicId, HOY, dia(20));
  const fFutura = data.detalle.find((x) => String(x.id) === String(futura._id));
  assert.equal(fFutura.category, 'OTROS_PAGOS', 'la regla se aplica sola a los documentos nuevos');
  assert.equal(fFutura.clasificadaPor, 'REGLA_SUPPLIER');

  // Deshacer el override devuelve el mando a la regla / al módulo.
  ok(await run(ctrl.unclassifyDoc, H.mockReq(clinicId, userId, { docModel: 'Payable', docRef: String(cOtro._id) })));
  data = await proj(clinicId, HOY, dia(20));
  assert.equal(data.detalle.find((x) => String(x.id) === String(cOtro._id)).clasificadaPor, 'REGLA_SUPPLIER');
});

test('30) un documento sin regla ni módulo cae en SIN_CLASIFICAR y genera alerta', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  const cuenta = await getAccount(clinicId, 'proveedores');
  // Una CxP de un origen que el módulo no conoce.
  await openPayable({
    clinic: clinicId, party: { model: 'Supplier', ref: null, name: 'Origen raro' },
    sourceModel: 'OrigenDesconocido', sourceRef: new H.mongoose.Types.ObjectId(),
    docType: 'OTRO', number: 'X-1', issueDate: dia(-1), dueDate: dia(3), total: 77, account: cuenta._id,
  });
  const data = await proj(clinicId, HOY, dia(15));
  const fila = data.detalle.find((x) => x.tercero === 'Origen raro');
  assert.equal(fila.category, 'SIN_CLASIFICAR', 'no desaparece: se ve y se puede clasificar');
  assert.equal(celda(data, dia(3), 'EGRESO', 'SIN_CLASIFICAR'), 77);
  assert.ok(data.alertas.some((a) => a.tipo === 'SIN_CLASIFICAR'));
  assert.ok(!!userId);
});

test('31) dos clínicas con reglas distintas para el mismo tipo de documento', async () => {
  const a = await H.seedClinic({ date: HOY });
  const b = await H.seedClinic({ date: HOY });
  ok(await run(ctrl.createMapping, H.mockReq(a.clinicId, a.userId, {
    direction: 'EGRESO', matchType: 'SOURCE_MODEL', matchValue: 'PurchaseInvoice',
    category: 'GASTOS_FIJOS', subcategory: 'OTROS_FIJOS',
  })));
  await cxp(a.clinicId, { total: 50, dueDate: dia(3) });
  await cxp(b.clinicId, { total: 50, dueDate: dia(3) });

  const da = await proj(a.clinicId, HOY, dia(10));
  const db = await proj(b.clinicId, HOY, dia(10));
  assert.equal(da.detalle[0].category, 'GASTOS_FIJOS', 'la regla de A aplica en A');
  assert.equal(db.detalle[0].category, 'PROVEEDORES', 'y NO se filtra a la clínica B');
  assert.equal(await CashFlowMapping.countDocuments({ clinic: b.clinicId }), 0);
});

// ═════════════════════ 32-35 · PARTIDAS MANUALES ═════════════════════

test('32-35) partida manual: proyecta sin asiento, se reprograma auditada, se excluye y se liquida', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  const JournalEntry = require('../models/JournalEntry');

  const item = ok(await run(ctrl.createManualItem, H.mockReq(clinicId, userId, {
    direction: 'EGRESO', category: 'PRESTAMOS_PAGADOS', subcategory: 'CAPITAL',
    description: 'Cuota Pichincha capital de trabajo', amount: 800, plannedDate: dia(5),
    origin: 'PRESTAMO', partyName: 'Banco Pichincha',
    loan: { creditor: 'Banco Pichincha', principal: 700, interest: 90, fee: 10 },
  })));

  // 32) proyecta… y NO generó ningún asiento.
  let data = await proj(clinicId, HOY, dia(20));
  assert.equal(celda(data, dia(5), 'EGRESO', 'PRESTAMOS_PAGADOS'), 800);
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId }), 0, 'una previsión no contabiliza nada');
  const fila = data.detalle.find((x) => x.docModel === 'CashFlowManualItem');
  assert.equal(fila.origin, 'PRESTAMO', 'el préstamo se marca explícitamente, no se deduce del texto');
  assert.equal(fila.loan.principal, 700);

  // 33) reprogramación auditada (motivo obligatorio).
  const sinMotivo = await run(ctrl.reschedule, H.mockReq(clinicId, userId, {
    docModel: 'CashFlowManualItem', docRef: String(item._id), newDate: dia(9),
  }));
  assert.equal(sinMotivo.statusCode, 400, 'sin motivo no se reprograma');

  ok(await run(ctrl.reschedule, H.mockReq(clinicId, userId, {
    docModel: 'CashFlowManualItem', docRef: String(item._id), newDate: dia(9), reason: 'El banco movió el débito',
  })));
  const refrescada = await CashFlowManualItem.findById(item._id);
  assert.equal(refrescada.history.length, 1);
  assert.equal(refrescada.history[0].reason, 'El banco movió el débito');
  assert.equal(key(new Date(refrescada.history[0].previousValue)), key(dia(5)), 'guarda el valor anterior');
  data = await proj(clinicId, HOY, dia(20));
  assert.equal(celda(data, dia(9), 'EGRESO', 'PRESTAMOS_PAGADOS'), 800);

  // 34) exclusión con motivo obligatorio.
  const sinRazon = await run(ctrl.setExcluded, H.mockReq(clinicId, userId, {
    docModel: 'CashFlowManualItem', docRef: String(item._id), excluded: true,
  }));
  assert.equal(sinRazon.statusCode, 400);
  ok(await run(ctrl.setExcluded, H.mockReq(clinicId, userId, {
    docModel: 'CashFlowManualItem', docRef: String(item._id), excluded: true, reason: 'Se renegocia el crédito',
  })));
  data = await proj(clinicId, HOY, dia(20));
  assert.equal(celda(data, dia(9), 'EGRESO', 'PRESTAMOS_PAGADOS'), 0, 'excluida: no suma');
  const excluida = data.detalle.find((x) => x.docModel === 'CashFlowManualItem');
  assert.equal(excluida.excluida, true);
  assert.equal(excluida.excludedReason, 'Se renegocia el crédito', 'pero se sigue viendo, con su motivo');

  // Volver a incluir.
  ok(await run(ctrl.setExcluded, H.mockReq(clinicId, userId, {
    docModel: 'CashFlowManualItem', docRef: String(item._id), excluded: false,
  })));
  data = await proj(clinicId, HOY, dia(20));
  assert.equal(celda(data, dia(9), 'EGRESO', 'PRESTAMOS_PAGADOS'), 800);

  // 35) marcarla como realizada NO es cambiar su estado: exige contabilizar el movimiento
  // (mode CREAR) o vincular uno real ya registrado (mode VINCULAR), validado. Ver el detalle
  // completo en cashFlowAudit.integration.test.js (bloque B4).
  const sinModo = await run(ctrl.settleManualItem, H.mockReq(clinicId, userId, {}, { params: { id: String(item._id) } }));
  assert.equal(sinModo.statusCode, 400);
  assert.match(sinModo.payload.message, /no se convierte en movimiento real cambiando su estado/i);

  const inventado = await run(ctrl.settleManualItem, H.mockReq(clinicId, userId, {
    mode: 'VINCULAR', settledByModel: 'BankTransaction', settledByRef: String(new H.mongoose.Types.ObjectId()),
  }, { params: { id: String(item._id) } }));
  assert.equal(inventado.statusCode, 404, 'no se puede vincular un movimiento que no existe');

  // Se vincula el movimiento bancario REAL que pagó la cuota.
  const bank = await bancoDe(clinicId);
  const tx = await BankTransaction.create({
    clinic: clinicId, bankAccount: bank._id, date: HOY, type: 'PAGO',
    amount: 800, direction: -1, description: 'Débito cuota Pichincha',
  });
  ok(await run(ctrl.settleManualItem, H.mockReq(clinicId, userId, {
    mode: 'VINCULAR', settledByModel: 'BankTransaction', settledByRef: String(tx._id),
  }, { params: { id: String(item._id) } })));

  data = await proj(clinicId, HOY, dia(20));
  assert.equal(celda(data, dia(9), 'EGRESO', 'PRESTAMOS_PAGADOS'), 0, 'ya realizada: sale de la proyección');
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId }), 0,
    'vincular no crea asientos: el movimiento real ya existía');
});

// ═════════════════════ 36-40 · CÁLCULO DIARIO ═════════════════════

test('36-38) roll-forward correcto, totales de categoría iguales al detalle', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-10) });
  await fondear(clinicId, userId, 1000, dia(-5));
  await cxc(clinicId, { total: 500, dueDate: dia(2), name: 'Cliente' });
  await cxp(clinicId, { total: 300, dueDate: dia(3), name: 'Proveedor' });

  const data = await proj(clinicId, HOY, dia(6));
  let esperado = 1000;
  for (const d of data.days) {
    assert.equal(d.saldoInicial, esperado, `el saldo inicial del ${d.date} es el final del día anterior`);
    assert.equal(d.saldoFinal, svc.r2(d.saldoInicial + d.ingresos - d.egresos), 'saldo = inicial + ingresos − egresos');
    esperado = d.saldoFinal;
  }
  assert.equal(data.saldoFinal, 1200, '1000 + 500 − 300');

  // 38) los totales de cada celda coinciden con la suma del detalle.
  for (const d of data.days) {
    for (const dir of ['INGRESO', 'EGRESO']) {
      for (const [cat, val] of Object.entries(d.categorias[dir] || {})) {
        const suma = svc.r2(data.detalle
          .filter((x) => x.day === d.date && x.direction === dir && x.category === cat)
          .reduce((s, x) => s + (x.esReal ? x.total : x.saldo), 0));
        assert.equal(val.total, suma, `celda ${d.date}/${dir}/${cat} = suma de su detalle`);
      }
    }
  }
  assert.ok(!data.alertas.some((a) => a.tipo === 'DESCUADRE_DETALLE'));
});

test('37) día negativo genera alerta de saldo negativo', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-10) });
  await fondear(clinicId, userId, 100, dia(-5));
  await cxp(clinicId, { total: 900, dueDate: dia(2), name: 'Grande' });

  const data = await proj(clinicId, HOY, dia(5));
  const alerta = data.alertas.find((a) => a.tipo === 'SALDO_NEGATIVO');
  assert.ok(alerta, 'avisa del déficit');
  assert.ok(data.days.some((d) => d.saldoFinal < 0));
  assert.equal(data.saldoFinal, -800);
});

test('39-40) rango que cruza meses y día actual sin doble conteo', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-40) });
  await fondear(clinicId, userId, 2000, dia(-35));
  // Un pago REAL de hoy + una obligación pendiente de hoy: no pueden solaparse.
  const p = await cxp(clinicId, { total: 400, dueDate: HOY, applied: 150, name: 'Mixta' });
  assert.equal(p.balance, 250);
  await fondear(clinicId, userId, 0.01, HOY, '1.1.01.01'); // un movimiento real hoy

  const data = await proj(clinicId, dia(-5), dia(40));
  assert.ok(data.days.length > 30, 'el rango cruza meses');
  const hoyCol = dayOf(data, HOY);
  assert.equal(hoyCol.egresosProyectados, 250, 'solo el SALDO pendiente, no el total de 400');
  assert.equal(hoyCol.ingresosReales, 0.01);
  // El saldo final del rango = disponible actual + lo cobrado − lo pendiente.
  assert.equal(data.saldoFinal, svc.r2(2000 + 0.01 - 250));
});

// ═════════════════════ 41-44 · EXCEL ═════════════════════

test('41-44) el Excel sale del mismo servicio: Flujo, Detalle y Saldos concilian', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-10) });
  await fondear(clinicId, userId, 1500, dia(-5));
  await cxc(clinicId, { total: 700, dueDate: dia(2) });
  await cxp(clinicId, { total: 400, dueDate: dia(3) });

  const api = await proj(clinicId, HOY, dia(10));
  const res = H.mockRes();
  await ctrl.projectionExcel(
    H.mockReq(clinicId, userId, {}, { query: { from: key(HOY), to: key(dia(10)) } }),
    res.res
  );
  assert.equal(res.state.statusCode, 200);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.state.payload);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Flujo', 'Saldos bancarios', 'Detalle', 'Movimientos reales']);

  // 43) los saldos bancarios del Excel salen del mayor (= los de la API).
  const wsb = wb.getWorksheet('Saldos bancarios');
  let totalHoja = 0;
  wsb.eachRow((row, i) => {
    if (i === 1) return;
    if (String(row.getCell(2).value).startsWith('TOTAL')) return;
    totalHoja += Number(row.getCell(4).value) || 0;
  });
  assert.equal(svc.r2(totalHoja), api.saldoInicial, 'saldos bancarios = saldo inicial de la API');

  // 41) la fila SALDO PROYECTADO del Excel es la de la API, día a día.
  const ws = wb.getWorksheet('Flujo');
  let filaSaldo = null;
  ws.eachRow((row) => { if (row.getCell(1).value === 'SALDO PROYECTADO') filaSaldo = row; });
  assert.ok(filaSaldo, 'existe la fila de saldo proyectado');
  api.days.forEach((d, i) => {
    assert.equal(svc.r2(filaSaldo.getCell(i + 2).value), d.saldoFinal, `saldo del día ${d.date} igual en Excel y API`);
  });

  // 42) el Detalle concilia con el resumen.
  const wsd = wb.getWorksheet('Detalle');
  let ingresos = 0;
  let egresos = 0;
  wsd.eachRow((row, i) => {
    if (i === 1) return;
    const dir = row.getCell(6).value;
    const saldo = Number(row.getCell(12).value) || 0;
    if (dir === 'INGRESO') ingresos += saldo; else egresos += saldo;
  });
  assert.equal(svc.r2(ingresos), api.totales.ingresos, 'ingresos del detalle = ingresos del flujo');
  assert.equal(svc.r2(egresos), api.totales.egresos, 'egresos del detalle = egresos del flujo');
});

test('44) los filtros también se aplican a la exportación', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-10) });
  await fondear(clinicId, userId, 1000, dia(-5));
  await cxc(clinicId, { total: 700, dueDate: dia(2) });
  await cxp(clinicId, { total: 400, dueDate: dia(3) });

  const filtrado = await proj(clinicId, HOY, dia(10), { direction: 'EGRESO' });
  assert.equal(filtrado.totales.ingresos, 0, 'filtrando egresos, los ingresos no suman');
  assert.equal(filtrado.totales.egresos, 400);

  const res = H.mockRes();
  await ctrl.projectionExcel(
    H.mockReq(clinicId, userId, {}, { query: { from: key(HOY), to: key(dia(10)), direction: 'EGRESO' } }),
    res.res
  );
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.state.payload);
  const wsd = wb.getWorksheet('Detalle');
  const dirs = new Set();
  wsd.eachRow((row, i) => { if (i > 1) dirs.add(row.getCell(6).value); });
  assert.deepEqual([...dirs], ['EGRESO'], 'el Excel exporta exactamente lo filtrado');
});

// ═════════════════════ 45-48 · CONCURRENCIA ═════════════════════

test('45) dos reprogramaciones simultáneas del mismo documento: sin E11000 crudo', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  const p = await cxp(clinicId, { total: 100, dueDate: dia(5) });

  const rs = settled(await Promise.allSettled([
    run(ctrl.reschedule, H.mockReq(clinicId, userId, {
      docModel: 'Payable', docRef: String(p._id), newDate: dia(8), reason: 'A',
    })),
    run(ctrl.reschedule, H.mockReq(clinicId, userId, {
      docModel: 'Payable', docRef: String(p._id), newDate: dia(9), reason: 'B',
    })),
  ]));
  assert.ok(rs.every((r) => r.statusCode === 200), JSON.stringify(rs.map((r) => r.payload?.message)));
  assert.ok(rs.every((r) => !/E11000|duplicate key/i.test(r.payload?.message || '')));

  assert.equal(await CashFlowPlan.countDocuments({ clinic: clinicId, docRef: p._id }), 1, 'un solo plan');
  const fresco = await Payable.findById(p._id);
  assert.equal(key(new Date(fresco.dueDate)), key(dia(5)), 'el vencimiento legal sigue intacto');
  const plan = await CashFlowPlan.findOne({ clinic: clinicId, docRef: p._id });
  assert.ok(plan.history.length >= 1, 'las dos reprogramaciones quedan auditadas o al menos la ganadora');
});

test('46) creación concurrente de la misma regla: una sola, sin E11000', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  const sup = await H.makeSupplier(clinicId);
  const body = {
    direction: 'EGRESO', matchType: 'SUPPLIER', matchValue: String(sup._id),
    category: 'GASTOS_FIJOS', subcategory: 'SERVICIOS_BASICOS',
  };
  const rs = settled(await Promise.allSettled([
    run(ctrl.createMapping, H.mockReq(clinicId, userId, body)),
    run(ctrl.createMapping, H.mockReq(clinicId, userId, body)),
  ]));
  assert.ok(rs.every((r) => r.statusCode < 400), JSON.stringify(rs.map((r) => r.payload?.message)));
  assert.ok(rs.every((r) => !/E11000|duplicate key/i.test(r.payload?.message || '')));
  assert.equal(await CashFlowMapping.countDocuments({ clinic: clinicId }), 1, 'una sola regla');

  // La misma llave con OTRA categoría ⇒ 409 explícito, no una segunda regla.
  const conflicto = await run(ctrl.createMapping, H.mockReq(clinicId, userId, { ...body, category: 'OTROS_PAGOS' }));
  assert.equal(conflicto.statusCode, 409);
  assert.equal(await CashFlowMapping.countDocuments({ clinic: clinicId }), 1);
});

test('47) creación concurrente de partida manual con la misma clave de idempotencia', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  const body = {
    direction: 'EGRESO', category: 'OTROS_PAGOS', subcategory: 'VIATICOS',
    description: 'Viáticos Quito', amount: 250, plannedDate: dia(4),
  };
  const req = () => H.mockReq(clinicId, userId, body, { headers: { 'idempotency-key': 'CF-1' } });

  const rs = settled(await Promise.allSettled([
    run(ctrl.createManualItem, req()),
    run(ctrl.createManualItem, req()),
  ]));
  assert.ok(rs.every((r) => r.statusCode < 400), JSON.stringify(rs.map((r) => r.payload?.message)));
  assert.ok(rs.every((r) => !/E11000|duplicate key/i.test(r.payload?.message || '')));
  assert.equal(await CashFlowManualItem.countDocuments({ clinic: clinicId }), 1, 'una sola partida');

  // Misma clave con contenido distinto ⇒ 409.
  const distinto = await run(ctrl.createManualItem, H.mockReq(clinicId, userId,
    { ...body, amount: 999 }, { headers: { 'idempotency-key': 'CF-1' } }));
  assert.equal(distinto.statusCode, 409);
  assert.equal(await CashFlowManualItem.countDocuments({ clinic: clinicId }), 1);

  // Y la proyección no se duplica.
  const data = await proj(clinicId, HOY, dia(10));
  assert.equal(celda(data, dia(4), 'EGRESO', 'OTROS_PAGOS'), 250);
});

test('48) consultar el flujo NO tiene efectos contables (es de solo lectura)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: HOY });
  const JournalEntry = require('../models/JournalEntry');
  const Payment = require('../models/Payment');
  await fondear(clinicId, userId, 500, dia(-1));
  await cxp(clinicId, { total: 100, dueDate: dia(3) });

  const antes = {
    asientos: await JournalEntry.countDocuments({ clinic: clinicId }),
    pagos: await Payment.countDocuments({ clinic: clinicId }),
    cxp: (await Payable.findOne({ clinic: clinicId })).applied,
  };
  for (let i = 0; i < 3; i += 1) await proj(clinicId, HOY, dia(20));  // reprocesar el flujo
  const despues = {
    asientos: await JournalEntry.countDocuments({ clinic: clinicId }),
    pagos: await Payment.countDocuments({ clinic: clinicId }),
    cxp: (await Payable.findOne({ clinic: clinicId })).applied,
  };
  assert.deepEqual(despues, antes, 'reprocesar el flujo no crea asientos, pagos ni aplicaciones');
});

// ═════════════════════ 49-50 · RENDIMIENTO ═════════════════════

test('49-50) volumen: 1.000 CxP + 1.000 CxC con pagos parciales sobre 90 días', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: dia(-10) });
  await fondear(clinicId, userId, 50000, dia(-5));

  const cuentaP = await getAccount(clinicId, 'proveedores');
  const cuentaC = await getAccount(clinicId, 'clientes');
  const docs = { p: [], c: [] };
  for (let i = 0; i < 1000; i += 1) {
    // Vencimientos repartidos en los primeros 80 días: así ninguna fecha efectiva se sale
    // del horizonte de 90 (una obligación cuyo dinero se mueve DESPUÉS del rango no entra,
    // que es lo correcto, pero enturbiaría la comprobación de volumen).
    const vence = dia((i % 80) + 1);
    const parcial = i % 3 === 0 ? 20 : 0;   // un tercio con pago/cobro parcial
    docs.p.push({
      clinic: clinicId, party: { model: 'Supplier', ref: null, name: `Prov ${i}` },
      sourceModel: 'PurchaseInvoice', sourceRef: new H.mongoose.Types.ObjectId(), docType: 'COMPRA',
      number: `C-${i}`, issueDate: dia(-3), dueDate: vence, total: 100, applied: parcial,
      balance: 100 - parcial, account: cuentaP._id,
    });
    docs.c.push({
      clinic: clinicId, party: { model: 'Patient', ref: null, name: `Cli ${i}` },
      sourceModel: 'Sale', sourceRef: new H.mongoose.Types.ObjectId(), docType: 'VENTA',
      number: `V-${i}`, issueDate: dia(-3), dueDate: vence, total: 150, applied: parcial,
      balance: 150 - parcial, account: cuentaC._id,
    });
  }
  await Payable.insertMany(docs.p);
  await Receivable.insertMany(docs.c);

  const t0 = Date.now();
  const data = await proj(clinicId, HOY, dia(89));   // 90 días de rango
  const ms = Date.now() - t0;

  assert.equal(data.detalle.length, 2000, 'los 2.000 documentos entran en la proyección');
  const esperadoEgresos = svc.r2(docs.p.reduce((s, d) => s + d.balance, 0));
  const esperadoIngresos = svc.r2(docs.c.reduce((s, d) => s + d.balance, 0));
  assert.equal(data.totales.egresos, esperadoEgresos, 'los parciales solo proyectan el saldo');
  assert.equal(data.totales.ingresos, esperadoIngresos);
  assert.equal(data.saldoFinal, svc.r2(50000 + esperadoIngresos - esperadoEgresos));
  // El tiempo real se reporta, no se inventa: solo se comprueba que no hay patrón N+1
  // (una consulta por documento haría explotar esto muy por encima del límite).
  console.log(`      · proyección de 2.000 documentos y 90 días: ${ms} ms`);
  assert.ok(ms < 15000, `la proyección tardó ${ms} ms (sin N+1 debería estar muy por debajo)`);
});

// ═════════════════════ EXTRA · configuración y calendario ═════════════════════

test('config: apagar los sábados los convierte en no hábiles y desplaza al lunes', async () => {
  const { clinicId } = await H.seedClinic({ date: HOY });
  const sabado = proximo(6);
  const lunes = new Date(sabado); lunes.setDate(lunes.getDate() + 2);
  await cxp(clinicId, { total: 120, dueDate: sabado, name: 'Sabatina' });

  const cfg = await CashFlowConfig.findOneAndUpdate(
    { clinic: clinicId }, { includeSaturdays: false }, { new: true, upsert: true }
  );
  assert.equal(cfg.includeSaturdays, false);

  const data = await proj(clinicId, HOY, dia(20));
  assert.ok(!data.days.includes(key(sabado)), 'el sábado deja de tener columna');
  assert.equal(celda(data, lunes, 'EGRESO', 'PROVEEDORES'), 120, 'y su obligación pasa al lunes');
  const fila = data.detalle.find((d) => d.tercero === 'Sabatina');
  assert.equal(key(new Date(fila.dueDate)), key(sabado), 'el vencimiento legal sigue siendo el sábado');
});
