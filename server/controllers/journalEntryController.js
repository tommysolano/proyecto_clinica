const JournalEntry = require('../models/JournalEntry');
const ChartOfAccount = require('../models/ChartOfAccount');
const { createEntry, reverseEntry, applyToBalances, nextEntryNumber, assertPeriodOpen, getOrCreatePeriod } = require('../utils/accounting');
const { startOfDay, endOfDay } = require('../utils/dates');
const { asObjectId } = require('../utils/objectId');

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

/** Actualiza un asiento en BORRADOR (antes de aprobar). */
exports.updateDraft = async (req, res) => {
  try {
    const entry = await JournalEntry.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!entry) return res.status(404).json({ message: 'No encontrado' });
    if (entry.status !== 'BORRADOR') return res.status(400).json({ message: 'Solo se editan borradores' });
    const { date, description, lines } = req.body;
    if (lines) { const { resolved, totalDebit, totalCredit } = await hydrateLines(req.clinicId, lines); entry.lines = resolved; entry.totalDebit = totalDebit; entry.totalCredit = totalCredit; }
    if (date) entry.date = new Date(date);
    if (description !== undefined) entry.description = description;
    await entry.save();
    res.json(entry);
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

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

/** Libro mayor por cuenta. */
exports.ledger = async (req, res) => {
  try {
    const { account, startDate, endDate, costCenter } = req.query;
    if (!account) return res.status(400).json({ message: 'account requerido' });
    const acc = await ChartOfAccount.findOne({ _id: account, clinic: req.clinicId });
    if (!acc) return res.status(404).json({ message: 'Cuenta no encontrada' });

    const dateFilter = {};
    if (startDate) dateFilter.$gte = startOfDay(startDate);
    if (endDate) dateFilter.$lte = endOfDay(endDate);

    // Saldo inicial: movimientos anteriores (aggregate requiere ObjectId, no string).
    const initFilter = { clinic: asObjectId(req.clinicId), status: 'CONTABILIZADO', 'lines.account': acc._id };
    if (startDate) initFilter.date = { $lt: startOfDay(startDate) };
    const init = await JournalEntry.aggregate([
      { $match: initFilter },
      { $unwind: '$lines' },
      { $match: { 'lines.account': acc._id, ...(costCenter ? { 'lines.costCenter': require('mongoose').Types.ObjectId.createFromHexString(costCenter) } : {}) } },
      { $group: { _id: null, d: { $sum: '$lines.debit' }, c: { $sum: '$lines.credit' } } },
    ]);
    const opening = acc.nature === 'DEBITO' ? (init[0]?.d || 0) - (init[0]?.c || 0) : (init[0]?.c || 0) - (init[0]?.d || 0);

    const match = { clinic: req.clinicId, status: 'CONTABILIZADO', 'lines.account': acc._id };
    if (startDate || endDate) match.date = dateFilter;
    const entries = await JournalEntry.find(match).sort({ date: 1, number: 1 });

    const rows = [];
    let saldo = opening;
    for (const e of entries) {
      for (const l of e.lines) {
        if (String(l.account) !== String(acc._id)) continue;
        if (costCenter && String(l.costCenter || '') !== String(costCenter)) continue;
        const delta = acc.nature === 'DEBITO' ? (l.debit - l.credit) : (l.credit - l.debit);
        saldo += delta;
        rows.push({
          date: e.date,
          number: e.number,
          description: l.description || e.description,
          debit: l.debit,
          credit: l.credit,
          saldo,
        });
      }
    }
    res.json({ account: { _id: acc._id, code: acc.code, name: acc.name, nature: acc.nature }, opening, rows });
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
