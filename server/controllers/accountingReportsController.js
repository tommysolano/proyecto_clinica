const JournalEntry = require('../models/JournalEntry');
const ChartOfAccount = require('../models/ChartOfAccount');
const Sale = require('../models/Sale');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');
const Receivable = require('../models/Receivable');
const Payable = require('../models/Payable');
const AccountBalance = require('../models/AccountBalance');
// Los reportes de ventas pueblan `createdBy`/`cashier`: sin registrar el modelo aquí,
// mongoose revienta con "Schema hasn't been registered for model User" en cuanto este
// controlador es el primero en cargarse (scripts, jobs, un test suelto).
require('../models/User');
const { recomputeBalances } = require('../utils/accounting');
const { startOfDay, endOfDay } = require('../utils/dates');
const {
  resolveReportRange, isMonthlyRange, invoiceFiscalDate, purchaseFiscalDate, inRange,
} = require('../utils/reportDateRange');
const { invoiceTaxBreakdown } = require('../utils/invoiceTaxBreakdown');
const { effectivePaymentDate } = require('../utils/paymentSchedule');
const { resolveReceivableEconomicObligations } = require('../services/receivableObligations');
const ExcelJS = require('exceljs');
const mongoose = require('mongoose');

/**
 * Clínica como ObjectId para los `$match` de las agregaciones.
 *
 * OJO — no es cosmético: `req.clinicId` llega del token como STRING. En `find()`
 * Mongoose lo convierte solo (conoce el esquema), pero en `aggregate()` NO hay
 * conversión: el pipeline compara un string contra un ObjectId, no casa NADA y el
 * reporte sale vacío sin dar error. Así estaban "Ventas por producto", "Ventas por
 * vendedor", "Ventas por cajero", "Gastos no deducibles" y "Anticipos".
 */
const oid = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));
const XL = require('../utils/excelReport');
const { buildAts, atsXml, atsFileName } = require('../utils/sriForms/ats');

/**
 * Número visible de una factura de venta ("001-001-000000123").
 *
 * `Invoice.numero` NO existe: el número es el virtual `numeroFactura`, y los virtuales se
 * PIERDEN al leer con `.lean()` (que es como leen los reportes). Por eso la columna
 * "Factura" del costo de venta salía vacía. Se compone aquí, una sola vez.
 */
const numeroFactura = (inv) => (inv?.estab ? `${inv.estab}-${inv.ptoEmi}-${inv.secuencial}` : '');

/**
 * Ventas fiscalmente en el período: facturas AUTORIZADAS cuya fecha FISCAL
 * (Invoice.fechaEmision 'DD/MM/YYYY', con fallback createdAt) cae en [start, end].
 * Se filtra en JS porque fechaEmision es String y no admite rango en Mongo.
 */
async function fetchSalesInRange(clinicId, start, end) {
  const invoices = await Invoice.find({ clinic: clinicId, estado: 'AUTORIZADO' }).lean();
  return invoices.filter((inv) => inRange(invoiceFiscalDate(inv), start, end));
}

/**
 * Cuenta las facturas de venta REGISTRADAS pero NO autorizadas cuya fecha fiscal cae en
 * el rango (estados de proceso: en cola, recibida, en proceso, no autorizado, devuelta,
 * error). Sirve para que la UI aclare por qué esas ventas no aparecen en el reporte SRI
 * (solo entran las AUTORIZADAS). No cuenta las ANULADA.
 */
async function countPendingSalesInRange(clinicId, start, end) {
  const pendingStates = ['EN_COLA', 'RECIBIDA', 'EN_PROCESO', 'NO_AUTORIZADO', 'DEVUELTA', 'ERROR'];
  const invoices = await Invoice.find({ clinic: clinicId, estado: { $in: pendingStates } })
    .select('estado fechaEmision createdAt').lean();
  return invoices.filter((inv) => inRange(invoiceFiscalDate(inv), start, end)).length;
}

/** Compras (no anuladas) cuya fecha de emisión (Date) cae en [start, end]. */
function purchasesInRangeQuery(clinicId, start, end) {
  return { clinic: clinicId, status: { $ne: 'ANULADA' }, fechaEmision: { $gte: start, $lte: end } };
}

/** Objeto período serializable para las respuestas (etiqueta + metadatos). */
function periodMeta(range) {
  return {
    start: range.start,
    end: range.end,
    label: range.label,
    periodType: range.periodType,
    year: range.year,
    month: range.month,
  };
}

const sendWorkbook = async (res, wb, filename) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
};

function dateMatch(req, field = 'createdAt') {
  const { startDate, endDate } = req.query;
  const m = {};
  if (startDate) m.$gte = new Date(startDate);
  if (endDate) m.$lte = new Date(endDate + 'T23:59:59.999');
  return Object.keys(m).length ? { [field]: m } : {};
}

function periodFormat(granularity) {
  switch (granularity) {
    case 'day': return '%Y-%m-%d';
    case 'week': return '%G-S%V';
    case 'year': return '%Y';
    default: return '%Y-%m';
  }
}

function asObjectId(value) {
  if (!value || !mongoose.Types.ObjectId.isValid(value)) return value;
  return new mongoose.Types.ObjectId(value);
}

function accountBalanceFromNature(account, debit, credit) {
  return account.nature === 'DEBITO' ? debit - credit : credit - debit;
}

function compactAccount(account) {
  return {
    _id: account._id,
    code: account.code,
    name: account.name,
    type: account.type,
    nature: account.nature,
    level: account.level,
    allowsMovement: account.allowsMovement,
    taxCode: account.taxCode,
    description: account.description,
    active: account.active,
  };
}

function lineAccount(line) {
  const accountRef = line.account || {};
  return {
    accountId: accountRef._id || line.account,
    accountCode: line.accountCode || accountRef.code || '',
    accountName: line.accountName || accountRef.name || '',
    description: line.description || '',
    debit: Number(line.debit) || 0,
    credit: Number(line.credit) || 0,
  };
}

function relatedReportsForAccount(account) {
  const reports = [
    { key: 'ledger', label: 'Libro Mayor', description: 'Movimientos y saldo acumulado de esta cuenta.' },
    { key: 'journal', label: 'Libro Diario', description: 'Asientos donde participa la cuenta y sus contrapartidas.' },
    { key: 'trial-balance', label: 'Balance de Comprobacion', description: 'Debitos, creditos y saldo comparados con el resto de cuentas.' },
    { key: 'period-balances', label: 'Saldos por Periodo', description: 'Apertura, movimiento y cierre mensual.' },
  ];
  if (['INGRESO', 'GASTO', 'COSTO'].includes(account.type)) {
    reports.push({ key: 'income-statement', label: 'Estado de Resultados', description: 'Aporta a utilidad bruta u operacional.' });
  }
  if (['ACTIVO', 'PASIVO', 'PATRIMONIO'].includes(account.type)) {
    reports.push({ key: 'balance-sheet', label: 'Balance General', description: 'Aporta a la posicion financiera acumulada.' });
  }
  if (account.code?.startsWith('1.1.01.')) {
    reports.push({ key: 'cash-flow', label: 'Flujo de Caja', description: 'Cuenta de efectivo o banco usada para entradas y salidas.' });
  }
  if (account.code?.startsWith('1.1.02.')) {
    reports.push({ key: 'ar-aging', label: 'Cartera por Cobrar', description: 'Puede relacionarse con clientes, tarjetas o anticipos.' });
  }
  if (account.code?.startsWith('2.1.01.')) {
    reports.push({ key: 'ap-aging', label: 'Cartera por Pagar', description: 'Puede relacionarse con proveedores, empleados o anticipos.' });
  }
  return reports;
}

// ---------- Helpers ----------

/** Zona horaria del negocio: el mes contable de un asiento es el mes en Ecuador. */
const TZ_EC = 'America/Guayaquil';
/** Columna a la que van las líneas SIN centro de costo (el usuario quiere verlas, no perderlas). */
const SIN_CENTRO = '__sin_centro__';
const MESES = ['ENERO', 'FEBRERO', 'MARZO', 'ABRIL', 'MAYO', 'JUNIO', 'JULIO', 'AGOSTO', 'SEPTIEMBRE', 'OCTUBRE', 'NOVIEMBRE', 'DICIEMBRE'];

/**
 * DESGLOSE en columnas del estado financiero: por MES, por CENTRO DE COSTO o por SEDE.
 * Devuelve la expresión de agrupación para el pipeline y, aparte, las columnas que se
 * van a mostrar (con su etiqueta), en el orden en que deben salir.
 *
 * `none` (por defecto) es el comportamiento de siempre: una sola columna con el total.
 */
function breakdownExpr(mode) {
  if (mode === 'month') return { $dateToString: { format: '%Y-%m', date: '$date', timezone: TZ_EC } };
  if (mode === 'costCenter') return { $ifNull: [{ $toString: '$lines.costCenter' }, SIN_CENTRO] };
  if (mode === 'clinic') return { $toString: '$clinic' };
  return null;
}

