#!/usr/bin/env node
/**
 * IMPORTAR PACIENTES DESDE LAS FICHAS FÍSICAS ESCANEADAS (/scanner).
 *
 * En "Mis documentos" del escáner hay PDF de fichas de "REGISTRO DE PACIENTES"
 * rellenadas a mano. Este script convierte cada una en:
 *
 *   · un PACIENTE (o el que ya existía, ver más abajo) con su ficha clínica y un
 *     primer seguimiento que lleva adjunta la PRIMERA PÁGINA del PDF: la ficha de
 *     registro propiamente dicha, que es lo que el doctor quiere ver;
 *   · una OBSERVACIÓN con las PÁGINAS RESTANTES —las «hojas de seguimiento», la
 *     tabla de fecha / servicio / costo / forma de pago / firma—, que es lo que
 *     recepción necesita a mano en la pestaña «Observaciones» del paciente;
 *   · el CHAT del CRM vinculado a ese paciente, si esa persona nos había escrito
 *     antes por WhatsApp: el call center deja de tener que registrarlo para poder
 *     agendarle una cita.
 *
 * Un escaneo de UNA sola página no deja observación: esa única página es la ficha
 * y ya va en el seguimiento.
 *
 * ─── DE DÓNDE SALEN LOS DATOS ─────────────────────────────────────────────────
 * NO se leen aquí. El servidor NO llama a ninguna IA (decisión del usuario: sin
 * costo por uso). Los PDF los transcribe el asistente fuera del sistema y entrega
 * un JSON; este script solo lo valida y lo inserta. Procedimiento completo en
 * docs/IMPORTAR_FICHAS_ESCANEADAS.md.
 *
 *   node scripts/importPatientsFromScans.js --datos=../data/fichas-escaneadas.json
 *   node scripts/importPatientsFromScans.js --datos=… --commit
 *   node scripts/importPatientsFromScans.js --datos=… --commit --desde=500 --limite=100
 *
 * Sin --commit no escribe nada: dice exactamente qué crearía y qué omitiría.
 *
 * ─── FORMATO DEL JSON ─────────────────────────────────────────────────────────
 *   { "fichas": [ { "documento": "<nombre en /scanner>",   // o "scanId": "<id>"
 *                   "fecha": "1-06-26", "nombres": "…", "apellidos": "…",
 *                   "cedula": "…", "edad": "71", "celular": "…",
 *                   "correo": "…", "direccion": "…",
 *                   "dudosos": ["cedula"] } ] }
 * También se acepta el array pelado. `dudosos` son los campos que quien transcribió
 * leyó con poca seguridad; se suman a los que no pasen la validación.
 *
 * ─── A QUIÉN PERTENECE CADA FICHA ─────────────────────────────────────────────
 * Casi todos los pacientes YA ESTÁN en el sistema: entraron por la API de
 * Contífico, con la cédula y el teléfono TECLEADOS por una persona. Estas fichas
 * son de esas mismas personas, así que lo primero es reconocerlas — si no, se
 * duplicaría media clínica. Se prueba en este orden, de más fuerte a más débil:
 *
 *   1. CÉDULA          — la clave única de siempre.
 *   2. NOMBRE+CELULAR  — el formulario nuevo no tiene casilla de cédula.
 *   3. NOMBRE+CORREO   — el correo casa exacto aunque el celular se leyera mal.
 *   4. NOMBRE a secas  — y solo si en toda la base hay UN paciente con ese nombre
 *                        completo. Es el escalón flojo: se acepta porque los
 *                        homónimos son rarísimos (1 en 6.000 fichas) y porque la
 *                        alternativa —dar de alta un duplicado con una cédula mal
 *                        leída— es mucho peor. Queda marcado para revisar.
 *
 * ─── EL DATO DEL SISTEMA MANDA, PERO EL PAPEL NO SE TIRA ──────────────────────
 * Al reconocer a un paciente NO se pisa lo que ya tiene. Es letra manuscrita
 * transcrita a ojo: en la tanda de agosto, de las cédulas que no coincidían, el
 * 90% NI SIQUIERA PASABA EL DÍGITO VERIFICADOR — el error era de lectura, no del
 * sistema. Pisar habría degradado 4.700 campos buenos.
 *
 * Lo que sí se hace:
 *   · se COMPLETA lo que el paciente tiene vacío (sobre todo la edad, que
 *     Contífico no trae);
 *   · lo que DIFIERE se guarda en `scanImport.alternos` y la ficha del paciente
 *     enseña LOS DOS valores, con el PDF a un clic para decidir cuál vale.
 *
 * ─── LO QUE NO HACE, A PROPÓSITO ──────────────────────────────────────────────
 * NO DISPARA AUTOMATIZACIONES. Crea el paciente con el modelo directamente, no por
 * el controlador, así que el evento `patient_created` no se emite. Es deliberado:
 * importar de golpe un lote de pacientes antiguos no puede desatar una tanda de
 * mensajes de bienvenida a gente que se registró hace meses. Si algún día alguien
 * "arregla" esto haciéndolo pasar por el controlador, romperá esa garantía.
 *
 * NO BORRA NI MODIFICA NADA DEL ESCÁNER. El original sigue intacto en storage/scans
 * y en /scanner; lo que se adjunta son copias REDUCIDAS (ver utils/scanMedia.js).
 * Reducirlas no es un capricho: copiar tal cual las 6.000 fichas de agosto añadiría
 * otros 12 GB al disco del VPS.
 *
 * NO RELLENA `whatsapp`. La ficha dice "celular" y eso va a `phone`. Dar por hecho
 * que ese número es WhatsApp metería a estos pacientes en el alcance de campañas
 * de marketing, y eso es una decisión del usuario, no de una importación.
 *
 * NO CREA CHATS NI ENVÍA NADA POR EL CRM. Solo VINCULA los que ya existen: pone
 * `conversation.patient` y, si el chat se llamaba con el apodo del perfil de
 * WhatsApp, le pone el nombre del paciente (vía `applyContactName`, que respeta
 * lo escrito a mano por un agente). Un chat ya vinculado a otro paciente no se
 * toca.
 *
 * ─── SE PUEDE VOLVER A EJECUTAR ───────────────────────────────────────────────
 * Cada una de las tres cosas que crea tiene su propia marca, así que un reintento
 * completa lo que falte sin duplicar nada: el paciente por `scanImport.scan`, la
 * observación por su índice único `scanImport.scan`, y el seguimiento por el nombre
 * del documento adjunto. Y si algo falla a mitad de una ficha, se deshace lo que esa
 * ficha hubiera creado para que el reintento la haga limpia.
 */
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

