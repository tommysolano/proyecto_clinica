const DeferredIncome = require('../models/DeferredIncome');
const { createEntry, runInTransaction, assertPeriodOpen } = require('../utils/accounting');

/** Lista los ingresos diferidos (paquetes) con filtros opcionales. */
exports.list = async (req, res) => {
  try {
    const { status, patient, q } = req.query;
    const filter = { clinic: req.clinicId };
    if (status) filter.status = status;
    if (patient) filter.patient = patient;
    if (q) filter.productName = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const items = await DeferredIncome.find(filter)
      .populate('patient', 'firstName lastName cedula')
      .populate('product', 'name code')
      .sort({ createdAt: -1 })
      .limit(300);
    const totals = items.reduce((a, d) => {
      a.total += d.total; a.recognized += d.recognized; a.balance += d.balance; return a;
    }, { total: 0, recognized: 0, balance: 0 });
    res.json({
      items,
      totals: {
        total: +totals.total.toFixed(2),
        recognized: +totals.recognized.toFixed(2),
        balance: +totals.balance.toFixed(2),
      },
    });
  } catch (e) {
    res.status(500).json({ message: 'Error al listar ingresos diferidos', error: e.message });
  }
};

exports.get = async (req, res) => {
  try {
    const di = await DeferredIncome.findOne({ _id: req.params.id, clinic: req.clinicId })
      .populate('patient', 'firstName lastName')
      .populate('product', 'name code');
    if (!di) return res.status(404).json({ message: 'No encontrado' });
    res.json(di);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/**
 * Reconoce ingreso diferido (total o parcial):
 *   Dr Ingresos diferidos / Cr Ingreso por servicios.
 * Body: { sessions?, amount?, date? }. Si se indican `sessions` y el paquete
 * tiene `sessionsTotal`, el monto se prorratea; si se indica `amount`, se usa ese;
 * si no se indica nada, se reconoce el saldo completo.
 */
exports.recognize = async (req, res) => {
  try {
    const result = await runInTransaction(async (session) => {
      const di = await DeferredIncome.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!di) throw Object.assign(new Error('Ingreso diferido no encontrado'), { status: 404 });
      if (di.status === 'ANULADO') throw Object.assign(new Error('Documento anulado'), { status: 400 });
      if (di.balance <= 0.005) throw Object.assign(new Error('No queda saldo por reconocer'), { status: 400 });
      if (!di.deferredAccount || !di.incomeAccount) {
        throw Object.assign(new Error('Faltan cuentas (diferida/ingreso) en el documento'), { status: 400 });
      }

      const date = req.body.date ? new Date(req.body.date) : new Date();
      await assertPeriodOpen(req.clinicId, date, { session });

      const sessions = Number(req.body.sessions) || 0;
      let amount;
      if (req.body.amount != null) {
        amount = +(Number(req.body.amount) || 0).toFixed(2);
      } else if (sessions > 0 && di.sessionsTotal > 0) {
        amount = +(di.total * (sessions / di.sessionsTotal)).toFixed(2);
      } else {
        amount = di.balance;
      }
      if (amount <= 0) throw Object.assign(new Error('Monto a reconocer inválido'), { status: 400 });
      // No reconocer más que el saldo (tolerancia de centavos -> ajusta al saldo).
      if (amount > di.balance + 0.01) amount = di.balance;

      const entry = await createEntry({
        clinicId: req.clinicId,
        date,
        description: `Reconocimiento ingreso diferido ${di.productName || ''}`.trim(),
        source: 'AJUSTE',
        sourceModel: 'DeferredIncome',
        sourceRef: di._id,
        sourceAction: `RECOGNIZE:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        lines: [
          { account: di.deferredAccount, debit: amount, credit: 0, description: 'Reconocimiento ingreso diferido' },
          { account: di.incomeAccount, debit: 0, credit: amount, description: 'Ingreso por servicios reconocido' },
        ],
        userId: req.user._id,
        session,
      });

      di.recognized = +(Number(di.recognized || 0) + amount).toFixed(2);
      if (sessions > 0) di.sessionsUsed = Math.min(di.sessionsTotal || sessions, (di.sessionsUsed || 0) + sessions);
      await di.save({ session });
      return { di, entry: { _id: entry._id, number: entry.number, amount } };
    });
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};
