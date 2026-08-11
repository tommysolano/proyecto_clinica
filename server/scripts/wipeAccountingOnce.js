#!/usr/bin/env node
/**
 * DEJAR LA CONTABILIDAD EN CERO — TAREA DE UNA SOLA VEZ.
 *
 * Borra TODO el movimiento contable para poder rehacer las pruebas desde cero, sin
 * tocar nada del CRM / marketing (chats, contactos, plantillas, automatizaciones,
 * campañas y segmentos siguen funcionando igual) ni los datos clínicos.
 *
 * A diferencia de `resetDatosPrueba.js` (que se corre a mano con flags), este script
 * está pensado para dispararse SOLO en un despliegue concreto: lleva su marca en la
 * base y no vuelve a ejecutarse nunca más.
 *
 * ─── SE BORRA ──────────────────────────────────────────────────────────────────────
 *   Ventas       Sale, Invoice, Quotation, notas de crédito/débito, CxC, ingresos diferidos
 *   Compras      PurchaseInvoice, CxP, comprobantes de retención emitidos
 *   Cobros/pagos Payment (cobros y pagos, con sus aplicaciones)
 *   Caja         movimientos y cierres de caja, depósitos, lotes y liquidaciones de tarjeta
 *   Bancos       movimientos bancarios, cheques y conciliaciones
 *   Inventario   capas del kardex, movimientos y tomas físicas (el stock y el costo
 *                promedio de cada producto vuelven a 0; los productos NO se borran)
 *   Activos      activos fijos y su depreciación
 *   Comisiones   contabilizaciones de comisiones
 *   Nómina       roles de pago, préstamos y deducciones de empleados
 *   Contable     asientos, saldos por período, períodos fiscales y el contador de asientos
 *   SRI          declaraciones (103/104), anexo RDEP
 *   Gerencial    presupuestos, plan de flujo de caja y sus partidas manuales
 *   Tratamientos se les quita el avance que venía de esas ventas (no se borran)
 *
 * ─── NO SE TOCA (a propósito) ──────────────────────────────────────────────────────
 *   · CRM / MARKETING COMPLETO: conversaciones, mensajes, contactos, oportunidades,
 *     plantillas, mensajes guardados, automatizaciones e inscripciones, campañas,
 *     segmentos, números de WhatsApp, papelera. Nada de esto se lee ni se escribe aquí.
 *   · Pacientes, citas, fichas clínicas y seguimientos.
 *   · Usuarios, clínicas, consultorios y bloqueos de acceso.
 *   · CATÁLOGOS: plan de cuentas, configuración contable, centros de costo, categorías
 *     de inventario, productos, proveedores, bodegas, cuentas bancarias, tarjetas,
 *     reglas de retención, empleados y catálogos de nómina.
 *   · CERTIFICADO DIGITAL (.p12) y su configuración de facturación.
 *   · SECUENCIALES DEL SRI (factura, NC, retención): el SRI ya tiene registrados esos
 *     números y no admite reutilizarlos, así que por defecto se conservan. Si de verdad
 *     hay que reiniciarlos (ambiente de PRUEBAS), se pasa `--secuenciales`.
 *   · Registro de auditoría (AuditLog): es la constancia de lo que se hizo.
 *
 * ─── "UNA SOLA VEZ" ────────────────────────────────────────────────────────────────
 * La marca vive en la base (colección `onetimetasks`, clave TASK_KEY), no en disco. El
 * despliegue puede invocarlo en cada push: solo el PRIMERO hace algo. Si falla a medias
 * queda FAILED y el siguiente despliegue lo reintenta; una vez DONE no corre nunca más.
 *
 * ⚠️  MIENTRAS LA LÍNEA DE `deploy.sh` SIGA COMENTADA, ESTE SCRIPT NO SE EJECUTA EN
 *     NINGÚN DESPLIEGUE. Para activarlo hay que descomentarla y hacer push.
 *
 * ─── USO ───────────────────────────────────────────────────────────────────────────
 *   node scripts/wipeAccountingOnce.js                      (DRY-RUN: solo cuenta)
 *   node scripts/wipeAccountingOnce.js --commit             (BORRA una vez y deja la marca)
 *   node scripts/wipeAccountingOnce.js --commit --clinic=<id>       (solo esa sucursal)
 *   node scripts/wipeAccountingOnce.js --commit --secuenciales      (además reinicia el SRI)
 *   node scripts/wipeAccountingOnce.js --commit --force     (repite aunque ya esté hecha)
 *   node scripts/wipeAccountingOnce.js --estado             (solo muestra el estado)
 *
 * Requiere MONGODB_URI en el entorno (server/.env) y se ejecuta desde `server/`.
 */
