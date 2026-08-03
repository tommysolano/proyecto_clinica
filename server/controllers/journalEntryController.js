const JournalEntry = require('../models/JournalEntry');
const ChartOfAccount = require('../models/ChartOfAccount');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const { createEntry, reverseEntry, applyToBalances, nextEntryNumber, assertPeriodOpen, getOrCreatePeriod } = require('../utils/accounting');
const { getAccountAndDescendants } = require('../utils/accountHierarchy');
const { startOfDay, endOfDay } = require('../utils/dates');
const { asObjectId } = require('../utils/objectId');
const { newWorkbook, addSheet, sendWorkbook, captureJson, excelHandler, periodLabel } = require('../utils/excelReport');

/**
 * Resumen bancario para el Libro Mayor: si alguna de las cuentas consultadas
 * (padre o hijas) es la `chartAccount` de una cuenta bancaria, devuelve el saldo
 * inicial / entradas / salidas / saldo final de cada banco en el rango, más el
 * consolidado. Devuelve null si ninguna cuenta corresponde a un banco.
 */
async function buildBankSummary(clinicId, accountIds, startDate, endDate) {
  const banks = await BankAccount.find({ clinic: clinicId, chartAccount: { $in: accountIds } })
    .select('name bank accountNumber initialBalance chartAccount')
    .lean();
  if (!banks.length) return null;

  const clinicObjId = asObjectId(clinicId);
  const start = startOfDay(startDate);
  const end = endOfDay(endDate);

  const accounts = [];
  for (const b of banks) {
    let opening = b.initialBalance || 0;
    if (start) {
      const prev = await BankTransaction.aggregate([
        { $match: { clinic: clinicObjId, bankAccount: b._id, voided: false, date: { $lt: start } } },
        { $group: { _id: null, total: { $sum: { $multiply: ['$amount', '$direction'] } } } },
      ]);
      opening = +((b.initialBalance || 0) + (prev[0]?.total || 0)).toFixed(2);
    }
    const rangeMatch = { clinic: clinicObjId, bankAccount: b._id, voided: false };
    if (start || end) {
      rangeMatch.date = {};
      if (start) rangeMatch.date.$gte = start;
      if (end) rangeMatch.date.$lte = end;
    }
    const agg = await BankTransaction.aggregate([
      { $match: rangeMatch },
      { $group: {
        _id: null,
        inflow: { $sum: { $cond: [{ $gt: ['$direction', 0] }, '$amount', 0] } },
        outflow: { $sum: { $cond: [{ $lt: ['$direction', 0] }, '$amount', 0] } },
      } },
    ]);
    const inflow = +(agg[0]?.inflow || 0).toFixed(2);
    const outflow = +(agg[0]?.outflow || 0).toFixed(2);
    accounts.push({
      bankAccountId: b._id,
      name: b.name,
      bank: b.bank,
      accountNumber: b.accountNumber,
      chartAccount: b.chartAccount,
      opening,
      inflow,
      outflow,
      closing: +(opening + inflow - outflow).toFixed(2),
    });
  }
  accounts.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const totals = accounts.reduce(
    (t, r) => ({ opening: t.opening + r.opening, inflow: t.inflow + r.inflow, outflow: t.outflow + r.outflow, closing: t.closing + r.closing }),
    { opening: 0, inflow: 0, outflow: 0, closing: 0 }
  );
  Object.keys(totals).forEach((k) => { totals[k] = +totals[k].toFixed(2); });
  return { accounts, totals };
}

