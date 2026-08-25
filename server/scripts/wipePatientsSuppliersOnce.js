#!/usr/bin/env node
/**
 * ARRANQUE DESDE CERO: PACIENTES + TERCEROS + CONTABILIDAD — TAREA DE UNA SOLA VEZ.
 *
 * Deja el sistema sin datos de clientes ni contabilidad para empezar a operar de
 * verdad, SIN tocar nada de Marketing / CRM ni del escáner de documentos.
 *
 * A diferencia de `wipeAccountingOnce.js` —que a propósito conserva pacientes,
 * proveedores y catálogos—, este borra también esas tres cosas. Por eso es un
 * archivo aparte con su propia marca: aquel script tiene un test que exige que el
 * paciente y el proveedor SOBREVIVAN, y los dos comportamientos son legítimos.
 *
 * ─── SE BORRA ──────────────────────────────────────────────────────────────────
 *   Pacientes    Patient y todo lo que cuelga: fichas clínicas con sus seguimientos,
 *                citas, planes de tratamiento y derivaciones.
 *   Terceros     Supplier COMPLETO. Ojo: esa colección es el padrón de terceros
 *                (roles CLIENTE, PROVEEDOR, EMPLEADO y VENDEDOR); la pantalla se
 *                titula "Personas". Se vacía entera, así que el buscador de
 *                clientes de Nueva Venta queda también sin datos.
 *   Contable     Todo el movimiento (lo hace `wipeAccounting`, reutilizado tal cual):
 *                ventas, compras, cobros y pagos, caja, bancos, inventario, activos,
 *                comisiones, nómina, asientos, SRI y gerencial.
 *   Catálogos    Plan de cuentas, configuración contable, centros de costo, productos,
 *                categorías de inventario y de servicios, bodegas, cuentas bancarias,
 *                tarjetas, reglas de retención, descuentos, reglas de comisión y los
 *                catálogos de nómina (departamentos, cargos, conceptos, tablas de IR).
 *   Reglas       Cuentas de gasto frecuente por proveedor y reglas de flujo de caja:
 *                apuntan a proveedores/pacientes y sin ellos quedarían señalando al
 *                vacío, llenando Flujo de Caja de filas "—" imposibles de identificar.
 *   SRI          Los secuenciales vuelven a 1 (ver la advertencia de más abajo).
 *
 * ─── SE DESVINCULA (el documento NO se borra: es de Marketing / CRM) ───────────
 *   Conversaciones, contactos, inscripciones de automatización, registro de
 *   disparadores, tareas de agente, llamadas, solicitudes de reseña, mensajes
 *   programados y envíos de correo: se les pone `patient` a null.
 *
 *   POR QUÉ ES IMPRESCINDIBLE y no basta con "ya se verá": la lista de chats NO
 *   popula el paciente (va proyectada por rendimiento), así que un id que apunta a
 *   un paciente borrado sigue pareciendo válido en la bandeja y sale null en el
 *   detalle. Con eso, el chat anuncia "Paciente vinculado" y ofrece "Crear cita"
 *   sobre alguien que no existe; y lo más grave: cuando el contacto escribe BAJA,
 *   `applyIncomingOptOut` busca por ese id, no encuentra al paciente, no cae al
 *   camino alternativo y le responde "Hemos registrado tu baja" sin registrar
 *   nada. Además la ingesta solo re-vincula si el campo está VACÍO, así que un id
 *   fantasma no se cura nunca solo. Dejarlo en null es lo único que permite que el
 *   sistema se recupere por sí mismo.
 *
 *   Las inscripciones y los mensajes programados que estuvieran en cola se cancelan:
 *   si no, el motor de envíos volvería a escribir el id fantasma en la conversación.
 *
 * ─── NO SE TOCA ────────────────────────────────────────────────────────────────
 *   · ESCÁNER (/scanner, grupo Herramientas): ni la colección `scanneddocuments` ni
 *     los PDF de `server/storage/scans`. Este script NO ESCRIBE EN DISCO EN ABSOLUTO.
 *   · MARKETING / CRM completo: conversaciones, mensajes, contactos, oportunidades,
 *     plantillas, mensajes guardados, automatizaciones, campañas, segmentos, números
 *     de WhatsApp, papelera. Solo se les quita el enlace al paciente.
 *   · Usuarios, sucursales, consultorios, horarios y bloqueos de acceso.
 *   · EMPLEADOS (`Employee`): son el personal de la clínica, no datos de clientes.
 *   · Certificado digital (.p12) y el resto de la configuración de facturación.
 *   · Registro de auditoría (AuditLog): es la constancia de lo que se hizo.
 *
 * ─── DOS CONSECUENCIAS QUE HAY QUE SABER ANTES DE APRETAR EL GATILLO ───────────
 *   1. Sin plan de cuentas ni categorías NO se puede facturar ni vender hasta
 *      reconfigurarlo: en este sistema las cuentas salen siempre de la categoría y
 *      no hay respaldo por código fijo. Esto es un arranque desde cero.
 *   2. Reiniciar los secuenciales del SRI solo es seguro en ambiente de PRUEBAS. En
 *      producción el SRI ya tiene registrados esos números y rechazará las próximas
 *      facturas por número repetido. El script AVISA si detecta ambiente 2.
 *   3. Marketing seguirá funcionando, pero sus informes que cruzan pacientes
 *      (segmentos por tratamiento, atribución, embudo por paciente) saldrán en cero
 *      hasta que haya pacientes nuevos. No se borra ni un documento de marketing.
 *
 * ─── "UNA SOLA VEZ" ────────────────────────────────────────────────────────────
 * La marca vive en la base (colección `onetimetasks`, clave TASK_KEY). El despliegue
 * puede invocarlo en cada push: solo el PRIMERO hace algo. Si falla a medias queda
 * FAILED y el siguiente despliegue lo reintenta; una vez DONE no corre nunca más.
 *
 * ⚠️  MIENTRAS LA LÍNEA DE `deploy.sh` SIGA COMENTADA, ESTE SCRIPT NO SE EJECUTA EN
 *     NINGÚN DESPLIEGUE. Para activarlo hay que descomentarla y hacer push.
 *
 * ─── USO ───────────────────────────────────────────────────────────────────────
 *   node scripts/wipePatientsSuppliersOnce.js                 (DRY-RUN: solo cuenta)
 *   node scripts/wipePatientsSuppliersOnce.js --commit        (BORRA una vez)
 *   node scripts/wipePatientsSuppliersOnce.js --commit --clinic=<id>   (solo esa sede)
 *   node scripts/wipePatientsSuppliersOnce.js --commit --force  (repite aunque esté hecha)
 *   node scripts/wipePatientsSuppliersOnce.js --estado        (solo muestra el estado)
 *
 * Requiere MONGODB_URI en el entorno (server/.env) y se ejecuta desde `server/`.
 */
