/**
 * Carga masiva por plantillas Excel (migración desde Contífico / carga inicial).
 *
 * Para cada tipo hay dos endpoints:
 *   GET  /data-import/template/:type  → descarga la plantilla .xlsx (con hoja
 *                                       de instrucciones y fila de ejemplo)
 *   POST /data-import/:type           → sube la plantilla llena (multipart `file`)
 *                                       y crea/actualiza en bloque (upsert por código
 *                                       o identificación). Devuelve { created,
 *                                       updated, errors[] } con el detalle por fila.
 *
 * Tipos: plan-cuentas · categorias · empleados · proveedores · clientes · activos
 * (la plantilla de productos vive en /inventory-advanced/template/products).
 */
const ExcelJS = require('exceljs');
const multer = require('multer');
const ChartOfAccount = require('../models/ChartOfAccount');
const InventoryCategory = require('../models/InventoryCategory');
const Employee = require('../models/Employee');
const PayrollDepartment = require('../models/PayrollDepartment');
const PayrollPosition = require('../models/PayrollPosition');
const CostCenter = require('../models/CostCenter');
const Supplier = require('../models/Supplier');
const Patient = require('../models/Patient');
const FixedAsset = require('../models/FixedAsset');
const { normalizeAssetConfig } = require('../utils/fixedAssetConfig');

exports.uploadMiddleware = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }).single('file');

// ─── Helpers compartidos ─────────────────────────────────────────────────────

const norm = (s) => String(s ?? '')
  .trim().toUpperCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

const parseBool = (v, def = false) => {
  const s = norm(v);
  if (!s) return def;
  return ['SI', 'S', 'TRUE', '1', 'X', 'YES'].includes(s);
};

const parseDate = (v) => {
  if (!v && v !== 0) return null;
  if (v instanceof Date) return v;
  const s = String(v).trim();
  // dd/mm/yyyy o dd-mm-yyyy
  let m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return new Date(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T12:00:00`);
  // yyyy-mm-dd
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T12:00:00`);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
};

const cellValue = (v) => {
  if (v && typeof v === 'object' && 'result' in v) v = v.result; // fórmula
  if (v && typeof v === 'object' && 'text' in v) v = v.text;     // rich text / link
  if (v && typeof v === 'object' && 'hyperlink' in v) v = v.text || v.hyperlink;
  return v;
};

async function loadWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    const err = new Error('No se pudo leer el archivo Excel. Ábrelo en Excel/Google Sheets/LibreOffice, guárdalo de nuevo como .xlsx y vuelve a subirlo.');
    err.status = 400;
    throw err;
  }
  const ws = wb.worksheets[0];
  if (!ws) { const err = new Error('El archivo no tiene hojas'); err.status = 400; throw err; }
  return ws;
}

/** Mapea la fila 1 a claves usando alias normalizados. */
function mapHeaders(ws, aliases) {
  const lookup = new Map();
  for (const [key, list] of Object.entries(aliases)) for (const a of list) lookup.set(norm(a), key);
  const headerMap = {};
  ws.getRow(1).eachCell((cell, col) => {
    const key = lookup.get(norm(cellValue(cell.value)));
    if (key) headerMap[col] = key;
  });
  return headerMap;
}

/** Convierte las filas (desde la 2) en objetos { key: valor } + n° de fila. */
function rowsToObjects(ws, headerMap) {
  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const data = {};
    let hasData = false;
    Object.entries(headerMap).forEach(([col, key]) => {
      const v = cellValue(row.getCell(parseInt(col)).value);
      if (v !== null && v !== undefined && String(v).trim() !== '') hasData = true;
      data[key] = v;
    });
    if (hasData) rows.push({ __row: r, ...data });
  }
  return rows;
}

/** Índice código → cuenta del plan (para resolver columnas cuenta_*). */
async function accountIndex(clinicId) {
  const accounts = await ChartOfAccount.find({ clinic: clinicId }).select('code name nature type allowsMovement').lean();
  return new Map(accounts.map((a) => [String(a.code).trim(), a]));
}

/** Resuelve un código de cuenta a su _id; agrega error si no existe / no permite movimiento. */
function resolveAccount(accIdx, raw, label, errors, rowNo, { required = false, movement = true } = {}) {
  const code = String(raw ?? '').trim();
  if (!code) {
    if (required) errors.push(`Fila ${rowNo}: falta la ${label}`);
    return undefined; // undefined = no tocar el campo
  }
  const acc = accIdx.get(code);
  if (!acc) { errors.push(`Fila ${rowNo}: ${label} "${code}" no existe en el plan de cuentas`); return undefined; }
  if (movement && acc.allowsMovement === false) { errors.push(`Fila ${rowNo}: ${label} "${code}" es agrupadora (no permite movimiento)`); return undefined; }
  return acc._id;
}

function templateWorkbook({ sheetName, columns, example, instructions }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
  if (example) ws.addRow(example);
  const help = wb.addWorksheet('Instrucciones');
  help.getColumn(1).width = 130;
  (instructions || []).forEach((line) => help.addRow([line]));
  help.addRow(['No borre la fila de encabezados. Puede borrar la(s) fila(s) de ejemplo.']);
  return wb;
}

