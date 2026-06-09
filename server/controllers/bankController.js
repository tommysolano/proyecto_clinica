const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const Reconciliation = require('../models/Reconciliation');
const BankCheck = require('../models/BankCheck');
const CreditCard = require('../models/CreditCard');
const Sale = require('../models/Sale');
const ChartOfAccount = require('../models/ChartOfAccount');
const { createEntry, findAccount } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');

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
async function postBankJournal({ clinicId, userId, date, description, bank, counterAccountCode, amount, direction, source = 'BANCO' }) {
  const bankAcc = await ChartOfAccount.findById(bank.chartAccount);
  const counter = await findAccount(clinicId, { code: counterAccountCode });
  const lines = direction > 0
    ? [
        { account: bankAcc._id, debit: amount, credit: 0, description },
        { account: counter._id, debit: 0, credit: amount, description },
      ]
    : [
        { account: counter._id, debit: amount, credit: 0, description },
        { account: bankAcc._id, debit: 0, credit: amount, description },
      ];
  return createEntry({ clinicId, date, description, source, lines, userId });
}

// ---------- Movimientos genéricos ----------
exports.createMovement = async (req, res) => {
  try {
    const { bankAccount, type, amount, date, description, reference,
            counterAccountCode, checkNumber, counterpartAccount,
            voucherUrl, voucherNumber } = req.body;
    if (!bankAccount || !type || !amount) return res.status(400).json({ message: 'bankAccount, type y amount requeridos' });
    const bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId });
    if (!bank) return res.status(404).json({ message: 'Cuenta bancaria no encontrada' });

    const inflow = ['DEPOSITO', 'TRANSFERENCIA_IN', 'INTERES', 'COBRO'].includes(type);
    const direction = inflow ? 1 : -1;
    const txDate = date ? new Date(date) : new Date();

    // Comprobante obligatorio para depósitos, transferencias y cheques
    const requiresVoucher = ['DEPOSITO', 'TRANSFERENCIA_IN', 'TRANSFERENCIA_OUT', 'CHEQUE_EMITIDO'].includes(type);
    if (requiresVoucher && !voucherNumber && !voucherUrl && !reference) {
      return res.status(400).json({
        message: 'Comprobante de depósito requerido (voucherNumber, voucherUrl o reference)',
      });
    }
    // Para salidas, validar saldo disponible
    if (direction < 0) {
      const agg = await BankTransaction.aggregate([
        { $match: { clinic: bank.clinic, bankAccount: bank._id, voided: false } },
        { $group: { _id: null, total: { $sum: { $multiply: ['$amount', '$direction'] } } } },
      ]);
      const balance = (bank.initialBalance || 0) + (agg[0]?.total || 0);
      if (balance < Number(amount)) {
        return res.status(400).json({ message: `Saldo insuficiente en ${bank.name} (disponible $${balance.toFixed(2)})` });
      }
    }

    // Contracuenta por defecto según tipo. Se resuelve por "rol" configurable en
    // Configuración de Cuentas (con caída al plan estándar), salvo que el cliente
    // envíe explícitamente un counterAccountCode.
    const counterRoleByType = {
      DEPOSITO: 'caja',             // contra Caja general
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
      defaultCounter = (await getAccount(req.clinicId, counterRoleByType[type])).code;
    }

    let counterpartTx = null;
    let entry = null;
    if (type === 'TRANSFERENCIA_OUT' || type === 'TRANSFERENCIA_IN') {
      if (!counterpartAccount) return res.status(400).json({ message: 'counterpartAccount requerido para transferencia' });
      const other = await BankAccount.findOne({ _id: counterpartAccount, clinic: req.clinicId });
      if (!other) return res.status(404).json({ message: 'Cuenta contraparte no encontrada' });
      // Crea asiento solo una vez: débito banco destino, crédito banco origen
      const out = direction < 0 ? bank : other;
      const inn = direction > 0 ? bank : other;
      entry = await createEntry({
        clinicId: req.clinicId, date: txDate, description: description || 'Transferencia bancaria',
        source: 'BANCO', userId: req.user._id,
        lines: [
          { account: inn.chartAccount, debit: amount, credit: 0, description },
          { account: out.chartAccount, debit: 0, credit: amount, description },
        ],
      });
      counterpartTx = await BankTransaction.create({
        clinic: req.clinicId, bankAccount: other._id, date: txDate,
        type: direction > 0 ? 'TRANSFERENCIA_OUT' : 'TRANSFERENCIA_IN',
        amount, direction: -direction, description, reference,
        voucherUrl: voucherUrl || '', voucherNumber: voucherNumber || '',
        counterpartAccount: bank._id, journalEntry: entry._id, createdBy: req.user._id,
      });
    } else {
      entry = await postBankJournal({
        clinicId: req.clinicId, userId: req.user._id, date: txDate,
        description: description || type, bank,
        counterAccountCode: counterAccountCode || defaultCounter,
        amount, direction,
      });
    }

    let realCheckNumber = checkNumber;
    if (type === 'CHEQUE_EMITIDO') {
      realCheckNumber = checkNumber || String(bank.nextCheckNumber);
      bank.nextCheckNumber = (parseInt(realCheckNumber, 10) || bank.nextCheckNumber) + 1;
      await bank.save();
    }

    const tx = await BankTransaction.create({
      clinic: req.clinicId, bankAccount: bank._id, date: txDate, type,
      amount, direction, description, reference, checkNumber: realCheckNumber,
      voucherUrl: voucherUrl || '', voucherNumber: voucherNumber || '',
      counterpartAccount: counterpartTx ? counterpartTx.bankAccount : null,
      journalEntry: entry._id, createdBy: req.user._id,
    });
    if (counterpartTx) {
      counterpartTx.counterpartAccount = bank._id;
      await counterpartTx.save();
    }
    // Marcar el cheque como GIRADO en el registro de chequera (si existe)
    if (type === 'CHEQUE_EMITIDO' && realCheckNumber) {
      await BankCheck.findOneAndUpdate(
        { clinic: req.clinicId, bankAccount: bank._id, number: parseInt(realCheckNumber, 10) },
        { status: 'GIRADO', beneficiary: description || '', amount: Number(amount), date: txDate, transaction: tx._id },
      );
    }
    res.status(201).json({ transaction: tx, journalEntry: entry, counterpartTx });
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
    const tx = await BankTransaction.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!tx) return res.status(404).json({ message: 'No encontrado' });
    if (tx.voided) return res.status(400).json({ message: 'Ya anulado' });
    if (tx.reconciled) return res.status(400).json({ message: 'Conciliado, no se puede anular' });
    tx.voided = true;
    tx.voidedAt = new Date();
    tx.voidedBy = req.user._id;
    tx.voidReason = req.body?.reason || '';
    await tx.save();
    // Reversar asiento
    if (tx.journalEntry) {
      const { reverseEntry } = require('../utils/accounting');
      await reverseEntry({ clinicId: req.clinicId, entryId: tx.journalEntry, userId: req.user._id, reason: `Anulación tx ${tx._id}` });
    }
    res.json({ message: 'Anulado' });
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
    if (!Array.isArray(saleIds) || !saleIds.length) return res.status(400).json({ message: 'saleIds requerido' });
    if (!bankAccount || !voucher) return res.status(400).json({ message: 'bankAccount y voucher requeridos' });
    const bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId });
    if (!bank) return res.status(404).json({ message: 'Cuenta bancaria no encontrada' });

    const sales = await Sale.find({ _id: { $in: saleIds }, clinic: req.clinicId, paymentMethod: 'efectivo', status: 'completada' });
    if (!sales.length) return res.status(400).json({ message: 'No hay ventas en efectivo válidas' });
    const total = sales.reduce((s, v) => s + (v.total || 0), 0);

    // Asiento: Banco (DB) / Caja general (CR)
    const cajaAcc = await getAccount(req.clinicId, 'caja');
    const entry = await postBankJournal({
      clinicId: req.clinicId, userId: req.user._id,
      date: date ? new Date(date) : new Date(),
      description: description || `Depósito ventas efectivo - papeleta ${voucher}`,
      bank, counterAccountCode: cajaAcc.code,
      amount: total, direction: 1,
    });
    const tx = await BankTransaction.create({
      clinic: req.clinicId, bankAccount: bank._id, date: date ? new Date(date) : new Date(),
      type: 'DEPOSITO', amount: total, direction: 1,
      description: description || `Depósito ventas efectivo`, reference: voucher,
      voucherNumber: voucher,
      journalEntry: entry._id, createdBy: req.user._id,
    });
    // Marcar ventas como transferidas (se cambia método y se asocia)
    await Sale.updateMany(
      { _id: { $in: sales.map((s) => s._id) } },
      { $set: { paymentMethod: 'transferencia', notes: `Depositado en ${bank.name} - papeleta ${voucher}` } }
    );
    res.json({ transaction: tx, journalEntry: entry, total, salesCount: sales.length });
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

