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
const PayrollConcept = require('../models/PayrollConcept');
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

const { computeIncomeTax } = require('./payrollTax');

/**
 * MOTOR ÚNICO de cálculo de un ítem del rol. Recalcula, desde una sola fuente:
 *  - sueldo GANADO prorrateado por días trabajados (30 − ausencias; vacaciones NO
 *    reducen días);
 *  - décimos/fondos mensualizados (ingreso) o acumulados (provisión) según el
 *    empleado;
 *  - base imponible IESS (sueldo + rubros marcados `affectsIess`), IESS personal/
 *    patronal/IECE/SECAP con las TASAS configurables;
 *  - impuesto a la renta con la TABLA parametrizable (o 0 si no hay tabla → el
 *    cierre luego lo bloquea);
 *  - provisiones de beneficios;
 *  - totales de ingresos/egresos, neto y provisiones (incluye rubros flexibles).
 *
 * @param {object} item
 * @param {object} ctx { employee, rates, taxTable, conceptMap, sbu }
 *   rates: { IESS_PERSONAL, IESS_PATRONAL, IECE, SECAP, FONDOS_RESERVA } (fracciones)
 *   taxTable: doc de PayrollIncomeTaxTable | null
 *   conceptMap: Map(conceptId → { affectsIess, affectsIncomeTax })
 */
function recomputeItem(item, ctx = {}) {
  const { employee = {}, rates = {}, taxTable = null, conceptMap = new Map(), sbu = 0 } = ctx;
  const R = {
    IESS_PERSONAL: rates.IESS_PERSONAL || 0,
    IESS_PATRONAL: rates.IESS_PATRONAL || 0,
    IECE: rates.IECE || 0,
    SECAP: rates.SECAP || 0,
    FONDOS_RESERVA: rates.FONDOS_RESERVA || 0,
  };

  // Días trabajados (ausencias reducen; vacaciones no).
  const monthly = Number(item.monthlySalary) || Number(item.baseSalary) || 0;
  let days = item.daysWorked;
  if (item.absenceDays != null && item.absenceDays !== '') days = 30 - Number(item.absenceDays);
  if (days == null || days === '' || Number.isNaN(Number(days))) days = 30;
  days = Math.max(0, Math.min(30, Number(days)));
  item.daysWorked = days;
  item.absenceDays = r2(30 - days);
  const earnedBase = r2(monthly * (days / 30));
  item.baseSalary = earnedBase;

  // Rubros flexibles y sus flags de afectación (desde el catálogo de conceptos).
  const earnings = item.earnings || [];
  const deductions = item.deductions || [];
  const flagOf = (line) => (line.concept ? conceptMap.get(String(line.concept)) : null) || {};
  const earn = earnings.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const ded = deductions.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const earnIess = earnings.reduce((s, e) => s + (flagOf(e).affectsIess ? (Number(e.amount) || 0) : 0), 0);
  const earnIr = earnings.reduce((s, e) => s + (flagOf(e).affectsIncomeTax ? (Number(e.amount) || 0) : 0), 0);

  // Ingresos fijos recurrentes (snapshot en el ítem). Suman al ingreso; gravan IESS solo si
  // `aportaIess` (no afectan IR salvo que se capture como rubro flexible con concepto).
  const fixedIncomes = (item.fixedIncomes || []).filter((f) => (Number(f.monto) || 0) > 0);
  const fixed = r2(fixedIncomes.reduce((s, f) => s + (Number(f.monto) || 0), 0));
  const fixedIess = r2(fixedIncomes.reduce((s, f) => s + (f.aportaIess ? (Number(f.monto) || 0) : 0), 0));

  // Extras fijos legacy que gravan (normalmente 0; el flujo nuevo usa earnings[]).
  const gravaFijo = (Number(item.overtime) || 0) + (Number(item.commissions) || 0) + (Number(item.bonuses) || 0);

  // Décimos / fondos mensualizados (ingreso) o acumulados (provisión).
  const emp = employee || {};
  const d3Mens = emp.receivesDecimoTercero !== false && emp.decimoTerceroAcumulado === 'MENSUALIZADO';
  const d4Mens = emp.receivesDecimoCuarto !== false && emp.decimoCuartoAcumulado === 'MENSUALIZADO';
  const eligibleFondos = item.eligibleFondos != null ? item.eligibleFondos : (emp.receivesFondosReserva || false);
  const frMens = eligibleFondos && emp.fondosReservaAcumulado === 'MENSUALIZADO';
  // Los fondos de reserva se ganan DESDE el aniversario del año: el factor (0..1) prorratea el
  // período si el aniversario cae a mitad de mes (lo calcula el controlador; 1 por defecto).
  const frFactor = item.fondosReservaFactor != null ? Math.max(0, Math.min(1, Number(item.fondosReservaFactor))) : 1;
  item.decimoTercero = d3Mens ? r2(earnedBase / 12) : 0;
  item.decimoCuarto = d4Mens ? r2((sbu || 0) / 12) : 0;
  item.fondosReserva = frMens ? r2(earnedBase * R.FONDOS_RESERVA * frFactor) : 0;

  // Base imponible IESS (décimos/fondos/vacaciones NO gravan; los ingresos fijos solo si aportan).
  const iessBase = r2(earnedBase + gravaFijo + earnIess + fixedIess);
  item.iessPersonal = r2(iessBase * R.IESS_PERSONAL);
  item.iessPatronal = r2(iessBase * R.IESS_PATRONAL);
  item.iece = r2(iessBase * R.IECE);
  item.secap = r2(iessBase * R.SECAP);

  // Impuesto a la renta desde la tabla parametrizable (0 si no hay tabla).
  const taxableMonthly = r2(earnedBase + gravaFijo + earnIr);
  let ir = 0;
  if (taxTable) {
    if (taxTable.periodType === 'MONTHLY') {
      const t = computeIncomeTax(Math.max(0, taxableMonthly - item.iessPersonal), taxTable);
      ir = t == null ? 0 : t;
    } else {
      const annual = Math.max(0, taxableMonthly * 12 - item.iessPersonal * 12);
      const t = computeIncomeTax(annual, taxTable);
      ir = t == null ? 0 : r2(t / 12);
    }
  }
  item.impuestoRenta = r2(ir);

  // Provisiones (acumulados) sobre el sueldo ganado.
  item.provDecimoTercero = emp.decimoTerceroAcumulado === 'ACUMULADO' ? r2(earnedBase / 12) : 0;
  item.provDecimoCuarto = emp.decimoCuartoAcumulado === 'ACUMULADO' ? r2((sbu || 0) / 12) : 0;
  item.provVacaciones = r2(earnedBase / 24);
  item.provFondosReserva = (eligibleFondos && emp.fondosReservaAcumulado === 'ACUMULADO') ? r2(earnedBase * R.FONDOS_RESERVA * frFactor) : 0;

  // Totales. El anticipo de quincena ya pagado se descuenta del neto del cierre de mes.
  item.totalIngresos = r2(
    earnedBase + gravaFijo + item.decimoTercero + item.decimoCuarto + item.fondosReserva
    + (Number(item.vacaciones) || 0) + (Number(item.otherIncome) || 0) + earn + fixed
  );
  item.totalEgresos = r2(
    item.iessPersonal + item.impuestoRenta + (Number(item.prestamoIess) || 0)
    + (Number(item.prestamoEmpresa) || 0) + (Number(item.anticipos) || 0) + (Number(item.anticipoQuincena) || 0)
    + (Number(item.multas) || 0) + (Number(item.otherDeductions) || 0) + ded
  );
  item.netoPagar = r2(item.totalIngresos - item.totalEgresos);
  item.totalProvisiones = r2(
    item.iessPatronal + item.iece + item.secap
    + item.provDecimoTercero + item.provDecimoCuarto + item.provVacaciones + item.provFondosReserva
  );
  return item;
}

