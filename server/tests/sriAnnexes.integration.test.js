/**
 * ANEXOS DEL SRI: RDEP (anual, del Formulario 103) y Anexo de Accionistas (APS).
 *
 * Lo que se comprueba:
 *   RDEP — sale de las nóminas CERRADAS del año (los BORRADORES no entran, como en el 103);
 *          los campos capturados por el contador se guardan y bajan la base imponible; los
 *          campos calculados NO son capturables (se rechazan en vez de ignorarse en silencio);
 *          la base gravada del anexo coincide con la que el 103 declara (misma fuente).
 *   APS  — la participación de los titulares de capital debe sumar 100 %; los miembros del
 *          directorio no cuentan para ese 100 %; un titular con `fechaHasta` sale del anexo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const annex = require('../controllers/sriAnnexController');
const Employee = require('../models/Employee');
const Payroll = require('../models/Payroll');
const PayrollIncomeTaxTable = require('../models/PayrollIncomeTaxTable');
const Shareholder = require('../models/Shareholder');
const { payrollWithholdingForPeriod } = require('../utils/payrollWithholding');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const YEAR = new Date().getFullYear();

async function makeEmployee(clinicId, { identificacion, nombre = 'Ana Gómez', position = 'Contadora' }) {
  return Employee.create({
    clinic: clinicId, code: `EMP-${identificacion}`, identificacion,
    firstName: nombre.split(' ')[0], lastName: nombre.split(' ').slice(1).join(' ') || 'X',
    hireDate: new Date(YEAR - 2, 0, 1), baseSalary: 1000, position,
  });
}

/** Rol CERRADO de un mes con un empleado (sueldo + comisión gravada + décimos no gravados). */
async function makePayroll(clinicId, emp, { month, status = 'CERRADO', baseSalary = 1000, commissions = 200, iess = 112.05, ir = 30 }) {
  return Payroll.create({
    clinic: clinicId, year: YEAR, month, period: `${YEAR}-${String(month).padStart(2, '0')}`,
    status, periodType: 'MENSUAL',
    items: [{
      employee: emp._id, employeeName: `${emp.firstName} ${emp.lastName}`, identificacion: emp.identificacion,
      baseSalary, commissions, decimoTercero: 100, decimoCuarto: 40,
      iessPersonal: iess, impuestoRenta: ir,
    }],
  });
}

const call = (handler, clinicId, userId, body = {}, query = {}) =>
  H.runController(handler, H.mockReq(clinicId, userId, body, { query }));

// ─────────────────────────────── RDEP ───────────────────────────────

test('RDEP: acumula los roles CERRADOS del año y excluye los BORRADORES (igual que el 103)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const emp = await makeEmployee(clinicId, { identificacion: '0912345678' });
  await makePayroll(clinicId, emp, { month: 1 });
  await makePayroll(clinicId, emp, { month: 2 });
  await makePayroll(clinicId, emp, { month: 3, status: 'BORRADOR' }); // no entra

  const r = await call(annex.getRdep, clinicId, userId, {}, { year: String(YEAR) });
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.rows.length, 1);
  const row = r.payload.rows[0];
  assert.equal(row.identificacion, '0912345678');
  assert.equal(row.meses, 2, 'solo los dos roles cerrados');
  assert.equal(row.sueldos, 2000);
  assert.equal(row.sobresueldos, 400, 'comisiones gravan');
  assert.equal(row.gravadoEmpleador, 2400);
  assert.equal(row.noGravado, 280, 'décimos: informativos, fuera de la base');
  assert.equal(row.iessPersonal, 224.1);
  assert.equal(row.retenidoEmpleador, 60);
  assert.ok(r.payload.warnings.some((w) => w.code === 'NOMINA_BORRADOR_EXCLUIDA'));
});

test('RDEP: la base gravada del anexo coincide con la que el 103 declara para el mismo mes', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const emp = await makeEmployee(clinicId, { identificacion: '0912345678' });
  await makePayroll(clinicId, emp, { month: 1 });

  const r = await call(annex.getRdep, clinicId, userId, {}, { year: String(YEAR) });
  const dep = await payrollWithholdingForPeriod({ clinicId, year: YEAR, month: 1 });
  assert.equal(r.payload.totals.gravadoEmpleador, dep.baseGravada, 'misma base que el casillero 302');
  assert.equal(r.payload.totals.retenidoEmpleador, dep.total, 'mismo valor retenido que el 352');
});

test('RDEP: los gastos personales capturados bajan la base imponible y se persisten', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const emp = await makeEmployee(clinicId, { identificacion: '0912345678' });
  await makePayroll(clinicId, emp, { month: 1 });
  await PayrollIncomeTaxTable.create({
    clinic: clinicId, year: YEAR, periodType: 'ANNUAL', active: true,
    ranges: [{ from: 0, to: 1000, baseTax: 0, excessRate: 0 }, { from: 1000, to: null, baseTax: 0, excessRate: 10 }],
  });

  // Sin gastos: base = 1200 gravado − 112.05 de IESS = 1087.95 → 10 % del excedente de 1000.
  const antes = await call(annex.getRdep, clinicId, userId, {}, { year: String(YEAR) });
  assert.equal(antes.payload.rows[0].baseImponible, 1087.95);
  assert.equal(antes.payload.rows[0].impuestoCausado, 8.8, 'tabla anual: 10 % sobre el excedente de 1000');

  // Con gastos personales: la base baja y el impuesto causado cae al primer tramo (0 %).
  const save = await call(annex.saveRdep, clinicId, userId, {
    entries: { '0912345678': { gastosSalud: 500, gastosEducacion: 87.95 } },
  }, { year: String(YEAR) });
  assert.equal(save.statusCode, 200, JSON.stringify(save.payload));
  const row = save.payload.rows[0];
  assert.equal(row.gastosPersonales, 587.95);
  assert.equal(row.baseImponible, 500);
  assert.equal(row.impuestoCausado, 0, 'con la base en 500 cae en el tramo exento');

  // Persiste entre consultas (el cálculo se rehace pero lo capturado se conserva).
  const luego = await call(annex.getRdep, clinicId, userId, {}, { year: String(YEAR) });
  assert.equal(luego.payload.rows[0].gastosSalud, 500);
  assert.equal(luego.payload.rows[0].baseImponible, 500);
});