const os = require('os');
const { connect, disconnect, mongoose } = require('./_common');

const OneTimeTask = require('../models/OneTimeTask');

// ─── Ventas ──────────────────────────────────────────────────────────────────
const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');
const Quotation = require('../models/Quotation');
const CreditDebitNote = require('../models/CreditDebitNote');
const Receivable = require('../models/Receivable');
const DeferredIncome = require('../models/DeferredIncome');
// ─── Compras ─────────────────────────────────────────────────────────────────
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Payable = require('../models/Payable');
const RetentionVoucher = require('../models/RetentionVoucher');
// ─── Cobros y pagos ──────────────────────────────────────────────────────────
const Payment = require('../models/Payment');
// ─── Caja ────────────────────────────────────────────────────────────────────
const CashMovement = require('../models/CashMovement');
const CashClosing = require('../models/CashClosing');
const CashDeposit = require('../models/CashDeposit');
const CardSettlement = require('../models/CardSettlement');
const CreditCardBatch = require('../models/CreditCardBatch');
// ─── Bancos ──────────────────────────────────────────────────────────────────
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const BankCheck = require('../models/BankCheck');
const Reconciliation = require('../models/Reconciliation');
// ─── Inventario ──────────────────────────────────────────────────────────────
const InventoryLayer = require('../models/InventoryLayer');
const InventoryMovement = require('../models/InventoryMovement');
const PhysicalCount = require('../models/PhysicalCount');
const Product = require('../models/Product');
// ─── Activos, comisiones, nómina ─────────────────────────────────────────────
const FixedAsset = require('../models/FixedAsset');
const CommissionPosting = require('../models/CommissionPosting');
const Payroll = require('../models/Payroll');
const EmployeeLoan = require('../models/EmployeeLoan');
const EmployeeDeduction = require('../models/EmployeeDeduction');
// ─── Contabilidad pura ───────────────────────────────────────────────────────
const JournalEntry = require('../models/JournalEntry');
const AccountBalance = require('../models/AccountBalance');
const FiscalPeriod = require('../models/FiscalPeriod');
const Counter = require('../models/Counter');
// ─── SRI y gerencial ─────────────────────────────────────────────────────────
const SriDeclaration = require('../models/SriDeclaration');
const RdepAnnex = require('../models/RdepAnnex');
const Budget = require('../models/Budget');
const CashFlowPlan = require('../models/CashFlowPlan');
const CashFlowManualItem = require('../models/CashFlowManualItem');
// ─── Efectos colaterales ─────────────────────────────────────────────────────
const Treatment = require('../models/Treatment');
const InvoicingConfig = require('../models/InvoicingConfig');

/**
 * Clave de la tarea. Es lo que hace que se ejecute UNA sola vez: mientras no cambie,
 * cualquier despliegue posterior encuentra la marca DONE y no borra nada.
 * Para volver a limpiar más adelante se sube la fecha de la clave (tarea nueva).
 */
const TASK_KEY = 'borrar-contabilidad-2026-08-10';

