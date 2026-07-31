#!/usr/bin/env node
/**
 * BORRADO DE TODAS LAS VENTAS — TAREA DE UNA SOLA VEZ.
 *
 * Para empezar las pruebas desde cero: elimina las ventas registradas y TODO lo que nace
 * de ellas, de forma que la contabilidad, la cartera y el inventario queden coherentes
 * (no basta con borrar la colección `sales`: quedarían asientos, CxC y stock descuadrados).
 *
 * ─── SE BORRA ──────────────────────────────────────────────────────────────────────
 *   · Ventas (Sale) — incluidas las anuladas.
 *   · Facturas electrónicas de esas ventas (Invoice) y sus notas de crédito/débito.
 *   · Cartera por cobrar de esas ventas/facturas (Receivable).
 *   · Cobros (Payment tipo COBRO) aplicados ÚNICAMENTE a esas ventas/facturas.
 *   · Ingresos diferidos (DeferredIncome) originados en esas ventas.
 *   · Asientos contables de todo lo anterior, MÁS sus asientos de reverso.
 *   · Movimientos bancarios generados por esas ventas y por esos cobros.
 *   · Movimientos de inventario de esas ventas (y se devuelve el stock a sus capas FIFO).
 *
 * ─── NO SE TOCA (a propósito) ──────────────────────────────────────────────────────
 *   · SECUENCIALES DEL SRI (factura/NC/retención): el SRI ya tiene registrados esos
 *     números y NO admite reutilizarlos. Se conservan: la próxima factura real seguirá
 *     donde iba. Borrar el documento local no lo anula ante el SRI (eso es otro trámite).
 *   · Compras, nómina, activos fijos, bancos (más allá de los movimientos de estas
 *     ventas), plan de cuentas, productos, pacientes, citas ni fichas clínicas.
 *   · Cierres de caja, lotes/liquidaciones de tarjeta y contabilizaciones de comisiones:
 *     son documentos con vida propia. Si alguno cubre ventas borradas, el script lo AVISA
 *     con su conteo para que se revise o se anule a mano.
 *
 * ─── "UNA SOLA VEZ" ────────────────────────────────────────────────────────────────
 * La marca vive en la base (colección `onetimetasks`, clave TASK_KEY), no en disco: el
 * despliegue lo ejecuta en cada push, pero solo el PRIMERO hace algo. Si falla a medias
 * queda FAILED y el siguiente despliegue lo reintenta; una vez DONE no vuelve a correr
 * nunca (ni aunque se repita el push o se reinstale el VPS).
 *
 * ─── USO ───────────────────────────────────────────────────────────────────────────
 *   node scripts/wipeSalesOnce.js                    (DRY-RUN: solo cuenta, no marca nada)
 *   node scripts/wipeSalesOnce.js --commit           (BORRA una vez y deja la marca)
 *   node scripts/wipeSalesOnce.js --commit --clinic=<id>   (solo esa sucursal)
 *   node scripts/wipeSalesOnce.js --commit --force   (repite aunque ya esté hecha)
 *   node scripts/wipeSalesOnce.js --estado           (solo muestra el estado de la marca)
 *
 * Requiere MONGODB_URI en el entorno (server/.env) y se ejecuta desde `server/`.
 */
const os = require('os');
const { connect, disconnect, mongoose } = require('./_common');

const kardex = require('../utils/kardex');
const { recomputeBalances } = require('../utils/accounting');

const OneTimeTask = require('../models/OneTimeTask');
const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');
const CreditDebitNote = require('../models/CreditDebitNote');
const Receivable = require('../models/Receivable');
const DeferredIncome = require('../models/DeferredIncome');
const Payment = require('../models/Payment');
const JournalEntry = require('../models/JournalEntry');
const BankTransaction = require('../models/BankTransaction');
const InventoryMovement = require('../models/InventoryMovement');
const Product = require('../models/Product');
const Treatment = require('../models/Treatment');
const CreditCardBatch = require('../models/CreditCardBatch');
const CardSettlement = require('../models/CardSettlement');
const CommissionPosting = require('../models/CommissionPosting');
const CashClosing = require('../models/CashClosing');
const FiscalPeriod = require('../models/FiscalPeriod');

