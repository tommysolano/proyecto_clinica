#!/usr/bin/env node
/**
 * IMPORTAR PACIENTES DESDE LAS FICHAS FÍSICAS ESCANEADAS (/scanner).
 *
 * En "Mis documentos" del escáner hay PDF de fichas de "REGISTRO DE PACIENTES"
 * rellenadas a mano. Este script convierte cada una en:
 *
 *   · un PACIENTE con su ficha clínica y un primer seguimiento que lleva el
 *     documento adjunto, para que el doctor pueda ver el original;
 *   · una OBSERVACIÓN con la ÚLTIMA PÁGINA del PDF —la «hoja de seguimiento»,
 *     la tabla de fecha / servicio / costo / forma de pago / firma—, que es lo
 *     que recepción necesita a mano en la pestaña «Observaciones» del paciente.
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
 * ─── UN PACIENTE PUEDE TENER VARIAS FICHAS ────────────────────────────────────
 * El formulario nuevo de la clínica NO tiene casilla de cédula, y quien vuelve a
 * consulta llena otra hoja. Así que la misma persona aparece en varias fichas y hay
 * que reconocerla, o la tanda de agosto de 2026 daría de alta al mismo paciente
 * media docena de veces:
 *
 *   · con cédula → es la clave única de siempre;
 *   · sin cédula → mismo NOMBRE (ver `claveNombre`) Y mismo CELULAR.
 *
 * Al reconocerla NO se le tocan los datos —los del sistema mandan sobre una
 * transcripción de letra manuscrita— pero SÍ se le añade lo de esa ficha: su
 * seguimiento con el documento y su observación con la hoja de seguimiento. Sin
 * celular no se fusiona: dos homónimos existen, y juntarlos mezcla dos historias.
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
const { nameKeyOf, sanitizeName } = require('../utils/scanNames');
const { normalizarExtraccion, claveNombre, NOTA_SEGUIMIENTO } = require('../utils/scanPatientExtract');
const { paginasJpeg, crearReductor, pdfDePaginas } = require('../utils/scanMedia');

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
const notaObservacion = (doc, fecha) =>
  `Hoja de seguimiento de la ficha física${fecha ? ` del ${fechaCorta(fecha)}` : ''}. ` +
  `Documento original en el escáner: "${doc.name}".`;

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
  // Se traen también los datos con los que se abre una historia clínica: al
  // reconocer a un paciente que ya existe hay que poder crearle la suya si no la
  // tiene, y con solo el nombre y el teléfono no se puede.
  const pacientes = await Patient.find({})
    .select('_id cedula firstName lastName phone clinic address age')
    .lean();
  const porCedula = new Map();
  const porNombreTelefono = new Map();

  const clave = (p) => `${claveNombre(p.firstName, p.lastName)}|${String(p.phone || '').replace(/\D/g, '')}`;

  const añadir = (p) => {
    if (p.cedula) porCedula.set(String(p.cedula), p);
    if (p.phone && (p.firstName || p.lastName)) {
      const k = clave(p);
      // El primero gana: si ya hay dos con el mismo nombre y teléfono, colgar la
      // ficha siempre del mismo evita repartir la historia de una persona entre dos.
      if (!porNombreTelefono.has(k)) porNombreTelefono.set(k, p);
    }
  };
  pacientes.forEach(añadir);

  return {
    total: pacientes.length,
    añadir,
    /** El paciente que ya está en el sistema, o null si esta ficha es de alguien nuevo. */
    buscar({ cedula, nombres, apellidos, celular }) {
      if (cedula) return porCedula.get(cedula) || null;
      if (!celular) return null; // sin cédula ni celular no hay forma segura de reconocerlo
      return porNombreTelefono.get(`${claveNombre(nombres, apellidos)}|${celular}`) || null;
    },
  };
}

// ─── Material del escaneo (copias reducidas) ─────────────────────────────────

/**
 * Prepara lo que se va a adjuntar a partir del PDF original:
 *   · `pdf`   — el documento entero, con las fotos reducidas;
 *   · `hoja`  — la ÚLTIMA página, para la observación.
 *
 * Un escaneo de UNA sola página no tiene hoja de seguimiento: esa única página es
 * la ficha, que ya va en el seguimiento. Devuelve `hoja: null` y se dice por qué.
 *
 * Si el PDF no se puede despiezar (páginas en PNG, un PDF que no hizo el escáner),
 * se adjunta el original tal cual y se sigue: perder al paciente por no poder
 * reducir una foto sería mucho peor que guardar un adjunto grande.
 */
async function materialFicha(doc, { dirs, reductor, reducir = true }) {
  const origen = path.join(dirs.scans, String(doc.clinic), doc.filename);
  const bruto = await fsp.readFile(origen); // si el archivo no está, esta ficha falla y se reporta

  const paginas = paginasJpeg(bruto);
  if (!paginas.length) {
    return { pdf: bruto, hoja: null, motivoSinHoja: 'no se pudieron separar las páginas del PDF', paginas: 0 };
  }
  if (!reducir) {
    return { pdf: bruto, hoja: paginas.length > 1 ? paginas[paginas.length - 1] : null, paginas: paginas.length };
  }

  const reducidas = [];
  for (const p of paginas) reducidas.push(await reductor.reducir(p));

  return {
    pdf: await pdfDePaginas(reducidas, doc.name),
    hoja: reducidas.length > 1 ? reducidas[reducidas.length - 1] : null,
    motivoSinHoja: reducidas.length > 1 ? '' : 'el escaneo tiene una sola página (no hay hoja de seguimiento)',
    paginas: reducidas.length,
  };
}

// ─── Escritura (cada pieza con su propia marca de "ya está hecho") ───────────

