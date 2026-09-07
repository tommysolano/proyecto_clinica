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

/**
 * ¿HAY QUE ESCRIBIR EL SUERO DE SERIE DE ESTE SERVICIO EN ESTA CITA?
 *
 * Es la pregunta de las TRES puertas por las que pasa una cita —agendarla,
 * corregirle el servicio y asignar la atención— y por eso vive aquí y no
 * repetida en cada una: cuando la respuesta se escribía a mano en cada sitio,
 * una de las tres se la contestaba distinto y el paciente acababa con dos bolsas
 * idénticas en su ficha, que se lee como que le recetaron dos sueros.
 *
 * La marca son DOS campos y hacen falta los dos:
 *   `autoSerumFollowUp`     → ya se escribió una;
 *   `autoSerumServiceItem`  → la de ESTE servicio.
 * Con solo el primero no se distingue «volvió a poner el mismo servicio» (no se
 * escribe nada) de «lo cambió por otro» (hay que escribir la bolsa nueva).
 *
 * OJO con las citas ANTERIORES a `autoSerumServiceItem`: traen la marca pero no
 * el servicio. Ahí se da la marca por buena en vez de suponer que es otro
 * servicio, que las duplicaría todas de una vez.
 */
function faltaElSueroDelServicio(apt, serviceItem) {
  if (!serviceItem?.autoSerum?.enabled) return false;
  if (!apt?.autoSerumFollowUp) return true;
  if (!apt.autoSerumServiceItem) return false;
  return String(apt.autoSerumServiceItem) !== String(serviceItem._id || serviceItem);
}

/**
 * SUMA AMPOLLAS A LA BOLSA QUE YA ESCRIBIÓ EL SERVICIO, en vez de abrir otra.
 *
 * El servicio con suero de serie («Detox Plus») escribe su receta al agendar. Si
 * mostrador, al repartir la atención, escoge además unas ampollas para el paso de
 * enfermería, hasta ahora eso abría una SEGUNDA receta — con el mismo nombre, el
 * del servicio, así que en la ficha aparecían dos «Detox Plus» con ampollas
 * distintas y parecía que se le habían recetado dos sueros. Es lo que pasó de
 * verdad (Andrés Ramos, 7-sep-2026): una bolsa con DETOX PLUS y otra con BERBERIS.
 *
 * Es UNA bolsa: la del servicio, con lo que mostrador le añada. Aquí se reescribe
 * su composición.
 *
 * NO se toca si ya tiene una aplicación registrada: eso movió inventario y es lo
 * que de verdad se le puso al paciente; reescribirlo sería falsear la historia.
 * Devuelve true si se pudo sumar.
 */
async function sumarSueroAlSeguimiento({ patientId, followUpId, linea }) {
  if (!patientId || !followUpId || !linea) return false;
  const record = await ClinicalRecord.findOne({ patient: patientId });
  const fu = record?.followUps?.id(followUpId);
  if (!fu) return false;

  const item = (fu.recetaItems || []).find((i) => i.isSerum);
  if (!item) return false;
  if ((item.administrations || []).length) return false; // ya aplicado: no se reescribe

  // Solo la COMPOSICIÓN. El nombre se conserva: sigue siendo el suero del
  // servicio, y es como lo reconocen la ficha, los PDF y la hoja del MSP.
  item.serumBase = linea.serumBase;
  item.serumComponents = linea.serumComponents;
  await record.save();
  return true;
}

module.exports = {
  sueroterapiaDeLaCita,
  sembrarSueroEnFicha,
  faltaElSueroDelServicio,
  sumarSueroAlSeguimiento,
};
