/**
 * Migración: saldos de cartera actuales → subledger (Receivable / Payable).
 *
 * - Ventas a crédito con saldo > 0  → Receivable (CxC).
 * - Facturas con saldo > 0          → Receivable (CxC).
 * - Compras con saldo > 0           → Payable (CxP).
 * Idempotente: openReceivable/openPayable son idempotentes por (clinic, source).
 *
 *   node scripts/migrateCarteraToSubledger.js            (dry-run)
 *   node scripts/migrateCarteraToSubledger.js --commit   (aplica)
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const { getAccount } = require('../utils/accountMap');
const { openReceivable, openPayable } = require('../utils/subledger');

async function run() {
  const opts = parseArgs();
  banner('Migración cartera → subledger (CxC/CxP)', opts);
  await connect();
  try {
    const base = opts.clinic ? { clinic: opts.clinic } : {};
    let ar = 0, ap = 0;

    // Ventas a crédito con saldo
    const sales = await Sale.find({ ...base, paymentMethod: 'credito', status: 'completada', balance: { $gt: 0.005 } });
    for (const s of sales) {
      console.log(`  CxC venta ${s.saleNumber}: saldo ${s.balance}`);
      if (opts.commit) {
        const clientes = await getAccount(s.clinic, 'clientes');
        await openReceivable({
          clinic: s.clinic, party: { model: 'Patient', ref: s.patient || null, name: s.clientName || '' },
          sourceModel: 'Sale', sourceRef: s._id, docType: 'VENTA', number: s.saleNumber,
          issueDate: s.createdAt, dueDate: s.dueDate || null, total: s.total,
          applied: +(Number(s.total || 0) - Number(s.balance || 0)).toFixed(2), account: clientes._id,
        });
      }
      ar++;
    }

    // Facturas con saldo
    const invoices = await Invoice.find({ ...base, balance: { $gt: 0.005 } });
    for (const inv of invoices) {
      console.log(`  CxC factura ${inv.secuencial || inv._id}: saldo ${inv.balance}`);
      if (opts.commit) {
        const clientes = await getAccount(inv.clinic, 'clientes');
        await openReceivable({
          clinic: inv.clinic, party: { model: 'Patient', ref: null, name: inv.razonSocialComprador || '' },
          sourceModel: 'Invoice', sourceRef: inv._id, docType: 'FACTURA', number: inv.secuencial || '',
          issueDate: inv.createdAt, total: inv.importeTotal || inv.total || 0,
          applied: +(Number(inv.importeTotal || inv.total || 0) - Number(inv.balance || 0)).toFixed(2), account: clientes._id,
        });
      }
      ar++;
    }

    // Compras con saldo
    const purchases = await PurchaseInvoice.find({ ...base, status: { $nin: ['ANULADA'] }, balance: { $gt: 0.005 } });
    for (const pi of purchases) {
      console.log(`  CxP compra ${pi.serie || pi._id}: saldo ${pi.balance}`);
      if (opts.commit) {
        const prov = await getAccount(pi.clinic, 'proveedores');
        const total = +(Number(pi.total || 0) - Number(pi.retentionTotal || 0)).toFixed(2);
        await openPayable({
          clinic: pi.clinic, party: { model: 'Supplier', ref: pi.supplier, name: '' },
          sourceModel: 'PurchaseInvoice', sourceRef: pi._id, docType: 'COMPRA', number: pi.serie || '',
          issueDate: pi.fechaEmision, total,
          applied: +(total - Number(pi.balance || 0)).toFixed(2), account: prov._id,
        });
      }
      ap++;
    }

    console.log(`\nCxC procesadas: ${ar}. CxP procesadas: ${ap}.`);
    if (opts.dryRun) console.log('DRY-RUN: nada se escribió.');
  } finally {
    await disconnect();
  }
}

run().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