/**
 * Deja el documento en la historia clínica del paciente como un seguimiento.
 *
 * Marca de idempotencia: el nombre del adjunto es el del documento del escáner, así
 * que si ya cuelga de la historia, esta ficha ya se procesó y no se repite.
 */
async function asegurarSeguimiento(paciente, doc, { fecha, pdf, dirs, creados }) {
  const originalName = `${sanitizeName(doc.name)}.pdf`;
  // La sucursal es la del ESCANEO, no la del paciente: la ficha del paciente es
  // global y la historia clínica es única por (sucursal, paciente).
  const historia = await ClinicalRecord.findOne({ clinic: doc.clinic, patient: paciente._id });
  const yaEstá = historia?.followUps?.some((f) =>
    (f.attachments || []).some((a) => a.originalName === originalName)
  );
  if (yaEstá) return { creado: false };

  const dir = path.join(dirs.followups, String(doc.clinic));
  await fsp.mkdir(dir, { recursive: true });
  const filename = nombreNuevo('.pdf');
  const destino = path.join(dir, filename);
  await fsp.writeFile(destino, pdf);
  creados.archivos.push(destino);

  const seguimiento = {
    fecha,
    tipoConsulta: 'primera',
    observaciones: NOTA_SEGUIMIENTO,
    attachments: [{
      filename,
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
 * Cuelga la hoja de seguimiento en la pestaña «Observaciones» del paciente.
 *
 * El archivo va a storage/observations/<paciente>/ —por paciente, no por sucursal—
 * porque es donde lo busca patientObservationController al descargarlo.
 */
async function asegurarObservacion(paciente, doc, { fecha, hoja, dirs, creados }) {
  const ya = await PatientObservation.findOne({ 'scanImport.scan': doc._id }).select('_id').lean();
  if (ya) return { creado: false };

  const dir = path.join(dirs.observations, String(paciente._id));
  await fsp.mkdir(dir, { recursive: true });
  const filename = nombreNuevo('.jpg');
  const destino = path.join(dir, filename);
  await fsp.writeFile(destino, hoja);
  creados.archivos.push(destino);

  const obs = await PatientObservation.create({
    clinic: doc.clinic,
    patient: paciente._id,
    text: notaObservacion(doc, fecha),
    attachments: [{
      filename,
      originalName: `${sanitizeName(doc.name)} - hoja de seguimiento.jpg`,
      mimeType: 'image/jpeg',
      size: hoja.length,
      uploadedAt: new Date(),
      uploadedBy: doc.createdBy || undefined,
    }],
    createdBy: doc.createdBy,
    scanImport: { scan: doc._id, importadoAt: new Date() },
  });
  creados.observaciones.push(obs._id);
  return { creado: true };
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
        const existente = yaDeEsteEscaneo || pacientes.buscar(norm.datos);

        const material = await materialFicha(doc, { dirs, reductor, reducir: commit });

        if (!commit) {
          const resumen = {
            ficha: etiqueta,
            nombre: `${norm.datos.nombres} ${norm.datos.apellidos}`.trim(),
            cedula: norm.datos.cedula,
            fecha,
            dudas,
            hoja: Boolean(material.hoja),
          };
          if (existente) fusionados.push({ ...resumen, paciente: `${existente.firstName} ${existente.lastName}` });
          else { creados.push(resumen); pacientes.añadir({ ...norm.datos, firstName: norm.datos.nombres, lastName: norm.datos.apellidos, phone: norm.datos.celular }); }
          continue;
        }

        let paciente = existente;
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
              revisadoAt: null,
              revisadoBy: null,
            },
          });
          hechos.paciente = paciente._id;
          pacientes.añadir(paciente.toObject());
        }

        const seg = await asegurarSeguimiento(paciente, doc, { fecha, pdf: material.pdf, dirs, creados: hechos });
        // Toda observación tiene autor (`createdBy` es obligatorio) y el suyo es
        // quien escaneó. Un escaneo sin autor —no los hay hoy— se queda sin
        // observación y se dice, en vez de tumbar la ficha entera.
        const puedeObservar = Boolean(material.hoja && doc.createdBy);
        const obs = puedeObservar
          ? await asegurarObservacion(paciente, doc, { fecha, hoja: material.hoja, dirs, creados: hechos })
          : { creado: false };

        const resumen = {
          ficha: etiqueta,
          paciente: String(paciente._id),
          nombre: `${paciente.firstName} ${paciente.lastName}`.trim(),
          cedula: paciente.cedula,
          fecha,
          dudas,
          seguimiento: seg.creado,
          observacion: obs.creado,
          sinHoja: puedeObservar ? '' : material.motivoSinHoja || 'el escaneo no dice quién lo hizo',
        };
        if (hechos.paciente) creados.push(resumen);
        else fusionados.push(resumen);
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

  return { creados, fusionados, omitidos, errores };
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
const TASK_KEY = 'importar-fichas-escaneadas-2026-08-31';
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

function informe({ creados, fusionados, omitidos, errores }, commit) {
  const conDudas = creados.filter((c) => c.dudas.length);
  const conObservacion = [...creados, ...fusionados].filter((c) => (commit ? c.observacion : c.hoja));
  console.log('\n─── RESULTADO ────────────────────────────────────────────────');
  console.log(`${commit ? 'Pacientes creados' : 'Se crearían'}: ${creados.length}`);
  console.log(`  · sin ninguna duda: ${creados.length - conDudas.length}`);
  console.log(`  · a revisar a mano: ${conDudas.length}`);
  console.log(`Fichas de pacientes que ya existían: ${fusionados.length}`);
  console.log(`Observaciones con la hoja de seguimiento: ${conObservacion.length}`);
  console.log(`Omitidos: ${omitidos.length}`);
  console.log(`Errores:  ${errores.length}`);

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
