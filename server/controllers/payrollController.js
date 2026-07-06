const Employee = require('../models/Employee');
const EmployeeLoan = require('../models/EmployeeLoan');
const Payroll = require('../models/Payroll');
const PayrollConfig = require('../models/PayrollConfig');
const PayrollDepartment = require('../models/PayrollDepartment');
const PayrollPosition = require('../models/PayrollPosition');
const PayrollConcept = require('../models/PayrollConcept');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const User = require('../models/User');
const EmployeeDeduction = require('../models/EmployeeDeduction');
const PayrollIncomeTaxTable = require('../models/PayrollIncomeTaxTable');
const { createEntry, findAccount, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const { recomputeItem, buildPayrollEntryLines, resolveConfigAccounts } = require('../utils/payrollPosting');
const { DEFAULT_IR_RANGES_2024, getActiveIncomeTaxTable } = require('../utils/payrollTax');

/** Mapa conceptId → flags de afectación (para el motor de cálculo del ítem). */
async function loadConceptFlags(clinicId, session) {
  const concepts = await PayrollConcept.find({ clinic: clinicId }).select('affectsIess affectsIncomeTax').session(session || null);
  return new Map(concepts.map((c) => [String(c._id), { affectsIess: c.affectsIess, affectsIncomeTax: c.affectsIncomeTax }]));
}

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

/**
 * Lista los usuarios con cuenta en la clínica activa, indicando si ya tienen
 * ficha de empleado. Sirve para "completar datos" y registrar como empleado a
 * quienes solo tienen login en el sistema.
 */
exports.listLinkableUsers = async (req, res) => {
  try {
    const users = await User.find({ active: true, 'clinics.clinic': req.clinicId })
      .select('name email phone cedula clinics')
      .sort({ name: 1 });
    const employees = await Employee.find({ clinic: req.clinicId, user: { $ne: null } }).select('user');
    const linked = new Set(employees.map((e) => String(e.user)));
    const result = users.map((u) => ({
      _id: u._id,
      name: u.name,
      email: u.email,
      phone: u.phone || '',
      cedula: u.cedula || '',
      role: u.getRoleForClinic(req.clinicId),
      hasEmployee: linked.has(String(u._id)),
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ message: e.message }); }
};
// Normaliza referencias opcionales: '' no debe castearse a ObjectId.
function cleanEmployeeRefs(obj) {
  ['departmentRef', 'positionRef', 'paymentBankAccount', 'salaryOriginClinic', 'costCenter'].forEach((k) => {
    if (obj[k] === '' || obj[k] === undefined) obj[k] = null;
  });
}

exports.createEmployee = async (req, res) => {
  try {
    const data = { ...req.body, clinic: req.clinicId };
    cleanEmployeeRefs(data);
    // Vínculo opcional con un usuario del sistema (login). Evita strings vacíos
    // y que un mismo usuario quede vinculado a dos fichas de empleado.
    if (!data.user) {
      delete data.user;
    } else {
      const dup = await Employee.findOne({ clinic: req.clinicId, user: data.user });
      if (dup) return res.status(400).json({ message: 'Ese usuario ya tiene una ficha de empleado' });
    }
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
    cleanEmployeeRefs(patch);
    // El vínculo con usuario solo se aplica si viene un id válido; '' no debe
    // intentar castearse a ObjectId (rompería el guardado en edición normal).
    if (!patch.user) {
      delete patch.user;
    } else if (String(patch.user) !== String(e.user || '')) {
      const dup = await Employee.findOne({ clinic: req.clinicId, user: patch.user, _id: { $ne: e._id } });
      if (dup) return res.status(400).json({ message: 'Ese usuario ya tiene una ficha de empleado' });
    }
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
// El IR ya NO se calcula con tabla hardcodeada: el motor recomputeItem usa la
// tabla parametrizable (PayrollIncomeTaxTable) vía utils/payrollTax.

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
    // Departamentos parametrizados (para el snapshot de tipo de gasto en cada ítem).
    const depts = await PayrollDepartment.find({ clinic: req.clinicId });
    const deptById = new Map(depts.map((d) => [String(d._id), d]));
    // Contexto del motor de cálculo (fuente única): tasas, tabla IR y flags de conceptos.
    const taxTable = await getActiveIncomeTaxTable(req.clinicId, y);
    const conceptMap = await loadConceptFlags(req.clinicId);
    const ctx = { rates: R, taxTable, conceptMap, sbu: R.SBU_2024 };

    const items = [];
    for (const emp of employees) {
      const yearsWorked = (endOfMonth - new Date(emp.hireDate)) / (1000 * 60 * 60 * 24 * 365);
      const eligibleFondos = emp.receivesFondosReserva || yearsWorked >= 1;
      const base = effectiveBaseSalary(emp);

      // Préstamos vigentes (cuota pendiente del período).
      const loans = await EmployeeLoan.find({ clinic: req.clinicId, employee: emp._id, status: 'ACTIVO' });
      let prestamoEmpresa = 0;
      for (const l of loans) { const pend = l.installments.find((i) => !i.paid); if (pend) prestamoEmpresa += pend.amount; }

      // Deducciones pendientes del empleado (consumo, multas, anticipos, etc.).
      const deductions = await EmployeeDeduction.find({ clinic: req.clinicId, employee: emp._id, status: 'PENDIENTE' });
      let multas = 0, anticipos = 0, otherDeductions = 0;
      for (const dd of deductions) {
        if (dd.type === 'MULTA') multas += dd.amount;
        else if (dd.type === 'ANTICIPO') anticipos += dd.amount;
        else otherDeductions += dd.amount; // CONSUMO / UNIFORME / OTRO
      }

      const dept = emp.departmentRef ? deptById.get(String(emp.departmentRef)) : null;
      const item = {
        employee: emp._id, employeeName: `${emp.firstName} ${emp.lastName}`, identificacion: emp.identificacion,
        departmentRef: emp.departmentRef || null, departmentType: dept?.type || '',
        daysWorked: 30, absenceDays: 0, monthlySalary: base, baseSalary: base,
        eligibleFondos,
        prestamoEmpresa: +prestamoEmpresa.toFixed(2),
        multas: +multas.toFixed(2), anticipos: +anticipos.toFixed(2), otherDeductions: +otherDeductions.toFixed(2),
        earnings: [], deductions: [],
      };
      // MOTOR ÚNICO: décimos/fondos, IESS, IR (tabla), provisiones y totales.
      recomputeItem(item, { ...ctx, employee: emp });
      items.push(item);
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
    // No se aceptan cuentas contables manuales en el rol: se ignora cualquier
    // intento de fijar cuenta; las cuentas salen de departamento/concepto al cerrar.
    delete patch.account; delete patch.accounts;
    Object.assign(it, patch);
    if (!it.monthlySalary) it.monthlySalary = it.baseSalary; // legacy sin sueldo contractual
    // Recalcula TODO con el motor único: base prorrateada, IESS, IR (tabla), décimos,
    // provisiones y totales. Así no queda un rol con sueldo nuevo pero IESS/IR viejo.
    const R = await getRates(req.clinicId);
    const taxTable = await getActiveIncomeTaxTable(req.clinicId, p.year);
    const conceptMap = await loadConceptFlags(req.clinicId);
    const employee = await Employee.findById(it.employee);
    recomputeItem(it, { rates: R, taxTable, conceptMap, sbu: R.SBU_2024, employee });
    p.totalIngresos = +p.items.reduce((s, x) => s + (x.totalIngresos || 0), 0).toFixed(2);
    p.totalEgresos = +p.items.reduce((s, x) => s + (x.totalEgresos || 0), 0).toFixed(2);
    p.totalNeto = +p.items.reduce((s, x) => s + (x.netoPagar || 0), 0).toFixed(2);
    p.totalProvisiones = +p.items.reduce((s, x) => s + (x.totalProvisiones || 0), 0).toFixed(2);
    await p.save();
    res.json(p);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/**
 * Cierra rol y genera el asiento contable PARAMETRIZADO. Las cuentas de gasto se
 * resuelven por DEPARTAMENTO (Admin/Ventas/Costos) y las obligaciones/provisiones
 * desde la configuración; nunca se capturan a mano. Bloquea el cierre si falta una
 * cuenta crítica (p.ej. la cuenta de sueldos del departamento). Trazabilidad:
 * source NOMINA · sourceModel Payroll · sourceRef rol · sourceAction CLOSE.
 */
exports.closePayroll = async (req, res) => {
  try {
    const payrollId = await runInTransaction(async (session) => {
      const p = await Payroll.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!p) throw Object.assign(new Error('No encontrado'), { status: 404 });
      if (p.status !== 'BORRADOR') throw Object.assign(new Error('No es borrador'), { status: 400 });
      const payrollDate = new Date(p.year, p.month - 1, 28);
      await assertPeriodOpen(req.clinicId, payrollDate, { session });

      // Bloqueo: si hay empleados con ingreso (sujetos a IR) y NO hay tabla de
      // impuesto a la renta configurada para el año, no se cierra con valores
      // obsoletos (se exige configurar la tabla).
      const hasTaxableIncome = (p.items || []).some((i) => (i.totalIngresos || 0) > 0);
      if (hasTaxableIncome) {
        const taxTable = await getActiveIncomeTaxTable(req.clinicId, p.year, { session });
        if (!taxTable) {
          throw Object.assign(new Error(`No hay tabla de impuesto a la renta configurada para el año ${p.year}. Configúrela antes de cerrar el rol.`), { status: 400 });
        }
      }

      // Construye las líneas (agrega por cuenta; valida config crítica).
      const { lines } = await buildPayrollEntryLines(p, { clinicId: req.clinicId, session });

      const entry = await createEntry({
        clinicId: req.clinicId,
        date: payrollDate,
        description: `Rol de pagos ${p.period}`,
        source: 'NOMINA',
        sourceRef: p._id,
        sourceModel: 'Payroll',
        sourceAction: 'CLOSE',
        lines,
        userId: req.user._id,
        session,
      });

      // Marcar como aplicadas las deducciones pendientes de los empleados del rol.
      const totDeducciones = p.items.reduce((s, i) => s + (i.multas || 0) + (i.anticipos || 0) + (i.otherDeductions || 0), 0);
      if (totDeducciones > 0) {
        const empIds = p.items.map((i) => i.employee);
        await EmployeeDeduction.updateMany(
          { clinic: req.clinicId, employee: { $in: empIds }, status: 'PENDIENTE' },
          { $set: { status: 'APLICADO', appliedIn: p.period, appliedAt: new Date() } },
          { session }
        );
      }

      // Marcar cuotas de préstamos cubiertas por el descuento del período.
      for (const it of p.items) {
        if (it.prestamoEmpresa > 0) {
          const loans = await EmployeeLoan.find({ clinic: req.clinicId, employee: it.employee, status: 'ACTIVO' }).session(session);
          let remaining = it.prestamoEmpresa;
          for (const loan of loans) {
            for (const inst of loan.installments) {
              if (inst.paid || remaining <= 0) continue;
              if (inst.amount <= remaining + 0.01) {
                inst.paid = true;
                inst.paidIn = p.period;
                inst.paidAt = new Date();
                loan.paidAmount = +(loan.paidAmount + inst.amount).toFixed(2);
                loan.balance = +(loan.principal - loan.paidAmount).toFixed(2);
                remaining -= inst.amount;
              }
            }
            if (loan.balance <= 0.01) loan.status = 'CANCELADO';
            await loan.save({ session });
            if (remaining <= 0) break;
          }
        }
      }

      p.status = 'CERRADO';
      p.journalEntry = entry._id;
      p.closedAt = new Date();
      p.closedBy = req.user._id;
      await p.save({ session });
      return p._id;
    });
    const payroll = await Payroll.findById(payrollId);
    return res.json(payroll);
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

/**
 * Paga un rol CERRADO. Si se indica `bankAccountId`, genera el asiento de pago
 * (DEBE Sueldos por pagar · HABER Banco) y una BankTransaction que se refleja en el
 * libro de bancos y el mayor (source PAGO · sourceModel Payroll · sourceAction PAY).
 * Si NO se indica banco, solo marca PAGADO (compat legacy, sin afectación bancaria).
 */
exports.markPaid = async (req, res) => {
  try {
    const { bankAccountId, date, reference } = req.body || {};
    // Sin banco: ENDURECIDO. Antes marcaba PAGADO sin ningún asiento, dejando "Sueldos
    // por pagar" abierto indefinidamente. Ahora solo se admite un pago MANUAL/EFECTIVO
    // EXPLÍCITO (confirmNoBank), que igualmente genera el asiento de liquidación
    // (D Sueldos por pagar / H Caja) para no dejar la obligación sin liquidar.
    if (!bankAccountId) {
      if (!(req.body?.confirmNoBank === true || req.body?.force === true)) {
        return res.status(400).json({
          message: 'El pago de nómina requiere un banco. Usa "Pagar desde banco", o confirma un pago manual en efectivo (confirmNoBank), que se contabilizará contra Caja.',
        });
      }
      const payrollId = await runInTransaction(async (session) => {
        const p = await Payroll.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
        if (!p) throw Object.assign(new Error('No encontrado'), { status: 404 });
        if (p.status !== 'CERRADO') throw Object.assign(new Error('Debe estar cerrado'), { status: 400 });
        const amount = +(p.totalNeto || 0).toFixed(2);
        if (amount <= 0) throw Object.assign(new Error('El rol no tiene neto por pagar'), { status: 400 });

        const cfg = await PayrollConfig.findOne({ clinic: req.clinicId }).session(session);
        const general = await resolveConfigAccounts(req.clinicId, cfg, session);
        const caja = await getAccount(req.clinicId, 'caja', { session });
        const txDate = date ? new Date(date) : new Date();

        // Idempotente por sourceAction 'PAY' (mismo que el pago desde banco).
        const entry = await createEntry({
          clinicId: req.clinicId, date: txDate,
          description: `Pago de nómina ${p.period} (efectivo/manual)`,
          source: 'PAGO', sourceRef: p._id, sourceModel: 'Payroll', sourceAction: 'PAY',
          lines: [
            { account: general.sueldosPorPagar._id, debit: amount, credit: 0, description: 'Pago sueldos por pagar' },
            { account: caja._id, debit: 0, credit: amount, description: `Pago nómina ${p.period} (efectivo)` },
          ],
          userId: req.user._id, session,
        });

        p.status = 'PAGADO';
        p.paymentJournalEntry = entry._id;
        p.paidAt = txDate;
        p.paidBy = req.user._id;
        await p.save({ session });
        return p._id;
      });
      const payroll = await Payroll.findById(payrollId);
      return res.json(payroll);
    }

    const payrollId = await runInTransaction(async (session) => {
      const p = await Payroll.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!p) throw Object.assign(new Error('No encontrado'), { status: 404 });
      if (p.status !== 'CERRADO') throw Object.assign(new Error('Debe estar cerrado'), { status: 400 });
      const amount = +(p.totalNeto || 0).toFixed(2);
      if (amount <= 0) throw Object.assign(new Error('El rol no tiene neto por pagar'), { status: 400 });

      const bank = await BankAccount.findOne({ _id: bankAccountId, clinic: req.clinicId }).session(session);
      if (!bank) throw Object.assign(new Error('Cuenta bancaria no encontrada'), { status: 400 });
      if (!bank.chartAccount) throw Object.assign(new Error('La cuenta bancaria no tiene cuenta contable asociada'), { status: 400 });

      const cfg = await PayrollConfig.findOne({ clinic: req.clinicId }).session(session);
      const general = await resolveConfigAccounts(req.clinicId, cfg, session);
      const txDate = date ? new Date(date) : new Date();

      const entry = await createEntry({
        clinicId: req.clinicId,
        date: txDate,
        description: `Pago de nómina ${p.period}`,
        source: 'PAGO',
        sourceRef: p._id,
        sourceModel: 'Payroll',
        sourceAction: 'PAY',
        lines: [
          { account: general.sueldosPorPagar._id, debit: amount, credit: 0, description: 'Pago sueldos por pagar' },
          { account: bank.chartAccount, debit: 0, credit: amount, description: `Pago nómina ${p.period}` },
        ],
        userId: req.user._id,
        session,
      });

      const [bankTx] = await BankTransaction.create([{
        clinic: req.clinicId,
        bankAccount: bank._id,
        date: txDate,
        type: 'PAGO',
        amount,
        direction: -1,
        description: `Pago de nómina ${p.period}`,
        reference: reference || p.code || '',
        journalEntry: entry._id,
        sourceModel: 'Payroll',
        sourceRef: p._id,
        createdBy: req.user._id,
      }], { session });

      p.status = 'PAGADO';
      p.paymentJournalEntry = entry._id;
      p.paymentBankTransaction = bankTx._id;
      p.paymentBankAccount = bank._id;
      p.paidAt = txDate;
      p.paidBy = req.user._id;
      await p.save({ session });
      return p._id;
    });
    const payroll = await Payroll.findById(payrollId);
    res.json(payroll);
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

// ═══════════════════════ Catálogos parametrizados ═══════════════════════

// ---- Departamentos ----
exports.listDepartments = async (req, res) => {
  const items = await PayrollDepartment.find({ clinic: req.clinicId })
    .populate('accounts.sueldos accounts.beneficios accounts.iessPatronal', 'code name')
    .sort({ name: 1 });
  res.json(items);
};
exports.createDepartment = async (req, res) => {
  try {
    const data = { ...req.body, clinic: req.clinicId };
    ['sueldos', 'beneficios', 'iessPatronal'].forEach((k) => { if (data.accounts && !data.accounts[k]) data.accounts[k] = null; });
    const d = await PayrollDepartment.create(data);
    res.status(201).json(d);
  } catch (e) { res.status(400).json({ message: e.message }); }
};
exports.updateDepartment = async (req, res) => {
  try {
    const d = await PayrollDepartment.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!d) return res.status(404).json({ message: 'No encontrado' });
    const patch = { ...req.body }; delete patch.clinic;
    Object.assign(d, patch);
    await d.save();
    res.json(d);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

// ---- Cargos ----
exports.listPositions = async (req, res) => {
  const items = await PayrollPosition.find({ clinic: req.clinicId }).populate('department', 'name type').sort({ name: 1 });
  res.json(items);
};
exports.createPosition = async (req, res) => {
  try {
    const data = { ...req.body, clinic: req.clinicId };
    if (!data.department) data.department = null;
    const p = await PayrollPosition.create(data);
    res.status(201).json(p);
  } catch (e) { res.status(400).json({ message: e.message }); }
};
exports.updatePosition = async (req, res) => {
  try {
    const p = await PayrollPosition.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!p) return res.status(404).json({ message: 'No encontrado' });
    const patch = { ...req.body }; delete patch.clinic;
    if (patch.department === '') patch.department = null;
    Object.assign(p, patch);
    await p.save();
    res.json(p);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

// ---- Conceptos (rubros) ----
exports.listConcepts = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.type) filter.type = req.query.type;
  const items = await PayrollConcept.find(filter)
    .populate('defaultAccount payableAccount', 'code name')
    .sort({ type: 1, code: 1 });
  res.json(items);
};
exports.createConcept = async (req, res) => {
  try {
    const data = { ...req.body, clinic: req.clinicId };
    if (!data.defaultAccount) data.defaultAccount = null;
    if (!data.payableAccount) data.payableAccount = null;
    const c = await PayrollConcept.create(data);
    res.status(201).json(c);
  } catch (e) { res.status(400).json({ message: e.message }); }
};
exports.updateConcept = async (req, res) => {
  try {
    const c = await PayrollConcept.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!c) return res.status(404).json({ message: 'No encontrado' });
    const patch = { ...req.body }; delete patch.clinic;
    if (patch.defaultAccount === '') patch.defaultAccount = null;
    if (patch.payableAccount === '') patch.payableAccount = null;
    Object.assign(c, patch);
    await c.save();
    res.json(c);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/**
 * Catálogo estándar de conceptos de nómina (Ecuador). Sin cuentas asignadas: el
 * contador las mapea después. Idempotente: no duplica códigos existentes.
 */
const STANDARD_CONCEPTS = [
  // Ingresos
  { code: 'ING-SUELDO', name: 'Sueldo', type: 'INGRESO', category: 'SUELDO', affectsIess: true, affectsDecimos: true, affectsIncomeTax: true },
  { code: 'ING-TRANSPORTE', name: 'Transporte', type: 'INGRESO', category: 'BONO' },
  { code: 'ING-COMISIONES', name: 'Comisiones', type: 'INGRESO', category: 'COMISION', affectsIess: true, affectsDecimos: true, affectsIncomeTax: true },
  { code: 'ING-BONIFICACION', name: 'Bonificación', type: 'INGRESO', category: 'BONO', affectsIncomeTax: true },
  { code: 'ING-ALIMENTACION', name: 'Alimentación', type: 'INGRESO', category: 'BONO' },
  { code: 'ING-VIVIENDA', name: 'Vivienda', type: 'INGRESO', category: 'BONO' },
  { code: 'ING-HE25', name: 'Horas extra 25%', type: 'INGRESO', category: 'HORAS_EXTRAS', rate: 25, affectsIess: true, affectsDecimos: true, affectsIncomeTax: true },
  { code: 'ING-HE50', name: 'Horas extra 50%', type: 'INGRESO', category: 'HORAS_EXTRAS', rate: 50, affectsIess: true, affectsDecimos: true, affectsIncomeTax: true },
  { code: 'ING-HE100', name: 'Horas extra 100%', type: 'INGRESO', category: 'HORAS_EXTRAS', rate: 100, affectsIess: true, affectsDecimos: true, affectsIncomeTax: true },
  { code: 'ING-VACACIONES', name: 'Vacaciones', type: 'INGRESO', category: 'VACACIONES' },
  { code: 'ING-FONDOS-RESERVA', name: 'Fondos de reserva', type: 'INGRESO', category: 'FONDOS_RESERVA', rate: 8.33 },
  { code: 'ING-DECIMO-TERCERO', name: 'Décimo tercero', type: 'INGRESO', category: 'DECIMO' },
  { code: 'ING-DECIMO-CUARTO', name: 'Décimo cuarto', type: 'INGRESO', category: 'DECIMO' },
  // Egresos
  { code: 'EGR-ANTICIPO', name: 'Anticipo', type: 'EGRESO', category: 'ANTICIPO' },
  { code: 'EGR-PREST-HIPOTECARIO', name: 'Préstamo hipotecario', type: 'EGRESO', category: 'PRESTAMO' },
  { code: 'EGR-PREST-QUIROGRAFARIO', name: 'Préstamo quirografario', type: 'EGRESO', category: 'PRESTAMO' },
  { code: 'EGR-PREST-PERSONAL', name: 'Préstamo personal', type: 'EGRESO', category: 'PRESTAMO' },
  { code: 'EGR-MULTAS', name: 'Multas', type: 'EGRESO', category: 'MULTA' },
  { code: 'EGR-SEGURO', name: 'Seguro', type: 'EGRESO', category: 'DESCUENTO' },
  { code: 'EGR-CELULAR', name: 'Celular', type: 'EGRESO', category: 'DESCUENTO' },
  { code: 'EGR-AUSENCIAS', name: 'Ausencias', type: 'EGRESO', category: 'AUSENCIA' },
  { code: 'EGR-EXT-CONYUGAL', name: 'Extensión conyugal', type: 'EGRESO', category: 'DESCUENTO' },
  { code: 'EGR-IMPUESTO-RENTA', name: 'Impuesto a la renta', type: 'EGRESO', category: 'IMPUESTO', affectsIncomeTax: true },
  { code: 'EGR-OTROS', name: 'Otros descuentos', type: 'EGRESO', category: 'DESCUENTO' },
  // Obligaciones / provisiones
  { code: 'OBL-IESS-PERSONAL', name: 'IESS personal', type: 'OBLIGACION', category: 'IESS', rate: 9.45 },
  { code: 'OBL-IESS-PATRONAL', name: 'Aporte patronal', type: 'OBLIGACION', category: 'IESS', rate: 11.15 },
  { code: 'OBL-SECAP-IECE', name: 'SECAP/IECE', type: 'OBLIGACION', category: 'IESS', rate: 1 },
  { code: 'PRV-SUELDOS-PAGAR', name: 'Sueldos por pagar', type: 'OBLIGACION', category: 'POR_PAGAR' },
  { code: 'PRV-DECIMO-TERCERO', name: 'Décimo tercero por pagar', type: 'PROVISION', category: 'DECIMO' },
  { code: 'PRV-DECIMO-CUARTO', name: 'Décimo cuarto por pagar', type: 'PROVISION', category: 'DECIMO' },
  { code: 'PRV-FONDOS-RESERVA', name: 'Fondos de reserva por pagar', type: 'PROVISION', category: 'FONDOS_RESERVA' },
  { code: 'PRV-VACACIONES', name: 'Vacaciones por pagar', type: 'PROVISION', category: 'VACACIONES' },
];

exports.seedConcepts = async (req, res) => {
  try {
    const existing = await PayrollConcept.find({ clinic: req.clinicId }).select('code');
    const have = new Set(existing.map((c) => c.code));
    const toCreate = STANDARD_CONCEPTS.filter((c) => !have.has(c.code)).map((c) => ({ ...c, clinic: req.clinicId }));
    if (toCreate.length) await PayrollConcept.insertMany(toCreate);
    const all = await PayrollConcept.find({ clinic: req.clinicId }).sort({ type: 1, code: 1 });
    res.json({ created: toCreate.length, total: all.length, concepts: all });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

// ---- Tabla de impuesto a la renta (parametrizable por año) ----
exports.listIncomeTaxTables = async (req, res) => {
  const items = await PayrollIncomeTaxTable.find({ clinic: req.clinicId }).sort({ year: -1, active: -1 });
  res.json(items);
};
exports.createIncomeTaxTable = async (req, res) => {
  try {
    const data = { ...req.body, clinic: req.clinicId };
    if (!data.year) return res.status(400).json({ message: 'year requerido' });
    // Solo una tabla ACTIVA por año: si esta entra activa, desactiva las previas.
    if (data.active !== false) {
      await PayrollIncomeTaxTable.updateMany({ clinic: req.clinicId, year: data.year, active: true }, { $set: { active: false } });
      data.active = true;
    }
    const t = await PayrollIncomeTaxTable.create(data);
    res.status(201).json(t);
  } catch (e) { res.status(400).json({ message: e.message }); }
};
exports.updateIncomeTaxTable = async (req, res) => {
  try {
    const t = await PayrollIncomeTaxTable.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!t) return res.status(404).json({ message: 'No encontrado' });
    const patch = { ...req.body }; delete patch.clinic;
    // Al activar esta tabla, desactiva otras del mismo año.
    if (patch.active === true) {
      await PayrollIncomeTaxTable.updateMany({ clinic: req.clinicId, year: patch.year || t.year, active: true, _id: { $ne: t._id } }, { $set: { active: false } });
    }
    Object.assign(t, patch);
    await t.save();
    res.json(t);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/**
 * Siembra la tabla de IR de un año con los rangos por defecto (SRI 2024) SOLO si
 * no existe una tabla activa para ese año. Idempotente. El contador debe validar
 * los valores vigentes.
 */
exports.seedIncomeTaxTable = async (req, res) => {
  try {
    const year = parseInt(req.body?.year || req.query?.year) || new Date().getFullYear();
    const existing = await PayrollIncomeTaxTable.findOne({ clinic: req.clinicId, year, active: true });
    if (existing) return res.json({ created: false, table: existing, warning: 'Ya existe una tabla activa; valida los valores vigentes.' });
    const t = await PayrollIncomeTaxTable.create({
      clinic: req.clinicId, year, periodType: 'ANNUAL', active: true,
      ranges: DEFAULT_IR_RANGES_2024,
      notes: 'Semilla SRI 2024. VALIDAR los valores vigentes del año antes de declarar.',
    });
    res.status(201).json({ created: true, table: t, warning: 'Semilla SRI 2024: valida/actualiza los valores vigentes del año.' });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

module.exports.STANDARD_CONCEPTS = STANDARD_CONCEPTS;
