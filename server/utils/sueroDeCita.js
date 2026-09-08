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
 * REESCRIBE EL SUERO QUE YA ESTABA ESCRITO EN LA FICHA.
 *
 * Es la vuelta atrás que faltaba. Quien agenda escoge las ampollas y al guardar
 * se escriben como receta en la ficha; si se equivocó —la ampolla que no era, el
 * volumen que no era— la cita ya solo decía «suero ya escrito en los
 * seguimientos» y no había forma de corregirlo desde ahí: había que abrir la
 * ficha del paciente y arreglarlo a mano, o dejarlo mal.
 *
 * NO SE TOCA LO QUE YA SE PUSO. Con una aplicación registrada, ese suero movió
 * inventario y es lo que de verdad le entró al paciente por la vena: reescribirlo
 * sería falsear la historia clínica. Se dice que no y se explica por qué.
 *
 * @returns {'reescrito'|'aplicado'|'sin-receta'}
 */
async function reescribirSueroDelSeguimiento({ patientId, followUpId, linea, conservarNombre = false }) {
  if (!patientId || !followUpId || !linea) return 'sin-receta';
  const record = await ClinicalRecord.findOne({ patient: patientId });
  const fu = record?.followUps?.id(followUpId);
  if (!fu) return 'sin-receta';

  const item = (fu.recetaItems || []).find((i) => i.isSerum);
  if (!item) return 'sin-receta';
  if ((item.administrations || []).length) return 'aplicado';

  item.serumBase = linea.serumBase;
  item.serumComponents = linea.serumComponents;
  // El nombre SÍ cambia cuando el suero es del paso (lo puede haber renombrado
  // el rótulo). El de la bolsa del SERVICIO no: sigue siendo su suero, y es como
  // lo reconocen la ficha, los PDF y la hoja del MSP.
  if (!conservarNombre && linea.name) item.name = linea.name;
  await record.save();
  return 'reescrito';
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
 * Es UNA bolsa: la del servicio, con lo que mostrador le añada.
 */
async function sumarSueroAlSeguimiento({ patientId, followUpId, linea }) {
  const r = await reescribirSueroDelSeguimiento({
    patientId, followUpId, linea, conservarNombre: true,
  });
  return r === 'reescrito';
}

/**
 * Campos que trae de fábrica un seguimiento SEMBRADO por el suero. Cualquier
 * otra cosa escrita ahí la puso una persona, y entonces el seguimiento ya no es
 * solo del suero.
 */
const CAMPOS_DEL_SEMBRADO = new Set([
  '_id', 'fecha', 'kind', 'descripcion', 'motivoConsulta', 'recetaItems',
  'createdBy', 'createdByRole', 'createdAt', 'updatedAt', 'tipoConsulta',
]);

/**
 * ¿Está en blanco? RECURSIVO, y esa es la gracia: los subdocumentos de
 * especialidad (ginecología, odontología, podología…) vienen de fábrica llenos
 * de sub-objetos y arrays vacíos, así que mirando un solo nivel TODOS parecían
 * escritos y no se borraba nunca un seguimiento. El 0 cuenta como blanco: es el
 * valor por defecto de los numéricos, no algo que alguien haya escrito.
 */
function enBlanco(v) {
  if (v === null || v === undefined || v === '' || v === false || v === 0) return true;
  if (v instanceof Date) return false;
  if (Array.isArray(v)) return v.every(enBlanco);
  if (typeof v === 'object') return Object.values(v).every(enBlanco);
  return false;
}

/** ¿Este seguimiento no tenía nada más que el suero que se sembró? */
function soloTraiaElSuero(fu) {
  const obj = fu.toObject ? fu.toObject() : fu;
  return Object.entries(obj).every(([k, v]) => CAMPOS_DEL_SEMBRADO.has(k) || enBlanco(v));
}

/**
 * QUITA DE LA FICHA EL SUERO QUE SE HABÍA ESCRITO.
 *
 * Para cuando el suero sobraba entero: se escogió por error, o el paso de
 * enfermería que lo llevaba se quitó de la cita. Sin esto la receta se quedaba
 * huérfana en la historia del paciente y enfermería la veía como algo pendiente
 * de poner.
 *
 * Se lleva el SEGUIMIENTO entero si no tenía nada más —los que siembra
 * sembrarSueroEnFicha son solo eso, la bolsa—; si alguien le escribió algo
 * después, se quita únicamente la línea del suero y el seguimiento se queda.
 * Y lo ya aplicado no se toca, por lo mismo de siempre.
 *
 * @returns {'quitado'|'aplicado'|'sin-receta'}
 */
async function quitarSueroDelSeguimiento({ patientId, followUpId }) {
  if (!patientId || !followUpId) return 'sin-receta';
  const record = await ClinicalRecord.findOne({ patient: patientId });
  const fu = record?.followUps?.id(followUpId);
  if (!fu) return 'sin-receta';

  const item = (fu.recetaItems || []).find((i) => i.isSerum);
  if (!item) return 'sin-receta';
  if ((item.administrations || []).length) return 'aplicado';

  fu.recetaItems.pull(item._id);
  if (!fu.recetaItems.length && soloTraiaElSuero(fu)) record.followUps.pull(fu._id);
  await record.save();
  return 'quitado';
}

module.exports = {
  sueroterapiaDeLaCita,
  sembrarSueroEnFicha,
  faltaElSueroDelServicio,
  sumarSueroAlSeguimiento,
  reescribirSueroDelSeguimiento,
  quitarSueroDelSeguimiento,
};
