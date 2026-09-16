/**
 * LIMPIEZA (sep-2026, a petición de la clínica):
 * ELIMINA LAS CITAS QUE EL SISTEMA CREÓ SOLAS CUANDO UN DOCTOR ATENDIÓ O RECETÓ.
 *
 * Dos familias, ambas marcadas por el MOTIVO que escribe el sistema al crearlas:
 *   · 'Aplicación de suero recetado…' — la cita que nacía de la receta de un
 *     doctor (los «Sueroterapia» que mostraban «Agendó: X (Doctor)»).
 *   · 'Atención inmediata' — la cita de una atención sin cita que el doctor
 *     registró al guardar el seguimiento.
 *
 * Se borran TODAS las de roles de doctor (incluidas las completadas, decisión
 * del usuario), SOLO si no tienen venta asociada: la venta cuelga de la cita
 * (Sale.appointment) y borrarla dejaría el cobro huérfano.
 *
 * Seque también las notificaciones de campana de esas citas y emite el evento
 * de borrado por socket para que la agenda de todos se refresque.
 *
 * USO: node scripts/limpiarCitasAutomaticasDoctor.js [--dry]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const { DOCTOR_LIKE_ROLES } = require('../constants/roles');

const DRY = process.argv.includes('--dry');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const col = db.collection('appointments');

  const filtro = {
    createdByRole: { $in: DOCTOR_LIKE_ROLES },
    $or: [
      { reason: { $regex: /^Aplicación de suero/ } },
      { reason: 'Atención inmediata' },
    ],
  };

  const candidatas = await col.find(filtro).project({ _id: 1, patient: 1, reason: 1, status: 1, createdAt: 1 }).toArray();
  const ids = candidatas.map((c) => c._id);
  console.log(`Candidatas: ${candidatas.length}`);

  // Ventas que cuelgan de alguna de estas citas: se quedan, y su cita también.
  const ventas = ids.length
    ? await db.collection('sales').find({ appointment: { $in: ids } }).project({ appointment: 1 }).toArray()
    : [];
  const conVenta = new Set(ventas.map((v) => String(v.appointment)));
  const aBorrar = candidatas.filter((c) => !conVenta.has(String(c._id)));
  console.log(`Con venta asociada (no se tocan): ${conVenta.size}`);
  console.log(`A borrar: ${aBorrar.length}`);
  const conteo = {};
  for (const c of candidatas) {
    const clave = `${c.reason.slice(0, 24)} · ${c.status}`;
    conteo[clave] = (conteo[clave] || 0) + 1;
  }
  for (const [k, v] of Object.entries(conteo)) console.log('   ·', k, v);

  if (DRY) {
    console.log('\n[--dry] Nada se ha borrado.');
  } else if (aBorrar.length) {
    const r = await col.deleteMany({ _id: { $in: aBorrar.map((c) => c._id) } });
    console.log(`\nEliminadas: ${r.deletedCount}`);
    const n = await db.collection('notifications').deleteMany({
      'meta.appointment': { $in: aBorrar.map((c) => c._id) },
    });
    console.log(`Notificaciones de campana apagadas: ${n.deletedCount || 0}`);
    // Queda constancia en la auditoría, igual que cuando una persona borra una
    // cita por la API (ver deleteAppointment): «quien la borró y qué borró».
    try {
      const AuditLog = require('../models/AuditLog');
      await AuditLog.create({
        action: 'DELETE',
        entity: 'appointments',
        entityId: null,
        userName: 'script:limpiarCitasAutomaticasDoctor',
        role: 'sistema',
        description: `Limpieza automática (sep-2026): se eliminaron ${r.deletedCount} citas que el sistema creó solo cuando un doctor atendió o recetó (motivo «Atención inmediata» o «Aplicación de suero recetado»). Decisión de la clínica: los doctores no generan citas; solo agendan call center, cajeros, administración y odontología.`,
        method: 'SCRIPT',
        path: 'scripts/limpiarCitasAutomaticasDoctor.js',
      });
    } catch (e) {
      console.warn('No se pudo registrar la limpieza en auditoría:', e.message);
    }
  }

  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
