const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const Reconciliation = require('../models/Reconciliation');
const BankCheck = require('../models/BankCheck');
const CreditCard = require('../models/CreditCard');
const Sale = require('../models/Sale');
const ChartOfAccount = require('../models/ChartOfAccount');
const { createEntry, findAccount, runInTransaction, assertPeriodOpen, reverseEntry } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const ExcelJS = require('exceljs');
const multer = require('multer');

// Carga de archivos en memoria para parsear estados de cuenta (CSV/Excel).
exports.uploadStatementMiddleware = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }).single('file');

/**
 * Opciones de medios de pago para el punto de cobro (cajero / recepción).
 * Devuelve solo lo necesario para los selectores: cuentas bancarias y
 * tarjetas/POS activos. No expone saldos ni datos sensibles.
 */
exports.paymentOptions = async (req, res) => {
  try {
    const [accounts, cards] = await Promise.all([
      BankAccount.find({ clinic: req.clinicId, active: true })
        .select('name bank accountNumber accountType')
        .sort({ name: 1 }),
      CreditCard.find({ clinic: req.clinicId, active: true })
        .select('name brand acquirer pos')
        .sort({ name: 1 }),
    ]);
    const cardsOut = cards.map((c) => ({
      _id: c._id,
      name: c.name,
      brand: c.brand,
      acquirer: c.acquirer,
      pos: (c.pos || []).filter((p) => p.active !== false).map((p) => ({ code: p.code, name: p.name, terminal: p.terminal })),
    }));
    res.json({ accounts, cards: cardsOut });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// ---------- Cuentas bancarias ----------
exports.listAccounts = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.active !== undefined) filter.active = req.query.active === 'true';
  const accs = await BankAccount.find(filter).populate('chartAccount', 'code name').sort({ name: 1 });
  res.json(accs);
};