const os = require('os');
const { connect, disconnect, mongoose } = require('./_common');

const OneTimeTask = require('../models/OneTimeTask');
const { wipeAccounting } = require('./wipeAccountingOnce');

// ─── Pacientes y lo que cuelga de ellos ──────────────────────────────────────
const Patient = require('../models/Patient');
const ClinicalRecord = require('../models/ClinicalRecord');
const PatientObservation = require('../models/PatientObservation');
const Appointment = require('../models/Appointment');
const Treatment = require('../models/Treatment');
const Referral = require('../models/Referral');
// ─── Terceros ────────────────────────────────────────────────────────────────
const Supplier = require('../models/Supplier');
// ─── Catálogos contables ─────────────────────────────────────────────────────
const ChartOfAccount = require('../models/ChartOfAccount');
const AccountingConfig = require('../models/AccountingConfig');
const CostCenter = require('../models/CostCenter');
const Product = require('../models/Product');
const InventoryCategory = require('../models/InventoryCategory');
const ServiceCategory = require('../models/ServiceCategory');
const Warehouse = require('../models/Warehouse');
const BankAccount = require('../models/BankAccount');
const CreditCard = require('../models/CreditCard');
const RetentionRule = require('../models/RetentionRule');
const Discount = require('../models/Discount');
const CommissionRule = require('../models/CommissionRule');
const PayrollConfig = require('../models/PayrollConfig');
const PayrollDepartment = require('../models/PayrollDepartment');
const PayrollPosition = require('../models/PayrollPosition');
const PayrollConcept = require('../models/PayrollConcept');
const PayrollIncomeTaxTable = require('../models/PayrollIncomeTaxTable');
// ─── Reglas que apuntan a terceros ───────────────────────────────────────────
const RecurringAccount = require('../models/RecurringAccount');
const CashFlowMapping = require('../models/CashFlowMapping');
const CashFlowConfig = require('../models/CashFlowConfig');
// ─── CRM: NO se borra, solo se desvincula ────────────────────────────────────
const Conversation = require('../models/Conversation');
const Contact = require('../models/Contact');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');
const WorkflowTriggerEvent = require('../models/WorkflowTriggerEvent');
const AgentTask = require('../models/AgentTask');
const Call = require('../models/Call');
const ReviewRequest = require('../models/ReviewRequest');
const ScheduledMessage = require('../models/ScheduledMessage');
const EmailSend = require('../models/EmailSend');

