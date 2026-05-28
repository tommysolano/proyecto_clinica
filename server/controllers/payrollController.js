const Employee = require('../models/Employee');
const EmployeeLoan = require('../models/EmployeeLoan');
const Payroll = require('../models/Payroll');
const PayrollConfig = require('../models/PayrollConfig');
const { createEntry, findAccount } = require('../utils/accounting');

// Tasas legales Ecuador por defecto (se sobrescriben con PayrollConfig)
const RATES = {
  IESS_PERSONAL: 0.0945,
  IESS_PATRONAL: 0.1115,
  IECE: 0.005,
  SECAP: 0.005,
  FONDOS_RESERVA: 0.0833,
  SBU_2024: 460, // Salario Básico Unificado
};

/** Devuelve las tasas efectivas para una clínica (config o defaults). */
async function getRates(clinicId) {
  const cfg = await PayrollConfig.findOne({ clinic: clinicId });
  if (!cfg) return { ...RATES, _config: null };
  return {
    IESS_PERSONAL: cfg.iessPersonal / 100,
    IESS_PATRONAL: cfg.iessPatronal / 100,
    IECE: cfg.iece / 100,
    SECAP: cfg.secap / 100,
    FONDOS_RESERVA: cfg.fondosReserva / 100,
    SBU_2024: cfg.sbu,
    _config: cfg,
  };
}

// ----- Configuración de nómina -----
exports.getConfig = async (req, res) => {
  let cfg = await PayrollConfig.findOne({ clinic: req.clinicId });
  if (!cfg) cfg = await PayrollConfig.create({ clinic: req.clinicId });
  res.json(cfg);
};
exports.updateConfig = async (req, res) => {
  try {
    let cfg = await PayrollConfig.findOne({ clinic: req.clinicId });
    if (!cfg) cfg = new PayrollConfig({ clinic: req.clinicId });
    const patch = { ...req.body }; delete patch.clinic;
    Object.assign(cfg, patch);
    await cfg.save();
    res.json(cfg);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/**
 * Gross-up: dado un sueldo NETO deseado, calcula el bruto que hay que asignar
 * para que netoPagar == netDesired luego de descontar el aporte personal IESS (9.45%).
 * No incluye IR porque el IR es retención que también afecta al neto; el usuario
 * que pacta neto suele asumir IR como parte del costo (se recalcula al cerrar rol).
 * Si se requiere absorber IR también, se puede iterar.
 */
function grossUpFromNet(netDesired) {
  if (!netDesired || netDesired <= 0) return 0;
  return +(netDesired / (1 - RATES.IESS_PERSONAL)).toFixed(2);
}

/**
 * Devuelve el sueldo bruto efectivo a usar para cálculos de nómina,
 * respetando el tipo (NET o GROSS) configurado en el empleado.
 */
function effectiveBaseSalary(emp) {
  if (emp.salaryType === 'NET' && emp.netSalary > 0) {
    return grossUpFromNet(emp.netSalary);
  }
  return emp.baseSalary || 0;
}

// ----- Empleados -----
exports.listEmployees = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.active !== undefined) filter.active = req.query.active === 'true';
  const items = await Employee.find(filter).sort({ lastName: 1, firstName: 1 });
  res.json(items);
};
exports.getEmployee = async (req, res) => {
  const e = await Employee.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!e) return res.status(404).json({ message: 'No encontrado' });
  res.json(e);
};
exports.createEmployee = async (req, res) => {
  try {
    const data = { ...req.body, clinic: req.clinicId };
    // Si vienen datos de tipo NET pero no baseSalary, calcular el bruto inicial.
    if (data.salaryType === 'NET' && data.netSalary > 0 && !data.baseSalary) {
      data.baseSalary = grossUpFromNet(Number(data.netSalary));
    }
    if (!data.baseSalary || data.baseSalary <= 0) {
      return res.status(400).json({ message: 'baseSalary es requerido (o netSalary si salaryType=NET)' });
    }
    data.salaryHistory = [{
      date: new Date(),
      newType: data.salaryType || 'GROSS',
      newSalary: data.baseSalary,
      newNet: data.netSalary || 0,
      reason: 'Alta del empleado',
      changedBy: req.user._id,
    }];
    const e = await Employee.create(data);
    res.status(201).json(e);
  }
  catch (err) { res.status(400).json({ message: err.message }); }
};
exports.updateEmployee = async (req, res) => {
  try {
    const e = await Employee.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!e) return res.status(404).json({ message: 'No encontrado' });
    const patch = { ...req.body };
    // Si se cambia a NET, recalcular baseSalary a partir de netSalary
    if (patch.salaryType === 'NET' && patch.netSalary && patch.netSalary > 0) {
      patch.baseSalary = grossUpFromNet(Number(patch.netSalary));
    }
    const salaryChanged =
      (patch.baseSalary !== undefined && Number(patch.baseSalary) !== Number(e.baseSalary)) ||
      (patch.netSalary !== undefined && Number(patch.netSalary || 0) !== Number(e.netSalary || 0)) ||
      (patch.salaryType !== undefined && patch.salaryType !== e.salaryType);
    if (salaryChanged) {
      e.salaryHistory.push({
        date: new Date(),
        previousType: e.salaryType,
        previousSalary: e.baseSalary,
        previousNet: e.netSalary,
        newType: patch.salaryType || e.salaryType,
        newSalary: patch.baseSalary !== undefined ? Number(patch.baseSalary) : e.baseSalary,
        newNet: patch.netSalary !== undefined ? Number(patch.netSalary || 0) : e.netSalary,
        reason: patch.salaryChangeReason || 'Modificación de sueldo',
        changedBy: req.user._id,
      });
    }
    delete patch.salaryChangeReason;
    delete patch.salaryHistory; // no permitir sobrescribir el historial desde el body
    Object.assign(e, patch); await e.save(); res.json(e);
  } catch (err) { res.status(400).json({ message: err.message }); }
};
exports.deleteEmployee = async (req, res) => {
  const e = await Employee.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!e) return res.status(404).json({ message: 'No encontrado' });
  e.active = false; e.exitDate = new Date(); await e.save();
  res.json({ message: 'Inactivado', employee: e });
};