/** Hidrata y valida líneas de un asiento (para borradores). */
async function hydrateLines(clinicId, lines) {
  if (!Array.isArray(lines) || lines.length < 2) throw Object.assign(new Error('El asiento debe tener al menos 2 líneas'), { status: 400 });
  const resolved = [];
  for (const l of lines) {
    let acc = null;
    if (l.account) acc = await ChartOfAccount.findOne({ _id: l.account, clinic: clinicId });
    else if (l.accountCode) acc = await ChartOfAccount.findOne({ code: l.accountCode, clinic: clinicId });
    if (!acc) throw Object.assign(new Error(`Cuenta no encontrada: ${l.accountCode || l.account}`), { status: 400 });
    if (!acc.allowsMovement) throw Object.assign(new Error(`Cuenta ${acc.code} no admite movimientos`), { status: 400 });
    const debit = Number(l.debit) || 0, credit = Number(l.credit) || 0;
    if (debit > 0 && credit > 0) throw Object.assign(new Error('Una línea no puede tener débito y crédito'), { status: 400 });
    resolved.push({ account: acc._id, accountCode: acc.code, accountName: acc.name, costCenter: l.costCenter || null, description: l.description || '', debit, credit });
  }
  const totalDebit = resolved.reduce((s, l) => s + l.debit, 0);
  const totalCredit = resolved.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) throw Object.assign(new Error(`Asiento descuadrado: ${totalDebit.toFixed(2)} ≠ ${totalCredit.toFixed(2)}`), { status: 400 });
  return { resolved, totalDebit, totalCredit };
}

