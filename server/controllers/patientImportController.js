/**
 * Carga masiva de PACIENTES con su historia clínica.
 *
 *   GET  /api/patients/import-template  → plantilla .xlsx con 3 hojas de datos
 *   POST /api/patients/import           → sube la plantilla llena (multipart `file`)
 *
 * La plantilla trae:
 *   · Pacientes      — datos generales (una fila por paciente)
 *   · FichaClinica   — antecedentes patológicos personales/familiares (una fila por paciente)
 *   · Seguimientos   — consultas del formato MSP (VARIAS filas por paciente)
 *
 * Las tres hojas se enlazan por `identificacion` (cédula/RUC/pasaporte). Si un
 * paciente no tiene identificación, se enlaza por `nombres` + `apellidos`.
 *
 * Es idempotente en los pacientes (si la identificación ya existe, ACTUALIZA) y
 * en la ficha (se reescriben los antecedentes), pero los seguimientos se AGREGAN:
 * subir dos veces el mismo archivo duplicaría las consultas.
 */
const multer = require('multer');
const Patient = require('../models/Patient');
const ClinicalRecord = require('../models/ClinicalRecord');
const {
  ANTECEDENTES_CATEGORIAS,
  REVISION_SISTEMAS,
  EXAMEN_REGIONAL,
  EXAMEN_SISTEMICO,
} = require('../constants/mspCatalogs');
const { describeCie10 } = require('../utils/cie10Catalog');
const {
  norm,
  parseDate,
  parseNumber,
  loadWorkbookFull,
  findSheet,
  mapHeaders,
  rowsToObjects,
  buildTemplate,
  sendWorkbook,
} = require('../utils/excelImport');

exports.uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
}).single('file');

// ─── Hoja 1: Pacientes ───────────────────────────────────────────────────────

const PAC_ALIASES = {
  cedula: ['identificacion', 'cedula', 'documento', 'ruc', 'pasaporte'],
  firstName: ['nombres', 'nombre'],
  lastName: ['apellidos', 'apellido'],
  gender: ['genero', 'sexo'],
  email: ['email', 'correo'],
  phone: ['telefono', 'celular'],
  whatsapp: ['whatsapp'],
  birthDate: ['fecha nacimiento', 'fecha de nacimiento', 'fecha_nacimiento'],
  age: ['edad'],
  address: ['direccion'],
  source: ['como nos conocio', 'origen', 'fuente'],
  referredByName: ['referido por', 'quien lo refirio'],
  tags: ['etiquetas', 'tags'],
  notes: ['notas', 'observaciones'],
};

const PAC_COLUMNS = [
  { header: 'identificacion', key: 'cedula', width: 16 },
  { header: 'nombres', key: 'firstName', width: 22 },
  { header: 'apellidos', key: 'lastName', width: 22 },
  { header: 'genero', key: 'gender', width: 12 },
  { header: 'telefono', key: 'phone', width: 14 },
  { header: 'whatsapp', key: 'whatsapp', width: 14 },
  { header: 'email', key: 'email', width: 26 },
  { header: 'fecha_nacimiento', key: 'birthDate', width: 17 },
  { header: 'edad', key: 'age', width: 8 },
  { header: 'direccion', key: 'address', width: 30 },
  { header: 'como_nos_conocio', key: 'source', width: 18 },
  { header: 'referido_por', key: 'referredByName', width: 22 },
  { header: 'etiquetas', key: 'tags', width: 22 },
  { header: 'notas', key: 'notes', width: 30 },
];

// ─── Hoja 2: Ficha clínica ───────────────────────────────────────────────────

const FICHA_ALIASES = {
  cedula: ['identificacion', 'cedula', 'documento'],
  firstName: ['nombres', 'nombre'],
  lastName: ['apellidos', 'apellido'],
  patologicosPersonales: ['antecedentes personales', 'antecedentes patologicos personales'],
  datosRelevantes: ['datos relevantes personales', 'datos relevantes', 'detalle personales'],
  patologicosFamiliares: ['antecedentes familiares', 'antecedentes patologicos familiares'],
  datosRelevantesFamiliares: ['datos relevantes familiares', 'detalle familiares'],
};

