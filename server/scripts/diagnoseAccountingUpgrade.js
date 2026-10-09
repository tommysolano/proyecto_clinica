/**
 * Auditoría de transición contable, solo lectura.
 * node scripts/diagnoseAccountingUpgrade.js --clinic=<id>
 * No imprime pacientes, proveedores, XML ni datos de contacto.
 */
const { parseArgs, connect, disconnect } = require('./_common');
const Clinic = require('../models/Clinic');
const JournalEntry = require('../models/JournalEntry');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Payment = require('../models/Payment');
const CashDeposit = require('../models/CashDeposit');
const CreditCardBatch = require('../models/CreditCardBatch');
const CardSettlement = require('../models/CardSettlement');
const CreditDebitNote = require('../models/CreditDebitNote');
const ChartOfAccount = require('../models/ChartOfAccount');
const { resolveReceivableEconomicObligations } = require('../services/receivableObligations');

async function diagnose({ clinic = null, onProgress = null } = {}) {
  const clinics = clinic ? [{ _id: clinic }] : await Clinic.find({}).select('_id').lean();
  const result = [];
  for (const [index, c] of clinics.entries()) {
    if (onProgress) onProgress(index + 1, clinics.length);
    const base = { clinic: c._id };
    const pendingPurchases = await PurchaseInvoice.find({ ...base,
      status: { $in: ['POR_AUTORIZAR', 'PENDIENTE'] } }).select('_id').lean();
    const payablePayments = pendingPurchases.length
      ? await Payment.countDocuments({ ...base, type: 'PAGO', status: 'REGISTRADO',
        applications: { $elemMatch: { docModel: 'PurchaseInvoice', docRef: { $in: pendingPurchases.map((p) => p._id) } } } })
      : 0;
    const batches = await CreditCardBatch.find({ ...base, status: { $ne: 'ANULADO' } })
      .select('_id vouchers journalEntry bankTransaction').lean();
    const settlements = await CardSettlement.find({ ...base, status: { $ne: 'ANULADO' } })
      .select('batch sourceSales status').lean();
    const batchSales = new Set(batches.flatMap((b) => (b.vouchers || []).map((v) => String(v.sale || '')).filter(Boolean)));
    const settlementSales = settlements.flatMap((s) => (s.sourceSales || []).map((v) => String(v.sale || '')).filter(Boolean));
    const duplicatedSaleRefs = settlementSales.length - new Set(settlementSales).size;
    const unlinkedSettlementSales = settlements.filter((s) => !s.batch)
      .flatMap((s) => (s.sourceSales || []).map((v) => String(v.sale || '')).filter(Boolean))
      .filter((id) => batchSales.has(id)).length;
    const ar = await resolveReceivableEconomicObligations({ clinicId: c._id });
    const chartCount = await ChartOfAccount.countDocuments(base);
    result.push({ clinic: String(c._id), chartCount,
      annualOpeningEntries: await JournalEntry.countDocuments({ ...base, source: 'APERTURA', status: 'CONTABILIZADO' }),
      reversedOperationalEntries: await JournalEntry.countDocuments({ ...base, isReversed: true,
        source: { $in: ['VENTA', 'COMPRA', 'COBRO', 'PAGO', 'TARJETA', 'CAJA', 'NC', 'ND'] } }),
      paymentsOnUnpostedPurchases: payablePayments,
      legacyPostedBatches: batches.filter((b) => b.journalEntry || b.bankTransaction).length,
      unlinkedSettlementsOnBatchSales: unlinkedSettlementSales,
      repeatedSalesInSettlements: duplicatedSaleRefs,
      legacyCashDepositsWithoutItems: await CashDeposit.countDocuments({ ...base, status: 'REGISTRADO',
        'items.0': { $exists: false }, manualReason: { $in: [null, ''] } }),
      duplicateReceivablePairs: ar.duplicadas.length,
      ambiguousReceivablePairs: ar.ambiguas.length,
      unapprovedPostedIssuedNotes: await CreditDebitNote.countDocuments({ ...base, direction: 'EMITIDA',
        estado: { $in: ['REGISTRADA', 'EN_COLA', 'RECIBIDA', 'EN_PROCESO', 'NO_AUTORIZADO', 'DEVUELTA', 'ERROR'] },
        journalEntry: { $ne: null } }),
    });
  }
  return result;
}

if (require.main === module) {
  const args = parseArgs();
  if (args.commit) { console.error('Este diagnóstico es solo lectura; no admite --commit.'); process.exitCode = 2; }
  else connect().then(async () => { console.log(JSON.stringify(await diagnose({ ...args,
    onProgress: (index, total) => console.error(`Analizando empresa ${index}/${total}...`),
  }), null, 2)); })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(disconnect);
}

module.exports = { diagnose };