/** Meses (clave YYYY-MM) que cubre el rango, en orden. */
function monthColumns(startDate, endDate) {
  const ini = startOfDay(startDate) || new Date();
  const fin = endOfDay(endDate) || new Date();
  const cols = [];
  const cur = new Date(ini.getFullYear(), ini.getMonth(), 1);
  const tope = new Date(fin.getFullYear(), fin.getMonth(), 1);
  const variosAnios = ini.getFullYear() !== fin.getFullYear();
  while (cur <= tope && cols.length < 120) {
    const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`;
    cols.push({ key, label: variosAnios ? `${MESES[cur.getMonth()]} ${cur.getFullYear()}` : MESES[cur.getMonth()] });
    cur.setMonth(cur.getMonth() + 1);
  }
  return cols;
}

/**
 * Columnas del desglose. Para centros de costo y sedes se leen los catálogos para
 * poner NOMBRES (no ids), y se añade siempre "Sin centro de costos" cuando hay
 * movimiento sin centro: el usuario pidió expresamente verlo, no que desapareciera.
 */
async function resolveBreakdownColumns(mode, { clinicIds, startDate, endDate, usados }) {
  if (mode === 'month') return monthColumns(startDate, endDate);
  if (mode === 'costCenter') {
    const CostCenter = require('../models/CostCenter');
    const ccs = await CostCenter.find({ clinic: { $in: clinicIds } }).select('code name').sort({ code: 1 }).lean();
    const cols = ccs
      .filter((c) => usados.has(String(c._id)))
      .map((c) => ({ key: String(c._id), label: `${c.code} ${c.name}`.trim() }));
    if (usados.has(SIN_CENTRO)) cols.push({ key: SIN_CENTRO, label: 'Sin centro de costos' });
    return cols;
  }
  if (mode === 'clinic') {
    const Clinic = require('../models/Clinic');
    const cls = await Clinic.find({ _id: { $in: clinicIds } }).select('name').lean();
    return cls
      .filter((c) => usados.has(String(c._id)))
      .map((c) => ({ key: String(c._id), label: c.name }));
  }
  return [];
}

/**
 * Sedes que puede leer el usuario. Solo se usa en el desglose "por sede": el resto de
 * los reportes siguen siendo de la sede activa.
 */
async function readableClinicIds(req) {
  const Clinic = require('../models/Clinic');
  if (req.user?.isSuperAdmin) return (await Clinic.find({ active: true }).select('_id').lean()).map((c) => c._id);
  const ids = (req.user?.clinics || []).map((c) => c.clinic).filter(Boolean);
  return ids.length ? ids : [asObjectId(req.clinicId)];
}

/**
 * Saldos por cuenta en el período. Con `mode` distinto de `none` devuelve además
 * `byColumn` (importe por mes / centro de costo / sede) para el reporte en columnas.
 */
async function getAccountBalances(clinicId, { startDate, endDate, mode = 'none', clinicIds } = {}) {
  const ids = clinicIds?.length ? clinicIds.map(asObjectId) : [asObjectId(clinicId)];
  const match = { clinic: { $in: ids }, status: 'CONTABILIZADO' };
  if (startDate || endDate) {
    match.date = {};
    if (startDate) match.date.$gte = startOfDay(startDate);
    if (endDate) match.date.$lte = endOfDay(endDate);
  }
  const bucket = breakdownExpr(mode);
  const agg = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    {
      $group: {
        _id: bucket ? { account: '$lines.account', bucket } : '$lines.account',
        debit: { $sum: '$lines.debit' },
        credit: { $sum: '$lines.credit' },
      },
    },
  ]);
  // El plan de cuentas es el de la sede activa (el resto de sedes comparten códigos).
  const accounts = await ChartOfAccount.find({ clinic: clinicId }).lean();
  const map = new Map(accounts.map((a) => [String(a._id), { ...a, debit: 0, credit: 0, balance: 0, byColumn: {} }]));
  const usados = new Set();
  for (const r of agg) {
    const accountId = bucket ? r._id?.account : r._id;
    const a = map.get(String(accountId));
    if (!a) continue;
    a.debit += r.debit; a.credit += r.credit;
    a.balance = accountBalanceFromNature(a, a.debit, a.credit);
    if (bucket) {
      const key = String(r._id?.bucket ?? SIN_CENTRO);
      usados.add(key);
      a.byColumn[key] = round2((a.byColumn[key] || 0) + accountBalanceFromNature(a, r.debit, r.credit));
    }
  }
  const list = Array.from(map.values());
  list.usados = usados;   // qué columnas tienen movimiento (para no pintar columnas vacías)
  return list;
}

/**
 * Construye el árbol jerárquico del plan de cuentas (por prefijo de código) con
 * los saldos rodados hacia arriba, igual que presentan Contífico/Supercías: cada
 * cuenta agrupadora muestra el subtotal de sus cuentas hijas. Devuelve los nodos
 * raíz cuyo `type` está en `types`, podando ramas sin saldo.
 */
function buildAccountTree(balances, types) {
  const byCode = new Map();
  const nodes = balances.map((a) => ({
    _id: a._id, code: a.code, name: a.name, type: a.type, nature: a.nature,
    level: a.level, allowsMovement: a.allowsMovement,
    debit: a.debit || 0, credit: a.credit || 0,
    own: a.allowsMovement ? (a.balance || 0) : 0, total: 0, children: [],
    // Importe propio por columna del desglose (mes / centro de costo / sede).
    ownByColumn: a.allowsMovement ? (a.byColumn || {}) : {},
    values: {},
  }));
  nodes.sort((a, b) => String(a.code).localeCompare(String(b.code)));
  for (const n of nodes) byCode.set(n.code, n);
  const roots = [];
  for (const n of nodes) {
    const parentCode = String(n.code).includes('.') ? String(n.code).slice(0, String(n.code).lastIndexOf('.')) : null;
    const parent = parentCode ? byCode.get(parentCode) : null;
    if (parent) parent.children.push(n); else roots.push(n);
  }
  const rollup = (n) => {
    let t = n.own;
    // Las columnas se suman igual que el total: cada grupo muestra la suma de sus hijas.
    const acc = { ...n.ownByColumn };
    for (const c of n.children) {
      t += rollup(c);
      for (const [k, v] of Object.entries(c.values || {})) acc[k] = round2((acc[k] || 0) + v);
    }
    n.values = acc;
    n.total = +t.toFixed(2);
    return n.total;
  };
  roots.forEach(rollup);
  const prune = (n) => {
    n.children = n.children.filter((c) => { prune(c); return Math.abs(c.total) > 0.004 || c.children.length; });
  };
  return roots
    .filter((r) => types.includes(r.type))
    .filter((r) => { prune(r); return Math.abs(r.total) > 0.004 || r.children.length; });
}

const round2 = (n) => +(Number(n) || 0).toFixed(2);

// ---------- Estado de Resultados ----------
exports.incomeStatement = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    // Tasas configurables (sociedades EC: 15% trabajadores, 25% IR por defecto).
    const profitSharingRate = req.query.profitSharingRate !== undefined ? Number(req.query.profitSharingRate) : 0.15;
    const incomeTaxRate = req.query.incomeTaxRate !== undefined ? Number(req.query.incomeTaxRate) : 0.25;

    /**
     * DESGLOSE EN COLUMNAS. `none` (por defecto) = el reporte de siempre, una sola
     * cifra por cuenta. `month` saca una columna por mes del rango; `costCenter`, una
     * por centro de costo (más "Sin centro de costos"); `clinic`, una por sede.
     */
    const mode = ['month', 'costCenter', 'clinic'].includes(req.query.breakdown) ? req.query.breakdown : 'none';
    // Solo el desglose por sede sale de la sede activa: el resto se queda en ella.
    const clinicIds = mode === 'clinic' ? await readableClinicIds(req) : null;

    const balances = await getAccountBalances(req.clinicId, { startDate, endDate, mode, clinicIds });
    const columns = mode === 'none'
      ? []
      : await resolveBreakdownColumns(mode, { clinicIds: clinicIds || [asObjectId(req.clinicId)], startDate, endDate, usados: balances.usados });

    const ingresos = balances.filter((a) => a.type === 'INGRESO' && a.allowsMovement);
    const costos = balances.filter((a) => a.type === 'COSTO' && a.allowsMovement);
    const gastos = balances.filter((a) => a.type === 'GASTO' && a.allowsMovement);
    const totalIngresos = round2(ingresos.reduce((s, a) => s + a.balance, 0));
    const totalCostos = round2(costos.reduce((s, a) => s + a.balance, 0));
    const totalGastos = round2(gastos.reduce((s, a) => s + a.balance, 0));
    const utilidadBruta = round2(totalIngresos - totalCostos);
    const utilidadOperacional = round2(utilidadBruta - totalGastos);

    // Los mismos totales, pero columna a columna: es lo que permite leer el reporte
    // como en la hoja del contador (una fila de utilidad y su % debajo, por mes o
    // por centro de costo).
    const sumaCol = (lista, key) => round2(lista.reduce((s, a) => s + (a.byColumn?.[key] || 0), 0));
    const porColumna = {};
    for (const c of columns) {
      const ing = sumaCol(ingresos, c.key);
      const cos = sumaCol(costos, c.key);
      const gas = sumaCol(gastos, c.key);
      const bruta = round2(ing - cos);
      const operacional = round2(bruta - gas);
      porColumna[c.key] = {
        totalIngresos: ing,
        totalCostos: cos,
        totalGastos: gas,
        utilidadBruta: bruta,
        utilidadOperacional: operacional,
        // Margen sobre las ventas de ESA columna (lo que el contador escribe debajo).
        margen: ing ? round2((operacional / ing) * 100) : 0,
      };
    }

    // Cascada tributaria (estimada) según normativa ecuatoriana.
    const utilidadAntesParticipacion = utilidadOperacional;
    const participacionTrabajadores = round2(Math.max(0, utilidadAntesParticipacion) * profitSharingRate);
    const utilidadAntesImpuesto = round2(utilidadAntesParticipacion - participacionTrabajadores);
    const impuestoRenta = round2(Math.max(0, utilidadAntesImpuesto) * incomeTaxRate);
    const utilidadNeta = round2(utilidadAntesImpuesto - impuestoRenta);

    res.json({
      // Desglose en columnas (vacío = reporte de una sola cifra, como siempre).
      breakdown: mode,
      columns,
      porColumna,
      // Árbol jerárquico (cuentas agrupadoras con subtotales) para presentación.
      tree: buildAccountTree(balances, ['INGRESO', 'COSTO', 'GASTO']),
      // Listas planas (compatibilidad).
      ingresos, costos, gastos,
      totalIngresos, totalCostos, totalGastos,
      utilidadBruta, utilidadOperacional,
      margen: totalIngresos ? round2((utilidadOperacional / totalIngresos) * 100) : 0,
      // Cascada tributaria estimada.
      profitSharingRate, incomeTaxRate,
      utilidadAntesParticipacion, participacionTrabajadores, utilidadAntesImpuesto, impuestoRenta,
      utilidadNeta,
      totales: { totalIngresos, totalCostos, totalGastos, utilidadBruta, utilidadOperacional, utilidadNeta },
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ---------- Balance General (Estado de Situación Financiera) ----------
exports.balanceSheet = async (req, res) => {
  try {
    const { date } = req.query;
    /**
     * El balance admite desglose por CENTRO DE COSTO y por SEDE. Por MES no: un balance
     * es una foto a una fecha, no un acumulado del período, y una columna por mes daría
     * una cifra que no significa nada.
     */
    const mode = ['costCenter', 'clinic'].includes(req.query.breakdown) ? req.query.breakdown : 'none';
    const clinicIds = mode === 'clinic' ? await readableClinicIds(req) : null;
    const balances = await getAccountBalances(req.clinicId, { endDate: date, mode, clinicIds });
    const columns = mode === 'none'
      ? []
      : await resolveBreakdownColumns(mode, { clinicIds: clinicIds || [asObjectId(req.clinicId)], endDate: date, usados: balances.usados });
    const activos = balances.filter((a) => a.type === 'ACTIVO' && a.allowsMovement);
    const pasivos = balances.filter((a) => a.type === 'PASIVO' && a.allowsMovement);
    const patrimonio = balances.filter((a) => a.type === 'PATRIMONIO' && a.allowsMovement);
    const ingresos = balances.filter((a) => a.type === 'INGRESO');
    const gastos = balances.filter((a) => a.type === 'GASTO' || a.type === 'COSTO');
    const totalActivos = round2(activos.reduce((s, a) => s + a.balance, 0));
    const totalPasivos = round2(pasivos.reduce((s, a) => s + a.balance, 0));
    const utilidad = round2(ingresos.reduce((s, a) => s + a.balance, 0) - gastos.reduce((s, a) => s + a.balance, 0));
    const totalPatrimonio = round2(patrimonio.reduce((s, a) => s + a.balance, 0) + utilidad);
    res.json({
      breakdown: mode,
      columns,
      tree: {
        activos: buildAccountTree(balances, ['ACTIVO']),
        pasivos: buildAccountTree(balances, ['PASIVO']),
        patrimonio: buildAccountTree(balances, ['PATRIMONIO']),
      },
      // Listas planas (compatibilidad).
      activos, pasivos, patrimonio,
      utilidadEjercicio: utilidad,
      totalActivos, totalPasivos, totalPatrimonio,
      totalPasivoPatrimonio: round2(totalPasivos + totalPatrimonio),
      // Descuadre = Activo − (Pasivo + Patrimonio). Debe ser 0.
      descuadre: round2(totalActivos - (totalPasivos + totalPatrimonio)),
      totales: { totalActivos, totalPasivos, totalPatrimonio, totalPasivoPatrimonio: round2(totalPasivos + totalPatrimonio) },
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/**
 * Proyección de liquidez para el flujo de caja: con el efectivo disponible HOY
 * (caja + bancos, sin tope de fecha) más los ingresos esperados (CxC abiertas),
 * ¿alcanza para cubrir las cuentas por pagar (CxP abiertas)?
 * Los documentos se clasifican en vencidos / por vencer contra la fecha actual.
 */
async function buildLiquidityProjection(clinicId) {
  const asOf = new Date();
  const cashAccs = await ChartOfAccount.find({ clinic: clinicId, code: /^1\.1\.01\./ }).lean();
  const ids = cashAccs.map((a) => a._id);
  let disponible = 0;
  if (ids.length) {
    const agg = await JournalEntry.aggregate([
      { $match: { clinic: asObjectId(clinicId), status: 'CONTABILIZADO', 'lines.account': { $in: ids } } },
      { $unwind: '$lines' },
      { $match: { 'lines.account': { $in: ids } } },
      { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
    ]);
    disponible = round2((agg[0]?.debit || 0) - (agg[0]?.credit || 0));
  }

  const openFilter = { clinic: clinicId, status: { $in: ['ABIERTO', 'PARCIAL'] } };
  const [receivables, payables] = await Promise.all([
    Receivable.find(openFilter).sort({ dueDate: 1, issueDate: 1 }).lean(),
    Payable.find(openFilter).sort({ dueDate: 1, issueDate: 1 }).lean(),
  ]);

  const summarize = (docs) => {
    const out = { total: 0, vencido: 0, porVencer: 0, count: docs.length, docs: [] };
    for (const d of docs) {
      const bal = round2(d.balance);
      const base = d.dueDate || d.issueDate;
      // Días vencidos (positivo = ya venció; negativo = faltan días para vencer).
      const dias = Math.floor((asOf - new Date(base)) / 86400000);
      // Fecha EFECTIVA de cobro/pago: manda la fecha planificada si existe, y si esa base
      // cae en domingo el dinero se mueve el lunes. El `dueDate` legal NO se toca.
      const { effectiveDate, shifted } = effectivePaymentDate(d);
      out.total = round2(out.total + bal);
      if (dias > 0) out.vencido = round2(out.vencido + bal);
      else out.porVencer = round2(out.porVencer + bal);
      if (out.docs.length < 200) {
        out.docs.push({
          id: d._id,
          party: d.party?.name || '—',
          docType: d.docType,
          number: d.number,
          issueDate: d.issueDate,
          dueDate: d.dueDate,
          plannedPaymentDate: d.plannedPaymentDate || null,
          fechaEfectiva: effectiveDate,
          desplazadaAHabil: shifted,
          balance: bal,
          dias,
        });
      }
    }
    return out;
  };

  const cxc = summarize(receivables);
  const cxp = summarize(payables);
  const saldoProyectado = round2(disponible + cxc.total - cxp.total);
  return {
    asOf,
    disponible,
    cxc,
    cxp,
    saldoProyectado,
    // Alertas de liquidez para la UI/Excel.
    alertas: {
      deficitProyectado: saldoProyectado < 0,
      vencidasSuperanDisponible: cxp.vencido > disponible,
    },
  };
}

// ---------- Flujo de Caja (cuentas de efectivo y banco + proyección de liquidez) ----------
exports.cashFlow = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const start = startOfDay(startDate);
    const end = endOfDay(endDate);
    const cashAccs = await ChartOfAccount.find({ clinic: req.clinicId, code: /^1\.1\.01\./ }).lean();
    const ids = cashAccs.map((a) => a._id);
    const accountMap = new Map(cashAccs.map((a) => [String(a._id), {
      ...compactAccount(a), opening: 0, debit: 0, credit: 0, closing: 0, balance: 0,
    }]));
    if (!ids.length) {
      const proyeccion = await buildLiquidityProjection(req.clinicId);
      return res.json({ flows: [], accounts: [], opening: 0, totalIn: 0, totalOut: 0, saldoFinal: 0, proyeccion });
    }

    if (start) {
      const openingAgg = await JournalEntry.aggregate([
        { $match: { clinic: asObjectId(req.clinicId), status: 'CONTABILIZADO', date: { $lt: start }, 'lines.account': { $in: ids } } },
        { $unwind: '$lines' },
        { $match: { 'lines.account': { $in: ids } } },
        { $group: { _id: '$lines.account', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
      ]);
      for (const r of openingAgg) {
        const acc = accountMap.get(String(r._id));
        if (!acc) continue;
        acc.opening = (r.debit || 0) - (r.credit || 0);
        acc.closing = acc.opening;
        acc.balance = acc.closing;
      }
    }

    const match = { clinic: req.clinicId, status: 'CONTABILIZADO', 'lines.account': { $in: ids } };
    if (startDate || endDate) {
      match.date = {};
      if (start) match.date.$gte = start;
      if (end) match.date.$lte = end;
    }
    const entries = await JournalEntry.find(match).sort({ date: 1, number: 1 }).lean();
    const flows = [];
    let saldo = [...accountMap.values()].reduce((s, a) => s + (a.opening || 0), 0);
    for (const e of entries) {
      for (const l of e.lines) {
        const acc = accountMap.get(String(l.account));
        if (!acc) continue;
        const movement = l.debit - l.credit;
        saldo += movement;
        acc.debit += Number(l.debit) || 0;
        acc.credit += Number(l.credit) || 0;
        acc.closing += movement;
        acc.balance = acc.closing;
        flows.push({
          entryId: e._id,
          date: e.date,
          number: e.number,
          description: l.description || e.description,
          entryDescription: e.description,
          accountId: l.account,
          accountCode: l.accountCode,
          accountName: l.accountName,
          source: e.source,
          sourceModel: e.sourceModel,
          sourceRef: e.sourceRef,
          in: Number(l.debit) || 0,
          out: Number(l.credit) || 0,
          saldo,
        });
      }
    }
    const accounts = [...accountMap.values()].sort((a, b) => a.code.localeCompare(b.code));
    const proyeccion = await buildLiquidityProjection(req.clinicId);
    res.json({
      flows,
      accounts,
      opening: accounts.reduce((s, a) => s + (a.opening || 0), 0),
      totalIn: flows.reduce((s, f) => s + f.in, 0),
      totalOut: flows.reduce((s, f) => s + f.out, 0),
      saldoFinal: saldo,
      proyeccion,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ---------- Trazabilidad de una cuenta (mayor + diario + contrapartidas) ----------
exports.accountFlow = async (req, res) => {
  try {
    const accountId = req.params.accountId || req.query.account;
    if (!accountId || !mongoose.Types.ObjectId.isValid(accountId)) {
      return res.status(400).json({ message: 'Cuenta requerida' });
    }

    const account = await ChartOfAccount.findOne({ _id: accountId, clinic: req.clinicId }).lean();
    if (!account) return res.status(404).json({ message: 'Cuenta no encontrada' });

    const { startDate, endDate } = req.query;
    const start = startOfDay(startDate);
    const end = endOfDay(endDate);
    const accountObjId = asObjectId(account._id);
    const clinicObjId = asObjectId(req.clinicId);

    let opening = 0;
    if (start) {
      const openingAgg = await JournalEntry.aggregate([
        { $match: { clinic: clinicObjId, status: 'CONTABILIZADO', date: { $lt: start }, 'lines.account': accountObjId } },
        { $unwind: '$lines' },
        { $match: { 'lines.account': accountObjId } },
        { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
      ]);
      opening = accountBalanceFromNature(account, openingAgg[0]?.debit || 0, openingAgg[0]?.credit || 0);
    }

    const match = { clinic: req.clinicId, status: 'CONTABILIZADO', 'lines.account': account._id };
    if (start || end) {
      match.date = {};
      if (start) match.date.$gte = start;
      if (end) match.date.$lte = end;
    }

    const entries = await JournalEntry.find(match).sort({ date: 1, number: 1 }).lean();
    const ledger = [];
    const journal = [];
    const counterpartMap = new Map();
    let saldo = opening;
    let debit = 0;
    let credit = 0;

    for (const entry of entries) {
      const lines = (entry.lines || []).map((line) => {
        const base = lineAccount(line);
        return { ...base, accountId: String(base.accountId || ''), isSelected: String(base.accountId) === String(account._id) };
      });
      journal.push({
        _id: entry._id,
        number: entry.number,
        date: entry.date,
        description: entry.description,
        source: entry.source,
        sourceModel: entry.sourceModel,
        sourceRef: entry.sourceRef,
        totalDebit: entry.totalDebit,
        totalCredit: entry.totalCredit,
        lines,
      });

      const selectedLines = lines.filter((line) => line.isSelected);
      for (const selected of selectedLines) {
        const counterparts = lines.filter((line) => !line.isSelected);
        const selectedDebit = Number(selected.debit) || 0;
        const selectedCredit = Number(selected.credit) || 0;
        debit += selectedDebit;
        credit += selectedCredit;
        saldo += account.nature === 'DEBITO' ? selectedDebit - selectedCredit : selectedCredit - selectedDebit;

        for (const cp of counterparts) {
          const key = cp.accountId || `${cp.accountCode}-${cp.accountName}`;
          if (!counterpartMap.has(key)) {
            counterpartMap.set(key, {
              accountId: cp.accountId,
              accountCode: cp.accountCode,
              accountName: cp.accountName,
              debit: 0,
              credit: 0,
              count: 0,
            });
          }
          const row = counterpartMap.get(key);
          row.debit += Number(cp.debit) || 0;
          row.credit += Number(cp.credit) || 0;
          row.count += 1;
        }

        ledger.push({
          entryId: entry._id,
          date: entry.date,
          number: entry.number,
          source: entry.source,
          sourceModel: entry.sourceModel,
          sourceRef: entry.sourceRef,
          description: selected.description || entry.description,
          entryDescription: entry.description,
          debit: selectedDebit,
          credit: selectedCredit,
          saldo,
          counterparts,
        });
      }
    }

    const closing = opening + accountBalanceFromNature(account, debit, credit);
    res.json({
      account: compactAccount(account),
      period: { startDate: startDate || null, endDate: endDate || null },
      summary: {
        opening,
        debit,
        credit,
        movement: accountBalanceFromNature(account, debit, credit),
        closing,
        entries: journal.length,
        movements: ledger.length,
        firstMovement: ledger[0]?.date || null,
        lastMovement: ledger[ledger.length - 1]?.date || null,
      },
      ledger,
      journal,
      counterpartSummary: [...counterpartMap.values()].sort((a, b) => (Math.abs(b.debit - b.credit) - Math.abs(a.debit - a.credit))),
      relatedReports: relatedReportsForAccount(account),
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ---------- Ventas: resumen, por producto, por cajero, semanal ----------
exports.salesSummary = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const match = { clinic: oid(req.clinicId), status: 'completada' };
    if (startDate || endDate) {
      match.createdAt = {};
      if (startDate) match.createdAt.$gte = new Date(startDate);
      if (endDate) match.createdAt.$lte = endOfDay(endDate);
    }
    const total = await Sale.aggregate([
      { $match: match },
      { $group: { _id: null, count: { $sum: 1 }, subtotal: { $sum: '$subtotal' }, taxAmount: { $sum: '$taxAmount' }, total: { $sum: '$total' } } },
    ]);
    res.json(total[0] || { count: 0, subtotal: 0, taxAmount: 0, total: 0 });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.salesByProduct = async (req, res) => {
  const { startDate, endDate } = req.query;
  const match = { clinic: oid(req.clinicId), status: 'completada' };
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) match.createdAt.$lte = endOfDay(endDate);
  }
  const rows = await Sale.aggregate([
    { $match: match }, { $unwind: '$items' },
    // El código va como `$first` y NO dentro del _id: metido en la clave partiría en dos
    // filas el mismo producto si alguna venta antigua guardó otro código.
    { $group: { _id: { product: '$items.product', name: '$items.productName' },
                code: { $first: '$items.productCode' },
                qty: { $sum: '$items.quantity' }, subtotal: { $sum: '$items.subtotal' } } },
    { $sort: { subtotal: -1 } },
  ]);
  res.json(rows);
};

exports.salesByCashier = async (req, res) => {
  const { startDate, endDate } = req.query;
  const match = { clinic: oid(req.clinicId), status: 'completada' };
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) match.createdAt.$lte = endOfDay(endDate);
  }
  const rows = await Sale.aggregate([
    { $match: match },
    { $group: { _id: '$cashier', count: { $sum: 1 }, total: { $sum: '$total' } } },
    { $sort: { total: -1 } },
  ]);
  await Sale.populate(rows, { path: '_id', model: 'User', select: 'name email' });
  res.json(rows);
};

exports.salesWeekly = async (req, res) => {
  const { year } = req.query;
  const y = parseInt(year) || new Date().getFullYear();
  const start = new Date(y, 0, 1);
  const end = new Date(y, 11, 31, 23, 59, 59);
  const rows = await Sale.aggregate([
    { $match: { clinic: oid(req.clinicId), status: 'completada', createdAt: { $gte: start, $lte: end } } },
    { $group: { _id: { week: { $isoWeek: '$createdAt' }, year: { $isoWeekYear: '$createdAt' } }, count: { $sum: 1 }, total: { $sum: '$total' } } },
    { $sort: { '_id.year': 1, '_id.week': 1 } },
  ]);
  res.json(rows);
};

/** Ventas agrupadas por período (granularity: day/week/month/quarter/year). */
exports.salesByPeriod = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const clinicObjId = new mongoose.Types.ObjectId(req.clinicId);
    const granularity = req.query.granularity || 'month';
    const match = { clinic: clinicObjId, status: 'completada', ...dateMatch(req) };
    let groupId;
    if (granularity === 'quarter') {
      groupId = { $concat: [{ $dateToString: { format: '%Y', date: '$createdAt' } }, '-T', { $toString: { $ceil: { $divide: [{ $month: '$createdAt' }, 3] } } }] };
    } else {
      groupId = { $dateToString: { format: periodFormat(granularity), date: '$createdAt' } };
    }
    const rows = await Sale.aggregate([
      { $match: match },
      { $group: { _id: groupId, count: { $sum: 1 }, subtotal: { $sum: '$subtotal' }, tax: { $sum: '$taxAmount' }, total: { $sum: '$total' } } },
      { $sort: { _id: 1 } },
    ]);
    res.json(rows);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/** Ventas por vendedor (createdBy). */
exports.salesBySeller = async (req, res) => {
  try {
    const match = { clinic: oid(req.clinicId), status: 'completada', ...dateMatch(req) };
    const rows = await Sale.aggregate([
      { $match: match },
      { $group: { _id: '$createdBy', count: { $sum: 1 }, total: { $sum: '$total' } } },
      { $sort: { total: -1 } },
    ]);
    await Sale.populate(rows, { path: '_id', model: 'User', select: 'name email' });
    res.json(rows);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/** Costo de venta por categoría de producto. */
exports.costOfSalesByCategory = async (req, res) => {
  try {
    const match = { clinic: oid(req.clinicId), status: 'completada', ...dateMatch(req) };
    const sales = await Sale.find(match).populate('items.product', 'purchasePrice averageCost category');
    const byCat = {};
    for (const s of sales) {
      for (const it of s.items) {
        const cat = it.product?.category || it.category || 'otro';
        // MISMO costo unitario que «Costo de venta»: el promedio del kardex, que es el costo
        // real de las compras. Antes aquí solo se miraba `purchasePrice` (un precio digitado
        // que ya no se captura), así que los dos reportes daban costos distintos para las
        // mismas ventas y el detalle de una fila no podía cuadrar con su total.
        const unitCost = Number(it.product?.averageCost) || Number(it.product?.purchasePrice) || 0;
        const cost = unitCost * it.quantity;
        if (!byCat[cat]) byCat[cat] = { category: cat, revenue: 0, cost: 0, qty: 0 };
        byCat[cat].revenue += it.subtotal || 0;
        byCat[cat].cost += cost;
        byCat[cat].qty += it.quantity;
      }
    }
    const rows = Object.values(byCat).map((r) => ({ ...r, grossProfit: +(r.revenue - r.cost).toFixed(2), margin: r.revenue > 0 ? +(((r.revenue - r.cost) / r.revenue) * 100).toFixed(2) : 0 }));
    res.json({ rows, totals: rows.reduce((a, r) => ({ revenue: a.revenue + r.revenue, cost: a.cost + r.cost, grossProfit: a.grossProfit + r.grossProfit }), { revenue: 0, cost: 0, grossProfit: 0 }) });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/**
 * COSTO DE VENTA — no basta con los tres totales: el gerente necesita ver QUÉ se
 * vendió. Devuelve una fila por línea vendida con el producto, la cantidad, el
 * precio de venta, el costo, la utilidad y LA FACTURA ASOCIADA (para poder abrirla).
 *
 * El costo unitario sale del promedio del kardex (`averageCost`), que es el costo
 * real de las compras; `purchasePrice` solo queda de respaldo para productos que
 * nunca tuvieron movimiento.
 */
exports.costOfSales = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const match = { clinic: oid(req.clinicId), status: 'completada' };
    if (startDate || endDate) {
      match.createdAt = {};
      if (startDate) match.createdAt.$gte = new Date(startDate);
      if (endDate) match.createdAt.$lte = endOfDay(endDate);
    }
    const sales = await Sale.find(match)
      .populate('items.product', 'purchasePrice averageCost code')
      .sort({ createdAt: -1 })
      .lean();

    // Factura de cada venta: es lo que el usuario quiere poder abrir desde el reporte.
    const facturas = await Invoice.find({ clinic: req.clinicId, sale: { $in: sales.map((s) => s._id) } })
      .select('sale estab ptoEmi secuencial estado')
      .lean();
    const facturaPorVenta = new Map(facturas.map((f) => [String(f.sale), f]));

    const rows = [];
    let cost = 0;
    for (const s of sales) {
      const inv = facturaPorVenta.get(String(s._id));
      for (const it of s.items || []) {
        const unitCost = Number(it.product?.averageCost) || Number(it.product?.purchasePrice) || 0;
        const lineCost = unitCost * (it.quantity || 0);
        cost += lineCost;
        rows.push({
          saleId: s._id,
          venta: s.saleNumber,
          fecha: s.createdAt,
          cliente: s.clientName || 'CONSUMIDOR FINAL',
          invoiceId: inv?._id || null,
          factura: numeroFactura(inv),
          producto: it.productName,
          codigo: it.productCode || it.product?.code || '',
          cantidad: it.quantity || 0,
          precioVenta: it.unitPrice || 0,
          ingreso: it.subtotal || 0,
          costoUnitario: unitCost,
          costo: +lineCost.toFixed(2),
          utilidad: +((it.subtotal || 0) - lineCost).toFixed(2),
        });
      }
    }
    const totalSales = sales.reduce((s, v) => s + (v.total || 0), 0);
    res.json({
      totalSales,
      totalCost: +cost.toFixed(2),
      grossProfit: +(totalSales - cost).toFixed(2),
      rows,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/**
 * DETALLE (drill-down) DE UNA FILA DE LOS REPORTES DE VENTAS.
 *
 * Los sub-reportes de ventas son totales agrupados ("producto X: $1.240"). La pregunta
 * que viene después es SIEMPRE la misma —"¿de qué ventas salió eso?"— y hasta ahora
 * había que salir a Ventas a buscarlas a mano. Aquí se devuelven las ventas (o las
 * líneas) que componen UNA fila, cada una con su venta y su factura, para que desde la
 * pantalla se abra el documento y, desde el documento, su asiento.
 *
 * `dimension` dice qué reporte se está abriendo y `key` qué fila:
 *   period   → el período tal como lo agrupó el reporte (se reutiliza la MISMA expresión
 *              de agrupación, así el detalle no puede discrepar del total por el huso)
 *   product  → id del producto (fila por LÍNEA; `name` afina cuando el reporte separó
 *              dos filas con el mismo producto y distinto nombre histórico)
 *   category → categoría del producto (fila por LÍNEA)
 *   seller   → Sale.createdBy  ('' = sin asignar)
 *   cashier  → Sale.cashier    ('' = sin asignar)
 */
const DRILL_DIMENSIONS = ['period', 'product', 'category', 'seller', 'cashier'];
const DRILL_TITLES = {
  period: 'Ventas por período',
  product: 'Ventas por producto',
  category: 'Costo por categoría',
  seller: 'Ventas por vendedor',
  cashier: 'Ventas por cajero',
};

exports.salesDrilldown = async (req, res) => {
  try {
    const dimension = String(req.query.dimension || '');
    if (!DRILL_DIMENSIONS.includes(dimension)) {
      return res.status(400).json({ message: 'Esta fila no tiene detalle de ventas.' });
    }
    const key = req.query.key == null ? '' : String(req.query.key);
    const match = { clinic: oid(req.clinicId), status: 'completada', ...dateMatch(req) };

    // Vendedor / cajero: el reporte agrupa por ese campo, así que se filtra en el match.
    if (dimension === 'seller') match.createdBy = key ? asObjectId(key) : null;
    if (dimension === 'cashier') match.cashier = key ? asObjectId(key) : null;

    if (dimension === 'period') {
      const granularity = req.query.granularity || 'month';
      const groupId = granularity === 'quarter'
        ? { $concat: [{ $dateToString: { format: '%Y', date: '$createdAt' } }, '-T', { $toString: { $ceil: { $divide: [{ $month: '$createdAt' }, 3] } } }] }
        : { $dateToString: { format: periodFormat(granularity), date: '$createdAt' } };
      const ids = await Sale.aggregate([
        { $match: match },
        { $addFields: { __periodo: groupId } },
        { $match: { __periodo: key } },
        { $project: { _id: 1 } },
      ]);
      match._id = { $in: ids.map((r) => r._id) };
    }

    const sales = await Sale.find(match)
      .populate('items.product', 'code category averageCost purchasePrice')
      .populate('createdBy', 'name')
      .populate('cashier', 'name')
      .sort({ createdAt: -1 })
      .lean();

    // La factura de cada venta: es el documento que el contador quiere abrir.
    const facturas = await Invoice.find({ clinic: req.clinicId, sale: { $in: sales.map((s) => s._id) } })
      .select('sale estab ptoEmi secuencial estado').lean();
    const facturaPorVenta = new Map(facturas.map((f) => [String(f.sale), f]));

    // Producto y categoría se detallan a nivel de LÍNEA: la fila del reporte suma
    // líneas, no ventas completas (una venta trae varios productos).
    const porLinea = dimension === 'product' || dimension === 'category';
    const nombreFiltro = dimension === 'product' ? String(req.query.name || '') : '';
    const categoriaDe = (it) => it.product?.category || it.category || 'otro';

    const rows = [];
    for (const s of sales) {
      const inv = facturaPorVenta.get(String(s._id));
      const base = {
        saleId: s._id,
        venta: s.saleNumber,
        fecha: s.createdAt,
        cliente: s.clientName || 'CONSUMIDOR FINAL',
        identificacion: s.clientCedula || '',
        vendedor: s.createdBy?.name || 'Sin asignar',
        cajero: s.cashier?.name || 'Sin asignar',
        invoiceId: inv?._id || null,
        factura: numeroFactura(inv),
        estadoSri: inv?.estado || '',
        estado: s.status,
      };
      if (!porLinea) {
        rows.push({
          ...base,
          cantidad: (s.items || []).reduce((n, it) => n + (it.quantity || 0), 0),
          subtotal: +(s.subtotal || 0).toFixed(2),
          iva: +(s.taxAmount || 0).toFixed(2),
          descuento: +(s.discountTotal || 0).toFixed(2),
          total: +(s.total || 0).toFixed(2),
        });
        continue;
      }
      for (const it of s.items || []) {
        const coincide = dimension === 'product'
          ? String(it.product?._id || it.product || '') === key && (!nombreFiltro || it.productName === nombreFiltro)
          : categoriaDe(it) === key;
        if (!coincide) continue;
        const costoUnitario = Number(it.product?.averageCost) || Number(it.product?.purchasePrice) || 0;
        const costo = +(costoUnitario * (it.quantity || 0)).toFixed(2);
        const subtotal = +(it.subtotal || 0).toFixed(2);
        const iva = +(it.taxAmount || 0).toFixed(2);
        rows.push({
          ...base,
          producto: it.productName,
          codigo: it.productCode || it.product?.code || '',
          cantidad: it.quantity || 0,
          precioUnitario: +(it.unitPrice || 0).toFixed(2),
          descuento: +(it.discount || 0).toFixed(2),
          subtotal,
          iva,
          total: +(it.lineTotal || subtotal + iva).toFixed(2),
          costo,
          utilidad: +(subtotal - costo).toFixed(2),
        });
      }
    }

    const suma = (k) => +rows.reduce((s, r) => s + (Number(r[k]) || 0), 0).toFixed(2);
    res.json({
      dimension,
      key,
      level: porLinea ? 'line' : 'sale',
      label: req.query.label || key || 'Sin asignar',
      rows,
      totals: {
        ventas: new Set(rows.map((r) => String(r.saleId))).size,
        lineas: rows.length,
        cantidad: suma('cantidad'),
        subtotal: suma('subtotal'),
        iva: suma('iva'),
        descuento: suma('descuento'),
        total: suma('total'),
        ...(porLinea ? { costo: suma('costo'), utilidad: suma('utilidad') } : {}),
      },
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ---------- Gestión ----------
/**
 * GASTOS NO DEDUCIBLES — una fila por movimiento, con su documento y proveedor,
 * y además el resumen por cuenta. Antes solo devolvía el saldo de cada cuenta, que
 * no sirve para justificar nada ante el SRI.
 */
exports.nonDeductibleExpenses = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const accs = await ChartOfAccount.find({
      clinic: req.clinicId,
      $or: [{ code: /^6\.3\./ }, { name: /no deducible/i }],
    }).lean();
    if (!accs.length) return res.json({ rows: [], byAccount: [], total: 0 });
    const ids = accs.map((a) => a._id);
    const porId = new Map(accs.map((a) => [String(a._id), a]));

    const match = { clinic: req.clinicId, status: 'CONTABILIZADO', 'lines.account': { $in: ids } };
    if (startDate || endDate) {
      match.date = {};
      if (startDate) match.date.$gte = startOfDay(startDate);
      if (endDate) match.date.$lte = endOfDay(endDate);
    }
    const entries = await JournalEntry.find(match).sort({ date: -1, number: -1 }).lean();

    // Proveedor / documento del gasto (la factura de compra es lo habitual).
    const compraIds = entries.filter((e) => e.sourceModel === 'PurchaseInvoice').map((e) => e.sourceRef);
    const compras = compraIds.length
      ? await PurchaseInvoice.find({ _id: { $in: compraIds } }).select('supplierName numeroFactura').lean()
      : [];
    const porCompra = new Map(compras.map((c) => [String(c._id), c]));

    const rows = [];
    for (const e of entries) {
      for (const l of e.lines || []) {
        const acc = porId.get(String(l.account));
        if (!acc) continue;
        const monto = (l.debit || 0) - (l.credit || 0);
        if (!monto) continue;
        const compra = porCompra.get(String(e.sourceRef));
        rows.push({
          date: e.date,
          asiento: e.number,
          cuenta: { code: acc.code, name: acc.name },
          concepto: l.description || e.description || '',
          proveedor: compra?.supplierName || '',
          documento: compra?.numeroFactura || '',
          monto: +monto.toFixed(2),
          sourceModel: e.sourceModel || null,
          sourceRef: e.sourceRef || null,
          entryId: e._id,
        });
      }
    }
    const byAccountMap = new Map();
    for (const r of rows) {
      const k = r.cuenta.code;
      const prev = byAccountMap.get(k) || { code: r.cuenta.code, name: r.cuenta.name, amount: 0, count: 0 };
      byAccountMap.set(k, { ...prev, amount: +(prev.amount + r.monto).toFixed(2), count: prev.count + 1 });
    }
    res.json({
      rows,
      byAccount: [...byAccountMap.values()].sort((a, b) => b.amount - a.amount),
      total: +rows.reduce((s, r) => s + r.monto, 0).toFixed(2),
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// Cartera por edad: separa documentos vencidos por rangos
function bucket(days) {
  if (days <= 0) return 'POR_VENCER';
  if (days <= 30) return 'VENCIDO_30';
  if (days <= 60) return 'VENCIDO_60';
  if (days <= 90) return 'VENCIDO_90';
  if (days <= 120) return 'VENCIDO_120';
  return 'VENCIDO_MAS_120';
}

/**
 * Antigüedad de cartera por cobrar.
 *
 * Una venta a crédito que además se facturó es UNA obligación económica con DOS documentos (y,
 * en la cartera migrada, hasta con dos CxC). Se resuelve con el servicio COMPARTIDO —el mismo
 * que usa el motor del flujo de caja—, así que el saldo que sale aquí es exactamente el que
 * proyecta el flujo, aparece una sola vez y lleva los vínculos a la venta y a la factura.
 * Los casos que no concilian no se ocultan: se muestran con su advertencia.
 */
exports.accountsReceivableAging = async (req, res) => {
  try {
    const today = new Date();
    const obl = await resolveReceivableEconomicObligations({ clinicId: req.clinicId });

    // Aplica a facturas de venta autorizadas con saldo pendiente (saldo = total - cobros aplicados)
    const invoices = await Invoice.find({ clinic: req.clinicId, estado: 'AUTORIZADO' });
    const paymentApps = await Payment.aggregate([
      { $match: { clinic: oid(req.clinicId), type: 'COBRO', status: 'REGISTRADO' } },
      { $unwind: '$applications' },
      { $match: { 'applications.docModel': 'Invoice' } },
      { $group: { _id: '$applications.docRef', paid: { $sum: '$applications.amount' } } },
    ]);
    const paidMap = new Map(paymentApps.map((p) => [String(p._id), p.paid]));
    const rows = [];
    for (const inv of invoices) {
      // Enlazada a una venta: la obligación se emite UNA vez, más abajo, con el saldo económico.
      if (obl.byInvoice.has(String(inv._id))) continue;
      const paid = paidMap.get(String(inv._id)) || 0;
      const balance = (inv.importeTotal || inv.total || 0) - paid;
      if (balance <= 0.01) continue;
      const emitido = new Date(inv.fechaEmision.split('/').reverse().join('-'));
      const days = Math.floor((today - emitido) / (1000 * 60 * 60 * 24)) - 30; // crédito 30 días por defecto
      const dueDate = new Date(emitido.getTime() + 30 * 86400000);
      rows.push({
        docId: inv._id, type: 'Factura', number: `${inv.estab}-${inv.ptoEmi}-${inv.secuencial}`,
        client: inv.razonSocialComprador, date: inv.fechaEmision, dueDate,
        description: inv.notes || '', retentions: 0,
        total: inv.importeTotal || inv.total, paid, balance, days,
        bucket: bucket(days),
      });
    }
    // Ventas con saldo pendiente (CxC directa, sin factura electrónica): crédito total
    // o la parte a crédito de un pago dividido — cualquier venta con balance > 0.
    const creditSales = await Sale.find({ clinic: req.clinicId, status: 'completada', balance: { $gt: 0.01 } });
    for (const s of creditSales) {
      if (obl.bySale.has(String(s._id))) continue;   // ídem: se emite como obligación única
      const emitido = new Date(s.createdAt);
      const dueDate = s.dueDate ? new Date(s.dueDate) : new Date(emitido.getTime() + 30 * 86400000);
      const days = Math.floor((today - dueDate) / 86400000);
      rows.push({
        docId: s._id, type: 'Venta crédito', number: s.saleNumber,
        client: s.clientName, date: emitido.toLocaleDateString('es-EC'), dueDate,
        description: s.notes || '', retentions: 0,
        total: s.total, paid: +(s.total - s.balance).toFixed(2), balance: s.balance, days,
        bucket: bucket(days),
      });
    }

    // ── Obligaciones venta+factura: UNA fila por obligación económica ────────────────────
    const invIds = obl.obligations.map((o) => o.factura.id);
    const invPares = invIds.length
      ? await Invoice.find({ clinic: req.clinicId, _id: { $in: invIds } })
        .select('estab ptoEmi secuencial razonSocialComprador').lean()
      : [];
    const invById = new Map(invPares.map((i) => [String(i._id), i]));
    for (const o of obl.obligations) {
      if (o.balance <= 0.01) continue;   // ya cobrada: no es cartera
      const iv = invById.get(o.factura.id);
      const numFactura = iv ? `${iv.estab}-${iv.ptoEmi}-${iv.secuencial}` : '';
      const emitido = o.issueDate ? new Date(o.issueDate) : today;
      const dueDate = o.dueDate ? new Date(o.dueDate) : new Date(emitido.getTime() + 30 * 86400000);
      const days = Math.floor((today - dueDate) / 86400000);
      rows.push({
        docId: o.canonical.sourceRef,
        type: 'Venta + Factura',
        number: [o.venta.numero, numFactura].filter(Boolean).join(' · '),
        client: o.party.name || iv?.razonSocialComprador || '—',
        date: emitido, dueDate,
        description: o.requiresReview ? o.reason : '',
        retentions: 0,
        total: o.total, paid: o.applied, balance: o.balance, days,
        bucket: bucket(days),
        // Trazabilidad: la fila es una obligación, pero se puede abrir cualquiera de sus
        // documentos y cualquiera de sus dos carteras.
        links: {
          sale: o.venta.id,
          invoice: o.factura.id,
          receivableSale: o.receivables.venta?.id || null,
          receivableInvoice: o.receivables.factura?.id || null,
        },
        resolution: o.resolution,
        resolutionReason: o.reason,
        formula: o.formula,
        // Confirmado ≠ estimado: una ambigua NUNCA se presenta como saldo conciliado.
        confirmedBalance: o.confirmedBalance,
        ambiguousEstimatedBalance: o.ambiguousEstimatedBalance,
        operationalBalance: o.operationalBalance,
        requiresReview: o.requiresReview,
        warning: o.requiresReview ? o.reason : null,
      });
    }

    // Las filas que no son una obligación venta+factura son cartera CONFIRMADA por definición.
    for (const r of rows) {
      if (r.resolution) continue;
      r.resolution = 'UNICA';
      r.confirmedBalance = r.balance;
      r.ambiguousEstimatedBalance = 0;
      r.operationalBalance = r.balance;
      r.requiresReview = false;
      r.formula = `${Number(r.total || 0).toFixed(2)} − ${Number(r.paid || 0).toFixed(2)} = ${Number(r.balance).toFixed(2)}`;
    }

    const totals = rows.reduce((acc, r) => {
      acc[r.bucket] = +((acc[r.bucket] || 0) + r.balance).toFixed(2);
      acc.total = +(acc.total + r.balance).toFixed(2);
      // Cada rango de edad se abre en confirmado y estimado.
      acc.confirmed[r.bucket] = +((acc.confirmed[r.bucket] || 0) + r.confirmedBalance).toFixed(2);
      acc.ambiguous[r.bucket] = +((acc.ambiguous[r.bucket] || 0) + r.ambiguousEstimatedBalance).toFixed(2);
      return acc;
    }, { total: 0, confirmed: {}, ambiguous: {} });

    const summary = {
      confirmedBalance: +rows.reduce((s, r) => s + r.confirmedBalance, 0).toFixed(2),
      ambiguousEstimatedBalance: +rows.reduce((s, r) => s + r.ambiguousEstimatedBalance, 0).toFixed(2),
      operationalBalance: +rows.reduce((s, r) => s + r.operationalBalance, 0).toFixed(2),
      ambiguousCount: rows.filter((r) => r.requiresReview).length,
    };
    summary.warning = summary.ambiguousCount
      ? `${summary.ambiguousCount} obligación(es) tienen dos carteras (venta y factura) que no concilian. `
        + `Su saldo (${summary.ambiguousEstimatedBalance.toFixed(2)}) es una ESTIMACIÓN conservadora, `
        + 'no cartera confirmada: requiere conciliación humana.'
      : null;

    const alerts = obl.ambiguas.filter((o) => o.balance > 0.01).map((o) => ({
      tipo: 'CXC_DUPLICADA_AMBIGUA',
      venta: o.venta.id,
      factura: o.factura.id,
      receivables: { venta: o.receivables.venta?.id || null, factura: o.receivables.factura?.id || null },
      numero: o.venta.numero,
      motivo: o.reason,
      formula: o.formula,
      saldo: o.balance,
    }));
    res.json({ rows, totals, summary, alerts });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.accountsPayableAging = async (req, res) => {
  try {
    const today = new Date();
    const invoices = await PurchaseInvoice.find({ clinic: req.clinicId, status: 'REGISTRADA' });
    const paymentApps = await Payment.aggregate([
      { $match: { clinic: oid(req.clinicId), type: 'PAGO', status: 'REGISTRADO' } },
      { $unwind: '$applications' },
      { $match: { 'applications.docModel': 'PurchaseInvoice' } },
      { $group: { _id: '$applications.docRef', paid: { $sum: '$applications.amount' } } },
    ]);
    const paidMap = new Map(paymentApps.map((p) => [String(p._id), p.paid]));
    const rows = [];
    for (const inv of invoices) {
      const paid = paidMap.get(String(inv._id)) || 0;
      const balance = inv.balance - paid;
      if (balance <= 0.01) continue;
      const dueDate = inv.fechaVencimiento || new Date(inv.fechaEmision.getTime() + 30 * 86400000);
      const days = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
      rows.push({
        docId: inv._id, type: 'Compra', number: inv.serie,
        supplier: inv.supplier, date: inv.fechaEmision, dueDate,
        description: inv.notes || '', retentions: inv.retentionTotal || 0,
        total: inv.total, paid, balance, days,
        bucket: bucket(days),
      });
    }
    const totals = rows.reduce((acc, r) => { acc[r.bucket] = (acc[r.bucket] || 0) + r.balance; acc.total += r.balance; return acc; }, { total: 0 });
    res.json({ rows, totals });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/**
 * ANTICIPOS — uno por uno, no el saldo agregado de la cuenta.
 *
 * Cada fila es un movimiento contra una cuenta de anticipos: a quién (persona),
 * con qué documento, en qué fecha, por cuánto, y si es de un CLIENTE (lo que nos
 * anticiparon) o a un PROVEEDOR (lo que anticipamos). Se puede abrir el documento
 * origen desde la pantalla.
 *
 * La persona no está en el asiento: se resuelve del documento que lo generó
 * (movimiento bancario, cobro/pago, factura de compra o venta) en una sola consulta
 * por modelo, no una por fila.
 */
exports.advancesControl = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    // Las cuentas se buscan por CÓDIGO y también por nombre: un plan personalizado
    // puede tenerlas en otro código, y el reporte no debe quedarse mudo por eso.
    const accs = await ChartOfAccount.find({
      clinic: req.clinicId,
      $or: [{ code: { $in: ['1.1.02.03', '2.1.01.03'] } }, { name: /anticipo/i }],
    }).lean();
    // El anticipo de impuesto a la renta NO es un anticipo a terceros: no va aquí.
    const cuentas = accs.filter((a) => !/impuesto|renta/i.test(a.name || ''));
    if (!cuentas.length) return res.json({ rows: [], totals: { clientes: 0, proveedores: 0 }, accounts: [] });

    const ids = cuentas.map((a) => a._id);
    const porId = new Map(cuentas.map((a) => [String(a._id), a]));

    const match = { clinic: req.clinicId, status: 'CONTABILIZADO', 'lines.account': { $in: ids } };
    if (startDate || endDate) {
      match.date = {};
      if (startDate) match.date.$gte = startOfDay(startDate);
      if (endDate) match.date.$lte = endOfDay(endDate);
    }
    const entries = await JournalEntry.find(match).sort({ date: -1, number: -1 }).lean();

    // Personas de los documentos origen (una consulta por modelo).
    const refs = { BankTransaction: [], Payment: [], PurchaseInvoice: [], Sale: [] };
    for (const e of entries) if (refs[e.sourceModel]) refs[e.sourceModel].push(e.sourceRef);
    const [banks, pagos, compras, ventas] = await Promise.all([
      refs.BankTransaction.length ? require('../models/BankTransaction').find({ _id: { $in: refs.BankTransaction } }).select('partyName description reference').lean() : [],
      refs.Payment.length ? Payment.find({ _id: { $in: refs.Payment } }).select('partyName number type').lean() : [],
      refs.PurchaseInvoice.length ? PurchaseInvoice.find({ _id: { $in: refs.PurchaseInvoice } }).select('supplierName numeroFactura').lean() : [],
      refs.Sale.length ? Sale.find({ _id: { $in: refs.Sale } }).select('clientName saleNumber').lean() : [],
    ]);
    const persona = new Map();
    banks.forEach((b) => persona.set(String(b._id), { nombre: b.partyName || '', doc: b.reference || '' }));
    pagos.forEach((p) => persona.set(String(p._id), { nombre: p.partyName || '', doc: p.number || '' }));
    compras.forEach((p) => persona.set(String(p._id), { nombre: p.supplierName || '', doc: p.numeroFactura || '' }));
    ventas.forEach((v) => persona.set(String(v._id), { nombre: v.clientName || '', doc: v.saleNumber || '' }));

    const rows = [];
    for (const e of entries) {
      for (const l of e.lines || []) {
        const acc = porId.get(String(l.account));
        if (!acc) continue;
        const p = persona.get(String(e.sourceRef)) || {};
        // Cliente = cuenta de PASIVO (nos anticiparon); proveedor = ACTIVO (anticipamos).
        const esCliente = acc.nature === 'CREDITO' || String(acc.code || '').startsWith('2.');
        const monto = esCliente ? (l.credit || 0) - (l.debit || 0) : (l.debit || 0) - (l.credit || 0);
        if (!monto) continue;
        rows.push({
          date: e.date,
          tipo: esCliente ? 'CLIENTE' : 'PROVEEDOR',
          persona: p.nombre || l.description || e.description || '(sin identificar)',
          documento: p.doc || e.number,
          asiento: e.number,
          concepto: l.description || e.description || '',
          cuenta: { code: acc.code, name: acc.name },
          monto: +monto.toFixed(2),
          sourceModel: e.sourceModel || null,
          sourceRef: e.sourceRef || null,
          entryId: e._id,
        });
      }
    }
    const totals = rows.reduce(
      (acc, r) => ({ ...acc, [r.tipo === 'CLIENTE' ? 'clientes' : 'proveedores']: acc[r.tipo === 'CLIENTE' ? 'clientes' : 'proveedores'] + r.monto }),
      { clientes: 0, proveedores: 0 }
    );
    res.json({
      rows,
      totals: { clientes: +totals.clientes.toFixed(2), proveedores: +totals.proveedores.toFixed(2) },
      accounts: cuentas.map((a) => ({ code: a.code, name: a.name })),
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.inventoryReport = async (req, res) => {
  const products = await Product.find({ clinic: req.clinicId, active: true });
  const rows = products.map((p) => {
    // Costo unitario REAL: el promedio que calcula el kardex desde las compras. El antiguo
    // `purchasePrice` era un dato tecleado a mano que ya no se captura; se conserva como
    // respaldo solo para los productos que nunca han tenido movimiento de compra.
    const unitCost = Number(p.averageCost) || Number(p.purchasePrice) || 0;
    return {
      code: p.code, name: p.name, category: p.category,
      stock: p.stock || 0, purchasePrice: unitCost,
      salePrice: p.salePrice || 0,
      valueAtCost: (p.stock || 0) * unitCost,
      valueAtSale: (p.stock || 0) * (p.salePrice || 0),
    };
  });
  const totals = rows.reduce((acc, r) => ({
    valueAtCost: acc.valueAtCost + r.valueAtCost,
    valueAtSale: acc.valueAtSale + r.valueAtSale,
    units: acc.units + r.stock,
  }), { valueAtCost: 0, valueAtSale: 0, units: 0 });
  res.json({ rows, totals });
};

/**
 * Reporte gerencial GENERAL: consolida los indicadores clave en una sola
 * respuesta, respetando los mismos filtros de fecha de los demás reportes
 * gerenciales (startDate/endDate).
 */
exports.generalReport = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const clinicObjId = new mongoose.Types.ObjectId(req.clinicId);
    const salesMatch = { clinic: clinicObjId, status: 'completada', ...dateMatch(req) };

    // Ventas
    const [salesAgg] = await Sale.aggregate([
      { $match: salesMatch },
      { $group: { _id: null, count: { $sum: 1 }, subtotal: { $sum: '$subtotal' }, tax: { $sum: '$taxAmount' }, discount: { $sum: '$discountTotal' }, total: { $sum: '$total' } } },
    ]);
    const sales = salesAgg || { count: 0, subtotal: 0, tax: 0, discount: 0, total: 0 };

    // Ventas anuladas
    const [voidedAgg] = await Sale.aggregate([
      { $match: { clinic: clinicObjId, status: 'anulada', ...dateMatch(req) } },
      { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$total' } } },
    ]);

    // Cobros por método
    const collections = await Sale.aggregate([
      { $match: salesMatch },
      { $group: { _id: '$paymentMethod', count: { $sum: 1 }, total: { $sum: '$total' } } },
      { $sort: { total: -1 } },
    ]);

    // Ventas por período (mensual)
    const byPeriod = await Sale.aggregate([
      { $match: salesMatch },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } }, total: { $sum: '$total' }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    // Top productos
    const topProducts = await Sale.aggregate([
      { $match: salesMatch }, { $unwind: '$items' },
      { $group: { _id: '$items.productName', qty: { $sum: '$items.quantity' }, total: { $sum: '$items.subtotal' } } },
      { $sort: { total: -1 } }, { $limit: 8 },
    ]);

    // Costo de venta / utilidad bruta
    const salesDocs = await Sale.find(salesMatch).populate('items.product', 'purchasePrice');
    let cost = 0;
    for (const s of salesDocs) for (const it of s.items) cost += (it.product?.purchasePrice || 0) * it.quantity;
    const grossProfit = +(sales.total - cost).toFixed(2);

    // Compras
    const purchaseMatch = { clinic: clinicObjId, status: { $ne: 'ANULADA' }, ...dateMatch(req, 'fechaEmision') };
    const [purchasesAgg] = await PurchaseInvoice.aggregate([
      { $match: purchaseMatch },
      { $group: { _id: null, count: { $sum: 1 }, subtotal: { $sum: '$subtotal' }, iva: { $sum: '$iva' }, total: { $sum: '$total' }, retentions: { $sum: '$retentionTotal' } } },
    ]);
    const purchases = purchasesAgg || { count: 0, subtotal: 0, iva: 0, total: 0, retentions: 0 };

    // Cuentas por pagar (saldo pendiente de proveedores)
    const [apAgg] = await PurchaseInvoice.aggregate([
      { $match: { clinic: clinicObjId, status: 'REGISTRADA', balance: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: '$balance' }, count: { $sum: 1 } } },
    ]);

    // Inventario valorizado
    const products = await Product.find({ clinic: req.clinicId, active: true }).select('stock averageCost purchasePrice salePrice');
    // Costo unitario del kardex (`averageCost`); `purchasePrice` solo como respaldo histórico.
    const inventory = products.reduce((acc, p) => ({
      valueAtCost: acc.valueAtCost + (p.stock || 0) * (Number(p.averageCost) || Number(p.purchasePrice) || 0),
      valueAtSale: acc.valueAtSale + (p.stock || 0) * (p.salePrice || 0),
      units: acc.units + (p.stock || 0),
    }), { valueAtCost: 0, valueAtSale: 0, units: 0 });

    res.json({
      sales,
      voided: voidedAgg || { count: 0, total: 0 },
      collections,
      byPeriod: byPeriod.map((p) => ({ period: p._id, total: p.total, count: p.count })),
      topProducts: topProducts.map((p) => ({ name: p._id || '—', qty: p.qty, total: p.total })),
      cost: +cost.toFixed(2),
      grossProfit,
      margin: sales.total > 0 ? +((grossProfit / sales.total) * 100).toFixed(2) : 0,
      purchases,
      accountsPayable: apAgg || { total: 0, count: 0 },
      inventory,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/**
 * Saldos por período (mes/año) usando los saldos materializados (AccountBalance):
 * saldo de apertura (acumulado de períodos previos), débito/crédito del período y
 * saldo de cierre, respetando la naturaleza de cada cuenta.
 */
exports.periodBalances = async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
    const accounts = await ChartOfAccount.find({ clinic: req.clinicId });
    const accMap = new Map(accounts.map((a) => [String(a._id), a]));

    const rows = await AccountBalance.find({ clinic: req.clinicId });
    const data = new Map(); // accId -> { opening, debit, credit }
    for (const b of rows) {
      const before = (b.year < year) || (b.year === year && b.month < month);
      const inPeriod = (b.year === year && b.month === month);
      if (!before && !inPeriod) continue;
      const key = String(b.account);
      if (!data.has(key)) data.set(key, { openingDebit: 0, openingCredit: 0, debit: 0, credit: 0 });
      const d = data.get(key);
      if (before) { d.openingDebit += b.debit; d.openingCredit += b.credit; }
      if (inPeriod) { d.debit += b.debit; d.credit += b.credit; }
    }

    const out = [];
    for (const [key, d] of data.entries()) {
      const acc = accMap.get(key);
      if (!acc) continue;
      const isDebit = acc.nature === 'DEBITO';
      const opening = +(isDebit ? d.openingDebit - d.openingCredit : d.openingCredit - d.openingDebit).toFixed(2);
      const movement = +(isDebit ? d.debit - d.credit : d.credit - d.debit).toFixed(2);
      const closing = +(opening + movement).toFixed(2);
      if (Math.abs(opening) < 0.005 && Math.abs(d.debit) < 0.005 && Math.abs(d.credit) < 0.005) continue;
      out.push({ account: { _id: acc._id, code: acc.code, name: acc.name, type: acc.type, nature: acc.nature },
        opening, debit: +d.debit.toFixed(2), credit: +d.credit.toFixed(2), closing });
    }
    out.sort((a, b) => a.account.code.localeCompare(b.account.code));
    res.json({ year, month, rows: out });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/**
 * Indicadores financieros NIIF: razones de liquidez, endeudamiento, rentabilidad
 * y punto de equilibrio, para el rango de fechas indicado.
 */
exports.financialIndicators = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    // Balance (acumulado a la fecha de corte = endDate o ahora)
    const cutoff = endDate ? new Date(endDate + 'T23:59:59.999') : new Date();
    const balAccounts = await getAccountBalances(req.clinicId, { endDate: cutoff });
    const sumBy = (pred) => balAccounts.filter(pred).reduce((s, a) => s + (a.balance || 0), 0);
    const activoTotal = sumBy((a) => a.type === 'ACTIVO');
    const activoCorriente = sumBy((a) => a.code?.startsWith('1.1'));
    const inventarios = sumBy((a) => a.code?.startsWith('1.1.04'));
    const pasivoTotal = sumBy((a) => a.type === 'PASIVO');
    const pasivoCorriente = sumBy((a) => a.code?.startsWith('2.1'));
    const patrimonio = sumBy((a) => a.type === 'PATRIMONIO');

    // Estado de resultados (en el período)
    const periodAccounts = await getAccountBalances(req.clinicId, { startDate: startDate ? new Date(startDate) : undefined, endDate: cutoff });
    const ingresos = periodAccounts.filter((a) => a.type === 'INGRESO').reduce((s, a) => s + (a.balance || 0), 0);
    const costos = periodAccounts.filter((a) => a.type === 'COSTO').reduce((s, a) => s + (a.balance || 0), 0);
    const gastos = periodAccounts.filter((a) => a.type === 'GASTO').reduce((s, a) => s + (a.balance || 0), 0);
    const utilidad = +(ingresos - costos - gastos).toFixed(2);

    const safe = (n, d) => (d && Math.abs(d) > 0.001 ? +(n / d).toFixed(4) : 0);
    const contributionRatio = ingresos > 0 ? safe(ingresos - costos, ingresos) : 0;
    const breakEven = contributionRatio > 0 ? +(gastos / contributionRatio).toFixed(2) : 0;

    res.json({
      balance: { activoTotal, activoCorriente, inventarios, pasivoTotal, pasivoCorriente, patrimonio },
      resultados: { ingresos: +ingresos.toFixed(2), costos: +costos.toFixed(2), gastos: +gastos.toFixed(2), utilidad },
      ratios: {
        razonCorriente: safe(activoCorriente, pasivoCorriente),
        pruebaAcida: safe(activoCorriente - inventarios, pasivoCorriente),
        capitalTrabajo: +(activoCorriente - pasivoCorriente).toFixed(2),
        endeudamiento: safe(pasivoTotal, activoTotal),
        apalancamiento: safe(pasivoTotal, patrimonio),
        margenNeto: safe(utilidad, ingresos),
        roa: safe(utilidad, activoTotal),
        roe: safe(utilidad, patrimonio),
      },
      puntoEquilibrio: { contributionRatio, ventasEquilibrio: breakEven, ventasActuales: +ingresos.toFixed(2), margenSeguridad: breakEven > 0 ? +(((ingresos - breakEven) / ingresos) * 100).toFixed(2) : 0 },
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/** Reconstruye los saldos materializados desde los asientos. */
exports.recomputeBalances = async (req, res) => {
  try {
    const n = await recomputeBalances(req.clinicId);
    res.json({ ok: true, periodos: n });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ---------- Exportaciones Excel de cartera ----------
const AGING_COLS = [
  { header: 'Nombre', key: 'name', width: 32 },
  { header: 'Tipo documento', key: 'type', width: 14 },
  { header: 'N° documento', key: 'number', width: 20 },
  { header: 'Fecha emisión', key: 'emision', width: 14 },
  { header: 'Fecha vencimiento', key: 'vence', width: 16 },
  { header: 'Centro de costo', key: 'costCenter', width: 18 },
  { header: 'Por vencer', key: 'porVencer', width: 12 },
  { header: '1-30', key: 'd30', width: 12 },
  { header: '31-60', key: 'd60', width: 12 },
  { header: '61-120', key: 'd120', width: 12 },
  { header: '> 120', key: 'd120plus', width: 12 },
  { header: 'Total', key: 'total', width: 12 },
  { header: 'Descripción', key: 'description', width: 30 },
  { header: 'Valor documento', key: 'docValue', width: 14 },
  { header: 'Retenciones', key: 'retentions', width: 12 },
  { header: 'Pagos', key: 'payments', width: 12 },
  // Confirmado ≠ estimado: una obligación ambigua no se exporta como cartera conciliada.
  { header: 'Resolución', key: 'resolution', width: 24 },
  { header: 'Saldo confirmado', key: 'confirmed', width: 16 },
  { header: 'Saldo ambiguo estimado', key: 'ambiguous', width: 20 },
  { header: 'Saldo operativo', key: 'operational', width: 15 },
  { header: 'Motivo', key: 'reason', width: 60 },
  { header: 'Requiere revisión', key: 'review', width: 16 },
];

function agingRowToExcel(r, name) {
  const b = r.bucket;
  return {
    name,
    type: r.type,
    number: r.number,
    emision: typeof r.date === 'string' ? r.date : (r.date ? new Date(r.date).toLocaleDateString('es-EC') : ''),
    vence: r.dueDate ? new Date(r.dueDate).toLocaleDateString('es-EC') : '',
    costCenter: r.costCenter || '',
    porVencer: b === 'POR_VENCER' ? r.balance : 0,
    d30: b === 'VENCIDO_30' ? r.balance : 0,
    d60: b === 'VENCIDO_60' ? r.balance : 0,
    d120: (b === 'VENCIDO_90' || b === 'VENCIDO_120') ? r.balance : 0,
    d120plus: b === 'VENCIDO_MAS_120' ? r.balance : 0,
    total: r.balance,
    description: r.description || '',
    docValue: r.total || 0,
    retentions: r.retentions || 0,
    payments: r.paid || 0,
    // En cartera por pagar no hay obligaciones ambiguas: todo es confirmado.
    resolution: r.resolution || 'UNICA',
    confirmed: r.confirmedBalance ?? r.balance ?? 0,
    ambiguous: r.ambiguousEstimatedBalance ?? 0,
    operational: r.operationalBalance ?? r.balance ?? 0,
    reason: r.resolutionReason || '',
    review: r.requiresReview ? 'SÍ — conciliación humana' : '',
  };
}

async function buildAgingWorkbook(rows, title, summary = null) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title);
  ws.columns = AGING_COLS;
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
  rows.forEach((r) => ws.addRow(r));
  ['porVencer', 'd30', 'd60', 'd120', 'd120plus', 'total', 'docValue', 'retentions', 'payments',
    'confirmed', 'ambiguous', 'operational'].forEach((k) => { ws.getColumn(k).numFmt = '"$"#,##0.00'; });

  // Sección de resumen: el Excel dice lo mismo que la API, y separa lo confirmado de lo estimado.
  if (summary) {
    ws.addRow({});
    const filas = [
      ['Total confirmado', summary.confirmedBalance],
      ['Estimación ambigua (NO es cartera confirmada)', summary.ambiguousEstimatedBalance],
      ['Total operativo (el que usa el flujo de caja)', summary.operationalBalance],
      ['Obligaciones ambiguas', summary.ambiguousCount],
    ];
    for (const [etiqueta, valor] of filas) {
      const row = ws.addRow({ name: etiqueta, total: valor });
      row.font = { bold: true };
    }
    if (summary.warning) ws.addRow({ name: summary.warning });
  }
  return wb;
}

exports.arAgingExcel = async (req, res) => {
  try {
    const data = await new Promise((resolve) => { exports.accountsReceivableAging(req, { json: resolve, status: () => ({ json: resolve }) }); });
    const rows = (data.rows || []).map((r) => agingRowToExcel(r, r.client));
    const wb = await buildAgingWorkbook(rows, 'Cuentas por cobrar', data.summary);
    await sendWorkbook(res, wb, `cartera_cobrar_${Date.now()}.xlsx`);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.apAgingExcel = async (req, res) => {
  try {
    const data = await new Promise((resolve) => { exports.accountsPayableAging(req, { json: resolve, status: () => ({ json: resolve }) }); });
    // Resolver nombre de proveedor
    const Supplier = require('../models/Supplier');
    const rows = [];
    for (const r of (data.rows || [])) {
      let name = '';
      if (r.supplier) { const s = await Supplier.findById(r.supplier).select('razonSocial'); name = s?.razonSocial || ''; }
      rows.push(agingRowToExcel(r, name));
    }
    const wb = await buildAgingWorkbook(rows, 'Cuentas por pagar');
    await sendWorkbook(res, wb, `cartera_pagar_${Date.now()}.xlsx`);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/** Flujo de caja en Excel con alertas de color (rojo si saldo negativo). */
exports.cashFlowExcel = async (req, res) => {
  try {
    const data = await new Promise((resolve) => { exports.cashFlow(req, { json: resolve, status: () => ({ json: resolve }) }); });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Flujo de caja');
    ws.columns = [
      { header: 'Fecha', key: 'date', width: 14 },
      { header: 'Asiento', key: 'number', width: 14 },
      { header: 'Descripción', key: 'description', width: 40 },
      { header: 'Ingreso', key: 'in', width: 14 },
      { header: 'Egreso', key: 'out', width: 14 },
      { header: 'Saldo', key: 'saldo', width: 14 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
    (data.flows || []).forEach((f) => {
      const row = ws.addRow({ date: new Date(f.date).toLocaleDateString('es-EC'), number: f.number, description: f.description, in: f.in, out: f.out, saldo: f.saldo });
      if (f.saldo < 0) {
        row.getCell('saldo').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
        row.getCell('saldo').font = { color: { argb: 'FFB91C1C' }, bold: true };
      } else if (f.saldo < 500) {
        row.getCell('saldo').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
      }
    });
    ['in', 'out', 'saldo'].forEach((k) => { ws.getColumn(k).numFmt = '"$"#,##0.00'; });
    // Fila de totales
    const totalRow = ws.addRow({ description: 'TOTALES', in: data.totalIn, out: data.totalOut, saldo: data.saldoFinal });
    totalRow.font = { bold: true };

    // ---- Proyección de liquidez ----
    const p = data.proyeccion;
    if (p) {
      ws.addRow({});
      const title = ws.addRow({ description: 'PROYECCIÓN DE LIQUIDEZ (a hoy)' });
      title.font = { bold: true };
      title.getCell('description').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
      const projRows = [
        ['Disponible actual (caja + bancos)', p.disponible],
        ['(+) Ingresos esperados (CxC por cobrar)', p.cxc.total],
        ['      · CxC vencidas', p.cxc.vencido],
        ['      · CxC por vencer', p.cxc.porVencer],
        ['(−) Cuentas por pagar (CxP pendientes)', -p.cxp.total],
        ['      · CxP vencidas', -p.cxp.vencido],
        ['      · CxP por vencer', -p.cxp.porVencer],
        ['(=) SALDO PROYECTADO', p.saldoProyectado],
      ];
      for (const [label, value] of projRows) {
        const row = ws.addRow({ description: label, saldo: value });
        if (label.startsWith('(=)')) {
          row.font = { bold: true };
          if (p.saldoProyectado < 0) {
            row.getCell('saldo').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
            row.getCell('saldo').font = { color: { argb: 'FFB91C1C' }, bold: true };
          }
        }
      }
      if (p.alertas?.deficitProyectado) {
        const a = ws.addRow({ description: 'ALERTA: las obligaciones superan el disponible + ingresos esperados' });
        a.font = { color: { argb: 'FFB91C1C' }, bold: true };
      } else if (p.alertas?.vencidasSuperanDisponible) {
        const a = ws.addRow({ description: 'ALERTA: las CxP ya vencidas superan el efectivo disponible' });
        a.font = { color: { argb: 'FFB91C1C' }, bold: true };
      }

      // Hojas de detalle de cartera abierta.
      const addDetailSheet = (name, docs, headerColor) => {
        const wd = wb.addWorksheet(name);
        wd.columns = [
          { header: 'Vencimiento', key: 'due', width: 14 },
          { header: 'Emisión', key: 'issue', width: 14 },
          { header: 'Contraparte', key: 'party', width: 34 },
          { header: 'Documento', key: 'number', width: 20 },
          { header: 'Tipo', key: 'docType', width: 10 },
          { header: 'Estado', key: 'estado', width: 22 },
          { header: 'Saldo', key: 'balance', width: 14 },
        ];
        wd.getRow(1).font = { bold: true };
        wd.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: headerColor } };
        for (const d of docs) {
          const row = wd.addRow({
            due: d.dueDate ? new Date(d.dueDate).toLocaleDateString('es-EC') : '—',
            issue: d.issueDate ? new Date(d.issueDate).toLocaleDateString('es-EC') : '',
            party: d.party,
            number: d.number,
            docType: d.docType,
            estado: d.dias > 0 ? `VENCIDA hace ${d.dias} día(s)` : `Vence en ${-d.dias} día(s)`,
            balance: d.balance,
          });
          if (d.dias > 0) row.getCell('estado').font = { color: { argb: 'FFB91C1C' }, bold: true };
        }
        wd.getColumn('balance').numFmt = '"$"#,##0.00';
        const t = wd.addRow({ estado: 'TOTAL', balance: docs.reduce((s, d) => s + d.balance, 0) });
        t.font = { bold: true };
      };
      addDetailSheet('Cuentas por pagar', p.cxp.docs || [], 'FFFEE2E2');
      addDetailSheet('Cuentas por cobrar', p.cxc.docs || [], 'FFD1FAE5');
    }
    await sendWorkbook(res, wb, `flujo_caja_${Date.now()}.xlsx`);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/** Compras y ventas (esquema SRI) en Excel. */
exports.purchaseSalesExcel = async (req, res) => {
  try {
    const data = await new Promise((resolve) => { exports.purchaseSalesList(req, { json: resolve, status: () => ({ json: resolve }) }); });
    const wb = new ExcelJS.Workbook();
    const wv = wb.addWorksheet('Ventas');
    wv.columns = [
      { header: 'Fecha', key: 'date', width: 14 }, { header: 'Comprobante', key: 'doc', width: 22 },
      { header: 'RUC/CI Cliente', key: 'id', width: 16 }, { header: 'Cliente', key: 'name', width: 30 },
      { header: 'Base 0%', key: 'base0', width: 12 }, { header: 'Base 15%', key: 'baseGrav', width: 12 },
      { header: 'IVA', key: 'iva', width: 12 }, { header: 'Total', key: 'total', width: 14 },
    ];
    wv.getRow(1).font = { bold: true };
    (data.ventas || []).forEach((v) => {
      const tb = v.taxBreakdown || {};
      wv.addRow({
        date: v.fechaEmision || (v.createdAt ? new Date(v.createdAt).toLocaleDateString('es-EC') : ''),
        doc: `${v.estab || ''}-${v.ptoEmi || ''}-${v.secuencial || ''}`,
        id: v.identificacionComprador, name: v.razonSocialComprador,
        base0: tb.base0 || 0, baseGrav: tb.baseGravada || 0, iva: tb.iva ?? v.totalImpuesto ?? 0, total: v.importeTotal || 0,
      });
    });
    const wc = wb.addWorksheet('Compras');
    wc.columns = [
      { header: 'Fecha', key: 'date', width: 14 }, { header: 'Serie', key: 'serie', width: 20 },
      { header: 'RUC Proveedor', key: 'ruc', width: 16 }, { header: 'Proveedor', key: 'name', width: 30 },
      { header: 'Subtotal', key: 'sub', width: 14 }, { header: 'IVA', key: 'iva', width: 12 }, { header: 'Total', key: 'total', width: 14 },
    ];
    wc.getRow(1).font = { bold: true };
    (data.compras || []).forEach((c) => wc.addRow({
      date: c.fechaEmision ? new Date(c.fechaEmision).toLocaleDateString('es-EC') : '',
      serie: c.serie, ruc: c.supplier?.ruc, name: c.supplier?.razonSocial,
      sub: c.subtotal || 0, iva: c.iva || 0, total: c.total || 0,
    }));
    [wv, wc].forEach((ws) => ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } });
    await sendWorkbook(res, wb, `compras_ventas_${Date.now()}.xlsx`);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ---------- Reportes SRI ----------
exports.purchaseSalesList = async (req, res) => {
  try {
    const range = resolveReportRange(req.query);
    // Cada venta lleva su desglose por tarifa (0% / gravada) para la lista y el Excel.
    const ventas = (await fetchSalesInRange(req.clinicId, range.start, range.end))
      .map((v) => ({ ...v, taxBreakdown: invoiceTaxBreakdown(v) }));
    const compras = await PurchaseInvoice.find(purchasesInRangeQuery(req.clinicId, range.start, range.end))
      .populate('supplier', 'ruc razonSocial');
    const salesPending = await countPendingSalesInRange(req.clinicId, range.start, range.end);
    res.json({ ventas, compras, period: periodMeta(range), salesPending });
  } catch (e) { res.status(e.status || 500).json({ message: e.message }); }
};

/** Formulario 104 - IVA mensual (resumen para llenado). */
/**
 * Rentabilidad por centro de costo (médico). Agrupa los asientos con dimensión
 * `doctor` y compara ingresos vs costos/gastos en el período.
 */
exports.profitabilityByDoctor = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const User = require('../models/User');
    const clinicId = mongoose.Types.ObjectId.createFromHexString(String(req.clinicId));
    const match = { clinic: clinicId, status: 'CONTABILIZADO', doctor: { $ne: null } };
    if (req.query.from || req.query.to) {
      match.date = {};
      if (req.query.from) match.date.$gte = new Date(req.query.from);
      if (req.query.to) match.date.$lte = new Date(req.query.to);
    }
    const rows = await JournalEntry.aggregate([
      { $match: match },
      { $unwind: '$lines' },
      { $lookup: { from: 'chartofaccounts', localField: 'lines.account', foreignField: '_id', as: 'acc' } },
      { $unwind: '$acc' },
      { $group: { _id: { doctor: '$doctor', type: '$acc.type' }, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
    ]);
    const byDoctor = new Map();
    for (const r of rows) {
      const id = String(r._id.doctor);
      if (!byDoctor.has(id)) byDoctor.set(id, { doctor: r._id.doctor, ingreso: 0, costo: 0, gasto: 0 });
      const row = byDoctor.get(id);
      if (r._id.type === 'INGRESO') row.ingreso += (r.credit - r.debit);
      else if (r._id.type === 'COSTO') row.costo += (r.debit - r.credit);
      else if (r._id.type === 'GASTO') row.gasto += (r.debit - r.credit);
    }
    const users = await User.find({ _id: { $in: [...byDoctor.values()].map((r) => r.doctor) } }).select('name');
    const names = new Map(users.map((u) => [String(u._id), u.name]));
    const result = [...byDoctor.values()].map((r) => ({
      doctor: r.doctor,
      doctorName: names.get(String(r.doctor)) || '—',
      ingreso: +r.ingreso.toFixed(2),
      costo: +r.costo.toFixed(2),
      gasto: +r.gasto.toFixed(2),
      margen: +(r.ingreso - r.costo - r.gasto).toFixed(2),
    })).sort((a, b) => b.margen - a.margen);
    res.json({ rows: result });
  } catch (e) {
    res.status(500).json({ message: 'Error en rentabilidad por médico', error: e.message });
  }
};

exports.form104 = async (req, res) => {
  try {
    const range = resolveReportRange(req.query);

    const ventas = await fetchSalesInRange(req.clinicId, range.start, range.end);
    // Ventas separadas por tarifa (0% vs gravada). base = base0 + baseGravada.
    const v = ventas.reduce((acc, i) => {
      const tb = invoiceTaxBreakdown(i);
      acc.base += tb.baseTotal;
      acc.base0 += tb.base0;
      acc.baseGravada += tb.baseGravada;
      acc.iva += tb.iva;
      return acc;
    }, { base: 0, base0: 0, baseGravada: 0, iva: 0 });
    ['base', 'base0', 'baseGravada', 'iva'].forEach((k) => { v[k] = +v[k].toFixed(2); });

    const compras = await PurchaseInvoice.find(purchasesInRangeQuery(req.clinicId, range.start, range.end));
    const c = compras.reduce((acc, p) => {
      acc.base += p.subtotal || 0;
      acc.iva += p.iva || 0;
      // IVA con derecho a crédito tributario (excluye el no deducible / no recuperable).
      const creditIva = p.deductible === false ? 0 : (p.vatCreditAmount || p.iva || 0);
      acc.ivaCredito += creditIva;
      acc.ivaNoCredito += (p.iva || 0) - creditIva;
      acc.retIVA += (p.retentions || []).filter((r) => r.type === 'IVA').reduce((s, r) => s + (r.amount || 0), 0);
      return acc;
    }, { base: 0, iva: 0, ivaCredito: 0, ivaNoCredito: 0, retIVA: 0 });

    res.json({
      periodo: range.label,
      period: periodMeta(range),
      ventas: v, compras: c,
      // Solo el IVA con crédito tributario reduce el IVA por pagar.
      ivaPorPagar: +(v.iva - c.ivaCredito - c.retIVA).toFixed(2),
      isPreliminary: true,
      nota: 'Preliquidación. Validar contra el formato oficial vigente del SRI antes de declarar.',
    });
  } catch (e) { res.status(e.status || 500).json({ message: e.message }); }
};

/** Formulario 103 - Retenciones en la fuente. */
exports.form103 = async (req, res) => {
  try {
    const range = resolveReportRange(req.query);
    const compras = await PurchaseInvoice.find(purchasesInRangeQuery(req.clinicId, range.start, range.end));
    const byCode = {};
    // Fuente ÚNICA: las retenciones de CABECERA (`p.retentions`), que ya vienen
    // agrupadas desde las retenciones por línea. No se recorre `item.retentions`
    // para evitar doble conteo (línea + cabecera).
    for (const p of compras) {
      for (const r of p.retentions || []) {
        if (r.type !== 'RENTA') continue;
        const key = r.code || '0000';
        if (!byCode[key]) byCode[key] = { code: key, description: r.description || '', base: 0, amount: 0 };
        byCode[key].base += r.baseAmount || 0;
        byCode[key].amount += r.amount || 0;
      }
    }
    res.json({ periodo: range.label, period: periodMeta(range), rows: Object.values(byCode), total: Object.values(byCode).reduce((s, r) => s + r.amount, 0) });
  } catch (e) { res.status(e.status || 500).json({ message: e.message }); }
};

/**
 * RDEP - Anexo de Retenciones en Relación de Dependencia (anual).
 * Agrega los roles de pago del año por empleado: ingreso gravado, aporte IESS
 * personal e impuesto a la renta retenido.
 */
const RDEP_INCLUDED_STATUSES = ['CERRADO', 'PAGADO'];
const RDEP_WARNING = {
  DRAFT_PAYROLLS_EXCLUDED: 'Hay roles en borrador que no se incluyen.',
  YEAR_WITHOUT_DATA: 'No hay nominas cerradas para este anio.',
  EMPLOYEE_MISSING_ID: 'Hay empleados sin identificacion completa.',
  EMPLOYEE_MISSING_HIRE_DATE: 'Hay empleados sin fecha de ingreso.',
  EMPLOYEE_MISSING_DEPARTMENT: 'Hay empleados sin departamento.',
  EMPLOYEE_MISSING_POSITION: 'Hay empleados sin cargo.',
  MISSING_INCOME_TAX_TABLE: 'No hay tabla de impuesto a la renta configurada para este anio.',
  UNCLASSIFIED_CONCEPTS: 'Hay conceptos sin clasificacion tributaria.',
  LEGACY_TOTALS_DERIVED: 'Hay roles antiguos con totales que no se pudieron clasificar por completo.',
};

const rdepRound = (n) => +(Number(n) || 0).toFixed(2);
const rdepUpper = (s) => String(s || '').trim().toUpperCase();
const rdepDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

function rdepWarningCollector() {
  const seen = new Set();
  const warnings = [];
  return {
    add(code, message, extra = {}) {
      const key = `${code}|${extra.employeeId || ''}|${extra.payrollId || ''}|${extra.conceptId || ''}|${extra.field || ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      warnings.push({ code, message, severity: extra.severity || 'warning', ...extra });
    },
    list() { return warnings; },
  };
}

