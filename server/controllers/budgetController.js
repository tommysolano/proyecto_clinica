const Budget = require('../models/Budget');
const ChartOfAccount = require('../models/ChartOfAccount');
const AccountBalance = require('../models/AccountBalance');

exports.list = async (req, res) => {
  const items = await Budget.find({ clinic: req.clinicId }).sort({ year: -1 });
  res.json(items);
};

exports.get = async (req, res) => {
  const b = await Budget.findOne({ _id: req.params.id, clinic: req.clinicId }).populate('lines.account', 'code name type');
  if (!b) return res.status(404).json({ message: 'No encontrado' });
  res.json(b);
};

exports.upsert = async (req, res) => {
  try {
    const { year, name, costCenter, lines } = req.body;
    if (!year) return res.status(400).json({ message: 'year requerido' });
    const filter = { clinic: req.clinicId, year, costCenter: costCenter || null };
    let b = await Budget.findOne(filter);
    if (!b) b = new Budget({ ...filter });
    b.name = name || b.name;
    if (Array.isArray(lines)) b.lines = lines.map((l) => ({ account: l.account, amounts: (l.amounts || []).slice(0, 12) }));
    b.createdBy = req.user._id;
    await b.save();
    res.json(b);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.remove = async (req, res) => {
  const b = await Budget.findOneAndDelete({ _id: req.params.id, clinic: req.clinicId });
  if (!b) return res.status(404).json({ message: 'No encontrado' });
  res.json({ ok: true });
};

/** Comparativo presupuesto vs. real del año (por cuenta). */
exports.execution = async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const costCenter = req.query.costCenter || null;
    const budget = await Budget.findOne({ clinic: req.clinicId, year, costCenter: costCenter || null });
    if (!budget) return res.json({ year, rows: [], totals: { budget: 0, actual: 0, variance: 0 } });

    const balances = await AccountBalance.find({ clinic: req.clinicId, year });
    const accounts = await ChartOfAccount.find({ clinic: req.clinicId });
    const accMap = new Map(accounts.map((a) => [String(a._id), a]));
    // Real por cuenta (respetando naturaleza)
    const actualMap = new Map();
    for (const bal of balances) {
      const acc = accMap.get(String(bal.account));
      if (!acc) continue;
      const net = acc.nature === 'DEBITO' ? bal.debit - bal.credit : bal.credit - bal.debit;
      actualMap.set(String(bal.account), (actualMap.get(String(bal.account)) || 0) + net);
    }

    const rows = budget.lines.map((l) => {
      const acc = accMap.get(String(l.account));
      const budgeted = (l.amounts || []).reduce((s, n) => s + (Number(n) || 0), 0);
      const actual = +(actualMap.get(String(l.account)) || 0).toFixed(2);
      const variance = +(actual - budgeted).toFixed(2);
      return {
        account: acc ? { _id: acc._id, code: acc.code, name: acc.name, type: acc.type } : null,
        budget: +budgeted.toFixed(2), actual, variance,
        compliance: budgeted ? +((actual / budgeted) * 100).toFixed(1) : 0,
      };
    });
    const totals = rows.reduce((a, r) => ({ budget: a.budget + r.budget, actual: a.actual + r.actual, variance: a.variance + r.variance }), { budget: 0, actual: 0, variance: 0 });
    res.json({ year, rows, totals });
  } catch (e) { res.status(500).json({ message: e.message }); }
};
