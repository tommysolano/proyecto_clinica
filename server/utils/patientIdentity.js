/**
 * Una identificación absorbida en una fusión sigue identificando al mismo
 * paciente. Centralizar este filtro evita que una reserva o importación hecha
 * con el RUC antiguo vuelva a crear la ficha duplicada que acabamos de cerrar.
 */
function patientIdentificationFilter(value) {
  const identification = String(value || '').trim();
  return {
    $or: [
      { cedula: identification },
      { identificationAliases: identification },
    ],
  };
}

/** Las 9 últimas cifras: '0988535561' y '+593 98 853 5561' son el mismo número. */
const colaTelefono = (value) => String(value || '').replace(/\D/g, '').slice(-9);

/**
 * EL PACIENTE DE ESTE TELÉFONO, mirando también sus OTROS números (sep-2026).
 *
 * Un paciente cambia de celular y escribe desde el nuevo. Si el nuevo solo se
 * buscaba en `phone`/`whatsapp`, el chat nunca lo reconocía y el call center
 * acababa abriéndole una ficha nueva. Ahora el número que se le asigna a mano
 * desde el chat va a `otherPhones` y se encuentra igual.
 *
 * El principal manda: si un número es el principal de uno y el «otro» de un
 * segundo, es del primero.
 */
async function findPatientByAnyPhone(phone, { extra = {} } = {}) {
  const cola = colaTelefono(phone);
  if (cola.length < 7) return null;
  const Patient = require('../models/Patient');
  const re = { $regex: `${cola}$` };
  return (await Patient.findOne({ ...extra, $or: [{ phone: re }, { whatsapp: re }] }))
    || Patient.findOne({ ...extra, otherPhones: re });
}

/** Lo mismo con el correo: el principal primero, después los de más. */
async function findPatientByAnyEmail(email) {
  const correo = String(email || '').trim().toLowerCase();
  if (!correo) return null;
  const Patient = require('../models/Patient');
  return (await Patient.findOne({ email: correo })) || Patient.findOne({ otherEmails: correo });
}

module.exports = {
  patientIdentificationFilter,
  colaTelefono,
  findPatientByAnyPhone,
  findPatientByAnyEmail,
};