function rdepNewEmployeeRow({ key, item, employee, department, position }) {
  const nombre = (item.employeeName || `${employee?.firstName || ''} ${employee?.lastName || ''}`.trim()).trim();
  const identificacion = item.identificacion || employee?.identificacion || '';
  return {
    key,
    employeeId: employee?._id ? String(employee._id) : (item.employee ? String(item.employee) : ''),
    identificacion,
    tipoIdentificacion: employee?.tipoIdentificacion || '',
    nombre,
    fechaIngreso: rdepDate(employee?.hireDate),
    fechaSalida: rdepDate(employee?.exitDate),
    departamento: department?.name || employee?.department || item.departmentType || '',
    cargo: position?.name || employee?.position || '',
    periodoFiscal: null,
    sueldoBase: 0,
    sueldo: 0,
    ingresosGravados: 0,
    ingresosNoGravados: 0,
    ingresoExento: 0,
    decimoTercero: 0,
    decimoCuarto: 0,
    fondosReserva: 0,
    vacaciones: 0,
    aporteIessPersonal: 0,
    aporteIessPatronal: 0,
    aporteIess: 0,
    impuestoRenta: 0,
    baseImponible: 0,
    otrosIngresos: 0,
    otrosDescuentos: 0,
    totalIngresos: 0,
    totalEgresos: 0,
    netoPagado: 0,
    mesesTrabajados: 0,
    rolesCerrados: [],
    _months: new Set(),
  };
}

