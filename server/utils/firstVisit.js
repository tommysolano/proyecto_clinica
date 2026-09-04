/**
 * ¿ES NUEVO ESTE PACIENTE?
 *
 * «Paciente nuevo» no es «paciente recién tecleado». La marca se congela en la
 * cita (`isFirstVisit`) y de ella cuelgan cosas que se pagan: las comisiones de
 * captación (`CommissionRule.patientScope === 'new'`), los reportes de pacientes
 * nuevos, el badge de la agenda y varios workflows de marketing. Marcar como
 * nuevo a un paciente de toda la vida es pagar una captación que no existió.
 *
 * Hasta sep-2026 la pregunta era «¿tiene citas anteriores?», y eso dejaba fuera
 * justo a los que llevaban años viniendo: los que se atendían EN PAPEL. Sus
 * fichas físicas se escanearon y se subieron (ver `importPatientsFromScans` y la
 * carga masiva por Excel), pero como nunca habían pasado por la agenda, la
 * primera cita que se les agendaba los estrenaba como pacientes nuevos.
 *
 * Ahora se busca CUALQUIER rastro de que ya se le hubiera atendido:
 *   1. una cita anterior —de cualquier sucursal: nuevo se es para la clínica,
 *      no para la sede—;
 *   2. una consulta en su historia clínica (ahí caen las fichas escaneadas y las
 *      historias subidas por Excel);
 *   3. una venta a su nombre (los que vinieron de Contífico);
 *   4. la marca del archivo físico (`scanImport`), que vale aunque la ficha
 *      escaneada todavía no haya llegado a convertirse en seguimiento.
 *
 * FUENTE ÚNICA a propósito: la usan las CUATRO vías de agendamiento —mostrador,
 * el chat del call center, la reserva online y la cita que se registra sola en
 * una atención sin cita—. Que cada una contara las citas por su cuenta es como
 * acabaron dando respuestas distintas a la misma pregunta.
 */

/**
 * ¿Hay constancia de que a este paciente ya se le atendió antes?
 *
 * @param {ObjectId|string} patientId
 * @param {object} [opts]
 * @param {number} [opts.ignoraSeguimientos] cuántas consultas de la historia son
 *        de ESTA MISMA atención y por tanto no cuentan como pasado. La atención
 *        sin cita guarda primero el seguimiento y registra la cita después: sin
 *        esto, el paciente que se estrena con una consulta directa se contestaría
 *        a sí mismo que ya tenía historia y no habría manera de que fuera nuevo.
 * @returns {Promise<boolean>}
 */
async function tieneHistorialPrevio(patientId, { ignoraSeguimientos = 0 } = {}) {
  if (!patientId) return false;
  // Se requieren aquí dentro (y no arriba) por la misma razón que en el resto de
  // utilidades del proyecto: evitar ciclos de require entre modelos y utils.
  const Appointment = require('../models/Appointment');
  const ClinicalRecord = require('../models/ClinicalRecord');
  const Sale = require('../models/Sale');
  const Patient = require('../models/Patient');

  // El índice del arreglo va dentro del NOMBRE del campo, así que se sanea a un
  // entero: cualquier otra cosa construiría una ruta que Mongo no entiende.
  const desde = Math.max(0, Math.trunc(Number(ignoraSeguimientos) || 0));

  const [cita, historia, venta, paciente] = await Promise.all([
    Appointment.exists({ patient: patientId }),
    ClinicalRecord.exists({
      patient: patientId,
      [`followUps.${desde}`]: { $exists: true },
    }),
    Sale.exists({ patient: patientId }),
    Patient.findById(patientId).select('scanImport.importadoAt').lean(),
  ]);

  return Boolean(cita || historia || venta || paciente?.scanImport?.importadoAt);
}

/**
 * ¿Esta es su PRIMERA visita? Lo contrario de lo anterior, con nombre propio
 * porque es como se lee en quien llama.
 */
async function esPrimeraVisita(patientId, opts = {}) {
  return !(await tieneHistorialPrevio(patientId, opts));
}

module.exports = { tieneHistorialPrevio, esPrimeraVisita };
