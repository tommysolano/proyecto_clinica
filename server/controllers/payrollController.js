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
const Payable = require('../models/Payable');
const JournalEntry = require('../models/JournalEntry');
const ChartOfAccount = require('../models/ChartOfAccount');
const { createEntry, findAccount, reverseEntry, runInTransaction, assertPeriodOpen, ensureAccountByCode } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const { openPayable, applyToPayable, voidPayable } = require('../utils/subledger');
const BankCheck = require('../models/BankCheck');
const { recomputeItem, buildPayrollEntryLines, resolveConfigAccounts } = require('../utils/payrollPosting');
const { girarCheque, liberarCheque } = require('../services/bankChecks');
const {
  LOAN_TYPES, DISBURSEMENT_METHODS, DISBURSEMENT_LABELS, loanType, loanTypeDef,
} = require('../services/employeeLoanTypes');
const { DEPT_TYPES, POSTING_DEFAULT_CODES, DEPT_NAME_HINTS } = PayrollConfig;
const { DEFAULT_IR_RANGES_2024, getActiveIncomeTaxTable } = require('../utils/payrollTax');
const { payrollWithholdingForPeriod } = require('../utils/payrollWithholding');
const {
  readIdempotencyKey, fingerprint, assertSameFingerprint, assertSameTarget, normalize: N,
} = require('../utils/idempotency');

const r2 = (n) => +(Number(n) || 0).toFixed(2);

/**
 * Adjunta al rol el estado REAL de su obligación (CxP), que es la fuente de verdad del
 * saldo. Si el rol tiene `payableRef`/CxP, `paidAmount` y `pendingAmount` se toman de ella y
 * NO del estado del rol: un rol legacy marcado PAGADO cuya CxP todavía tiene saldo muestra
 * el saldo real, no cero. Solo cuando no hay cartera se usan los virtuales del modelo
 * (fallback legacy documentado en models/Payroll.js).
 */
async function withObligation(payroll, clinicId) {
  if (!payroll) return payroll;
  const obj = payroll.toObject ? payroll.toObject({ virtuals: true }) : { ...payroll };
  const cxp = await Payable.findOne({
    clinic: clinicId, sourceModel: 'Payroll', sourceRef: payroll._id,
  }).lean();
  if (!cxp) return { ...obj, obligacion: null };
  return {
    ...obj,
    paidAmount: r2(cxp.applied),
    pendingAmount: r2(cxp.balance),
    obligacion: {
      total: r2(cxp.total),
      applied: r2(cxp.applied),
      balance: r2(cxp.balance),
      status: cxp.status,
      dueDate: cxp.dueDate,
      plannedPaymentDate: cxp.plannedPaymentDate || null,
    },
  };
}

/**
 * Abre (o sincroniza) la OBLIGACIÓN por el neto de sueldos por pagar del rol.
 *
 * El pasivo contable ya lo reconoció el asiento de cierre (crédito a «Sueldos por
 * pagar»): esta CxP es SOLO el documento de submayor que hace la obligación visible
 * y proyectable en el flujo de caja. NO genera un segundo crédito.
 *
 * Idempotente por (clínica, Payroll, rolId): cerrar dos veces no duplica la obligación.
 */
async function openPayrollObligation(p, { clinicId, account, session }) {
  const neto = r2(p.totalNeto);
  if (neto <= 0) return null;
  return openPayable({
    clinic: clinicId,
    party: { model: 'Employee', ref: null, name: `Empleados — rol ${p.period}` },
    sourceModel: 'Payroll',
    sourceRef: p._id,
    docType: 'OTRO',
    number: p.code || `ROL-${p.period}`,
    issueDate: p.accountingDate || new Date(),
    dueDate: p.scheduledPaymentDate || null,
    total: neto,
    account,
    notes: `Neto de sueldos por pagar del rol ${p.period}`,
  }, { session });
}

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

// Los 4 departamentos estándar sembrados por clínica (la contadora solo crea CARGOS).
const STANDARD_DEPARTMENTS = [
  { name: 'Administrativo', type: 'ADMINISTRATIVO' },
  { name: 'Ventas', type: 'VENTAS' },
  { name: 'Costos', type: 'COSTOS' },
  { name: 'Otros', type: 'OTROS' },
];

/**
 * Siembra (idempotente) los 4 departamentos estándar de la clínica. Devuelve todos los
 * departamentos. Si ya existe uno del mismo TIPO no crea otro (reutiliza el existente,
 * p.ej. tras la migración de departamentos personalizados).
 */
async function ensureStandardDepartments(clinicId) {
  const existing = await PayrollDepartment.find({ clinic: clinicId });
  const byType = new Map(existing.map((d) => [d.type, d]));
  const toCreate = STANDARD_DEPARTMENTS
    .filter((s) => !byType.has(s.type))
    .map((s) => ({ clinic: clinicId, name: s.name, type: s.type }));
  if (toCreate.length) {
    // Evita chocar con el índice único (clinic, name): salta nombres ya usados.
    const names = new Set(existing.map((d) => d.name));
    const safe = toCreate.filter((d) => !names.has(d.name));
    if (safe.length) await PayrollDepartment.insertMany(safe, { ordered: false }).catch(() => {});
  }
  return PayrollDepartment.find({ clinic: clinicId }).sort({ name: 1 });
}

/**
 * Rellena los campos de cuenta AÚN NO DEFINIDOS (undefined) de la config con valores por
 * defecto: los rubros centrales por CÓDIGO (creando la cuenta si hace falta) y los rubros
 * granulares de ingreso por NOMBRE (si ya existe una cuenta similar en el plan). No pisa
 * las cuentas que la contadora ya asignó ni las que dejó en blanco a propósito (null).
 * Idempotente. Devuelve true si cambió algo.
 */
async function seedPayrollAccountDefaults(cfg, clinicId) {
  cfg.accounts = cfg.accounts || {};
  cfg.accounts.global = cfg.accounts.global || {};
  cfg.accounts.byDepartment = cfg.accounts.byDepartment || {};
  let changed = false;

  const setIfUnset = (bucket, field, id) => {
    if (id && bucket[field] === undefined) { bucket[field] = id; changed = true; }
  };

  // Globales por código.
  for (const [field, code] of Object.entries(POSTING_DEFAULT_CODES.global)) {
    if (cfg.accounts.global[field] === undefined) {
      const acc = await ensureAccountByCode(clinicId, code);
      setIfUnset(cfg.accounts.global, field, acc?._id);
    }
  }
  // Cuentas de GASTO por nombre (para pre-cargar los granulares de ingreso, sin crear cuentas).
  const gastoAccounts = await ChartOfAccount.find({ clinic: clinicId, type: { $in: ['GASTO', 'COSTO'] }, allowsMovement: { $ne: false } }).select('name');
  const findByName = (re) => gastoAccounts.find((a) => re.test(a.name || ''));

  for (const type of DEPT_TYPES) {
    cfg.accounts.byDepartment[type] = cfg.accounts.byDepartment[type] || {};
    const bucket = cfg.accounts.byDepartment[type];
    for (const [field, code] of Object.entries(POSTING_DEFAULT_CODES.byDepartment)) {
      if (bucket[field] === undefined) {
        const acc = await ensureAccountByCode(clinicId, code);
        setIfUnset(bucket, field, acc?._id);
      }
    }
    for (const [field, re] of Object.entries(DEPT_NAME_HINTS)) {
      if (bucket[field] === undefined) {
        const acc = findByName(re);
        if (acc) setIfUnset(bucket, field, acc._id);
      }
    }
  }
  if (changed) { cfg.markModified('accounts'); }
  return changed;
}

/**
 * COHERENCIA PANTALLA ↔ POSTEO. Siembra en la config los rubros con DEFAULT DE POSTEO que
 * estén sin cuenta (null O undefined), con la MISMA cuenta que resolvería el cierre de rol
 * (`makeAccountResolver`: valor falsy → default por código). Así la contadora ve EXACTAMENTE
 * las cuentas a las que se contabiliza y puede cambiarlas si no está de acuerdo, en lugar de
 * ver campos vacíos que sin embargo posteaban a una cuenta oculta.
 *
 * NO toca:
 *   - los ObjectId ya asignados (respeta lo que la contadora configuró, incl. mapeo legacy);
 *   - los rubros SIN default de posteo (alimentación, transporte, comisiones, comisariato,
 *     farmacia, etc.): quedan en blanco y el cierre los sigue BLOQUEANDO si se usan sin cuenta.
 *
 * Idempotente. Devuelve { changed, seeded[] } para el resumen/diagnóstico.
 */