const FICHA_COLUMNS = [
  { header: 'identificacion', key: 'cedula', width: 16 },
  { header: 'nombres', key: 'firstName', width: 20 },
  { header: 'apellidos', key: 'lastName', width: 20 },
  { header: 'antecedentes_personales', key: 'patologicosPersonales', width: 40 },
  { header: 'datos_relevantes_personales', key: 'datosRelevantes', width: 45 },
  { header: 'antecedentes_familiares', key: 'patologicosFamiliares', width: 40 },
  { header: 'datos_relevantes_familiares', key: 'datosRelevantesFamiliares', width: 45 },
];

// ─── Hoja 3: Seguimientos ────────────────────────────────────────────────────

const SEG_ALIASES = {
  cedula: ['identificacion', 'cedula', 'documento'],
  firstName: ['nombres', 'nombre'],
  lastName: ['apellidos', 'apellido'],
  fecha: ['fecha', 'fecha consulta'],
  tipoConsulta: ['tipo consulta', 'tipo de consulta'],
  motivo: ['motivo de consulta', 'motivo', 'descripcion'],
  enfermedadActual: ['enfermedad actual', 'enfermedad o problema actual'],
  hora: ['hora'],
  bloodPressure: ['presion arterial', 'tension arterial', 'ta'],
  heartRate: ['frecuencia cardiaca', 'fc', 'pulso'],
  respiratoryRate: ['frecuencia respiratoria', 'fr'],
  temperature: ['temperatura'],
  oxygenSaturation: ['saturacion', 'saturacion oxigeno', 'sat o2'],
  weight: ['peso'],
  height: ['talla', 'estatura'],
  abdominalPerimeter: ['perimetro abdominal'],
  capillaryHemoglobin: ['hemoglobina capilar', 'hemoglobina'],
  glucose: ['glucosa'],
  revisionSistemas: ['revision de sistemas', 'revision organos y sistemas', 'revision sistemas'],
  revisionSistemasHallazgos: ['hallazgos revision', 'hallazgos de la revision'],
  examenRegional: ['examen fisico regional', 'examen regional'],
  examenSistemico: ['examen fisico sistemico', 'examen sistemico'],
  examenHallazgos: ['hallazgos examen fisico', 'hallazgos del examen fisico'],
  diagnosticos: ['diagnosticos', 'diagnosticos cie10', 'cie10', 'cie 10'],
  planTratamiento: ['plan de tratamiento', 'plan tratamiento', 'tratamiento'],
};

const SEG_COLUMNS = [
  { header: 'identificacion', key: 'cedula', width: 16 },
  { header: 'nombres', key: 'firstName', width: 18 },
  { header: 'apellidos', key: 'lastName', width: 18 },
  { header: 'fecha', key: 'fecha', width: 12 },
  { header: 'tipo_consulta', key: 'tipoConsulta', width: 14 },
  { header: 'motivo_de_consulta', key: 'motivo', width: 30 },
  { header: 'enfermedad_actual', key: 'enfermedadActual', width: 40 },
  { header: 'hora', key: 'hora', width: 8 },
  { header: 'presion_arterial', key: 'bloodPressure', width: 14 },
  { header: 'frecuencia_cardiaca', key: 'heartRate', width: 12 },
  { header: 'frecuencia_respiratoria', key: 'respiratoryRate', width: 12 },
  { header: 'temperatura', key: 'temperature', width: 11 },
  { header: 'saturacion', key: 'oxygenSaturation', width: 11 },
  { header: 'peso', key: 'weight', width: 9 },
  { header: 'talla', key: 'height', width: 9 },
  { header: 'perimetro_abdominal', key: 'abdominalPerimeter', width: 13 },
  { header: 'hemoglobina_capilar', key: 'capillaryHemoglobin', width: 13 },
  { header: 'glucosa', key: 'glucose', width: 10 },
  { header: 'revision_de_sistemas', key: 'revisionSistemas', width: 34 },
  { header: 'hallazgos_revision', key: 'revisionSistemasHallazgos', width: 40 },
  { header: 'examen_fisico_regional', key: 'examenRegional', width: 34 },
  { header: 'examen_fisico_sistemico', key: 'examenSistemico', width: 34 },
  { header: 'hallazgos_examen_fisico', key: 'examenHallazgos', width: 40 },
  { header: 'diagnosticos_cie10', key: 'diagnosticos', width: 30 },
  { header: 'plan_de_tratamiento', key: 'planTratamiento', width: 40 },
];

// ─── Parsers de celdas de lista ──────────────────────────────────────────────

