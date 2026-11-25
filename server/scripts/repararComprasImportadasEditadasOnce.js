#!/usr/bin/env node
/**
 * COMPRAS IMPORTADAS DE CONTÍFICO QUE LA EDICIÓN RECONTABILIZÓ — UNA SOLA VEZ (nov-2026).
 *
 * El 24-11-2026 se editaron en Compras 7 notas de venta importadas de Contífico, solo para
 * completar su autorización. Su compra y su pago ya estaban en los asientos importados
 * (CTF-…). Pero la edición completa las trató como compras nuevas:
 *   · creó un asiento de compra propio (AS-…): GASTO DUPLICADO, y
 *   · abrió una CxP por el total: compras PAGADAS volvieron a «por pagar».
 * (Desde ahora la edición no lo hace: ver esImportadaSinAsiento en purchaseInvoiceController.)
 *
 * Esta tarea, para cada compra así:
 *   · REVERSA ese asiento propio con la MISMA fecha (los asientos son inmutables; así el mes
 *     de la compra queda como estaba, sin el gasto duplicado);
 *   · ANULA la CxP abierta por la edición (solo si no tiene pagos aplicados en el sistema);
 *   · devuelve la compra a su estado REAL y la deja sin asiento propio. No todas estaban pagadas
 *     (026/032/033 estaban pendientes en Contífico y ya tenían su CxP importada, que la edición
 *     DUPLICÓ). El saldo sale de la CxP importada (sourceModel 'ContificoRecord', con los pagos
 *     que se le hayan aplicado después) o, si no la hay, del saldo del documento en Contífico.
 *   · CONSERVA la autorización y demás datos del comprobante que se corrigieron.
 *
 * Detección (no hay ids fijos): compra con sourceModel 'ContificoRecord' cuyo asiento es uno
 * creado por el sistema (sourceModel 'PurchaseInvoice', no un CTF-…) y sin reversar, con una
 * CxP sin nada aplicado. Las compras enlazadas a su asiento CTF-… no se tocan.
 *
 *   node scripts/repararComprasImportadasEditadasOnce.js            (DRY-RUN: lista y no escribe)
 *   node scripts/repararComprasImportadasEditadasOnce.js --commit   (repara una vez y deja marca)
 */
const os = require('os');
const { connect, disconnect } = require('./_common');
const OneTimeTask = require('../models/OneTimeTask');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const JournalEntry = require('../models/JournalEntry');
const Payable = require('../models/Payable');
const ContificoRecord = require('../models/ContificoRecord');
require('../models/Supplier');
const { reverseEntry, runInTransaction } = require('../utils/accounting');

const TASK_KEY = 'reparar-compras-importadas-editadas-2026-11-25';
const MOTIVO = 'Compra importada de Contífico: su asiento y pago ya existían; la edición lo duplicó';

/** Documento original de Contífico archivado (gzip-json). */
function payloadContifico(rec) {
  if (!rec?.payloadCompressed) return null;
  const buf = Buffer.from(rec.payloadCompressed.buffer || rec.payloadCompressed);
  return JSON.parse(require('zlib').gunzipSync(buf).toString('utf8'));
}

/** Saldo real de la compra: CxP importada (con lo aplicado después) o saldo de Contífico. */
async function saldoReal(p) {
  const neto = +(Number(p.total || 0) - Number(p.retentionTotal || 0)).toFixed(2);
  const cxpImportada = await Payable.findOne({ clinic: p.clinic, sourceModel: 'ContificoRecord', sourceRef: p.sourceRef, status: { $ne: 'ANULADO' } }).lean();
  if (cxpImportada) return { saldo: Math.max(0, +(Number(cxpImportada.total || 0) - Number(cxpImportada.applied || 0)).toFixed(2)), origen: 'CxP importada' };
  const rec = await ContificoRecord.findById(p.sourceRef).lean();
  const d = payloadContifico(rec);
  if (d && d.saldo != null) return { saldo: Math.min(neto, Math.max(0, +Number(d.saldo).toFixed(2))), origen: 'saldo en Contífico' };
  return null; // sin dato fiable: no se toca
}