function rdepConceptId(line) {
  return line?.concept ? String(line.concept) : '';
}

function rdepClassifyIncome(line, concept) {
  const code = rdepUpper(concept?.code || line?.code);
  const category = rdepUpper(concept?.category || '');
  if (concept?.isDecimoTercero || code.includes('DECIMO-TERCERO')) return 'decimoTercero';
  if (concept?.isDecimoCuarto || code.includes('DECIMO-CUARTO')) return 'decimoCuarto';
  if (concept?.isFondosReserva || code.includes('FONDOS-RESERVA') || category === 'FONDOS_RESERVA') return 'fondosReserva';
  if (concept?.isVacation || code.includes('VACACIONES') || category === 'VACACIONES') return 'vacaciones';
  if (concept?.isTaxableIncome || concept?.affectsIncomeTax) return 'gravado';
  if (concept?.isNonTaxableIncome || concept?.isOtherNonTaxable || concept?.isReimbursement) return 'noGravado';
  return 'sinClasificar';
}

function rdepClassifyDeduction(line, concept) {
  const code = rdepUpper(concept?.code || line?.code);
  const category = rdepUpper(concept?.category || '');
  if (concept?.isPersonalIess || code.includes('IESS-PERSONAL')) return 'aporteIessPersonal';
  if (concept?.isIncomeTaxWithholding || code.includes('IMPUESTO-RENTA') || category === 'IMPUESTO') return 'impuestoRenta';
  if (concept?.isDiscount || concept?.type === 'EGRESO' || ['ANTICIPO', 'PRESTAMO', 'MULTA', 'DESCUENTO', 'AUSENCIA'].includes(category)) return 'descuento';
  return 'sinClasificar';
}

