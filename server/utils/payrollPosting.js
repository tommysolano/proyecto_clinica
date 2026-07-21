/**
 * Posteo contable de nómina PARAMETRIZADO. Las cuentas no se capturan a mano en el
 * rol: se resuelven desde la CONFIGURACIÓN de nómina (PayrollConfig.accounts), que
 * replica la estructura de RRHH de Contífico:
 *
 *  - cuentas de GASTO por DEPARTAMENTO del empleado (Admin/Ventas/Costos/Otros);
 *  - cuentas de BALANCE globales (descuentos, préstamos, por pagar, IESS por pagar);
 *  - cada línea de GASTO lleva el CENTRO DE COSTO del empleado (reportes por centro);
 *  - se BLOQUEA el cierre si un rubro con valor no tiene cuenta (nombra rubro + depto).
 *
 * Resolución de cada campo: `config → default por código` (solo para los rubros
 * centrales, para que una clínica sin configurar contabilice igual). Los rubros
 * granulares que administra la contadora no tienen default: si se usan sin cuenta,
 * el cierre se bloquea (nunca se adivina una cuenta).
 */
const { ensureAccountByCode, findAccount } = require('./accounting');
const PayrollConfig = require('../models/PayrollConfig');
const PayrollConcept = require('../models/PayrollConcept');
const ChartOfAccount = require('../models/ChartOfAccount');
const { POSTING_DEFAULT_CODES } = PayrollConfig;

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

