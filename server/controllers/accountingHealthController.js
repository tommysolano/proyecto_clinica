const mongoose = require('mongoose');
const JournalEntry = require('../models/JournalEntry');
const AccountBalance = require('../models/AccountBalance');
const Receivable = require('../models/Receivable');
const Payable = require('../models/Payable');
const Sale = require('../models/Sale');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const { getAccount } = require('../utils/accountMap');

function round2(n) {
  return +Number(n || 0).toFixed(2);
}

/**
 * Chequeo de salud contable: detecta inconsistencias entre el mayor, los
 * documentos y el subledger. Pensado para correrse antes de un cierre o como
 * verificación periódica.
 *
 * Reporta:
 *  - Partida doble global (sum débitos == sum créditos).
 *  - Asientos descuadrados.
 *  - Cartera (subledger) vs cuenta de control del mayor (Clientes / Proveedores).
 *  - Documentos con saldo pero sin asiento contable.
 */
exports.check = async (req, res) => {
  try {
    const clinicId = mongoose.Types.ObjectId.createFromHexString(String(req.clinicId));
    const findings = [];

    // 1. Partida doble global
    const totalsAgg = await JournalEntry.aggregate([
      { $match: { clinic: clinicId, status: 'CONTABILIZADO' } },
      { $group: { _id: null, debit: { $sum: '$totalDebit' }, credit: { $sum: '$totalCredit' } } },
    ]);
    const gDebit = round2(totalsAgg[0]?.debit || 0);
    const gCredit = round2(totalsAgg[0]?.credit || 0);
    const globalBalanced = Math.abs(gDebit - gCredit) <= 0.01;
    if (!globalBalanced) {
      findings.push({ level: 'error', code: 'GLOBAL_UNBALANCED', message: `Mayor descuadrado: débitos ${gDebit} vs créditos ${gCredit}` });
    }

    // 2. Asientos individuales descuadrados
    const unbalanced = await JournalEntry.aggregate([
      { $match: { clinic: clinicId, status: 'CONTABILIZADO' } },
      { $project: { number: 1, diff: { $abs: { $subtract: ['$totalDebit', '$totalCredit'] } } } },
      { $match: { diff: { $gt: 0.01 } } },
      { $limit: 50 },
    ]);
    if (unbalanced.length) {
      findings.push({ level: 'error', code: 'ENTRY_UNBALANCED', message: `${unbalanced.length} asiento(s) descuadrado(s)`, sample: unbalanced.map((e) => e.number) });
    }

    // 3. Subledger vs cuenta de control del mayor
    async function ledgerBalanceFor(role) {
      const acc = await getAccount(req.clinicId, role);
      const agg = await AccountBalance.aggregate([
        { $match: { clinic: clinicId, account: acc._id } },
        { $group: { _id: null, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
      ]);
      return { acc, balance: round2((agg[0]?.debit || 0) - (agg[0]?.credit || 0)) };
    }
    async function subledgerBalance(Model) {
      const docs = await Model.find({ clinic: req.clinicId, status: { $in: ['ABIERTO', 'PARCIAL'] } }).select('balance');
      return round2(docs.reduce((s, d) => s + Number(d.balance || 0), 0));
    }

    const cxc = await ledgerBalanceFor('clientes');
    const arSub = await subledgerBalance(Receivable);
    const cxcDiff = round2(cxc.balance - arSub);
    if (Math.abs(cxcDiff) > 0.01) {
      findings.push({ level: 'warn', code: 'AR_MISMATCH', message: `CxC mayor (${cxc.balance}) ≠ subledger Receivables (${arSub}); diferencia ${cxcDiff}` });
    }

    const cxp = await ledgerBalanceFor('proveedores');
    const apSub = await subledgerBalance(Payable);
    // Proveedores es de naturaleza crédito: el saldo del mayor es negativo (credit>debit).
    const cxpLedger = round2(-cxp.balance);
    const cxpDiff = round2(cxpLedger - apSub);
    if (Math.abs(cxpDiff) > 0.01) {
      findings.push({ level: 'warn', code: 'AP_MISMATCH', message: `CxP mayor (${cxpLedger}) ≠ subledger Payables (${apSub}); diferencia ${cxpDiff}` });
    }

    // 4. Documentos con saldo pero sin asiento
    const salesNoEntry = await Sale.countDocuments({ clinic: req.clinicId, status: 'completada', journalEntry: null });
    if (salesNoEntry > 0) {
      findings.push({ level: 'warn', code: 'SALE_NO_ENTRY', message: `${salesNoEntry} venta(s) completada(s) sin asiento contable` });
    }
    const purchasesNoEntry = await PurchaseInvoice.countDocuments({ clinic: req.clinicId, status: { $in: ['REGISTRADA', 'PAGADA'] }, journalEntry: null });
    if (purchasesNoEntry > 0) {
      findings.push({ level: 'warn', code: 'PURCHASE_NO_ENTRY', message: `${purchasesNoEntry} compra(s) sin asiento contable` });
    }

    res.json({
      ok: findings.filter((f) => f.level === 'error').length === 0,
      checkedAt: new Date(),
      summary: {
        globalDebit: gDebit,
        globalCredit: gCredit,
        cxcLedger: cxc.balance,
        cxcSubledger: arSub,
        cxpLedger,
        cxpSubledger: apSub,
      },
      findings,
    });
  } catch (e) {
    res.status(500).json({ message: 'Error en chequeo de salud contable', error: e.message });
  }
};