// ---------- Conciliación bancaria ----------
exports.startReconciliation = async (req, res) => {
  try {
    const { bankAccount, periodStart, periodEnd, statementBalance } = req.body;
    const bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId });
    if (!bank) return res.status(404).json({ message: 'Cuenta no encontrada' });
    const txs = await BankTransaction.find({
      clinic: req.clinicId, bankAccount: bank._id, voided: false,
      date: { $gte: new Date(periodStart), $lte: new Date(periodEnd) },
    }).sort({ date: 1 });
    const items = txs.map((t) => ({ transaction: t._id, matched: t.reconciled }));
    const bookBalance = txs.reduce((s, t) => s + t.amount * t.direction, 0) + (bank.initialBalance || 0);
    const rec = await Reconciliation.create({
      clinic: req.clinicId, bankAccount: bank._id,
      periodStart: new Date(periodStart), periodEnd: new Date(periodEnd),
      statementBalance, bookBalance, difference: statementBalance - bookBalance,
      items, createdBy: req.user._id,
    });
    res.status(201).json(rec);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.updateReconciliation = async (req, res) => {
  try {
    const rec = await Reconciliation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!rec) return res.status(404).json({ message: 'No encontrada' });
    if (rec.status === 'CONCILIADO') return res.status(400).json({ message: 'Ya cerrada' });
    if (req.body.items) rec.items = req.body.items;
    if (req.body.statementBalance !== undefined) rec.statementBalance = req.body.statementBalance;
    if (req.body.notes !== undefined) rec.notes = req.body.notes;
    rec.difference = rec.statementBalance - rec.bookBalance;
    await rec.save();
    res.json(rec);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.closeReconciliation = async (req, res) => {
  try {
    const rec = await Reconciliation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!rec) return res.status(404).json({ message: 'No encontrada' });
    if (Math.abs(rec.difference) > 0.01) return res.status(400).json({ message: `Hay diferencia de ${rec.difference.toFixed(2)}` });
    rec.status = 'CONCILIADO';
    rec.closedAt = new Date();
    await rec.save();
    const matchedIds = rec.items.filter((i) => i.matched).map((i) => i.transaction);
    await BankTransaction.updateMany({ _id: { $in: matchedIds } }, { reconciled: true, reconciliation: rec._id });
    res.json(rec);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.listReconciliations = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.bankAccount) filter.bankAccount = req.query.bankAccount;
  const items = await Reconciliation.find(filter).populate('bankAccount', 'name bank').sort({ periodEnd: -1 });
  res.json(items);
};

