const ClinicalRecord = require('../models/ClinicalRecord');
const { saneaSueroPlano, lineaDeRecetaDeSuero } = require('./suero');

/**
 * EL SUERO QUE SE INDICA AL AGENDAR, ESCRITO EN LOS SEGUIMIENTOS.
 *
 * Enfermería no lee la cita: lee la ficha. Lo que puede dar por aplicado —y lo
 * que descuenta la ampolla del inventario— es una línea de receta con `isSerum`,
 * y hasta ahora esa línea la tenía que escribir alguien a mano en la ficha del
 * paciente, cita por cita. Con los servicios que SIEMPRE llevan el mismo suero
 * (Detox Plus) eso era copiar y pegar veintitrés veces al mes.
 *
 * Así que el suero se escribe solo, y entra por dos puertas que acaban aquí:
 *  · el SERVICIO trae el suyo de serie (`AppointmentServiceItem.autoSerum`);
 *  · quien agenda lo indica a mano en el formulario de la cita (`serum`).
 *
 * Es un seguimiento normal, de los que enfermería ya sabe leer: no hay un
 * segundo camino ni un tipo nuevo de entrada. Lo único que lo distingue es
 * `createdByRole` —quien agendó— y el motivo, que dice de dónde salió.
 */

/**
 * El suero DE SERIE del servicio, ya saneado y como línea de receta.
 *
 * Solo el del servicio: el que escoge una persona a mano cuelga de SU paso de
 * enfermería (`Appointment.turns[].serum`), porque es ahí donde se pone y es lo
 * que permite tener dos pasos con dos preparaciones distintas en la misma cita.
 *
 * @param {object} serviceItem  el servicio de agenda (documento o lean), o null
 * @returns {Array} líneas de receta listas para guardar (vacío si no trae suero)
 */
function sueroterapiaDeLaCita(serviceItem) {
  if (!serviceItem?.autoSerum?.enabled) return [];
  const limpio = saneaSueroPlano(serviceItem.autoSerum);
  return limpio ? [lineaDeRecetaDeSuero(limpio, serviceItem.name)] : [];
}

/**
 * Escribe las líneas en la ficha del paciente como un seguimiento nuevo.
 *
 * La ficha es ÚNICA por paciente y no se filtra por sucursal (una cita en
 * Extensión escribe en la misma historia que las de Central); si el paciente
 * todavía no tiene, se crea aquí — un paciente recién registrado al que se le
 * agenda un detox no puede quedarse sin el suero porque nadie haya abierto su
 * ficha.
 *
 * @returns {object|null} el seguimiento creado, o null si no había nada que escribir
 */
async function sembrarSueroEnFicha({ clinicId, patientId, user, role, lineas, motivo }) {
  if (!lineas?.length) return null;

  const seguimiento = {
    fecha: new Date(),
    descripcion: motivo,
    motivoConsulta: motivo,
    recetaItems: lineas,
    kind: '',
    createdBy: user._id,
    // Con qué sombrero se escribió, igual que en `addFollowUp`: quien agenda no
    // es quien atiende, y la ficha tiene que poder decirlo.
    createdByRole: role || '',
  };

  const record = await ClinicalRecord.findOneAndUpdate(
    { patient: patientId },
    {
      $push: { followUps: seguimiento },
      $setOnInsert: { clinic: clinicId, patient: patientId, createdBy: user._id },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  return (record?.followUps || []).slice(-1)[0] || null;
}

module.exports = { sueroterapiaDeLaCita, sembrarSueroEnFicha };