/** Un proceso que lleva más de esto en RUNNING se da por muerto y se puede reintentar. */
const STALE_RUNNING_MS = 30 * 60 * 1000;

/**
 * Qué se borra, agrupado como lo ve el usuario en el menú de Contabilidad.
 * `[etiqueta, Modelo, filtroExtra?]`.
 */
const GRUPOS = [
  ['Ventas', [
    ['Ventas (Sale)', Sale],
    ['Facturas electrónicas (Invoice)', Invoice],
    ['Cotizaciones (Quotation)', Quotation],
    ['Notas de crédito/débito (CreditDebitNote)', CreditDebitNote],
    ['Cuentas por cobrar (Receivable)', Receivable],
    ['Ingresos diferidos (DeferredIncome)', DeferredIncome],
  ]],
  ['Compras', [
    ['Facturas de compra (PurchaseInvoice)', PurchaseInvoice],
    ['Cuentas por pagar (Payable)', Payable],
    ['Comprobantes de retención (RetentionVoucher)', RetentionVoucher],
  ]],
  ['Cobros y pagos', [
    ['Cobros y pagos (Payment)', Payment],
  ]],
  ['Caja', [
    ['Movimientos de caja (CashMovement)', CashMovement],
    ['Cierres de caja (CashClosing)', CashClosing],
    ['Depósitos de efectivo (CashDeposit)', CashDeposit],
    ['Liquidaciones de tarjeta (CardSettlement)', CardSettlement],
    ['Lotes de tarjeta (CreditCardBatch)', CreditCardBatch],
  ]],
  ['Bancos', [
    ['Movimientos bancarios (BankTransaction)', BankTransaction],
    ['Cheques (BankCheck)', BankCheck],
    ['Conciliaciones (Reconciliation)', Reconciliation],
  ]],
  ['Inventario', [
    ['Capas del kardex (InventoryLayer)', InventoryLayer],
    ['Movimientos de inventario (InventoryMovement)', InventoryMovement],
    ['Tomas físicas (PhysicalCount)', PhysicalCount],
  ]],
  ['Activos fijos', [
    ['Activos fijos (FixedAsset)', FixedAsset],
  ]],
  ['Comisiones', [
    ['Comisiones contabilizadas (CommissionPosting)', CommissionPosting],
  ]],
  ['Nómina', [
    ['Roles de pago (Payroll)', Payroll],
    ['Préstamos de empleados (EmployeeLoan)', EmployeeLoan],
    ['Deducciones de empleados (EmployeeDeduction)', EmployeeDeduction],
  ]],
  ['Contabilidad', [
    ['Asientos contables (JournalEntry)', JournalEntry],
    ['Saldos por cuenta/período (AccountBalance)', AccountBalance],
    ['Períodos fiscales (FiscalPeriod)', FiscalPeriod],
    ['Contador de numeración de asientos', Counter, { key: /^journal-/ }],
  ]],
  ['SRI', [
    ['Declaraciones 103/104 (SriDeclaration)', SriDeclaration],
    ['Anexo RDEP (RdepAnnex)', RdepAnnex],
  ]],
  ['Gerencial', [
    ['Presupuestos (Budget)', Budget],
    ['Plan de flujo de caja (CashFlowPlan)', CashFlowPlan],
    ['Partidas manuales de flujo (CashFlowManualItem)', CashFlowManualItem],
  ]],
];

/**
 * Quita de los planes de tratamiento el avance que venía de una venta. Las ventas se
 * borran enteras, así que cualquier referencia de tipo 'sale' queda huérfana: si no se
 * limpia, el plan sigue diciendo "3 de 5 sesiones cumplidas" sin ninguna venta detrás.
 * El avance registrado desde CITAS (type 'appointment') se respeta.
 */