const { connect, disconnect } = require('./_common');
const Patient = require('../models/Patient');
const ClinicalRecord = require('../models/ClinicalRecord');
const ScannedDocument = require('../models/ScannedDocument');
const PatientObservation = require('../models/PatientObservation');
const Conversation = require('../models/Conversation');
const { nameKeyOf, sanitizeName } = require('../utils/scanNames');
const { normalizarExtraccion, claveNombre, NOTA_SEGUIMIENTO } = require('../utils/scanPatientExtract');
const { paginasJpeg, crearReductor, pdfDePaginas } = require('../utils/scanMedia');
const { applyContactName } = require('../utils/messaging');

const SCANS_DIR = path.join(__dirname, '..', 'storage', 'scans');
const FOLLOWUPS_DIR = path.join(__dirname, '..', 'storage', 'followups');
const OBSERVATIONS_DIR = path.join(__dirname, '..', 'storage', 'observations');

const DIRS = { scans: SCANS_DIR, followups: FOLLOWUPS_DIR, observations: OBSERVATIONS_DIR };

/** Misma clave que usa el escáner, para emparejar el PDF del ZIP con su ficha. */
const claveDocumento = (s) => nameKeyOf(sanitizeName(s));

/** Nombre de archivo nuevo, igual que haría una subida normal. */
const nombreNuevo = (ext) => `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;

const fechaCorta = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('es-EC') : '');

/**
 * Texto de la observación. Nombra el documento del escáner a propósito: la imagen
 * adjunta está reducida y, si alguien necesita el máximo detalle del papel, con ese
 * nombre lo encuentra en /scanner en dos segundos.
 */
const notaObservacion = (doc, fecha, paginas = 2) => {
  const hojas = Math.max(1, (paginas || 2) - 1);
  return `${hojas === 1 ? 'Hoja' : `${hojas} hojas`} de seguimiento de la ficha física` +
    `${fecha ? ` del ${fechaCorta(fecha)}` : ''}. ` +
    `La ficha de registro está en el primer seguimiento. ` +
    `Documento original completo en el escáner: "${doc.name}".`;
};

// ─── Emparejar cada entrada del JSON con su documento escaneado ──────────────

/**
 * Índice de los escaneos por id y por nombre. El nombre es único por clínica, así
 * que sirve de clave; aun así se detectan los ambiguos (dos nombres distintos que
 * al limpiarlos coinciden) para no adjudicarle el PDF equivocado a un paciente.
 */
async function indiceEscaneos(clinic) {
  const docs = await ScannedDocument.find(clinic ? { clinic } : {}).lean();
  const porId = new Map();
  const porNombre = new Map();
  const ambiguos = new Set();
  for (const d of docs) {
    porId.set(String(d._id), d);
    const k = claveDocumento(d.name);
    if (porNombre.has(k)) ambiguos.add(k);
    else porNombre.set(k, d);
  }
  return { porId, porNombre, ambiguos, total: docs.length };
}

function resolverEscaneo(ficha, idx) {
  if (ficha.scanId) {
    const d = idx.porId.get(String(ficha.scanId));
    return d ? { doc: d } : { error: `no existe el documento con id ${ficha.scanId}` };
  }
  const nombre = String(ficha.documento || '').trim();
  const k = claveDocumento(nombre);
  if (!k) return { error: 'la entrada no dice a qué documento del escáner pertenece' };
  if (idx.ambiguos.has(k)) return { error: `hay más de un escaneo que se llama "${nombre}"` };
  const d = idx.porNombre.get(k);
  return d ? { doc: d } : { error: `no hay ningún escaneo llamado "${nombre}"` };
}

// ─── Reconocer al paciente que ya está en el sistema ─────────────────────────

/**
 * Índice de los pacientes que YA existen, en memoria: son miles de fichas y cada
 * una preguntaría dos veces a una base que está a 120 ms de aquí. Se actualiza
 * según se van creando, así que dos fichas de la misma persona dentro del mismo
 * lote también se reconocen.
 */
async function indicePacientes() {
  // Se traen también los datos con los que se abre una historia clínica y con los
  // que se decide qué completar: al reconocer a un paciente que ya existe hay que
  // saber qué campos tiene vacíos y cuáles dicen otra cosa que el papel.
  const pacientes = await Patient.find({})
    .select('_id cedula firstName lastName phone whatsapp email address age clinic')
    .lean();
  const porCedula = new Map();
  const porNombreTelefono = new Map();
  const porNombreCorreo = new Map();
  // Nombre → TODOS los que se llaman así. Hace falta la lista entera, no el
  // primero: si hay dos homónimos el nombre deja de identificar a nadie y esa
  // ficha no se puede fusionar a ciegas.
  const porNombre = new Map();

  const digitos = (v) => String(v || '').replace(/\D/g, '');
  const correoDe = (v) => String(v || '').trim().toLowerCase();

  const añadir = (p) => {
    if (p.cedula) porCedula.set(String(p.cedula), p);
    const nombre = claveNombre(p.firstName, p.lastName);
    if (!nombre) return;
    // El primero gana en las claves fuertes: si ya hay dos con el mismo nombre y
    // teléfono, colgar la ficha siempre del mismo evita repartir la historia de
    // una persona entre dos.
    if (p.phone) {
      const k = `${nombre}|${digitos(p.phone)}`;
      if (!porNombreTelefono.has(k)) porNombreTelefono.set(k, p);
    }
    if (p.email) {
      const k = `${nombre}|${correoDe(p.email)}`;
      if (!porNombreCorreo.has(k)) porNombreCorreo.set(k, p);
    }
    porNombre.set(nombre, [...(porNombre.get(nombre) || []), p]);
  };
  pacientes.forEach(añadir);

  return {
    total: pacientes.length,
    añadir,
    /**
     * El paciente que ya está en el sistema y CÓMO se le reconoció, o `via: null`
     * si esta ficha es de alguien nuevo. El `via` viaja hasta el informe: el
     * escalón por el que entró es la medida de cuánto hay que fiarse.
     */
    buscar({ cedula, nombres, apellidos, celular, correo }) {
      if (cedula) {
        const p = porCedula.get(cedula);
        if (p) return { paciente: p, via: 'cedula' };
      }
      const nombre = claveNombre(nombres, apellidos);
      if (!nombre) return { paciente: null, via: null };
      if (celular) {
        const p = porNombreTelefono.get(`${nombre}|${celular}`);
        if (p) return { paciente: p, via: 'nombre+celular' };
      }
      if (correo) {
        const p = porNombreCorreo.get(`${nombre}|${correoDe(correo)}`);
        if (p) return { paciente: p, via: 'nombre+correo' };
      }
      const homonimos = porNombre.get(nombre) || [];
      // Dos personas con el mismo nombre completo: el nombre ya no identifica a
      // nadie. Se aparta en vez de jugársela — meter la ficha de una en la
      // historia clínica de la otra no lo detecta nadie a simple vista.
      if (homonimos.length > 1) return { paciente: null, via: 'homonimos' };
      if (homonimos.length === 1) return { paciente: homonimos[0], via: 'nombre' };
      return { paciente: null, via: null };
    },
  };
}

// ─── Material del escaneo (copias reducidas) ─────────────────────────────────

/**
 * Prepara lo que se va a adjuntar a partir del PDF original, PARTIDO EN DOS:
 *   · `ficha` — un PDF con la PRIMERA página: la ficha de registro. Va al
 *               seguimiento, que es lo que abre el doctor.
 *   · `hojas` — un PDF con las páginas 2 en adelante: las hojas de seguimiento
 *               (fecha / servicio / costo / forma de pago / firma). Van a la
 *               pestaña «Observaciones», que es lo que mira recepción.
 *
 * Se parte a propósito: antes el seguimiento cargaba el documento ENTERO y quien
 * quería la ficha tenía que pasar hojas de tabla hasta encontrarla. Cada mitad
 * acaba donde la usa quien la necesita.
 *
 * Un escaneo de UNA sola página no tiene hojas de seguimiento: esa única página
 * es la ficha, que ya va en el seguimiento. Devuelve `hojas: null` y dice por qué.
 *
 * Si el PDF no se puede despiezar (páginas en PNG, un PDF que no hizo el escáner),
 * se adjunta el original tal cual como ficha y se sigue: perder al paciente por no
 * poder separar una foto sería mucho peor que guardar un adjunto de más.
 */
async function materialFicha(doc, { dirs, reductor, reducir = true }) {
  const origen = path.join(dirs.scans, String(doc.clinic), doc.filename);
  const bruto = await fsp.readFile(origen); // si el archivo no está, esta ficha falla y se reporta

  const paginas = paginasJpeg(bruto);
  if (!paginas.length) {
    return { ficha: bruto, hojas: null, motivoSinHojas: 'no se pudieron separar las páginas del PDF', paginas: 0 };
  }

  // Sin reducir (dry-run) no se arma ningún PDF: solo interesa saber cuántas
  // páginas hay y si habrá observación. Armarlos costaría minutos y no se usan.
  if (!reducir) {
    return { ficha: bruto, hojas: paginas.length > 1 ? bruto : null, paginas: paginas.length };
  }

  const reducidas = [];
  for (const p of paginas) reducidas.push(await reductor.reducir(p));

  return {
    ficha: await pdfDePaginas(reducidas.slice(0, 1), `${doc.name} - ficha`),
    hojas: reducidas.length > 1
      ? await pdfDePaginas(reducidas.slice(1), `${doc.name} - hojas de seguimiento`)
      : null,
    motivoSinHojas: reducidas.length > 1 ? '' : 'el escaneo tiene una sola página (no hay hoja de seguimiento)',
    paginas: reducidas.length,
  };
}

/**
 * ¿Esta ficha ya está entera? Se mira ANTES de tocar el PDF.
 *
 * Importa por el REANUDAR: una tanda de 6.000 fichas se corta (aquí se colgó el
 * Chromium a las dos horas) y hay que relanzarla. Sin esta comprobación, el
 * segundo intento vuelve a abrir, despiezar y reescalar las 2.000 ya hechas para
 * acabar descartándolas — horas de trabajo para no cambiar nada.
 */
async function fichaCompleta(doc, paciente) {
  if (!paciente) return false;
  const historia = await ClinicalRecord.findOne({ patient: paciente._id })
    .select('followUps.attachments.originalName').lean();
  const tieneFicha = (historia?.followUps || []).some((f) =>
    (f.attachments || []).some((a) => a.originalName === NOMBRE_FICHA(doc))
  );
  if (!tieneFicha) return false;
  // De una sola página no hay observación que crear: con el seguimiento basta.
  if ((doc.pages || 0) <= 1) return true;
  const obs = await PatientObservation.findOne({ 'scanImport.scan': doc._id }).select('_id').lean();
  return Boolean(obs);
}

/** Nombres visibles de los adjuntos. Son la marca de que la ficha ya se procesó. */
const NOMBRE_FICHA = (doc) => `${sanitizeName(doc.name)} - ficha.pdf`;
const NOMBRE_HOJAS = (doc, paginas) =>
  `${sanitizeName(doc.name)} - hojas de seguimiento${paginas > 2 ? ` (${paginas - 1})` : ''}.pdf`;
/**
 * Nombre que usaba la importación ANTERIOR, cuando el seguimiento cargaba el PDF
 * entero. Sirve para reconocer esas fichas y repartirlas como las nuevas, en vez
 * de dejar dos criterios distintos conviviendo en la misma pantalla.
 */
const NOMBRE_ANTIGUO = (doc) => `${sanitizeName(doc.name)}.pdf`;

// ─── Escritura (cada pieza con su propia marca de "ya está hecho") ───────────

/**
 * Deja el documento en la historia clínica del paciente como un seguimiento.
 *
 * Marca de idempotencia: el nombre del adjunto es el del documento del escáner, así
 * que si ya cuelga de la historia, esta ficha ya se procesó y no se repite.
 */
async function asegurarSeguimiento(paciente, doc, { fecha, pdf, dirs, creados }) {
  const originalName = NOMBRE_FICHA(doc);
  const antiguo = NOMBRE_ANTIGUO(doc);
  // La sucursal es la del ESCANEO, no la del paciente: la ficha del paciente es
  // global y la historia clínica es única por (sucursal, paciente).
  const historia = await ClinicalRecord.findOne({ patient: paciente._id });
  const yaEstá = historia?.followUps?.some((f) =>
    (f.attachments || []).some((a) => a.originalName === originalName)
  );
  if (yaEstá) return { creado: false };

  /**
   * `registrar` apunta el archivo para borrarlo si la ficha falla más adelante.
   * En la conversión NO se apunta: para cuando se escribe, el cambio en la base
   * ya está guardado y apunta a él. Borrarlo en el rollback dejaría un
   * seguimiento enlazado a un PDF que no existe, que es justo lo que nadie
   * detecta a simple vista.
   */
  const escribirArchivo = async ({ registrar = true } = {}) => {
    const dir = path.join(dirs.followups, String(doc.clinic));
    await fsp.mkdir(dir, { recursive: true });
    const filename = nombreNuevo('.pdf');
    const destino = path.join(dir, filename);
    await fsp.writeFile(destino, pdf);
    if (registrar) creados.archivos.push(destino);
    return filename;
  };

  // ─── Ficha de la importación vieja: se convierte, no se duplica ───────────
  // Aquella colgaba el PDF ENTERO con el nombre del escaneo a secas. Volver a
  // adjuntar dejaría al paciente con el documento dos veces; se cambia el adjunto
  // por la primera página y las demás se van a observaciones como en las nuevas.
  const seguimientoViejo = historia?.followUps?.find((f) =>
    (f.attachments || []).some((a) => a.originalName === antiguo)
  );
  if (seguimientoViejo) {
    const adjunto = seguimientoViejo.attachments.find((a) => a.originalName === antiguo);
    const anterior = path.join(dirs.followups, String(doc.clinic), adjunto.filename);
    adjunto.filename = await escribirArchivo({ registrar: false });
    adjunto.originalName = originalName;
    adjunto.size = pdf.length;
    await historia.save();
    // El PDF entero ya no lo referencia nadie. El ORIGINAL sigue intacto en
    // storage/scans: esto solo borra la copia que hizo la importación.
    await fsp.unlink(anterior).catch(() => {});
    return { creado: true, convertido: true };
  }

  const seguimiento = {
    fecha,
    tipoConsulta: 'primera',
    observaciones: NOTA_SEGUIMIENTO,
    attachments: [{
      filename: await escribirArchivo(),
      originalName,
      mimeType: 'application/pdf',
      size: pdf.length,
      uploadedAt: new Date(),
      uploadedBy: doc.createdBy || undefined,
    }],
  };

  if (historia) {
    historia.followUps.push(seguimiento);
    await historia.save();
    creados.seguimientos.push({ historia: historia._id, idx: historia.followUps.length - 1 });
  } else {
    const nueva = await ClinicalRecord.create({
      clinic: doc.clinic,
      patient: paciente._id,
      fecha,
      nombre: `${paciente.firstName} ${paciente.lastName}`.trim(),
      direccion: paciente.address,
      edad: paciente.age ?? undefined,
      cedula: paciente.cedula,
      celular: paciente.phone,
      createdBy: doc.createdBy || undefined,
      followUps: [seguimiento],
    });
    creados.historias.push(nueva._id);
  }
  return { creado: true };
}

/**
 * Cuelga las hojas de seguimiento en la pestaña «Observaciones» del paciente.
 *
 * Van en UN SOLO PDF, no en una imagen por hoja: se abren de un clic en el visor
 * (que ya previsualiza PDF) y conservan el orden del papel, que en una tabla de
 * fechas y abonos es justamente lo que se lee.
 *
 * El archivo va a storage/observations/<paciente>/ —por paciente, no por sucursal—
 * porque es donde lo busca patientObservationController al descargarlo.
 */
async function asegurarObservacion(paciente, doc, { fecha, hojas, paginas, dirs, creados }) {
  const ya = await PatientObservation.findOne({ 'scanImport.scan': doc._id }).select('_id').lean();
  if (ya) return { creado: false };

  const dir = path.join(dirs.observations, String(paciente._id));
  await fsp.mkdir(dir, { recursive: true });
  const filename = nombreNuevo('.pdf');
  const destino = path.join(dir, filename);
  await fsp.writeFile(destino, hojas);
  creados.archivos.push(destino);

  const obs = await PatientObservation.create({
    clinic: doc.clinic,
    patient: paciente._id,
    text: notaObservacion(doc, fecha, paginas),
    attachments: [{
      filename,
      originalName: NOMBRE_HOJAS(doc, paginas),
      mimeType: 'application/pdf',
      size: hojas.length,
      uploadedAt: new Date(),
      uploadedBy: doc.createdBy || undefined,
    }],
    createdBy: doc.createdBy,
    scanImport: { scan: doc._id, importadoAt: new Date() },
  });
  creados.observaciones.push(obs._id);
  return { creado: true };
}

// ─── CRM: el chat de esa persona pasa a ser el chat del paciente ─────────────

/**
 * Vincula con el paciente los chats cuyo número es el suyo, y les pone su nombre.
 *
 * Para qué: el call center abría un chat que se llamaba "Karol❤️" y, para poder
 * agendar, tenía que registrar al paciente a mano — aunque esa persona llevara
 * meses en el sistema. Vinculado, `createAppointmentFromChat` ya lo acepta: el
 * agente solo crea la cita.
 *
 * El número se compara por los ÚLTIMOS 9 DÍGITOS, igual que `findPatientForIncoming`,
 * que es como el CRM reconoce a quien escribe (así casan 0999… y 593999…).
 *
 * Lo que NO hace: tocar un chat ya vinculado a otro paciente —ahí manda quien lo
 * vinculó, no una importación— ni pisar un nombre escrito por un agente
 * (`applyContactName` respeta esa jerarquía).
 */
async function vincularConversaciones(paciente, { commit, resumen, yaVistos }) {
  const cola = String(paciente.phone || paciente.whatsapp || '').replace(/\D/g, '').slice(-9);
  if (cola.length < 9) return;
  // Un mismo paciente trae varias fichas y la consulta por teléfono es una regex
  // sobre 15.000 chats: repetirla por cada hoja son horas tiradas. Con el número
  // ya visto en esta pasada no hay nada nuevo que vincular.
  if (yaVistos?.has(cola)) return;
  yaVistos?.add(cola);

  const chats = await Conversation.find({ phone: { $regex: `${cola}$` } })
    .select('_id patient contactName contactNameSource contactNameEditedAt')
    .limit(50); // un número compartido por media familia no debe disparar una tanda
  const nombre = `${paciente.firstName || ''} ${paciente.lastName || ''}`.trim();

  for (const chat of chats) {
    const ajeno = chat.patient && String(chat.patient) !== String(paciente._id);
    if (ajeno) continue;
    const vincula = !chat.patient;
    const renombra = Boolean(nombre) && applyContactName(chat, nombre, { source: 'contact' });
    if (!vincula && !renombra) continue;
    if (vincula) { chat.patient = paciente._id; resumen.chatsVinculados += 1; }
    if (renombra) resumen.chatsRenombrados += 1;
    if (commit) await chat.save();
  }
}

// ─── Completar al paciente que ya existe (sin pisarle nada) ──────────────────

const soloDigitos = (v) => String(v ?? '').replace(/\D/g, '');
/** Marcas de acento, escritas por código como en utils/scanNames.js. */
const DIACRITICOS = new RegExp('[\\u0300-\\u036f]', 'g');
/** Texto comparable: sin tildes, sin mayúsculas y sin espacios de más. */
const textoIgual = (a, b) => {
  const n = (v) => String(v ?? '').normalize('NFD').replace(DIACRITICOS, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
  return n(a) === n(b);
};

/**
 * Los campos que la ficha física puede aportar, y cómo se compara cada uno con lo
 * que ya tiene el paciente.
 *
 * La comparación IMPORTA tanto como el dato: comparando en crudo, "DURAN" y
 * "Durán" salían como valores distintos y 1.796 direcciones se habrían marcado
 * como discrepancia sin serlo. Aquí solo cuenta como "otro valor" lo que de
 * verdad dice otra cosa.
 */
const CAMPOS_FICHA = [
  { campo: 'cedula', en: 'cedula', lee: (d) => d.cedula, iguales: (a, b) => soloDigitos(a) === soloDigitos(b) },
  { campo: 'celular', en: 'phone', lee: (d) => d.celular, iguales: (a, b) => soloDigitos(a).slice(-9) === soloDigitos(b).slice(-9) },
  { campo: 'correo', en: 'email', lee: (d) => d.correo, iguales: (a, b) => String(a).toLowerCase().trim() === String(b).toLowerCase().trim() },
  { campo: 'direccion', en: 'address', lee: (d) => d.direccion, iguales: textoIgual },
  { campo: 'edad', en: 'age', lee: (d) => d.edad, iguales: (a, b) => Number(a) === Number(b) },
];

/**
 * Vuelca en el paciente lo que aporta esta ficha:
 *   · COMPLETA los campos que tiene vacíos (la edad, sobre todo: Contífico no la
 *     trae y el 68% de los pacientes no la tenía);
 *   · lo que DIFIERE lo guarda en `scanImport.alternos` para enseñar los dos
 *     valores, sin tocar el que ya había.
 *
 * La CÉDULA es el único campo delicado al completar: es clave única en toda la
 * base, así que si la que trae el papel ya es de otro paciente no se escribe —se
 * guarda como alterno y se marca para revisar. Sin esa comprobación, el E11000
 * tumbaría la ficha entera por un dígito mal leído.
 */
async function completarPaciente(paciente, datos, doc, { fecha, dudas, crudo, commit, resumen }) {
  const alternos = [...(paciente.scanImport?.alternos || [])];
  const nuevasDudas = new Set([...(paciente.scanImport?.dudas || []), ...dudas]);
  let tocado = false;
  let alternosNuevos = 0;

  for (const { campo, en, lee, iguales } of CAMPOS_FICHA) {
    const valor = lee(datos);
    if (valor === '' || valor === null || valor === undefined) continue;
    const actual = paciente[en];
    const vacío = actual === null || actual === undefined || String(actual).trim() === '';

    if (vacío) {
      if (campo === 'cedula') {
        const choque = await Patient.findOne({ cedula: String(valor), _id: { $ne: paciente._id } })
          .select('_id').lean();
        if (choque) {
          alternos.push({ campo, valor: String(valor), scan: doc._id, fecha });
          nuevasDudas.add(campo);
          alternosNuevos += 1;
          continue;
        }
      }
      paciente[en] = valor;
      resumen.completados[campo] = (resumen.completados[campo] || 0) + 1;
      tocado = true;
      continue;
    }

    if (iguales(actual, valor)) continue;

    // Otro valor. Se guarda una sola vez por (campo, valor): un paciente con seis
    // fichas repetiría seis veces el mismo teléfono mal leído.
    const yaEstá = alternos.some((a) => a.campo === campo && textoIgual(a.valor, String(valor)));
    if (!yaEstá) {
      alternos.push({ campo, valor: String(valor), scan: doc._id, fecha });
      alternosNuevos += 1;
    }
    nuevasDudas.add(campo);
    resumen.discrepancias[campo] = (resumen.discrepancias[campo] || 0) + 1;
    tocado = true;
  }

  // El nombre: solo se completa si el paciente no tenía. No se guarda como alterno
  // porque el nombre es JUSTAMENTE por lo que se le reconoció — si difiriera de
  // verdad, no sería el mismo paciente.
  if (!String(paciente.firstName || '').trim() && datos.nombres) { paciente.firstName = datos.nombres; tocado = true; }
  if (!String(paciente.lastName || '').trim() && datos.apellidos) { paciente.lastName = datos.apellidos; tocado = true; }

  const scanImport = paciente.scanImport || {};
  // `scan` y `crudo` van juntos y solo la primera vez: la pantalla de revisión
  // enseña el PDF de `scan` al lado de lo que se leyó en él. Apuntar a un escaneo
  // y enseñar la transcripción de otro sería peor que no enseñar nada.
  if (!scanImport.scan) {
    paciente.set('scanImport.scan', doc._id);
    paciente.set('scanImport.crudo', crudo || null);
    paciente.set('scanImport.importadoAt', new Date());
    tocado = true;
  }
  if (alternosNuevos) {
    paciente.set('scanImport.alternos', alternos);
    // Hay algo nuevo que mirar: vuelve a la lista de pendientes aunque alguien ya
    // la hubiera dado por revisada con las fichas anteriores.
    paciente.set('scanImport.revisadoAt', null);
    tocado = true;
  }
  if (nuevasDudas.size !== (scanImport.dudas || []).length) {
    paciente.set('scanImport.dudas', [...nuevasDudas]);
    tocado = true;
  }

  if (tocado && commit) await paciente.save();
  return { tocado, alternos: alternosNuevos };
}

// ─── Importación ─────────────────────────────────────────────────────────────

/**
 * Importa un lote de fichas ya transcritas.
 * @returns {{ creados:[], fusionados:[], omitidos:[], errores:[] }}
 */
async function importarFichas({
  fichas,
  commit = false,
  clinic = null,
  dirs = DIRS,
  log = () => {},
  // Inyectable para no arrancar un Chromium en los tests, que prueban el flujo,
  // no el reescalado (ese es de utils/scanMedia.js).
  reductor = crearReductor(),
} = {}) {
  const idx = await indiceEscaneos(clinic);
  const pacientes = await indicePacientes();
  log(`Escaneos disponibles: ${idx.total}${clinic ? ' (solo esta sucursal)' : ''}`);
  log(`Pacientes ya en el sistema: ${pacientes.total}`);

  const creados = [];
  const fusionados = [];
  const omitidos = [];
  const errores = [];
  const resumen = {
    completados: {},
    discrepancias: {},
    porVia: {},
    chatsVinculados: 0,
    chatsRenombrados: 0,
    convertidos: 0,
    yaHechas: 0,
  };
  /** Teléfonos cuyos chats ya se miraron en esta pasada (ver vincularConversaciones). */
  const telefonosVistos = new Set();

  try {
    for (const [i, ficha] of fichas.entries()) {
      const etiqueta = ficha.documento || ficha.scanId || `#${i + 1}`;
      if (commit && i > 0 && i % 25 === 0) {
        log(`  … ${i}/${fichas.length} (${creados.length} nuevos, ${fusionados.length} fusionados)`);
      }

      const { doc, error } = resolverEscaneo(ficha, idx);
      if (error) { errores.push({ ficha: etiqueta, motivo: error }); continue; }

      const norm = normalizarExtraccion(ficha);
      if (!norm.utilizable) {
        omitidos.push({ ficha: etiqueta, motivo: 'la ficha no tiene nombre ni apellido legibles' });
        continue;
      }

      // Sin fecha legible se usa la del escaneo: es lo más cercano y queda marcado
      // como duda, así que en la revisión se corrige contra el PDF.
      const fecha = norm.datos.fecha || doc.createdAt || new Date();
      const dudas = norm.datos.fecha ? norm.dudas : [...new Set([...norm.dudas, 'fecha'])];

      // Lo que esta ficha haya creado, para deshacerlo si algo falla a mitad.
      const hechos = { paciente: null, historias: [], seguimientos: [], observaciones: [], archivos: [] };
      try {
        // El paciente que ya salió de ESTE escaneo manda sobre cualquier otra
        // coincidencia: es literalmente esta ficha, reintentada.
        const yaDeEsteEscaneo = await Patient.findOne({ 'scanImport.scan': doc._id });
        const hallado = yaDeEsteEscaneo
          ? { paciente: yaDeEsteEscaneo, via: 'reintento' }
          : pacientes.buscar(norm.datos);
        resumen.porVia[hallado.via || 'nuevo'] = (resumen.porVia[hallado.via || 'nuevo'] || 0) + 1;

        // Dos personas con el mismo nombre completo: ver `indicePacientes.buscar`.
        // Ni se fusiona (podría ser la otra) ni se crea una tercera.
        if (hallado.via === 'homonimos') {
          omitidos.push({
            ficha: etiqueta,
            motivo: `hay más de un paciente llamado "${norm.datos.nombres} ${norm.datos.apellidos}": hay que decidir a mano de quién es esta ficha`,
          });
          continue;
        }

        // Reanudar: lo que ya está hecho se salta sin abrir el PDF (ver `fichaCompleta`).
        if (commit && hallado.paciente && await fichaCompleta(doc, hallado.paciente)) {
          resumen.yaHechas += 1;
          fusionados.push({
            ficha: etiqueta,
            paciente: String(hallado.paciente._id),
            nombre: `${hallado.paciente.firstName} ${hallado.paciente.lastName}`.trim(),
            cedula: hallado.paciente.cedula,
            fecha,
            dudas,
            via: hallado.via,
            seguimiento: false,
            observacion: false,
            sinHoja: '',
          });
          continue;
        }

        const material = await materialFicha(doc, { dirs, reductor, reducir: commit });

        if (!commit) {
          const fila = {
            ficha: etiqueta,
            nombre: `${norm.datos.nombres} ${norm.datos.apellidos}`.trim(),
            cedula: norm.datos.cedula,
            fecha,
            dudas,
            via: hallado.via,
            hoja: Boolean(material.hojas),
          };
          if (hallado.paciente) {
            fusionados.push({ ...fila, paciente: `${hallado.paciente.firstName} ${hallado.paciente.lastName}` });
          } else {
            creados.push(fila);
            pacientes.añadir({
              ...norm.datos,
              firstName: norm.datos.nombres,
              lastName: norm.datos.apellidos,
              phone: norm.datos.celular,
              email: norm.datos.correo,
            });
          }
          continue;
        }

        let paciente = hallado.paciente;
        if (paciente && !paciente.save) {
          // El índice viene `lean()` (son miles y se recorren en memoria); para
          // escribir hace falta el documento de verdad.
          paciente = await Patient.findById(paciente._id);
        }
        if (!paciente) {
          paciente = await Patient.create({
            clinic: doc.clinic,
            cedula: norm.datos.cedula,
            firstName: norm.datos.nombres || norm.datos.apellidos,
            lastName: norm.datos.apellidos || norm.datos.nombres,
            email: norm.datos.correo,
            phone: norm.datos.celular,
            age: norm.datos.edad ?? undefined,
            address: norm.datos.direccion,
            source: 'recepcion',
            scanImport: {
              scan: doc._id,
              importadoAt: new Date(),
              dudas,
              crudo: norm.crudo,
              alternos: [],
              revisadoAt: null,
              revisadoBy: null,
            },
          });
          hechos.paciente = paciente._id;
          pacientes.añadir(paciente.toObject());
        } else {
          // Ya existía (Contífico, o una ficha anterior de esta misma tanda): se
          // le completa lo que le falte y se guarda el otro valor de lo que difiera.
          await completarPaciente(paciente, norm.datos, doc, {
            fecha, dudas, crudo: norm.crudo, commit, resumen,
          });
        }

        const seg = await asegurarSeguimiento(paciente, doc, { fecha, pdf: material.ficha, dirs, creados: hechos });
        if (seg.convertido) resumen.convertidos += 1;
        // Toda observación tiene autor (`createdBy` es obligatorio) y el suyo es
        // quien escaneó. Un escaneo sin autor —no los hay hoy— se queda sin
        // observación y se dice, en vez de tumbar la ficha entera.
        const puedeObservar = Boolean(material.hojas && doc.createdBy);
        const obs = puedeObservar
          ? await asegurarObservacion(paciente, doc, {
              fecha, hojas: material.hojas, paginas: material.paginas, dirs, creados: hechos,
            })
          : { creado: false };

        // El CRM, al final: si algo falla antes, esta ficha se deshace entera y no
        // tiene sentido haber renombrado ya el chat de alguien.
        await vincularConversaciones(paciente, { commit, resumen, yaVistos: telefonosVistos });

        const fila = {
          ficha: etiqueta,
          paciente: String(paciente._id),
          nombre: `${paciente.firstName} ${paciente.lastName}`.trim(),
          cedula: paciente.cedula,
          fecha,
          dudas,
          via: hallado.via,
          seguimiento: seg.creado,
          observacion: obs.creado,
          sinHoja: puedeObservar ? '' : material.motivoSinHojas || 'el escaneo no dice quién lo hizo',
        };
        if (hechos.paciente) creados.push(fila);
        else fusionados.push(fila);
      } catch (e) {
        // Deshacer lo de ESTA ficha para que el reintento la haga desde cero. Un
        // paciente sin historia, o una historia apuntando a un PDF que no se copió,
        // es peor que no haberlo importado: nadie lo detecta a simple vista.
        for (const id of hechos.observaciones) await PatientObservation.deleteOne({ _id: id }).catch(() => {});
        for (const id of hechos.historias) await ClinicalRecord.deleteOne({ _id: id }).catch(() => {});
        for (const s of hechos.seguimientos) {
          await ClinicalRecord.updateOne({ _id: s.historia }, { $pop: { followUps: 1 } }).catch(() => {});
        }
        if (hechos.paciente) await Patient.deleteOne({ _id: hechos.paciente }).catch(() => {});
        for (const f of hechos.archivos) await fsp.unlink(f).catch(() => {});
        errores.push({ ficha: etiqueta, motivo: e.message });
      }
    }
  } finally {
    await reductor.cerrar?.();
  }

  return { creados, fusionados, omitidos, errores, resumen };
}

