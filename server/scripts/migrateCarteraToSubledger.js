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

/** Migración pura (sin conectar/desconectar): las pruebas ejercitan ESTE código. */
async function migrate(opts = {}) {
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

    // Facturas con saldo.
    // Una factura EMITIDA DESDE UNA VENTA a crédito representa la MISMA obligación económica
    // que esa venta: abrirle su propia CxC duplicaría el saldo en la cartera y en el flujo de
    // caja. El documento canónico es la VENTA (es la que abre cartera en el flujo vivo), así
    // que aquí se saltan las facturas que ya están cubiertas por la CxC de su venta.
    const facturasDeVenta = new Set(
      (await Sale.find({ ...base, invoice: { $ne: null }, balance: { $gt: 0.005 } }).select('invoice'))
        .map((s) => String(s.invoice))
    );
    const invoices = await Invoice.find({ ...base, balance: { $gt: 0.005 } });
    let saltadas = 0;
    for (const inv of invoices) {
      if (facturasDeVenta.has(String(inv._id))) {
        saltadas += 1;
        console.log(`  ↷ factura ${inv.secuencial || inv._id}: ya cubierta por la CxC de su venta (no se duplica)`);
        continue;
      }
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

    console.log(`\nCxC procesadas: ${ar}. CxP procesadas: ${ap}. Facturas saltadas por venta enlazada: ${saltadas}.`);
    if (saltadas) {
      console.log('Para revisar duplicados YA creados por una corrida anterior:');
      console.log('  node scripts/diagnoseDuplicateReceivables.js --clinic=<id>');
    }
    if (opts.dryRun) console.log('DRY-RUN: nada se escribió.');
    return { ar, ap, saltadas };
}

async function run() {
  const opts = parseArgs();
  banner('Migración cartera → subledger (CxC/CxP)', opts);
  await connect();
  try {
    return await migrate(opts);
  } finally {
    await disconnect();
  }
}

if (require.main === module) {
  run().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}

module.exports = { run, migrate };