/**
 * Clave de la tarea. Es lo que hace que se ejecute UNA sola vez: mientras no cambie,
 * cualquier despliegue posterior encuentra la marca DONE y no borra nada.
 * Para volver a limpiar en el futuro se sube la fecha de la clave (nueva tarea).
 */
const TASK_KEY = 'borrar-ventas-2026-07-31';

/** Un proceso que lleva más de esto en RUNNING se da por muerto y se puede reintentar. */
const STALE_RUNNING_MS = 30 * 60 * 1000;

const CHUNK = 500;

/** Ejecuta `work` en una transacción; si el Mongo no las soporta, lo hace sin ella. */
async function atomically(work) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await work(session); });
    return out;
  } catch (e) {
    const noTx = /Transaction numbers are only allowed|Transactions are not supported|not supported.*transaction|replica set/i;
    if (!noTx.test(e.message || '')) throw e;
    return work(null);
  } finally {
    await session.endSession();
  }
}

const withSession = (query, session) => (session ? query.session(session) : query);

/** Borra por lotes para no armar un `$in` gigante. */
async function deleteByIds(Model, ids) {
  let n = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { deletedCount } = await Model.deleteMany({ _id: { $in: ids.slice(i, i + CHUNK) } });
    n += deletedCount || 0;
  }
  return n;
}

const idsOf = (docs) => docs.map((d) => d._id);

/**
 * Reúne TODO lo que hay que borrar. Se calcula antes de tocar nada para poder mostrarlo
 * en el dry-run exactamente igual que se borrará.
 */