test('RDEP: no se pueden capturar los campos que calcula la nómina', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const emp = await makeEmployee(clinicId, { identificacion: '0912345678' });
  await makePayroll(clinicId, emp, { month: 1 });

  const r = await call(annex.saveRdep, clinicId, userId, {
    entries: { '0912345678': { retenidoEmpleador: 9999 } },
  }, { year: String(YEAR) });
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /lo calcula el sistema/i);
});

test('RDEP: avisa de los empleados sin identificación (no se pueden reportar)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await Payroll.create({
    clinic: clinicId, year: YEAR, month: 1, period: `${YEAR}-01`, status: 'CERRADO', periodType: 'MENSUAL',
    items: [{ employee: new H.mongoose.Types.ObjectId(), employeeName: 'Sin Cédula', identificacion: '', baseSalary: 500 }],
  });
  const r = await call(annex.getRdep, clinicId, userId, {}, { year: String(YEAR) });
  assert.equal(r.payload.rows.length, 0);
  assert.ok(r.payload.warnings.some((w) => w.code === 'EMPLEADO_SIN_IDENTIFICACION'));
  assert.equal(r.payload.conciliaciones.find((c) => c.key === 'EMPLEADOS_IDENTIFICADOS').ok, false);
});

// ────────────────────── Anexo de Accionistas (APS) ──────────────────────

test('APS: los titulares de capital deben sumar 100 % (avisa mientras no cuadre)', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const a = await call(annex.createShareholder, clinicId, userId, {
    identificacion: '0912345678', razonSocial: 'María Torres', role: 'ACCIONISTA', porcentajeParticipacion: 60, capitalInvertido: 600,
  });
  assert.equal(a.statusCode, 201, JSON.stringify(a.payload));

  let r = await call(annex.getAps, clinicId, userId, {}, { year: String(YEAR) });
  assert.equal(r.payload.totals.porcentajeTotal, 60);
  assert.ok(r.payload.warnings.some((w) => w.code === 'PARTICIPACION_NO_SUMA_100'));
  assert.equal(r.payload.conciliaciones.find((c) => c.key === 'PARTICIPACION_100').ok, false);

  await call(annex.createShareholder, clinicId, userId, {
    identificacion: '0998765432', razonSocial: 'Luis Vera', role: 'SOCIO', porcentajeParticipacion: 40, capitalInvertido: 400,
  });
  r = await call(annex.getAps, clinicId, userId, {}, { year: String(YEAR) });
  assert.equal(r.payload.totals.porcentajeTotal, 100);
  assert.equal(r.payload.totals.capitalTotal, 1000);
  assert.equal(r.payload.warnings.length, 0);
  assert.equal(r.payload.conciliaciones.find((c) => c.key === 'PARTICIPACION_100').ok, true);
});

test('APS: el miembro del directorio se reporta pero NO cuenta para el 100 % del capital', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await call(annex.createShareholder, clinicId, userId, {
    identificacion: '0912345678', razonSocial: 'María Torres', role: 'ACCIONISTA', porcentajeParticipacion: 100,
  });
  await call(annex.createShareholder, clinicId, userId, {
    identificacion: '0911111111', razonSocial: 'Pedro Mora', role: 'MIEMBRO_DIRECTORIO', porcentajeParticipacion: 0,
  });
  const r = await call(annex.getAps, clinicId, userId, {}, { year: String(YEAR) });
  assert.equal(r.payload.rows.length, 2, 'ambos se reportan');
  assert.equal(r.payload.totals.titulares, 1);
  assert.equal(r.payload.totals.otrosRoles, 1);
  assert.equal(r.payload.totals.porcentajeTotal, 100);
  assert.equal(r.payload.warnings.length, 0);
});

test('APS: un titular con fecha "hasta" pasada deja de figurar en el anexo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await call(annex.createShareholder, clinicId, userId, {
    identificacion: '0912345678', razonSocial: 'María Torres', role: 'ACCIONISTA', porcentajeParticipacion: 100,
  });
  await Shareholder.create({
    clinic: clinicId, identificacion: '0900000000', razonSocial: 'Ex Socio', role: 'SOCIO',
    porcentajeParticipacion: 50, fechaHasta: new Date(YEAR - 1, 5, 30),
  });
  const r = await call(annex.getAps, clinicId, userId, {}, { year: String(YEAR) });
  assert.equal(r.payload.rows.length, 1, 'el ex socio no figura al corte actual');
  assert.equal(r.payload.totals.porcentajeTotal, 100);
});

test('APS: la misma persona no puede figurar dos veces con la misma calidad', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const body = { identificacion: '0912345678', razonSocial: 'María Torres', role: 'ACCIONISTA', porcentajeParticipacion: 50 };
  assert.equal((await call(annex.createShareholder, clinicId, userId, body)).statusCode, 201);
  const dup = await call(annex.createShareholder, clinicId, userId, body);
  assert.equal(dup.statusCode, 409, JSON.stringify(dup.payload));
});