/**
 * Clave de la tarea. Es lo que hace que se ejecute UNA sola vez: mientras no cambie,
 * cualquier despliegue posterior encuentra la marca DONE y no borra nada.
 */
const TASK_KEY = 'borrar-pacientes-terceros-contabilidad-2026-08-15';

/** Un proceso que lleva más de esto en RUNNING se da por muerto y se puede reintentar. */
const STALE_RUNNING_MS = 30 * 60 * 1000;

/** Qué se borra, agrupado como lo ve el usuario. `[etiqueta, Modelo, filtroExtra?]`. */
const GRUPOS = [
  ['Pacientes', [
    ['Pacientes (Patient)', Patient],
    ['Fichas clínicas y seguimientos (ClinicalRecord)', ClinicalRecord],
    ['Observaciones del paciente (PatientObservation)', PatientObservation],
    ['Citas (Appointment)', Appointment],
    ['Planes de tratamiento (Treatment)', Treatment],
    ['Derivaciones (Referral)', Referral],
  ]],
  ['Terceros', [
    ['Personas: clientes, proveedores, empleados y vendedores (Supplier)', Supplier],
  ]],
  ['Catálogos contables', [
    ['Plan de cuentas (ChartOfAccount)', ChartOfAccount],
    ['Configuración contable (AccountingConfig)', AccountingConfig],
    ['Centros de costo (CostCenter)', CostCenter],
    ['Productos y servicios (Product)', Product],
    ['Categorías de inventario (InventoryCategory)', InventoryCategory],
    ['Categorías de servicio (ServiceCategory)', ServiceCategory],
    ['Bodegas (Warehouse)', Warehouse],
    ['Cuentas bancarias (BankAccount)', BankAccount],
    ['Tarjetas (CreditCard)', CreditCard],
    ['Reglas de retención (RetentionRule)', RetentionRule],
    ['Descuentos (Discount)', Discount],
    ['Reglas de comisión (CommissionRule)', CommissionRule],
  ]],
  ['Catálogos de nómina', [
    ['Configuración de nómina (PayrollConfig)', PayrollConfig],
    ['Departamentos (PayrollDepartment)', PayrollDepartment],
    ['Cargos (PayrollPosition)', PayrollPosition],
    ['Conceptos (PayrollConcept)', PayrollConcept],
    ['Tablas de impuesto a la renta (PayrollIncomeTaxTable)', PayrollIncomeTaxTable],
  ]],
  ['Reglas ligadas a terceros', [
    ['Cuentas de gasto frecuente por proveedor (RecurringAccount)', RecurringAccount],
    ['Reglas de flujo de caja (CashFlowMapping)', CashFlowMapping],
    ['Configuración de flujo de caja (CashFlowConfig)', CashFlowConfig],
  ]],
];