async function seedPostingDefaults(cfg, clinicId) {
  cfg.accounts = cfg.accounts || {};
  cfg.accounts.global = cfg.accounts.global || {};
  cfg.accounts.byDepartment = cfg.accounts.byDepartment || {};
  const seeded = [];
  let changed = false;

  const fill = async (bucket, scopeLabel, field, code) => {
    if (bucket[field]) return; // ObjectId ya asignado: no se toca (mismo criterio que el posteo)
    const acc = await ensureAccountByCode(clinicId, code);
    if (acc?._id) {
      bucket[field] = acc._id;
      changed = true;
      seeded.push({ scope: scopeLabel, field, code, account: String(acc._id), accountName: acc.name || '' });
    }
  };

  for (const [field, code] of Object.entries(POSTING_DEFAULT_CODES.global)) {
    await fill(cfg.accounts.global, 'global', field, code);
  }
  for (const type of DEPT_TYPES) {
    cfg.accounts.byDepartment[type] = cfg.accounts.byDepartment[type] || {};
    for (const [field, code] of Object.entries(POSTING_DEFAULT_CODES.byDepartment)) {
      await fill(cfg.accounts.byDepartment[type], type, field, code);
    }
  }
  if (changed) cfg.markModified('accounts');
  return { changed, seeded };
}

exports.getConfig = async (req, res) => {
  try {
    let cfg = await PayrollConfig.findOne({ clinic: req.clinicId });
    await ensureStandardDepartments(req.clinicId);
    let mustSave = false;
    if (!cfg) {
      // Config NUEVA: se siembra con las cuentas predeterminadas (la contadora las revisa/ajusta).
      cfg = new PayrollConfig({ clinic: req.clinicId });
      await seedPayrollAccountDefaults(cfg, req.clinicId);
      mustSave = true;
    }
    // Coherencia pantalla↔posteo (config nueva o existente): rellena los rubros con default de
    // posteo que estén vacíos con la MISMA cuenta que usaría el cierre. Solo pisa null/undefined,
    // nunca un ObjectId ya asignado, así que preserva el mapeo explícito (incl. legacy).
    const { changed } = await seedPostingDefaults(cfg, req.clinicId);
    if (mustSave || changed) await cfg.save();
    res.json(cfg);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

// Normaliza los campos de cuenta de un bucket: '' → null (bug 3.3: un select vacío no debe
// castearse a ObjectId y reventar el guardado). Deja los ObjectId tal cual.
function sanitizeAccountBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return bucket;
  const out = {};
  for (const [k, v] of Object.entries(bucket)) out[k] = (v === '' || v == null) ? null : v;
  return out;
}

exports.updateConfig = async (req, res) => {
  try {
    let cfg = await PayrollConfig.findOne({ clinic: req.clinicId });
    if (!cfg) cfg = new PayrollConfig({ clinic: req.clinicId });
    const patch = { ...req.body }; delete patch.clinic;
    // Sanitiza el mapeo de cuentas: '' → null en global y en cada departamento.
    if (patch.accounts && typeof patch.accounts === 'object') {
      const acc = { ...patch.accounts };
      if (acc.global) acc.global = sanitizeAccountBucket(acc.global);
      if (acc.byDepartment && typeof acc.byDepartment === 'object') {
        const bd = {};
        for (const [type, bucket] of Object.entries(acc.byDepartment)) bd[type] = sanitizeAccountBucket(bucket);
        acc.byDepartment = bd;
      }
      patch.accounts = acc;
      cfg.accounts = { global: acc.global || {}, byDepartment: acc.byDepartment || {} };
      cfg.markModified('accounts');
      delete patch.accounts;
    }
    Object.assign(cfg, patch);
    await cfg.save();
    res.json(cfg);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/**
 * Copia las cuentas de GASTO por departamento de un TIPO a otro (evita configurar 4 veces
 * lo mismo). body: { from: 'ADMINISTRATIVO', to: 'VENTAS' }.
 */
exports.copyDepartmentAccounts = async (req, res) => {
  try {
    const from = String(req.body?.from || '').toUpperCase();
    const to = String(req.body?.to || '').toUpperCase();
    if (!DEPT_TYPES.includes(from) || !DEPT_TYPES.includes(to) || from === to) {
      return res.status(400).json({ message: 'Departamentos de origen/destino inválidos.' });
    }
    let cfg = await PayrollConfig.findOne({ clinic: req.clinicId });
    if (!cfg) cfg = new PayrollConfig({ clinic: req.clinicId });
    cfg.accounts = cfg.accounts || {}; cfg.accounts.byDepartment = cfg.accounts.byDepartment || {};
    const src = cfg.accounts.byDepartment[from] ? (cfg.accounts.byDepartment[from].toObject ? cfg.accounts.byDepartment[from].toObject() : cfg.accounts.byDepartment[from]) : {};
    cfg.accounts.byDepartment[to] = { ...src };
    cfg.markModified('accounts');
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
      .select('name email phone cedula clinics worksInAllClinics')
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
  ['departmentRef', 'positionRef', 'paymentBankAccount', 'salaryOriginClinic', 'costCenter', 'user'].forEach((k) => {
    if (obj[k] === '' || obj[k] === undefined) obj[k] = null;
  });
}

/**
 * Traduce los errores de guardado de empleado a un mensaje CLARO (el bug del usuario vinculado
 * mostraba errores crudos tipo «... ficha de empleado» / cast de fecha). Devuelve string o null.
 */
function friendlyEmployeeError(err) {
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern || err.keyValue || {}).find((k) => k !== 'clinic') || '';
    if (field.includes('identificacion')) return 'Ya existe un empleado con esa identificación (cédula/RUC) en la clínica.';
    if (field.includes('code')) return 'Ya existe un empleado con ese código en la clínica.';
    return 'Ya existe un empleado con esos datos (identificación o código duplicado).';
  }
  if (err?.name === 'ValidationError') {
    const paths = Object.keys(err.errors || {});
    if (paths.includes('hireDate')) return 'La fecha de ingreso es obligatoria y debe ser una fecha válida.';
    if (paths.includes('baseSalary')) return 'El sueldo base es obligatorio y debe ser un número válido.';
    const first = err.errors[paths[0]];
    if (first) return `Dato inválido en «${paths[0]}»: ${first.message}`;
  }
  if (err?.name === 'CastError' && err.path === 'hireDate') return 'La fecha de ingreso no es válida.';
  return null;
}

/**
 * Comprueba si un usuario ya está vinculado a OTRA ficha de empleado y devuelve un mensaje claro
 * (indicando el nombre y si esa ficha está inactiva, que era la fuente de confusión al re-vincular).
 */
async function userLinkConflict(clinicId, userId, excludeEmployeeId = null) {
  const filter = { clinic: clinicId, user: userId };
  if (excludeEmployeeId) filter._id = { $ne: excludeEmployeeId };
  const dup = await Employee.findOne(filter).select('firstName lastName active');
  if (!dup) return null;
  const quien = `${dup.firstName || ''} ${dup.lastName || ''}`.trim() || 'otro empleado';
  return dup.active === false
    ? `Ese usuario ya está vinculado a la ficha INACTIVA de «${quien}». Reactívala o desvincula el usuario de ella antes de volver a usarlo.`
    : `Ese usuario ya está vinculado a la ficha de «${quien}».`;
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
      const conflict = await userLinkConflict(req.clinicId, data.user);
      if (conflict) return res.status(400).json({ message: conflict });
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
  catch (err) { res.status(400).json({ message: friendlyEmployeeError(err) || err.message }); }
};
exports.updateEmployee = async (req, res) => {
  try {
    const e = await Employee.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!e) return res.status(404).json({ message: 'No encontrado' });
    const patch = { ...req.body };
    cleanEmployeeRefs(patch);
    // El vínculo con usuario solo se aplica si viene un id válido; '' no debe
    // intentar castearse a ObjectId (rompería el guardado en edición normal).
    if (patch.user == null || patch.user === '') {
      delete patch.user;
    } else if (String(patch.user) !== String(e.user || '')) {
      const conflict = await userLinkConflict(req.clinicId, patch.user, e._id);
      if (conflict) return res.status(400).json({ message: conflict });
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
  } catch (err) { res.status(400).json({ message: friendlyEmployeeError(err) || err.message }); }
};
exports.deleteEmployee = async (req, res) => {
  const e = await Employee.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!e) return res.status(404).json({ message: 'No encontrado' });
  e.active = false; e.exitDate = new Date(); await e.save();
  res.json({ message: 'Inactivado', employee: e });
};

// ----- Préstamos y descuentos al empleado -----
exports.listLoans = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.employee) filter.employee = req.query.employee;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.type) filter.type = req.query.type;
  const items = await EmployeeLoan.find(filter)
    .populate('employee', 'code firstName lastName')
    .populate('receivableAccount counterAccount', 'code name')
    .populate('bankAccount', 'name bank')
    .sort({ createdAt: -1 });
  res.json(items);
};

