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
 * ¿LO ESCRIBIÓ UNA CITA? (oct-2026)
 *
 * Los seguimientos que siembra `sembrarSueroEnFicha` llevan como motivo de
 * dónde salieron: el servicio, el formulario de la cita o el paso de
 * enfermería. Todo lo demás —la receta del doctor en su consulta, lo que
 * mostrador escribió a mano en la ficha— lo escribió una PERSONA, y la cita que
 * solo lo ESCOGIÓ para enfermería no es su dueña: puede corregirlo, pero no
 * borrarlo ni renombrarlo.
 */
const MOTIVO_DE_CITA = /^Suero (adicional )?indicado al (asignar la atención|agendar)|^Suero del servicio \(/;
function sembradoPorUnaCita(fu) {
  return MOTIVO_DE_CITA.test(String(fu?.descripcion || fu?.motivoConsulta || ''));
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
 * LA LÍNEA QUE SE CORRIGE ES LA PENDIENTE (oct-2026). La pantalla enseña y edita
 * la primera línea de suero que aún tiene dosis por poner (`pendingSerums(fu)[0]`
 * en el cliente); aquí se tomaba la primera línea de suero A SECAS y, si tenía
 * alguna dosis, se negaba entera. Con las recetas del doctor —de varias sesiones
 * («×5») o con más de un suero— en cuanto se ponía la primera, ninguna corrección
 * de caja llegaba ya a enfermería: le seguía saliendo lo que recetó el doctor.
 *
 * Y SI YA LLEVA SESIONES PUESTAS, SE PARTE: las puestas se quedan como se
 * pusieron —la línea original se cierra con esa cantidad, sus aplicaciones y su
 * inventario intactos— y las que faltan pasan a una línea nueva, justo debajo,
 * con la composición corregida. La suma de sesiones no cambia.
 *
 * @returns {'reescrito'|'aplicado'|'sin-receta'}
 */
async function reescribirSueroDelSeguimiento({ patientId, followUpId, linea, conservarNombre = false }) {
  if (!patientId || !followUpId || !linea) return 'sin-receta';
  const record = await ClinicalRecord.findOne({ patient: patientId });
  const fu = record?.followUps?.id(followUpId);
  if (!fu) return 'sin-receta';

  const sueros = (fu.recetaItems || []).filter((i) => i.isSerum);
  if (!sueros.length) return 'sin-receta';
  const puestas = (i) => (i.administrations || []).length;
  const item =
    sueros.find((i) => puestas(i) < (Number(i.quantity) || 0)) ||
    // Una línea «de 0» sin nada puesto (receta vieja): se corrige como antes.
    sueros.find((i) => !puestas(i));
  if (!item) return 'aplicado';

  /**
   * El nombre SÍ cambia cuando el suero lo escribió el PASO de la cita (lo puede
   * haber renombrado el rótulo). El de la bolsa del SERVICIO no, y tampoco el
   * que recetó el doctor: corregirle una ampolla no lo vuelve otro suero, y es
   * como lo reconocen la ficha, los PDF y la hoja del MSP.
   */
  const nombre = !conservarNombre && sembradoPorUnaCita(fu) && linea.name ? linea.name : item.name;

  const yaPuestas = puestas(item);
  if (!yaPuestas) {
    item.serumBase = linea.serumBase;
    item.serumComponents = linea.serumComponents;
    item.name = nombre;
  } else {
    const faltan = Math.max(1, (Number(item.quantity) || 0) - yaPuestas);
    const { _id, ...resto } = item.toObject();
    item.quantity = yaPuestas;
    const idx = fu.recetaItems.indexOf(item);
    fu.recetaItems.splice(idx + 1, 0, {
      ...resto,
      name: nombre,
      quantity: faltan,
      serumBase: linea.serumBase,
      serumComponents: linea.serumComponents,
      administrations: [],
      // Los «no se pudo aplicar» se quedan en la línea original, con su historia.
      noAplicaciones: [],
    });
  }
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
 * SOLO LO QUE ESCRIBIÓ UNA CITA (oct-2026). Mostrador puede escoger para
 * enfermería el suero que recetó el doctor; si después lo quita del paso —o
 * quita el paso, o borra la cita— eso quiere decir «hoy no se le pone», no
 * «bórrale la receta al doctor». Antes se le borraba la línea de su receta.
 * Ese suero se queda en la ficha, pendiente para otra visita.
 * `propio`: quien llama SABE que lo escribió la cita (la bolsa del servicio,
 * `autoSerumFollowUp`), y entonces no hace falta deducirlo del motivo.
 *
 * @returns {'quitado'|'aplicado'|'ajeno'|'sin-receta'}
 */
async function quitarSueroDelSeguimiento({ patientId, followUpId, propio = false }) {
  if (!patientId || !followUpId) return 'sin-receta';
  const record = await ClinicalRecord.findOne({ patient: patientId });
  const fu = record?.followUps?.id(followUpId);
  if (!fu) return 'sin-receta';
  if (!propio && !sembradoPorUnaCita(fu)) return 'ajeno';

  const item = (fu.recetaItems || []).find((i) => i.isSerum);
  if (!item) return 'sin-receta';
  if ((item.administrations || []).length) return 'aplicado';

  fu.recetaItems.pull(item._id);
  if (!fu.recetaItems.length && soloTraiaElSuero(fu)) record.followUps.pull(fu._id);
  await record.save();
  return 'quitado';
}

/**
 * ¿HAY ALGÚN SUERO RECETADO EN LA FICHA QUE SIGA SIN APLICARSE?
 *
 * Es la pregunta que decide si la cita se RETIENE al pasar a enfermería
 * (sep-2026): si la ficha tiene una receta de suero pendiente y el paso de
 * enfermería no lleva uno escogido, lo que le llegaría a la enfermera es «el
 * que recetó el doctor» — y ya no se confía en eso: el que toca aplicar en ese
 * momento lo decide mostrador. Con la ficha limpia de sueros no hay nada que
 * asignar y la cita sigue su camino normal.
 *
 * Misma cuenta que `pendingSerums` del cliente (utils/serumProgress.js): una
 * línea está pendiente cuando sus aplicaciones (`administrations`) no llegan a
 * la cantidad recetada.
 */
async function fichaTieneSueroPendiente(patientId) {
  if (!patientId) return false;
  const record = await ClinicalRecord.findOne({ patient: patientId })
    .select('followUps.recetaItems')
    .lean();
  if (!record) return false;
  return (record.followUps || []).some((fu) =>
    (fu.recetaItems || []).some(
      (item) =>
        item?.isSerum &&
        (Number(item?.quantity) || 0) >
          (Array.isArray(item?.administrations) ? item.administrations.length : 0)
    )
  );
}

/**
 * ¿ESTA CITA QUEDA RETENIDA al pasar el turno a enfermería?
 *
 * El doctor cerró SU turno y el vigente es de enfermería: la cita solo se
 * le entrega a enfermería si el suero que va a aplicar ya está decidido —lo escogió
 * mostrador en el paso (`turn.serum`/`serumFollowUp`)—. En los demás casos la
 * cita se retiene: `serumStatus = 'por_asignar'` y mostrador decide en
 * «Asignar atención» (escoge el suero, o lo deja sin él si el paciente no se lo
 * pondrá — eso es el «suero pendiente»).
 *
 * UN PASO SIN SUERO PERO CON TRABAJO PROPIO (sep-2026) NO SE RETIENE: la
 * retención existe para que el suero no llegue «de receta» sin que mostrador
 * decida; si el paso NO lleva suero pero sí lleva lo suyo —indicaciones escritas
 * para la enfermera, o la hidroterapia marcada— es un paso de enfermería que
 * no pone nada por vía, y retenerlo bloqueaba enviar la asignación de
 * «solo hidroterapia»: el check se marcaba y la cita nunca salía a la bandeja.
 *
 * NO se pregunta si la ficha tiene un suero recetado pendiente. Así se hizo la
 * primera vez (17-sep) y se coló el caso de FAUSTO MALLA UVACO (18-sep): el paso
 * de enfermería era un suero sin decidir, pero la ficha no tenía NINGUNA receta
 * de suero —el servicio de la cita no trae bolsa de serie y nadie recetó nada—,
 * la condición daba falso y la cita salió sola a la bandeja de la enfermera.
 * La decisión del suero es de mostrador SIEMPRE que el paso no lo lleve
 * escrito, haya o no receta previa en la ficha.
 */
async function leFaltaElSueroDeEnfermeria(apt) {
  const { turnoVigente } = require('./appointmentTurns');
  const vigente = turnoVigente(apt);
  if (!vigente || vigente.kind !== 'enfermeria') return false;
  if (vigente.serumFollowUp) return false;
  if ((vigente.serum?.components || []).some((c) => String(c?.name || '').trim())) return false;
  // Con solo sueros ADICIONALES el suero también está decidido.
  if ((vigente.extraSerums || []).some((x) => x?.serumFollowUp || (x?.components || []).length)) return false;
  // Paso sin suero pero con instrucciones o hidroterapia: no hay nada que
  // decidir de suero — mostrador ya dijo qué se hace en el paso.
  if (String(vigente.nurseInstructions || '').trim()) return false;
  if (vigente.hidroterapia?.solicitada) return false;
  return true;
}

module.exports = {
  sueroterapiaDeLaCita,
  sembrarSueroEnFicha,
  faltaElSueroDelServicio,
  sumarSueroAlSeguimiento,
  reescribirSueroDelSeguimiento,
  quitarSueroDelSeguimiento,
  sembradoPorUnaCita,
  fichaTieneSueroPendiente,
  leFaltaElSueroDeEnfermeria,
};