// ----- Préstamos -----
exports.listLoans = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.employee) filter.employee = req.query.employee;
  if (req.query.status) filter.status = req.query.status;
  const items = await EmployeeLoan.find(filter).populate('employee', 'code firstName lastName').sort({ createdAt: -1 });
  res.json(items);
};

exports.createLoan = async (req, res) => {
  try {
    const { employee, principal, installmentsCount, interestRate = 0, grantDate, type, description } = req.body;
    const cuota = +(principal / installmentsCount).toFixed(2);
    const installments = [];
    const start = grantDate ? new Date(grantDate) : new Date();
    for (let i = 1; i <= installmentsCount; i++) {
      const d = new Date(start); d.setMonth(d.getMonth() + i);
      installments.push({ number: i, dueDate: d, amount: cuota, paid: false });
    }
    const loan = await EmployeeLoan.create({
      clinic: req.clinicId, employee, principal, installmentsCount, installmentAmount: cuota,
      interestRate, grantDate: grantDate || new Date(), type, description,
      installments, balance: principal, createdBy: req.user._id,
    });
    res.status(201).json(loan);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.updateLoan = async (req, res) => {
  try {
    const l = await EmployeeLoan.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!l) return res.status(404).json({ message: 'No encontrado' });
    Object.assign(l, req.body); await l.save(); res.json(l);
  } catch (err) { res.status(400).json({ message: err.message }); }
};

// ----- Rol de pagos -----
function computeIESS(income) { return +(income * RATES.IESS_PERSONAL).toFixed(2); }
function computeIESSPatronal(income) { return +(income * RATES.IESS_PATRONAL).toFixed(2); }

/** Calcula impuesto a la renta mensual proyectado (tabla 2024 simplificada). */
function computeIRMonthly(annualBase) {
  // Tabla IR personas naturales 2024 (proyección)
  const tabla = [
    { hasta: 11722, base: 0, fraccion: 0 },
    { hasta: 14930, base: 0, fraccion: 5 },
    { hasta: 19385, base: 160, fraccion: 10 },
    { hasta: 25638, base: 606, fraccion: 12 },
    { hasta: 33738, base: 1356, fraccion: 15 },
    { hasta: 44721, base: 2571, fraccion: 20 },
    { hasta: 59537, base: 4768, fraccion: 25 },
    { hasta: 79388, base: 8472, fraccion: 30 },
    { hasta: 105580, base: 14427, fraccion: 35 },
    { hasta: Infinity, base: 23594, fraccion: 37 },
  ];
  for (const r of tabla) {
    if (annualBase <= r.hasta) {
      const prev = tabla[tabla.indexOf(r) - 1];
      const fraccionExcedente = prev ? annualBase - prev.hasta : annualBase;
      const ir = r.base + (fraccionExcedente * r.fraccion / 100);
      return Math.max(0, +(ir / 12).toFixed(2));
    }
  }
  return 0;
}

/**
 * Genera (o regenera) borrador de rol para un período.
 * body: { year, month }
 */
exports.generatePayroll = async (req, res) => {
  try {
    const { year, month } = req.body;
    const y = parseInt(year), m = parseInt(month);
    if (!y || !m) return res.status(400).json({ message: 'year y month requeridos' });
    const period = `${y}-${String(m).padStart(2, '0')}`;
    const endOfMonth = new Date(y, m, 0);

    const existing = await Payroll.findOne({ clinic: req.clinicId, year: y, month: m });
    if (existing && existing.status !== 'BORRADOR') {
      return res.status(400).json({ message: 'El rol ya está cerrado o pagado' });
    }
    const employees = await Employee.find({ clinic: req.clinicId, active: true, hireDate: { $lte: endOfMonth } });
    const R = await getRates(req.clinicId);

    const items = [];
    for (const emp of employees) {
      const yearsWorked = (endOfMonth - new Date(emp.hireDate)) / (1000 * 60 * 60 * 24 * 365);
      const eligibleFondos = emp.receivesFondosReserva || yearsWorked >= 1;

      const base = effectiveBaseSalary(emp);
      const decimoTercero = emp.receivesDecimoTercero && emp.decimoTerceroAcumulado === 'MENSUALIZADO' ? +(base / 12).toFixed(2) : 0;
      const decimoCuarto = emp.receivesDecimoCuarto && emp.decimoCuartoAcumulado === 'MENSUALIZADO' ? +(R.SBU_2024 / 12).toFixed(2) : 0;
      const fondosReserva = eligibleFondos && emp.fondosReservaAcumulado === 'MENSUALIZADO' ? +(base * R.FONDOS_RESERVA).toFixed(2) : 0;

      const totalIngresos = +(base + decimoTercero + decimoCuarto + fondosReserva).toFixed(2);

      // Aporte IESS sobre ingreso afecto (no incluye décimos ni fondos)
      const iessBase = base;
      const iessPersonal = +(iessBase * R.IESS_PERSONAL).toFixed(2);
      const iessPatronal = +(iessBase * R.IESS_PATRONAL).toFixed(2);
      const iece = +(iessBase * R.IECE).toFixed(2);
      const secap = +(iessBase * R.SECAP).toFixed(2);

      // Préstamos vigentes
      const loans = await EmployeeLoan.find({ clinic: req.clinicId, employee: emp._id, status: 'ACTIVO' });
      let prestamoEmpresa = 0;
      for (const l of loans) {
        const pend = l.installments.find((i) => !i.paid);
        if (pend) prestamoEmpresa += pend.amount;
      }

      // IR mensual proyectado
      const annualBase = (base + decimoCuarto + fondosReserva) * 12 - iessPersonal * 12;
      const impuestoRenta = computeIRMonthly(annualBase);

      const totalEgresos = +(iessPersonal + impuestoRenta + prestamoEmpresa).toFixed(2);
      const netoPagar = +(totalIngresos - totalEgresos).toFixed(2);
      const provDecimoTercero = emp.decimoTerceroAcumulado === 'ACUMULADO' ? +(base / 12).toFixed(2) : 0;
      const provDecimoCuarto = emp.decimoCuartoAcumulado === 'ACUMULADO' ? +(R.SBU_2024 / 12).toFixed(2) : 0;
      const provVacaciones = +(base / 24).toFixed(2);
      const provFondosReserva = eligibleFondos && emp.fondosReservaAcumulado === 'ACUMULADO' ? +(base * R.FONDOS_RESERVA).toFixed(2) : 0;
      const totalProvisiones = +(iessPatronal + iece + secap + provDecimoTercero + provDecimoCuarto + provVacaciones + provFondosReserva).toFixed(2);

      items.push({
        employee: emp._id, employeeName: `${emp.firstName} ${emp.lastName}`, identificacion: emp.identificacion,
        daysWorked: 30, baseSalary: base,
        decimoTercero, decimoCuarto, fondosReserva,
        totalIngresos, iessPersonal, impuestoRenta, prestamoEmpresa,
        totalEgresos, netoPagar,
        iessPatronal, iece, secap, provDecimoTercero, provDecimoCuarto, provVacaciones, provFondosReserva,
        totalProvisiones,
      });
    }

    const totals = items.reduce((a, i) => ({
      totalIngresos: a.totalIngresos + i.totalIngresos,
      totalEgresos: a.totalEgresos + i.totalEgresos,
      totalNeto: a.totalNeto + i.netoPagar,
      totalProvisiones: a.totalProvisiones + i.totalProvisiones,
    }), { totalIngresos: 0, totalEgresos: 0, totalNeto: 0, totalProvisiones: 0 });

    let payroll;
    if (existing) {
      existing.items = items;
      Object.assign(existing, totals);
      await existing.save();
      payroll = existing;
    } else {
      const count = await Payroll.countDocuments({ clinic: req.clinicId });
      const code = `ROL-${y}${String(m).padStart(2, '0')}-${String(count + 1).padStart(4, '0')}`;
      payroll = await Payroll.create({
        clinic: req.clinicId, code, year: y, month: m, period,
        items, ...totals, createdBy: req.user._id,
      });
    }
    res.json(payroll);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.listPayrolls = async (req, res) => {
  const items = await Payroll.find({ clinic: req.clinicId }).sort({ year: -1, month: -1 });
  res.json(items);
};
exports.getPayroll = async (req, res) => {
  const p = await Payroll.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!p) return res.status(404).json({ message: 'No encontrado' });
  res.json(p);
};

exports.updatePayrollItem = async (req, res) => {
  try {
    const p = await Payroll.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!p) return res.status(404).json({ message: 'No encontrado' });
    if (p.status !== 'BORRADOR') return res.status(400).json({ message: 'No editable' });
    const { employeeId, patch } = req.body;
    const it = p.items.find((i) => String(i.employee) === String(employeeId));
    if (!it) return res.status(404).json({ message: 'Item no encontrado' });
    Object.assign(it, patch);
    it.totalIngresos = +(it.baseSalary + it.overtime + it.bonuses + it.commissions + it.decimoTercero + it.decimoCuarto + it.fondosReserva + it.vacaciones + it.otherIncome).toFixed(2);
    it.totalEgresos = +(it.iessPersonal + it.impuestoRenta + it.prestamoIess + it.prestamoEmpresa + it.anticipos + it.multas + it.otherDeductions).toFixed(2);
    it.netoPagar = +(it.totalIngresos - it.totalEgresos).toFixed(2);
    p.totalIngresos = p.items.reduce((s, x) => s + x.totalIngresos, 0);
    p.totalEgresos = p.items.reduce((s, x) => s + x.totalEgresos, 0);
    p.totalNeto = p.items.reduce((s, x) => s + x.netoPagar, 0);
    await p.save();
    res.json(p);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/** Cierra rol y genera asiento contable + marca cuotas de préstamos pagadas. */
exports.closePayroll = async (req, res) => {
  try {
    const p = await Payroll.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!p) return res.status(404).json({ message: 'No encontrado' });
    if (p.status !== 'BORRADOR') return res.status(400).json({ message: 'No es borrador' });

    // Cuentas (desde configuración, con fallback a códigos por defecto)
    const cfg = await PayrollConfig.findOne({ clinic: req.clinicId });
    const acc = cfg?.accounts || {};
    const sueldos = await findAccount(req.clinicId, { code: acc.sueldos || '6.1.01' });
    const beneficios = await findAccount(req.clinicId, { code: acc.beneficios || '6.1.02' });
    const iessPat = await findAccount(req.clinicId, { code: acc.iessPatronal || '6.1.03' });
    const iessXpagar = await findAccount(req.clinicId, { code: acc.iessPorPagar || '2.1.03.02' });
    const sueldosXpagar = await findAccount(req.clinicId, { code: acc.sueldosPorPagar || '2.1.03.01' });
    const irXpagar = await findAccount(req.clinicId, { code: acc.irPorPagar || '2.1.02.05' });
    const prestEmpresaXcobrar = await findAccount(req.clinicId, { code: acc.prestamosPorCobrar || '1.1.02.04' });
    const provisiones = await findAccount(req.clinicId, { code: acc.provisionesPorPagar || '2.1.03.03' });

    const lines = [];
    if (p.totalIngresos > 0) lines.push({ account: sueldos._id, debit: p.totalIngresos, credit: 0, description: 'Sueldos y beneficios' });
    const totIessPat = p.items.reduce((s, i) => s + (i.iessPatronal || 0) + (i.iece || 0) + (i.secap || 0), 0);
    const totProvBen = p.items.reduce((s, i) => s + (i.provDecimoTercero || 0) + (i.provDecimoCuarto || 0) + (i.provVacaciones || 0) + (i.provFondosReserva || 0), 0);
    if (totIessPat > 0) lines.push({ account: iessPat._id, debit: +totIessPat.toFixed(2), credit: 0, description: 'Aporte patronal IESS' });
    if (totProvBen > 0) lines.push({ account: beneficios._id, debit: +totProvBen.toFixed(2), credit: 0, description: 'Provisión beneficios sociales' });

    const totIessPer = p.items.reduce((s, i) => s + (i.iessPersonal || 0), 0);
    if (totIessPer + totIessPat > 0) lines.push({ account: iessXpagar._id, debit: 0, credit: +(totIessPer + totIessPat).toFixed(2), description: 'IESS por pagar' });
    const totIR = p.items.reduce((s, i) => s + (i.impuestoRenta || 0), 0);
    if (totIR > 0) lines.push({ account: irXpagar._id, debit: 0, credit: +totIR.toFixed(2), description: 'Impuesto a la renta' });
    const totPrest = p.items.reduce((s, i) => s + (i.prestamoEmpresa || 0), 0);
    if (totPrest > 0) lines.push({ account: prestEmpresaXcobrar._id, debit: 0, credit: +totPrest.toFixed(2), description: 'Préstamos empleados' });
    if (totProvBen > 0) lines.push({ account: provisiones._id, debit: 0, credit: +totProvBen.toFixed(2), description: 'Provisiones por pagar' });
    if (p.totalNeto > 0) lines.push({ account: sueldosXpagar._id, debit: 0, credit: +p.totalNeto.toFixed(2), description: 'Sueldos por pagar' });

    const entry = await createEntry({
      clinicId: req.clinicId, date: new Date(p.year, p.month - 1, 28),
      description: `Rol de pagos ${p.period}`, source: 'NOMINA',
      sourceRef: p._id, sourceModel: 'Payroll',
      lines, userId: req.user._id,
    });

    // Marcar cuotas de préstamos
    for (const it of p.items) {
      if (it.prestamoEmpresa > 0) {
        const loans = await EmployeeLoan.find({ clinic: req.clinicId, employee: it.employee, status: 'ACTIVO' });
        let remaining = it.prestamoEmpresa;
        for (const l of loans) {
          for (const inst of l.installments) {
            if (inst.paid || remaining <= 0) continue;
            if (inst.amount <= remaining + 0.01) {
              inst.paid = true; inst.paidIn = p.period; inst.paidAt = new Date();
              l.paidAmount = +(l.paidAmount + inst.amount).toFixed(2);
              l.balance = +(l.principal - l.paidAmount).toFixed(2);
              remaining -= inst.amount;
            }
          }
          if (l.balance <= 0.01) l.status = 'CANCELADO';
          await l.save();
          if (remaining <= 0) break;
        }
      }
    }

    p.status = 'CERRADO';
    p.journalEntry = entry._id;
    p.closedAt = new Date();
    p.closedBy = req.user._id;
    await p.save();
    res.json(p);
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/**
 * Plantilla de décimos (13ro / 14to) para todos los empleados de un año.
 * query: { year, type: 'DECIMO_TERCERO' | 'DECIMO_CUARTO' }
 * - Décimo tercero: equivale a un sueldo mensual promedio (remuneración anual / 12).
 * - Décimo cuarto: un SBU completo (proporcional a meses trabajados).
 */
exports.generateDecimos = async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const type = req.query.type === 'DECIMO_CUARTO' ? 'DECIMO_CUARTO' : 'DECIMO_TERCERO';
    const R = await getRates(req.clinicId);
    // Período de cálculo del décimo
    const periodStart = type === 'DECIMO_TERCERO' ? new Date(year - 1, 11, 1) : new Date(year - 1, 7, 1);
    const periodEnd = type === 'DECIMO_TERCERO' ? new Date(year, 10, 30) : new Date(year, 6, 31);
    const employees = await Employee.find({ clinic: req.clinicId, active: true });
    const rows = [];
    let total = 0;
    for (const emp of employees) {
      const hire = new Date(emp.hireDate);
      const effStart = hire > periodStart ? hire : periodStart;
      const monthsWorked = Math.max(0, Math.min(12, Math.round((periodEnd - effStart) / (1000 * 60 * 60 * 24 * 30))));
      const base = effectiveBaseSalary(emp);
      let amount;
      if (type === 'DECIMO_TERCERO') {
        if (!emp.receivesDecimoTercero) continue;
        amount = +((base * monthsWorked) / 12).toFixed(2);
      } else {
        if (!emp.receivesDecimoCuarto) continue;
        amount = +((R.SBU_2024 * monthsWorked) / 12).toFixed(2);
      }
      total += amount;
      rows.push({
        employee: emp._id, employeeName: `${emp.firstName} ${emp.lastName}`,
        identificacion: emp.identificacion, baseSalary: base,
        monthsWorked, amount,
      });
    }
    res.json({ year, type, periodStart, periodEnd, total: +total.toFixed(2), rows });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.markPaid = async (req, res) => {
  const p = await Payroll.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!p) return res.status(404).json({ message: 'No encontrado' });
  if (p.status !== 'CERRADO') return res.status(400).json({ message: 'Debe estar cerrado' });
  p.status = 'PAGADO';
  await p.save();
  res.json(p);
};