/** Parte una celda "a ; b , c" en trozos limpios. */
const splitList = (v) => String(v ?? '')
  .split(/[;,|\n]/)
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Convierte una celda de lista en casillas MSP `[{ key, marked, detail }]`.
 * Acepta la etiqueta ("Cardiopatía") o la clave ("cardiopatia"), sin tildes ni
 * mayúsculas. Lo que no reconozca se devuelve en `unknown` para avisar.
 */
function parseChecks(value, catalog) {
  const byNorm = new Map();
  for (const c of catalog) {
    byNorm.set(norm(c.key), c.key);
    byNorm.set(norm(c.label), c.key);
  }
  const checks = [];
  const unknown = [];
  const seen = new Set();
  for (const raw of splitList(value)) {
    const key = byNorm.get(norm(raw));
    if (!key) { unknown.push(raw); continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    checks.push({ key, marked: true, detail: '' });
  }
  return { checks, unknown };
}

/**
 * Convierte una celda "E11.9 ; I10" en diagnósticos con su descripción oficial.
 * También acepta "E11.9 - texto libre" (el texto queda como descripción propia).
 */
function parseDiagnosticos(value) {
  const out = [];
  const unknown = [];
  for (const raw of splitList(value).slice(0, 6)) {
    const m = String(raw).match(/^([A-Za-z]\d{2}\.?\d?)\s*[-–:]?\s*(.*)$/);
    const cie = m ? m[1].toUpperCase() : '';
    const libre = m ? m[2].trim() : String(raw).trim();
    const oficial = cie ? describeCie10(cie) : '';
    if (cie && !oficial) unknown.push(cie);
    out.push({
      descripcion: libre || oficial,
      cie: oficial ? cie : '',
      cieDescripcion: oficial,
      presuntivo: false,
      definitivo: !!oficial,
    });
  }
  return { diagnosticos: out.filter((d) => d.descripcion || d.cie), unknown };
}

// ─── Plantilla ───────────────────────────────────────────────────────────────

const labels = (catalog) => catalog.map((c) => c.label);

exports.downloadTemplate = async (req, res) => {
  try {
    const wb = buildTemplate({
      sheets: [
        {
          name: 'Pacientes',
          columns: PAC_COLUMNS,
          examples: [{
            cedula: '0923456789', firstName: 'ANA', lastName: 'SUÁREZ', gender: 'femenino',
            phone: '0991234567', email: 'ana@mail.com', birthDate: '14/03/1988',
            address: 'Av. Principal 123', source: 'recepcion', tags: 'vip; control anual',
          }],
        },
        {
          name: 'FichaClinica',
          columns: FICHA_COLUMNS,
          examples: [{
            cedula: '0923456789',
            patologicosPersonales: 'Hipertensión; Endócrino Metabólico',
            datosRelevantes: 'Cesárea 2015. Alérgica a penicilina.',
            patologicosFamiliares: 'Cardiopatía; Cáncer',
            datosRelevantesFamiliares: 'Padre con infarto a los 60. Madre con cáncer de mama.',
          }],
        },
        {
          name: 'Seguimientos',
          columns: SEG_COLUMNS,
          examples: [{
            cedula: '0923456789', fecha: '05/02/2026', tipoConsulta: 'primera',
            motivo: 'Control de presión', enfermedadActual: 'Cefalea de 3 días, sin fiebre.',
            hora: '09:30', bloodPressure: '140/90', heartRate: 82, respiratoryRate: 18,
            temperature: 36.6, oxygenSaturation: 97, weight: 68, height: 162, glucose: 95,
            revisionSistemas: 'Cardio - vascular; Nervioso',
            revisionSistemasHallazgos: 'Refiere palpitaciones ocasionales.',
            examenRegional: 'Cabeza; Cuello',
            examenSistemico: 'Cardio - vascular',
            examenHallazgos: 'Ruidos cardíacos rítmicos, sin soplos.',
            diagnosticos: 'I10; G44.2',
            planTratamiento: 'Losartán 50mg cada 24h. Control en 30 días.',
          }],
        },
      ],
      instructions: [
        'CARGA MASIVA DE PACIENTES — el archivo tiene TRES hojas de datos que se llenan por separado.',
        '',
        'ENLACE ENTRE HOJAS: las hojas FichaClinica y Seguimientos se enlazan con la hoja Pacientes por la',
        'columna "identificacion". Si el paciente no tiene identificación, escriba nombres y apellidos EXACTOS',
        'en las tres hojas y el sistema los enlaza por nombre.',
        '',
        '1) HOJA "Pacientes" — una fila por paciente.',
        '   Obligatorios: nombres, apellidos y genero (masculino / femenino / otro).',
        '   Si la identificación ya existe en el sistema, la fila ACTUALIZA ese paciente (no lo duplica).',
        '   como_nos_conocio: anuncio, referido, recepcion u organico.',
        '   etiquetas: varias separadas por ";".  Fechas: dd/mm/aaaa.',
        '',
        '2) HOJA "FichaClinica" — una fila por paciente (opcional).',
        '   antecedentes_personales / antecedentes_familiares: escriba los que apliquen separados por ";".',
        '   Los valores válidos están en la hoja "Catalogos". El detalle va en las columnas datos_relevantes.',
        '',
        '3) HOJA "Seguimientos" — VARIAS filas por paciente (una por consulta).',
        '   Obligatorios: identificacion (o nombres+apellidos) y fecha.',
        '   tipo_consulta: primera o subsecuente.',
        '   revision_de_sistemas / examen_fisico_regional / examen_fisico_sistemico: valores de "Catalogos"',
        '   separados por ";". Lo descrito va en las columnas de hallazgos.',
        '   diagnosticos_cie10: uno o varios códigos separados por ";" (ej. "I10; E11.9"). El sistema pone el',
        '   nombre oficial del código. Máximo 6 por consulta.',
        '',
        'IMPORTANTE: los seguimientos se AGREGAN. Si sube el mismo archivo dos veces, las consultas se duplican.',
      ],
      catalogs: {
        'Antecedentes (personales y familiares)': labels(ANTECEDENTES_CATEGORIAS),
        'Revisión de órganos y sistemas': labels(REVISION_SISTEMAS),
        'Examen físico — regional': labels(EXAMEN_REGIONAL),
        'Examen físico — sistémico': labels(EXAMEN_SISTEMICO),
        'Género': ['masculino', 'femenino', 'otro'],
        'Tipo de consulta': ['primera', 'subsecuente'],
        '¿Cómo nos conoció?': ['anuncio', 'referido', 'recepcion', 'organico'],
      },
    });
    await sendWorkbook(res, 'plantilla_pacientes_historia_clinica.xlsx', wb);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ message: e.message });
  }
};