async function limpiarTratamientos(filter, commit, log) {
  const planes = await Treatment.find({ ...filter, 'items.completionRefs.type': 'sale' });
  if (!planes.length) return 0;
  if (!commit) {
    log(`   • Tratamientos con avance por venta: ${planes.length} plan(es) se revertirían.`);
    return planes.length;
  }
  let tocados = 0;
  for (const plan of planes) {
    let cambio = false;
    for (const item of plan.items || []) {
      const porVenta = (item.completionRefs || []).filter((r) => r.type === 'sale');
      if (!porVenta.length) continue;
      item.completionRefs = (item.completionRefs || []).filter((r) => r.type !== 'sale');
      // Cada cita cumple exactamente una sesión (appointmentController), así que lo que
      // queda cumplido es el número de referencias de cita que sobrevivieron.
      item.completed = Math.min(item.completionRefs.length, Number(item.quantity || 0));
      cambio = true;
    }
    if (!cambio) continue;
    if (plan.status === 'completado') plan.status = 'activo';
    await plan.save();
    tocados += 1;
  }
  log(`   ♻️  Tratamientos: avance por venta revertido en ${tocados} plan(es).`);
  return tocados;
}

/**
 * El kardex es la ÚNICA fuente del stock. Al borrarlo hay que dejar en cero el cache que
 * llevan los productos, o el sistema seguiría creyendo que hay existencias que ya no
 * tienen ni una capa detrás.
 */
async function resetearStock(filter, commit, log) {
  const conStock = await Product.countDocuments({
    ...filter,
    $or: [{ stock: { $gt: 0 } }, { averageCost: { $gt: 0 } }, { 'stockByClinic.0': { $exists: true } }],
  });
  if (!commit) {
    log(`   • Stock y costo promedio: se pondrían en 0 (${conStock} producto(s) los tienen).`);
    return conStock;
  }
  await Product.updateMany(filter, { $set: { stock: 0, averageCost: 0, stockByClinic: [] } });
  log(`   ♻️  Stock y costo promedio en 0 (${conStock} producto(s) los tenían). Los productos NO se borran.`);
  return conStock;
}

/**
 * El saldo de libro del banco lo mantienen los movimientos por incrementos. Sin movimientos,
 * el saldo correcto es el SALDO INICIAL configurado (no cero: ese saldo inicial es un dato
 * de configuración que el contador digitó, no un movimiento).
 */
async function resetearSaldosBancarios(filter, commit, log) {
  const cuentas = await BankAccount.find(filter).select('name bookBalance initialBalance');
  if (!cuentas.length) return 0;
  if (!commit) {
    log(`   • Saldo de libro de ${cuentas.length} cuenta(s) bancaria(s): volvería a su saldo inicial.`);
    return cuentas.length;
  }
  for (const c of cuentas) {
    await BankAccount.updateOne({ _id: c._id }, { $set: { bookBalance: Number(c.initialBalance || 0) } });
  }
  log(`   ♻️  ${cuentas.length} cuenta(s) bancaria(s) devueltas a su saldo inicial (la cuenta no se borra).`);
  return cuentas.length;
}

/**
 * Reinicio de los secuenciales del SRI. APAGADO por defecto: en producción esos números
 * ya están registrados ante el SRI y no se pueden reutilizar. Solo tiene sentido en un
 * ambiente de pruebas (`ambiente: '1'`).
 */
async function reiniciarSecuenciales(filter, commit, log) {
  const configs = await InvoicingConfig.find(filter).select('secuencial ambiente retentionSeries');
  if (!configs.length) return 0;
  const enProduccion = configs.filter((c) => c.ambiente === '2');
  if (enProduccion.length) {
    log(`   ⚠️  ${enProduccion.length} configuración(es) están en ambiente PRODUCCIÓN: `
      + 'reiniciar su secuencial haría que el SRI rechace las próximas facturas por número repetido.');
  }
  if (!commit) {
    log(`   • Secuenciales SRI: ${configs.length} configuración(es) volverían a 1.`);
    return configs.length;
  }
  for (const c of configs) {
    await InvoicingConfig.updateOne({ _id: c._id }, { $set: { secuencial: 1, retentionSeries: {} } });
  }
  log(`   🔢  Secuenciales SRI reiniciados en ${configs.length} configuración(es). El certificado digital NO se tocó.`);
  return configs.length;
}