function rdepAddIncome(row, bucket, amount) {
  const value = rdepRound(amount);
  if (value <= 0) return;
  if (bucket === 'decimoTercero') { row.decimoTercero += value; row.ingresosNoGravados += value; return; }
  if (bucket === 'decimoCuarto') { row.decimoCuarto += value; row.ingresosNoGravados += value; return; }
  if (bucket === 'fondosReserva') { row.fondosReserva += value; row.ingresosNoGravados += value; return; }
  if (bucket === 'vacaciones') { row.vacaciones += value; row.ingresosNoGravados += value; return; }
  if (bucket === 'gravado') { row.ingresosGravados += value; return; }
  if (bucket === 'noGravado') { row.ingresosNoGravados += value; return; }
  row.otrosIngresos += value;
}

function rdepAddDeduction(row, bucket, amount) {
  const value = rdepRound(amount);
  if (value <= 0) return;
  if (bucket === 'aporteIessPersonal') { row.aporteIessPersonal += value; return; }
  if (bucket === 'impuestoRenta') { row.impuestoRenta += value; return; }
  row.otrosDescuentos += value;
}

exports.rdep = async (req, res) => {
  try {
    const Payroll = require('../models/Payroll');
    const Employee = require('../models/Employee');
    const PayrollConcept = require('../models/PayrollConcept');
    const PayrollDepartment = require('../models/PayrollDepartment');
    const PayrollPosition = require('../models/PayrollPosition');
    const PayrollIncomeTaxTable = require('../models/PayrollIncomeTaxTable');
    const Clinic = require('../models/Clinic');
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const warnings = rdepWarningCollector();

    const allRolls = await Payroll.find({ clinic: req.clinicId, year }).lean();
    const statusCounts = allRolls.reduce((acc, p) => {
      acc[p.status || 'SIN_ESTADO'] = (acc[p.status || 'SIN_ESTADO'] || 0) + 1;
      return acc;
    }, {});
    const rolls = allRolls.filter((p) => RDEP_INCLUDED_STATUSES.includes(p.status));
    const draftExcluded = allRolls.filter((p) => p.status === 'BORRADOR').length;
    if (draftExcluded > 0) {
      warnings.add('DRAFT_PAYROLLS_EXCLUDED', RDEP_WARNING.DRAFT_PAYROLLS_EXCLUDED, { count: draftExcluded });
    }
    if (!rolls.length) warnings.add('YEAR_WITHOUT_DATA', RDEP_WARNING.YEAR_WITHOUT_DATA, { year, severity: 'info' });

    const employeeIds = [...new Set(rolls.flatMap((p) => (p.items || []).map((it) => String(it.employee || '')).filter((id) => mongoose.Types.ObjectId.isValid(id))))];
    const conceptIds = [...new Set(rolls.flatMap((p) => (p.items || []).flatMap((it) => [...(it.earnings || []), ...(it.deductions || [])].map(rdepConceptId))).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
    const [clinic, employees, departments, positions, concepts, taxTable] = await Promise.all([
      Clinic.findById(req.clinicId).lean(),
      employeeIds.length ? Employee.find({ clinic: req.clinicId, _id: { $in: employeeIds } }).lean() : [],
      PayrollDepartment.find({ clinic: req.clinicId }).lean(),
      PayrollPosition.find({ clinic: req.clinicId }).lean(),
      conceptIds.length ? PayrollConcept.find({ clinic: req.clinicId, _id: { $in: conceptIds } }).lean() : [],
      PayrollIncomeTaxTable.findOne({ clinic: req.clinicId, year, active: true }).lean(),
    ]);
    if (rolls.length && !taxTable) warnings.add('MISSING_INCOME_TAX_TABLE', RDEP_WARNING.MISSING_INCOME_TAX_TABLE, { year });

    const employeesById = new Map(employees.map((e) => [String(e._id), e]));
    const deptById = new Map(departments.map((d) => [String(d._id), d]));
    const posById = new Map(positions.map((p) => [String(p._id), p]));
    const conceptById = new Map(concepts.map((c) => [String(c._id), c]));
    const byEmp = new Map();

    for (const p of rolls) {
      for (const it of p.items || []) {
        const employeeId = it.employee ? String(it.employee) : '';
        const employee = employeesById.get(employeeId);
        const department = deptById.get(String(employee?.departmentRef || it.departmentRef || ''));
        const position = posById.get(String(employee?.positionRef || ''));
        const key = employeeId || it.identificacion || it.employeeName || `item-${byEmp.size + 1}`;
        if (!byEmp.has(key)) byEmp.set(key, rdepNewEmployeeRow({ key, item: it, employee, department, position }));
        const row = byEmp.get(key);
        row.periodoFiscal = year;
        row.rolesCerrados.push({ payrollId: String(p._id), code: p.code || '', period: p.period || `${p.year}-${String(p.month).padStart(2, '0')}`, month: p.month, status: p.status });
        if (p.month) row._months.add(p.month);

        const warnCtx = { employeeId: row.employeeId, employeeName: row.nombre };
        if (!employee && employeeId) warnings.add('EMPLOYEE_NOT_FOUND', 'El rol referencia un empleado que no existe o no pertenece a la clinica.', { ...warnCtx, payrollId: String(p._id) });
        if (!row.identificacion) warnings.add('EMPLOYEE_MISSING_ID', RDEP_WARNING.EMPLOYEE_MISSING_ID, warnCtx);
        if (!row.fechaIngreso) warnings.add('EMPLOYEE_MISSING_HIRE_DATE', RDEP_WARNING.EMPLOYEE_MISSING_HIRE_DATE, warnCtx);
        if (!row.departamento) warnings.add('EMPLOYEE_MISSING_DEPARTMENT', RDEP_WARNING.EMPLOYEE_MISSING_DEPARTMENT, warnCtx);
        if (!row.cargo) warnings.add('EMPLOYEE_MISSING_POSITION', RDEP_WARNING.EMPLOYEE_MISSING_POSITION, warnCtx);

        let classifiedIncome = 0;
        const taxableFixed = rdepRound((it.baseSalary || 0) + (it.overtime || 0) + (it.bonuses || 0) + (it.commissions || 0));
        row.sueldoBase += rdepRound(it.baseSalary || 0);
        rdepAddIncome(row, 'gravado', taxableFixed);
        classifiedIncome += taxableFixed;

        for (const [bucket, value] of [
          ['decimoTercero', it.decimoTercero],
          ['decimoCuarto', it.decimoCuarto],
          ['fondosReserva', it.fondosReserva],
          ['vacaciones', it.vacaciones],
        ]) {
          const amount = rdepRound(value);
          rdepAddIncome(row, bucket, amount);
          classifiedIncome += amount;
        }

        const otherIncome = rdepRound(it.otherIncome || 0);
        if (otherIncome > 0) {
          rdepAddIncome(row, 'sinClasificar', otherIncome);
          classifiedIncome += otherIncome;
          warnings.add('UNCLASSIFIED_CONCEPTS', RDEP_WARNING.UNCLASSIFIED_CONCEPTS, { ...warnCtx, payrollId: String(p._id), field: 'otherIncome' });
        }

        for (const line of it.earnings || []) {
          const amount = rdepRound(line.amount);
          if (amount <= 0) continue;
          const conceptId = rdepConceptId(line);
          const concept = conceptId ? conceptById.get(conceptId) : null;
          const bucket = rdepClassifyIncome(line, concept);
          rdepAddIncome(row, bucket, amount);
          classifiedIncome += amount;
          if (!concept || bucket === 'sinClasificar') {
            warnings.add('UNCLASSIFIED_CONCEPTS', RDEP_WARNING.UNCLASSIFIED_CONCEPTS, {
              ...warnCtx,
              payrollId: String(p._id),
              conceptId,
              conceptCode: line.code || concept?.code || '',
              conceptName: line.name || concept?.name || '',
            });
          }
        }

        const actualIncome = rdepRound(it.totalIngresos);
        if (actualIncome > classifiedIncome + 0.01) {
          const diff = rdepRound(actualIncome - classifiedIncome);
          rdepAddIncome(row, 'sinClasificar', diff);
          classifiedIncome += diff;
          warnings.add('LEGACY_TOTALS_DERIVED', RDEP_WARNING.LEGACY_TOTALS_DERIVED, { ...warnCtx, payrollId: String(p._id), field: 'totalIngresos' });
        }
        row.totalIngresos += actualIncome > 0 ? actualIncome : classifiedIncome;

        let classifiedDeductions = 0;
        for (const [bucket, value] of [
          ['aporteIessPersonal', it.iessPersonal],
          ['impuestoRenta', it.impuestoRenta],
        ]) {
          const amount = rdepRound(value);
          rdepAddDeduction(row, bucket, amount);
          classifiedDeductions += amount;
        }
        row.aporteIessPatronal += rdepRound(it.iessPatronal || 0);

        const fixedDiscounts = rdepRound((it.prestamoIess || 0) + (it.prestamoEmpresa || 0) + (it.anticipos || 0) + (it.multas || 0) + (it.otherDeductions || 0));
        rdepAddDeduction(row, 'descuento', fixedDiscounts);
        classifiedDeductions += fixedDiscounts;

        for (const line of it.deductions || []) {
          const amount = rdepRound(line.amount);
          if (amount <= 0) continue;
          const conceptId = rdepConceptId(line);
          const concept = conceptId ? conceptById.get(conceptId) : null;
          const bucket = rdepClassifyDeduction(line, concept);
          rdepAddDeduction(row, bucket, amount);
          classifiedDeductions += amount;
          if (!concept || bucket === 'sinClasificar') {
            warnings.add('UNCLASSIFIED_CONCEPTS', RDEP_WARNING.UNCLASSIFIED_CONCEPTS, {
              ...warnCtx,
              payrollId: String(p._id),
              conceptId,
              conceptCode: line.code || concept?.code || '',
              conceptName: line.name || concept?.name || '',
            });
          }
        }

        const actualDeductions = rdepRound(it.totalEgresos);
        if (actualDeductions > classifiedDeductions + 0.01) {
          const diff = rdepRound(actualDeductions - classifiedDeductions);
          rdepAddDeduction(row, 'descuento', diff);
          classifiedDeductions += diff;
          warnings.add('LEGACY_TOTALS_DERIVED', RDEP_WARNING.LEGACY_TOTALS_DERIVED, { ...warnCtx, payrollId: String(p._id), field: 'totalEgresos' });
        }
        row.totalEgresos += actualDeductions > 0 ? actualDeductions : classifiedDeductions;
        row.netoPagado += it.netoPagar != null ? rdepRound(it.netoPagar) : rdepRound((actualIncome || classifiedIncome) - (actualDeductions || classifiedDeductions));
      }
    }
    const moneyFields = ['sueldoBase', 'sueldo', 'ingresosGravados', 'ingresosNoGravados', 'ingresoExento', 'decimoTercero', 'decimoCuarto', 'fondosReserva', 'vacaciones', 'aporteIessPersonal', 'aporteIessPatronal', 'aporteIess', 'impuestoRenta', 'baseImponible', 'otrosIngresos', 'otrosDescuentos', 'totalIngresos', 'totalEgresos', 'netoPagado'];
    const empleados = [...byEmp.values()].map((row) => {
      row.mesesTrabajados = row._months.size;
      delete row._months;
      row.ingresosGravados = rdepRound(row.ingresosGravados);
      row.ingresosNoGravados = rdepRound(row.ingresosNoGravados);
      row.sueldo = row.ingresosGravados; // compat con el RDEP anterior
      row.ingresoExento = row.ingresosNoGravados;
      row.aporteIess = row.aporteIessPersonal;
      row.baseImponible = rdepRound(Math.max(0, row.ingresosGravados - row.aporteIessPersonal));
      for (const field of moneyFields) row[field] = rdepRound(row[field]);
      return row;
    }).sort((a, b) => a.nombre.localeCompare(b.nombre));

    const totals = empleados.reduce((acc, e) => {
      for (const field of moneyFields) acc[field] = rdepRound((acc[field] || 0) + (e[field] || 0));
      acc.empleados += 1;
      acc.rolesCerrados += e.rolesCerrados.length;
      return acc;
    }, { empleados: 0, rolesCerrados: 0 });
    totals.mesesTrabajados = empleados.reduce((s, e) => s + e.mesesTrabajados, 0);
    const warningsPayload = warnings.list();

    if (req.query.format === 'xml') {
      const esc = (s) => String(s || '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
      let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<rdep preliminar="true">\n';
      xml += `  <Anio>${year}</Anio>\n  <IdInformante>${esc(clinic?.ruc)}</IdInformante>\n  <razonSocial>${esc(clinic?.razonSocial || clinic?.name)}</razonSocial>\n`;
      xml += '  <nota>Vista previa preliminar generada desde nominas cerradas/pagadas; validar contra el formato oficial vigente del SRI.</nota>\n';
      xml += '  <empleados>\n';
      for (const e of empleados) {
        xml += '    <empleado>\n';
        xml += `      <tipoIdentificacion>${esc(e.tipoIdentificacion || 'CEDULA')}</tipoIdentificacion>\n      <identificacion>${esc(e.identificacion)}</identificacion>\n      <nombre>${esc(e.nombre)}</nombre>\n`;
        xml += `      <fechaIngreso>${esc(e.fechaIngreso)}</fechaIngreso>\n      <fechaSalida>${esc(e.fechaSalida)}</fechaSalida>\n      <mesesTrabajados>${e.mesesTrabajados}</mesesTrabajados>\n`;
        xml += `      <sueldoBase>${e.sueldoBase.toFixed(2)}</sueldoBase>\n      <ingresosGravados>${e.ingresosGravados.toFixed(2)}</ingresosGravados>\n      <ingresosNoGravados>${e.ingresosNoGravados.toFixed(2)}</ingresosNoGravados>\n`;
        xml += `      <decimoTercero>${e.decimoTercero.toFixed(2)}</decimoTercero>\n      <decimoCuarto>${e.decimoCuarto.toFixed(2)}</decimoCuarto>\n      <fondosReserva>${e.fondosReserva.toFixed(2)}</fondosReserva>\n      <vacaciones>${e.vacaciones.toFixed(2)}</vacaciones>\n`;
        xml += `      <aporteIessPersonal>${e.aporteIessPersonal.toFixed(2)}</aporteIessPersonal>\n      <impuestoRentaRetenido>${e.impuestoRenta.toFixed(2)}</impuestoRentaRetenido>\n`;
        xml += `      <otrosIngresos>${e.otrosIngresos.toFixed(2)}</otrosIngresos>\n      <otrosDescuentos>${e.otrosDescuentos.toFixed(2)}</otrosDescuentos>\n`;
        xml += '    </empleado>\n';
      }
      xml += '  </empleados>\n  <advertencias>\n';
      for (const w of warningsPayload) xml += `    <advertencia codigo="${esc(w.code)}">${esc(w.message)}</advertencia>\n`;
      xml += '  </advertencias>\n</rdep>\n';
      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', `attachment; filename="RDEP-${year}.xml"`);
      return res.send(xml);
    }

    res.json({
      year,
      period: { label: `Anio fiscal ${year}`, periodType: 'ANNUAL', year },
      source: 'Payroll',
      includedStatuses: RDEP_INCLUDED_STATUSES,
      isPreliminary: true,
      nota: 'Vista previa preliminar generada desde nominas cerradas/pagadas. Validar contra el formato oficial vigente del SRI antes de declarar.',
      payrolls: {
        totalInYear: allRolls.length,
        included: rolls.length,
        draftExcluded,
        statusCounts,
      },
      empleados,
      totals,
      total: totals.impuestoRenta || 0,
      warnings: warningsPayload,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/**
 * Retenciones que nos efectúan terceros (recibidas): consolida las retenciones
 * de las liquidaciones de tarjeta de crédito por tipo y código SRI.
 */
exports.retentionsReceived = async (req, res) => {
  try {
    const CardSettlement = require('../models/CardSettlement');
    const range = resolveReportRange(req.query);
    const settlements = await CardSettlement.find({ clinic: req.clinicId, status: 'CONTABILIZADO', issueDate: { $gte: range.start, $lte: range.end } });
    const byCode = {};
    let total = 0;
    for (const s of settlements) {
      for (const r of s.retentions || []) {
        const key = `${r.type}-${r.sriCode || ''}`;
        if (!byCode[key]) byCode[key] = { type: r.type, sriCode: r.sriCode || '', base: 0, value: 0, count: 0 };
        byCode[key].base += r.base || 0;
        byCode[key].value += r.value || 0;
        byCode[key].count += 1;
        total += r.value || 0;
      }
    }
    res.json({ periodo: range.label, period: periodMeta(range), rows: Object.values(byCode), total: +total.toFixed(2) });
  } catch (e) { res.status(e.status || 500).json({ message: e.message }); }
};

/**
 * ATS — Anexo Transaccional Simplificado.
 *
 * Toda la lógica (mapeo de códigos del SRI, agrupaciones, orden del XSD) vive en
 * `utils/sriForms/ats.js`. Aquí solo quedan los tres endpoints, que salen del MISMO
 * `buildAts()`: la pantalla, el Excel y el XML no pueden discrepar entre sí.
 */
const ATS_MODELS = () => ({
  Invoice,
  PurchaseInvoice,
  Clinic: require('../models/Clinic'),
  RetentionVoucher: require('../models/RetentionVoucher'),
  InvoicingConfig: require('../models/InvoicingConfig'),
});

/** Datos del ATS del período pedido (uso interno de los tres endpoints). */
async function atsData(req) {
  const range = resolveReportRange(req.query);
  const data = await buildAts({ clinicId: req.clinicId, range, models: ATS_MODELS() });
  data.monthlyXmlAvailable = isMonthlyRange(range);
  data.salesPending = await countPendingSalesInRange(req.clinicId, range.start, range.end);
  return data;
}

/**
 * ATS visual (JSON): el detalle completo del anexo para revisarlo ANTES de generar el XML,
 * con los avisos de lo que el SRI rechazaría. Acepta cualquier período; el XML, solo mensual.
 */
exports.atsPreview = async (req, res) => {
  try {
    res.json(await atsData(req));
  } catch (e) { res.status(e.status || 500).json({ message: e.message }); }
};

/**
 * ATS en XML, con la estructura y el ORDEN del esquema oficial (ats.xsd). El ATS se declara
 * por MES, así que se bloquea cualquier período que no lo sea.
 *
 * Si faltan datos que el SRI exige (RUC del proveedor, autorización, secuencial, comprobante
 * de retención…) se responde 409 con la lista: es preferible decirlo aquí que dejar que el
 * portal del SRI lo rechace sin explicar cuál documento está mal. `?force=true` genera el
 * archivo de todos modos, para poder revisarlo.
 */
exports.ats = async (req, res) => {
  try {
    const range = resolveReportRange(req.query);
    if (!isMonthlyRange(range)) {
      return res.status(400).json({ message: 'El ATS se declara por MES. Cambie el período a "Mensual" para generar el XML.' });
    }
    const data = await buildAts({ clinicId: req.clinicId, range, models: ATS_MODELS() });
    if (data.errores.length && req.query.force !== 'true') {
      return res.status(409).json({
        message: 'El ATS tiene datos que el SRI rechazaría. Corrija estos documentos y vuelva a generarlo.',
        errores: data.errores,
        code: 'ATS_INCOMPLETO',
      });
    }
    const xml = atsXml(data);
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="${atsFileName(range.year, range.month)}"`);
    res.send(xml);
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message });
  }
};

/** ATS en Excel: una hoja por bloque del anexo (compras, ventas, establecimientos, anulados). */
exports.atsExcel = XL.excelHandler(async (req, res) => {
  const d = await atsData(req);
  const wb = XL.newWorkbook();
  const meta = [
    ['Reporte', 'ATS — Anexo Transaccional Simplificado'],
    ['Período', d.period?.label || ''],
    ['Informante', `${d.informante?.ruc || ''} — ${d.informante?.razonSocial || ''}`],
    ['Total ventas', d.informante?.totalVentas],
  ];

  XL.addSheet(wb, {
    title: 'Compras',
    meta,
    columns: [
      { header: 'Fecha emisión', key: 'fechaEmision', width: 14 },
      { header: 'Comprobante', key: '_serie', width: 20 },
      { header: 'Tipo', key: 'tipoComprobante', width: 8 },
      { header: 'Sustento', key: 'codSustento', width: 10 },
      { header: 'Tipo ID', key: 'tpIdProv', width: 8 },
      { header: 'RUC / Cédula', key: 'idProv', width: 16 },
      { header: 'Proveedor', key: '_proveedor', width: 34 },
      { header: 'Autorización', key: 'autorizacion', width: 26 },
      { header: 'Base no grava IVA', key: 'baseNoGraIva', width: 16, money: true },
      { header: 'Base 0%', key: 'baseImponible', width: 14, money: true },
      { header: 'Base gravada', key: 'baseImpGrav', width: 16, money: true },
      { header: 'Base exenta', key: 'baseImpExe', width: 14, money: true },
      { header: 'ICE', key: 'montoIce', width: 12, money: true },
      { header: 'IVA', key: 'montoIva', width: 14, money: true },
      { header: 'Ret. IVA', key: '_retIva', width: 14, money: true },
      { header: 'Ret. Renta', key: '_retRenta', width: 14, money: true },
      { header: 'N° retención', key: '_retencionNumero', width: 20 },
      { header: 'Total', key: '_total', width: 16, money: true },
    ],
    rows: d.compras || [],
    totals: {
      baseImponible: d.totals?.comprasBase0,
      baseImpGrav: d.totals?.comprasBaseGrav,
      montoIva: d.totals?.comprasIva,
      _retIva: d.totals?.comprasRetIva,
      _retRenta: d.totals?.comprasRetRenta,
      _total: d.totals?.comprasTotal,
    },
    notes: ['Códigos del SRI — Sustento: tabla 5. Tipo comprobante: tabla 4. Tipo ID proveedor: 01 RUC, 02 cédula, 03 pasaporte.'],
  });

  XL.addSheet(wb, {
    title: 'Ventas',
    meta,
    columns: [
      { header: 'Tipo ID', key: 'tpIdCliente', width: 8 },
      { header: 'Identificación', key: 'idCliente', width: 18 },
      { header: 'Cliente', key: 'denoCli', width: 36 },
      { header: 'Tipo comprobante', key: 'tipoComprobante', width: 16 },
      { header: 'Emisión', key: 'tipoEmision', width: 10 },
      { header: 'N° comprobantes', key: 'numeroComprobantes', width: 16, number: true },
      { header: 'Base no grava IVA', key: 'baseNoGraIva', width: 16, money: true },
      { header: 'Base 0%', key: 'baseImponible', width: 14, money: true },
      { header: 'Base gravada', key: 'baseImpGrav', width: 16, money: true },
      { header: 'IVA', key: 'montoIva', width: 14, money: true },
      { header: 'Ret. IVA', key: 'valorRetIva', width: 14, money: true },
      { header: 'Ret. Renta', key: 'valorRetRenta', width: 14, money: true },
      { header: 'Total', key: '_total', width: 16, money: true },
    ],
    rows: d.ventas || [],
    totals: {
      numeroComprobantes: d.totals?.ventasCount,
      baseImponible: d.totals?.ventasBase0,
      baseImpGrav: d.totals?.ventasBaseGrav,
      montoIva: d.totals?.ventasIva,
      _total: d.totals?.ventasTotal,
    },
    notes: [
      'Ventas agrupadas por cliente y tipo de comprobante, como las exige el ATS.',
      'Solo se incluyen facturas electrónicas AUTORIZADAS.',
      d.salesPending > 0 ? `⚠ Hay ${d.salesPending} venta(s) registrada(s) SIN autorizar en el período: no entran en el anexo.` : '',
    ].filter(Boolean),
  });

  XL.addSheet(wb, {
    title: 'Ventas por establecimiento',
    meta,
    columns: [
      { header: 'Establecimiento', key: 'codEstab', width: 18 },
      { header: 'Ventas', key: 'ventasEstab', width: 18, money: true },
      { header: 'IVA compensación', key: 'ivaComp', width: 18, money: true },
    ],
    rows: d.ventasEstablecimiento || [],
  });

  XL.addSheet(wb, {
    title: 'Anulados',
    meta,
    columns: [
      { header: 'Fecha', key: '_fecha', width: 14 },
      { header: 'Tipo comprobante', key: 'tipoComprobante', width: 16 },
      { header: 'Establecimiento', key: 'establecimiento', width: 16 },
      { header: 'Punto emisión', key: 'puntoEmision', width: 14 },
      { header: 'Secuencial desde', key: 'secuencialInicio', width: 18 },
      { header: 'Secuencial hasta', key: 'secuencialFin', width: 18 },
      { header: 'Autorización', key: 'autorizacion', width: 26 },
    ],
    rows: d.anulados || [],
    notes: ['Comprobantes anulados del período. Se declara uno por fila (inicio = fin) para no agrupar rangos con huecos.'],
  });

  if (d.errores?.length) {
    XL.addSheet(wb, {
      title: 'Errores por corregir',
      meta,
      columns: [{ header: 'Problema detectado', key: 'error', width: 110 }],
      rows: d.errores.map((error) => ({ error })),
      notes: ['El SRI rechazaría el anexo con estos datos faltantes. Corrija los documentos y vuelva a generarlo.'],
    });
  }

  await XL.sendWorkbook(res, wb, `ATS_${d.period?.year || ''}_${String(d.period?.month || '').padStart(2, '0')}.xlsx`);
});

// ═══════════════════════ EXPORTACIONES A EXCEL ═══════════════════════════════
//
// Pedido del contador: TODO reporte o consulta se debe poder bajar en Excel. Cada exportación
// reutiliza el controlador JSON de su pantalla (`XL.captureJson`), de modo que el archivo y la
// pantalla no puedan discrepar nunca: hay una sola consulta y una sola aritmética.

/** Aplana el árbol de cuentas de los estados financieros a filas con nivel de sangría. */
function flattenAccountTree(nodes, level = 0, out = [], columns = []) {
  for (const n of nodes || []) {
    const fila = {
      code: n.code || '',
      name: `${'    '.repeat(level)}${n.name || ''}`,
      balance: n.balance ?? n.total ?? 0,
      level,
    };
    // Desglose en columnas (mes / centro de costo / sede): el Excel sale igual que la
    // pantalla, que es lo que se pidió — no una versión recortada.
    for (const c of columns) fila[`col_${c.key}`] = n.values?.[c.key] || 0;
    out.push(fila);
    if (n.children?.length) flattenAccountTree(n.children, level + 1, out, columns);
  }
  return out;
}

const ACCOUNT_TREE_COLUMNS = [
  { header: 'Código', key: 'code', width: 16 },
  { header: 'Cuenta', key: 'name', width: 52 },
  { header: 'Saldo', key: 'balance', width: 18, money: true },
];

/** Columnas del Excel cuando el reporte viene desglosado: una por mes/centro/sede + Total. */
const accountTreeColumnsWith = (columns = []) => (
  columns.length
    ? [
      { header: 'Código', key: 'code', width: 16 },
      { header: 'Cuenta', key: 'name', width: 52 },
      ...columns.map((c) => ({ header: c.label, key: `col_${c.key}`, width: 16, money: true })),
      { header: 'Total', key: 'balance', width: 18, money: true },
    ]
    : ACCOUNT_TREE_COLUMNS
);

const BREAKDOWN_LABELS = { month: 'Mes', costCenter: 'Centro de costo', clinic: 'Sede' };

/** ESTADO DE RESULTADOS en Excel (jerárquico + cascada tributaria). */
exports.incomeStatementExcel = XL.excelHandler(async (req, res) => {
  const d = await XL.captureJson(exports.incomeStatement, req);
  const wb = XL.newWorkbook();
  const meta = [['Reporte', 'Estado de Resultados'], ['Período', XL.periodLabel(req.query)]];

  const columns = d.columns || [];
  if (columns.length) meta.push(['Desglose', BREAKDOWN_LABELS[d.breakdown] || d.breakdown]);

  XL.addSheet(wb, {
    title: 'Estado de Resultados',
    meta,
    columns: accountTreeColumnsWith(columns),
    rows: flattenAccountTree(d.tree, 0, [], columns),
    notes: ['Cuentas jerárquicas: los grupos muestran el subtotal de sus cuentas hijas.'],
  });

  // Hoja con la lectura por columna: ventas, costos, gastos, utilidad y margen de
  // cada mes / centro de costo / sede, que es como se revisa el reporte.
  if (columns.length) {
    XL.addSheet(wb, {
      title: 'Por columna',
      meta,
      columns: [
        { header: BREAKDOWN_LABELS[d.breakdown] || 'Columna', key: 'label', width: 30 },
        { header: 'Ingresos', key: 'totalIngresos', width: 16, money: true },
        { header: 'Costos', key: 'totalCostos', width: 16, money: true },
        { header: 'Utilidad bruta', key: 'utilidadBruta', width: 16, money: true },
        { header: 'Gastos', key: 'totalGastos', width: 16, money: true },
        { header: 'Utilidad operacional', key: 'utilidadOperacional', width: 20, money: true },
        { header: 'Margen %', key: 'margen', width: 12 },
      ],
      rows: columns.map((c) => ({ label: c.label, ...(d.porColumna?.[c.key] || {}) })),
      totals: {
        totalIngresos: d.totalIngresos,
        totalCostos: d.totalCostos,
        utilidadBruta: d.utilidadBruta,
        totalGastos: d.totalGastos,
        utilidadOperacional: d.utilidadOperacional,
      },
      totalsLabel: 'TOTAL',
    });
  }

  XL.addKeyValueSheet(wb, {
    title: 'Resumen',
    meta,
    sections: [
      {
        title: 'RESULTADO DEL EJERCICIO',
        rows: [
          ['Ingresos', d.totalIngresos],
          ['(−) Costos', d.totalCostos],
          ['(=) Utilidad bruta', d.utilidadBruta],
          ['(−) Gastos', d.totalGastos],
        ],
        total: ['(=) Utilidad operacional', d.utilidadOperacional],
      },
      {
        title: 'CASCADA TRIBUTARIA (estimada)',
        rows: [
          ['Utilidad antes de participación', d.utilidadAntesParticipacion],
          [`(−) Participación trabajadores (${((d.profitSharingRate || 0) * 100).toFixed(0)}%)`, d.participacionTrabajadores],
          ['(=) Utilidad antes de impuesto a la renta', d.utilidadAntesImpuesto],
          [`(−) Impuesto a la renta (${((d.incomeTaxRate || 0) * 100).toFixed(0)}%)`, d.impuestoRenta],
        ],
        total: ['(=) UTILIDAD NETA', d.utilidadNeta],
      },
    ],
    notes: ['La cascada tributaria es una ESTIMACIÓN con las tasas configuradas; no sustituye la declaración.'],
  });

  await XL.sendWorkbook(res, wb, `estado_resultados_${Date.now()}.xlsx`);
});

/** BALANCE GENERAL en Excel (activo / pasivo / patrimonio + comprobación del cuadre). */
exports.balanceSheetExcel = XL.excelHandler(async (req, res) => {
  const d = await XL.captureJson(exports.balanceSheet, req);
  const wb = XL.newWorkbook();
  const meta = [['Reporte', 'Balance General'], ['Corte', req.query.date ? XL.xlsDate(req.query.date) : 'A la fecha']];

  const columnsBg = d.columns || [];
  if (columnsBg.length) meta.push(['Desglose', BREAKDOWN_LABELS[d.breakdown] || d.breakdown]);

  for (const [title, nodes, total] of [
    ['Activos', d.tree?.activos, d.totalActivos],
    ['Pasivos', d.tree?.pasivos, d.totalPasivos],
    ['Patrimonio', d.tree?.patrimonio, d.totalPatrimonio],
  ]) {
    XL.addSheet(wb, {
      title,
      meta,
      columns: accountTreeColumnsWith(columnsBg),
      rows: flattenAccountTree(nodes, 0, [], columnsBg),
      totals: { balance: total },
      totalsLabel: `TOTAL ${title.toUpperCase()}`,
    });
  }

  XL.addKeyValueSheet(wb, {
    title: 'Cuadre',
    meta,
    sections: [{
      title: 'ECUACIÓN CONTABLE',
      rows: [
        ['Total activos', d.totalActivos],
        ['Total pasivos', d.totalPasivos],
        ['Utilidad del ejercicio', d.utilidadEjercicio],
        ['Total patrimonio (incluye utilidad)', d.totalPatrimonio],
        ['Pasivo + Patrimonio', d.totalPasivoPatrimonio],
      ],
      total: ['DESCUADRE (debe ser 0)', d.descuadre],
    }],
    notes: [Math.abs(Number(d.descuadre) || 0) > 0.005
      ? '⚠ El balance NO cuadra. Revise el Libro Mayor de las cuentas afectadas antes de presentar este reporte.'
      : 'El balance cuadra: Activo = Pasivo + Patrimonio.'],
  });

  await XL.sendWorkbook(res, wb, `balance_general_${Date.now()}.xlsx`);
});

/** SALDOS POR PERÍODO en Excel (apertura, movimiento y cierre por cuenta). */
exports.periodBalancesExcel = XL.excelHandler(async (req, res) => {
  const d = await XL.captureJson(exports.periodBalances, req);
  const rows = (d.rows || []).map((r) => ({
    code: r.account?.code || '', name: r.account?.name || '', type: r.account?.type || '',
    nature: r.account?.nature || '', opening: r.opening, debit: r.debit, credit: r.credit, closing: r.closing,
  }));
  const wb = XL.newWorkbook();
  XL.addSheet(wb, {
    title: 'Saldos por período',
    meta: [['Reporte', 'Saldos por período'], ['Año', d.year], ['Mes', d.month || 'Todo el año']],
    columns: [
      { header: 'Código', key: 'code', width: 16 },
      { header: 'Cuenta', key: 'name', width: 44 },
      { header: 'Tipo', key: 'type', width: 14 },
      { header: 'Naturaleza', key: 'nature', width: 12 },
      { header: 'Saldo inicial', key: 'opening', width: 16, money: true },
      { header: 'Débito', key: 'debit', width: 16, money: true },
      { header: 'Crédito', key: 'credit', width: 16, money: true },
      { header: 'Saldo final', key: 'closing', width: 16, money: true },
    ],
    rows,
    totals: {
      debit: +rows.reduce((s, r) => s + (r.debit || 0), 0).toFixed(2),
      credit: +rows.reduce((s, r) => s + (r.credit || 0), 0).toFixed(2),
    },
  });
  await XL.sendWorkbook(res, wb, `saldos_periodo_${d.year || ''}${d.month ? `_${d.month}` : ''}.xlsx`);
});

/** INDICADORES FINANCIEROS en Excel (ratios + punto de equilibrio). */
exports.indicatorsExcel = XL.excelHandler(async (req, res) => {
  const d = await XL.captureJson(exports.financialIndicators, req);
  const r = d.ratios || {};
  const pe = d.puntoEquilibrio || {};
  const wb = XL.newWorkbook();
  XL.addKeyValueSheet(wb, {
    title: 'Indicadores',
    meta: [['Reporte', 'Indicadores financieros'], ['Período', XL.periodLabel(req.query)]],
    sections: [
      { title: 'BALANCE', rows: Object.entries(d.balance || {}).map(([k, v]) => [k, v]) },
      { title: 'RESULTADOS', rows: Object.entries(d.resultados || {}).map(([k, v]) => [k, v]) },
      {
        title: 'RAZONES FINANCIERAS',
        rows: [
          ['Razón corriente (activo cte. / pasivo cte.)', r.razonCorriente],
          ['Prueba ácida', r.pruebaAcida],
          ['Capital de trabajo', r.capitalTrabajo],
          ['Endeudamiento (pasivo / activo)', r.endeudamiento],
          ['Apalancamiento (pasivo / patrimonio)', r.apalancamiento],
          ['Margen neto', r.margenNeto],
          ['ROA (utilidad / activo)', r.roa],
          ['ROE (utilidad / patrimonio)', r.roe],
        ],
      },
      {
        title: 'PUNTO DE EQUILIBRIO',
        rows: [
          ['Índice de contribución', pe.contributionRatio],
          ['Ventas de equilibrio', pe.ventasEquilibrio],
          ['Ventas actuales', pe.ventasActuales],
          ['Margen de seguridad (%)', pe.margenSeguridad],
        ],
      },
    ],
    notes: ['Las razones son índices (no montos): interprételas como proporción, no como dólares.'],
  });
  await XL.sendWorkbook(res, wb, `indicadores_${Date.now()}.xlsx`);
});

/** GASTOS NO DEDUCIBLES en Excel. */
exports.nonDeductibleExcel = XL.excelHandler(async (req, res) => {
  const d = await XL.captureJson(exports.nonDeductibleExpenses, req);
  const wb = XL.newWorkbook();
  // Hoja 1: el detalle (es lo que sirve para justificar el gasto ante el SRI).
  XL.addSheet(wb, {
    title: 'Detalle',
    meta: [['Reporte', 'Gastos no deducibles'], ['Período', XL.periodLabel(req.query)]],
    columns: [
      { header: 'Fecha', key: 'fecha', width: 12 },
      { header: 'Asiento', key: 'asiento', width: 16 },
      { header: 'Cuenta', key: 'cuenta', width: 44 },
      { header: 'Concepto', key: 'concepto', width: 40 },
      { header: 'Proveedor', key: 'proveedor', width: 28 },
      { header: 'Documento', key: 'documento', width: 20 },
      { header: 'Monto', key: 'monto', width: 16, money: true },
    ],
    rows: (d.rows || []).map((r) => ({
      fecha: r.date ? new Date(r.date).toLocaleDateString('es-EC') : '',
      asiento: r.asiento,
      cuenta: `${r.cuenta?.code || ''} ${r.cuenta?.name || ''}`.trim(),
      concepto: r.concepto, proveedor: r.proveedor, documento: r.documento, monto: r.monto,
    })),
    totals: { monto: d.total },
    notes: ['Cuentas 6.3.x — gastos que NO son deducibles del impuesto a la renta.'],
  });
  XL.addSheet(wb, {
    title: 'Por cuenta',
    columns: [
      { header: 'Código', key: 'code', width: 16 },
      { header: 'Cuenta', key: 'name', width: 50 },
      { header: 'Movimientos', key: 'count', width: 14 },
      { header: 'Monto', key: 'amount', width: 18, money: true },
    ],
    rows: d.byAccount || [],
    totals: { amount: d.total },
  });
  await XL.sendWorkbook(res, wb, `gastos_no_deducibles_${Date.now()}.xlsx`);
});

/** CONTROL DE ANTICIPOS en Excel: uno por uno, con persona y documento. */
exports.advancesExcel = XL.excelHandler(async (req, res) => {
  const d = await XL.captureJson(exports.advancesControl, req);
  const wb = XL.newWorkbook();
  XL.addSheet(wb, {
    title: 'Anticipos',
    meta: [
      ['Reporte', 'Control de anticipos'],
      ['Período', XL.periodLabel(req.query)],
      ['Anticipos de clientes', d.totals?.clientes || 0],
      ['Anticipos a proveedores', d.totals?.proveedores || 0],
    ],
    columns: [
      { header: 'Fecha', key: 'fecha', width: 12 },
      { header: 'Tipo', key: 'tipo', width: 12 },
      { header: 'Persona', key: 'persona', width: 32 },
      { header: 'Documento', key: 'documento', width: 20 },
      { header: 'Concepto', key: 'concepto', width: 36 },
      { header: 'Cuenta', key: 'cuenta', width: 34 },
      { header: 'Monto', key: 'monto', width: 16, money: true },
    ],
    rows: (d.rows || []).map((r) => ({
      fecha: r.date ? new Date(r.date).toLocaleDateString('es-EC') : '',
      tipo: r.tipo === 'CLIENTE' ? 'De cliente' : 'A proveedor',
      persona: r.persona, documento: r.documento, concepto: r.concepto,
      cuenta: `${r.cuenta?.code || ''} ${r.cuenta?.name || ''}`.trim(),
      monto: r.monto,
    })),
  });
  await XL.sendWorkbook(res, wb, `anticipos_${Date.now()}.xlsx`);
});

/** INVENTARIO VALORIZADO en Excel. */
exports.inventoryExcel = XL.excelHandler(async (req, res) => {
  const d = await XL.captureJson(exports.inventoryReport, req);
  const wb = XL.newWorkbook();
  XL.addSheet(wb, {
    title: 'Inventario valorizado',
    meta: [['Reporte', 'Inventario valorizado'], ['Unidades totales', d.totals?.units]],
    columns: [
      { header: 'Código', key: 'code', width: 16 },
      { header: 'Producto', key: 'name', width: 44 },
      { header: 'Tipo', key: 'category', width: 14 },
      { header: 'Stock', key: 'stock', width: 12, number: true },
      { header: 'Costo unitario', key: 'purchasePrice', width: 16, money: true },
      { header: 'Precio venta', key: 'salePrice', width: 16, money: true },
      { header: 'Valor al costo', key: 'valueAtCost', width: 18, money: true },
      { header: 'Valor a precio de venta', key: 'valueAtSale', width: 20, money: true },
    ],
    rows: d.rows || [],
    totals: { valueAtCost: d.totals?.valueAtCost, valueAtSale: d.totals?.valueAtSale, stock: d.totals?.units },
    notes: ['El costo unitario es el promedio del kardex (calculado desde las compras), no un precio digitado.'],
  });
  await XL.sendWorkbook(res, wb, `inventario_valorizado_${Date.now()}.xlsx`);
});

/** RENTABILIDAD POR MÉDICO / centro de costo en Excel. */
exports.profitabilityExcel = XL.excelHandler(async (req, res) => {
  const d = await XL.captureJson(exports.profitabilityByDoctor, req);
  const rows = d.rows || [];
  const wb = XL.newWorkbook();
  XL.addSheet(wb, {
    title: 'Rentabilidad',
    meta: [['Reporte', 'Rentabilidad por médico'], ['Período', XL.periodLabel({ startDate: req.query.from, endDate: req.query.to })]],
    columns: [
      { header: 'Médico', key: 'doctorName', width: 34 },
      { header: 'Ingresos', key: 'ingreso', width: 18, money: true },
      { header: 'Costos', key: 'costo', width: 18, money: true },
      { header: 'Gastos', key: 'gasto', width: 18, money: true },
      { header: 'Margen', key: 'margen', width: 18, money: true },
    ],
    rows,
    totals: {
      ingreso: +rows.reduce((s, r) => s + (r.ingreso || 0), 0).toFixed(2),
      costo: +rows.reduce((s, r) => s + (r.costo || 0), 0).toFixed(2),
      gasto: +rows.reduce((s, r) => s + (r.gasto || 0), 0).toFixed(2),
      margen: +rows.reduce((s, r) => s + (r.margen || 0), 0).toFixed(2),
    },
  });
  await XL.sendWorkbook(res, wb, `rentabilidad_medico_${Date.now()}.xlsx`);
});

/** MOVIMIENTOS DE UNA CUENTA (consulta de cuenta) en Excel. */
exports.accountFlowExcel = XL.excelHandler(async (req, res) => {
  const d = await XL.captureJson(exports.accountFlow, req);
  const wb = XL.newWorkbook();
  const meta = [
    ['Reporte', 'Movimientos de la cuenta'],
    ['Cuenta', `${d.account?.code || ''} - ${d.account?.name || ''}`.trim()],
    ['Período', XL.periodLabel(req.query)],
  ];
  XL.addSheet(wb, {
    title: 'Movimientos',
    meta,
    columns: [
      { header: 'Fecha', key: 'date', width: 12, date: true },
      { header: 'Asiento', key: 'number', width: 14 },
      { header: 'Descripción', key: 'description', width: 48 },
      { header: 'Origen', key: 'source', width: 16 },
      { header: 'Débito', key: 'debit', width: 14, money: true },
      { header: 'Crédito', key: 'credit', width: 14, money: true },
      { header: 'Saldo', key: 'saldo', width: 14, money: true },
    ],
    rows: d.ledger || [],
  });
  if (d.counterpartSummary?.length) {
    XL.addSheet(wb, {
      title: 'Contrapartidas',
      meta,
      columns: [
        { header: 'Código', key: 'code', width: 16 },
        { header: 'Cuenta', key: 'name', width: 44 },
        { header: 'Débito', key: 'debit', width: 16, money: true },
        { header: 'Crédito', key: 'credit', width: 16, money: true },
      ],
      rows: d.counterpartSummary,
    });
  }
  await XL.sendWorkbook(res, wb, `cuenta_${String(d.account?.code || '').replace(/[^\w.-]+/g, '_')}.xlsx`);
});

/** REPORTE GENERAL (consolidado de gestión) en Excel. */
exports.generalReportExcel = XL.excelHandler(async (req, res) => {
  const d = await XL.captureJson(exports.generalReport, req);
  const wb = XL.newWorkbook();
  const meta = [['Reporte', 'General consolidado'], ['Período', XL.periodLabel(req.query)]];

  XL.addKeyValueSheet(wb, {
    title: 'Resumen',
    meta,
    sections: [
      {
        title: 'VENTAS',
        rows: [
          ['Ventas (total)', d.sales?.total],
          ['N° de ventas', d.sales?.count],
          ['Ventas anuladas (total)', d.voided?.total],
          ['N° de ventas anuladas', d.voided?.count],
          ['Costo de ventas', d.cost],
          ['Utilidad bruta', d.grossProfit],
          ['Margen (%)', d.margin],
        ],
      },
      { title: 'COBROS', rows: Object.entries(d.collections || {}).map(([k, v]) => [k, v]) },
      {
        title: 'COMPRAS Y CUENTAS POR PAGAR',
        rows: [
          ['Compras (total)', d.purchases?.total],
          ['N° de compras', d.purchases?.count],
          ['Cuentas por pagar (saldo)', d.accountsPayable?.total],
          ['N° de facturas por pagar', d.accountsPayable?.count],
        ],
      },
      {
        title: 'INVENTARIO',
        rows: [
          ['Unidades', d.inventory?.units],
          ['Valor al costo', d.inventory?.valueAtCost],
          ['Valor a precio de venta', d.inventory?.valueAtSale],
        ],
      },
    ],
  });

  if (d.byPeriod?.length) {
    XL.addSheet(wb, {
      title: 'Ventas por período',
      meta,
      columns: [
        { header: 'Período', key: 'period', width: 18 },
        { header: 'N° ventas', key: 'count', width: 14, number: true },
        { header: 'Total', key: 'total', width: 18, money: true },
      ],
      rows: d.byPeriod,
      totals: { total: +d.byPeriod.reduce((s, p) => s + (p.total || 0), 0).toFixed(2) },
    });
  }
  if (d.topProducts?.length) {
    XL.addSheet(wb, {
      title: 'Productos más vendidos',
      meta,
      columns: [
        { header: 'Producto', key: 'name', width: 44 },
        { header: 'Cantidad', key: 'qty', width: 14, number: true },
        { header: 'Total', key: 'total', width: 18, money: true },
      ],
      rows: d.topProducts,
    });
  }
  await XL.sendWorkbook(res, wb, `reporte_general_${Date.now()}.xlsx`);
});

// ─────────────────────────── Reportes SRI en Excel ───────────────────────────

/** FORMULARIO 104 (IVA) — preliquidación en Excel. */
exports.form104Excel = XL.excelHandler(async (req, res) => {
  const d = await XL.captureJson(exports.form104, req);
  const wb = XL.newWorkbook();
  XL.addKeyValueSheet(wb, {
    title: 'Formulario 104',
    meta: [['Reporte', 'Formulario 104 — IVA (preliquidación)'], ['Período', d.periodo || d.period?.label || '']],
    sections: [
      {
        title: 'VENTAS',
        rows: [
          ['Base tarifa 0%', d.ventas?.base0],
          ['Base gravada', d.ventas?.baseGravada],
          ['Base imponible total', d.ventas?.base],
          ['IVA generado', d.ventas?.iva],
        ],
      },
      {
        title: 'COMPRAS',
        rows: [
          ['Base imponible', d.compras?.base],
          ['IVA', d.compras?.iva],
          ['IVA con crédito tributario', d.compras?.ivaCredito],
          ['IVA sin crédito (al gasto)', d.compras?.ivaNoCredito],
          ['Retención de IVA que nos hicieron', d.compras?.retIVA],
        ],
        total: ['IVA POR PAGAR (estimado)', d.ivaPorPagar],
      },
    ],
    notes: [
      d.nota || '',
      'Preliquidación de SOLO LECTURA. La declaración formal se hace en Declaraciones SRI.',
    ].filter(Boolean),
  });
  await XL.sendWorkbook(res, wb, `form104_${Date.now()}.xlsx`);
});

/** FORMULARIO 103 (retenciones en la fuente) — preliquidación en Excel. */
exports.form103Excel = XL.excelHandler(async (req, res) => {
  const d = await XL.captureJson(exports.form103, req);
  const wb = XL.newWorkbook();
  XL.addSheet(wb, {
    title: 'Formulario 103',
    meta: [['Reporte', 'Formulario 103 — Retenciones en la fuente'], ['Período', d.periodo || d.period?.label || '']],
    columns: [
      { header: 'Código', key: 'code', width: 14 },
      { header: 'Descripción', key: 'description', width: 52 },
      { header: 'Base', key: 'base', width: 18, money: true },
      { header: 'Valor retenido', key: 'amount', width: 18, money: true },
    ],
    rows: d.rows || [],
    totals: { amount: d.total },
  });
  await XL.sendWorkbook(res, wb, `form103_${Date.now()}.xlsx`);
});

/** RETENCIONES RECIBIDAS (las que nos efectúan terceros) en Excel. */
exports.retentionsReceivedExcel = XL.excelHandler(async (req, res) => {
  const d = await XL.captureJson(exports.retentionsReceived, req);
  const wb = XL.newWorkbook();
  XL.addSheet(wb, {
    title: 'Retenciones recibidas',
    meta: [['Reporte', 'Retenciones que nos efectuaron'], ['Período', d.periodo || '']],
    columns: [
      { header: 'Tipo', key: 'type', width: 14 },
      { header: 'Código SRI', key: 'sriCode', width: 14 },
      { header: 'N° comprobantes', key: 'count', width: 18, number: true },
      { header: 'Base', key: 'base', width: 18, money: true },
      { header: 'Valor', key: 'value', width: 18, money: true },
    ],
    rows: d.rows || [],
    totals: { value: d.total },
  });
  await XL.sendWorkbook(res, wb, `retenciones_recibidas_${Date.now()}.xlsx`);
});

/** RDEP (relación de dependencia) en Excel. */
exports.rdepExcel = XL.excelHandler(async (req, res) => {
  const d = await XL.captureJson(exports.rdep, req);
  const wb = XL.newWorkbook();
  XL.addSheet(wb, {
    title: 'RDEP',
    meta: [
      ['Reporte', 'RDEP — Retenciones en relación de dependencia'],
      ['Año', d.year],
      ['Empleados', d.totals?.empleados],
      ['Roles incluidos', d.payrolls?.included],
    ],
    columns: [
      { header: 'Tipo id.', key: 'tipoIdentificacion', width: 12 },
      { header: 'Identificación', key: 'identificacion', width: 16 },
      { header: 'Nombre', key: 'nombre', width: 34 },
      { header: 'Meses trabajados', key: 'mesesTrabajados', width: 16, number: true },
      { header: 'Sueldo base', key: 'sueldoBase', width: 16, money: true },
      { header: 'Ingresos gravados', key: 'ingresosGravados', width: 18, money: true },
      { header: 'Ingresos no gravados', key: 'ingresosNoGravados', width: 18, money: true },
      { header: 'Décimo tercero', key: 'decimoTercero', width: 16, money: true },
      { header: 'Décimo cuarto', key: 'decimoCuarto', width: 16, money: true },
      { header: 'Fondos de reserva', key: 'fondosReserva', width: 16, money: true },
      { header: 'Vacaciones', key: 'vacaciones', width: 14, money: true },
      { header: 'IESS personal', key: 'aporteIessPersonal', width: 16, money: true },
      { header: 'IESS patronal', key: 'aporteIessPatronal', width: 16, money: true },
      { header: 'Base imponible', key: 'baseImponible', width: 16, money: true },
      { header: 'IR retenido', key: 'impuestoRenta', width: 16, money: true },
      { header: 'Otros descuentos', key: 'otrosDescuentos', width: 16, money: true },
      { header: 'Neto pagado', key: 'netoPagado', width: 16, money: true },
    ],
    rows: d.empleados || [],
    totals: d.totals || {},
    notes: [d.nota, ...(d.warnings || []).map((w) => `⚠ ${w.message}`)].filter(Boolean),
  });
  await XL.sendWorkbook(res, wb, `rdep_${d.year || ''}.xlsx`);
});

/**
 * SUB-REPORTES DE VENTAS en Excel (por período, producto, vendedor, cajero, costo y costo
 * por categoría). Comparten un endpoint porque comparten forma: la única diferencia son las
 * columnas, así que declararlas en una tabla evita seis controladores casi idénticos.
 */
const SALES_SUBREPORTS = {
  'by-period': {
    handler: () => exports.salesByPeriod,
    title: 'Ventas por período',
    columns: [
      { header: 'Período', key: '_id', width: 18 },
      { header: 'N° ventas', key: 'count', width: 14, number: true },
      { header: 'Subtotal', key: 'subtotal', width: 16, money: true },
      { header: 'IVA', key: 'tax', width: 16, money: true },
      { header: 'Total', key: 'total', width: 18, money: true },
    ],
  },
  'by-product': {
    handler: () => exports.salesByProduct,
    title: 'Ventas por producto',
    map: (r) => ({ name: r._id?.name || '—', code: r.code || '', qty: r.qty, subtotal: r.subtotal }),
    columns: [
      { header: 'Código', key: 'code', width: 16 },
      { header: 'Producto', key: 'name', width: 44 },
      { header: 'Cantidad', key: 'qty', width: 14, number: true },
      { header: 'Total', key: 'subtotal', width: 18, money: true },
    ],
  },
  'by-seller': {
    handler: () => exports.salesBySeller,
    title: 'Ventas por vendedor',
    map: (r) => ({ name: r._id?.name || 'Sin asignar', count: r.count, total: r.total }),
    columns: [
      { header: 'Vendedor', key: 'name', width: 34 },
      { header: 'N° ventas', key: 'count', width: 14, number: true },
      { header: 'Total', key: 'total', width: 18, money: true },
    ],
  },
  'by-cashier': {
    handler: () => exports.salesByCashier,
    title: 'Ventas por cajero',
    map: (r) => ({ name: r._id?.name || 'Sin asignar', count: r.count, total: r.total }),
    columns: [
      { header: 'Cajero', key: 'name', width: 34 },
      { header: 'N° ventas', key: 'count', width: 14, number: true },
      { header: 'Total', key: 'total', width: 18, money: true },
    ],
  },
  'cost-by-category': {
    handler: () => exports.costOfSalesByCategory,
    title: 'Costo por categoría',
    columns: [
      { header: 'Categoría', key: 'category', width: 30 },
      { header: 'Cantidad', key: 'qty', width: 14, number: true },
      { header: 'Ingresos', key: 'revenue', width: 18, money: true },
      { header: 'Costo', key: 'cost', width: 18, money: true },
      { header: 'Utilidad bruta', key: 'grossProfit', width: 18, money: true },
      { header: 'Margen %', key: 'margin', width: 12, number: true },
    ],
  },
};

exports.salesSubreportExcel = XL.excelHandler(async (req, res) => {
  const key = String(req.params.report || '');
  // Costo de venta: el resumen de tres cifras y, en otra hoja, el detalle de lo
  // vendido (producto, cantidad, precio de venta, costo y factura asociada).
  if (key === 'cost') {
    const d = await XL.captureJson(exports.costOfSales, req);
    const wb = XL.newWorkbook();
    XL.addKeyValueSheet(wb, {
      title: 'Costo de venta',
      meta: [['Reporte', 'Costo de venta'], ['Período', XL.periodLabel(req.query)]],
      sections: [{
        title: 'RESULTADO',
        rows: [['Ventas', d.totalSales], ['Costo de venta', d.totalCost]],
        total: ['Utilidad bruta', d.grossProfit],
      }],
    });
    XL.addSheet(wb, {
      title: 'Detalle',
      columns: [
        { header: 'Fecha', key: 'fecha', width: 12 },
        { header: 'Venta', key: 'venta', width: 14 },
        { header: 'Factura', key: 'factura', width: 18 },
        { header: 'Cliente', key: 'cliente', width: 28 },
        { header: 'Código', key: 'codigo', width: 14 },
        { header: 'Producto / servicio', key: 'producto', width: 34 },
        { header: 'Cantidad', key: 'cantidad', width: 10, number: true },
        { header: 'Precio de venta', key: 'precioVenta', width: 15, money: true },
        { header: 'Ingreso', key: 'ingreso', width: 14, money: true },
        { header: 'Costo unitario', key: 'costoUnitario', width: 15, money: true },
        { header: 'Costo', key: 'costo', width: 14, money: true },
        { header: 'Utilidad', key: 'utilidad', width: 14, money: true },
      ],
      rows: (d.rows || []).map((r) => ({
        ...r,
        fecha: r.fecha ? new Date(r.fecha).toLocaleDateString('es-EC') : '',
      })),
      totals: {
        cantidad: +(d.rows || []).reduce((s, r) => s + (r.cantidad || 0), 0).toFixed(2),
        ingreso: +(d.rows || []).reduce((s, r) => s + (r.ingreso || 0), 0).toFixed(2),
        costo: d.totalCost,
        utilidad: +(d.rows || []).reduce((s, r) => s + (r.utilidad || 0), 0).toFixed(2),
      },
    });
    return XL.sendWorkbook(res, wb, `costo_venta_${Date.now()}.xlsx`);
  }

  const spec = SALES_SUBREPORTS[key];
  if (!spec) return res.status(404).json({ message: 'Reporte no encontrado' });

  const payload = await XL.captureJson(spec.handler(), req);
  const raw = Array.isArray(payload) ? payload : (payload.rows || []);
  const rows = spec.map ? raw.map(spec.map) : raw;

  // Totales de las columnas monetarias y numéricas: es lo primero que mira un contador.
  const totals = {};
  for (const c of spec.columns) {
    if (!c.money && !c.number) continue;
    if (c.key === 'margin') continue;   // un porcentaje no se suma
    totals[c.key] = +rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0).toFixed(2);
  }

  const wb = XL.newWorkbook();
  XL.addSheet(wb, {
    title: spec.title,
    meta: [['Reporte', spec.title], ['Período', XL.periodLabel(req.query)]],
    columns: spec.columns,
    rows,
    totals,
  });
  await XL.sendWorkbook(res, wb, `${key.replace(/-/g, '_')}_${Date.now()}.xlsx`);
});

/**
 * DETALLE de una fila de los reportes de ventas en Excel: las MISMAS filas que abre la
 * pantalla (mismo controlador), para que el contador se lleve el respaldo del total.
 */
exports.salesDrilldownExcel = XL.excelHandler(async (req, res) => {
  const d = await XL.captureJson(exports.salesDrilldown, req);
  const porLinea = d.level === 'line';
  const wb = XL.newWorkbook();
  XL.addSheet(wb, {
    title: 'Detalle',
    meta: [
      ['Reporte', `Detalle — ${DRILL_TITLES[d.dimension] || d.dimension}`],
      ['Fila', d.label],
      ['Período', XL.periodLabel(req.query)],
      ['Ventas', d.totals?.ventas || 0],
    ],
    columns: [
      { header: 'Fecha', key: 'fecha', width: 12, date: true },
      { header: 'Venta', key: 'venta', width: 14 },
      { header: 'Factura', key: 'factura', width: 18 },
      { header: 'Cliente', key: 'cliente', width: 30 },
      { header: 'Identificación', key: 'identificacion', width: 16 },
      ...(porLinea ? [
        { header: 'Código', key: 'codigo', width: 14 },
        { header: 'Producto / servicio', key: 'producto', width: 34 },
      ] : []),
      { header: 'Cantidad', key: 'cantidad', width: 10, number: true },
      { header: 'Descuento', key: 'descuento', width: 13, money: true },
      { header: 'Subtotal', key: 'subtotal', width: 14, money: true },
      { header: 'IVA', key: 'iva', width: 12, money: true },
      { header: 'Total', key: 'total', width: 14, money: true },
      ...(porLinea ? [
        { header: 'Costo', key: 'costo', width: 13, money: true },
        { header: 'Utilidad', key: 'utilidad', width: 13, money: true },
      ] : []),
      { header: 'Vendedor', key: 'vendedor', width: 24 },
      { header: 'Cajero', key: 'cajero', width: 24 },
      { header: 'Estado SRI', key: 'estadoSri', width: 14 },
    ],
    rows: d.rows || [],
    totals: d.totals || {},
  });
  await XL.sendWorkbook(res, wb, `detalle_ventas_${Date.now()}.xlsx`);
});