// ─── Ejecución de una sola vez (para el despliegue) ─────────────────────────

/**
 * Clave de la tanda. La importación ya se salta lo que está hecho, pero eso NO
 * basta: si alguien borra un paciente importado, el siguiente despliegue lo
 * resucitaría sin que nadie lo pidiera. La marca corta eso en seco — la tanda entra
 * una vez y no vuelve a mirarse.
 *
 * Para una tanda NUEVA de fichas: cambiar la clave junto con el JSON.
 */
const TASK_KEY = 'importar-fichas-escaneadas-2026-09-03';
const STALE_RUNNING_MS = 30 * 60 * 1000;
/**
 * La tanda de agosto de 2026 son 6.000 fichas: horas de trabajo. Sin dar señales de
 * vida, un despliegue a mitad vería la marca RUNNING caducada y arrancaría una
 * SEGUNDA importación en paralelo sobre la misma base.
 */
const LATIDO_MS = 5 * 60 * 1000;

async function runOnce({ key = TASK_KEY, ruta, force = false, dirs, log = console.log, ...resto } = {}) {
  const OneTimeTask = require('../models/OneTimeTask');
  const os = require('os');

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

  const latido = setInterval(() => {
    OneTimeTask.updateOne({ _id: key }, { $set: { startedAt: new Date() } }).catch(() => {});
  }, LATIDO_MS);
  latido.unref?.();

  try {
    const fichas = leerDatos(ruta);
    const r = await importarFichas({ fichas, commit: true, log, ...(dirs ? { dirs } : {}), ...resto });
    informe(r, true);
    const result = {
      creados: r.creados.length,
      fusionados: r.fusionados.length,
      conDudas: r.creados.filter((c) => c.dudas.length).length,
      observaciones: [...r.creados, ...r.fusionados].filter((c) => c.observacion).length,
      omitidos: r.omitidos.length,
      errores: r.errores.length,
      completados: r.resumen?.completados || {},
      discrepancias: r.resumen?.discrepancias || {},
      porVia: r.resumen?.porVia || {},
      chatsVinculados: r.resumen?.chatsVinculados || 0,
      chatsRenombrados: r.resumen?.chatsRenombrados || 0,
      convertidos: r.resumen?.convertidos || 0,
      yaHechas: r.resumen?.yaHechas || 0,
    };
    await OneTimeTask.updateOne({ _id: key }, { $set: { status: 'DONE', finishedAt: new Date(), result } });
    log(`🔒  Marca "${key}" = DONE: no volverá a ejecutarse en los próximos despliegues.`);
    return { skipped: false, status: 'DONE', result };
  } catch (e) {
    await OneTimeTask.updateOne({ _id: key }, { $set: { status: 'FAILED', finishedAt: new Date(), error: e.message } });
    throw e;
  } finally {
    clearInterval(latido);
  }
}