exports.createAccount = async (req, res) => {
  try {
    const data = { ...req.body, clinic: req.clinicId };
    const acc = await BankAccount.create(data);
    res.status(201).json(acc);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.updateAccount = async (req, res) => {
  try {
    const acc = await BankAccount.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!acc) return res.status(404).json({ message: 'No encontrada' });
    Object.assign(acc, req.body);
    await acc.save();
    res.json(acc);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.deleteAccount = async (req, res) => {
  const acc = await BankAccount.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!acc) return res.status(404).json({ message: 'No encontrada' });
  const has = await BankTransaction.countDocuments({ bankAccount: acc._id, voided: false });
  if (has) return res.status(400).json({ message: 'Tiene movimientos, no se puede eliminar' });
  await acc.deleteOne();
  res.json({ message: 'Eliminada' });
};

// ---------- Saldos ----------
exports.balances = async (req, res) => {
  try {
    const accounts = await BankAccount.find({ clinic: req.clinicId, active: true }).populate('chartAccount', 'code name');
    const out = [];
    for (const a of accounts) {
      const agg = await BankTransaction.aggregate([
        { $match: { clinic: a.clinic, bankAccount: a._id, voided: false } },
        { $group: { _id: null, total: { $sum: { $multiply: ['$amount', '$direction'] } } } },
      ]);
      const bookBalance = (a.initialBalance || 0) + (agg[0]?.total || 0);
      out.push({ _id: a._id, name: a.name, bank: a.bank, accountNumber: a.accountNumber,
                 chartAccount: a.chartAccount, bookBalance });
    }
    res.json(out);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ---------- Helper: genera asiento contable de banco ----------
async function postBankJournal({
  clinicId,
  userId,
  date,
  description,
  bank,
  counterAccountCode,
  amount,
  direction,
  source = 'BANCO',
  sourceModel,
  sourceRef,
  sourceAction,
  session,
}) {
  const bankAcc = await ChartOfAccount.findById(bank.chartAccount).session(session || null);
  const counter = await findAccount(clinicId, { code: counterAccountCode }, { session });
  const lines = direction > 0
    ? [
        { account: bankAcc._id, debit: amount, credit: 0, description },
        { account: counter._id, debit: 0, credit: amount, description },
      ]
    : [
        { account: counter._id, debit: amount, credit: 0, description },
        { account: bankAcc._id, debit: 0, credit: amount, description },
      ];
  return createEntry({
    clinicId,
    date,
    description,
    source,
    sourceModel,
    sourceRef,
    sourceAction,
    lines,
    userId,
    session,
  });
}

// ---------- Movimientos genéricos ----------
exports.createMovement = async (req, res) => {
  try {
    const { bankAccount, type, amount, date, description, reference,
            counterAccountCode, checkNumber, counterpartAccount,
            voucherUrl, voucherNumber } = req.body;
    {
      const result = await runInTransaction(async (session) => {
        if (!bankAccount || !type || !amount) {
          throw Object.assign(new Error('bankAccount, type y amount requeridos'), { status: 400 });
        }
        const txAmount = +Number(amount).toFixed(2);
        if (txAmount <= 0) throw Object.assign(new Error('Monto invalido'), { status: 400 });
        const txDate = date ? new Date(date) : new Date();
        await assertPeriodOpen(req.clinicId, txDate, { session });

        const bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId }).session(session);
        if (!bank) throw Object.assign(new Error('Cuenta bancaria no encontrada'), { status: 404 });

        const inflow = ['DEPOSITO', 'TRANSFERENCIA_IN', 'INTERES', 'COBRO'].includes(type);
        const direction = inflow ? 1 : -1;
        const requiresVoucher = ['DEPOSITO', 'TRANSFERENCIA_IN', 'TRANSFERENCIA_OUT', 'CHEQUE_EMITIDO'].includes(type);
        if (requiresVoucher && !voucherNumber && !voucherUrl && !reference) {
          throw Object.assign(new Error('Comprobante requerido (voucherNumber, voucherUrl o reference)'), { status: 400 });
        }

        const counterRoleByType = {
          DEPOSITO: 'caja',
          RETIRO: 'caja',
          CAJA_CHICA: 'cajaChica',
          ANTICIPO: 'anticipoProveedores',
          COMISION: 'comisionBancaria',
          INTERES: 'interesesGanados',
          AJUSTE: 'resultadosAcumulados',
          CHEQUE_EMITIDO: 'proveedores',
        };
        let defaultCounter = counterAccountCode || null;
        if (!defaultCounter && counterRoleByType[type]) {
          defaultCounter = (await getAccount(req.clinicId, counterRoleByType[type], { session })).code;
        }

        let counterpartTx = null;
        let entry = null;
        let realCheckNumber = checkNumber;

        if (type === 'TRANSFERENCIA_OUT' || type === 'TRANSFERENCIA_IN') {
          if (!counterpartAccount) throw Object.assign(new Error('counterpartAccount requerido para transferencia'), { status: 400 });
          const other = await BankAccount.findOne({ _id: counterpartAccount, clinic: req.clinicId }).session(session);
          if (!other) throw Object.assign(new Error('Cuenta contraparte no encontrada'), { status: 404 });
          const out = direction < 0 ? bank : other;
          const inn = direction > 0 ? bank : other;
          const outBalanceAgg = await BankTransaction.aggregate([
            { $match: { clinic: out.clinic, bankAccount: out._id, voided: false } },
            { $group: { _id: null, total: { $sum: { $multiply: ['$amount', '$direction'] } } } },
          ]).session(session);
          const outBalance = (out.initialBalance || 0) + (outBalanceAgg[0]?.total || 0);
          if (outBalance < txAmount) {
            throw Object.assign(new Error(`Saldo insuficiente en ${out.name} (disponible $${outBalance.toFixed(2)})`), { status: 400 });
          }

          const [mainTx] = await BankTransaction.create([{
            clinic: req.clinicId,
            bankAccount: bank._id,
            date: txDate,
            type,
            amount: txAmount,
            direction,
            description,
            reference,
            voucherUrl: voucherUrl || '',
            voucherNumber: voucherNumber || '',
            counterpartAccount: other._id,
            createdBy: req.user._id,
          }], { session });
          [counterpartTx] = await BankTransaction.create([{
            clinic: req.clinicId,
            bankAccount: other._id,
            date: txDate,
            type: direction > 0 ? 'TRANSFERENCIA_OUT' : 'TRANSFERENCIA_IN',
            amount: txAmount,
            direction: -direction,
            description,
            reference,
            voucherUrl: voucherUrl || '',
            voucherNumber: voucherNumber || '',
            counterpartAccount: bank._id,
            createdBy: req.user._id,
          }], { session });
          entry = await createEntry({
            clinicId: req.clinicId,
            date: txDate,
            description: description || 'Transferencia bancaria',
            source: 'BANCO',
            sourceModel: 'BankTransaction',
            sourceRef: mainTx._id,
            sourceAction: 'TRANSFER',
            userId: req.user._id,
            session,
            lines: [
              { account: inn.chartAccount, debit: txAmount, credit: 0, description },
              { account: out.chartAccount, debit: 0, credit: txAmount, description },
            ],
          });
          mainTx.journalEntry = entry._id;
          counterpartTx.journalEntry = entry._id;
          await mainTx.save({ session });
          await counterpartTx.save({ session });
          return { transaction: mainTx, journalEntry: entry, counterpartTx };
        }

        if (direction < 0) {
          const agg = await BankTransaction.aggregate([
            { $match: { clinic: bank.clinic, bankAccount: bank._id, voided: false } },
            { $group: { _id: null, total: { $sum: { $multiply: ['$amount', '$direction'] } } } },
          ]).session(session);
          const balance = (bank.initialBalance || 0) + (agg[0]?.total || 0);
          if (balance < txAmount) {
            throw Object.assign(new Error(`Saldo insuficiente en ${bank.name} (disponible $${balance.toFixed(2)})`), { status: 400 });
          }
        }

        if (type === 'CHEQUE_EMITIDO') {
          realCheckNumber = checkNumber || String(bank.nextCheckNumber);
          bank.nextCheckNumber = (parseInt(realCheckNumber, 10) || bank.nextCheckNumber) + 1;
          await bank.save({ session });
        }

        const [tx] = await BankTransaction.create([{
          clinic: req.clinicId,
          bankAccount: bank._id,
          date: txDate,
          type,
          amount: txAmount,
          direction,
          description,
          reference,
          checkNumber: realCheckNumber,
          voucherUrl: voucherUrl || '',
          voucherNumber: voucherNumber || '',
          createdBy: req.user._id,
        }], { session });

        entry = await postBankJournal({
          clinicId: req.clinicId,
          userId: req.user._id,
          date: txDate,
          description: description || type,
          bank,
          counterAccountCode: defaultCounter,
          amount: txAmount,
          direction,
          sourceModel: 'BankTransaction',
          sourceRef: tx._id,
          sourceAction: 'POST',
          session,
        });
        tx.journalEntry = entry._id;
        await tx.save({ session });

        if (type === 'CHEQUE_EMITIDO' && realCheckNumber) {
          await BankCheck.findOneAndUpdate(
            { clinic: req.clinicId, bankAccount: bank._id, number: parseInt(realCheckNumber, 10) },
            { status: 'GIRADO', beneficiary: description || '', amount: txAmount, date: txDate, transaction: tx._id },
            { session }
          );
        }
        return { transaction: tx, journalEntry: entry, counterpartTx: null };
      });
      return res.status(201).json(result);
    }
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

exports.listMovements = async (req, res) => {
  const { bankAccount, startDate, endDate, type, reconciled, page = 1, limit = 50 } = req.query;
  const filter = { clinic: req.clinicId };
  if (bankAccount) filter.bankAccount = bankAccount;
  if (type) filter.type = type;
  if (reconciled !== undefined) filter.reconciled = reconciled === 'true';
  if (startDate || endDate) {
    filter.date = {};
    if (startDate) filter.date.$gte = new Date(startDate);
    if (endDate) filter.date.$lte = new Date(endDate);
  }
  const total = await BankTransaction.countDocuments(filter);
  const items = await BankTransaction.find(filter)
    .populate('bankAccount', 'name bank accountNumber')
    .populate('createdBy', 'name')
    .sort({ date: -1, createdAt: -1 })
    .skip((page - 1) * limit).limit(parseInt(limit));
  res.json({ items, total, pages: Math.ceil(total / limit), currentPage: parseInt(page) });
};

exports.voidMovement = async (req, res) => {
  try {
    {
      const result = await runInTransaction(async (session) => {
        const tx = await BankTransaction.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
        if (!tx) throw Object.assign(new Error('No encontrado'), { status: 404 });
        if (tx.voided) throw Object.assign(new Error('Ya anulado'), { status: 400 });
        if (tx.reconciled) throw Object.assign(new Error('Conciliado, no se puede anular'), { status: 400 });
        const reversalDate = req.body.date ? new Date(req.body.date) : new Date();
        await assertPeriodOpen(req.clinicId, reversalDate, { session });

        const toVoid = [tx];
        if (tx.journalEntry && ['TRANSFERENCIA_IN', 'TRANSFERENCIA_OUT'].includes(tx.type)) {
          const pair = await BankTransaction.findOne({
            _id: { $ne: tx._id },
            clinic: req.clinicId,
            journalEntry: tx.journalEntry,
            voided: false,
          }).session(session);
          if (pair) {
            if (pair.reconciled) throw Object.assign(new Error('La contraparte esta conciliada, no se puede anular'), { status: 400 });
            toVoid.push(pair);
          }
        }

        if (tx.journalEntry) {
          await reverseEntry({
            clinicId: req.clinicId,
            entryId: tx.journalEntry,
            userId: req.user._id,
            reason: `Anulacion tx ${tx._id}`,
            date: reversalDate,
            session,
          });
        }

        for (const item of toVoid) {
          item.voided = true;
          item.voidedAt = reversalDate;
          item.voidedBy = req.user._id;
          item.voidReason = req.body?.reason || '';
          await item.save({ session });
          await BankAccount.updateOne(
            { _id: item.bankAccount },
            { $inc: { bookBalance: -(Number(item.amount || 0) * Number(item.direction || 0)) } },
            { session }
          );
        }
        return { message: 'Anulado', voidedCount: toVoid.length };
      });
      return res.json(result);
    }
  } catch (e) { res.status(400).json({ message: e.message }); }
};

// ---------- Convertir ventas en efectivo a depósito en cuenta bancaria ----------

// Lista las ventas en efectivo pendientes de depósito (caja) y el total acumulado.
exports.getCashPending = async (req, res) => {
  try {
    const filter = {
      clinic: req.clinicId,
      paymentMethod: 'efectivo',
      status: 'completada',
    };
    if (req.query.startDate && req.query.endDate) {
      filter.createdAt = {
        $gte: new Date(req.query.startDate),
        $lte: new Date(req.query.endDate),
      };
    }
    const sales = await Sale.find(filter)
      .populate('patient', 'firstName lastName cedula')
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 });
    const total = sales.reduce((s, v) => s + (v.total || 0), 0);
    res.json({ sales, total, count: sales.length });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

exports.cashToTransfer = async (req, res) => {
  try {
    const { saleIds, bankAccount, voucher, date, description } = req.body;
    {
      const result = await runInTransaction(async (session) => {
        if (!Array.isArray(saleIds) || !saleIds.length) throw Object.assign(new Error('saleIds requerido'), { status: 400 });
        if (!bankAccount || !voucher) throw Object.assign(new Error('bankAccount y voucher requeridos'), { status: 400 });
        const txDate = date ? new Date(date) : new Date();
        await assertPeriodOpen(req.clinicId, txDate, { session });
        const bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId }).session(session);
        if (!bank) throw Object.assign(new Error('Cuenta bancaria no encontrada'), { status: 404 });
        const sales = await Sale.find({
          _id: { $in: saleIds },
          clinic: req.clinicId,
          paymentMethod: 'efectivo',
          status: 'completada',
        }).session(session);
        if (!sales.length) throw Object.assign(new Error('No hay ventas en efectivo validas'), { status: 400 });
        const total = +sales.reduce((s, v) => s + (Number(v.total) || 0), 0).toFixed(2);
        const [tx] = await BankTransaction.create([{
          clinic: req.clinicId,
          bankAccount: bank._id,
          date: txDate,
          type: 'DEPOSITO',
          amount: total,
          direction: 1,
          description: description || 'Deposito ventas efectivo',
          reference: voucher,
          voucherNumber: voucher,
          sourceModel: 'CashDeposit',
          createdBy: req.user._id,
        }], { session });
        const cajaAcc = await getAccount(req.clinicId, 'caja', { session });
        const entry = await postBankJournal({
          clinicId: req.clinicId,
          userId: req.user._id,
          date: txDate,
          description: description || `Deposito ventas efectivo - papeleta ${voucher}`,
          bank,
          counterAccountCode: cajaAcc.code,
          amount: total,
          direction: 1,
          sourceModel: 'BankTransaction',
          sourceRef: tx._id,
          sourceAction: 'CASH_DEPOSIT',
          session,
        });
        tx.journalEntry = entry._id;
        tx.sourceRef = tx._id;
        await tx.save({ session });
        await Sale.updateMany(
          { _id: { $in: sales.map((s) => s._id) }, clinic: req.clinicId },
          { $set: { paymentMethod: 'transferencia', notes: `Depositado en ${bank.name} - papeleta ${voucher}` } },
          { session }
        );
        return { transaction: tx, journalEntry: entry, total, salesCount: sales.length };
      });
      return res.json(result);
    }
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

// ---------- Conciliación bancaria ----------

/** Calcula el saldo contable (libro) de una cuenta hasta una fecha de corte (incl.). */
async function bookBalanceAt(clinicId, bank, cutDate, session) {
  const q = BankTransaction.aggregate([
    { $match: { clinic: bank.clinic, bankAccount: bank._id, voided: false, date: { $lte: cutDate } } },
    { $group: { _id: null, total: { $sum: { $multiply: ['$amount', '$direction'] } } } },
  ]);
  if (session) q.session(session);
  const agg = await q;
  return +(((bank.initialBalance || 0) + (agg[0]?.total || 0))).toFixed(2);
}

/** Devuelve la conciliación con sus movimientos del libro y líneas del extracto poblados. */
async function populatedReconciliation(id) {
  return Reconciliation.findById(id)
    .populate('bankAccount', 'name bank initialBalance')
    .populate('items.transaction', 'date type description amount direction reference voucherNumber')
    .populate('statementLines.transaction', 'date description amount direction');
}

/**
 * Inicia una conciliación por FECHA DE CORTE (no se usa fecha inicial). Trae todos
 * los movimientos del libro NO conciliados hasta el corte y calcula el saldo contable.
 * Body: { bankAccount, cutDate, statementBalance, description }
 */
exports.startReconciliation = async (req, res) => {
  try {
    const { bankAccount, cutDate, statementBalance = 0, description = '' } = req.body;
    if (!bankAccount || !cutDate) return res.status(400).json({ message: 'bankAccount y fecha de corte son requeridos' });
    const bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId });
    if (!bank) return res.status(404).json({ message: 'Cuenta no encontrada' });
    const cut = new Date(cutDate);
    // Movimientos del libro pendientes de conciliar hasta el corte.
    const txs = await BankTransaction.find({
      clinic: req.clinicId, bankAccount: bank._id, voided: false, reconciled: false,
      date: { $lte: cut },
    }).sort({ date: 1 });
    const items = txs.map((t) => ({ transaction: t._id, matched: false }));
    const bookBalance = await bookBalanceAt(req.clinicId, bank, cut);
    const rec = await Reconciliation.create({
      clinic: req.clinicId, bankAccount: bank._id,
      cutDate: cut, periodEnd: cut, description,
      statementBalance: Number(statementBalance) || 0, bookBalance,
      difference: +((Number(statementBalance) || 0) - bookBalance).toFixed(2),
      items, createdBy: req.user._id,
    });
    res.status(201).json(await populatedReconciliation(rec._id));
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/** Detalle de una conciliación (con movimientos y extracto poblados). */
exports.getReconciliation = async (req, res) => {
  try {
    const rec = await populatedReconciliation(req.params.id);
    if (!rec || String(rec.clinic) !== String(req.clinicId)) return res.status(404).json({ message: 'No encontrada' });
    res.json(rec);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.updateReconciliation = async (req, res) => {
  try {
    const rec = await Reconciliation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!rec) return res.status(404).json({ message: 'No encontrada' });
    if (rec.status === 'CONCILIADO') return res.status(400).json({ message: 'Ya cerrada' });
    // Solo persistimos los flags de match (no se reescriben las transacciones).
    if (Array.isArray(req.body.items)) {
      const flags = new Map(req.body.items.map((i) => [String(i.transaction?._id || i.transaction), i]));
      rec.items = rec.items.map((it) => {
        const f = flags.get(String(it.transaction));
        return f ? { transaction: it.transaction, matched: !!f.matched, statementRef: f.statementRef || it.statementRef || '' } : it;
      });
    }
    if (req.body.statementBalance !== undefined) rec.statementBalance = Number(req.body.statementBalance) || 0;
    if (req.body.description !== undefined) rec.description = req.body.description;
    if (req.body.notes !== undefined) rec.notes = req.body.notes;
    rec.difference = +(rec.statementBalance - rec.bookBalance).toFixed(2);
    await rec.save();
    res.json(await populatedReconciliation(rec._id));
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.closeReconciliation = async (req, res) => {
  try {
    const recId = await runInTransaction(async (session) => {
      const rec = await Reconciliation.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!rec) throw Object.assign(new Error('No encontrada'), { status: 404 });
      if (rec.status === 'CONCILIADO') throw Object.assign(new Error('Ya está conciliada'), { status: 400 });
      rec.status = 'CONCILIADO';
      rec.closedAt = new Date();
      await rec.save({ session });
      const matchedIds = rec.items.filter((i) => i.matched).map((i) => i.transaction);
      if (matchedIds.length) {
        await BankTransaction.updateMany(
          { _id: { $in: matchedIds }, clinic: req.clinicId, bankAccount: rec.bankAccount },
          { reconciled: true, reconciliation: rec._id },
          { session }
        );
      }
      return rec._id;
    });
    res.json(await populatedReconciliation(recId));
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/**
 * Importa el extracto bancario DENTRO de una conciliación: empareja cada línea con
 * un movimiento del libro pendiente (por monto con signo y fecha cercana), marca
 * esos movimientos como conciliados y guarda las líneas (las sin match quedan para
 * crear como movimiento). Body: { lines: [{date, description, reference, amount}] }
 */
exports.reconcileImport = async (req, res) => {
  try {
    const { lines = [] } = req.body;
    const rec = await Reconciliation.findOne({ _id: req.params.id, clinic: req.clinicId }).populate('items.transaction', 'date amount direction reference voucherNumber');
    if (!rec) return res.status(404).json({ message: 'No encontrada' });
    if (rec.status === 'CONCILIADO') return res.status(400).json({ message: 'Ya está conciliada' });

    const used = new Set();
    const statementLines = lines.map((ln) => {
      const amt = Number(ln.amount) || 0;
      const ref = String(ln.reference || '').trim().toLowerCase();
      const lineDate = ln.date ? new Date(ln.date) : null;
      let best = null, bestScore = -1;
      for (const it of rec.items) {
        const t = it.transaction;
        if (!t || used.has(String(t._id))) continue;
        const signed = t.amount * t.direction;
        if (Math.abs(signed - amt) > 0.01) continue;
        let score = 1;
        if (ref && (String(t.reference || '').toLowerCase() === ref || String(t.voucherNumber || '').toLowerCase() === ref)) score += 3;
        if (lineDate) { const days = Math.abs((new Date(t.date) - lineDate) / 86400000); if (days <= 1) score += 2; else if (days <= 5) score += 1; }
        if (score > bestScore) { bestScore = score; best = it; }
      }
      if (best) {
        used.add(String(best.transaction._id));
        best.matched = true;
        best.statementRef = ln.reference || '';
      }
      return {
        date: lineDate, description: ln.description || '', reference: ln.reference || '', amount: amt,
        matched: !!best, transaction: best ? best.transaction._id : null,
      };
    });
    rec.statementLines = statementLines;
    rec.difference = +(rec.statementBalance - rec.bookBalance).toFixed(2);
    await rec.save();
    const matched = statementLines.filter((l) => l.matched).length;
    const out = await populatedReconciliation(rec._id);
    res.json({ reconciliation: out, matched, unmatched: statementLines.length - matched });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/**
 * Crea movimientos del libro (con asiento) para líneas del extracto sin match dentro
 * de una conciliación (comisiones, intereses, notas de débito del banco, etc.) y los
 * agrega a la conciliación ya marcados. Body: { creates: [{date, amount, description, reference, counterAccountCode}] }
 */
exports.reconcileCreateMovements = async (req, res) => {
  try {
    const { creates = [] } = req.body;
    const recId = await runInTransaction(async (session) => {
      const rec = await Reconciliation.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!rec) throw Object.assign(new Error('No encontrada'), { status: 404 });
      if (rec.status === 'CONCILIADO') throw Object.assign(new Error('Ya está conciliada'), { status: 400 });
      const bank = await BankAccount.findOne({ _id: rec.bankAccount, clinic: req.clinicId }).session(session);
      if (!bank) throw Object.assign(new Error('Cuenta no encontrada'), { status: 404 });

      for (const c of creates) {
        const amount = Math.abs(Number(c.amount) || 0);
        if (!amount) continue;
        const direction = (Number(c.amount) || 0) >= 0 ? 1 : -1;
        const txDate = c.date ? new Date(c.date) : new Date();
        await assertPeriodOpen(req.clinicId, txDate, { session });
        const counterCode = c.counterAccountCode
          || (await getAccount(req.clinicId, direction > 0 ? 'interesesGanados' : 'comisionBancaria', { session })).code;
        const [tx] = await BankTransaction.create([{
          clinic: req.clinicId, bankAccount: bank._id, date: txDate,
          type: c.type || (direction > 0 ? 'DEPOSITO' : 'COMISION'),
          amount, direction,
          description: c.description || 'Movimiento de estado de cuenta',
          reference: c.reference || '', reconciled: true, reconciliation: rec._id,
          createdBy: req.user._id,
        }], { session });
        const entry = await postBankJournal({
          clinicId: req.clinicId, userId: req.user._id, date: txDate,
          description: c.description || 'Movimiento de estado de cuenta',
          bank, counterAccountCode: counterCode, amount, direction,
          sourceModel: 'BankTransaction', sourceRef: tx._id, sourceAction: 'STATEMENT', session,
        });
        tx.journalEntry = entry._id;
        await tx.save({ session });
        // Lo agregamos a la conciliación ya conciliado.
        rec.items.push({ transaction: tx._id, matched: true, statementRef: c.reference || '' });
        // Si la línea del extracto existía, la marcamos enlazada.
        const sl = rec.statementLines.find((l) => !l.matched && Math.abs((l.amount || 0) - amount * direction) < 0.01);
        if (sl) { sl.matched = true; sl.transaction = tx._id; }
      }
      // El saldo contable sube/baja con los nuevos movimientos.
      rec.bookBalance = await bookBalanceAt(req.clinicId, bank, rec.cutDate, session);
      rec.difference = +(rec.statementBalance - rec.bookBalance).toFixed(2);
      await rec.save({ session });
      return rec._id;
    });
    res.json(await populatedReconciliation(recId));
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

exports.listReconciliations = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.bankAccount) filter.bankAccount = req.query.bankAccount;
  const items = await Reconciliation.find(filter).populate('bankAccount', 'name bank').sort({ cutDate: -1, createdAt: -1 });
  res.json(items);
};

// ---------- Importación de estado de cuenta bancario + matching ----------
// ----- Parseo de estado de cuenta (CSV / Excel) -----

/** Normaliza el valor de una celda (fórmula, rich text, hipervínculo) a algo simple. */
function cellValue(v) {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return v.result;        // fórmula
    if ('text' in v) return v.text;             // rich text / hipervínculo
    if ('hyperlink' in v && 'text' in v) return v.text;
  }
  return v;
}

/** Convierte una fecha (Date de Excel o texto DD/MM/AAAA / AAAA-MM-DD) a 'AAAA-MM-DD'. */
function normalizeDate(v) {
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  const s = String(v || '').trim();
  if (!s) return '';
  // DD/MM/AAAA o DD-MM-AAAA
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return s; // ya viene AAAA-MM-DD u otro formato; se deja como está
}

/** Parsea un número de monto tolerando símbolos, miles y coma decimal. */
function parseAmount(v) {
  if (typeof v === 'number') return v;
  let s = String(v == null ? '' : v).trim();
  if (!s) return 0;
  const neg = /^\(.*\)$/.test(s) || /-/.test(s); // (123) o -123 = negativo
  s = s.replace(/[()]/g, '');
  // Si hay coma y punto, el último separador es el decimal.
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    // Solo coma: si parece decimal (una coma con 1-2 decimales), tratar como decimal
    s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  const n = Math.abs(parseFloat(s.replace(/[^0-9.]/g, ''))) || 0;
  return neg ? -n : n;
}

/**
 * Convierte filas crudas (array de celdas) en líneas { date, description, reference, amount }.
 * Detecta encabezado por palabras clave; si no hay, usa orden posicional
 * (fecha, descripción, [referencia], monto). Soporta columnas Débito/Crédito separadas.
 */
function rowsToLines(rows) {
  const out = [];
  if (!rows.length) return out;

  // ¿La primera fila es encabezado?
  const first = rows[0].map((c) => String(cellValue(c) || '').trim().toLowerCase());
  const looksHeader = first.some((h) => /fecha|date/.test(h)) && first.some((h) => /monto|amount|valor|d[ée]bito|cr[ée]dito|debe|haber|cargo|abono/.test(h));
  let idx = { date: -1, desc: -1, ref: -1, amount: -1, debit: -1, credit: -1 };
  let startRow = 0;
  if (looksHeader) {
    startRow = 1;
    first.forEach((h, i) => {
      if (idx.date < 0 && /fecha|date/.test(h)) idx.date = i;
      else if (idx.desc < 0 && /descrip|concepto|detalle|glosa/.test(h)) idx.desc = i;
      else if (idx.ref < 0 && /refer|documento|comprob|n[uú]mero|nro/.test(h)) idx.ref = i;
      else if (idx.debit < 0 && /d[ée]bito|debe|cargo|retiro/.test(h)) idx.debit = i;
      else if (idx.credit < 0 && /cr[ée]dito|haber|abono|dep[oó]sito/.test(h)) idx.credit = i;
      else if (idx.amount < 0 && /monto|amount|valor|importe/.test(h)) idx.amount = i;
    });
  }

  for (let r = startRow; r < rows.length; r++) {
    const cols = rows[r].map(cellValue);
    if (!cols.length || cols.every((c) => String(c || '').trim() === '')) continue;

    let date, description, reference, amount;
    if (looksHeader && (idx.amount >= 0 || idx.debit >= 0 || idx.credit >= 0)) {
      date = normalizeDate(cols[idx.date]);
      description = idx.desc >= 0 ? String(cols[idx.desc] || '').trim() : '';
      reference = idx.ref >= 0 ? String(cols[idx.ref] || '').trim() : '';
      if (idx.amount >= 0) {
        amount = parseAmount(cols[idx.amount]);
      } else {
        const debit = idx.debit >= 0 ? Math.abs(parseAmount(cols[idx.debit])) : 0;
        const credit = idx.credit >= 0 ? Math.abs(parseAmount(cols[idx.credit])) : 0;
        amount = credit - debit; // crédito = +, débito = -
      }
    } else {
      // Posicional: fecha, descripción, [referencia], monto (última columna con valor).
      const vals = cols;
      date = normalizeDate(vals[0]);
      if (vals.length >= 4) { description = String(vals[1] || '').trim(); reference = String(vals[2] || '').trim(); amount = parseAmount(vals[3]); }
      else if (vals.length === 3) { description = String(vals[1] || '').trim(); reference = ''; amount = parseAmount(vals[2]); }
      else { description = String(vals[1] || '').trim(); reference = ''; amount = parseAmount(vals[vals.length - 1]); }
    }
    if (!amount) continue;
    out.push({ date, description, reference, amount });
  }
  return out;
}

/** Lee un buffer CSV/TXT a filas de celdas. */
function csvBufferToRows(buf) {
  const text = buf.toString('utf-8');
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((ln) => ln.split(/[,;\t]/).map((c) => c.trim()));
}

/** Lee un buffer Excel (.xlsx) a filas de celdas usando la primera hoja. */
async function excelBufferToRows(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) throw Object.assign(new Error('El archivo Excel no tiene hojas'), { status: 400 });
  const rows = [];
  ws.eachRow((row) => {
    const cells = [];
    // row.values es 1-based; el índice 0 es undefined.
    const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
    for (let i = 0; i < vals.length; i++) cells.push(vals[i] === undefined ? '' : vals[i]);
    rows.push(cells);
  });
  return rows;
}

/**
 * Parsea un estado de cuenta subido (CSV, TXT o Excel .xlsx/.xls) y devuelve las
 * líneas normalizadas para conciliar. Body: multipart con campo `file`.
 * Respuesta: { lines: [{ date, description, reference, amount }], count }.
 */
exports.parseStatement = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Archivo requerido' });
    const name = (req.file.originalname || '').toLowerCase();
    const isExcel = /\.xlsx?$/.test(name) || /spreadsheetml|excel/.test(req.file.mimetype || '');
    let rows;
    if (isExcel) {
      try {
        rows = await excelBufferToRows(req.file.buffer);
      } catch (loadErr) {
        return res.status(400).json({
          message: 'No se pudo leer el Excel. Ábrelo en Excel/Google Sheets/LibreOffice y vuelve a guardarlo como .xlsx, o expórtalo a CSV.',
        });
      }
    } else {
      rows = csvBufferToRows(req.file.buffer);
    }
    const lines = rowsToLines(rows);
    if (!lines.length) return res.status(400).json({ message: 'No se detectaron movimientos válidos en el archivo. Revisa que tenga columnas de fecha y monto.' });
    res.json({ lines, count: lines.length });
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/**
 * Recibe líneas del estado de cuenta (parseadas del CSV en el cliente) y sugiere
 * conciliación contra las transacciones del libro no conciliadas.
 * Body: { bankAccount, lines: [{ date, description, reference, amount }] }
 *   amount: positivo = crédito/depósito, negativo = débito/retiro.
 */
exports.statementMatch = async (req, res) => {
  try {
    const { bankAccount, lines = [] } = req.body;
    const bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId });
    if (!bank) return res.status(404).json({ message: 'Cuenta no encontrada' });

    const book = await BankTransaction.find({ clinic: req.clinicId, bankAccount: bank._id, voided: false, reconciled: false }).sort({ date: 1 });
    const used = new Set();
    const result = lines.map((ln, idx) => {
      const amt = Number(ln.amount) || 0;
      const ref = String(ln.reference || '').trim().toLowerCase();
      const lineDate = ln.date ? new Date(ln.date) : null;
      let best = null, bestScore = -1;
      for (const t of book) {
        if (used.has(String(t._id))) continue;
        const signed = t.amount * t.direction;
        if (Math.abs(signed - amt) > 0.01) continue;
        let score = 1;
        if (ref && (String(t.reference || '').toLowerCase() === ref || String(t.voucherNumber || '').toLowerCase() === ref)) score += 3;
        if (lineDate) { const days = Math.abs((t.date - lineDate) / 86400000); if (days <= 1) score += 2; else if (days <= 5) score += 1; else score -= Math.min(2, Math.floor(days / 5)); }
        if (score > bestScore) { bestScore = score; best = t; }
      }
      if (best) used.add(String(best._id));
      return {
        index: idx, line: { date: ln.date, description: ln.description, reference: ln.reference, amount: amt },
        match: best ? { _id: best._id, date: best.date, description: best.description, amount: best.amount, direction: best.direction, reference: best.reference } : null,
      };
    });
    const matched = result.filter((r) => r.match).length;
    res.json({ rows: result, matched, unmatched: result.length - matched });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/**
 * Aplica la conciliación: marca como conciliadas las transacciones emparejadas y
 * crea transacciones nuevas (con asiento) para las líneas sin match (comisiones,
 * intereses, notas de débito del banco, etc.).
 * Body: { bankAccount, matchTransactionIds: [], creates: [{ date, amount, type, description, counterAccountCode }] }
 */
exports.statementApply = async (req, res) => {
  try {
    const { bankAccount, matchTransactionIds = [], creates = [] } = req.body;
    {
      const result = await runInTransaction(async (session) => {
        const bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId }).session(session);
        if (!bank) throw Object.assign(new Error('Cuenta no encontrada'), { status: 404 });

        if (matchTransactionIds.length) {
          await BankTransaction.updateMany(
            { _id: { $in: matchTransactionIds }, clinic: req.clinicId, bankAccount: bank._id },
            { reconciled: true },
            { session }
          );
        }

        const created = [];
        for (const c of creates) {
          const amount = Math.abs(Number(c.amount) || 0);
          if (!amount) continue;
          const direction = (Number(c.amount) || 0) >= 0 ? 1 : -1;
          const txDate = c.date ? new Date(c.date) : new Date();
          await assertPeriodOpen(req.clinicId, txDate, { session });
          const counterCode = c.counterAccountCode
            || (await getAccount(req.clinicId, direction > 0 ? 'interesesGanados' : 'comisionBancaria', { session })).code;
          const [tx] = await BankTransaction.create([{
            clinic: req.clinicId,
            bankAccount: bank._id,
            date: txDate,
            type: c.type || (direction > 0 ? 'DEPOSITO' : 'COMISION'),
            amount,
            direction,
            description: c.description || 'Movimiento de estado de cuenta',
            reference: c.reference || '',
            reconciled: true,
            createdBy: req.user._id,
          }], { session });
          const entry = await postBankJournal({
            clinicId: req.clinicId,
            userId: req.user._id,
            date: txDate,
            description: c.description || 'Movimiento de estado de cuenta',
            bank,
            counterAccountCode: counterCode,
            amount,
            direction,
            sourceModel: 'BankTransaction',
            sourceRef: tx._id,
            sourceAction: 'STATEMENT',
            session,
          });
          tx.journalEntry = entry._id;
          await tx.save({ session });
          created.push(tx);
        }
        return { ok: true, matched: matchTransactionIds.length, created: created.length };
      });
      return res.json(result);
    }
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/** Recalcula el bookBalance almacenado de una cuenta (o todas) desde sus transacciones. */
exports.recomputeBankBalances = async (req, res) => {
  try {
    const accounts = await BankAccount.find({ clinic: req.clinicId });
    for (const a of accounts) {
      const agg = await BankTransaction.aggregate([
        { $match: { clinic: a.clinic, bankAccount: a._id, voided: false } },
        { $group: { _id: null, total: { $sum: { $multiply: ['$amount', '$direction'] } } } },
      ]);
      a.bookBalance = +((a.initialBalance || 0) + (agg[0]?.total || 0)).toFixed(2);
      await a.save();
    }
    res.json({ ok: true, cuentas: accounts.length });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ---------- Chequera / secuencias de cheques ----------
exports.listChecks = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.bankAccount) filter.bankAccount = req.query.bankAccount;
  if (req.query.status) filter.status = req.query.status;
  const items = await BankCheck.find(filter).sort({ number: 1 });
  res.json(items);
};

/** Genera un rango de cheques (chequera) para una cuenta. body: { bankAccount, from, to } */
exports.generateChecks = async (req, res) => {
  try {
    const { bankAccount, from, to } = req.body;
    const bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId });
    if (!bank) return res.status(404).json({ message: 'Cuenta no encontrada' });
    const start = parseInt(from, 10), end = parseInt(to, 10);
    if (!start || !end || end < start) return res.status(400).json({ message: 'Rango inválido' });
    if (end - start > 1000) return res.status(400).json({ message: 'Rango demasiado grande (máx 1000)' });
    let created = 0;
    for (let n = start; n <= end; n++) {
      try { await BankCheck.create({ clinic: req.clinicId, bankAccount: bank._id, number: n }); created++; }
      catch { /* duplicado, ignorar */ }
    }
    res.json({ created });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.voidCheck = async (req, res) => {
  try {
    const chk = await BankCheck.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!chk) return res.status(404).json({ message: 'Cheque no encontrado' });
    if (chk.status === 'COBRADO') return res.status(400).json({ message: 'Cheque ya cobrado' });
    chk.status = 'ANULADO';
    chk.voidReason = req.body?.reason || '';
    await chk.save();
    res.json(chk);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

// ---------- Tarjetas de crédito + POS ----------
exports.listCards = async (req, res) => {
  const items = await CreditCard.find({ clinic: req.clinicId }).populate('chartAccount', 'code name').sort({ name: 1 });
  res.json(items);
};
exports.createCard = async (req, res) => {
  try { const card = await CreditCard.create({ ...req.body, clinic: req.clinicId }); res.status(201).json(card); }
  catch (e) { res.status(400).json({ message: e.message }); }
};
exports.updateCard = async (req, res) => {
  try {
    const card = await CreditCard.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!card) return res.status(404).json({ message: 'No encontrada' });
    const patch = { ...req.body }; delete patch.clinic;
    Object.assign(card, patch); await card.save(); res.json(card);
  } catch (e) { res.status(400).json({ message: e.message }); }
};
exports.deleteCard = async (req, res) => {
  const card = await CreditCard.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!card) return res.status(404).json({ message: 'No encontrada' });
  await card.deleteOne(); res.json({ message: 'Eliminada' });
};
