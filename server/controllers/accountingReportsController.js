const JournalEntry = require('../models/JournalEntry');
const ChartOfAccount = require('../models/ChartOfAccount');
const Sale = require('../models/Sale');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');
const AccountBalance = require('../models/AccountBalance');
const { recomputeBalances } = require('../utils/accounting');
const { startOfDay, endOfDay } = require('../utils/dates');
const {
  resolveReportRange, isMonthlyRange, invoiceFiscalDate, purchaseFiscalDate, inRange,
} = require('../utils/reportDateRange');
const { invoiceTaxBreakdown } = require('../utils/invoiceTaxBreakdown');
const ExcelJS = require('exceljs');
const mongoose = require('mongoose');

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
async function getAccountBalances(clinicId, { startDate, endDate } = {}) {
  const match = { clinic: asObjectId(clinicId), status: 'CONTABILIZADO' };
  if (startDate || endDate) {
    match.date = {};
    if (startDate) match.date.$gte = startOfDay(startDate);
    if (endDate) match.date.$lte = endOfDay(endDate);
  }
  const agg = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    { $group: { _id: '$lines.account', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  const accounts = await ChartOfAccount.find({ clinic: clinicId }).lean();
  const map = new Map(accounts.map((a) => [String(a._id), { ...a, debit: 0, credit: 0, balance: 0 }]));
  for (const r of agg) {
    const a = map.get(String(r._id));
    if (!a) continue;
    a.debit = r.debit; a.credit = r.credit;
    a.balance = accountBalanceFromNature(a, r.debit, r.credit);
  }
  return Array.from(map.values());
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
    for (const c of n.children) t += rollup(c);
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

    const balances = await getAccountBalances(req.clinicId, { startDate, endDate });
    const ingresos = balances.filter((a) => a.type === 'INGRESO' && a.allowsMovement);
    const costos = balances.filter((a) => a.type === 'COSTO' && a.allowsMovement);
    const gastos = balances.filter((a) => a.type === 'GASTO' && a.allowsMovement);
    const totalIngresos = round2(ingresos.reduce((s, a) => s + a.balance, 0));
    const totalCostos = round2(costos.reduce((s, a) => s + a.balance, 0));
    const totalGastos = round2(gastos.reduce((s, a) => s + a.balance, 0));
    const utilidadBruta = round2(totalIngresos - totalCostos);
    const utilidadOperacional = round2(utilidadBruta - totalGastos);

    // Cascada tributaria (estimada) según normativa ecuatoriana.
    const utilidadAntesParticipacion = utilidadOperacional;
    const participacionTrabajadores = round2(Math.max(0, utilidadAntesParticipacion) * profitSharingRate);
    const utilidadAntesImpuesto = round2(utilidadAntesParticipacion - participacionTrabajadores);
    const impuestoRenta = round2(Math.max(0, utilidadAntesImpuesto) * incomeTaxRate);
    const utilidadNeta = round2(utilidadAntesImpuesto - impuestoRenta);

    res.json({
      // Árbol jerárquico (cuentas agrupadoras con subtotales) para presentación.
      tree: buildAccountTree(balances, ['INGRESO', 'COSTO', 'GASTO']),
      // Listas planas (compatibilidad).
      ingresos, costos, gastos,
      totalIngresos, totalCostos, totalGastos,
      utilidadBruta, utilidadOperacional,
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
    const balances = await getAccountBalances(req.clinicId, { endDate: date });
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

// ---------- Flujo de Caja (cuentas de efectivo y banco) ----------
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
      return res.json({ flows: [], accounts: [], opening: 0, totalIn: 0, totalOut: 0, saldoFinal: 0 });
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
    res.json({
      flows,
      accounts,
      opening: accounts.reduce((s, a) => s + (a.opening || 0), 0),
      totalIn: flows.reduce((s, f) => s + f.in, 0),
      totalOut: flows.reduce((s, f) => s + f.out, 0),
      saldoFinal: saldo,
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
    const match = { clinic: req.clinicId, status: 'completada' };
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
  const match = { clinic: req.clinicId, status: 'completada' };
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) match.createdAt.$lte = endOfDay(endDate);
  }
  const rows = await Sale.aggregate([
    { $match: match }, { $unwind: '$items' },
    { $group: { _id: { product: '$items.product', name: '$items.productName' },
                qty: { $sum: '$items.quantity' }, subtotal: { $sum: '$items.subtotal' } } },
    { $sort: { subtotal: -1 } },
  ]);
  res.json(rows);
};

exports.salesByCashier = async (req, res) => {
  const { startDate, endDate } = req.query;
  const match = { clinic: req.clinicId, status: 'completada' };
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
    { $match: { clinic: req.clinicId, status: 'completada', createdAt: { $gte: start, $lte: end } } },
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
    const match = { clinic: req.clinicId, status: 'completada', ...dateMatch(req) };
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
    const match = { clinic: req.clinicId, status: 'completada', ...dateMatch(req) };
    const sales = await Sale.find(match).populate('items.product', 'purchasePrice category');
    const byCat = {};
    for (const s of sales) {
      for (const it of s.items) {
        const cat = it.product?.category || it.category || 'otro';
        const cost = (it.product?.purchasePrice || 0) * it.quantity;
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

exports.costOfSales = async (req, res) => {
  const { startDate, endDate } = req.query;
  const match = { clinic: req.clinicId, status: 'completada' };
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = new Date(startDate);
    if (endDate) match.createdAt.$lte = endOfDay(endDate);
  }
  const sales = await Sale.find(match).populate('items.product', 'purchasePrice');
  let cost = 0;
  for (const s of sales) {
    for (const it of s.items) {
      const pcost = it.product?.purchasePrice || 0;
      cost += pcost * it.quantity;
    }
  }
  const totalSales = sales.reduce((s, v) => s + v.total, 0);
  res.json({ totalSales, totalCost: cost, grossProfit: totalSales - cost });
};

// ---------- Gestión ----------
exports.nonDeductibleExpenses = async (req, res) => {
  const { startDate, endDate } = req.query;
  const accs = await ChartOfAccount.find({ clinic: req.clinicId, code: /^6\.3\./ });
  const ids = accs.map((a) => a._id);
  const match = { clinic: req.clinicId, status: 'CONTABILIZADO', 'lines.account': { $in: ids } };
  if (startDate || endDate) {
    match.date = {};
    if (startDate) match.date.$gte = startOfDay(startDate);
    if (endDate) match.date.$lte = endOfDay(endDate);
  }
  const agg = await JournalEntry.aggregate([
    { $match: match }, { $unwind: '$lines' },
    { $match: { 'lines.account': { $in: ids } } },
    { $group: { _id: '$lines.account', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  const map = new Map(accs.map((a) => [String(a._id), a]));
  const rows = agg.map((r) => ({ account: map.get(String(r._id)), amount: r.debit - r.credit }));
  const total = rows.reduce((s, r) => s + r.amount, 0);
  res.json({ rows, total });
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

exports.accountsReceivableAging = async (req, res) => {
  try {
    const today = new Date();
    // Aplica a facturas de venta autorizadas con saldo pendiente (saldo = total - cobros aplicados)
    const invoices = await Invoice.find({ clinic: req.clinicId, estado: 'AUTORIZADO' });
    const paymentApps = await Payment.aggregate([
      { $match: { clinic: req.clinicId, type: 'COBRO', status: 'REGISTRADO' } },
      { $unwind: '$applications' },
      { $match: { 'applications.docModel': 'Invoice' } },
      { $group: { _id: '$applications.docRef', paid: { $sum: '$applications.amount' } } },
    ]);
    const paidMap = new Map(paymentApps.map((p) => [String(p._id), p.paid]));
    const rows = [];
    for (const inv of invoices) {
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
    // Ventas a crédito con saldo pendiente (CxC directa, sin factura electrónica)
    const creditSales = await Sale.find({ clinic: req.clinicId, status: 'completada', paymentMethod: 'credito', balance: { $gt: 0.01 } });
    for (const s of creditSales) {
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
    const totals = rows.reduce((acc, r) => { acc[r.bucket] = (acc[r.bucket] || 0) + r.balance; acc.total += r.balance; return acc; }, { total: 0 });
    res.json({ rows, totals });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.accountsPayableAging = async (req, res) => {
  try {
    const today = new Date();
    const invoices = await PurchaseInvoice.find({ clinic: req.clinicId, status: 'REGISTRADA' });
    const paymentApps = await Payment.aggregate([
      { $match: { clinic: req.clinicId, type: 'PAGO', status: 'REGISTRADO' } },
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

exports.advancesControl = async (req, res) => {
  // Saldo de cuentas Anticipos a proveedores y Anticipos de clientes
  const codes = ['1.1.02.03', '2.1.01.03'];
  const accs = await ChartOfAccount.find({ clinic: req.clinicId, code: { $in: codes } });
  const ids = accs.map((a) => a._id);
  const agg = await JournalEntry.aggregate([
    { $match: { clinic: req.clinicId, status: 'CONTABILIZADO', 'lines.account': { $in: ids } } },
    { $unwind: '$lines' },
    { $match: { 'lines.account': { $in: ids } } },
    { $group: { _id: '$lines.account', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  const rows = agg.map((r) => {
    const acc = accs.find((a) => String(a._id) === String(r._id));
    return { code: acc.code, name: acc.name, debit: r.debit, credit: r.credit, saldo: acc.nature === 'DEBITO' ? r.debit - r.credit : r.credit - r.debit };
  });
  res.json(rows);
};

exports.inventoryReport = async (req, res) => {
  const products = await Product.find({ clinic: req.clinicId, active: true });
  const rows = products.map((p) => ({
    code: p.code, name: p.name, category: p.category,
    stock: p.stock || 0, purchasePrice: p.purchasePrice || 0,
    salePrice: p.salePrice || 0,
    valueAtCost: (p.stock || 0) * (p.purchasePrice || 0),
    valueAtSale: (p.stock || 0) * (p.salePrice || 0),
  }));
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
    const products = await Product.find({ clinic: req.clinicId, active: true }).select('stock purchasePrice salePrice');
    const inventory = products.reduce((acc, p) => ({
      valueAtCost: acc.valueAtCost + (p.stock || 0) * (p.purchasePrice || 0),
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
  };
}

async function buildAgingWorkbook(rows, title) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title);
  ws.columns = AGING_COLS;
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
  rows.forEach((r) => ws.addRow(r));
  ['porVencer', 'd30', 'd60', 'd120', 'd120plus', 'total', 'docValue', 'retentions', 'payments'].forEach((k) => { ws.getColumn(k).numFmt = '"$"#,##0.00'; });
  return wb;
}

exports.arAgingExcel = async (req, res) => {
  try {
    const data = await new Promise((resolve) => { exports.accountsReceivableAging(req, { json: resolve, status: () => ({ json: resolve }) }); });
    const rows = (data.rows || []).map((r) => agingRowToExcel(r, r.client));
    const wb = await buildAgingWorkbook(rows, 'Cuentas por cobrar');
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
exports.rdep = async (req, res) => {
  try {
    const Payroll = require('../models/Payroll');
    const Clinic = require('../models/Clinic');
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const clinic = await Clinic.findById(req.clinicId);
    const rolls = await Payroll.find({ clinic: req.clinicId, year, status: { $in: ['CERRADO', 'PAGADO'] } });

    const byEmp = new Map();
    for (const p of rolls) {
      for (const it of p.items || []) {
        const key = it.identificacion || String(it.employee);
        if (!byEmp.has(key)) byEmp.set(key, { identificacion: it.identificacion || '', nombre: it.employeeName || '', sueldo: 0, iess: 0, impuestoRenta: 0, exento: 0 });
        const e = byEmp.get(key);
        const exento = (it.decimoTercero || 0) + (it.decimoCuarto || 0) + (it.fondosReserva || 0);
        e.sueldo += (it.totalIngresos || 0) - exento;
        e.exento += exento;
        e.iess += it.iessPersonal || 0;
        e.impuestoRenta += it.impuestoRenta || 0;
      }
    }
    const empleados = [...byEmp.values()].map((e) => ({
      identificacion: e.identificacion, nombre: e.nombre,
      sueldo: +e.sueldo.toFixed(2), ingresoExento: +e.exento.toFixed(2),
      aporteIess: +e.iess.toFixed(2), impuestoRenta: +e.impuestoRenta.toFixed(2),
    }));

    if (req.query.format === 'xml') {
      const esc = (s) => String(s || '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
      let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<rdep>\n';
      xml += `  <Anio>${year}</Anio>\n  <IdInformante>${esc(clinic?.ruc)}</IdInformante>\n  <razonSocial>${esc(clinic?.razonSocial || clinic?.name)}</razonSocial>\n`;
      xml += '  <empleados>\n';
      for (const e of empleados) {
        xml += '    <empleado>\n';
        xml += `      <tipoIdentificacion>C</tipoIdentificacion>\n      <identificacion>${esc(e.identificacion)}</identificacion>\n      <nombre>${esc(e.nombre)}</nombre>\n`;
        xml += `      <sueldos>${e.sueldo.toFixed(2)}</sueldos>\n      <ingresoExento>${e.ingresoExento.toFixed(2)}</ingresoExento>\n`;
        xml += `      <aporteIess>${e.aporteIess.toFixed(2)}</aporteIess>\n      <impuestoRentaRetenido>${e.impuestoRenta.toFixed(2)}</impuestoRentaRetenido>\n`;
        xml += '    </empleado>\n';
      }
      xml += '  </empleados>\n</rdep>\n';
      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', `attachment; filename="RDEP-${year}.xml"`);
      return res.send(xml);
    }
    res.json({ year, empleados, total: empleados.reduce((s, e) => s + e.impuestoRenta, 0) });
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
 * ATS visual (JSON) por rango: compras y ventas del período, con desglose de
 * retenciones, para revisar/conciliar antes de generar el XML oficial (mensual).
 * Acepta cualquier período (mensual, semestral, anual, personalizado).
 */
exports.atsPreview = async (req, res) => {
  try {
    const range = resolveReportRange(req.query);
    const ventasDocs = await fetchSalesInRange(req.clinicId, range.start, range.end);
    const comprasDocs = await PurchaseInvoice.find(purchasesInRangeQuery(req.clinicId, range.start, range.end))
      .populate('supplier', 'ruc razonSocial tipoIdentificacion');

    const compras = comprasDocs.map((c) => {
      const retIva = (c.retentions || []).filter((r) => r.type === 'IVA').reduce((s, r) => s + (r.amount || 0), 0);
      const retRenta = (c.retentions || []).filter((r) => r.type === 'RENTA').reduce((s, r) => s + (r.amount || 0), 0);
      return {
        fecha: c.fechaEmision,
        serie: c.serie || [c.estab, c.ptoEmi, c.secuencial].filter(Boolean).join('-'),
        proveedor: c.supplier?.razonSocial || '',
        ruc: c.supplier?.ruc || '',
        baseNoObjeto: +(c.subtotalNoObjeto || 0).toFixed(2),
        base0: +(c.subtotal0 || 0).toFixed(2),
        baseGrav: +((c.subtotal12 || 0) + (c.subtotal15 || 0)).toFixed(2),
        iva: +(c.iva || 0).toFixed(2),
        retIva: +retIva.toFixed(2),
        retRenta: +retRenta.toFixed(2),
        total: +(c.total || 0).toFixed(2),
      };
    });

    const byClient = {};
    for (const v of ventasDocs) {
      const tb = invoiceTaxBreakdown(v);
      const k = v.identificacionComprador || '9999999999999';
      if (!byClient[k]) byClient[k] = { idCliente: k, razonSocial: v.razonSocialComprador || 'CONSUMIDOR FINAL', numComprobantes: 0, base: 0, base0: 0, baseGrav: 0, iva: 0, total: 0 };
      byClient[k].numComprobantes += 1;
      byClient[k].base += tb.baseTotal;
      byClient[k].base0 += tb.base0;
      byClient[k].baseGrav += tb.baseGravada;
      byClient[k].iva += tb.iva;
      byClient[k].total += v.importeTotal || 0;
    }
    const ventas = Object.values(byClient).map((v) => ({
      ...v, base: +v.base.toFixed(2), base0: +v.base0.toFixed(2), baseGrav: +v.baseGrav.toFixed(2), iva: +v.iva.toFixed(2), total: +v.total.toFixed(2),
    }));

    const totals = {
      comprasBase: +compras.reduce((s, c) => s + c.base0 + c.baseGrav + c.baseNoObjeto, 0).toFixed(2),
      comprasIva: +compras.reduce((s, c) => s + c.iva, 0).toFixed(2),
      comprasRetIva: +compras.reduce((s, c) => s + c.retIva, 0).toFixed(2),
      comprasRetRenta: +compras.reduce((s, c) => s + c.retRenta, 0).toFixed(2),
      comprasTotal: +compras.reduce((s, c) => s + c.total, 0).toFixed(2),
      ventasBase: +ventas.reduce((s, v) => s + v.base, 0).toFixed(2),
      ventasBase0: +ventas.reduce((s, v) => s + v.base0, 0).toFixed(2),
      ventasBaseGrav: +ventas.reduce((s, v) => s + v.baseGrav, 0).toFixed(2),
      ventasIva: +ventas.reduce((s, v) => s + v.iva, 0).toFixed(2),
      ventasTotal: +ventas.reduce((s, v) => s + v.total, 0).toFixed(2),
    };

    const salesPending = await countPendingSalesInRange(req.clinicId, range.start, range.end);
    res.json({ period: periodMeta(range), monthlyXmlAvailable: isMonthlyRange(range), compras, ventas, totals, salesPending });
  } catch (e) { res.status(e.status || 500).json({ message: e.message }); }
};

/**
 * ATS - Anexo Transaccional Simplificado.
 * Genera XML simplificado (estructura básica del SRI v2.0.0).
 * El ATS oficial es MENSUAL: se bloquea cualquier período no mensual.
 */
exports.ats = async (req, res) => {
  try {
    const range = resolveReportRange(req.query);
    if (!isMonthlyRange(range)) {
      return res.status(400).json({ message: 'El ATS XML debe generarse por mes; para rangos use el reporte visual.' });
    }
    const y = range.year;
    const m = range.month;
    const start = range.start;
    const end = range.end;
    const Clinic = require('../models/Clinic');
    const clinic = await Clinic.findById(req.clinicId);
    const ventas = await fetchSalesInRange(req.clinicId, start, end);
    const compras = await PurchaseInvoice.find({ clinic: req.clinicId, status: { $ne: 'ANULADA' }, fechaEmision: { $gte: start, $lte: end } }).populate('supplier');

    const esc = (s) => String(s || '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<iva>\n';
    xml += `  <TipoIDInformante>R</TipoIDInformante>\n`;
    xml += `  <IdInformante>${esc(clinic?.ruc)}</IdInformante>\n`;
    xml += `  <razonSocial>${esc(clinic?.razonSocial || clinic?.name)}</razonSocial>\n`;
    xml += `  <Anio>${y}</Anio>\n  <Mes>${String(m).padStart(2, '0')}</Mes>\n`;

    // Compras
    xml += '  <compras>\n';
    for (const c of compras) {
      xml += '    <detalleCompras>\n';
      xml += `      <codSustento>01</codSustento>\n`;
      xml += `      <tpIdProv>${c.supplier?.tipoIdentificacion === 'CEDULA' ? '02' : '01'}</tpIdProv>\n`;
      xml += `      <idProv>${esc(c.supplier?.ruc)}</idProv>\n`;
      xml += `      <tipoComprobante>${c.docType === 'NOTA_CREDITO_REC' ? '04' : '01'}</tipoComprobante>\n`;
      xml += `      <fechaRegistro>${c.fechaEmision.toISOString().slice(0, 10).split('-').reverse().join('/')}</fechaRegistro>\n`;
      xml += `      <establecimiento>${esc(c.estab || '001')}</establecimiento>\n`;
      xml += `      <puntoEmision>${esc(c.ptoEmi || '001')}</puntoEmision>\n`;
      xml += `      <secuencial>${esc(c.secuencial || '')}</secuencial>\n`;
      xml += `      <autorizacion>${esc(c.autorizacion || '')}</autorizacion>\n`;
      xml += `      <fechaEmision>${c.fechaEmision.toISOString().slice(0, 10).split('-').reverse().join('/')}</fechaEmision>\n`;
      xml += `      <baseNoGraIva>${(c.subtotalNoObjeto || 0).toFixed(2)}</baseNoGraIva>\n`;
      xml += `      <baseImponible>${(c.subtotal0 || 0).toFixed(2)}</baseImponible>\n`;
      xml += `      <baseImpGrav>${((c.subtotal12 || 0) + (c.subtotal15 || 0)).toFixed(2)}</baseImpGrav>\n`;
      xml += `      <montoIva>${(c.iva || 0).toFixed(2)}</montoIva>\n`;
      const retIvaC = (c.retentions || []).filter((r) => r.type === 'IVA').reduce((s, r) => s + (r.amount || 0), 0);
      const retRentaC = (c.retentions || []).filter((r) => r.type === 'RENTA');
      const retRentaTotal = retRentaC.reduce((s, r) => s + (r.amount || 0), 0);
      xml += `      <valRetBien10>0.00</valRetBien10>\n`;
      xml += `      <valRetServ20>0.00</valRetServ20>\n`;
      xml += `      <valorRetBienes>0.00</valorRetBienes>\n`;
      xml += `      <valRetServ50>0.00</valRetServ50>\n`;
      xml += `      <valorRetServicios>0.00</valorRetServicios>\n`;
      xml += `      <valRetServ100>${retIvaC.toFixed(2)}</valRetServ100>\n`;
      xml += `      <totbasesImpReembolso>0.00</totbasesImpReembolso>\n`;
      xml += `      <pagoLocExt>01</pagoLocExt>\n`;
      xml += `      <parteRel>NO</parteRel>\n`;
      // Detalle de retenciones en la fuente (renta)
      if (retRentaC.length) {
        xml += '      <air>\n';
        for (const r of retRentaC) {
          xml += '        <detalleAir>\n';
          xml += `          <codRetAir>${esc(r.code || '')}</codRetAir>\n`;
          xml += `          <baseImpAir>${(r.baseAmount || 0).toFixed(2)}</baseImpAir>\n`;
          xml += `          <porcentajeAir>${(r.percentage || 0).toFixed(2)}</porcentajeAir>\n`;
          xml += `          <valRetAir>${(r.amount || 0).toFixed(2)}</valRetAir>\n`;
          xml += '        </detalleAir>\n';
        }
        xml += '      </air>\n';
      }
      // Formas de pago (cuando el total supera el umbral SRI se reporta)
      xml += '      <formasDePago>\n';
      xml += `        <formaPago>${esc(c.paymentMethodSri || '01')}</formaPago>\n`;
      xml += '      </formasDePago>\n';
      xml += `      <valorRetIva>${retIvaC.toFixed(2)}</valorRetIva>\n`;
      xml += `      <valorRetRenta>${retRentaTotal.toFixed(2)}</valorRetRenta>\n`;
      xml += `      <total>${(c.total || 0).toFixed(2)}</total>\n`;
      xml += '    </detalleCompras>\n';
    }
    xml += '  </compras>\n';

    // Ventas (agrupadas por cliente). Se separa base 0% (baseImponible) de la base
    // gravada (baseImpGrav) usando el desglose por tarifa de cada factura; antes
    // TODA la base iba a baseImpGrav aunque hubiera ventas 0% (servicios médicos).
    const byClient = {};
    for (const v of ventas) {
      const tb = invoiceTaxBreakdown(v);
      const k = v.identificacionComprador || '9999999999999';
      if (!byClient[k]) byClient[k] = { ...v, base0: 0, baseGrav: 0, iva: 0, total: 0, count: 0 };
      byClient[k].base0 += tb.base0 + tb.baseExento + tb.baseNoObjeto;
      byClient[k].baseGrav += tb.baseGravada;
      byClient[k].iva += tb.iva;
      byClient[k].total += v.importeTotal || 0;
      byClient[k].count += 1;
    }
    xml += '  <ventas>\n';
    for (const v of Object.values(byClient)) {
      xml += '    <detalleVentas>\n';
      xml += `      <tpIdCliente>${v.tipoIdentificacionComprador === '04' ? '01' : '02'}</tpIdCliente>\n`;
      xml += `      <idCliente>${esc(v.identificacionComprador)}</idCliente>\n`;
      xml += `      <tipoComprobante>18</tipoComprobante>\n`;
      xml += `      <numeroComprobantes>${v.count}</numeroComprobantes>\n`;
      xml += `      <baseImponible>${v.base0.toFixed(2)}</baseImponible>\n`;
      xml += `      <baseImpGrav>${v.baseGrav.toFixed(2)}</baseImpGrav>\n`;
      xml += `      <montoIva>${v.iva.toFixed(2)}</montoIva>\n`;
      xml += `      <valorRetIva>0.00</valorRetIva>\n`;
      xml += `      <valorRetRenta>0.00</valorRetRenta>\n`;
      xml += '      <formasDePago>\n';
      xml += '        <formaPago>01</formaPago>\n';
      xml += '      </formasDePago>\n';
      xml += '    </detalleVentas>\n';
    }
    xml += '  </ventas>\n';
    xml += '</iva>\n';
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="ATS-${y}-${String(m).padStart(2, '0')}.xml"`);
    res.send(xml);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};