/**
 * Borra el movimiento contable. Con `commit: false` no escribe nada: solo informa.
 */
async function wipeAccounting({ clinic = null, commit = false, secuenciales = false, log = console.log } = {}) {
  const filter = clinic ? { clinic: new mongoose.Types.ObjectId(String(clinic)) } : {};
  const stats = {};
  let totalDocs = 0;

  for (const [grupo, entradas] of GRUPOS) {
    log(`\n— ${grupo}`);
    for (const [label, Model, extra] of entradas) {
      const f = { ...filter, ...(extra || {}) };
      const n = await Model.countDocuments(f);
      totalDocs += n;
      stats[Model.modelName] = (stats[Model.modelName] || 0) + n;
      if (!commit) { log(`   • ${label}: ${n}`); continue; }
      const { deletedCount } = await Model.deleteMany(f);
      log(`   🗑️  ${label}: ${deletedCount} eliminados (había ${n}).`);
    }
  }

  log('\n— Efectos colaterales');
  await resetearStock(filter, commit, log);
  await resetearSaldosBancarios(filter, commit, log);
  await limpiarTratamientos(filter, commit, log);
  if (secuenciales) await reiniciarSecuenciales(filter, commit, log);
  else log('   🔒 Secuenciales del SRI conservados (usa --secuenciales para reiniciarlos).');

  log('\n🔒 Intactos: CRM y marketing completos (chats, contactos, plantillas, automatizaciones,');
  log('   campañas, segmentos y números de WhatsApp), pacientes, citas, fichas clínicas,');
  log('   usuarios, plan de cuentas, catálogos, empleados y el certificado digital.');

  if (!commit) {
    log(`\nDRY-RUN: no se borró nada (${totalDocs} documento(s) en total). Ejecuta con --commit para aplicar.`);
    return { ...stats, totalDocs, dryRun: true };
  }
  log(`\n✅  Contabilidad en cero: ${totalDocs} documento(s) eliminados.`);
  return { ...stats, totalDocs };
}

/**
 * Envoltorio "una sola vez": reclama la marca de forma atómica (el índice `_id` da la
 * exclusión mutua), ejecuta el borrado y deja constancia del resultado.
 */
async function runOnce({ key = TASK_KEY, clinic = null, secuenciales = false, force = false, log = console.log } = {}) {
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
    const result = await wipeAccounting({ clinic, secuenciales, commit: true, log });
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
  const secuenciales = args.includes('--secuenciales');
  const soloEstado = args.includes('--estado');
  const clinic = (args.find((a) => a.startsWith('--clinic=')) || '').split('=')[1] || null;
  const key = (args.find((a) => a.startsWith('--key=')) || '').split('=')[1] || TASK_KEY;

  console.log('\n=== CONTABILIDAD EN CERO (tarea de una sola vez) ===');
  console.log(`Clave de la tarea: ${key}`);
  console.log(clinic ? `Alcance: solo la sucursal ${clinic}` : 'Alcance: TODAS las sucursales');
  console.log(commit ? 'MODO: COMMIT (borra de verdad).' : 'MODO: DRY-RUN (solo cuenta). Usa --commit para aplicar.');

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
      if (previa) console.log(`(Marca existente: ${previa.status}. Con --commit ${previa.status === 'DONE' && !force ? 'NO' : 'SÍ'} se ejecutaría.)`);
      await wipeAccounting({ clinic, secuenciales, commit: false });
      return;
    }
    await runOnce({ key, clinic, secuenciales, force });
  } finally {
    await disconnect();
  }
}

module.exports = { wipeAccounting, runOnce, GRUPOS, TASK_KEY };

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