/** Resuelve todas las cuentas GENERALES de PayrollConfig (fallback / obligaciones). */
async function resolveConfigAccounts(clinicId, cfg, session) {
  const a = cfg?.accounts || {};
  const code = (k, def) => a[k] || def;
  const [
    sueldos, beneficios, iessPatronal, gastoVacaciones,
    iessPorPagar, sueldosPorPagar, irPorPagar, prestamosPorCobrar, cxcEmpleados, anticipoQuincena,
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
    accByCode(clinicId, code('anticipoQuincena', '1.1.02.06'), session),
    accByCode(clinicId, code('decimoTerceroPorPagar', '2.1.03.03'), session),
    accByCode(clinicId, code('decimoCuartoPorPagar', '2.1.03.04'), session),
    accByCode(clinicId, code('fondosReservaPorPagar', '2.1.03.05'), session),
    accByCode(clinicId, code('vacacionesPorPagar', '2.1.03.06'), session),
  ]);
  return {
    sueldos, beneficios, iessPatronal, gastoVacaciones,
    iessPorPagar, sueldosPorPagar, irPorPagar, prestamosPorCobrar, cxcEmpleados, anticipoQuincena,
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

  const conceptCache = new Map();
  const loadConcept = async (id) => {
    const k = String(id);
    if (!conceptCache.has(k)) conceptCache.set(k, await PayrollConcept.findOne({ _id: id, clinic: clinicId }).session(session || null));
    return conceptCache.get(k);
  };

  // ── QUINCENA: anticipo del sueldo. Solo mueve dinero al empleado, NO reconoce gasto:
  //    Débito «Anticipo de sueldo por cobrar» / Crédito «Sueldos por pagar» (neto = anticipo).
  //    El gasto del mes y el IESS se reconocen en el CIERRE, que descuenta este anticipo.
  if (payroll.periodType === 'QUINCENA_1') {
    for (const it of payroll.items || []) {
      const anticipo = r2(it.anticipoQuincena || it.netoPagar || 0);
      if (anticipo <= 0) continue;
      add(general.anticipoQuincena, anticipo, 0, 'Anticipo quincena (por cobrar al empleado)');
      add(general.sueldosPorPagar, 0, anticipo, 'Anticipo quincena por pagar');
    }
    const lines = [...agg.values()].map((l) => {
      const net = r2(l.debit - l.credit);
      return net >= 0
        ? { account: l.account, debit: net, credit: 0, description: l.description }
        : { account: l.account, debit: 0, credit: r2(-net), description: l.description };
    }).filter((l) => l.debit > 0 || l.credit > 0);
    if (!lines.length) { const err = new Error('La quincena no tiene anticipos para contabilizar.'); err.status = 400; throw err; }
    return { lines, config: general };
  }

  for (const it of payroll.items || []) {
    const dept = await resolveDeptExpenseAccounts(clinicId, it.departmentRef, general, deptCache, session);

    // Ingresos que van a la cuenta de sueldos del departamento (rubros sin concepto),
    // menos las vacaciones contra provisión. Un rubro CON concepto exige la cuenta
    // del concepto (bloquea el cierre si falta).
    const conceptEarnAcct = [];
    let earnToDept = 0;
    for (const e of it.earnings || []) {
      const amt = Number(e.amount) || 0;
      if (amt <= 0) continue;
      if (e.concept) {
        const c = await loadConcept(e.concept);
        const accDoc = c && c.defaultAccount ? await accById(clinicId, c.defaultAccount, session) : null;
        if (!accDoc) {
          const err = new Error(`El concepto «${e.name || c?.name || e.code || 'ingreso'}» no tiene cuenta de gasto configurada.`);
          err.status = 400; throw err;
        }
        conceptEarnAcct.push({ acc: accDoc, amount: amt, name: e.name });
      } else earnToDept += amt;
    }
    // Ingresos fijos: con cuenta propia van a su cuenta; sin cuenta, a la de sueldos del depto.
    const fixedAcct = [];
    let fixedToDept = 0;
    for (const f of it.fixedIncomes || []) {
      const amt = Number(f.monto) || 0;
      if (amt <= 0) continue;
      if (f.account) {
        const accDoc = await accById(clinicId, f.account, session);
        if (!accDoc) { const err = new Error(`El ingreso fijo «${f.concepto || 'ingreso'}» apunta a una cuenta inexistente.`); err.status = 400; throw err; }
        fixedAcct.push({ acc: accDoc, amount: amt, name: f.concepto });
      } else fixedToDept += amt;
    }
    const vacContra = Number(it.vacacionesContraProvision) || 0;
    const salaryExpense = r2(
      (it.baseSalary || 0) + (it.overtime || 0) + (it.bonuses || 0) + (it.commissions || 0)
      + (it.decimoTercero || 0) + (it.decimoCuarto || 0) + (it.fondosReserva || 0)
      + (it.vacaciones || 0) + (it.otherIncome || 0) + earnToDept + fixedToDept - vacContra
    );
    if (salaryExpense > 0) add(dept.sueldos, salaryExpense, 0, 'Sueldos y remuneraciones');
    for (const ce of conceptEarnAcct) if (ce.amount > 0) add(ce.acc, ce.amount, 0, ce.name || 'Rubro de nómina');
    for (const fe of fixedAcct) if (fe.amount > 0) add(fe.acc, fe.amount, 0, fe.name || 'Ingreso fijo');
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
    // Anticipo de quincena ya pagado: se acredita el «Anticipo por cobrar» para saldarlo (lo
    // debitó la quincena). Así el mes reconoce el gasto completo y el neto sale ya descontado.
    if ((it.anticipoQuincena || 0) > 0) add(general.anticipoQuincena, 0, it.anticipoQuincena, 'Descuento anticipo quincena');
    const genericDed = r2((it.multas || 0) + (it.anticipos || 0) + (it.otherDeductions || 0) + (it.prestamoIess || 0));
    if (genericDed > 0) add(general.cxcEmpleados, 0, genericDed, 'Deducciones empleados');
    for (const d of it.deductions || []) {
      const amt = Number(d.amount) || 0;
      if (amt <= 0) continue;
      let acc = general.cxcEmpleados;
      if (d.concept) {
        const c = await loadConcept(d.concept);
        acc = c && c.payableAccount ? await accById(clinicId, c.payableAccount, session) : null;
        if (!acc) {
          const err = new Error(`El concepto «${d.name || c?.name || d.code || 'descuento'}» no tiene cuenta por pagar configurada.`);
          err.status = 400; throw err;
        }
      }
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

module.exports = { recomputeItem, buildPayrollEntryLines, resolveConfigAccounts, accByCode };