async function collectTargets(clinic) {
  const filter = clinic ? { clinic: new mongoose.Types.ObjectId(String(clinic)) } : {};

  const sales = await Sale.find(filter).select('_id clinic saleNumber status items').lean();
  const saleIds = idsOf(sales);

  const invoices = saleIds.length
    ? await Invoice.find({ sale: { $in: saleIds } }).select('_id estado serie secuencial').lean()
    : [];
  const invoiceIds = idsOf(invoices);

  const notes = invoiceIds.length
    ? await CreditDebitNote.find({ refModel: 'Invoice', refDoc: { $in: invoiceIds } }).select('_id').lean()
    : [];
  const deferred = saleIds.length
    ? await DeferredIncome.find({ sourceModel: 'Sale', sourceRef: { $in: saleIds } }).select('_id').lean()
    : [];
  const receivables = saleIds.length || invoiceIds.length
    ? await Receivable.find({
      $or: [
        { sourceModel: 'Sale', sourceRef: { $in: saleIds } },
        { sourceModel: 'Invoice', sourceRef: { $in: invoiceIds } },
      ],
    }).select('_id').lean()
    : [];

  // Cobros: solo los que se aplicaron ÚNICAMENTE a estas ventas/facturas. Un cobro que
  // además pagó otra cosa (o una compra) no se borra —se avisa— porque borrarlo dejaría
  // esa otra cartera cobrada sin respaldo.
  const docIdSet = new Set([...saleIds, ...invoiceIds].map(String));
  const payments = docIdSet.size
    ? await Payment.find({ 'applications.docRef': { $in: [...saleIds, ...invoiceIds] } })
      .select('_id number applications').lean()
    : [];
  const paymentsToDelete = payments.filter((p) => (p.applications || []).every((a) => docIdSet.has(String(a.docRef))));
  const paymentsMixed = payments.filter((p) => !(p.applications || []).every((a) => docIdSet.has(String(a.docRef))));
  const paymentIds = idsOf(paymentsToDelete);

  // Asientos de todos esos documentos… y los reversos que los anularon (que apuntan al
  // asiento original, no al documento): sin ellos quedarían asientos sueltos "REVERSO de".
  const entryOr = [
    { sourceModel: 'Sale', sourceRef: { $in: saleIds } },
    { sourceModel: 'Invoice', sourceRef: { $in: invoiceIds } },
    { sourceModel: 'CreditDebitNote', sourceRef: { $in: idsOf(notes) } },
    { sourceModel: 'DeferredIncome', sourceRef: { $in: idsOf(deferred) } },
    { sourceModel: 'Payment', sourceRef: { $in: paymentIds } },
  ].filter((c) => c.sourceRef.$in.length);

  const entryIds = [];
  const seen = new Set();
  let frontier = [];
  if (entryOr.length) {
    const base = await JournalEntry.find({ $or: entryOr }).select('_id clinic').lean();
    for (const e of base) { seen.add(String(e._id)); entryIds.push(e._id); }
    frontier = idsOf(base);
  }
  while (frontier.length) { // reverso del reverso incluido (por si alguna vez se encadenan)
    const revs = await JournalEntry.find({
      $or: [{ sourceModel: 'JournalEntry', sourceRef: { $in: frontier } }, { reverses: { $in: frontier } }],
    }).select('_id').lean();
    const nuevos = revs.filter((r) => !seen.has(String(r._id)));
    for (const r of nuevos) { seen.add(String(r._id)); entryIds.push(r._id); }
    frontier = idsOf(nuevos);
  }

  const bankTx = (saleIds.length || paymentIds.length)
    ? await BankTransaction.find({
      $or: [
        { sourceModel: 'Sale', sourceRef: { $in: saleIds } },
        { sourceModel: 'Payment', sourceRef: { $in: paymentIds } },
      ],
    }).select('_id').lean()
    : [];

  const movements = saleIds.length
    ? await InventoryMovement.countDocuments({ sourceModel: 'Sale', sourceRef: { $in: saleIds } })
    : 0;

  // Documentos que NO se borran pero que quedan mirando a ventas que ya no existirán.
  const warnings = [];
  const autorizadas = invoices.filter((i) => i.estado === 'AUTORIZADO');
  if (autorizadas.length) {
    warnings.push(`${autorizadas.length} factura(s) electrónica(s) AUTORIZADA(s) por el SRI se borrarán de la base local `
      + `(${autorizadas.slice(0, 5).map((i) => i.serie || i.secuencial).join(', ')}${autorizadas.length > 5 ? '…' : ''}). `
      + 'El SRI las mantiene: si alguna era real hay que anularla ante el SRI aparte. Los secuenciales NO se reinician.');
  }
  if (paymentsMixed.length) {
    warnings.push(`${paymentsMixed.length} cobro(s) tocan además otros documentos: NO se borran `
      + `(${paymentsMixed.slice(0, 5).map((p) => p.number).join(', ')}). Revísalos a mano.`);
  }
  if (saleIds.length) {
    const lotes = await CreditCardBatch.countDocuments({ 'vouchers.sale': { $in: saleIds } });
    if (lotes) warnings.push(`${lotes} lote(s) de tarjeta referencian ventas borradas: revisa o anula esos lotes.`);
    const liq = await CardSettlement.countDocuments({ 'sourceSales.sale': { $in: saleIds } });
    if (liq) warnings.push(`${liq} liquidación(es) de tarjeta referencian ventas borradas: revísalas.`);
  }
  const comisiones = await CommissionPosting.countDocuments({ ...filter, status: 'CONTABILIZADO' });
  if (comisiones) {
    warnings.push(`${comisiones} contabilización(es) de comisiones vigentes incluyen comisiones por venta: `
      + 'no se borran (también cubren citas). Anúlalas y vuelve a contabilizar si quieres partir de cero.');
  }
  const cerrados = await FiscalPeriod.countDocuments({ ...filter, status: 'CERRADO' });
  if (cerrados) {
    warnings.push(`${cerrados} período(s) fiscal(es) CERRADO(s): el borrado no los respeta `
      + '(a diferencia de una anulación normal). Si alguno ya se declaró al SRI, revísalo.');
  }
  const cajas = await CashClosing.countDocuments({ ...filter, status: 'CERRADO' });
  if (cajas) {
    warnings.push(`${cajas} cierre(s) de caja quedaron con sus totales calculados sobre ventas que se borran: `
      + 'sus arqueos históricos dejarán de cuadrar (no se tocan).');
  }

  return {
    sales, saleIds, invoices, invoiceIds, notes, deferred, receivables,
    paymentsToDelete, paymentsMixed, paymentIds, entryIds, bankTx, movements, warnings,
    clinics: [...new Set(sales.map((s) => String(s.clinic)))],
  };
}

