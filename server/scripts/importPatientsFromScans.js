#!/usr/bin/env node
/**
 * IMPORTAR PACIENTES DESDE LAS FICHAS FÍSICAS ESCANEADAS (/scanner).
 *
 * En "Mis documentos" del escáner hay PDF de fichas de "REGISTRO DE PACIENTES"
 * rellenadas a mano. Este script convierte cada una en un paciente con su ficha
 * clínica y un primer seguimiento que lleva el PDF adjunto, para que el doctor
 * pueda ver el original.
 *
 * ─── DE DÓNDE SALEN LOS DATOS ─────────────────────────────────────────────────
 * NO se leen aquí. El servidor NO llama a ninguna IA (decisión del usuario: sin
 * costo por uso). Los PDF los transcribe el asistente fuera del sistema y entrega
 * un JSON; este script solo lo valida y lo inserta. Procedimiento completo en
 * docs/IMPORTAR_FICHAS_ESCANEADAS.md.
 *
 *   node scripts/importPatientsFromScans.js --datos=../data/fichas-escaneadas.json
 *   node scripts/importPatientsFromScans.js --datos=… --commit
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
 * ─── LO QUE NO HACE, A PROPÓSITO ──────────────────────────────────────────────
 * NO DISPARA AUTOMATIZACIONES. Crea el paciente con el modelo directamente, no por
 * el controlador, así que el evento `patient_created` no se emite. Es deliberado:
 * importar de golpe un lote de pacientes antiguos no puede desatar una tanda de
 * mensajes de bienvenida a gente que se registró hace meses. Si algún día alguien
 * "arregla" esto haciéndolo pasar por el controlador, romperá esa garantía.
 *
 * NO BORRA NI MODIFICA NADA DEL ESCÁNER. El PDF se COPIA a storage/followups; el
 * original sigue intacto en storage/scans y en /scanner.
 *
 * NO RELLENA `whatsapp`. La ficha dice "celular" y eso va a `phone`. Dar por hecho
 * que ese número es WhatsApp metería a estos pacientes en el alcance de campañas
 * de marketing, y eso es una decisión del usuario, no de una importación.
 *
 * ─── SE PUEDE VOLVER A EJECUTAR ───────────────────────────────────────────────
 * Es idempotente por documento: si un escaneo ya generó paciente, se omite. Y si
 * algo falla a mitad de una ficha, se deshace lo que esa ficha hubiera creado
 * (paciente, historia y el PDF copiado) para que el reintento la haga limpia.
 */
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

const { connect, disconnect } = require('./_common');
const Patient = require('../models/Patient');
const ClinicalRecord = require('../models/ClinicalRecord');
const ScannedDocument = require('../models/ScannedDocument');
const { nameKeyOf, sanitizeName } = require('../utils/scanNames');
const { normalizarExtraccion, NOTA_SEGUIMIENTO } = require('../utils/scanPatientExtract');

const SCANS_DIR = path.join(__dirname, '..', 'storage', 'scans');
const FOLLOWUPS_DIR = path.join(__dirname, '..', 'storage', 'followups');

/** Misma clave que usa el escáner, para emparejar el PDF del ZIP con su ficha. */
const claveDocumento = (s) => nameKeyOf(sanitizeName(s));

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

// ─── Copia del PDF al almacén de adjuntos ────────────────────────────────────

/**
 * Copia el PDF del escáner a storage/followups con un nombre nuevo, igual que
 * haría una subida normal. El original NO se toca: se lee y se copia.
 */
