/**
 * A NOMBRE DE QUIÉN QUEDA UNA CITA («agendada por»).
 *
 * Lo normal es que la agende quien la escribe, y eso es lo que se ha guardado
 * siempre: `createdBy` + su nombre y su rol de sello. Pero en el call center pasa
 * a diario que una asesora cierra la cita por teléfono y la escribe OTRA —
 * porque la primera está en llamada, porque el turno cambió a media
 * conversación, o porque una atiende y otra digita—. Sin poder decirlo, la cita
 * se apuntaba a quien tecleó, y con ella el reporte de citas por asesor y el
 * panel de supervisión, que es justo por lo que se mira ese dato.
 *
 * Por eso `bookedBy` es OPCIONAL y solo cambia a quién se le acredita:
 *   · `createdBy` / `createdByName` / `createdByRole` → la persona acreditada,
 *     que es lo que leen los reportes, las comisiones y la pantalla;
 *   · `registeredBy` / `registeredByName` → quien de verdad lo escribió.
 *
 * Los dos hacen falta: acreditar sin dejar rastro de quién digitó convertiría
 * este campo en una forma silenciosa de firmar por otro.
 */
const User = require('../models/User');

/** Roles que agendan (y a los que, por tanto, se le puede acreditar una cita). */
const ROLES_QUE_AGENDAN = ['call_center', 'admin', 'cajero'];

/**
 * Resuelve la atribución de la cita.
 *
 * @param {object} req petición (para el usuario y su rol)
 * @param {string} bookedById id del usuario al que se le acredita (opcional)
 * @returns {Promise<{ok: true, fields: object} | {ok: false, status: number, message: string}>}
 */
async function resolverAgendadoPor(req, bookedById) {
  // Lo de siempre: la agenda quien la escribe.
  const propio = {
    createdBy: req.user._id,
    createdByName: req.user.name || '',
    createdByRole: req.role || null,
    registeredBy: null,
    registeredByName: '',
  };
  const id = String(bookedById || '').trim();
  if (!id || id === String(req.user._id)) return { ok: true, fields: propio };

  // Acreditar a otro es cosa de quien agenda; a quien atiende no se le ofrece
  // siquiera (ver el selector «Agendada por» en el cliente).
  if (!req.user.isSuperAdmin && !ROLES_QUE_AGENDAN.includes(req.role)) {
    return { ok: false, status: 403, message: 'No puedes agendar a nombre de otra persona.' };
  }

  const otro = await User.findOne({ _id: id, active: true }).select('name clinics worksInAllClinics isSuperAdmin');
  if (!otro) return { ok: false, status: 400, message: 'La persona que agenda no existe o está inactiva.' };

  // Su rol en la sede de la cita; si no trabaja ahí, el de su primera
  // asignación — el dato es «quién agendó», no «dónde atiende».
  const rol = otro.getRoleForClinic(req.clinicId) || otro.clinics?.[0]?.role || null;
  if (!otro.isSuperAdmin && !ROLES_QUE_AGENDAN.includes(rol)) {
    return { ok: false, status: 400, message: 'Esa persona no agenda citas: elige a alguien de call center, caja o administración.' };
  }

  return {
    ok: true,
    fields: {
      createdBy: otro._id,
      createdByName: otro.name || '',
      createdByRole: rol,
      // Quién lo escribió de verdad. Sin esto, acreditar a otro sería firmar por él.
      registeredBy: req.user._id,
      registeredByName: req.user.name || '',
    },
  };
}

module.exports = { resolverAgendadoPor, ROLES_QUE_AGENDAN };