/**
 * Kardex: devuelve a sus capas FIFO lo que consumieron las ventas VIGENTES y repone el
 * `stock` del producto. Las ventas ANULADAS ya devolvieron su stock al anularse: volver a
 * devolverlo lo duplicaría, así que sus movimientos solo se borran.
 * Se procesa producto por producto y de forma atómica para que un corte a medias no deje
 * el stock contado dos veces.
 */
async function restoreInventory(activeSaleIds, log) {
  if (!activeSaleIds.length) return { productos: 0, unidades: 0 };
  const productIds = await InventoryMovement.distinct('product', {
    sourceModel: 'Sale', sourceRef: { $in: activeSaleIds },
  });
  let unidades = 0;
  for (const productId of productIds) {
    const devueltas = await atomically(async (session) => {
      const movs = await withSession(
        InventoryMovement.find({ sourceModel: 'Sale', sourceRef: { $in: activeSaleIds }, product: productId }),
        session
      );
      let delta = 0;
      for (const m of movs) {
        if (m.type !== 'salida') continue; // las 'entrada' de una anulación ya se compensaron
        await kardex.reverseIssue({
          consumption: (m.layerConsumption || []).map((c) => ({ layerId: c.layer, qty: c.qty })),
        }, session);
        delta += Number(m.quantity || 0);
      }
      if (delta > 0) {
        await withSession(Product.updateOne({ _id: productId }, { $inc: { stock: delta } }), session);
      }
      const prod = await withSession(Product.findById(productId).select('clinic'), session);
      if (prod) {
        const cur = await kardex.currentStock({ clinicId: prod.clinic, product: productId }, session);
        await withSession(Product.updateOne({ _id: productId }, { $set: { averageCost: cur.averageCost } }), session);
      }
      // Se borran DENTRO de la misma transacción: si algo falla, ni se devolvió el stock
      // ni desapareció el movimiento (un reintento vuelve a empezar sin duplicar).
      await withSession(
        InventoryMovement.deleteMany({ sourceModel: 'Sale', sourceRef: { $in: activeSaleIds }, product: productId }),
        session
      );
      return delta;
    });
    unidades += devueltas;
  }
  log(`   ♻️  Kardex: ${unidades} unidad(es) devueltas a sus capas en ${productIds.length} producto(s).`);
  return { productos: productIds.length, unidades };
}

/** Deshace el avance de tratamientos que estas ventas marcaron como cumplido. */
async function restoreTreatments(sales, log) {
  const saleIds = idsOf(sales);
  if (!saleIds.length) return 0;
  const qtyBySaleProduct = new Map();
  for (const s of sales) {
    for (const it of s.items || []) {
      qtyBySaleProduct.set(`${s._id}|${it.product}`, Number(it.quantity || 0));
    }
  }
  const saleIdSet = new Set(saleIds.map(String));
  const treatments = await Treatment.find({ 'items.completionRefs.ref': { $in: saleIds } });
  let tocados = 0;
  for (const t of treatments) {
    let cambio = false;
    for (const item of t.items) {
      const quitados = (item.completionRefs || []).filter((r) => r.type === 'sale' && saleIdSet.has(String(r.ref)));
      if (!quitados.length) continue;
      item.completionRefs = item.completionRefs.filter((r) => !(r.type === 'sale' && saleIdSet.has(String(r.ref))));
      const bajar = quitados.reduce((s, r) => s + (qtyBySaleProduct.get(`${r.ref}|${item.product}`) || 1), 0);
      item.completed = Math.max(0, Number(item.completed || 0) - bajar);
      cambio = true;
    }
    if (!cambio) continue;
    if (t.status === 'completado') t.status = 'activo';
    await t.save();
    tocados += 1;
  }
  if (tocados) log(`   ♻️  Tratamientos: ${tocados} plan(es) con su progreso por venta revertido.`);
  return tocados;
}