// ─── Importación ─────────────────────────────────────────────────────────────

/** Lee una hoja opcional del libro y devuelve sus filas como objetos. */
function readSheet(wb, name, aliases) {
  const ws = findSheet(wb, name);
  if (!ws) return { rows: [], present: false };
  return { rows: rowsToObjects(ws, mapHeaders(ws, aliases)), present: true };
}

/** Clave de enlace: la identificación si existe; si no, "NOMBRES APELLIDOS". */
const linkKey = (r) => {
  const ced = String(r.cedula ?? '').trim();
  if (ced) return `C:${ced}`;
  const name = norm(`${r.firstName ?? ''} ${r.lastName ?? ''}`);
  return name ? `N:${name}` : '';
};

exports.importPatients = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Archivo requerido (campo file)' });
    const wb = await loadWorkbookFull(req.file.buffer);

    const pac = readSheet(wb, 'Pacientes', PAC_ALIASES);
    const fic = readSheet(wb, 'FichaClinica', FICHA_ALIASES);
    const seg = readSheet(wb, 'Seguimientos', SEG_ALIASES);

    if (!pac.present && !fic.present && !seg.present) {
      return res.status(400).json({
        message: 'El archivo no tiene las hojas esperadas (Pacientes, FichaClinica, Seguimientos). Descarga la plantilla oficial y úsala como base.',
      });
    }
    if (!pac.rows.length && !fic.rows.length && !seg.rows.length) {
      return res.status(400).json({ message: 'El archivo no tiene filas con datos' });
    }

    const errors = [];
    const warnings = [];
    let created = 0;
    let updated = 0;
    let fichas = 0;
    let seguimientos = 0;

    // Índice clave de enlace → paciente (se llena con lo creado y con búsquedas).
    const index = new Map();
    const remember = (p) => {
      if (p.cedula) index.set(`C:${String(p.cedula).trim()}`, p);
      const n = norm(`${p.firstName} ${p.lastName}`);
      if (n) index.set(`N:${n}`, p);
    };

    // ── Hoja 1: pacientes ────────────────────────────────────────────────────
    for (const r of pac.rows) {
      const cedula = String(r.cedula ?? '').trim();
      const firstName = String(r.firstName ?? '').trim().toUpperCase();
      const lastName = String(r.lastName ?? '').trim().toUpperCase();
      if (!firstName || !lastName) {
        errors.push(`Pacientes, fila ${r.__row}: nombres y apellidos son obligatorios`);
        continue;
      }
      const gender = String(r.gender ?? '').trim().toLowerCase();
      if (!['masculino', 'femenino', 'otro'].includes(gender)) {
        errors.push(`Pacientes, fila ${r.__row} (${firstName} ${lastName}): genero debe ser masculino, femenino u otro`);
        continue;
      }

      const fields = { firstName, lastName, gender };
      if (r.email) fields.email = String(r.email).trim();
      if (r.phone) fields.phone = String(r.phone).trim();
      if (r.whatsapp) fields.whatsapp = String(r.whatsapp).trim();
      if (r.address) fields.address = String(r.address).trim();
      if (r.notes) fields.notes = String(r.notes).trim();
      const birth = parseDate(r.birthDate);
      if (birth) fields.birthDate = birth;
      const age = parseNumber(r.age);
      if (age !== null && age >= 0 && age <= 150) fields.age = age;
      const source = String(r.source ?? '').trim().toLowerCase();
      if (['anuncio', 'referido', 'recepcion', 'organico'].includes(source)) fields.source = source;
      else if (source) warnings.push(`Pacientes, fila ${r.__row}: "${source}" no es un origen válido — se dejó sin especificar`);
      if (r.referredByName) fields.referredByName = String(r.referredByName).trim();
      const tags = splitList(r.tags);
      if (tags.length) fields.tags = tags;

      try {
        // La cédula de paciente es única GLOBAL (no por clínica).
        const prev = cedula ? await Patient.findOne({ cedula }) : null;
        if (prev) {
          Object.assign(prev, fields);
          await prev.save();
          updated++;
          remember(prev);
        } else {
          if (!cedula) warnings.push(`Pacientes, fila ${r.__row} (${firstName} ${lastName}): sin identificación — se creó un paciente nuevo (no se puede detectar si ya existía)`);
          const p = await Patient.create({ clinic: req.clinicId, cedula, ...fields });
          created++;
          remember(p);
        }
      } catch (e) {
        errors.push(`Pacientes, fila ${r.__row} (${cedula || firstName}): ${e.message}`);
      }
    }

    /** Busca el paciente de una fila: primero lo importado, luego la base. */
    const findPatient = async (r, sheet) => {
      const key = linkKey(r);
      if (!key) {
        errors.push(`${sheet}, fila ${r.__row}: falta la identificación (o nombres y apellidos) del paciente`);
        return null;
      }
      if (index.has(key)) return index.get(key);
      let p = null;
      if (key.startsWith('C:')) p = await Patient.findOne({ cedula: key.slice(2) });
      else {
        const first = String(r.firstName ?? '').trim();
        const last = String(r.lastName ?? '').trim();
        if (first && last) {
          const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          p = await Patient.findOne({
            firstName: new RegExp(`^${esc(first)}$`, 'i'),
            lastName: new RegExp(`^${esc(last)}$`, 'i'),
          });
        }
      }
      if (!p) {
        errors.push(`${sheet}, fila ${r.__row}: no se encontró el paciente "${String(r.cedula ?? '').trim() || `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim()}". Agrégalo en la hoja Pacientes o revisa la identificación.`);
        return null;
      }
      remember(p);
      return p;
    };

    /** Ficha clínica del paciente (la crea si no existe en esta clínica). */
    const getRecord = async (patient) => {
      let rec = await ClinicalRecord.findOne({ clinic: req.clinicId, patient: patient._id });
      if (!rec) {
        rec = await ClinicalRecord.create({
          clinic: req.clinicId,
          patient: patient._id,
          fecha: new Date(),
          nombre: `${patient.firstName} ${patient.lastName}`.trim(),
          direccion: patient.address || '',
          edad: patient.age ?? 0,
          cedula: patient.cedula || '',
          celular: patient.phone || '',
          createdBy: req.user._id,
        });
      }
      return rec;
    };

    // ── Hoja 2: ficha clínica ────────────────────────────────────────────────
    for (const r of fic.rows) {
      const patient = await findPatient(r, 'FichaClinica');
      if (!patient) continue;
      try {
        const rec = await getRecord(patient);
        const per = parseChecks(r.patologicosPersonales, ANTECEDENTES_CATEGORIAS);
        const fam = parseChecks(r.patologicosFamiliares, ANTECEDENTES_CATEGORIAS);
        for (const u of [...per.unknown, ...fam.unknown]) {
          warnings.push(`FichaClinica, fila ${r.__row}: "${u}" no es un antecedente del catálogo — se ignoró`);
        }
        if (per.checks.length) rec.patologicosPersonales = per.checks;
        if (fam.checks.length) rec.patologicosFamiliares = fam.checks;
        if (r.datosRelevantes) rec.datosRelevantes = String(r.datosRelevantes).trim();
        if (r.datosRelevantesFamiliares) rec.datosRelevantesFamiliares = String(r.datosRelevantesFamiliares).trim();
        rec.updatedBy = req.user._id;
        await rec.save();
        fichas++;
      } catch (e) {
        errors.push(`FichaClinica, fila ${r.__row}: ${e.message}`);
      }
    }

    // ── Hoja 3: seguimientos ─────────────────────────────────────────────────
    for (const r of seg.rows) {
      const patient = await findPatient(r, 'Seguimientos');
      if (!patient) continue;
      const fecha = parseDate(r.fecha);
      if (!fecha) {
        errors.push(`Seguimientos, fila ${r.__row}: la fecha está vacía o no es válida (use dd/mm/aaaa)`);
        continue;
      }
      try {
        const rec = await getRecord(patient);
        const rev = parseChecks(r.revisionSistemas, REVISION_SISTEMAS);
        const reg = parseChecks(r.examenRegional, EXAMEN_REGIONAL);
        const sis = parseChecks(r.examenSistemico, EXAMEN_SISTEMICO);
        const dx = parseDiagnosticos(r.diagnosticos);
        for (const u of [...rev.unknown, ...reg.unknown, ...sis.unknown]) {
          warnings.push(`Seguimientos, fila ${r.__row}: "${u}" no está en el catálogo MSP — se ignoró`);
        }
        for (const u of dx.unknown) {
          warnings.push(`Seguimientos, fila ${r.__row}: el código CIE-10 "${u}" no existe — se guardó solo el texto`);
        }
        const tipo = String(r.tipoConsulta ?? '').trim().toLowerCase();

        rec.followUps.push({
          fecha,
          tipoConsulta: ['primera', 'subsecuente'].includes(tipo) ? tipo : '',
          descripcion: String(r.motivo ?? '').trim(),
          motivoConsulta: String(r.motivo ?? '').trim(),
          enfermedadActual: String(r.enfermedadActual ?? '').trim(),
          vitalSigns: {
            hora: String(r.hora ?? '').trim(),
            bloodPressure: String(r.bloodPressure ?? '').trim(),
            heartRate: parseNumber(r.heartRate),
            respiratoryRate: parseNumber(r.respiratoryRate),
            temperature: parseNumber(r.temperature),
            oxygenSaturation: parseNumber(r.oxygenSaturation),
            weight: parseNumber(r.weight),
            height: parseNumber(r.height),
            abdominalPerimeter: parseNumber(r.abdominalPerimeter),
            capillaryHemoglobin: parseNumber(r.capillaryHemoglobin),
            glucose: parseNumber(r.glucose),
          },
          revisionSistemas: rev.checks,
          revisionSistemasHallazgos: String(r.revisionSistemasHallazgos ?? '').trim(),
          examenFisico: {
            regional: reg.checks,
            sistemico: sis.checks,
            hallazgos: String(r.examenHallazgos ?? '').trim(),
          },
          diagnosticos: dx.diagnosticos,
          planTratamiento: String(r.planTratamiento ?? '').trim(),
          createdBy: req.user._id,
        });
        rec.updatedBy = req.user._id;
        await rec.save();
        seguimientos++;
      } catch (e) {
        errors.push(`Seguimientos, fila ${r.__row}: ${e.message}`);
      }
    }

    res.json({
      total: pac.rows.length + fic.rows.length + seg.rows.length,
      created,
      updated,
      fichas,
      seguimientos,
      errors,
      warnings,
    });
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};
