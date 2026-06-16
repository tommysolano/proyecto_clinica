const Payment = require('../models/Payment');
const Invoice = require('../models/Invoice');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const Sale = require('../models/Sale');
const { createEntry, findAccount, reverseEntry, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const { openReceivable, applyToReceivable, unapplyFromReceivable, openPayable, applyToPayable, unapplyFromPayable } = require('../utils/subledger');

async function nextNumber(clinicId, type) {
  const prefix = type === 'COBRO' ? 'CB-' : 'PG-';
  const year = new Date().getFullYear();
  const re = new RegExp(`^${prefix}${year}-`);
  const last = await Payment.findOne({ clinic: clinicId, number: re }).sort({ createdAt: -1 }).select('number');
  let n = 1;
  if (last) {
    const m = last.number.match(/(\d+)$/);
    if (m) n = parseInt(m[1]) + 1;
  }
  return `${prefix}${year}-${String(n).padStart(6, '0')}`;
}

exports.list = async (req, res) => {
  const { type, startDate, endDate, partyRef, status, page = 1, limit = 20 } = req.query;
  const filter = { clinic: req.clinicId };
  if (type) filter.type = type;
  if (partyRef) filter.partyRef = partyRef;
  if (status) filter.status = status;
  if (startDate || endDate) {
    filter.date = {};
    if (startDate) filter.date.$gte = new Date(startDate);
    if (endDate) filter.date.$lte = new Date(endDate);
  }
  const total = await Payment.countDocuments(filter);
  const items = await Payment.find(filter)
    .populate('createdBy', 'name')
    .populate('bankAccount', 'name bank')
    .sort({ date: -1, createdAt: -1 })
    .skip((page - 1) * limit).limit(parseInt(limit));
  res.json({ items, total, pages: Math.ceil(total / limit), currentPage: parseInt(page) });
};

exports.get = async (req, res) => {
  const p = await Payment.findOne({ _id: req.params.id, clinic: req.clinicId })
    .populate('createdBy', 'name')
    .populate('bankAccount', 'name bank')
    .populate('journalEntry');
  if (!p) return res.status(404).json({ message: 'No encontrado' });
  res.json(p);
};

/**
 * Crea cobro o pago, aplica a documentos, opcional anticipo.
 */
exports.create = async (req, res) => {
  try {
    {
      const paymentId = await runInTransaction(async (session) => {
        const { type, date, partyModel, partyRef, partyName, partyId,
                method, bankAccount, checkNumber, reference, applications = [],
                advanceAmount = 0, description, voucherUrl, voucherNumber } = req.body;
        if (!['COBRO', 'PAGO'].includes(type)) throw Object.assign(new Error('type invalido'), { status: 400 });
        if (!method) throw Object.assign(new Error('method requerido'), { status: 400 });
        if (!['EFECTIVO'].includes(method) && !bankAccount && method !== 'TARJETA') {
          throw Object.assign(new Error('bankAccount requerido para este metodo'), { status: 400 });
        }

        const txDate = date ? new Date(date) : new Date();
        await assertPeriodOpen(req.clinicId, txDate, { session });
        const apps = applications.map((a) => ({ ...a, amount: +(Number(a.amount) || 0).toFixed(2) }));
        const seen = new Set();
        for (const a of apps) {
          if (!a.docRef || !(a.amount > 0)) throw Object.assign(new Error('Aplicacion invalida'), { status: 400 });
          const key = `${a.docModel}:${a.docRef}`;
          if (seen.has(key)) throw Object.assign(new Error('No se permite aplicar dos veces al mismo documento'), { status: 400 });
          seen.add(key);
        }
        const appliedAmount = +apps.reduce((s, a) => s + a.amount, 0).toFixed(2);
        const total = +(appliedAmount + Number(advanceAmount || 0)).toFixed(2);
        if (total <= 0) throw Object.assign(new Error('Total debe ser mayor a 0'), { status: 400 });

        for (const a of apps) {
          if (type === 'PAGO' && a.docModel === 'PurchaseInvoice') {
            const pi = await PurchaseInvoice.findOne({ _id: a.docRef, clinic: req.clinicId }).session(session);
            if (!pi) throw Object.assign(new Error('Compra no encontrada'), { status: 400 });
            if (pi.status === 'ANULADA') throw Object.assign(new Error('No se puede pagar una compra anulada'), { status: 400 });
            await assertPeriodOpen(req.clinicId, pi.fechaEmision, { session });
            const balance = Number(pi.balance ?? pi.total ?? 0);
            if (a.amount > balance + 0.01) throw Object.assign(new Error(`El pago excede el saldo de ${pi.serie || 'compra'}`), { status: 400 });
          } else if (type === 'COBRO' && a.docModel === 'Invoice') {
            const inv = await Invoice.findOne({ _id: a.docRef, clinic: req.clinicId }).session(session);
            if (!inv) throw Object.assign(new Error('Factura no encontrada'), { status: 400 });
            if (inv.estado === 'ANULADA') throw Object.assign(new Error('No se puede cobrar una factura anulada'), { status: 400 });
            if (typeof inv.balance !== 'undefined' && a.amount > Number(inv.balance || 0) + 0.01) {
              throw Object.assign(new Error('El cobro excede el saldo de la factura'), { status: 400 });
            }
          } else if (type === 'COBRO' && a.docModel === 'Sale') {
            const s = await Sale.findOne({ _id: a.docRef, clinic: req.clinicId }).session(session);
            if (!s) throw Object.assign(new Error('Venta no encontrada'), { status: 400 });
            if (s.status === 'anulada') throw Object.assign(new Error('No se puede cobrar una venta anulada'), { status: 400 });
            if (s.paymentMethod !== 'credito') throw Object.assign(new Error('La venta no es a crédito'), { status: 400 });
            if (a.amount > Number(s.balance || 0) + 0.01) {
              throw Object.assign(new Error('El cobro excede el saldo de la venta'), { status: 400 });
            }
          }
        }

        let bank = null;
        if (bankAccount) bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId }).session(session);
        if (bankAccount && !bank) throw Object.assign(new Error('Cuenta bancaria no encontrada'), { status: 404 });

        if (type === 'PAGO' && method !== 'EFECTIVO' && bank) {
          if (!voucherNumber && !voucherUrl && !reference && !checkNumber) {
            throw Object.assign(new Error('Comprobante requerido para pagos bancarios'), { status: 400 });
          }
          const agg = await BankTransaction.aggregate([
            { $match: { clinic: bank.clinic, bankAccount: bank._id, voided: false } },
            { $group: { _id: null, total: { $sum: { $multiply: ['$amount', '$direction'] } } } },
          ]).session(session);
          const balance = (bank.initialBalance || 0) + (agg[0]?.total || 0);
          if (balance < total) {
            throw Object.assign(new Error(`Saldo insuficiente en ${bank.name} (disponible $${balance.toFixed(2)})`), { status: 400 });
          }
        }

        const number = await nextNumber(req.clinicId, type);
        const [payment] = await Payment.create([{
          clinic: req.clinicId,
          type,
          number,
          date: txDate,
          partyModel: partyModel || (type === 'COBRO' ? 'Patient' : 'Supplier'),
          partyRef,
          partyName,
          partyId,
          method,
          bankAccount: bank?._id || null,
          checkNumber,
          reference,
          total,
          applications: apps,
          appliedAmount,
          advanceAmount,
          description,
          createdBy: req.user._id,
        }], { session });

        const lines = [];
        if (type === 'COBRO') {
          if (method === 'EFECTIVO') {
            const caja = await getAccount(req.clinicId, 'caja', { session });
            lines.push({ account: caja._id, debit: total, credit: 0, description: 'Cobro en efectivo' });
          } else if (method === 'TARJETA') {
            const tarj = await getAccount(req.clinicId, 'tarjetasPorLiquidar', { session });
            lines.push({ account: tarj._id, debit: total, credit: 0, description: 'Cobro tarjeta - por liquidar' });
          } else {
            lines.push({ account: bank.chartAccount, debit: total, credit: 0, description: `Cobro ${method}` });
          }
          if (appliedAmount > 0) {
            const clientes = await getAccount(req.clinicId, 'clientes', { session });
            lines.push({ account: clientes._id, debit: 0, credit: appliedAmount, description: 'Aplicacion a factura' });
          }
          if (Number(advanceAmount || 0) > 0) {
            const anticipo = await getAccount(req.clinicId, 'anticipoClientes', { session });
            lines.push({ account: anticipo._id, debit: 0, credit: Number(advanceAmount), description: 'Anticipo cliente' });
          }
        } else {
          if (appliedAmount > 0) {
            const prov = await getAccount(req.clinicId, 'proveedores', { session });
            lines.push({ account: prov._id, debit: appliedAmount, credit: 0, description: 'Pago a proveedor' });
          }
          if (Number(advanceAmount || 0) > 0) {
            const ant = await getAccount(req.clinicId, 'anticipoProveedores', { session });
            lines.push({ account: ant._id, debit: Number(advanceAmount), credit: 0, description: 'Anticipo a proveedor' });
          }
          if (method === 'EFECTIVO') {
            const caja = await getAccount(req.clinicId, 'caja', { session });
            lines.push({ account: caja._id, debit: 0, credit: total, description: 'Pago en efectivo' });
          } else {
            lines.push({ account: bank.chartAccount, debit: 0, credit: total, description: `Pago ${method}` });
          }
        }

        const entry = await createEntry({
          clinicId: req.clinicId,
          date: txDate,
          description: description || `${type} ${number}`,
          source: type === 'COBRO' ? 'COBRO' : 'PAGO',
          sourceModel: 'Payment',
          sourceRef: payment._id,
          sourceAction: 'REGISTER',
          lines,
          userId: req.user._id,
          session,
        });

        let bankTx = null;
        if (bank) {
          let txType = type === 'COBRO' ? 'COBRO' : 'PAGO';
          if (method === 'CHEQUE' && type === 'PAGO') {
            txType = 'CHEQUE_EMITIDO';
            if (!checkNumber) {
              bank.nextCheckNumber++;
              await bank.save({ session });
            }
          }
          [bankTx] = await BankTransaction.create([{
            clinic: req.clinicId,
            bankAccount: bank._id,
            date: txDate,
            type: txType,
            amount: total,
            direction: type === 'COBRO' ? 1 : -1,
            description: description || `${type} ${number}`,
            reference,
            voucherUrl: voucherUrl || '',
            voucherNumber: voucherNumber || '',
            checkNumber,
            journalEntry: entry._id,
            sourceModel: 'Payment',
            sourceRef: payment._id,
            createdBy: req.user._id,
          }], { session });
        }

        payment.journalEntry = entry._id;
        payment.bankTransaction = bankTx?._id || null;
        await payment.save({ session });

        for (const a of apps) {
          if (type === 'PAGO' && a.docModel === 'PurchaseInvoice') {
            const pi = await PurchaseInvoice.findOne({ _id: a.docRef, clinic: req.clinicId }).session(session);
            pi.balance = Math.max(0, Number(pi.balance || pi.total || 0) - Number(a.amount));
            if (pi.balance <= 0.005) {
              pi.balance = 0;
              pi.paid = true;
              if (pi.status !== 'ANULADA') pi.status = 'PAGADA';
            }
            await pi.save({ session });
            // Subledger CxP: asegura y aplica el pago al documento de la compra.
            const provAcc = await getAccount(req.clinicId, 'proveedores', { session });
            await openPayable({
              clinic: req.clinicId,
              party: { model: 'Supplier', ref: pi.supplier, name: partyName || '' },
              sourceModel: 'PurchaseInvoice', sourceRef: pi._id, docType: 'COMPRA',
              number: pi.serie || '', issueDate: pi.fechaEmision || new Date(),
              total: +(Number(pi.total || 0) - Number(pi.retentionTotal || 0)).toFixed(2),
              // applied previo (antes de este pago): total - retención - saldo ANTERIOR.
              applied: +(Number(pi.total || 0) - Number(pi.retentionTotal || 0) - (Number(pi.balance || 0) + Number(a.amount))).toFixed(2),
              account: provAcc._id,
            }, { session });
            await applyToPayable({ clinicId: req.clinicId, sourceModel: 'PurchaseInvoice', sourceRef: pi._id, amount: a.amount }, { session });
          } else if (type === 'COBRO' && a.docModel === 'Invoice') {
            const inv = await Invoice.findOne({ _id: a.docRef, clinic: req.clinicId }).session(session);
            if (inv && typeof inv.balance !== 'undefined') {
              inv.balance = Math.max(0, Number(inv.balance || inv.total || 0) - Number(a.amount));
              if (inv.balance <= 0.005) {
                inv.balance = 0;
                if (typeof inv.paid !== 'undefined') inv.paid = true;
              }
              await inv.save({ session });
            }
          } else if (type === 'COBRO' && a.docModel === 'Sale') {
            const s = await Sale.findOne({ _id: a.docRef, clinic: req.clinicId }).session(session);
            if (s) {
              s.balance = Math.max(0, Number(s.balance || s.total || 0) - Number(a.amount));
              s.paid = s.balance <= 0.005;
              if (s.paid) s.balance = 0;
              await s.save({ session });
              // Subledger CxC: asegura y aplica el cobro al documento de la venta.
              const clientesAcc = await getAccount(req.clinicId, 'clientes', { session });
              await openReceivable({
                clinic: req.clinicId,
                party: { model: 'Patient', ref: s.patient || null, name: s.clientName || '' },
                sourceModel: 'Sale', sourceRef: s._id, docType: 'VENTA',
                number: s.saleNumber, issueDate: s.createdAt || txDate, dueDate: s.dueDate || null,
                total: s.total,
                applied: +(Number(s.total || 0) - (Number(s.balance || 0) + Number(a.amount))).toFixed(2),
                account: clientesAcc._id,
              }, { session });
              await applyToReceivable({ clinicId: req.clinicId, sourceModel: 'Sale', sourceRef: s._id, amount: a.amount }, { session });
            }
          }
        }

        return payment._id;
      });
      const payment = await Payment.findById(paymentId);
      return res.status(201).json(payment);
    }
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

exports.void = async (req, res) => {
  try {
    {
      const result = await runInTransaction(async (session) => {
        const p = await Payment.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
        if (!p) throw Object.assign(new Error('No encontrado'), { status: 404 });
        if (p.status === 'ANULADO') throw Object.assign(new Error('Ya anulado'), { status: 400 });
        await assertPeriodOpen(req.clinicId, p.date, { session });
        const reversalDate = req.body.date ? new Date(req.body.date) : new Date();
        await assertPeriodOpen(req.clinicId, reversalDate, { session });

        if (p.journalEntry) {
          await reverseEntry({
            clinicId: req.clinicId,
            entryId: p.journalEntry,
            userId: req.user._id,
            reason: 'Anulacion de cobro/pago',
            date: reversalDate,
            session,
          });
        }
        if (p.bankTransaction) {
          const tx = await BankTransaction.findById(p.bankTransaction).session(session);
          if (tx && !tx.voided) {
            tx.voided = true;
            tx.voidedAt = reversalDate;
            tx.voidedBy = req.user._id;
            tx.voidReason = req.body?.reason || 'Anulacion de pago';
            await tx.save({ session });
            await BankAccount.updateOne(
              { _id: tx.bankAccount },
              { $inc: { bookBalance: -(Number(tx.amount || 0) * Number(tx.direction || 0)) } },
              { session }
            );
          }
        }

        p.status = 'ANULADO';
        await p.save({ session });

        for (const a of p.applications || []) {
          if (!a.docRef || !a.amount) continue;
          if (p.type === 'PAGO' && a.docModel === 'PurchaseInvoice') {
            const pi = await PurchaseInvoice.findOne({ _id: a.docRef, clinic: req.clinicId }).session(session);
            if (pi) {
              await assertPeriodOpen(req.clinicId, pi.fechaEmision, { session });
              pi.balance = Number(pi.balance || 0) + Number(a.amount);
              if (pi.balance > 0.005 && pi.status === 'PAGADA') {
                pi.paid = false;
                pi.status = 'REGISTRADA';
              }
              await pi.save({ session });
              await unapplyFromPayable({ clinicId: req.clinicId, sourceModel: 'PurchaseInvoice', sourceRef: pi._id, amount: a.amount }, { session });
            }
          } else if (p.type === 'COBRO' && a.docModel === 'Invoice') {
            const inv = await Invoice.findOne({ _id: a.docRef, clinic: req.clinicId }).session(session);
            if (inv && typeof inv.balance !== 'undefined') {
              inv.balance = Number(inv.balance || 0) + Number(a.amount);
              if (inv.balance > 0.005 && inv.paid) inv.paid = false;
              await inv.save({ session });
            }
          } else if (p.type === 'COBRO' && a.docModel === 'Sale') {
            const s = await Sale.findOne({ _id: a.docRef, clinic: req.clinicId }).session(session);
            if (s) {
              s.balance = Number(s.balance || 0) + Number(a.amount);
              if (s.balance > 0.005 && s.paid) s.paid = false;
              await s.save({ session });
              await unapplyFromReceivable({ clinicId: req.clinicId, sourceModel: 'Sale', sourceRef: s._id, amount: a.amount }, { session });
            }
          }
        }

        return { message: 'Anulado' };
      });
      return res.json(result);
    }
  } catch (e) { res.status(400).json({ message: e.message }); }
};