/**
 * Documentos de Marketing / CRM que apuntan al paciente. NO se borran: se les quita
 * el enlace. `[etiqueta, Modelo, patch]`.
 */
const DESVINCULAR = [
  ['Contactos (Contact)', Contact, { patient: null, convertedAt: null }],
  ['Inscripciones de automatización (WorkflowEnrollment)', WorkflowEnrollment, { patient: null }],
  ['Registro de disparadores (WorkflowTriggerEvent)', WorkflowTriggerEvent, { patient: null }],
  ['Tareas de agente (AgentTask)', AgentTask, { patient: null }],
  ['Llamadas (Call)', Call, { patient: null }],
  ['Solicitudes de reseña (ReviewRequest)', ReviewRequest, { patient: null }],
  ['Mensajes programados (ScheduledMessage)', ScheduledMessage, { patient: null }],
  ['Envíos de correo (EmailSend)', EmailSend, { patient: null }],
];

/**
 * Quita de los chats el enlace al paciente y a las citas borradas.
 *
 * Va aparte del resto porque toca tres campos distintos y porque es el punto que de
 * verdad protege al call center: sin esto la bandeja seguiría diciendo "Paciente
 * vinculado" sobre pacientes que ya no existen (ver la cabecera del archivo).
 */
async function desvincularChats(filter, commit, log) {
  const conPaciente = await Conversation.countDocuments({ ...filter, patient: { $ne: null } });
  const conCita = await Conversation.countDocuments({
    ...filter,
    $or: [{ 'opportunity.appointment': { $ne: null } }, { 'opportunities.appointment': { $ne: null } }],
  });
  if (!commit) {
    log(`   • Conversaciones a desvincular del paciente: ${conPaciente}`);
    log(`   • Conversaciones con cita en su oportunidad: ${conCita}`);
    return conPaciente + conCita;
  }
  await Conversation.updateMany({ ...filter, patient: { $ne: null } }, { $set: { patient: null } });
  await Conversation.updateMany(
    { ...filter, 'opportunity.appointment': { $ne: null } },
    { $set: { 'opportunity.appointment': null } },
  );
  // El array necesita el operador posicional para todas sus posiciones.
  await Conversation.updateMany(
    { ...filter, 'opportunities.appointment': { $ne: null } },
    { $set: { 'opportunities.$[].appointment': null } },
  );
  log(`   🔗 Conversaciones desvinculadas: ${conPaciente} del paciente, ${conCita} de su cita. El chat, sus mensajes y su oportunidad NO se tocan.`);
  return conPaciente + conCita;
}

/**
 * Cancela lo que estuviera EN COLA apuntando a un paciente. Si se dejara vivo, el
 * motor de envíos volvería a escribir el id del paciente borrado dentro de la
 * conversación, deshaciendo la desvinculación de arriba.
 */
async function cancelarEnCola(filter, commit, log) {
  const inscripciones = await WorkflowEnrollment.countDocuments({ ...filter, status: 'active', patient: { $ne: null } });
  const programados = await ScheduledMessage.countDocuments({ ...filter, status: 'queued', patient: { $ne: null } });
  if (!commit) {
    log(`   • Inscripciones activas de pacientes: ${inscripciones} se cancelarían.`);
    log(`   • Mensajes programados en cola: ${programados} se cancelarían.`);
    return inscripciones + programados;
  }
  await WorkflowEnrollment.updateMany(
    { ...filter, status: 'active', patient: { $ne: null } },
    { $set: { status: 'cancelled' } },
  );
  await ScheduledMessage.updateMany(
    { ...filter, status: 'queued', patient: { $ne: null } },
    { $set: { status: 'cancelled' } },
  );
  log(`   ⏹️  Canceladas ${inscripciones} inscripción(es) y ${programados} mensaje(s) en cola de pacientes borrados.`);
  return inscripciones + programados;
}