async function copiarPdf(doc, { commit, dirs }) {
  const origen = path.join(dirs.scans, String(doc.clinic), doc.filename);
  const st = await fsp.stat(origen); // si el archivo no está, esta ficha falla y se reporta
  if (!commit) return { size: st.size, filename: null, destino: null };

  const dir = path.join(dirs.followups, String(doc.clinic));
  await fsp.mkdir(dir, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.pdf`;
  const destino = path.join(dir, filename);
  await fsp.copyFile(origen, destino);
  return { size: st.size, filename, destino };
}

// ─── Importación ─────────────────────────────────────────────────────────────

/**
 * Importa un lote de fichas ya transcritas.
 * @returns {{ creados:[], omitidos:[], errores:[] }}
 */
async function importarFichas({
  fichas,
  commit = false,
  clinic = null,
  dirs = { scans: SCANS_DIR, followups: FOLLOWUPS_DIR },
  log = () => {},
} = {}) {
  const idx = await indiceEscaneos(clinic);
  log(`Escaneos disponibles: ${idx.total}${clinic ? ' (solo esta sucursal)' : ''}`);

  const creados = [];
  const omitidos = [];
  const errores = [];
  // Dentro del propio lote también puede venir dos veces la misma cédula.
  const cedulasDelLote = new Set();

  for (const [i, ficha] of fichas.entries()) {
    const etiqueta = ficha.documento || ficha.scanId || `#${i + 1}`;

    const { doc, error } = resolverEscaneo(ficha, idx);
    if (error) { errores.push({ ficha: etiqueta, motivo: error }); continue; }

    const yaImportado = await Patient.findOne({ 'scanImport.scan': doc._id }).select('_id firstName lastName').lean();
    if (yaImportado) {
      omitidos.push({ ficha: etiqueta, motivo: 'el documento ya se importó', paciente: `${yaImportado.firstName} ${yaImportado.lastName}` });
      continue;
    }

    const norm = normalizarExtraccion(ficha);
    if (!norm.utilizable) {
      omitidos.push({ ficha: etiqueta, motivo: 'la ficha no tiene nombre ni apellido legibles' });
      continue;
    }

    // La cédula es única en toda la base: si ya existe, este paciente probablemente
    // está registrado. Importarlo daría un E11000 o un duplicado; mejor avisar.
    const { cedula } = norm.datos;
    if (cedula) {
      if (cedulasDelLote.has(cedula)) {
        omitidos.push({ ficha: etiqueta, motivo: `la cédula ${cedula} viene repetida dentro del mismo lote` });
        continue;
      }
      const existente = await Patient.findOne({ cedula }).select('_id firstName lastName').lean();
      if (existente) {
        omitidos.push({ ficha: etiqueta, motivo: `ya hay un paciente con la cédula ${cedula}`, paciente: `${existente.firstName} ${existente.lastName}` });
        continue;
      }
    }

    // Sin fecha legible se usa la del escaneo: es lo más cercano y queda marcado
    // como duda, así que en la revisión se corrige contra el PDF.
    const fecha = norm.datos.fecha || doc.createdAt || new Date();
    const dudas = norm.datos.fecha ? norm.dudas : [...new Set([...norm.dudas, 'fecha'])];

    let pdf = null;
    let paciente = null;
    let historia = null;
    try {
      pdf = await copiarPdf(doc, { commit, dirs });

      const datosPaciente = {
        clinic: doc.clinic,
        cedula,
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
      };

      if (!commit) {
        creados.push({ ficha: etiqueta, nombre: `${datosPaciente.firstName} ${datosPaciente.lastName}`, cedula, fecha, dudas });
        if (cedula) cedulasDelLote.add(cedula);
        continue;
      }

      paciente = await Patient.create(datosPaciente);
      historia = await ClinicalRecord.create({
        clinic: doc.clinic,
        patient: paciente._id,
        fecha,
        nombre: `${norm.datos.nombres} ${norm.datos.apellidos}`.trim(),
        direccion: norm.datos.direccion,
        edad: norm.datos.edad ?? undefined,
        cedula,
        celular: norm.datos.celular,
        createdBy: doc.createdBy || undefined,
        followUps: [{
          fecha,
          tipoConsulta: 'primera',
          observaciones: NOTA_SEGUIMIENTO,
          attachments: [{
            filename: pdf.filename,
            originalName: `${sanitizeName(doc.name)}.pdf`,
            mimeType: 'application/pdf',
            size: pdf.size,
            uploadedAt: new Date(),
            uploadedBy: doc.createdBy || undefined,
          }],
        }],
      });

      if (cedula) cedulasDelLote.add(cedula);
      creados.push({ ficha: etiqueta, paciente: String(paciente._id), nombre: paciente.fullName, cedula, fecha, dudas });
    } catch (e) {
      // Deshacer lo de ESTA ficha para que el reintento la haga desde cero. Un
      // paciente sin historia, o una historia apuntando a un PDF que no se copió,
      // es peor que no haberlo importado: nadie lo detecta a simple vista.
      if (historia) await ClinicalRecord.deleteOne({ _id: historia._id }).catch(() => {});
      if (paciente) await Patient.deleteOne({ _id: paciente._id }).catch(() => {});
      if (pdf?.destino) await fsp.unlink(pdf.destino).catch(() => {});
      errores.push({ ficha: etiqueta, motivo: e.message });
    }
  }

  return { creados, omitidos, errores };
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

function informe({ creados, omitidos, errores }, commit) {
  const conDudas = creados.filter((c) => c.dudas.length);
  console.log('\n─── RESULTADO ────────────────────────────────────────────────');
  console.log(`${commit ? 'Creados' : 'Se crearían'}: ${creados.length}`);
  console.log(`  · sin ninguna duda: ${creados.length - conDudas.length}`);
  console.log(`  · a revisar a mano: ${conDudas.length}`);
  console.log(`Omitidos: ${omitidos.length}`);
  console.log(`Errores:  ${errores.length}`);

  if (conDudas.length) {
    console.log('\nA revisar (aparecen en /patients → "Fichas por revisar"):');
    for (const c of conDudas) console.log(`  · ${c.nombre} — dudas en: ${c.dudas.join(', ')}`);
  }
  if (omitidos.length) {
    console.log('\nOmitidos:');
    for (const o of omitidos) console.log(`  · ${o.ficha}: ${o.motivo}${o.paciente ? ` (${o.paciente})` : ''}`);
  }
  if (errores.length) {
    console.log('\nErrores:');
    for (const e of errores) console.log(`  · ${e.ficha}: ${e.motivo}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const ruta = (args.find((a) => a.startsWith('--datos=')) || '').split('=')[1];
  const clinic = (args.find((a) => a.startsWith('--clinic=')) || '').split('=')[1] || null;

  if (!ruta) {
    console.error('Falta --datos=<ruta al JSON>. Ver docs/IMPORTAR_FICHAS_ESCANEADAS.md');
    process.exit(1);
  }

  const fichas = leerDatos(ruta);
  console.log('\n=== IMPORTAR PACIENTES DESDE FICHAS ESCANEADAS ===');
  console.log(`Fichas en el archivo: ${fichas.length}`);
  console.log(commit ? 'MODO: COMMIT (crea de verdad).' : 'MODO: DRY-RUN (no escribe nada). Usa --commit para aplicar.');

  await connect();
  try {
    const r = await importarFichas({ fichas, commit, clinic, log: (m) => console.log(m) });
    informe(r, commit);
  } finally {
    await disconnect();
  }
}

module.exports = { importarFichas, indiceEscaneos, resolverEscaneo, claveDocumento, NOTA_SEGUIMIENTO };

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
