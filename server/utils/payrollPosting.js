/**
 * Posteo contable de nómina PARAMETRIZADO. Las cuentas no se capturan a mano en el
 * rol: se resuelven desde departamento / concepto / configuración. Este módulo:
 *  - recalcula los totales de cada ítem (con prorrateo por días trabajados);
 *  - resuelve las cuentas de gasto por DEPARTAMENTO (Admin/Ventas/Costos) y las
 *    cuentas de obligaciones/provisiones desde PayrollConfig;
 *  - construye el asiento CUADRADO del cierre, agregando por cuenta;
 *  - bloquea el cierre si falta una cuenta crítica (mensaje claro).
 */
const { ensureAccountByCode, findAccount } = require('./accounting');
const PayrollConfig = require('../models/PayrollConfig');
const PayrollDepartment = require('../models/PayrollDepartment');
const ChartOfAccount = require('../models/ChartOfAccount');

const r2 = (n) => +(Number(n) || 0).toFixed(2);

/** Resuelve (o crea) una cuenta del plan por código. */
async function accByCode(clinicId, code, session) {
  if (!code) return null;
  const ensured = await ensureAccountByCode(clinicId, code, { session });
  if (ensured) return ensured;
  return findAccount(clinicId, { code }, { session });
}

/** Resuelve una cuenta por _id (dentro de la clínica). */
async function accById(clinicId, id, session) {
  if (!id) return null;
  return ChartOfAccount.findOne({ _id: id, clinic: clinicId }).session(session || null);
}

/**
 * Recalcula los totales de un ítem del rol. `daysWorked` (30 − ausencias) prorratea
 * el sueldo del mes; las vacaciones NO reducen días. Suma los rubros flexibles.
 */
function recomputeItem(item) {
  const monthly = Number(item.monthlySalary) || Number(item.baseSalary) || 0;
  let days = item.daysWorked;
  if (item.absenceDays != null && item.absenceDays !== '') {
    days = 30 - Number(item.absenceDays);
  }
  if (days == null || days === '' || Number.isNaN(Number(days))) days = 30;
  days = Math.max(0, Math.min(30, Number(days)));
  item.daysWorked = days;
  item.absenceDays = r2(30 - days);
  const earnedBase = r2(monthly * (days / 30));
  item.baseSalary = earnedBase;

  const earn = (item.earnings || []).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const ded = (item.deductions || []).reduce((s, d) => s + (Number(d.amount) || 0), 0);

  item.totalIngresos = r2(
    earnedBase + (item.overtime || 0) + (item.bonuses || 0) + (item.commissions || 0)
    + (item.decimoTercero || 0) + (item.decimoCuarto || 0) + (item.fondosReserva || 0)
    + (item.vacaciones || 0) + (item.otherIncome || 0) + earn
  );
  item.totalEgresos = r2(
    (item.iessPersonal || 0) + (item.impuestoRenta || 0) + (item.prestamoIess || 0)
    + (item.prestamoEmpresa || 0) + (item.anticipos || 0) + (item.multas || 0)
    + (item.otherDeductions || 0) + ded
  );
  item.netoPagar = r2(item.totalIngresos - item.totalEgresos);
  item.totalProvisiones = r2(
    (item.iessPatronal || 0) + (item.iece || 0) + (item.secap || 0)
    + (item.provDecimoTercero || 0) + (item.provDecimoCuarto || 0)
    + (item.provVacaciones || 0) + (item.provFondosReserva || 0)
  );
  return item;
}

/** Resuelve todas las cuentas GENERALES de PayrollConfig (fallback / obligaciones). */
async function resolveConfigAccounts(clinicId, cfg, session) {
  const a = cfg?.accounts || {};
  const code = (k, def) => a[k] || def;
  const [
    sueldos, beneficios, iessPatronal, gastoVacaciones,
    iessPorPagar, sueldosPorPagar, irPorPagar, prestamosPorCobrar, cxcEmpleados,
    decimoTerceroPorPagar, decimoCuartoPorPagar, fondosReservaPorPagar, vacacionesPorPagar,
  ] = await Promise.all([
    accByCode(clinicId, code('sueldos', '6.1.01'), session),
    accByCode(clinicId, code('beneficios', '6.1.02'), session),
    accByCode(clinicId, code('iessPatronal', '6.1.03'), session),
    accByCode(clinicId, code('gastoVacaciones', '6.1.07'), session),
    accByCode(clinicId, code('iessPorPagar', '2.1.03.02'), session),
    accByCode(clinicId, code('sueldosPorPagar', '2.1.03.01'), session),
    accByCode(clinicId, code('irPorPagar', '2.1.02.05'), session),
    accByCode(clinicId, code('prestamosPorCobrar', '1.1.02.04'), session),
    accByCode(clinicId, code('cxcEmpleados', '1.1.02.06'), session),
    accByCode(clinicId, code('decimoTerceroPorPagar', '2.1.03.03'), session),
    accByCode(clinicId, code('decimoCuartoPorPagar', '2.1.03.04'), session),
    accByCode(clinicId, code('fondosReservaPorPagar', '2.1.03.05'), session),
    accByCode(clinicId, code('vacacionesPorPagar', '2.1.03.06'), session),
  ]);
  return {
    sueldos, beneficios, iessPatronal, gastoVacaciones,
    iessPorPagar, sueldosPorPagar, irPorPagar, prestamosPorCobrar, cxcEmpleados,
    decimoTerceroPorPagar, decimoCuartoPorPagar, fondosReservaPorPagar, vacacionesPorPagar,
  };
}