/** Catálogo de tipos con su cuenta propuesta (lo pinta el formulario). */
exports.loanTypes = async (req, res) => {
  try {
    const cfg = await PayrollConfig.findOne({ clinic: req.clinicId });
    const salida = [];
    for (const [key, def] of Object.entries(LOAN_TYPES)) {
      const acc = await resolveLoanAccount(req.clinicId, cfg, def.accountField);
      salida.push({
        type: key,
        label: def.label,
        disburses: def.disburses,
        account: acc ? { _id: acc._id, code: acc.code, name: acc.name } : null,
        accountField: def.accountField,
      });
    }
    res.json({ types: salida, methods: DISBURSEMENT_LABELS });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/**
 * Cuenta configurada para un rubro global de nómina, con el código por defecto como respaldo
 * (misma resolución que usa el cierre del rol: la cuenta del préstamo y la que el rol acredita
 * al recuperarlo tienen que ser la misma).
 */
async function resolveLoanAccount(clinicId, cfg, field, session) {
  const id = cfg?.accounts?.global?.[field];
  if (id) {
    const acc = await ChartOfAccount.findOne({ _id: id, clinic: clinicId }).session(session || null);
    if (acc) return acc;
  }
  const code = POSTING_DEFAULT_CODES.global[field];
  if (!code) return null;
  return ChartOfAccount.findOne({ clinic: clinicId, code }).session(session || null);
}

/**
 * Registra un préstamo/descuento al empleado CON SU ASIENTO.
 *
 * Asiento: DEBE la cuenta por cobrar del tipo (quirografario, hipotecario, empresa, anticipo,
 * multa…) y HABER el origen del dinero: la cuenta bancaria (transferencia o cheque), caja,
 * caja chica, o la contrapartida que indique el contador cuando no sale dinero.
 *
 * Cuando el origen es un banco se registra además el movimiento bancario, para que el
 * desembolso aparezca en Bancos → Movimientos y se pueda conciliar; con cheque se gira contra
 * la chequera (el número tiene que existir y estar disponible).
 *
 * body: { employee, type, principal, installmentsCount, grantDate, description,
 *         disbursementMethod, bankAccount?, checkNumber?, reference?,
 *         receivableAccount?, counterAccount? }
 */
exports.createLoan = async (req, res) => {
  try {
    const loanId = await runInTransaction(async (session) => {
      const {
        employee, installmentsCount, interestRate = 0, grantDate, description,
        disbursementMethod, bankAccount, checkNumber, reference,
      } = req.body;
      const tipo = loanType(req.body.type);
      const def = loanTypeDef(tipo);
      const principal = r2(req.body.principal);
      const cuotas = parseInt(installmentsCount, 10) || 0;

      if (!employee) throw Object.assign(new Error('Selecciona el empleado'), { status: 400 });
      if (!(principal > 0)) throw Object.assign(new Error('El monto debe ser mayor que cero'), { status: 400 });
      if (cuotas < 1) throw Object.assign(new Error('El número de cuotas debe ser al menos 1'), { status: 400 });

      const emp = await Employee.findOne({ _id: employee, clinic: req.clinicId }).session(session);
      if (!emp) throw Object.assign(new Error('Empleado no encontrado'), { status: 404 });

      const fecha = grantDate ? new Date(grantDate) : new Date();
      await assertPeriodOpen(req.clinicId, fecha, { session });

      // ── Cuentas del asiento ──────────────────────────────────────────────────────────
      const cfg = await PayrollConfig.findOne({ clinic: req.clinicId }).session(session);
      let debe = null;
      if (req.body.receivableAccount) {
        debe = await ChartOfAccount.findOne({ _id: req.body.receivableAccount, clinic: req.clinicId }).session(session);
      }
      if (!debe) debe = await resolveLoanAccount(req.clinicId, cfg, def.accountField, session);
      if (!debe) {
        throw Object.assign(new Error(
          `No hay cuenta configurada para «${def.label}». Configúrala en Nómina → Configuración → Cuentas Contables `
          + `(rubro ${def.accountField}) o elígela en el formulario.`
        ), { status: 400 });
      }

      const metodo = DISBURSEMENT_METHODS.includes(disbursementMethod)
        ? disbursementMethod
        : (def.disburses ? 'TRANSFERENCIA' : 'SIN_DESEMBOLSO');

      let haber = null;
      let banco = null;
      if (metodo === 'TRANSFERENCIA' || metodo === 'CHEQUE') {
        if (!bankAccount) throw Object.assign(new Error('Selecciona la cuenta bancaria desde la que sale el dinero'), { status: 400 });
        banco = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId }).session(session);
        if (!banco) throw Object.assign(new Error('Cuenta bancaria no encontrada'), { status: 404 });
        if (!banco.chartAccount) throw Object.assign(new Error('La cuenta bancaria no tiene cuenta contable asociada'), { status: 400 });
        haber = await ChartOfAccount.findById(banco.chartAccount).session(session);
      } else if (metodo === 'EFECTIVO') {
        haber = await getAccount(req.clinicId, 'caja', { session });
      } else if (metodo === 'CAJA_CHICA') {
        haber = await getAccount(req.clinicId, 'cajaChica', { session });
      } else {
        if (!req.body.counterAccount) {
          throw Object.assign(new Error(
            'Sin desembolso hay que indicar la contrapartida del asiento: la cuenta contra la que se registra '
            + `«${def.label}» (por ejemplo, la recuperación de gasto o el ingreso por la multa).`
          ), { status: 400 });
        }
        haber = await ChartOfAccount.findOne({ _id: req.body.counterAccount, clinic: req.clinicId }).session(session);
        if (!haber) throw Object.assign(new Error('Cuenta de contrapartida no encontrada'), { status: 404 });
      }

      // ── Cuotas ───────────────────────────────────────────────────────────────────────
      const cuota = r2(principal / cuotas);
      const installments = [];
      let acumulado = 0;
      for (let i = 1; i <= cuotas; i += 1) {
        const d = new Date(fecha); d.setMonth(d.getMonth() + i);
        // La última cuota absorbe el redondeo: si no, la suma de cuotas no daba el capital.
        const monto = i === cuotas ? r2(principal - acumulado) : cuota;
        acumulado = r2(acumulado + monto);
        installments.push({ number: i, dueDate: d, amount: monto, paid: false });
      }

      const [loan] = await EmployeeLoan.create([{
        clinic: req.clinicId,
        employee,
        type: tipo,
        principal,
        installmentsCount: cuotas,
        installmentAmount: cuota,
        interestRate,
        grantDate: fecha,
        description,
        installments,
        balance: principal,
        receivableAccount: debe._id,
        counterAccount: metodo === 'SIN_DESEMBOLSO' ? haber._id : null,
        disbursementMethod: metodo,
        bankAccount: banco?._id || null,
        reference: reference || '',
        createdBy: req.user._id,
      }], { session });

      const glosa = `${def.label} — ${emp.firstName} ${emp.lastName}`;
      const entry = await createEntry({
        clinicId: req.clinicId,
        date: fecha,
        description: description ? `${glosa} (${description})` : glosa,
        source: 'NOMINA',
        sourceModel: 'EmployeeLoan',
        sourceRef: loan._id,
        sourceAction: 'GRANT',
        lines: [
          { account: debe._id, debit: principal, credit: 0, description: glosa },
          { account: haber._id, debit: 0, credit: principal, description: glosa },
        ],
        userId: req.user._id,
        session,
      });
      loan.journalEntry = entry._id;

      if (banco) {
        let numeroCheque = checkNumber || null;
        if (metodo === 'CHEQUE' && !numeroCheque) {
          const libre = await BankCheck.findOne({
            clinic: req.clinicId, bankAccount: banco._id, status: 'DISPONIBLE',
          }).sort({ number: 1 }).session(session);
          if (!libre) {
            throw Object.assign(new Error(
              'No quedan cheques disponibles en la chequera de esta cuenta. Genera el siguiente rango en Bancos → Cheques.'
            ), { status: 400 });
          }
          numeroCheque = String(libre.number);
        }
        const [tx] = await BankTransaction.create([{
          clinic: req.clinicId,
          bankAccount: banco._id,
          date: fecha,
          type: metodo === 'CHEQUE' ? 'CHEQUE_EMITIDO' : 'PAGO',
          amount: principal,
          direction: -1,
          description: glosa,
          reference: reference || '',
          checkNumber: numeroCheque,
          partyName: `${emp.firstName} ${emp.lastName}`,
          costCenter: emp.costCenter || null,
          journalEntry: entry._id,
          sourceModel: 'EmployeeLoan',
          sourceRef: loan._id,
          createdBy: req.user._id,
        }], { session });
        loan.bankTransaction = tx._id;
        loan.checkNumber = numeroCheque || '';
        if (metodo === 'CHEQUE') {
          await girarCheque({
            clinicId: req.clinicId, bankId: banco._id, number: numeroCheque,
            beneficiary: `${emp.firstName} ${emp.lastName}`, amount: principal, date: fecha,
            transactionId: tx._id, session,
          });
        }
      }

      await loan.save({ session });
      return loan._id;
    });

    const loan = await EmployeeLoan.findById(loanId)
      .populate('employee', 'code firstName lastName')
      .populate('receivableAccount counterAccount', 'code name');
    return res.status(201).json(loan);
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/**
 * Anula un préstamo/descuento: reversa su asiento, anula el movimiento bancario (devolviendo
 * el saldo del banco y el cheque a la chequera) y lo saca de los descuentos del rol.
 * No se puede anular si ya se descontó alguna cuota en un rol.
 */
exports.voidLoan = async (req, res) => {
  try {
    const result = await runInTransaction(async (session) => {
      const loan = await EmployeeLoan.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!loan) throw Object.assign(new Error('No encontrado'), { status: 404 });
      if (loan.status === 'ANULADO') throw Object.assign(new Error('Ya está anulado'), { status: 400 });
      const cobrada = (loan.installments || []).find((i) => i.paid);
      if (cobrada) {
        throw Object.assign(new Error(
          `No se puede anular: la cuota ${cobrada.number} ya se descontó en el rol ${cobrada.paidIn || ''}. `
          + 'Reabre ese rol primero.'
        ), { status: 400 });
      }

      const fecha = req.body?.date ? new Date(req.body.date) : new Date();
      await assertPeriodOpen(req.clinicId, fecha, { session });

      if (loan.bankTransaction) {
        const tx = await BankTransaction.findById(loan.bankTransaction).session(session);
        if (tx && tx.reconciled) {
          throw Object.assign(new Error('El desembolso ya está conciliado con el banco: reabre la conciliación antes de anularlo.'), { status: 400 });
        }
        if (tx && !tx.voided) {
          tx.voided = true;
          tx.voidedAt = fecha;
          tx.voidedBy = req.user._id;
          tx.voidReason = req.body?.reason || 'Anulación de préstamo';
          await tx.save({ session });
          await BankAccount.updateOne(
            { _id: tx.bankAccount },
            { $inc: { bookBalance: -(Number(tx.amount || 0) * Number(tx.direction || 0)) } },
            { session }
          );
          if (tx.type === 'CHEQUE_EMITIDO' && tx.checkNumber) {
            await liberarCheque({ clinicId: req.clinicId, bankId: tx.bankAccount, number: tx.checkNumber, session });
          }
        }
      }
      if (loan.journalEntry) {
        await reverseEntry({
          clinicId: req.clinicId,
          entryId: loan.journalEntry,
          userId: req.user._id,
          reason: `Anulación préstamo ${loan.code || ''}`.trim(),
          date: fecha,
          session,
        });
      }
      loan.status = 'ANULADO';
      loan.voidReason = req.body?.reason || '';
      loan.balance = 0;
      await loan.save({ session });
      return { message: 'Préstamo anulado' };
    });
    res.json(result);
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/**
 * Solo retoca los datos DESCRIPTIVOS. El monto, el tipo, las cuentas o el origen del dinero ya
 * están contabilizados: cambiarlos dejaría el asiento diciendo una cosa y el préstamo otra.
 * Para corregir eso se anula (que reversa el asiento) y se vuelve a registrar.
 */
exports.updateLoan = async (req, res) => {
  try {
    const l = await EmployeeLoan.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!l) return res.status(404).json({ message: 'No encontrado' });
    if (req.body.description !== undefined) l.description = req.body.description;
    if (req.body.reference !== undefined) l.reference = req.body.reference;
    const contable = ['principal', 'type', 'installmentsCount', 'receivableAccount', 'counterAccount', 'bankAccount', 'disbursementMethod', 'grantDate'];
    if (l.journalEntry && contable.some((k) => req.body[k] !== undefined)) {
      return res.status(400).json({
        message: 'El préstamo ya está contabilizado: el monto, el tipo, las cuentas y el origen del dinero no se editan. Anúlalo y regístralo de nuevo.',
      });
    }
    await l.save();
    res.json(l);
  } catch (err) { res.status(400).json({ message: err.message }); }
};

// ----- Rol de pagos -----
// El IR ya NO se calcula con tabla hardcodeada: el motor recomputeItem usa la
// tabla parametrizable (PayrollIncomeTaxTable) vía utils/payrollTax.

const DAY_MS = 1000 * 60 * 60 * 24;
const startOfDayLocal = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const clamp01 = (n) => Math.max(0, Math.min(1, n));

/** Suma los totales de una lista de ítems del rol. */
function sumItemTotals(items) {
  return items.reduce((a, i) => ({
    totalIngresos: r2(a.totalIngresos + (i.totalIngresos || 0)),
    totalEgresos: r2(a.totalEgresos + (i.totalEgresos || 0)),
    totalNeto: r2(a.totalNeto + (i.netoPagar || 0)),
    totalProvisiones: r2(a.totalProvisiones + (i.totalProvisiones || 0)),
  }), { totalIngresos: 0, totalEgresos: 0, totalNeto: 0, totalProvisiones: 0 });
}

/** Guarda (crea o regenera) el rol del período/tipo con los ítems y totales dados. */
async function upsertPayroll({ clinicId, existing, y, m, period, periodType, items, userId }) {
  const totals = sumItemTotals(items);
  if (existing) {
    existing.items = items;
    Object.assign(existing, totals);
    await existing.save();
    return existing;
  }
  const count = await Payroll.countDocuments({ clinic: clinicId });
  const suffix = periodType === 'QUINCENA_1' ? 'Q1' : (periodType === 'CIERRE_MES' ? 'CM' : 'M');
  const code = `ROL-${y}${String(m).padStart(2, '0')}-${suffix}-${String(count + 1).padStart(4, '0')}`;
  return Payroll.create({
    clinic: clinicId, code, year: y, month: m, period, periodType,
    items, ...totals, createdBy: userId,
  });
}

/**
 * Genera (o regenera) borrador de rol para un período.
 * body: { year, month, periodType? = 'MENSUAL' | 'QUINCENA_1' | 'CIERRE_MES' }
 *
 * - MENSUAL: rol mensual completo (todos los empleados activos) — comportamiento histórico.
 * - QUINCENA_1: anticipo de la 1ª quincena para los empleados QUINCENALES (solo % del sueldo,
 *   sin IESS ni beneficios; contablemente va a la cuenta de anticipo por cobrar).
 * - CIERRE_MES: liquida el mes completo y DESCUENTA el anticipo ya pagado en la quincena.
 *
 * Devuelve además `pendingFondosDecisions`: empleados que cumplieron 1 año y aún no tienen
 * definido el modo de fondos de reserva (la UI abre el modal MENSUALIZAR/ACUMULAR).
 */
exports.generatePayroll = async (req, res) => {
  try {
    const { year, month } = req.body;
    const periodType = ['QUINCENA_1', 'CIERRE_MES', 'MENSUAL'].includes(req.body.periodType) ? req.body.periodType : 'MENSUAL';
    const y = parseInt(year, 10), m = parseInt(month, 10);
    // Validación de rango: evita el año corrupto (p.ej. un «26» que Date convierte en 1926) que
    // luego reventaba el cierre con «No hay tabla de IR para el año 1926».
    if (!Number.isInteger(y) || y < 2000 || y > 2100) return res.status(400).json({ message: 'El año del rol debe estar entre 2000 y 2100.' });
    if (!Number.isInteger(m) || m < 1 || m > 12) return res.status(400).json({ message: 'El mes del rol debe estar entre 1 y 12.' });
    const period = `${y}-${String(m).padStart(2, '0')}`;
    const periodStart = new Date(y, m - 1, 1);
    const endOfMonth = new Date(y, m, 0);
    const totalDays = (endOfMonth - periodStart) / DAY_MS + 1;

    const existing = await Payroll.findOne({ clinic: req.clinicId, year: y, month: m, periodType });
    if (existing && existing.status !== 'BORRADOR') {
      return res.status(400).json({ message: 'El rol ya está cerrado o pagado' });
    }
    const R = await getRates(req.clinicId);
    const anticipoPctDefault = R._config?.anticipoQuincenaPct != null ? R._config.anticipoQuincenaPct : 40;

    // Empleados del período según el tipo (la quincena solo cubre a los QUINCENALES).
    const empFilter = { clinic: req.clinicId, active: true, hireDate: { $lte: endOfMonth } };
    if (periodType === 'QUINCENA_1') empFilter.paymentFrequency = 'QUINCENAL';
    const employees = await Employee.find(empFilter);
    const depts = await PayrollDepartment.find({ clinic: req.clinicId });
    const deptById = new Map(depts.map((d) => [String(d._id), d]));
    const deptSnap = (emp) => (emp.departmentRef ? deptById.get(String(emp.departmentRef)) : null);

    // ── QUINCENA_1: anticipo = % del sueldo (solo sueldo, sin IESS ni beneficios) ──────────
    if (periodType === 'QUINCENA_1') {
      const items = [];
      for (const emp of employees) {
        const base = effectiveBaseSalary(emp);
        const pct = emp.anticipoQuincenaPct != null ? emp.anticipoQuincenaPct : anticipoPctDefault;
        const anticipo = r2(base * pct / 100);
        if (anticipo <= 0) continue;
        const dept = deptSnap(emp);
        items.push({
          employee: emp._id, employeeName: `${emp.firstName} ${emp.lastName}`, identificacion: emp.identificacion,
          departmentRef: emp.departmentRef || null, departmentType: dept?.type || '', costCenter: emp.costCenter || null,
          daysWorked: 15, absenceDays: 0, monthlySalary: base, baseSalary: 0,
          anticipoQuincena: anticipo, fixedIncomes: [], earnings: [], deductions: [],
          totalIngresos: 0, totalEgresos: 0, netoPagar: anticipo, totalProvisiones: 0,
        });
      }
      const payroll = await upsertPayroll({ clinicId: req.clinicId, existing, y, m, period, periodType, items, userId: req.user._id });
      return res.json({ ...payroll.toObject(), pendingFondosDecisions: [] });
    }

    // ── MENSUAL / CIERRE_MES: liquidación completa ─────────────────────────────────────────
    const taxTable = await getActiveIncomeTaxTable(req.clinicId, y);
    const conceptMap = await loadConceptFlags(req.clinicId);
    const ctx = { rates: R, taxTable, conceptMap, sbu: R.SBU_2024 };
    // Conceptos por código: cada préstamo entra al rol con el concepto de su tipo.
    const conceptByCode = new Map(
      (await PayrollConcept.find({ clinic: req.clinicId }).select('code name')).map((c) => [c.code, c])
    );

    // Anticipos ya pagados en la quincena de este mes (para descontarlos en el cierre).
    const anticipoByEmp = new Map();
    if (periodType === 'CIERRE_MES') {
      const quincena = await Payroll.findOne({ clinic: req.clinicId, year: y, month: m, periodType: 'QUINCENA_1' });
      // El cierre solo procede si la quincena NO existe o ya está contabilizada/pagada: el asiento
      // del cierre acredita el anticipo por cobrar que debitó la quincena; si la quincena sigue en
      // borrador ese activo no existe todavía y el neto quedaría mal.
      if (quincena && quincena.status === 'BORRADOR') {
        return res.status(400).json({ message: 'La quincena de este mes está en borrador: ciérrala (o págala) antes de generar el cierre de mes.' });
      }
      if (quincena && quincena.status !== 'ANULADO') {
        for (const it of (quincena.items || [])) anticipoByEmp.set(String(it.employee), r2(it.anticipoQuincena || it.netoPagar || 0));
      }
    }

    const pendingFondosDecisions = [];
    const items = [];
    for (const emp of employees) {
      const base = effectiveBaseSalary(emp);
      const hire = startOfDayLocal(emp.hireDate);

      // Prorrateo por FECHA DE INGRESO: un empleado que entró a mitad de mes gana solo los días
      // trabajados. Así el sueldo ganado, el IESS y el neto se calculan sobre la MISMA base.
      let daysWorked = 30;
      if (hire > periodStart) {
        const worked = (endOfMonth - hire) / DAY_MS + 1;
        daysWorked = Math.max(0, Math.min(30, Math.round((30 * worked) / totalDays)));
      }

      // Fondos de reserva: se ganan al cumplir 1 AÑO. Elegible si ya llegó el aniversario; el
      // modo (mensualizar/acumular) se DECIDE al llegar (si no, se pide por modal y no se generan).
      const anniversary = new Date(hire); anniversary.setFullYear(hire.getFullYear() + 1);
      const eligibleByTime = anniversary <= endOfMonth;
      const alreadyDecided = !!(emp.fondosReservaModeSet || emp.receivesFondosReserva);
      if (eligibleByTime && !alreadyDecided) {
        pendingFondosDecisions.push({ employee: String(emp._id), name: `${emp.firstName} ${emp.lastName}`, anniversary });
      }
      // Proporcional si el aniversario cae dentro del período.
      let fondosReservaFactor = 1;
      if (anniversary > endOfMonth) fondosReservaFactor = 0;
      else if (anniversary > periodStart) fondosReservaFactor = clamp01(((endOfMonth - anniversary) / DAY_MS + 1) / totalDays);

      // Ingresos fijos activos (snapshot). En cierre/mensual siempre; en quincena no aplica aquí.
      const fixedIncomes = (emp.fixedIncomes || [])
        .filter((f) => f.activo !== false && (Number(f.monto) || 0) > 0)
        .map((f) => ({ concepto: f.concepto, monto: r2(f.monto), aportaIess: !!f.aportaIess, concept: f.concept || null, account: f.account || null }));

      // ── Préstamos y descuentos vigentes: una LÍNEA por cada uno ──────────────────────
      //
      // Antes se sumaban todos en un único número (`prestamoEmpresa`), con dos consecuencias:
      // en la pantalla del rol el préstamo no se veía (era un importe suelto sin nombre, que
      // además se perdía si el rol se había generado antes de crear el préstamo), y en el
      // asiento TODOS los tipos acreditaban la cuenta de préstamos de la empresa —un
      // quirografario recuperaba contra la cuenta equivocada—.
      //
      // Ahora cada préstamo entra como un descuento con nombre, concepto y CUENTA propia (la
      // misma que se debitó al otorgarlo), y con la referencia a su cuota para poder marcarla.
      const loans = await EmployeeLoan.find({ clinic: req.clinicId, employee: emp._id, status: 'ACTIVO' });
      const loanLines = [];
      for (const l of loans) {
        const pend = (l.installments || []).find((i) => !i.paid);
        if (!pend || !(pend.amount > 0)) continue;
        const def = loanTypeDef(l.type);
        loanLines.push({
          concept: conceptByCode.get(def.conceptCode)?._id || null,
          code: def.conceptCode,
          name: `${def.label} — cuota ${pend.number}/${l.installmentsCount}`,
          amount: r2(pend.amount),
          account: l.receivableAccount || null,
          sourceModel: 'EmployeeLoan',
          sourceRef: l._id,
          installmentNumber: pend.number,
        });
      }

      // Deducciones pendientes del empleado (consumo, multas, anticipos, etc.).
      const deductions = await EmployeeDeduction.find({ clinic: req.clinicId, employee: emp._id, status: 'PENDIENTE' });
      let multas = 0, anticipos = 0, otherDeductions = 0;
      for (const dd of deductions) {
        if (dd.type === 'MULTA') multas += dd.amount;
        else if (dd.type === 'ANTICIPO') anticipos += dd.amount;
        else otherDeductions += dd.amount; // CONSUMO / UNIFORME / OTRO
      }

      const dept = deptSnap(emp);
      const item = {
        employee: emp._id, employeeName: `${emp.firstName} ${emp.lastName}`, identificacion: emp.identificacion,
        departmentRef: emp.departmentRef || null, departmentType: dept?.type || '', costCenter: emp.costCenter || null,
        // daysWorked prorrateado por ingreso; absenceDays null para que el motor NO lo sobrescriba.
        daysWorked, absenceDays: null, monthlySalary: base, baseSalary: base,
        eligibleFondos: eligibleByTime && alreadyDecided,
        fondosReservaFactor,
        fixedIncomes,
        anticipoQuincena: anticipoByEmp.get(String(emp._id)) || 0,
        prestamoEmpresa: 0,   // los préstamos entran como líneas de descuento (ver arriba)
        multas: +multas.toFixed(2), anticipos: +anticipos.toFixed(2), otherDeductions: +otherDeductions.toFixed(2),
        earnings: [], deductions: loanLines,
      };
      // MOTOR ÚNICO: sueldo ganado, décimos/fondos, IESS (sobre lo ganado), IR, provisiones y totales.
      recomputeItem(item, { ...ctx, employee: emp });
      items.push(item);
    }

    const payroll = await upsertPayroll({ clinicId: req.clinicId, existing, y, m, period, periodType, items, userId: req.user._id });
    res.json({ ...payroll.toObject(), pendingFondosDecisions });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/**
 * Define el modo de fondos de reserva de un empleado que cumplió el año (lo llama el modal).
 * body: { mode: 'MENSUALIZADO' | 'ACUMULADO' }
 */
exports.setFondosReservaMode = async (req, res) => {
  try {
    const mode = req.body?.mode === 'ACUMULADO' ? 'ACUMULADO' : 'MENSUALIZADO';
    const e = await Employee.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!e) return res.status(404).json({ message: 'No encontrado' });
    e.fondosReservaAcumulado = mode;
    e.receivesFondosReserva = true;
    e.fondosReservaModeSet = true;
    await e.save();
    res.json(e);
  } catch (err) { res.status(400).json({ message: err.message }); }
};

exports.listPayrolls = async (req, res) => {
  const items = await Payroll.find({ clinic: req.clinicId }).sort({ year: -1, month: -1 });
  res.json(items);
};
exports.getPayroll = async (req, res) => {
  const p = await Payroll.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!p) return res.status(404).json({ message: 'No encontrado' });
  res.json(await withObligation(p, req.clinicId));
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
/**
 * Cierra el rol: contabiliza gastos/provisiones/pasivos y abre la OBLIGACIÓN por el
 * neto (CxP), dejándola proyectable en el flujo de caja.
 *
 * Body: { accountingDate?, scheduledPaymentDate? }
 *   - accountingDate: fecha de DEVENGO del gasto (por defecto, último día del mes del
 *     rol). Antes se forzaba el día 28: ya no.
 *   - scheduledPaymentDate: fecha en que se planea pagar el neto → vencimiento de la
 *     obligación. Es la fecha LEGAL: no se desplaza por caer fin de semana (eso lo hace
 *     la proyección, que muestra además la fecha efectiva).
 */
exports.closePayroll = async (req, res) => {
  try {
    const payrollId = await runInTransaction(async (session) => {
      const p = await Payroll.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!p) throw Object.assign(new Error('No encontrado'), { status: 404 });
      if (p.status !== 'BORRADOR') throw Object.assign(new Error('No es borrador'), { status: 400 });

      // Último día del mes del rol: devengo natural del período (sustituye al día 28 fijo).
      const defaultDate = new Date(p.year, p.month, 0, 23, 59, 59, 999);
      const payrollDate = req.body?.accountingDate ? new Date(req.body.accountingDate) : defaultDate;
      if (Number.isNaN(payrollDate.getTime())) throw Object.assign(new Error('Fecha contable inválida'), { status: 400 });
      const scheduled = req.body?.scheduledPaymentDate ? new Date(req.body.scheduledPaymentDate) : null;
      if (scheduled && Number.isNaN(scheduled.getTime())) throw Object.assign(new Error('Fecha de pago programada inválida'), { status: 400 });
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
      const { lines, config } = await buildPayrollEntryLines(p, { clinicId: req.clinicId, session });

      // El asiento se identifica por `sourceAction`, y `createEntry` es idempotente por
      // (clinic, sourceModel, sourceRef, sourceAction). Un asiento REVERSADO conserva su
      // status CONTABILIZADO, así que reutilizar 'CLOSE' tras una reapertura devolvería el
      // asiento reversado y el rol quedaría cerrado SIN reconocer el gasto (con la CxP
      // reabierta y sin respaldo en el mayor). Cada ciclo de cierre usa su propia acción.
      const previousCloses = await JournalEntry.countDocuments({
        clinic: req.clinicId,
        sourceModel: 'Payroll',
        sourceRef: p._id,
        sourceAction: { $regex: /^CLOSE/ },
      }).session(session);
      const closeAction = previousCloses === 0 ? 'CLOSE' : `CLOSE:${previousCloses + 1}`;

      const entry = await createEntry({
        clinicId: req.clinicId,
        date: payrollDate,
        description: `Rol de pagos ${p.period}`,
        source: 'NOMINA',
        sourceRef: p._id,
        sourceModel: 'Payroll',
        sourceAction: closeAction,
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

      // Marcar la cuota EXACTA que descontó cada línea de préstamo del rol. Cada línea sabe de
      // qué préstamo y de qué número de cuota salió, así que ya no hay que repartir un importe
      // agregado entre los préstamos del empleado adivinando cuál pagó qué.
      for (const it of p.items) {
        for (const d of it.deductions || []) {
          if (d.sourceModel !== 'EmployeeLoan' || !d.sourceRef) continue;
          const monto = Number(d.amount) || 0;
          if (monto <= 0) continue;
          const loan = await EmployeeLoan.findOne({ _id: d.sourceRef, clinic: req.clinicId }).session(session);
          if (!loan || loan.status === 'ANULADO') continue;
          const inst = (loan.installments || []).find((x) => x.number === d.installmentNumber && !x.paid)
            || (loan.installments || []).find((x) => !x.paid);
          if (!inst) continue;
          inst.paid = true;
          inst.paidIn = p.period;
          inst.paidAt = new Date();
          // Si el contador ajustó el importe de la línea, manda lo realmente descontado.
          loan.paidAmount = r2(loan.paidAmount + monto);
          loan.balance = Math.max(0, r2(loan.principal - loan.paidAmount));
          if (loan.balance <= 0.01) { loan.balance = 0; loan.status = 'CANCELADO'; }
          await loan.save({ session });
        }
      }

      p.status = 'CERRADO';
      p.journalEntry = entry._id;
      p.accountingDate = payrollDate;
      p.scheduledPaymentDate = scheduled;
      p.closedAt = new Date();
      p.closedBy = req.user._id;

      // Obligación por el neto (submayor de «Sueldos por pagar»): el crédito contable
      // ya lo hizo el asiento de arriba, aquí NO se vuelve a acreditar nada.
      const obligation = await openPayrollObligation(p, {
        clinicId: req.clinicId,
        account: config.sueldosPorPagar?._id || null,
        session,
      });
      p.payableRef = obligation?._id || null;

      await p.save({ session });
      return p._id;
    });
    const payroll = await Payroll.findById(payrollId);
    return res.json(await withObligation(payroll, req.clinicId));
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/**
 * POST /payroll/:id/reopen — devuelve un rol CERRADO a BORRADOR.
 * Reversa el asiento de cierre y anula la obligación. Se bloquea si ya hubo pagos:
 * primero habría que revertirlos (evita dejar la cartera y el mayor incoherentes).
 */
/**
 * Deshace lo que el CIERRE marcó como cobrado al empleado: las cuotas de préstamo que descontó
 * este rol vuelven a estar pendientes y las deducciones aplicadas vuelven a PENDIENTE.
 *
 * Sin esto, reabrir un rol dejaba la cuota marcada como pagada: al volver a cerrarlo se
 * descontaba la cuota SIGUIENTE y el empleado terminaba pagando dos veces el mismo mes.
 */
async function liberarCobrosDelRol(p, clinicId, session) {
  for (const it of p.items || []) {
    for (const d of it.deductions || []) {
      if (d.sourceModel !== 'EmployeeLoan' || !d.sourceRef) continue;
      const loan = await EmployeeLoan.findOne({ _id: d.sourceRef, clinic: clinicId }).session(session);
      if (!loan) continue;
      const inst = (loan.installments || []).find((x) => x.paid && x.paidIn === p.period && x.number === d.installmentNumber)
        || (loan.installments || []).find((x) => x.paid && x.paidIn === p.period);
      if (!inst) continue;
      inst.paid = false;
      inst.paidIn = '';
      inst.paidAt = null;
      loan.paidAmount = Math.max(0, r2(loan.paidAmount - (Number(d.amount) || 0)));
      loan.balance = Math.max(0, r2(loan.principal - loan.paidAmount));
      if (loan.status === 'CANCELADO' && loan.balance > 0.01) loan.status = 'ACTIVO';
      await loan.save({ session });
    }
  }
  await EmployeeDeduction.updateMany(
    { clinic: clinicId, status: 'APLICADO', appliedIn: p.period },
    { $set: { status: 'PENDIENTE', appliedIn: '', appliedAt: null } },
    { session }
  );
}

exports.reopenPayroll = async (req, res) => {
  try {
    const payrollId = await runInTransaction(async (session) => {
      const p = await Payroll.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!p) throw Object.assign(new Error('No encontrado'), { status: 404 });
      if (p.status !== 'CERRADO') throw Object.assign(new Error('Solo se reabre un rol cerrado'), { status: 400 });
      if ((p.payments || []).length) throw Object.assign(new Error('El rol tiene pagos registrados: no se puede reabrir'), { status: 400 });

      const reversalDate = req.body?.date ? new Date(req.body.date) : new Date();
      await assertPeriodOpen(req.clinicId, p.accountingDate || reversalDate, { session });
      await assertPeriodOpen(req.clinicId, reversalDate, { session });

      if (p.journalEntry) {
        await reverseEntry({
          clinicId: req.clinicId,
          entryId: p.journalEntry,
          userId: req.user._id,
          reason: req.body?.reason || `Reapertura del rol ${p.period}`,
          date: reversalDate,
          session,
        });
      }
      await voidPayable({ clinicId: req.clinicId, sourceModel: 'Payroll', sourceRef: p._id }, { session });
      await liberarCobrosDelRol(p, req.clinicId, session);

      p.status = 'BORRADOR';
      p.journalEntry = null;
      p.payableRef = null;
      p.closedAt = null;
      p.closedBy = null;
      await p.save({ session });
      return p._id;
    });
    const payroll = await Payroll.findById(payrollId);
    res.json(await withObligation(payroll, req.clinicId));
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/** POST /payroll/:id/void — anula el rol: reversa el asiento y cancela la obligación. */
exports.voidPayroll = async (req, res) => {
  try {
    const payrollId = await runInTransaction(async (session) => {
      const p = await Payroll.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!p) throw Object.assign(new Error('No encontrado'), { status: 404 });
      if (p.status === 'ANULADO') throw Object.assign(new Error('El rol ya está anulado'), { status: 400 });
      if ((p.payments || []).length) throw Object.assign(new Error('El rol tiene pagos registrados: reverse los pagos antes de anular'), { status: 400 });

      const reversalDate = req.body?.date ? new Date(req.body.date) : new Date();
      await assertPeriodOpen(req.clinicId, reversalDate, { session });
      if (p.journalEntry) {
        await reverseEntry({
          clinicId: req.clinicId,
          entryId: p.journalEntry,
          userId: req.user._id,
          reason: req.body?.reason || `Anulación del rol ${p.period}`,
          date: reversalDate,
          session,
        });
      }
      await voidPayable({ clinicId: req.clinicId, sourceModel: 'Payroll', sourceRef: p._id }, { session });
      // Un rol anulado no cobró nada: las cuotas y deducciones vuelven a estar pendientes.
      await liberarCobrosDelRol(p, req.clinicId, session);
      p.status = 'ANULADO';
      await p.save({ session });
      return p._id;
    });
    const payroll = await Payroll.findById(payrollId);
    res.json(await withObligation(payroll, req.clinicId));
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/**
 * GET /payroll/withholding?year&month — servicio auditable de retención en relación de
 * dependencia (lo consume el Formulario 103): base gravada, IR retenido y el detalle de
 * qué rubro se incluyó/excluyó y por qué.
 */
exports.withholdingSummary = async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);
    const data = await payrollWithholdingForPeriod({ clinicId: req.clinicId, year, month });
    res.json({ year, month, ...data });
  } catch (e) { res.status(e.status || 500).json({ message: e.message }); }
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
 * Paga un rol CERRADO, TOTAL o PARCIALMENTE, aplicando la obligación (CxP) del neto.
 *
 * Body: { bankAccountId?, confirmNoBank?, amount?, date?, reference?, idempotencyKey? }
 * Header: `Idempotency-Key` (preferido).
 *   - Con `bankAccountId`: asiento D Sueldos por pagar / H Banco + BankTransaction.
 *   - Con `confirmNoBank`: pago en efectivo → H Caja (nunca se marca PAGADO sin asiento).
 *   - `amount` ausente = paga el saldo pendiente. Si queda saldo, el rol sigue CERRADO.
 *
 * IDEMPOTENCIA: la clave identifica la INTENCIÓN de pago. Reintentarla (doble clic, red)
 * devuelve el pago ya registrado sin duplicar asiento, movimiento bancario ni aplicación.
 * La misma clave con OTRO contenido responde 409. Dos claves distintas son dos pagos reales
 * (dos pagos de 100 en momentos distintos se registran los dos).
 *
 * La comprobación vive DENTRO de la transacción: dos peticiones en paralelo con la misma
 * clave se serializan por el conflicto de escritura sobre el rol, y la que reintenta ve el
 * pago ya aplicado y hace replay.
 *
 * El submayor impide además el doble pago por importe: aplicar más que el saldo de la CxP
 * lanza error.
 */
exports.markPaid = async (req, res) => {
  const { bankAccountId, date, reference } = req.body || {};
  const idemKey = readIdempotencyKey(req);
  // Huella del contenido ENVIADO (no de los valores resueltos por defecto): así un
  // reintento idéntico coincide, y un cambio de importe/banco/fecha no. Incluye la
  // IDENTIDAD DEL DESTINO (`payroll`, del parámetro de ruta) y el tipo de operación: la
  // misma clave en otro rol nunca puede confundirse con un reintento de este.
  const idemFingerprint = fingerprint({
    op: 'payroll.pay',
    sourceModel: 'Payroll',
    sourceRef: String(req.params.id),
    payroll: String(req.params.id),
    amount: N.num(req.body?.amount),
    bankAccount: N.id(bankAccountId),
    cash: !bankAccountId,
    date: N.date(date),
    reference: reference || null,
  });

  try {
    if (!bankAccountId && !(req.body?.confirmNoBank === true || req.body?.force === true)) {
      return res.status(400).json({
        message: 'El pago de nómina requiere un banco. Usa "Pagar desde banco", o confirma un pago manual en efectivo (confirmNoBank), que se contabilizará contra Caja.',
      });
    }

    // Replay rápido fuera de la transacción (doble clic / reintento de red).
    // La clave se busca en TODA la clínica, no solo en este rol: el índice único es de
    // clínica, así que reutilizarla en OTRO rol debe responder 409, no reventar contra el
    // índice ni devolver el pago del rol ajeno.
    if (idemKey) {
      const previo = await Payroll.findOne({
        clinic: req.clinicId, 'payments.idempotencyKey': idemKey,
      });
      if (previo) {
        assertSameTarget(previo._id, req.params.id, 'el pago de nómina');
        const pago = previo.payments.find((x) => x.idempotencyKey === idemKey);
        assertSameFingerprint(pago?.fingerprint, idemFingerprint, 'pago de nómina');
        return res.json({ ...(await withObligation(previo, req.clinicId)), idempotentReplay: true });
      }
    }

    const result = await runInTransaction(async (session) => {
      const p = await Payroll.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!p) throw Object.assign(new Error('No encontrado'), { status: 404 });

      // Dentro de la transacción: si la clave ya se aplicó (la ganó otra petición
      // concurrente), se hace replay sin escribir nada —o 409 si fue en otro rol.
      if (idemKey) {
        const dueño = await Payroll.findOne({
          clinic: req.clinicId, 'payments.idempotencyKey': idemKey,
        }).session(session);
        if (dueño) {
          assertSameTarget(dueño._id, p._id, 'el pago de nómina');
          const yaAplicado = dueño.payments.find((x) => x.idempotencyKey === idemKey);
          assertSameFingerprint(yaAplicado?.fingerprint, idemFingerprint, 'pago de nómina');
          return { payrollId: p._id, replay: true };
        }
      }

      if (p.status !== 'CERRADO') {
        throw Object.assign(new Error(p.status === 'PAGADO' ? 'El rol ya está pagado' : 'Debe estar cerrado'), { status: 400 });
      }
      const neto = r2(p.totalNeto);
      if (neto <= 0) throw Object.assign(new Error('El rol no tiene neto por pagar'), { status: 400 });

      const cfg = await PayrollConfig.findOne({ clinic: req.clinicId }).session(session);
      const general = await resolveConfigAccounts(req.clinicId, cfg, session);

      // Roles cerrados ANTES de que existiera la obligación (legacy): se abre ahora,
      // idempotente, para que el pago tenga contra qué aplicarse.
      let payable = await Payable.findOne({
        clinic: req.clinicId, sourceModel: 'Payroll', sourceRef: p._id,
      }).session(session);
      if (!payable) {
        payable = await openPayrollObligation(p, {
          clinicId: req.clinicId, account: general.sueldosPorPagar?._id || null, session,
        });
        p.payableRef = payable?._id || null;
      }
      if (!payable || payable.status === 'ANULADO') throw Object.assign(new Error('El rol no tiene obligación pendiente'), { status: 400 });

      const saldo = r2(payable.balance);
      if (saldo <= 0) throw Object.assign(new Error('La obligación del rol ya está pagada'), { status: 400 });
      const amount = req.body?.amount != null ? r2(req.body.amount) : saldo;
      if (amount <= 0) throw Object.assign(new Error('Monto de pago inválido'), { status: 400 });
      if (amount > saldo + 0.005) {
        throw Object.assign(new Error(`El monto excede el saldo pendiente del rol (${saldo.toFixed(2)})`), { status: 400 });
      }

      const txDate = date ? new Date(date) : new Date();
      await assertPeriodOpen(req.clinicId, txDate, { session });

      let bank = null;
      let creditAccount = null;
      if (bankAccountId) {
        bank = await BankAccount.findOne({ _id: bankAccountId, clinic: req.clinicId }).session(session);
        if (!bank) throw Object.assign(new Error('Cuenta bancaria no encontrada'), { status: 400 });
        if (!bank.chartAccount) throw Object.assign(new Error('La cuenta bancaria no tiene cuenta contable asociada'), { status: 400 });
        creditAccount = bank.chartAccount;
      } else {
        creditAccount = (await getAccount(req.clinicId, 'caja', { session }))._id;
      }

      // Primer pago conserva el sourceAction 'PAY' histórico; los siguientes se numeran.
      const seq = (p.payments || []).length + 1;
      const entry = await createEntry({
        clinicId: req.clinicId,
        date: txDate,
        description: `Pago de nómina ${p.period}${amount < saldo ? ' (parcial)' : ''}${bank ? '' : ' (efectivo/manual)'}`,
        source: 'PAGO',
        sourceRef: p._id,
        sourceModel: 'Payroll',
        sourceAction: seq === 1 ? 'PAY' : `PAY:${seq}`,
        lines: [
          { account: general.sueldosPorPagar._id, debit: amount, credit: 0, description: 'Pago sueldos por pagar' },
          { account: creditAccount, debit: 0, credit: amount, description: `Pago nómina ${p.period}${bank ? '' : ' (efectivo)'}` },
        ],
        userId: req.user._id,
        session,
      });

      let bankTx = null;
      if (bank) {
        [bankTx] = await BankTransaction.create([{
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
      }

      // Aplica al submayor: es quien impide la doble aplicación (excede saldo → error).
      const applied = await applyToPayable(
        { clinicId: req.clinicId, sourceModel: 'Payroll', sourceRef: p._id, amount },
        { session }
      );

      p.payments.push({
        date: txDate,
        amount,
        bankAccount: bank?._id || null,
        journalEntry: entry._id,
        bankTransaction: bankTx?._id || null,
        reference: reference || '',
        paidBy: req.user._id,
        idempotencyKey: idemKey,
        fingerprint: idemKey ? idemFingerprint : null,
      });
      // Campos legacy: reflejan el primer pago.
      if (!p.paymentJournalEntry) {
        p.paymentJournalEntry = entry._id;
        p.paymentBankTransaction = bankTx?._id || null;
        p.paymentBankAccount = bank?._id || null;
        p.paidBy = req.user._id;
      }
      if (r2(applied.balance) <= 0.005) {
        p.status = 'PAGADO';
        p.paidAt = txDate;
      }
      await p.save({ session });
      return { payrollId: p._id, replay: false };
    });

    const payroll = await Payroll.findById(result.payrollId);
    const body = await withObligation(payroll, req.clinicId);
    res.json(result.replay ? { ...body, idempotentReplay: true } : body);
  } catch (e) {
    // Carrera de idempotencia contra el índice único (la clave la ganó otra petición):
    // se resuelve en vez de devolver un E11000 crudo. El índice es de clínica, así que el
    // ganador puede ser OTRO rol → 409 (nunca se devuelve su pago como si fuera de este).
    if (e.code === 11000 && idemKey) {
      const previo = await Payroll.findOne({
        clinic: req.clinicId, 'payments.idempotencyKey': idemKey,
      });
      if (previo) {
        try {
          assertSameTarget(previo._id, req.params.id, 'el pago de nómina');
          const pago = previo.payments.find((x) => x.idempotencyKey === idemKey);
          assertSameFingerprint(pago?.fingerprint, idemFingerprint, 'pago de nómina');
        } catch (conflictErr) {
          return res.status(conflictErr.status || 409).json({ message: conflictErr.message });
        }
        const body = await withObligation(previo, req.clinicId);
        return res.json({ ...body, idempotentReplay: true });
      }
    }
    res.status(e.status || 400).json({ message: e.message });
  }
};

// ═══════════════════════ Catálogos parametrizados ═══════════════════════

// ---- Departamentos ----
exports.listDepartments = async (req, res) => {
  // Siembra (idempotente) los 4 departamentos estándar: la contadora no los crea a mano,
  // solo escoge el departamento al crear un CARGO o un empleado.
  const items = await ensureStandardDepartments(req.clinicId);
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
/** Normaliza los overrides de cuenta por departamento: descarta filas sin depto o sin cuenta. */
function cleanDeptAccounts(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((d) => ({ department: d.department || d.dept || null, account: d.account || null }))
    .filter((d) => d.department && d.account);
}

exports.listConcepts = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.type) filter.type = req.query.type;
  const items = await PayrollConcept.find(filter)
    .populate('defaultAccount payableAccount', 'code name')
    .populate('deptAccounts.department', 'name type')
    .populate('deptAccounts.account', 'code name')
    .sort({ type: 1, code: 1 });
  res.json(items);
};
exports.createConcept = async (req, res) => {
  try {
    const data = { ...req.body, clinic: req.clinicId };
    if (!data.defaultAccount) data.defaultAccount = null;
    if (!data.payableAccount) data.payableAccount = null;
    data.deptAccounts = cleanDeptAccounts(data.deptAccounts);
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
    if (patch.deptAccounts !== undefined) patch.deptAccounts = cleanDeptAccounts(patch.deptAccounts);
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
  { code: 'ING-SUELDO', name: 'Sueldo', type: 'INGRESO', category: 'SUELDO', affectsIess: true, affectsDecimos: true, affectsIncomeTax: true, isTaxableIncome: true },
  { code: 'ING-TRANSPORTE', name: 'Transporte', type: 'INGRESO', category: 'BONO' },
  { code: 'ING-COMISIONES', name: 'Comisiones', type: 'INGRESO', category: 'COMISION', affectsIess: true, affectsDecimos: true, affectsIncomeTax: true, isTaxableIncome: true },
  { code: 'ING-BONIFICACION', name: 'Bonificación', type: 'INGRESO', category: 'BONO', affectsIncomeTax: true, isTaxableIncome: true },
  { code: 'ING-ALIMENTACION', name: 'Alimentación', type: 'INGRESO', category: 'BONO' },
  { code: 'ING-VIVIENDA', name: 'Vivienda', type: 'INGRESO', category: 'BONO' },
  { code: 'ING-HE25', name: 'Horas extra 25%', type: 'INGRESO', category: 'HORAS_EXTRAS', rate: 25, affectsIess: true, affectsDecimos: true, affectsIncomeTax: true, isTaxableIncome: true },
  { code: 'ING-HE50', name: 'Horas extra 50%', type: 'INGRESO', category: 'HORAS_EXTRAS', rate: 50, affectsIess: true, affectsDecimos: true, affectsIncomeTax: true, isTaxableIncome: true },
  { code: 'ING-HE100', name: 'Horas extra 100%', type: 'INGRESO', category: 'HORAS_EXTRAS', rate: 100, affectsIess: true, affectsDecimos: true, affectsIncomeTax: true, isTaxableIncome: true },
  { code: 'ING-DEVOLUCION-DIAS', name: 'Devolución de días laborados', type: 'INGRESO', category: 'SUELDO', affectsIess: true, affectsDecimos: true, affectsIncomeTax: true, isTaxableIncome: true },
  { code: 'ING-OTROS', name: 'Otros ingresos', type: 'INGRESO', category: 'OTRO' },
  { code: 'ING-VACACIONES', name: 'Vacaciones', type: 'INGRESO', category: 'VACACIONES', isVacation: true, isNonTaxableIncome: true },
  { code: 'ING-FONDOS-RESERVA', name: 'Fondos de reserva', type: 'INGRESO', category: 'FONDOS_RESERVA', rate: 8.33, isFondosReserva: true, isNonTaxableIncome: true },
  { code: 'ING-DECIMO-TERCERO', name: 'Décimo tercero', type: 'INGRESO', category: 'DECIMO', isDecimoTercero: true, isNonTaxableIncome: true },
  { code: 'ING-DECIMO-CUARTO', name: 'Décimo cuarto', type: 'INGRESO', category: 'DECIMO', isDecimoCuarto: true, isNonTaxableIncome: true },
  // Egresos
  { code: 'EGR-ANTICIPO', name: 'Anticipo', type: 'EGRESO', category: 'ANTICIPO', isDiscount: true },
  { code: 'EGR-ANTICIPO-QUINCENA', name: 'Anticipo quincenal', type: 'EGRESO', category: 'ANTICIPO', isDiscount: true },
  { code: 'EGR-PREST-HIPOTECARIO', name: 'Préstamo hipotecario', type: 'EGRESO', category: 'PRESTAMO', isDiscount: true },
  { code: 'EGR-PREST-QUIROGRAFARIO', name: 'Préstamo quirografario', type: 'EGRESO', category: 'PRESTAMO', isDiscount: true },
  { code: 'EGR-PREST-PERSONAL', name: 'Préstamo personal', type: 'EGRESO', category: 'PRESTAMO', isDiscount: true },
  { code: 'EGR-MULTAS', name: 'Multas', type: 'EGRESO', category: 'MULTA', isDiscount: true },
  { code: 'EGR-SEGURO', name: 'Seguro', type: 'EGRESO', category: 'DESCUENTO', isDiscount: true },
  { code: 'EGR-CELULAR', name: 'Celular', type: 'EGRESO', category: 'DESCUENTO', isDiscount: true },
  { code: 'EGR-AUSENCIAS', name: 'Ausencias', type: 'EGRESO', category: 'AUSENCIA', isDiscount: true },
  { code: 'EGR-EXT-CONYUGAL', name: 'Extensión conyugal', type: 'EGRESO', category: 'DESCUENTO', isDiscount: true },
  { code: 'EGR-DESCUENTOS', name: 'Descuentos', type: 'EGRESO', category: 'DESCUENTO', isDiscount: true },
  { code: 'EGR-IMPUESTO-RENTA', name: 'Impuesto a la renta', type: 'EGRESO', category: 'IMPUESTO', isIncomeTaxWithholding: true },
  { code: 'EGR-OTROS', name: 'Otros egresos', type: 'EGRESO', category: 'DESCUENTO', isDiscount: true },
  // Obligaciones / provisiones
  { code: 'OBL-IESS-PERSONAL', name: 'IESS personal', type: 'OBLIGACION', category: 'IESS', rate: 9.45, isPersonalIess: true },
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