/**
 * Borra las ventas y sus derivados. Devuelve el resumen de conteos.
 * Con `commit: false` no escribe nada: solo informa lo que borraría.
 */
async function wipeSales({ clinic = null, commit = false, log = console.log } = {}) {
  const t = await collectTargets(clinic);

  const plan = [
    ['ventas', 'Ventas (Sale)', t.saleIds.length],
    ['facturas', 'Facturas electrónicas (Invoice)', t.invoiceIds.length],
    ['notas', 'Notas de crédito/débito (CreditDebitNote)', t.notes.length],
    ['cxc', 'Cuentas por cobrar (Receivable)', t.receivables.length],
    ['cobros', 'Cobros (Payment)', t.paymentIds.length],
    ['diferidos', 'Ingresos diferidos (DeferredIncome)', t.deferred.length],
    ['asientos', 'Asientos contables (JournalEntry, con reversos)', t.entryIds.length],
    ['bancos', 'Movimientos bancarios (BankTransaction)', t.bankTx.length],
    ['inventario', 'Movimientos de inventario (InventoryMovement)', t.movements],
  ];
  for (const [, label, n] of plan) log(`   ${commit ? '🗑️ ' : '•'} ${label}: ${n}`);
  for (const w of t.warnings) log(`   ⚠️  ${w}`);

  const stats = Object.fromEntries(plan.map(([key, , n]) => [key, n]));
  if (!commit) {
    log('\nDRY-RUN: no se borró nada. Ejecuta con --commit para aplicar.');
    return { ...stats, dryRun: true, warnings: t.warnings };
  }
  if (!t.saleIds.length) {
    log('\nNo hay ventas que borrar: nada que hacer.');
    return { ...stats, warnings: t.warnings };
  }

  // 1) Inventario y tratamientos ANTES de borrar las ventas (necesitan sus datos).
  const activeSaleIds = t.sales.filter((s) => s.status !== 'anulada').map((s) => s._id);
  await restoreInventory(activeSaleIds, log);
  await restoreTreatments(t.sales, log);
  // Movimientos de las ventas anuladas (y cualquier resto): ya no cambian el stock.
  const restoMovs = await InventoryMovement.deleteMany({ sourceModel: 'Sale', sourceRef: { $in: t.saleIds } });
  if (restoMovs.deletedCount) log(`   🗑️  Movimientos de inventario de ventas anuladas: ${restoMovs.deletedCount}.`);

  // 2) Documentos, de la hoja a la raíz.
  await deleteByIds(BankTransaction, idsOf(t.bankTx));
  await deleteByIds(Payment, t.paymentIds);
  await deleteByIds(Receivable, idsOf(t.receivables));
  await deleteByIds(DeferredIncome, idsOf(t.deferred));
  await deleteByIds(CreditDebitNote, idsOf(t.notes));
  await deleteByIds(Invoice, t.invoiceIds);
  await deleteByIds(JournalEntry, t.entryIds);
  await deleteByIds(Sale, t.saleIds);

  // 3) Saldos por cuenta/período: se recalculan desde los asientos que quedaron vivos
  //    (se mantienen por incrementos, así que borrar asientos sin recalcular los deja mal).
  for (const clinicId of t.clinics) {
    const filas = await recomputeBalances(clinicId);
    log(`   ♻️  Saldos recalculados para la sucursal ${clinicId}: ${filas} fila(s).`);
  }

  log('\n✅  Ventas eliminadas. Compras, nómina, catálogos y secuenciales del SRI quedaron intactos.');
  return { ...stats, warnings: t.warnings };
}