/**
 * Cuentas de GASTO del departamento del empleado. Si el empleado tiene
 * departamento parametrizado, su cuenta de sueldos es OBLIGATORIA (no hay
 * fallback silencioso → cumple "bloquear si falta config crítica"). Las de
 * beneficios/patronal caen a la general si no están definidas.
 */
async function resolveDeptExpenseAccounts(clinicId, deptRef, general, deptCache, session) {
  if (!deptRef) return { sueldos: general.sueldos, beneficios: general.beneficios, iessPatronal: general.iessPatronal };
  const key = String(deptRef);
  let dept = deptCache.get(key);
  if (dept === undefined) {
    dept = await PayrollDepartment.findOne({ _id: deptRef, clinic: clinicId }).session(session || null);
    deptCache.set(key, dept);
  }
  if (!dept) return { sueldos: general.sueldos, beneficios: general.beneficios, iessPatronal: general.iessPatronal };
  const da = dept.accounts || {};
  const sueldos = await accById(clinicId, da.sueldos, session);
  if (!sueldos) {
    const err = new Error(`El departamento «${dept.name}» no tiene cuenta de gasto de sueldos configurada.`);
    err.status = 400;
    throw err;
  }
  const beneficios = (await accById(clinicId, da.beneficios, session)) || general.beneficios;
  const iessPatronal = (await accById(clinicId, da.iessPatronal, session)) || general.iessPatronal;
  return { sueldos, beneficios, iessPatronal };
}

/**
 * Construye las líneas del asiento de cierre de rol, agregadas por cuenta.
 * Debita gastos por departamento; acredita sueldos por pagar, IESS, IR, préstamos,
 * deducciones y provisiones. Vacaciones gozadas van contra provisión.
 * @returns {Promise<Array<{account, debit, credit, description}>>}
 */