async function sendTemplate(res, filename, wbDef) {
  const wb = templateWorkbook(wbDef);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

// ─── PLAN DE CUENTAS ─────────────────────────────────────────────────────────

const PLAN_ALIASES = {
  code: ['codigo', 'codigo contable', 'code', 'cuenta'],
  name: ['nombre', 'nombre de cuenta', 'descripcion de cuenta', 'name'],
  type: ['tipo', 'tipo de cuenta', 'type'],
  nature: ['naturaleza', 'nature'],
  allowsMovement: ['permite movimiento', 'movimiento', 'imputable'],
  active: ['estado', 'activo', 'active'],
  description: ['descripcion', 'observaciones', 'description'],
};

const TYPE_SYNONYMS = {
  ACTIVO: 'ACTIVO', ACTIVOS: 'ACTIVO',
  PASIVO: 'PASIVO', PASIVOS: 'PASIVO',
  PATRIMONIO: 'PATRIMONIO', CAPITAL: 'PATRIMONIO',
  INGRESO: 'INGRESO', INGRESOS: 'INGRESO', VENTAS: 'INGRESO',
  GASTO: 'GASTO', GASTOS: 'GASTO', EGRESO: 'GASTO', EGRESOS: 'GASTO',
  COSTO: 'COSTO', COSTOS: 'COSTO',
  ORDEN: 'ORDEN',
};
const DEFAULT_NATURE = { ACTIVO: 'DEBITO', GASTO: 'DEBITO', COSTO: 'DEBITO', ORDEN: 'DEBITO', PASIVO: 'CREDITO', PATRIMONIO: 'CREDITO', INGRESO: 'CREDITO' };

const planTemplateDef = {
  sheetName: 'PlanDeCuentas',
  columns: [
    { header: 'codigo', key: 'code', width: 18 },
    { header: 'nombre', key: 'name', width: 45 },
    { header: 'tipo', key: 'type', width: 14 },
    { header: 'naturaleza', key: 'nature', width: 14 },
    { header: 'permite_movimiento', key: 'allowsMovement', width: 18 },
    { header: 'estado', key: 'active', width: 10 },
    { header: 'descripcion', key: 'description', width: 40 },
  ],
  example: { code: '1.1.01.02', name: 'Bancos', type: 'ACTIVO', nature: 'DEUDORA', allowsMovement: 'NO', active: 'ACTIVO', description: 'Agrupa las cuentas bancarias' },
  instructions: [
    'PLAN DE CUENTAS — la jerarquía se arma por el código con puntos: 1 → 1.1 → 1.1.01 → 1.1.01.02',
    'codigo (obligatorio): código contable. La cuenta padre se deduce del código (1.1.01 es padre de 1.1.01.02).',
    'nombre (obligatorio).',
    'tipo (obligatorio): ACTIVO, PASIVO, PATRIMONIO, INGRESO, GASTO, COSTO u ORDEN.',
    'naturaleza (opcional): DEUDORA o ACREEDORA (también se acepta DEBITO/CREDITO). Si se deja vacía se asigna por el tipo.',
    'permite_movimiento (opcional): SI/NO. Si se deja vacío: NO cuando la cuenta tiene hijas en este mismo archivo (agrupadora), SI cuando no las tiene.',
    'estado (opcional): ACTIVO o INACTIVO (por defecto ACTIVO).',
    'Importe PRIMERO el plan de cuentas y después categorías/productos/activos/empleados que referencian cuentas.',
    'Si el código ya existe en el sistema, la fila ACTUALIZA esa cuenta (no duplica).',
    'Las cuentas bancarias, de inventario o de retención se vinculan luego en su módulo (Bancos, Categorías, Reglas de retención).',
  ],
};

async function importPlanCuentas(req, rows) {
  const errors = [];
  const warnings = []; // la fila SÍ se importó, pero con una observación
  // Validar y normalizar
  const parsed = [];
  const codesInFile = new Set();
  for (const r of rows) {
    const code = String(r.code ?? '').trim();
    const name = String(r.name ?? '').trim();
    if (!code || !name) { errors.push(`Fila ${r.__row}: codigo y nombre son obligatorios`); continue; }
    const type = TYPE_SYNONYMS[norm(r.type)];
    if (!type) { errors.push(`Fila ${r.__row} (${code}): tipo inválido "${r.type}" (use ACTIVO/PASIVO/PATRIMONIO/INGRESO/GASTO/COSTO/ORDEN)`); continue; }
    let nature = norm(r.nature);
    if (nature === 'DEUDORA' || nature === 'DEBE') nature = 'DEBITO';
    if (nature === 'ACREEDORA' || nature === 'HABER') nature = 'CREDITO';
    if (!nature) nature = DEFAULT_NATURE[type];
    if (!['DEBITO', 'CREDITO'].includes(nature)) { errors.push(`Fila ${r.__row} (${code}): naturaleza inválida "${r.nature}"`); continue; }
    codesInFile.add(code);
    parsed.push({
      row: r.__row, code, name, type, nature,
      allowsMovementRaw: r.allowsMovement,
      active: norm(r.active) !== 'INACTIVO',
      description: String(r.description ?? '').trim(),
    });
  }

  // allowsMovement por defecto: agrupadora si tiene hijas en el archivo.
  const hasChildren = (code) => {
    const prefix = code + '.';
    for (const c of codesInFile) if (c.startsWith(prefix)) return true;
    return false;
  };

  // Padres primero (menor profundidad) para poder enlazar `parent` en una pasada.
  parsed.sort((a, b) => a.code.split('.').length - b.code.split('.').length || a.code.localeCompare(b.code));

  const existing = await ChartOfAccount.find({ clinic: req.clinicId }).select('code');
  const byCode = new Map(existing.map((a) => [a.code, a]));
  let created = 0, updated = 0;
  for (const p of parsed) {
    const level = p.code.split('.').length;
    const parentCode = level > 1 ? p.code.split('.').slice(0, -1).join('.') : null;
    const parent = parentCode ? (byCode.get(parentCode)?._id || null) : null;
    if (parentCode && !parent) warnings.push(`Fila ${p.row} (${p.code}): la cuenta padre ${parentCode} no existe (ni en el archivo ni en el sistema); se importó sin padre`);
    const allowsMovement = (p.allowsMovementRaw === undefined || p.allowsMovementRaw === null || String(p.allowsMovementRaw).trim() === '')
      ? !hasChildren(p.code)
      : parseBool(p.allowsMovementRaw, true);
    const fields = { name: p.name, type: p.type, nature: p.nature, parent, level, allowsMovement, active: p.active, description: p.description };
    try {
      const prev = byCode.get(p.code);
      if (prev) {
        await ChartOfAccount.updateOne({ _id: prev._id }, { $set: fields });
        updated++;
      } else {
        const doc = await ChartOfAccount.create({ clinic: req.clinicId, code: p.code, ...fields });
        byCode.set(p.code, doc);
        created++;
      }
    } catch (e) { errors.push(`Fila ${p.row} (${p.code}): ${e.message}`); }
  }
  return { created, updated, errors, warnings };
}

// ─── CATEGORÍAS (INVENTARIO / ACTIVO_FIJO) ───────────────────────────────────

const CAT_ALIASES = {
  code: ['codigo', 'code'],
  name: ['nombre', 'name'],
  kind: ['tipo', 'kind', 'clase'],
  assetAccount: ['cuenta inventario', 'cuenta de inventario', 'cuenta activo', 'cuenta de activo'],
  expenseAccount: ['cuenta costo', 'cuenta de costo', 'cuenta costo gasto', 'cuenta gasto', 'cuenta de gasto'],
  incomeAccount: ['cuenta venta', 'cuenta de venta', 'cuenta ingreso', 'cuenta de ingreso'],
  depreciationAccount: ['cuenta depreciacion', 'cuenta gasto depreciacion', 'cuenta de depreciacion'],
  accumDepreciationAccount: ['cuenta dep acumulada', 'cuenta depreciacion acumulada'],
  usefulLifeMonths: ['vida util meses', 'vida util (meses)', 'meses vida util'],
  residualPercent: ['porcentaje residual', '% residual', 'residual'],
  expenseType: ['tipo gasto', 'tipo de gasto'],
  noDepreciate: ['no depreciar', 'sin depreciacion'],
};

const catTemplateDef = {
  sheetName: 'Categorias',
  columns: [
    { header: 'codigo', key: 'code', width: 14 },
    { header: 'nombre', key: 'name', width: 32 },
    { header: 'tipo', key: 'kind', width: 14 },
    { header: 'cuenta_inventario', key: 'assetAccount', width: 18 },
    { header: 'cuenta_costo', key: 'expenseAccount', width: 18 },
    { header: 'cuenta_venta', key: 'incomeAccount', width: 18 },
    { header: 'cuenta_depreciacion', key: 'depreciationAccount', width: 20 },
    { header: 'cuenta_dep_acumulada', key: 'accumDepreciationAccount', width: 20 },
    { header: 'vida_util_meses', key: 'usefulLifeMonths', width: 15 },
    { header: 'porcentaje_residual', key: 'residualPercent', width: 18 },
    { header: 'tipo_gasto', key: 'expenseType', width: 16 },
    { header: 'no_depreciar', key: 'noDepreciate', width: 12 },
  ],
  example: { code: 'AMP', name: 'Ampollas', kind: 'INVENTARIO', assetAccount: '1.1.04.01', expenseAccount: '5.1.01', incomeAccount: '4.1.01' },
  instructions: [
    'CATEGORÍAS CONTABLES — parametrizan las cuentas de productos (INVENTARIO) y activos fijos (ACTIVO_FIJO).',
    'codigo y nombre: obligatorios. Si el código ya existe, la fila ACTUALIZA la categoría.',
    'tipo: INVENTARIO o ACTIVO_FIJO.',
    'Las columnas cuenta_* llevan el CÓDIGO de la cuenta según el plan de cuentas (impórtelo primero).',
    'Para INVENTARIO: cuenta_inventario (activo), cuenta_costo (costo/gasto) y cuenta_venta (ingreso). Obligatoria la de inventario.',
    'Para ACTIVO_FIJO: cuenta_inventario = cuenta del activo; cuenta_depreciacion (gasto) y cuenta_dep_acumulada;',
    '  vida_util_meses (ej: 120 = 10 años), porcentaje_residual (0-100), tipo_gasto: ADMINISTRATIVO, VENTAS, COSTOS u OTRO.',
    'no_depreciar: SI solo para activos que no se deprecian (p.ej. terrenos).',
  ],
};

async function importCategorias(req, rows) {
  const errors = [];
  const accIdx = await accountIndex(req.clinicId);
  let created = 0, updated = 0;
  for (const r of rows) {
    const code = String(r.code ?? '').trim();
    const name = String(r.name ?? '').trim();
    if (!code || !name) { errors.push(`Fila ${r.__row}: codigo y nombre son obligatorios`); continue; }
    const kindRaw = norm(r.kind);
    const kind = kindRaw === 'ACTIVO FIJO' || kindRaw === 'ACTIVO_FIJO' || kindRaw === 'ACTIVOFIJO' ? 'ACTIVO_FIJO'
      : kindRaw === 'INVENTARIO' || !kindRaw ? 'INVENTARIO' : null;
    if (!kind) { errors.push(`Fila ${r.__row} (${code}): tipo inválido "${r.kind}" (INVENTARIO o ACTIVO_FIJO)`); continue; }

    const rowErrors = [];
    const fields = { name, kind };
    const asset = resolveAccount(accIdx, r.assetAccount, kind === 'INVENTARIO' ? 'cuenta de inventario' : 'cuenta de activo', rowErrors, r.__row, { required: true });
    if (asset !== undefined) fields.assetAccount = asset;
    const expense = resolveAccount(accIdx, r.expenseAccount, 'cuenta de costo/gasto', rowErrors, r.__row);
    if (expense !== undefined) fields.expenseAccount = expense;
    const income = resolveAccount(accIdx, r.incomeAccount, 'cuenta de venta', rowErrors, r.__row);
    if (income !== undefined) fields.incomeAccount = income;

    if (kind === 'ACTIVO_FIJO') {
      fields.noDepreciate = parseBool(r.noDepreciate, false);
      if (!fields.noDepreciate) {
        const dep = resolveAccount(accIdx, r.depreciationAccount, 'cuenta de gasto de depreciación', rowErrors, r.__row, { required: true });
        if (dep !== undefined) fields.depreciationAccount = dep;
        const accum = resolveAccount(accIdx, r.accumDepreciationAccount, 'cuenta de depreciación acumulada', rowErrors, r.__row, { required: true });
        if (accum !== undefined) fields.accumDepreciationAccount = accum;
        fields.usefulLifeMonths = Number(r.usefulLifeMonths) || 0;
        fields.residualPercent = Number(r.residualPercent) || 0;
        const et = norm(r.expenseType);
        fields.expenseType = ['ADMINISTRATIVO', 'VENTAS', 'COSTOS', 'OTRO'].includes(et) ? et : '';
        if (!(fields.usefulLifeMonths > 0)) rowErrors.push(`Fila ${r.__row} (${code}): vida_util_meses debe ser mayor a 0`);
        if (!fields.expenseType) rowErrors.push(`Fila ${r.__row} (${code}): tipo_gasto es obligatorio (ADMINISTRATIVO/VENTAS/COSTOS/OTRO)`);
      }
    }
    if (rowErrors.length) { errors.push(...rowErrors); continue; }
    try {
      const prev = await InventoryCategory.findOne({ clinic: req.clinicId, code });
      if (prev) { Object.assign(prev, fields); await prev.save(); updated++; }
      else { await InventoryCategory.create({ clinic: req.clinicId, code, ...fields }); created++; }
    } catch (e) { errors.push(`Fila ${r.__row} (${code}): ${e.message}`); }
  }
  return { created, updated, errors };
}

// ─── EMPLEADOS ───────────────────────────────────────────────────────────────

const EMP_ALIASES = {
  code: ['codigo', 'code'],
  identificacion: ['identificacion', 'cedula', 'ruc', 'documento'],
  tipoIdentificacion: ['tipo identificacion', 'tipo documento'],
  firstName: ['nombres', 'nombre', 'first name'],
  lastName: ['apellidos', 'apellido', 'last name'],
  email: ['email', 'correo'],
  phone: ['telefono', 'celular', 'phone'],
  address: ['direccion', 'address'],
  birthDate: ['fecha nacimiento', 'fecha de nacimiento'],
  hireDate: ['fecha ingreso', 'fecha de ingreso', 'ingreso'],
  department: ['departamento', 'department'],
  position: ['cargo', 'puesto', 'position'],
  baseSalary: ['sueldo', 'sueldo base', 'salario', 'sueldo bruto'],
  contractType: ['tipo contrato', 'tipo de contrato', 'contrato'],
  paymentFrequency: ['frecuencia pago', 'frecuencia de pago'],
  paymentMethod: ['forma pago', 'forma de pago', 'metodo de pago'],
  bankName: ['banco'],
  bankAccountType: ['tipo cuenta', 'tipo de cuenta'],
  bankAccount: ['cuenta bancaria', 'numero de cuenta', 'nro cuenta'],
  chargesFamily: ['cargas familiares', 'cargas'],
  decimoTercero: ['decimo tercero', 'decimotercero', 'xiii'],
  decimoCuarto: ['decimo cuarto', 'decimocuarto', 'xiv'],
  fondosReserva: ['fondos reserva', 'fondos de reserva'],
  costCenter: ['centro costo', 'centro de costo'],
  sectoralCode: ['codigo sectorial', 'comision sectorial'],
};

const empTemplateDef = {
  sheetName: 'Empleados',
  columns: [
    { header: 'identificacion', key: 'identificacion', width: 15 },
    { header: 'tipo_identificacion', key: 'tipoIdentificacion', width: 16 },
    { header: 'nombres', key: 'firstName', width: 22 },
    { header: 'apellidos', key: 'lastName', width: 22 },
    { header: 'fecha_ingreso', key: 'hireDate', width: 14 },
    { header: 'departamento', key: 'department', width: 20 },
    { header: 'cargo', key: 'position', width: 20 },
    { header: 'sueldo', key: 'baseSalary', width: 12 },
    { header: 'tipo_contrato', key: 'contractType', width: 15 },
    { header: 'frecuencia_pago', key: 'paymentFrequency', width: 15 },
    { header: 'forma_pago', key: 'paymentMethod', width: 16 },
    { header: 'banco', key: 'bankName', width: 18 },
    { header: 'tipo_cuenta', key: 'bankAccountType', width: 12 },
    { header: 'cuenta_bancaria', key: 'bankAccount', width: 16 },
    { header: 'email', key: 'email', width: 24 },
    { header: 'telefono', key: 'phone', width: 14 },
    { header: 'direccion', key: 'address', width: 26 },
    { header: 'fecha_nacimiento', key: 'birthDate', width: 15 },
    { header: 'cargas_familiares', key: 'chargesFamily', width: 15 },
    { header: 'decimo_tercero', key: 'decimoTercero', width: 15 },
    { header: 'decimo_cuarto', key: 'decimoCuarto', width: 15 },
    { header: 'fondos_reserva', key: 'fondosReserva', width: 14 },
    { header: 'centro_costo', key: 'costCenter', width: 14 },
    { header: 'codigo_sectorial', key: 'sectoralCode', width: 16 },
    { header: 'codigo', key: 'code', width: 12 },
  ],
  example: {
    identificacion: '0912345678', tipoIdentificacion: 'CEDULA', firstName: 'María José', lastName: 'Pérez López',
    hireDate: '01/03/2024', department: 'Administrativo', position: 'Contadora', baseSalary: 800,
    contractType: 'INDEFINIDO', paymentFrequency: 'MENSUAL', paymentMethod: 'TRANSFERENCIA',
    bankName: 'Banco Pichincha', bankAccountType: 'AHORROS', bankAccount: '2201234567',
    decimoTercero: 'MENSUALIZADO', decimoCuarto: 'MENSUALIZADO', fondosReserva: 'SI',
  },
  instructions: [
    'EMPLEADOS — si la identificación ya existe, la fila ACTUALIZA ese empleado.',
    'Obligatorios: identificacion, nombres, apellidos, fecha_ingreso, sueldo.',
    'tipo_identificacion: CEDULA (defecto), RUC o PASAPORTE.',
    'departamento y cargo: use el NOMBRE exacto del catálogo de nómina (Contabilidad → Nómina → Configuración).',
    '  Las cuentas contables del rol salen del departamento/cargo/conceptos, no de esta plantilla.',
    'tipo_contrato: INDEFINIDO, FIJO, EVENTUAL, PRACTICAS o TIEMPO_PARCIAL. frecuencia_pago: MENSUAL, QUINCENAL o SEMANAL.',
    'forma_pago: TRANSFERENCIA, CHEQUE o EFECTIVO. tipo_cuenta: AHORROS o CORRIENTE.',
    'decimo_tercero / decimo_cuarto: MENSUALIZADO o ACUMULADO. fondos_reserva: SI cuando ya cumplió 1 año.',
    'Fechas: dd/mm/aaaa. centro_costo: código del centro de costo (opcional).',
    'codigo (opcional): si se deja vacío se genera EMP-#### automáticamente.',
  ],
};

async function importEmpleados(req, rows) {
  const errors = [];
  const warnings = [];
  const [departments, positions, costCenters] = await Promise.all([
    PayrollDepartment.find({ clinic: req.clinicId }).select('name').lean(),
    PayrollPosition.find({ clinic: req.clinicId }).select('name').lean(),
    CostCenter.find({ clinic: req.clinicId }).select('code name').lean(),
  ]);
  const depIdx = new Map(departments.map((d) => [norm(d.name), d._id]));
  const posIdx = new Map(positions.map((p) => [norm(p.name), p._id]));
  const ccIdx = new Map(costCenters.flatMap((c) => [[norm(c.code), c._id], [norm(c.name), c._id]]));

  // Próximo código EMP-#### disponible
  const last = await Employee.find({ clinic: req.clinicId, code: /^EMP-\d+$/ }).select('code').lean();
  let nextNum = last.reduce((m, e) => Math.max(m, parseInt(e.code.slice(4), 10) || 0), 0) + 1;

  let created = 0, updated = 0;
  for (const r of rows) {
    const identificacion = String(r.identificacion ?? '').trim();
    const firstName = String(r.firstName ?? '').trim();
    const lastName = String(r.lastName ?? '').trim();
    if (!identificacion || !firstName || !lastName) { errors.push(`Fila ${r.__row}: identificacion, nombres y apellidos son obligatorios`); continue; }
    const hireDate = parseDate(r.hireDate);
    const baseSalary = Number(r.baseSalary) || 0;

    const fields = { firstName, lastName };
    const tid = norm(r.tipoIdentificacion);
    if (['CEDULA', 'RUC', 'PASAPORTE'].includes(tid)) fields.tipoIdentificacion = tid;
    if (r.email) fields.email = String(r.email).trim();
    if (r.phone) fields.phone = String(r.phone).trim();
    if (r.address) fields.address = String(r.address).trim();
    const birth = parseDate(r.birthDate);
    if (birth) fields.birthDate = birth;
    if (hireDate) fields.hireDate = hireDate;
    if (baseSalary > 0) fields.baseSalary = baseSalary;

    if (r.department) {
      const dep = depIdx.get(norm(r.department));
      if (dep) { fields.departmentRef = dep; fields.department = String(r.department).trim(); }
      else warnings.push(`Fila ${r.__row} (${identificacion}): departamento "${r.department}" no existe en el catálogo de nómina (se importó sin departamento)`);
    }
    if (r.position) {
      const pos = posIdx.get(norm(r.position));
      if (pos) { fields.positionRef = pos; fields.position = String(r.position).trim(); }
      else warnings.push(`Fila ${r.__row} (${identificacion}): cargo "${r.position}" no existe en el catálogo de nómina (se importó sin cargo)`);
    }
    if (r.costCenter) {
      const cc = ccIdx.get(norm(r.costCenter));
      if (cc) fields.costCenter = cc;
      else warnings.push(`Fila ${r.__row} (${identificacion}): centro de costo "${r.costCenter}" no existe (se importó sin centro)`);
    }
    const ct = norm(r.contractType);
    if (['INDEFINIDO', 'FIJO', 'EVENTUAL', 'PRACTICAS', 'TIEMPO PARCIAL', 'TIEMPO_PARCIAL'].includes(ct)) fields.contractType = ct.replace(' ', '_');
    const pf = norm(r.paymentFrequency);
    if (['MENSUAL', 'QUINCENAL', 'SEMANAL'].includes(pf)) fields.paymentFrequency = pf;
    const pm = norm(r.paymentMethod);
    if (['TRANSFERENCIA', 'CHEQUE', 'EFECTIVO'].includes(pm)) fields.paymentMethod = pm;
    if (r.bankName) fields.bankName = String(r.bankName).trim();
    const bat = norm(r.bankAccountType);
    if (['AHORROS', 'CORRIENTE'].includes(bat)) fields.bankAccountType = bat;
    if (r.bankAccount) fields.bankAccount = String(r.bankAccount).trim();
    if (r.chargesFamily !== undefined && r.chargesFamily !== null && String(r.chargesFamily).trim() !== '') fields.chargesFamily = Number(r.chargesFamily) || 0;
    const d13 = norm(r.decimoTercero);
    if (['MENSUALIZADO', 'ACUMULADO'].includes(d13)) fields.decimoTerceroAcumulado = d13;
    const d14 = norm(r.decimoCuarto);
    if (['MENSUALIZADO', 'ACUMULADO'].includes(d14)) fields.decimoCuartoAcumulado = d14;
    if (r.fondosReserva !== undefined && r.fondosReserva !== null && String(r.fondosReserva).trim() !== '') fields.receivesFondosReserva = parseBool(r.fondosReserva);
    if (r.sectoralCode) fields.sectoralCode = String(r.sectoralCode).trim();

    try {
      const prev = await Employee.findOne({ clinic: req.clinicId, identificacion });
      if (prev) {
        Object.assign(prev, fields);
        await prev.save();
        updated++;
      } else {
        if (!hireDate) { errors.push(`Fila ${r.__row} (${identificacion}): fecha_ingreso es obligatoria para empleados nuevos`); continue; }
        if (!(baseSalary > 0)) { errors.push(`Fila ${r.__row} (${identificacion}): sueldo es obligatorio para empleados nuevos`); continue; }
        const code = String(r.code ?? '').trim() || `EMP-${String(nextNum++).padStart(4, '0')}`;
        await Employee.create({
          clinic: req.clinicId, code, identificacion, ...fields,
          salaryHistory: [{ date: new Date(), newType: 'GROSS', newSalary: baseSalary, newNet: 0, reason: 'Carga inicial por plantilla', changedBy: req.user._id }],
        });
        created++;
      }
    } catch (e) { errors.push(`Fila ${r.__row} (${identificacion}): ${e.message}`); }
  }
  return { created, updated, errors, warnings };
}

// ─── PROVEEDORES / CLIENTES CONTABLES (Supplier) ─────────────────────────────

const SUP_ALIASES = {
  ruc: ['identificacion', 'ruc', 'cedula', 'documento'],
  tipoIdentificacion: ['tipo identificacion', 'tipo documento'],
  razonSocial: ['razon social', 'nombre', 'razonsocial'],
  nombreComercial: ['nombre comercial'],
  roles: ['roles', 'rol', 'tipo tercero'],
  email: ['email', 'correo'],
  phone: ['telefono', 'celular'],
  address: ['direccion'],
  contactName: ['contacto', 'nombre contacto', 'persona de contacto'],
  creditDays: ['dias credito', 'dias de credito', 'plazo'],
  isSpecialContributor: ['contribuyente especial'],
  isWithholdingAgent: ['agente retencion', 'agente de retencion'],
  rimpe: ['rimpe', 'regimen rimpe'],
  defaultExpenseAccount: ['cuenta gasto', 'cuenta de gasto', 'cuenta gasto defecto'],
  defaultPayableAccount: ['cuenta por pagar', 'cuenta cxp'],
  notes: ['notas', 'observaciones'],
};

const supTemplateDef = {
  sheetName: 'Proveedores',
  columns: [
    { header: 'identificacion', key: 'ruc', width: 16 },
    { header: 'tipo_identificacion', key: 'tipoIdentificacion', width: 16 },
    { header: 'razon_social', key: 'razonSocial', width: 34 },
    { header: 'nombre_comercial', key: 'nombreComercial', width: 26 },
    { header: 'roles', key: 'roles', width: 20 },
    { header: 'email', key: 'email', width: 24 },
    { header: 'telefono', key: 'phone', width: 14 },
    { header: 'direccion', key: 'address', width: 30 },
    { header: 'contacto', key: 'contactName', width: 20 },
    { header: 'dias_credito', key: 'creditDays', width: 12 },
    { header: 'contribuyente_especial', key: 'isSpecialContributor', width: 20 },
    { header: 'agente_retencion', key: 'isWithholdingAgent', width: 16 },
    { header: 'rimpe', key: 'rimpe', width: 14 },
    { header: 'cuenta_gasto', key: 'defaultExpenseAccount', width: 14 },
    { header: 'cuenta_por_pagar', key: 'defaultPayableAccount', width: 16 },
    { header: 'notas', key: 'notes', width: 30 },
  ],
  example: {
    ruc: '0992345678001', tipoIdentificacion: 'RUC', razonSocial: 'Distribuidora Médica S.A.',
    nombreComercial: 'DIMESA', roles: 'PROVEEDOR', creditDays: 30, isSpecialContributor: 'NO',
    isWithholdingAgent: 'NO', rimpe: '', defaultExpenseAccount: '5.2.01',
  },
  instructions: [
    'PROVEEDORES / TERCEROS — si la identificación ya existe, la fila ACTUALIZA el registro.',
    'Obligatorios: identificacion y razon_social.',
    'tipo_identificacion: RUC (defecto), CEDULA o PASAPORTE.',
    'roles: PROVEEDOR (defecto), CLIENTE o ambos separados por coma (PROVEEDOR,CLIENTE).',
    'contribuyente_especial / agente_retencion: SI o NO. rimpe: POPULAR, EMPRENDEDOR o vacío.',
    'cuenta_gasto / cuenta_por_pagar: CÓDIGO de la cuenta del plan (opcional; memoria para las compras).',
  ],
};

async function importProveedores(req, rows) {
  const errors = [];
  const warnings = []; // cuentas opcionales no encontradas: la fila se importa igual
  const accIdx = await accountIndex(req.clinicId);
  let created = 0, updated = 0;
  for (const r of rows) {
    const ruc = String(r.ruc ?? '').trim();
    const razonSocial = String(r.razonSocial ?? '').trim();
    if (!ruc || !razonSocial) { errors.push(`Fila ${r.__row}: identificacion y razon_social son obligatorios`); continue; }
    const fields = { razonSocial };
    const tid = norm(r.tipoIdentificacion);
    if (['RUC', 'CEDULA', 'PASAPORTE'].includes(tid)) fields.tipoIdentificacion = tid;
    if (r.nombreComercial) fields.nombreComercial = String(r.nombreComercial).trim();
    if (r.roles) {
      const roles = norm(r.roles).split(/[,;/]+/).map((x) => x.trim()).filter((x) => ['CLIENTE', 'PROVEEDOR', 'EMPLEADO', 'VENDEDOR'].includes(x));
      if (roles.length) fields.roles = roles;
    }
    if (r.email) fields.email = String(r.email).trim();
    if (r.phone) fields.phone = String(r.phone).trim();
    if (r.address) fields.address = String(r.address).trim();
    if (r.contactName) fields.contactName = String(r.contactName).trim();
    if (r.creditDays !== undefined && r.creditDays !== null && String(r.creditDays).trim() !== '') fields.creditDays = Number(r.creditDays) || 0;
    if (r.isSpecialContributor !== undefined && String(r.isSpecialContributor ?? '').trim() !== '') fields.isSpecialContributor = parseBool(r.isSpecialContributor);
    if (r.isWithholdingAgent !== undefined && String(r.isWithholdingAgent ?? '').trim() !== '') fields.isWithholdingAgent = parseBool(r.isWithholdingAgent);
    const rimpe = norm(r.rimpe);
    if (['POPULAR', 'EMPRENDEDOR'].includes(rimpe)) fields.rimpe = rimpe;
    const exp = resolveAccount(accIdx, r.defaultExpenseAccount, 'cuenta de gasto', warnings, r.__row);
    if (exp !== undefined) fields.defaultExpenseAccount = exp;
    const pay = resolveAccount(accIdx, r.defaultPayableAccount, 'cuenta por pagar', warnings, r.__row);
    if (pay !== undefined) fields.defaultPayableAccount = pay;
    if (r.notes) fields.notes = String(r.notes).trim();
    try {
      const prev = await Supplier.findOne({ clinic: req.clinicId, ruc });
      if (prev) { Object.assign(prev, fields); await prev.save(); updated++; }
      else { await Supplier.create({ clinic: req.clinicId, ruc, ...fields }); created++; }
    } catch (e) { errors.push(`Fila ${r.__row} (${ruc}): ${e.message}`); }
  }
  return { created, updated, errors, warnings };
}

// ─── CLIENTES (Pacientes) ────────────────────────────────────────────────────

const CLI_ALIASES = {
  cedula: ['identificacion', 'cedula', 'documento'],
  firstName: ['nombres', 'nombre'],
  lastName: ['apellidos', 'apellido'],
  email: ['email', 'correo'],
  phone: ['telefono', 'celular'],
  whatsapp: ['whatsapp'],
  birthDate: ['fecha nacimiento', 'fecha de nacimiento'],
  gender: ['genero', 'sexo'],
  address: ['direccion'],
  notes: ['notas', 'observaciones'],
};

const cliTemplateDef = {
  sheetName: 'Clientes',
  columns: [
    { header: 'identificacion', key: 'cedula', width: 15 },
    { header: 'nombres', key: 'firstName', width: 24 },
    { header: 'apellidos', key: 'lastName', width: 24 },
    { header: 'email', key: 'email', width: 26 },
    { header: 'telefono', key: 'phone', width: 14 },
    { header: 'whatsapp', key: 'whatsapp', width: 14 },
    { header: 'fecha_nacimiento', key: 'birthDate', width: 16 },
    { header: 'genero', key: 'gender', width: 12 },
    { header: 'direccion', key: 'address', width: 32 },
    { header: 'notas', key: 'notes', width: 30 },
  ],
  example: { cedula: '0923456789', firstName: 'Ana', lastName: 'Suárez', email: 'ana@mail.com', phone: '0991234567', gender: 'femenino' },
  instructions: [
    'CLIENTES (pacientes) — si la identificación ya existe, la fila ACTUALIZA el registro.',
    'Obligatorios: nombres y apellidos. La identificación es muy recomendable (evita duplicados y sirve para facturar).',
    'genero: masculino, femenino u otro. Fechas: dd/mm/aaaa.',
  ],
};

async function importClientes(req, rows) {
  const errors = [];
  let created = 0, updated = 0;
  for (const r of rows) {
    const cedula = String(r.cedula ?? '').trim();
    const firstName = String(r.firstName ?? '').trim();
    const lastName = String(r.lastName ?? '').trim();
    if (!firstName || !lastName) { errors.push(`Fila ${r.__row}: nombres y apellidos son obligatorios`); continue; }
    const fields = { firstName, lastName };
    if (r.email) fields.email = String(r.email).trim();
    if (r.phone) fields.phone = String(r.phone).trim();
    if (r.whatsapp) fields.whatsapp = String(r.whatsapp).trim();
    const birth = parseDate(r.birthDate);
    if (birth) fields.birthDate = birth;
    const g = String(r.gender ?? '').trim().toLowerCase();
    if (['masculino', 'femenino', 'otro'].includes(g)) fields.gender = g;
    if (r.address) fields.address = String(r.address).trim();
    if (r.notes) fields.notes = String(r.notes).trim();
    try {
      // La cédula de paciente es única GLOBAL (no por clínica): buscar sin filtro de clínica.
      const prev = cedula ? await Patient.findOne({ cedula }) : null;
      if (prev) { Object.assign(prev, fields); await prev.save(); updated++; }
      else { await Patient.create({ clinic: req.clinicId, cedula, ...fields }); created++; }
    } catch (e) { errors.push(`Fila ${r.__row} (${cedula || firstName}): ${e.message}`); }
  }
  return { created, updated, errors };
}

// ─── ACTIVOS FIJOS ───────────────────────────────────────────────────────────

const ASSET_ALIASES = {
  code: ['codigo', 'code'],
  name: ['nombre', 'name', 'descripcion del activo'],
  category: ['categoria', 'categoria activo', 'categoria de activo'],
  serial: ['serie', 'serial', 'numero de serie'],
  location: ['ubicacion', 'location'],
  acquisitionDate: ['fecha adquisicion', 'fecha de adquisicion', 'fecha compra'],
  acquisitionCost: ['costo adquisicion', 'costo de adquisicion', 'costo', 'valor compra'],
  startDate: ['inicio depreciacion', 'fecha inicio depreciacion'],
  accumulatedDepreciation: ['depreciacion acumulada', 'dep acumulada'],
  notes: ['notas', 'observaciones'],
};

const assetTemplateDef = {
  sheetName: 'ActivosFijos',
  columns: [
    { header: 'codigo', key: 'code', width: 14 },
    { header: 'nombre', key: 'name', width: 34 },
    { header: 'categoria', key: 'category', width: 24 },
    { header: 'fecha_adquisicion', key: 'acquisitionDate', width: 17 },
    { header: 'costo_adquisicion', key: 'acquisitionCost', width: 16 },
    { header: 'inicio_depreciacion', key: 'startDate', width: 18 },
    { header: 'depreciacion_acumulada', key: 'accumulatedDepreciation', width: 20 },
    { header: 'serie', key: 'serial', width: 18 },
    { header: 'ubicacion', key: 'location', width: 20 },
    { header: 'notas', key: 'notes', width: 30 },
  ],
  example: {
    code: 'AF-001', name: 'Láser CO2 fraccionado', category: 'Equipos médicos',
    acquisitionDate: '15/01/2023', acquisitionCost: 25000, startDate: '01/02/2023', accumulatedDepreciation: 6250,
  },
  instructions: [
    'ACTIVOS FIJOS — si el código ya existe, la fila ACTUALIZA el activo.',
    'Obligatorios: codigo, nombre, categoria, fecha_adquisicion, costo_adquisicion.',
    'categoria: CÓDIGO o NOMBRE exacto de una categoría de tipo ACTIVO_FIJO (impórtelas primero).',
    '  Las cuentas contables, vida útil y % residual salen de la categoría (fuente única); el activo guarda el snapshot.',
    'depreciacion_acumulada: saldo YA depreciado al migrar (activos a medio depreciar de Contífico). El sistema',
    '  continúa la depreciación desde ese valor.',
    'inicio_depreciacion: si se deja vacío, se usa la fecha de adquisición.',
    'Fechas: dd/mm/aaaa.',
  ],
};

async function importActivos(req, rows) {
  const errors = [];
  const cats = await InventoryCategory.find({ clinic: req.clinicId, kind: 'ACTIVO_FIJO' }).lean();
  const catIdx = new Map(cats.flatMap((c) => [[norm(c.code), c], [norm(c.name), c]]));
  let created = 0, updated = 0;
  for (const r of rows) {
    const code = String(r.code ?? '').trim();
    const name = String(r.name ?? '').trim();
    if (!code || !name) { errors.push(`Fila ${r.__row}: codigo y nombre son obligatorios`); continue; }
    const cat = catIdx.get(norm(r.category));
    if (!cat) { errors.push(`Fila ${r.__row} (${code}): categoría "${r.category}" no existe o no es de tipo ACTIVO_FIJO`); continue; }
    const acquisitionDate = parseDate(r.acquisitionDate);
    const acquisitionCost = Number(r.acquisitionCost) || 0;
    if (!acquisitionDate || !(acquisitionCost > 0)) { errors.push(`Fila ${r.__row} (${code}): fecha_adquisicion y costo_adquisicion son obligatorios`); continue; }

    // Snapshot de parámetros desde la categoría (fuente única de configuración).
    const cfg = normalizeAssetConfig(cat);
    const residualValue = +((acquisitionCost * (cfg.residualPercent || 0)) / 100).toFixed(2);
    const usefulLifeMonths = cfg.noDepreciate ? 0 : cfg.usefulLifeMonths;
    if (!cfg.noDepreciate && !(usefulLifeMonths > 0)) { errors.push(`Fila ${r.__row} (${code}): la categoría "${cat.name}" no tiene vida útil configurada`); continue; }
    const base = acquisitionCost - residualValue;
    const monthlyDepreciation = cfg.noDepreciate ? 0 : +(base / usefulLifeMonths).toFixed(2);
    const accumulated = Math.min(Number(r.accumulatedDepreciation) || 0, base);
    const startDate = parseDate(r.startDate) || acquisitionDate;

    const fields = {
      name,
      category: cat._id,
      serial: r.serial ? String(r.serial).trim() : undefined,
      location: r.location ? String(r.location).trim() : undefined,
      notes: r.notes ? String(r.notes).trim() : undefined,
      acquisitionDate, acquisitionCost, startDate,
      residualValue,
      residualPercent: cfg.residualPercent || 0,
      depreciationRate: cfg.noDepreciate ? 0 : +(1200 / usefulLifeMonths).toFixed(2),
      usefulLifeMonths: usefulLifeMonths || 1,
      expenseType: cat.expenseType || '',
      assetAccount: cat.assetAccount || null,
      depreciationAccount: cat.depreciationAccount || null,
      accumDepreciationAccount: cat.accumDepreciationAccount || null,
      accumulatedDepreciation: accumulated,
      bookValue: +(acquisitionCost - accumulated).toFixed(2),
      monthlyDepreciation,
    };
    Object.keys(fields).forEach((k) => fields[k] === undefined && delete fields[k]);
    try {
      const prev = await FixedAsset.findOne({ clinic: req.clinicId, code });
      if (prev) { Object.assign(prev, fields); await prev.save(); updated++; }
      else { await FixedAsset.create({ clinic: req.clinicId, code, ...fields, createdBy: req.user._id }); created++; }
    } catch (e) { errors.push(`Fila ${r.__row} (${code}): ${e.message}`); }
  }
  return { created, updated, errors };
}

// ─── Registro de tipos y endpoints ───────────────────────────────────────────

const TYPES = {
  'plan-cuentas': { filename: 'plantilla_plan_de_cuentas.xlsx', template: planTemplateDef, aliases: PLAN_ALIASES, run: importPlanCuentas, required: ['code', 'name'] },
  categorias: { filename: 'plantilla_categorias.xlsx', template: catTemplateDef, aliases: CAT_ALIASES, run: importCategorias, required: ['code', 'name'] },
  empleados: { filename: 'plantilla_empleados.xlsx', template: empTemplateDef, aliases: EMP_ALIASES, run: importEmpleados, required: ['identificacion', 'firstName'] },
  proveedores: { filename: 'plantilla_proveedores.xlsx', template: supTemplateDef, aliases: SUP_ALIASES, run: importProveedores, required: ['ruc', 'razonSocial'] },
  clientes: { filename: 'plantilla_clientes.xlsx', template: cliTemplateDef, aliases: CLI_ALIASES, run: importClientes, required: ['firstName', 'lastName'] },
  activos: { filename: 'plantilla_activos_fijos.xlsx', template: assetTemplateDef, aliases: ASSET_ALIASES, run: importActivos, required: ['code', 'name'] },
};

exports.downloadTemplate = async (req, res) => {
  try {
    const def = TYPES[req.params.type];
    if (!def) return res.status(404).json({ message: `Tipo de plantilla desconocido: ${req.params.type}` });
    await sendTemplate(res, def.filename, def.template);
  } catch (e) { if (!res.headersSent) res.status(500).json({ message: e.message }); }
};

exports.importFile = async (req, res) => {
  try {
    const def = TYPES[req.params.type];
    if (!def) return res.status(404).json({ message: `Tipo de importación desconocido: ${req.params.type}` });
    if (!req.file) return res.status(400).json({ message: 'Archivo requerido (campo file)' });
    const ws = await loadWorkbook(req.file.buffer);
    const headerMap = mapHeaders(ws, def.aliases);
    const mapped = new Set(Object.values(headerMap));
    const missing = def.required.filter((k) => !mapped.has(k));
    if (missing.length) {
      const labels = missing.map((k) => Object.values(def.aliases[k] || [k])[0]);
      return res.status(400).json({ message: `La plantilla no tiene las columnas obligatorias: ${labels.join(', ')}. Descarga la plantilla oficial y úsala como base.` });
    }
    const rows = rowsToObjects(ws, headerMap);
    if (!rows.length) return res.status(400).json({ message: 'El archivo no tiene filas con datos' });
    const result = await def.run(req, rows);
    res.json({ total: rows.length, ...result });
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};