/**
 * Envoltorio "una sola vez": reclama la marca de forma atómica (el índice `_id` da la
 * exclusión mutua), ejecuta el borrado y deja constancia del resultado.
 */
async function runOnce({ key = TASK_KEY, clinic = null, force = false, log = console.log } = {}) {
  const previa = await OneTimeTask.findById(key).lean();
  if (previa && !force) {
    if (previa.status === 'DONE') {
      log(`⏭️  Tarea "${key}" ya ejecutada el ${previa.finishedAt?.toISOString?.() || '—'}: no se hace nada.`);
      return { skipped: true, status: 'DONE' };
    }
    if (previa.status === 'RUNNING' && Date.now() - new Date(previa.startedAt).getTime() < STALE_RUNNING_MS) {
      log(`⏭️  Tarea "${key}" en ejecución por ${previa.host} (pid ${previa.pid}): no se hace nada.`);
      return { skipped: true, status: 'RUNNING' };
    }
    log(`↻  Intento anterior de "${key}" quedó en ${previa.status}: se reintenta.`);
  }

  const marca = {
    status: 'RUNNING', host: os.hostname(), pid: process.pid, startedAt: new Date(),
    finishedAt: null, error: '', result: null,
  };
  if (previa) {
    await OneTimeTask.updateOne({ _id: key }, { $set: marca, $inc: { attempts: 1 } });
  } else {
    try {
      await OneTimeTask.create({ _id: key, ...marca, attempts: 1 });
    } catch (e) {
      if (e.code === 11000) { // otro proceso la reclamó en este mismo instante
        log(`⏭️  Otro proceso reclamó "${key}" primero: no se hace nada.`);
        return { skipped: true, status: 'RUNNING' };
      }
      throw e;
    }
  }

  try {
    const result = await wipeSales({ clinic, commit: true, log });
    await OneTimeTask.updateOne({ _id: key }, { $set: { status: 'DONE', finishedAt: new Date(), result } });
    log(`🔒  Marca "${key}" = DONE: no volverá a ejecutarse en los próximos despliegues.`);
    return { skipped: false, status: 'DONE', result };
  } catch (e) {
    await OneTimeTask.updateOne({ _id: key }, { $set: { status: 'FAILED', finishedAt: new Date(), error: e.message } });
    throw e;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const force = args.includes('--force');
  const soloEstado = args.includes('--estado');
  const clinic = (args.find((a) => a.startsWith('--clinic=')) || '').split('=')[1] || null;
  const key = (args.find((a) => a.startsWith('--key=')) || '').split('=')[1] || TASK_KEY;

  console.log('\n=== BORRADO DE VENTAS (tarea de una sola vez) ===');
  console.log(`Clave de la tarea: ${key}`);
  if (clinic) console.log(`Alcance: solo la sucursal ${clinic}`);
  console.log(commit ? 'MODO: COMMIT (borra de verdad).' : 'MODO: DRY-RUN (solo cuenta). Usa --commit para aplicar.');
  console.log('');

  await connect();
  try {
    const previa = await OneTimeTask.findById(key).lean();
    if (soloEstado) {
      console.log(previa
        ? `Estado: ${previa.status} · intentos: ${previa.attempts} · host: ${previa.host} · fin: ${previa.finishedAt || '—'}`
        : 'Estado: sin marca (nunca se ejecutó).');
      return;
    }
    if (!commit) {
      if (previa) console.log(`(Marca existente: ${previa.status}. Con --commit ${previa.status === 'DONE' && !force ? 'NO' : 'SÍ'} se ejecutaría.)\n`);
      await wipeSales({ clinic, commit: false });
      return;
    }
    await runOnce({ key, clinic, force });
  } finally {
    await disconnect();
  }
}

module.exports = { wipeSales, runOnce, collectTargets, TASK_KEY };

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