async function buildPayrollEntryLines(payroll, { clinicId, session } = {}) {
  const cfg = await PayrollConfig.findOne({ clinic: clinicId }).session(session || null);
  const general = await resolveConfigAccounts(clinicId, cfg, session);
  const deptCache = new Map();

  // agregador: idCuenta → { account, debit, credit }
  const agg = new Map();
  const add = (account, debit, credit, description) => {
    if (!account) return;
    const k = String(account._id);
    if (!agg.has(k)) agg.set(k, { account: account._id, debit: 0, credit: 0, description });
    const row = agg.get(k);
    row.debit = r2(row.debit + (debit || 0));
    row.credit = r2(row.credit + (credit || 0));
  };

  for (const it of payroll.items || []) {
    const dept = await resolveDeptExpenseAccounts(clinicId, it.departmentRef, general, deptCache, session);

    // Ingresos que van a la cuenta de sueldos del departamento (todo lo que no
    // tenga cuenta de concepto propia), menos las vacaciones contra provisión.
    const conceptEarnAcct = [];
    let earnToDept = 0;
    for (const e of it.earnings || []) {
      const acc = await accById(clinicId, e.concept ? (await conceptAccount(clinicId, e.concept, 'defaultAccount', session)) : null, session);
      if (acc) conceptEarnAcct.push({ acc, amount: Number(e.amount) || 0, name: e.name });
      else earnToDept += Number(e.amount) || 0;
    }
    const vacContra = Number(it.vacacionesContraProvision) || 0;
    const salaryExpense = r2(
      (it.baseSalary || 0) + (it.overtime || 0) + (it.bonuses || 0) + (it.commissions || 0)
      + (it.decimoTercero || 0) + (it.decimoCuarto || 0) + (it.fondosReserva || 0)
      + (it.vacaciones || 0) + (it.otherIncome || 0) + earnToDept - vacContra
    );
    if (salaryExpense > 0) add(dept.sueldos, salaryExpense, 0, 'Sueldos y remuneraciones');
    for (const ce of conceptEarnAcct) if (ce.amount > 0) add(ce.acc, ce.amount, 0, ce.name || 'Rubro de nómina');
    if (vacContra > 0) add(general.vacacionesPorPagar, vacContra, 0, 'Vacaciones gozadas (contra provisión)');

    // Provisiones patronales y de beneficios (gasto).
    const patronal = r2((it.iessPatronal || 0) + (it.iece || 0) + (it.secap || 0));
    if (patronal > 0) add(dept.iessPatronal, patronal, 0, 'Aporte patronal IESS');
    const benExpense = r2((it.provDecimoTercero || 0) + (it.provDecimoCuarto || 0) + (it.provFondosReserva || 0));
    if (benExpense > 0) add(dept.beneficios, benExpense, 0, 'Provisión beneficios sociales');
    if ((it.provVacaciones || 0) > 0) add(general.gastoVacaciones, it.provVacaciones, 0, 'Provisión vacaciones');

    // Créditos: obligaciones y descuentos.
    const iessTotal = r2((it.iessPersonal || 0) + patronal);
    if (iessTotal > 0) add(general.iessPorPagar, 0, iessTotal, 'IESS por pagar');
    if ((it.impuestoRenta || 0) > 0) add(general.irPorPagar, 0, it.impuestoRenta, 'Retención impuesto a la renta');
    if ((it.prestamoEmpresa || 0) > 0) add(general.prestamosPorCobrar, 0, it.prestamoEmpresa, 'Préstamos empleados (recuperación)');
    const genericDed = r2((it.multas || 0) + (it.anticipos || 0) + (it.otherDeductions || 0) + (it.prestamoIess || 0));
    if (genericDed > 0) add(general.cxcEmpleados, 0, genericDed, 'Deducciones empleados');
    for (const d of it.deductions || []) {
      const amt = Number(d.amount) || 0;
      if (amt <= 0) continue;
      const acc = (d.concept ? await accById(clinicId, await conceptAccount(clinicId, d.concept, 'payableAccount', session), session) : null) || general.cxcEmpleados;
      add(acc, 0, amt, d.name || 'Descuento');
    }

    // Provisiones por pagar (desglosadas).
    if ((it.provDecimoTercero || 0) > 0) add(general.decimoTerceroPorPagar, 0, it.provDecimoTercero, 'Décimo tercero por pagar');
    if ((it.provDecimoCuarto || 0) > 0) add(general.decimoCuartoPorPagar, 0, it.provDecimoCuarto, 'Décimo cuarto por pagar');
    if ((it.provFondosReserva || 0) > 0) add(general.fondosReservaPorPagar, 0, it.provFondosReserva, 'Fondos de reserva por pagar');
    if ((it.provVacaciones || 0) > 0) add(general.vacacionesPorPagar, 0, it.provVacaciones, 'Vacaciones por pagar');

    // Neto a pagar.
    if ((it.netoPagar || 0) > 0) add(general.sueldosPorPagar, 0, it.netoPagar, 'Sueldos por pagar');
  }

  // Netear por cuenta: una misma cuenta puede recibir débito y crédito (p.ej.
  // vacaciones por pagar recibe la provisión del mes y el pago de lo gozado). El
  // asiento no admite una línea con débito y crédito a la vez → dejar un solo lado.
  const lines = [...agg.values()].map((l) => {
    const net = r2(l.debit - l.credit);
    return net >= 0
      ? { account: l.account, debit: net, credit: 0, description: l.description }
      : { account: l.account, debit: 0, credit: r2(-net), description: l.description };
  }).filter((l) => l.debit > 0 || l.credit > 0);
  if (!lines.length) {
    const err = new Error('El rol no tiene montos para contabilizar.');
    err.status = 400;
    throw err;
  }
  return { lines, config: general };
}

// Cache-less lookup del campo de cuenta de un concepto (defaultAccount/payableAccount).
const PayrollConcept = require('../models/PayrollConcept');
async function conceptAccount(clinicId, conceptId, field, session) {
  if (!conceptId) return null;
  const c = await PayrollConcept.findOne({ _id: conceptId, clinic: clinicId }).session(session || null);
  return c ? c[field] || null : null;
}

module.exports = { recomputeItem, buildPayrollEntryLines, resolveConfigAccounts, accByCode };
