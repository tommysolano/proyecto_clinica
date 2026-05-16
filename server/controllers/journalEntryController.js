const JournalEntry = require('../models/JournalEntry');
const ChartOfAccount = require('../models/ChartOfAccount');
const { createEntry, reverseEntry } = require('../utils/accounting');

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
    const { date, description, lines } = req.body;
    const entry = await createEntry({
      clinicId: req.clinicId,
      date: date ? new Date(date) : new Date(),
      description,
      source: 'MANUAL',
      lines,
      userId: req.user._id,
    });
    res.status(201).json(entry);
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
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
    if (startDate) dateFilter.$gte = new Date(startDate);
    if (endDate) dateFilter.$lte = new Date(endDate);

    // Saldo inicial: movimientos anteriores
    const initFilter = { clinic: req.clinicId, status: 'CONTABILIZADO', 'lines.account': acc._id };
    if (startDate) initFilter.date = { $lt: new Date(startDate) };
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
    const match = { clinic: req.clinicId, status: 'CONTABILIZADO' };
    if (startDate || endDate) {
      match.date = {};
      if (startDate) match.date.$gte = new Date(startDate);
      if (endDate) match.date.$lte = new Date(endDate);
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