// ─── Línea de comandos ───────────────────────────────────────────────────────

function leerDatos(ruta) {
  const abs = path.resolve(process.cwd(), ruta);
  if (!fs.existsSync(abs)) throw new Error(`no existe el archivo de datos: ${abs}`);
  const crudo = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const fichas = Array.isArray(crudo) ? crudo : crudo.fichas;
  if (!Array.isArray(fichas)) throw new Error('el JSON debe ser un array o traer la propiedad "fichas"');
  return fichas;
}

/** Etiqueta legible del escalón por el que se reconoció al paciente. */
const VIAS = {
  cedula: 'por cédula',
  'nombre+celular': 'por nombre + celular',
  'nombre+correo': 'por nombre + correo',
  nombre: 'solo por el nombre (revisar)',
  reintento: 'ya venía de este mismo escaneo',
  homonimos: 'nombre repetido: apartada',
  nuevo: 'no existía: alta nueva',
};

function informe({ creados, fusionados, omitidos, errores, resumen }, commit) {
  const conDudas = creados.filter((c) => c.dudas.length);
  const conObservacion = [...creados, ...fusionados].filter((c) => (commit ? c.observacion : c.hoja));
  const cuenta = (o) => Object.entries(o || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || 'ninguno';
  console.log('\n─── RESULTADO ────────────────────────────────────────────────');
  console.log(`${commit ? 'Pacientes creados' : 'Se crearían'}: ${creados.length}`);
  console.log(`  · sin ninguna duda: ${creados.length - conDudas.length}`);
  console.log(`  · a revisar a mano: ${conDudas.length}`);
  console.log(`Fichas de pacientes que ya existían: ${fusionados.length}`);
  console.log(`Observaciones con las hojas de seguimiento: ${conObservacion.length}`);
  console.log(`Omitidos: ${omitidos.length}`);
  console.log(`Errores:  ${errores.length}`);

  if (resumen) {
    console.log('\nCómo se reconoció a cada paciente:');
    for (const [via, n] of Object.entries(resumen.porVia || {})) {
      console.log(`  · ${VIAS[via] || via}: ${n}`);
    }
    if (commit) {
      console.log(`\nCampos COMPLETADOS (los tenía vacíos): ${cuenta(resumen.completados)}`);
      console.log(`Campos con OTRO valor (se guardan los dos): ${cuenta(resumen.discrepancias)}`);
      console.log(`Fichas de la importación vieja convertidas al criterio nuevo: ${resumen.convertidos}`);
      console.log(`Fichas que ya estaban hechas (reanudar): ${resumen.yaHechas}`);
      console.log(`CRM: ${resumen.chatsVinculados} chats vinculados al paciente, ${resumen.chatsRenombrados} renombrados`);
    }
  }

  if (conDudas.length) {
    console.log('\nA revisar (aparecen en /patients → "Fichas por revisar"):');
    for (const c of conDudas.slice(0, 40)) console.log(`  · ${c.nombre} — dudas en: ${c.dudas.join(', ')}`);
    if (conDudas.length > 40) console.log(`  … y ${conDudas.length - 40} más`);
  }
  if (omitidos.length) {
    console.log('\nOmitidos:');
    for (const o of omitidos.slice(0, 40)) console.log(`  · ${o.ficha}: ${o.motivo}${o.paciente ? ` (${o.paciente})` : ''}`);
    if (omitidos.length > 40) console.log(`  … y ${omitidos.length - 40} más`);
  }
  if (errores.length) {
    console.log('\nErrores:');
    for (const e of errores.slice(0, 40)) console.log(`  · ${e.ficha}: ${e.motivo}`);
    if (errores.length > 40) console.log(`  … y ${errores.length - 40} más`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const valor = (nombre) => (args.find((a) => a.startsWith(`--${nombre}=`)) || '').split('=')[1];
  const commit = args.includes('--commit');
  const once = args.includes('--once');
  const force = args.includes('--force');
  const ruta = valor('datos');
  const clinic = valor('clinic') || null;
  const key = valor('key') || TASK_KEY;
  const desde = Number(valor('desde') || 0);
  const limite = Number(valor('limite') || 0);

  if (!ruta) {
    console.error('Falta --datos=<ruta al JSON>. Ver docs/IMPORTAR_FICHAS_ESCANEADAS.md');
    process.exit(1);
  }

  console.log('\n=== IMPORTAR PACIENTES DESDE FICHAS ESCANEADAS ===');
  if (once) console.log(`Clave de la tarea: ${key}`);
  console.log(commit ? 'MODO: COMMIT (crea de verdad).' : 'MODO: DRY-RUN (no escribe nada). Usa --commit para aplicar.');

  await connect();
  try {
    // `--once` es lo que usa el despliegue: entra una sola vez aunque el push se repita.
    if (once && commit) {
      await runOnce({ key, ruta, force, clinic });
      return;
    }
    let fichas = leerDatos(ruta);
    if (desde) fichas = fichas.slice(desde);
    if (limite) fichas = fichas.slice(0, limite);
    console.log(`Fichas a procesar: ${fichas.length}`);
    const r = await importarFichas({ fichas, commit, clinic, log: (m) => console.log(m) });
    informe(r, commit);
  } finally {
    await disconnect();
  }
}

module.exports = {
  importarFichas,
  indiceEscaneos,
  indicePacientes,
  resolverEscaneo,
  claveDocumento,
  materialFicha,
  runOnce,
  TASK_KEY,
  NOTA_SEGUIMIENTO,
};

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