async function afectadas() {
  const candidatas = await PurchaseInvoice.find({ sourceModel: 'ContificoRecord', journalEntry: { $ne: null }, status: { $ne: 'ANULADA' } })
    .populate('supplier', 'razonSocial').lean();
  const out = [];
  for (const p of candidatas) {
    const je = await JournalEntry.findById(p.journalEntry).lean();
    if (!je || je.sourceModel !== 'PurchaseInvoice' || je.isReversed || je.reversedBy) continue; // enlazada a su CTF-…: bien
    const cxp = await Payable.findOne({ clinic: p.clinic, sourceModel: 'PurchaseInvoice', sourceRef: p._id }).lean();
    const aplicado = Number(cxp?.applied || 0);
    const real = await saldoReal(p);
    out.push({ p, je, cxp, real, apta: aplicado <= 0.005 && !!real });
  }
  return out;
}

async function main() {
  const commit = process.argv.includes('--commit');
  await connect();
  try {
    const lista = await afectadas();
    console.log(`Compras importadas recontabilizadas por una edición: ${lista.length}`);
    for (const { p, je, cxp, real, apta } of lista) {
      const destino = real ? (real.saldo > 0.005 ? `REGISTRADA saldo ${real.saldo}` : 'PAGADA saldo 0') + ` (${real.origen})` : 'sin dato';
      console.log(`  ${apta ? '·' : '⚠ NO SE TOCA (pagos en el sistema o sin saldo fiable):'} ${p.serie} ${p.docType} ${p.supplier?.razonSocial || ''} $${p.total}`
        + ` | hoy ${p.status} saldo ${p.balance} → ${destino} | asiento ${je.number} (${je.date.toISOString().slice(0, 10)})`
        + ` | CxP de la edición ${cxp ? `${cxp.status} aplicado ${cxp.applied}` : 'no hay'} | aut ${p.autorizacion || '—'}`);
    }
    if (!commit) { console.log('\nDRY-RUN: no se escribió nada. Use --commit para reparar.'); return; }

    const previa = await OneTimeTask.findById(TASK_KEY).lean();
    if (previa?.status === 'DONE') { console.log(`⏭️  "${TASK_KEY}" ya ejecutada.`); return; }
    const marca = { status: 'RUNNING', host: os.hostname(), pid: process.pid, startedAt: new Date(), finishedAt: null, error: '', result: null };
    if (previa) await OneTimeTask.updateOne({ _id: TASK_KEY }, { $set: marca, $inc: { attempts: 1 } });
    else await OneTimeTask.create({ _id: TASK_KEY, ...marca, attempts: 1 });

    const reparadas = [];
    try {
      for (const { p, je, real, apta } of lista) {
        if (!apta) continue;
        const pagada = real.saldo <= 0.005;
        await runInTransaction(async (session) => {
          // Misma fecha que el asiento duplicado: el mes de la compra queda limpio.
          const rev = await reverseEntry({ clinicId: p.clinic, entryId: je._id, userId: null, reason: MOTIVO, date: je.date, session });
          await Payable.updateOne({ clinic: p.clinic, sourceModel: 'PurchaseInvoice', sourceRef: p._id }, { $set: { status: 'ANULADO' } }, { session });
          await PurchaseInvoice.updateOne({ _id: p._id }, {
            $set: { journalEntry: null, status: pagada ? 'PAGADA' : 'REGISTRADA', paid: pagada, balance: pagada ? 0 : real.saldo },
          }, { session });
          reparadas.push(`${p.serie} (${je.number} → ${rev.number}) → ${pagada ? 'PAGADA' : `REGISTRADA saldo ${real.saldo}`}`);
        });
      }
      await OneTimeTask.updateOne({ _id: TASK_KEY }, { $set: { status: 'DONE', finishedAt: new Date(), result: { reparadas } } });
      console.log(`\n✅ Reparadas ${reparadas.length}:`);
      reparadas.forEach((r) => console.log('   ', r));
    } catch (e) {
      await OneTimeTask.updateOne({ _id: TASK_KEY }, { $set: { status: 'FAILED', finishedAt: new Date(), error: String(e?.message || e), result: { reparadas } } });
      throw e;
    }
  } finally {
    await disconnect();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
