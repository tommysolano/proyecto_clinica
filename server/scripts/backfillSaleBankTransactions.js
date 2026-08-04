/**
 * REPONE EN EL LIBRO DE BANCOS los cobros por TRANSFERENCIA de las ventas del mostrador.
 *
 * El problema que arregla: al registrar una venta cobrada por transferencia, el asiento debitaba
 * la cuenta contable del banco, pero no se creaba ningún `BankTransaction`. Consecuencia para
 * las ventas ya registradas:
 *   · No aparecen en Bancos → Movimientos.
 *   · La conciliación bancaria no las ofrece (solo se veían los pagos, que sí lo creaban).
 *   · El `bookBalance` de la cuenta quedó POR DEBAJO de su propia cuenta contable, y la
 *     diferencia crece con cada venta.
 *
 * El código nuevo ya crea el movimiento; este script repone los que faltan hacia atrás. Es
 * idempotente: una venta que ya tiene su movimiento se salta.
 *
 * Uso:
 *   node scripts/backfillSaleBankTransactions.js            (dry-run: solo informa)
 *   node scripts/backfillSaleBankTransactions.js --commit   (crea los movimientos)
 *
 * OJO: el .env local apunta a PRODUCCIÓN. Preferir ejecutarlo en el VPS.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');

const r2 = (n) => +Number(n || 0).toFixed(2);

/** Cobros por transferencia de una venta, con su banco (soporta el pago dividido y el legacy). */
function transferenciasDe(sale) {
  const filas = (sale.payments || []).filter((p) => p.method === 'transferencia' && p.bankAccount && Number(p.amount) > 0);
  if (filas.length) return filas.map((p) => ({ bankAccount: p.bankAccount, amount: r2(p.amount), reference: p.reference || '' }));
  // Venta antigua sin desglose: método resumen 'transferencia' y banco en la cabecera.
  if (sale.paymentMethod === 'transferencia' && sale.bankAccount && Number(sale.total) > 0) {
    return [{ bankAccount: sale.bankAccount, amount: r2(sale.total), reference: '' }];
  }
  return [];
}

async function main() {
  const commit = process.argv.includes('--commit');
  await mongoose.connect(process.env.MONGODB_URI);

  const ventas = await Sale.find({
    status: 'completada',
    $or: [{ 'payments.method': 'transferencia' }, { paymentMethod: 'transferencia' }],
  }).select('clinic saleNumber clientName createdAt total paymentMethod payments bankAccount journalEntry costCenter');

  console.log(`Ventas con cobro por transferencia: ${ventas.length}`);

  const porBanco = new Map();   // bancoId -> importe repuesto
  let creados = 0;
  let saltados = 0;

  for (const venta of ventas) {
    const filas = transferenciasDe(venta);
    if (!filas.length) continue;

    // Si la venta YA tiene movimientos bancarios propios, no se toca (evita duplicar).
    const existentes = await BankTransaction.countDocuments({
      clinic: venta.clinic, sourceModel: 'Sale', sourceRef: venta._id,
    });
    if (existentes) { saltados += 1; continue; }

    for (const f of filas) {
      const banco = await BankAccount.findOne({ _id: f.bankAccount, clinic: venta.clinic });
      if (!banco) {
        console.log(`  ! ${venta.saleNumber}: la cuenta bancaria ${f.bankAccount} ya no existe, se omite`);
        continue;
      }
      porBanco.set(String(banco._id), r2((porBanco.get(String(banco._id)) || 0) + f.amount));
      creados += 1;
      if (commit) {
        // Al guardarse, el gancho del modelo suma el importe al bookBalance de la cuenta.
        await BankTransaction.create({
          clinic: venta.clinic,
          bankAccount: banco._id,
          date: venta.createdAt,
          type: 'COBRO',
          amount: f.amount,
          direction: 1,
          description: `Venta ${venta.saleNumber}`,
          reference: f.reference || venta.saleNumber,
          partyName: venta.clientName || '',
          costCenter: venta.costCenter || null,
          journalEntry: venta.journalEntry || null,
          sourceModel: 'Sale',
          sourceRef: venta._id,
        });
      }
    }
  }

  console.log(`\nMovimientos ${commit ? 'creados' : 'que se crearían'}: ${creados}`);
  console.log(`Ventas que ya tenían su movimiento (sin tocar): ${saltados}`);
  for (const [bancoId, monto] of porBanco) {
    const b = await BankAccount.findById(bancoId).select('name bank');
    console.log(`  ${b?.name || bancoId}: +$${monto.toFixed(2)}`);
  }
  if (!commit) console.log('\n(dry-run: no se escribió nada. Repite con --commit para aplicarlo.)');

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