exports.list = async (req, res) => {
  try {
    const { startDate, endDate, account, costCenter, source, status, q, page = 1, limit = 50 } = req.query;
    const filter = { clinic: req.clinicId };
    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(startDate);
      if (endDate) filter.date.$lte = new Date(endDate);
    }
    if (source) filter.source = source;
    if (status) filter.status = status;
    if (account) filter['lines.account'] = account;
    if (costCenter) filter['lines.costCenter'] = costCenter;
    if (q) filter.$or = [{ number: new RegExp(q, 'i') }, { description: new RegExp(q, 'i') }];

    const total = await JournalEntry.countDocuments(filter);
    const entries = await JournalEntry.find(filter)
      .populate('createdBy', 'name')
      .sort({ date: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    res.json({ entries, total, pages: Math.ceil(total / limit), currentPage: parseInt(page) });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

exports.get = async (req, res) => {
  const e = await JournalEntry.findOne({ _id: req.params.id, clinic: req.clinicId })
    .populate('createdBy', 'name')
    .populate('lines.account', 'code name')
    .populate('lines.costCenter', 'code name');
  if (!e) return res.status(404).json({ message: 'No encontrado' });
  res.json(e);
};

/**
 * Asientos generados por un documento origen (trazabilidad inversa):
 * cualquier módulo puede consultar sus asientos con ?model=<sourceModel>&ref=<id>.
 * Un documento puede tener varios (p.ej. venta: ingreso + costo + reversas).
 */
exports.bySource = async (req, res) => {
  try {
    const { model, ref } = req.query;
    if (!model || !ref) return res.status(400).json({ message: 'model y ref requeridos' });
    const entries = await JournalEntry.find({ clinic: req.clinicId, sourceModel: model, sourceRef: ref })
      .populate('createdBy', 'name')
      .sort({ date: 1, createdAt: 1 });
    res.json(entries);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

/** PDF del comprobante de asiento (cuentas afectadas, origen, usuario, fecha/hora). */
exports.pdf = async (req, res) => {
  try {
    const entry = await JournalEntry.findOne({ _id: req.params.id, clinic: req.clinicId })
      .populate('createdBy', 'name');
    if (!entry) return res.status(404).json({ message: 'No encontrado' });
    const Clinic = require('../models/Clinic');
    const clinic = await Clinic.findById(req.clinicId).select('name razonSocial ruc address').lean();
    const { streamJournalEntryPdf } = require('../utils/journalEntryPdf');
    streamJournalEntryPdf({ entry, clinic, res });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ message: e.message });
  }
};

exports.create = async (req, res) => {
  try {
    const { date, description, lines, draft } = req.body;
    const entryDate = date ? new Date(date) : new Date();

    // Borrador: se guarda sin contabilizar ni afectar saldos, para revisión/aprobación.
    if (draft) {
      const { resolved, totalDebit, totalCredit } = await hydrateLines(req.clinicId, lines);
      const period = await getOrCreatePeriod(req.clinicId, entryDate);
      const number = `BOR-${Date.now()}`;
      const entry = await JournalEntry.create({
        clinic: req.clinicId, number, date: entryDate, period: period._id,
        description, source: 'MANUAL', lines: resolved, totalDebit, totalCredit,
        status: 'BORRADOR', createdBy: req.user._id,
      });
      return res.status(201).json(entry);
    }

    const entry = await createEntry({
      clinicId: req.clinicId, date: entryDate, description, source: 'MANUAL', lines, userId: req.user._id,
    });
    res.status(201).json(entry);
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

/** Aprueba (contabiliza) un asiento en BORRADOR: asigna número y afecta saldos. */
exports.approve = async (req, res) => {
  try {
    const entry = await JournalEntry.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!entry) return res.status(404).json({ message: 'No encontrado' });
    if (entry.status !== 'BORRADOR') return res.status(400).json({ message: 'El asiento no está en borrador' });
    await assertPeriodOpen(req.clinicId, entry.date);
    entry.number = await nextEntryNumber(req.clinicId, entry.date);
    entry.status = 'CONTABILIZADO';
    await entry.save();
    await applyToBalances(req.clinicId, entry.date, entry.lines, 1);
    res.json(entry);
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/*
 * NOTA CONTABLE: aquí vivía `updateDraft`. Se eliminó junto con la edición del asiento de
 * venta y de compra: en este sistema un asiento NO se edita en ningún momento. Un borrador
 * equivocado se ELIMINA y se vuelve a crear; un asiento contabilizado se REVERSA (deja
 * rastro de auditoría). Así lo que se ve en el asiento siempre es lo que generó el documento.
 */

/** Elimina un asiento en BORRADOR. */
exports.removeDraft = async (req, res) => {
  try {
    const entry = await JournalEntry.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!entry) return res.status(404).json({ message: 'No encontrado' });
    if (entry.status !== 'BORRADOR') return res.status(400).json({ message: 'Solo se eliminan borradores (usa reversa para contabilizados)' });
    await entry.deleteOne();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.reverse = async (req, res) => {
  try {
    const rev = await reverseEntry({
      clinicId: req.clinicId,
      entryId: req.params.id,
      userId: req.user._id,
      reason: req.body?.reason,
    });
    res.json(rev);
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

/**
 * Libro mayor por cuenta. Soporta cuentas PADRE (agrupadoras): al consultar una
 * cuenta padre incluye la cuenta seleccionada + TODAS sus descendientes, de modo
 * que el saldo y los movimientos reflejan a las cuentas hijas (p.ej. "Bancos"
 * muestra el movimiento consolidado de todas las cuentas bancarias).
 * Cada fila indica la cuenta HIJA realmente afectada y el asiento/documento origen.
 */
exports.ledger = async (req, res) => {
  try {
    const { account, startDate, endDate, costCenter } = req.query;
    if (!account) return res.status(400).json({ message: 'account requerido' });

    const hier = await getAccountAndDescendants({ clinicId: req.clinicId, accountId: account });
    if (!hier) return res.status(404).json({ message: 'Cuenta no encontrada' });
    const { root, accounts, ids, isParent } = hier;

    const accById = new Map(accounts.map((a) => [String(a._id), a]));
    const clinicObjId = asObjectId(req.clinicId);
    const ccObjId = costCenter ? asObjectId(costCenter) : null;

    // Saldo inicial: débitos/créditos de todas las cuentas incluidas anteriores al
    // rango. El SALDO sigue la naturaleza de la cuenta RAÍZ consultada (coherente
    // para cuentas agrupadoras); no se mezcla la naturaleza de cada hija, para no
    // ocultar errores de clasificación ni generar saldos raros.
    let opening = 0;
    if (startDate) {
      const init = await JournalEntry.aggregate([
        { $match: { clinic: clinicObjId, status: 'CONTABILIZADO', date: { $lt: startOfDay(startDate) }, 'lines.account': { $in: ids } } },
        { $unwind: '$lines' },
        { $match: { 'lines.account': { $in: ids }, ...(ccObjId ? { 'lines.costCenter': ccObjId } : {}) } },
        { $group: { _id: null, d: { $sum: '$lines.debit' }, c: { $sum: '$lines.credit' } } },
      ]);
      const d = init[0]?.d || 0;
      const c = init[0]?.c || 0;
      opening = +(root.nature === 'DEBITO' ? d - c : c - d).toFixed(2);
    }

    const match = { clinic: req.clinicId, status: 'CONTABILIZADO', 'lines.account': { $in: ids } };
    if (startDate || endDate) {
      match.date = {};
      if (startDate) match.date.$gte = startOfDay(startDate);
      if (endDate) match.date.$lte = endOfDay(endDate);
    }
    const entries = await JournalEntry.find(match).sort({ date: 1, number: 1 }).lean();

    const rows = [];
    let saldo = opening;
    let debit = 0;
    let credit = 0;
    for (const e of entries) {
      for (const l of e.lines || []) {
        const a = accById.get(String(l.account));
        if (!a) continue;
        if (costCenter && String(l.costCenter || '') !== String(costCenter)) continue;
        const ld = Number(l.debit) || 0;
        const lc = Number(l.credit) || 0;
        // El saldo corrido sigue la naturaleza de la cuenta RAÍZ consultada.
        const delta = root.nature === 'DEBITO' ? (ld - lc) : (lc - ld);
        saldo = +(saldo + delta).toFixed(2);
        debit += ld;
        credit += lc;
        rows.push({
          date: e.date,
          number: e.number,
          // Datos para navegar al asiento / documento origen del movimiento.
          entryId: e._id,
          source: e.source,
          sourceModel: e.sourceModel,
          sourceRef: e.sourceRef,
          sourceAction: e.sourceAction,
          // Cuenta HIJA realmente afectada (útil al consultar una cuenta padre).
          accountId: a._id,
          accountCode: a.code,
          accountName: a.name,
          description: l.description || e.description,
          debit: ld,
          credit: lc,
          saldo,
        });
      }
    }
    debit = +debit.toFixed(2);
    credit = +credit.toFixed(2);
    // El saldo final es el saldo corrido de la última fila (misma base de redondeo
    // que ve el usuario); el movimiento neto se deriva de él.
    const closing = saldo;
    const movement = +(closing - opening).toFixed(2);

    const bankSummary = await buildBankSummary(req.clinicId, ids, startDate, endDate);

    res.json({
      account: { _id: root._id, code: root.code, name: root.name, type: root.type, nature: root.nature, allowsMovement: root.allowsMovement },
      isParent,
      includedAccounts: accounts
        .map((a) => ({ _id: a._id, code: a.code, name: a.name, nature: a.nature }))
        .sort((x, y) => String(x.code).localeCompare(String(y.code))),
      opening,
      debit,
      credit,
      movement,
      closing,
      rows,
      bankSummary,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

/** Balance de comprobación. */
exports.trialBalance = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    // `aggregate` no castea el clinicId (string del JWT) a ObjectId: hay que convertirlo.
    const match = { clinic: asObjectId(req.clinicId), status: 'CONTABILIZADO' };
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
    const accounts = await ChartOfAccount.find({ clinic: req.clinicId, allowsMovement: true });
    const accMap = new Map(accounts.map((a) => [String(a._id), a]));
    const rows = agg
      .map((r) => {
        const a = accMap.get(String(r._id));
        if (!a) return null;
        const saldo = a.nature === 'DEBITO' ? r.debit - r.credit : r.credit - r.debit;
        return { code: a.code, name: a.name, type: a.type, nature: a.nature, debit: r.debit, credit: r.credit, saldo };
      })
      .filter(Boolean)
      .sort((a, b) => a.code.localeCompare(b.code));
    const totals = rows.reduce((acc, r) => ({ debit: acc.debit + r.debit, credit: acc.credit + r.credit }), { debit: 0, credit: 0 });
    res.json({ rows, totals });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// ─────────────────────────── Exportaciones a Excel ───────────────────────────
// Cada una reutiliza el controlador JSON de su pantalla (`captureJson`): el archivo dice
// exactamente lo mismo que se está viendo, y no hay una segunda consulta que mantener.

/** LIBRO MAYOR en Excel: movimientos de la cuenta con saldo corrido, más el resumen bancario. */
exports.ledgerExcel = excelHandler(async (req, res) => {
  const data = await captureJson(exports.ledger, req);
  const wb = newWorkbook();
  const cuenta = `${data.account?.code || ''} - ${data.account?.name || ''}`.trim();

  addSheet(wb, {
    title: 'Libro Mayor',
    meta: [
      ['Reporte', 'Libro Mayor'],
      ['Cuenta', cuenta],
      ['Naturaleza', data.account?.nature || ''],
      ['Período', periodLabel(req.query)],
      ['Saldo inicial', data.opening],
      ['Total débito', data.debit],
      ['Total crédito', data.credit],
      ['Movimiento neto', data.movement],
      ['Saldo final', data.closing],
      ...(data.isParent ? [['Cuenta agrupadora', `Incluye ${data.includedAccounts?.length || 0} cuentas: ${(data.includedAccounts || []).map((a) => a.code).join(', ')}`]] : []),
    ],
    columns: [
      { header: 'Fecha', key: 'date', width: 12, date: true },
      { header: 'Asiento', key: 'number', width: 14 },
      { header: 'Cuenta', key: 'accountCode', width: 14 },
      { header: 'Nombre de cuenta', key: 'accountName', width: 30 },
      { header: 'Descripción', key: 'description', width: 46 },
      { header: 'Origen', key: 'source', width: 16 },
      { header: 'Débito', key: 'debit', width: 14, money: true },
      { header: 'Crédito', key: 'credit', width: 14, money: true },
      { header: 'Saldo', key: 'saldo', width: 14, money: true },
    ],
    rows: data.rows || [],
    totals: { debit: data.debit, credit: data.credit, saldo: data.closing },
    notes: ['Solo se incluyen asientos CONTABILIZADOS. El saldo corrido sigue la naturaleza de la cuenta consultada.'],
  });

  if (data.bankSummary?.accounts?.length) {
    addSheet(wb, {
      title: 'Resumen bancario',
      meta: [['Período', periodLabel(req.query)]],
      columns: [
        { header: 'Cuenta bancaria', key: 'name', width: 28 },
        { header: 'Banco', key: 'bank', width: 20 },
        { header: 'N° cuenta', key: 'accountNumber', width: 20 },
        { header: 'Saldo inicial', key: 'opening', width: 16, money: true },
        { header: 'Entradas', key: 'inflow', width: 16, money: true },
        { header: 'Salidas', key: 'outflow', width: 16, money: true },
        { header: 'Saldo final', key: 'closing', width: 16, money: true },
      ],
      rows: data.bankSummary.accounts,
      totals: data.bankSummary.totals,
      totalsLabel: 'CONSOLIDADO',
    });
  }

  const slug = String(data.account?.code || 'cuenta').replace(/[^\w.-]+/g, '_');
  await sendWorkbook(res, wb, `mayor_${slug}_${Date.now()}.xlsx`);
});

/** BALANCE DE COMPROBACIÓN en Excel. */
exports.trialBalanceExcel = excelHandler(async (req, res) => {
  const data = await captureJson(exports.trialBalance, req);
  const wb = newWorkbook();
  addSheet(wb, {
    title: 'Balance de comprobación',
    meta: [
      ['Reporte', 'Balance de comprobación'],
      ['Período', periodLabel(req.query)],
    ],
    columns: [
      { header: 'Código', key: 'code', width: 16 },
      { header: 'Cuenta', key: 'name', width: 44 },
      { header: 'Tipo', key: 'type', width: 14 },
      { header: 'Naturaleza', key: 'nature', width: 12 },
      { header: 'Débito', key: 'debit', width: 16, money: true },
      { header: 'Crédito', key: 'credit', width: 16, money: true },
      { header: 'Saldo', key: 'saldo', width: 16, money: true },
    ],
    rows: data.rows || [],
    totals: { debit: data.totals?.debit, credit: data.totals?.credit },
    notes: ['Solo cuentas de movimiento con asientos CONTABILIZADOS en el período.'],
  });
  await sendWorkbook(res, wb, `balance_comprobacion_${Date.now()}.xlsx`);
});

/**
 * LIBRO DIARIO en Excel: una fila por LÍNEA de asiento (no por asiento), que es como lo pide
 * un contador para cuadrar. Se exporta el rango completo del filtro, sin la paginación de la
 * pantalla: un Excel de "página 1 de 40" no sirve para nada.
 */
exports.journalExcel = excelHandler(async (req, res) => {
  const { startDate, endDate, account, costCenter, source, status, q } = req.query;
  const filter = { clinic: req.clinicId };
  if (startDate || endDate) {
    filter.date = {};
    if (startDate) filter.date.$gte = startOfDay(startDate);
    if (endDate) filter.date.$lte = endOfDay(endDate);
  }
  if (source) filter.source = source;
  if (status) filter.status = status;
  if (account) filter['lines.account'] = account;
  if (costCenter) filter['lines.costCenter'] = costCenter;
  if (q) filter.$or = [{ number: new RegExp(q, 'i') }, { description: new RegExp(q, 'i') }];

  const entries = await JournalEntry.find(filter)
    .populate('createdBy', 'name')
    .sort({ date: 1, number: 1 })
    .lean();

  const accountIds = new Set();
  for (const e of entries) for (const l of e.lines || []) if (l.account) accountIds.add(String(l.account));
  const accounts = await ChartOfAccount.find({ _id: { $in: [...accountIds] } }).select('code name').lean();
  const accById = new Map(accounts.map((a) => [String(a._id), a]));

  const rows = [];
  let debit = 0;
  let credit = 0;
  for (const e of entries) {
    for (const l of e.lines || []) {
      const a = accById.get(String(l.account));
      debit += Number(l.debit) || 0;
      credit += Number(l.credit) || 0;
      rows.push({
        date: e.date,
        number: e.number,
        status: e.status,
        source: e.source || '',
        entryDescription: e.description || '',
        accountCode: a?.code || '',
        accountName: a?.name || '',
        lineDescription: l.description || '',
        debit: Number(l.debit) || 0,
        credit: Number(l.credit) || 0,
        createdBy: e.createdBy?.name || '',
      });
    }
  }

  const wb = newWorkbook();
  addSheet(wb, {
    title: 'Libro Diario',
    meta: [
      ['Reporte', 'Libro Diario'],
      ['Período', periodLabel(req.query)],
      ['Asientos', entries.length],
      ['Líneas', rows.length],
    ],
    columns: [
      { header: 'Fecha', key: 'date', width: 12, date: true },
      { header: 'Asiento', key: 'number', width: 14 },
      { header: 'Estado', key: 'status', width: 15 },
      { header: 'Origen', key: 'source', width: 16 },
      { header: 'Descripción del asiento', key: 'entryDescription', width: 40 },
      { header: 'Código', key: 'accountCode', width: 14 },
      { header: 'Cuenta', key: 'accountName', width: 32 },
      { header: 'Detalle de la línea', key: 'lineDescription', width: 34 },
      { header: 'Débito', key: 'debit', width: 14, money: true },
      { header: 'Crédito', key: 'credit', width: 14, money: true },
      { header: 'Registró', key: 'createdBy', width: 20 },
    ],
    rows,
    totals: { debit: +debit.toFixed(2), credit: +credit.toFixed(2) },
  });
  await sendWorkbook(res, wb, `libro_diario_${Date.now()}.xlsx`);
});