/** Normaliza el tipo de departamento a una de las 4 claves estándar. */
function normalizeDeptType(t) {
  const up = String(t || '').toUpperCase();
  if (up === 'OTRO' || up === 'OTROS') return 'OTROS';
  if (['ADMINISTRATIVO', 'VENTAS', 'COSTOS'].includes(up)) return up;
  return 'ADMINISTRATIVO'; // sin departamento / legacy → Administrativo
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

// Etiquetas legibles de cada rubro (para el mensaje de bloqueo).
const RUBRO_LABELS = {
  sueldo: 'Sueldo', alimentacion: 'Alimentación', transporte: 'Transporte', vivienda: 'Vivienda',
  comisiones: 'Comisiones', horasExtra: 'Horas extra', bonificaciones: 'Bonificaciones',
  otrosIngresos: 'Otros ingresos', devBeneficios: 'Devolución beneficios sociales',
  devDiasMultas: 'Devolución días/multas',
  dec3Gasto: 'Gasto décimo tercero', dec4Gasto: 'Gasto décimo cuarto',
  fondosReservaGasto: 'Gasto fondos de reserva', vacacionesGasto: 'Gasto vacaciones',
  aportePatronalGasto: 'Gasto aporte patronal', secapGasto: 'Gasto SECAP/IECE',
  anticipos: 'Anticipos a empleado', descuento: 'Descuento', multa: 'Multa', ausencias: 'Ausencias',
  comisariato: 'Comisariato', farmacia: 'Farmacia', seguros: 'Seguros', celular: 'Celular',
  descuentoDiasNoLaborados: 'Descuento días no laborados',
  prestamoQuirografario: 'Préstamo quirografario', prestamoHipotecario: 'Préstamo hipotecario',
  prestamoPersonal: 'Préstamo personal', otrosEgresos: 'Otros egresos', impRenta: 'Impuesto a la renta',
  sueldosPorPagar: 'Sueldos por pagar', dec3Pasivo: 'Décimo tercero por pagar',
  dec4Pasivo: 'Décimo cuarto por pagar', fondosReservaPasivo: 'Fondos de reserva por pagar',
  vacacionesPasivo: 'Vacaciones por pagar', iessPersonal: 'Aporte personal IESS',
  aporteConyugal: 'Aporte conyugal IESS', aportePatronalPasivo: 'Aporte patronal por pagar',
  secapPasivo: 'SECAP/IECE por pagar',
};
const DEPT_LABEL = { ADMINISTRATIVO: 'Administrativo', VENTAS: 'Ventas', COSTOS: 'Costos', OTROS: 'Otros' };

// Concepto (código del catálogo) → campo de ingreso por departamento.
const INCOME_FIELD_BY_CODE = {
  'ING-SUELDO': 'sueldo', 'ING-ALIMENTACION': 'alimentacion', 'ING-TRANSPORTE': 'transporte',
  'ING-VIVIENDA': 'vivienda', 'ING-COMISIONES': 'comisiones',
  'ING-HE25': 'horasExtra', 'ING-HE50': 'horasExtra', 'ING-HE100': 'horasExtra',
  'ING-BONIFICACION': 'bonificaciones', 'ING-DEVOLUCION-DIAS': 'devDiasMultas',
  'ING-OTROS': 'otrosIngresos', 'ING-VACACIONES': 'vacacionesGasto',
  'ING-FONDOS-RESERVA': 'fondosReservaGasto', 'ING-DECIMO-TERCERO': 'dec3Gasto', 'ING-DECIMO-CUARTO': 'dec4Gasto',
};
// Concepto (código) → campo de egreso global.
const DEDUCTION_FIELD_BY_CODE = {
  'EGR-ANTICIPO': 'anticipos', 'EGR-ANTICIPO-QUINCENA': 'anticipos',
  'EGR-PREST-HIPOTECARIO': 'prestamoHipotecario', 'EGR-PREST-QUIROGRAFARIO': 'prestamoQuirografario',
  'EGR-PREST-PERSONAL': 'prestamoPersonal', 'EGR-MULTAS': 'multa', 'EGR-SEGURO': 'seguros',
  'EGR-CELULAR': 'celular', 'EGR-AUSENCIAS': 'ausencias', 'EGR-DESCUENTOS': 'descuento',
  'EGR-IMPUESTO-RENTA': 'impRenta', 'EGR-OTROS': 'otrosEgresos', 'EGR-EXT-CONYUGAL': 'descuento',
};

/**
 * Resolutor de cuentas de la configuración. Para cada campo:
 *   - config[scope][field] es ObjectId → se usa;
 *   - config[scope][field] === null (la contadora lo dejó en blanco a propósito) → null;
 *   - no está definido (clínica/legacy sin configurar) → default por código si el rubro
 *     es central; si no, null.
 * `require*` bloquea con mensaje claro cuando un rubro CON VALOR resuelve a null.
 */
function makeAccountResolver(clinicId, cfg, session) {
  const cache = new Map();
  const resolveId = async (id) => {
    const k = String(id);
    if (!cache.has(k)) cache.set(k, await accById(clinicId, id, session));
    return cache.get(k);
  };
  const codeCache = new Map();
  const resolveCode = async (code) => {
    if (!codeCache.has(code)) codeCache.set(code, await accByCode(clinicId, code, session));
    return codeCache.get(code);
  };

  const resolve = async (scope, field, deptType) => {
    const bucket = scope === 'global'
      ? cfg?.accounts?.global
      : cfg?.accounts?.byDepartment?.[deptType];
    const raw = bucket ? bucket[field] : undefined;
    if (raw) return resolveId(raw); // ObjectId configurado
    // Sin cuenta (null o undefined) → default por código si el rubro es CENTRAL. Los rubros
    // granulares que administra la contadora no tienen default: resuelven a null y bloquean.
    const code = (scope === 'global' ? POSTING_DEFAULT_CODES.global : POSTING_DEFAULT_CODES.byDepartment)[field];
    return code ? resolveCode(code) : null;
  };

  const gAcc = (field) => resolve('global', field);
  const dAcc = (deptType, field) => resolve('dept', field, deptType);
  return { gAcc, dAcc };
}

/** Cuentas GLOBALES relevantes para otros módulos (obligación del neto, pago). */
async function resolveConfigAccounts(clinicId, cfg, session) {
  const { gAcc } = makeAccountResolver(clinicId, cfg, session);
  const sueldosPorPagar = await gAcc('sueldosPorPagar');
  return { sueldosPorPagar };
}

/**
 * Construye las líneas del asiento de cierre de rol, agregadas por (cuenta, centro de
 * costo). Debita gastos por DEPARTAMENTO con el CENTRO DE COSTO del empleado; acredita
 * sueldos por pagar, IESS, IR, préstamos, deducciones y provisiones (cuentas globales,
 * sin centro de costo). Bloquea si un rubro con valor no tiene cuenta configurada.
 * @returns {Promise<{ lines, config }>}
 */
async function buildPayrollEntryLines(payroll, { clinicId, session } = {}) {
  const cfg = await PayrollConfig.findOne({ clinic: clinicId }).session(session || null);
  const { gAcc, dAcc } = makeAccountResolver(clinicId, cfg, session);

  // Código del rubro por su concepto (los ingresos fijos guardan `concept` pero no `code`).
  const concepts = await PayrollConcept.find({ clinic: clinicId }).select('code').session(session || null).lean();
  const codeById = new Map(concepts.map((c) => [String(c._id), c.code]));
  const codeOf = (line) => line.code || (line.concept ? codeById.get(String(line.concept)) : null);

  // agregador: `cuentaId|centroCosto` → { account, costCenter, debit, credit, description }
  const agg = new Map();
  const add = (account, debit, credit, description, costCenter = null) => {
    if (!account) return;
    const k = `${String(account._id)}|${costCenter ? String(costCenter) : ''}`;
    if (!agg.has(k)) agg.set(k, { account: account._id, costCenter: costCenter || null, debit: 0, credit: 0, description });
    const row = agg.get(k);
    row.debit = r2(row.debit + (debit || 0));
    row.credit = r2(row.credit + (credit || 0));
  };

  // Exige la cuenta de GASTO de un rubro por departamento (bloquea nombrando rubro + depto).
  const reqDept = async (deptType, field) => {
    const acc = await dAcc(deptType, field);
    if (!acc) {
      const err = new Error(`No hay cuenta configurada para «${RUBRO_LABELS[field] || field}» del departamento ${DEPT_LABEL[deptType] || deptType}. Configúrala en Nómina → Configuración → Cuentas Contables.`);
      err.status = 400; throw err;
    }
    return acc;
  };
  // Exige una cuenta GLOBAL de balance (bloquea nombrando el rubro).
  const reqGlobal = async (field) => {
    const acc = await gAcc(field);
    if (!acc) {
      const err = new Error(`No hay cuenta configurada para «${RUBRO_LABELS[field] || field}» (cuentas generales). Configúrala en Nómina → Configuración → Cuentas Contables.`);
      err.status = 400; throw err;
    }
    return acc;
  };

  // ── QUINCENA: anticipo del sueldo. Solo mueve dinero al empleado, NO reconoce gasto:
  //    Débito «Anticipos a empleado» / Crédito «Sueldos por pagar» (neto = anticipo).
  if (payroll.periodType === 'QUINCENA_1') {
    for (const it of payroll.items || []) {
      const anticipo = r2(it.anticipoQuincena || it.netoPagar || 0);
      if (anticipo <= 0) continue;
      add(await reqGlobal('anticipos'), anticipo, 0, 'Anticipo quincena (por cobrar al empleado)');
      add(await reqGlobal('sueldosPorPagar'), 0, anticipo, 'Anticipo quincena por pagar');
    }
    const lines = collapse(agg);
    if (!lines.length) { const err = new Error('La quincena no tiene anticipos para contabilizar.'); err.status = 400; throw err; }
    return { lines, config: { sueldosPorPagar: await gAcc('sueldosPorPagar') } };
  }

  for (const it of payroll.items || []) {
    const deptType = normalizeDeptType(it.departmentType);
    const cc = it.costCenter || null; // centro de costo del empleado → líneas de GASTO

    // ── Ingresos estructurados (gasto por departamento) ──────────────────────────────
    if ((it.baseSalary || 0) > 0) add(await reqDept(deptType, 'sueldo'), it.baseSalary, 0, 'Sueldos y remuneraciones', cc);
    if ((it.overtime || 0) > 0) add(await reqDept(deptType, 'horasExtra'), it.overtime, 0, 'Horas extra', cc);
    if ((it.commissions || 0) > 0) add(await reqDept(deptType, 'comisiones'), it.commissions, 0, 'Comisiones', cc);
    if ((it.bonuses || 0) > 0) add(await reqDept(deptType, 'bonificaciones'), it.bonuses, 0, 'Bonificación', cc);
    // Décimos/fondos MENSUALIZADOS (ingreso): van a su cuenta de gasto por departamento.
    if ((it.decimoTercero || 0) > 0) add(await reqDept(deptType, 'dec3Gasto'), it.decimoTercero, 0, 'Décimo tercero (mensualizado)', cc);
    if ((it.decimoCuarto || 0) > 0) add(await reqDept(deptType, 'dec4Gasto'), it.decimoCuarto, 0, 'Décimo cuarto (mensualizado)', cc);
    if ((it.fondosReserva || 0) > 0) add(await reqDept(deptType, 'fondosReservaGasto'), it.fondosReserva, 0, 'Fondos de reserva (mensualizado)', cc);
    if ((it.otherIncome || 0) > 0) add(await reqDept(deptType, 'otrosIngresos'), it.otherIncome, 0, 'Otros ingresos', cc);

    // Vacaciones gozadas: la parte contra provisión debita el PASIVO; el resto es gasto del depto.
    const vacContra = Number(it.vacacionesContraProvision) || 0;
    const vacResto = r2((Number(it.vacaciones) || 0) - vacContra);
    if (vacContra > 0) add(await reqGlobal('vacacionesPasivo'), vacContra, 0, 'Vacaciones gozadas (contra provisión)');
    if (vacResto > 0) add(await reqDept(deptType, 'vacacionesGasto'), vacResto, 0, 'Vacaciones pagadas', cc);
    else if (vacResto < 0) add(await reqGlobal('vacacionesPasivo'), 0, -vacResto, 'Ajuste vacaciones');

    // Rubros flexibles de INGRESO: cuenta según su concepto/código (por departamento).
    for (const e of it.earnings || []) {
      const amt = Number(e.amount) || 0;
      if (amt <= 0) continue;
      const field = INCOME_FIELD_BY_CODE[codeOf(e)] || 'otrosIngresos';
      const acc = await dAcc(deptType, field);
      if (!acc) {
        const err = new Error(`El rubro «${e.name || e.code || 'ingreso'}» (${RUBRO_LABELS[field] || field}) no tiene cuenta de gasto configurada para el departamento ${DEPT_LABEL[deptType] || deptType}.`);
        err.status = 400; throw err;
      }
      add(acc, amt, 0, e.name || 'Rubro de nómina', cc);
    }

    // Ingresos fijos recurrentes: cuenta directa (legacy) o por su concepto/código y departamento.
    for (const f of it.fixedIncomes || []) {
      const amt = Number(f.monto) || 0;
      if (amt <= 0) continue;
      let acc = null;
      if (f.account) {
        acc = await accById(clinicId, f.account, session);
        if (!acc) { const err = new Error(`El ingreso fijo «${f.concepto || 'ingreso'}» apunta a una cuenta inexistente.`); err.status = 400; throw err; }
      } else {
        const field = INCOME_FIELD_BY_CODE[codeOf(f)] || 'otrosIngresos';
        acc = await dAcc(deptType, field);
        if (!acc) {
          const err = new Error(`El ingreso fijo «${f.concepto || RUBRO_LABELS[field] || 'ingreso'}» no tiene cuenta de gasto configurada para el departamento ${DEPT_LABEL[deptType] || deptType}.`);
          err.status = 400; throw err;
        }
      }
      add(acc, amt, 0, f.concepto || 'Ingreso fijo', cc);
    }

    // ── Provisiones (acumulados): gasto del departamento contra pasivo global ─────────
    if ((it.provDecimoTercero || 0) > 0) {
      add(await reqDept(deptType, 'dec3Gasto'), it.provDecimoTercero, 0, 'Provisión décimo tercero', cc);
      add(await reqGlobal('dec3Pasivo'), 0, it.provDecimoTercero, 'Décimo tercero por pagar');
    }
    if ((it.provDecimoCuarto || 0) > 0) {
      add(await reqDept(deptType, 'dec4Gasto'), it.provDecimoCuarto, 0, 'Provisión décimo cuarto', cc);
      add(await reqGlobal('dec4Pasivo'), 0, it.provDecimoCuarto, 'Décimo cuarto por pagar');
    }
    if ((it.provFondosReserva || 0) > 0) {
      add(await reqDept(deptType, 'fondosReservaGasto'), it.provFondosReserva, 0, 'Provisión fondos de reserva', cc);
      add(await reqGlobal('fondosReservaPasivo'), 0, it.provFondosReserva, 'Fondos de reserva por pagar');
    }
    if ((it.provVacaciones || 0) > 0) {
      add(await reqDept(deptType, 'vacacionesGasto'), it.provVacaciones, 0, 'Provisión vacaciones', cc);
      add(await reqGlobal('vacacionesPasivo'), 0, it.provVacaciones, 'Vacaciones por pagar');
    }

    // ── Aportes al IESS: gasto por departamento contra pasivo global ──────────────────
    if ((it.iessPatronal || 0) > 0) {
      add(await reqDept(deptType, 'aportePatronalGasto'), it.iessPatronal, 0, 'Aporte patronal IESS', cc);
      add(await reqGlobal('aportePatronalPasivo'), 0, it.iessPatronal, 'Aporte patronal por pagar');
    }
    const secapExpense = r2((it.iece || 0) + (it.secap || 0));
    if (secapExpense > 0) {
      add(await reqDept(deptType, 'secapGasto'), secapExpense, 0, 'SECAP/IECE', cc);
      add(await reqGlobal('secapPasivo'), 0, secapExpense, 'SECAP/IECE por pagar');
    }
    if ((it.iessPersonal || 0) > 0) add(await reqGlobal('iessPersonal'), 0, it.iessPersonal, 'Aporte personal IESS');

    // ── Egresos / descuentos (créditos a cuentas globales de balance) ─────────────────
    if ((it.impuestoRenta || 0) > 0) add(await reqGlobal('impRenta'), 0, it.impuestoRenta, 'Retención impuesto a la renta');
    if ((it.prestamoEmpresa || 0) > 0) add(await reqGlobal('prestamoPersonal'), 0, it.prestamoEmpresa, 'Préstamo empleado (recuperación)');
    if ((it.prestamoIess || 0) > 0) add(await reqGlobal('prestamoQuirografario'), 0, it.prestamoIess, 'Préstamo quirografario (recuperación)');
    if ((it.anticipoQuincena || 0) > 0) add(await reqGlobal('anticipos'), 0, it.anticipoQuincena, 'Descuento anticipo quincena');
    if ((it.anticipos || 0) > 0) add(await reqGlobal('anticipos'), 0, it.anticipos, 'Descuento anticipos');
    if ((it.multas || 0) > 0) add(await reqGlobal('multa'), 0, it.multas, 'Descuento multas');
    if ((it.otherDeductions || 0) > 0) add(await reqGlobal('descuento'), 0, it.otherDeductions, 'Otros descuentos');
    for (const d of it.deductions || []) {
      const amt = Number(d.amount) || 0;
      if (amt <= 0) continue;
      const field = DEDUCTION_FIELD_BY_CODE[codeOf(d)] || 'descuento';
      const acc = await gAcc(field);
      if (!acc) {
        const err = new Error(`El descuento «${d.name || d.code || 'descuento'}» (${RUBRO_LABELS[field] || field}) no tiene cuenta configurada en las cuentas generales.`);
        err.status = 400; throw err;
      }
      add(acc, 0, amt, d.name || 'Descuento');
    }

    // ── Neto a pagar ──────────────────────────────────────────────────────────────────
    if ((it.netoPagar || 0) > 0) add(await reqGlobal('sueldosPorPagar'), 0, it.netoPagar, 'Sueldos por pagar');
  }

  const lines = collapse(agg);
  if (!lines.length) {
    const err = new Error('El rol no tiene montos para contabilizar.');
    err.status = 400;
    throw err;
  }
  return { lines, config: { sueldosPorPagar: await gAcc('sueldosPorPagar') } };
}

/**
 * Netea por (cuenta, centro de costo): una misma cuenta puede recibir débito y crédito
 * (p.ej. vacaciones por pagar recibe la provisión del mes y el pago de lo gozado). El
 * asiento no admite una línea con débito y crédito a la vez → dejar un solo lado.
 */
function collapse(agg) {
  return [...agg.values()].map((l) => {
    const net = r2(l.debit - l.credit);
    return net >= 0
      ? { account: l.account, costCenter: l.costCenter, debit: net, credit: 0, description: l.description }
      : { account: l.account, costCenter: l.costCenter, debit: 0, credit: r2(-net), description: l.description };
  }).filter((l) => l.debit > 0 || l.credit > 0);
}

module.exports = { recomputeItem, buildPayrollEntryLines, resolveConfigAccounts, accByCode, normalizeDeptType };