// ---------- Importación de estado de cuenta bancario + matching ----------
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
    const bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId });
    if (!bank) return res.status(404).json({ message: 'Cuenta no encontrada' });

    if (matchTransactionIds.length) {
      await BankTransaction.updateMany(
        { _id: { $in: matchTransactionIds }, clinic: req.clinicId, bankAccount: bank._id },
        { reconciled: true }
      );
    }

    const created = [];
    for (const c of creates) {
      const amount = Math.abs(Number(c.amount) || 0);
      if (!amount) continue;
      const direction = (Number(c.amount) || 0) >= 0 ? 1 : -1;
      // Cuenta de contrapartida: interés ganado (ingreso) o comisión bancaria (gasto),
      // resueltas por rol configurable salvo que se envíe un código explícito.
      const counterCode = c.counterAccountCode
        || (await getAccount(req.clinicId, direction > 0 ? 'interesesGanados' : 'comisionBancaria')).code;
      const entry = await postBankJournal({
        clinicId: req.clinicId, userId: req.user._id,
        date: c.date ? new Date(c.date) : new Date(),
        description: c.description || 'Movimiento de estado de cuenta',
        bank, counterAccountCode: counterCode, amount, direction,
      });
      const tx = await BankTransaction.create({
        clinic: req.clinicId, bankAccount: bank._id, date: c.date ? new Date(c.date) : new Date(),
        type: c.type || (direction > 0 ? 'DEPOSITO' : 'COMISION'), amount, direction,
        description: c.description || 'Movimiento de estado de cuenta', reference: c.reference || '',
        reconciled: true, journalEntry: entry._id, createdBy: req.user._id,
      });
      created.push(tx);
    }
    res.json({ ok: true, matched: matchTransactionIds.length, created: created.length });
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