/** Desvincula (no borra) los documentos de CRM que apuntaban al paciente. */
async function desvincularCrm(filter, commit, log) {
  let total = 0;
  for (const [label, Model, patch] of DESVINCULAR) {
    const n = await Model.countDocuments({ ...filter, patient: { $ne: null } });
    total += n;
    if (!commit) { log(`   • ${label}: ${n} a desvincular.`); continue; }
    if (n) await Model.updateMany({ ...filter, patient: { $ne: null } }, { $set: patch });
    log(`   🔗 ${label}: ${n} desvinculado(s). El documento se conserva.`);
  }
  return total;
}

/**
 * Cuenta los adjuntos de ficha clínica que quedarán huérfanos en disco.
 *
 * NO los borra: este script no escribe en disco a propósito, porque en el mismo
 * árbol `server/storage` viven los PDF del escáner, la media del chat y el
 * certificado digital, y un borrado equivocado ahí no tiene vuelta atrás. Se informa
 * para que se limpien a mano si se quiere.
 */
async function contarAdjuntosHuerfanos(filter, log) {
  const conAdjuntos = await ClinicalRecord.aggregate([
    { $match: filter },
    { $project: { n: { $size: { $ifNull: ['$followUps.attachments', []] } } } },
    { $group: { _id: null, total: { $sum: '$n' } } },
  ]);
  const total = conAdjuntos[0]?.total || 0;
  if (total) {
    log(`   📎 ${total} adjunto(s) de ficha clínica quedarán huérfanos en server/storage/followups.`);
    log('      El script NO toca el disco (ahí también viven los PDF del escáner): bórralos a mano si quieres.');
  }
  return total;
}

/** Borra pacientes, terceros y contabilidad. Con `commit: false` no escribe nada. */
async function wipeAll({ clinic = null, commit = false, log = console.log } = {}) {
  const filter = clinic ? { clinic: new mongoose.Types.ObjectId(String(clinic)) } : {};
  const stats = {};
  let totalDocs = 0;

  // 1) Primero lo CONTABLE, reutilizando el script ya probado. Va antes que los
  //    terceros para que sus documentos (compras, retenciones) desaparezcan con el
  //    proveedor todavía vivo y el informe salga cuadrado.
  log('\n════ CONTABILIDAD (movimiento) ════');
  const contable = await wipeAccounting({ clinic, commit, secuenciales: true, log });
  totalDocs += contable.totalDocs || 0;

  // 2) Pacientes, terceros y catálogos.
  for (const [grupo, entradas] of GRUPOS) {
    log(`\n════ ${grupo.toUpperCase()} ════`);
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

  // 3) CRM: se conserva entero, solo se le quita el enlace al paciente.
  log('\n════ MARKETING / CRM: NO SE BORRA, SOLO SE DESVINCULA ════');
  await desvincularChats(filter, commit, log);
  await desvincularCrm(filter, commit, log);
  await cancelarEnCola(filter, commit, log);

  log('\n════ AVISOS ════');
  await contarAdjuntosHuerfanos(filter, log);
  log('   🔒 Escáner INTACTO: ni la colección de documentos escaneados ni server/storage/scans.');
  log('   🔒 Intactos también: usuarios, sucursales, consultorios, empleados, certificado digital y auditoría.');
  log('   ℹ️  Sin plan de cuentas ni categorías no se puede facturar hasta reconfigurarlo.');
  log('   ℹ️  Los informes de marketing que cruzan pacientes saldrán en cero hasta que haya pacientes nuevos.');

  if (!commit) {
    log(`\nDRY-RUN: no se borró nada (${totalDocs} documento(s) en total). Ejecuta con --commit para aplicar.`);
    return { ...stats, totalDocs, dryRun: true };
  }
  log(`\n✅  Sistema en cero: ${totalDocs} documento(s) eliminados.`);
  return { ...stats, totalDocs };
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
    const result = await wipeAll({ clinic, commit: true, log });
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

  console.log('\n=== PACIENTES + TERCEROS + CONTABILIDAD EN CERO (tarea de una sola vez) ===');
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
      await wipeAll({ clinic, commit: false });
      return;
    }
    await runOnce({ key, clinic, force });
  } finally {
    await disconnect();
  }
}

module.exports = { wipeAll, runOnce, GRUPOS, DESVINCULAR, TASK_KEY };

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
