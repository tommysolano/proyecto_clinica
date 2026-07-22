/**
 * Importación masiva de contactos desde Excel/CSV (asistente de 4 pasos).
 *
 * El flujo es el de Daplox, y el orden importa:
 *   1. POST /contacts/imports/analyze  → sube el archivo y devuelve sus CABECERAS
 *      con valores de muestra + un mapeo sugerido. No crea nada todavía.
 *   2. POST /contacts/imports          → el usuario confirma el mapeo, etiquetas y
 *      grupos; se crea el lote en 'pending'. Responde al instante.
 *   3. Un job procesa el lote en segundo plano y emite el progreso por socket.
 *
 * Se sube a DISCO (no a memoria ni a Mongo): un CSV de 30 MB en RAM tumbaría el
 * VPS, que además corre Chromium para los QR y los PDFs.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const mongoose = require('mongoose');
const ContactImport = require('../models/ContactImport');
const ContactGroup = require('../models/ContactGroup');
const Contact = require('../models/Contact');
const { readHeaders, isSupported } = require('../utils/contactFileReader');
const { suggestMapping, FIELD_OPTIONS } = require('../utils/contactRowMapper');
const { revertImport } = require('../utils/contactImportRunner');

// En server/storage (el patrón de la casa para lo que debe SOBREVIVIR deploys:
// certificados, adjuntos clínicos), NO en /tmp. El archivo se necesita minutos
// después de subirlo (lo procesa un job) y /tmp no garantiza nada en ese
// intervalo: el SO puede limpiarlo y un reinicio de pm2 a mitad de importación
// dejaba lotes en "el archivo ya no está en el servidor".
const UPLOAD_DIR = path.join(__dirname, '..', 'storage', 'contact_imports');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/** Barre subidas huérfanas (analizadas pero nunca confirmadas) de más de 24 h. */
function sweepOldUploads() {
  fs.promises
    .readdir(UPLOAD_DIR)
    .then((files) =>
      Promise.all(
        files.map(async (f) => {
          const p = path.join(UPLOAD_DIR, f);
          const st = await fs.promises.stat(p).catch(() => null);
          if (st && Date.now() - st.mtimeMs > 24 * 60 * 60 * 1000) {
            await fs.promises.unlink(p).catch(() => {});
          }
        })
      )
    )
    .catch(() => {});
}

// 30 MB, igual que Daplox.
exports.uploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) =>
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!isSupported(file.originalname)) {
      return cb(new Error('Formato no admitido: sube un archivo .xlsx, .csv o .tsv. Desde Google Sheets usa Archivo → Descargar → Microsoft Excel (.xlsx) o Valores separados por comas (.csv).'));
    }
    cb(null, true);
  },
}).single('file');

/**
 * Plantilla .xlsx para rellenar y volver a subir. Resuelve la duda de "¿qué
 * formato quiere el sistema?": ninguno en concreto —basta con que la primera fila
 * sean los títulos—, pero una plantilla lista quita toda fricción.
 *
 * Lo importante: la columna del TELÉFONO se marca como TEXTO (numFmt '@'). Es la
 * trampa nº 1 de estas importaciones — si Excel la trata como número, un
 * 0999111222 se guarda como 9,99E+08 y esa fila no se puede importar.
 */
exports.template = async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Contactos');

    ws.columns = [
      { header: 'Nombre', key: 'nombre', width: 18 },
      { header: 'Apellido', key: 'apellido', width: 20 },
      { header: 'Teléfono', key: 'telefono', width: 18 },
      { header: 'Correo', key: 'correo', width: 26 },
      { header: 'Sucursal', key: 'sucursal', width: 20 },
      { header: 'Hora de envío', key: 'hora', width: 14 },
      { header: 'Etiquetas', key: 'etiquetas', width: 24 },
    ];

    // Cabecera en negrita para que se vea que es la fila de títulos.
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
    });

    // Teléfono Y hora como TEXTO: si Excel trata "08:00" como hora, la guarda como
    // fracción de día (0,3333) y al importar salían "demasiados decimales". Como texto,
    // "08:00" se queda tal cual.
    ws.getColumn('telefono').numFmt = '@';
    ws.getColumn('hora').numFmt = '@';

    // Ejemplos: el teléfono y la hora van como STRING, no como número, para que
    // hereden el formato de texto y sirvan de guía de cómo escribirlos.
    const ejemplos = [
      { nombre: 'Emily', apellido: 'Torres Vera', telefono: '0999111222', correo: 'emily@correo.com', sucursal: 'Quito', hora: '08:00', etiquetas: 'feria-julio, interesada' },
      { nombre: 'Dome', apellido: '', telefono: '0988776655', correo: '', sucursal: 'Guayaquil', hora: '14:00', etiquetas: 'feria-julio' },
    ];
    ejemplos.forEach((e) => ws.addRow(e));

    // Hoja de instrucciones aparte, para no ensuciar los datos.
    const help = wb.addWorksheet('Instrucciones');
    help.getColumn(1).width = 90;
    const lines = [
      'Cómo usar esta plantilla',
      '',
      '1. Escribe un contacto por fila, debajo de los títulos de la hoja "Contactos".',
      '2. La única columna OBLIGATORIA es Teléfono. El resto son opcionales.',
      '3. El teléfono puede ir como 0999111222 o +593 99 911 1222: el sistema lo normaliza.',
      '4. Deja el teléfono con formato de TEXTO (ya viene así en la plantilla). Si Excel',
      '   lo convierte a número, un 0999111222 se vuelve 9,99E+08 y esa fila se descarta.',
      '5. Sucursal (opcional): escribe el NOMBRE de la sede a la que pertenece el contacto',
      '   (p. ej. Quito). No importan mayúsculas ni tildes. El contacto queda en esa sucursal',
      '   y el flujo de automatización puede tomar un camino distinto según la sede. Si la',
      '   dejas vacía o el nombre no coincide con ninguna sucursal, va a la sede por defecto.',
      '6. Hora de envío (opcional): la hora a la que quieres que le llegue el PRIMER mensaje',
      '   del workflow a ese contacto, en formato 24h HH:MM (p. ej. 08:00, 14:30). Escríbela',
      '   como TEXTO (ya viene así). Si ya pasó esa hora hoy, sale mañana a esa hora. Si la',
      '   dejas vacía, el contacto entra dentro de la franja normal (09:00–20:00).',
      '7. Puedes añadir tus propias columnas (Ciudad, Interés…): al importar decides a qué',
      '   campo va cada una, o las guardas como dato adicional del contacto.',
      '8. Borra estas dos filas de ejemplo antes de subir el archivo.',
    ];
    lines.forEach((t, i) => {
      const row = help.getRow(i + 1);
      row.getCell(1).value = t;
      if (i === 0) row.font = { bold: true, size: 14 };
    });

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_contactos_shiluv.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ message: 'No se pudo generar la plantilla', error: err.message });
  }
};

/** Paso 2 del asistente: analiza el archivo y propone el mapeo. */
exports.analyze = async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No se recibió ningún archivo' });
  sweepOldUploads(); // cada subida nueva limpia las huérfanas viejas
  try {
    const { headers, samples } = await readHeaders(req.file.path, req.file.originalname);
    if (!headers.length) {
      await fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ message: 'El archivo no tiene cabeceras: la primera fila debe ser el nombre de cada columna.' });
    }
    res.json({
      // El front devuelve esto al confirmar: así el archivo no se sube dos veces.
      uploadId: path.basename(req.file.path),
      fileName: req.file.originalname,
      fileSize: req.file.size,
      headers,
      samples,
      mapping: suggestMapping(headers),
      fieldOptions: FIELD_OPTIONS,
    });
  } catch (err) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    res.status(400).json({ message: `No se pudo leer el archivo: ${err.message}` });
  }
};

/** Paso 4: confirma y encola la importación. */
exports.create = async (req, res) => {
  try {
    const { uploadId, fileName, mapping, mode, tags, groups, whatsappOptIn, consentSource, workflows, dripSeconds } = req.body;
    // basename() evita que un uploadId manipulado ("../../etc/passwd") salga del
    // directorio de subidas.
    const filePath = path.join(UPLOAD_DIR, path.basename(String(uploadId || '')));
    if (!uploadId || !fs.existsSync(filePath)) {
      return res.status(400).json({ message: 'El archivo subido ya no está disponible. Vuelve a subirlo.' });
    }
    const map = Array.isArray(mapping) ? mapping : [];
    if (!map.some((m) => m.field === 'phone')) {
      return res.status(400).json({
        message: 'Debes asignar una columna al campo Teléfono: es lo que identifica a cada contacto.',
      });
    }

    const groupIds = (Array.isArray(groups) ? groups : []).filter((g) => mongoose.isValidObjectId(g));
    if (groupIds.length) {
      const found = await ContactGroup.countDocuments({ _id: { $in: groupIds }, clinic: req.clinicId, kind: 'static' });
      if (found !== groupIds.length) {
        return res.status(400).json({ message: 'Algún grupo no existe o es un grupo por filtro (esos se calculan solos).' });
      }
    }

    // Workflows elegidos: deben existir, estar ACTIVOS y tener el disparador
    // "Contactos importados". Se valida aquí y no en el runner: si no, el usuario
    // elige un workflow que nunca inscribe a nadie y parece que "no funciona".
    const workflowIds = (Array.isArray(workflows) ? workflows : []).filter((w) => mongoose.isValidObjectId(w));
    if (workflowIds.length) {
      const Workflow = require('../models/Workflow');
      const { matchingFlows } = require('../utils/workflowEngine');
      const docs = await Workflow.find({ _id: { $in: workflowIds }, clinic: req.clinicId });
      if (docs.length !== workflowIds.length) {
        return res.status(400).json({ message: 'Algún workflow elegido no existe.' });
      }
      for (const wf of docs) {
        if (!wf.active) {
          return res.status(400).json({ message: `El workflow "${wf.name}" está desactivado: actívalo antes de importar.` });
        }
        if (!matchingFlows(wf, (tr) => tr?.type === 'contact_import').length) {
          return res.status(400).json({
            message: `El workflow "${wf.name}" no tiene el disparador "Contactos importados (Excel)" con pasos conectados.`,
          });
        }
      }
    }

    const batch = await ContactImport.create({
      clinic: req.clinicId,
      fileName: fileName || 'contactos.csv',
      filePath,
      fileSize: fs.statSync(filePath).size,
      // El archivo vive en el disco de ESTA máquina: solo ella puede procesarlo.
      host: os.hostname(),
      status: 'pending',
      mapping: map.map((m) => ({
        column: String(m.column || ''),
        field: String(m.field || ''),
        skipEmpty: m.skipEmpty !== false,
      })),
      mode: ['upsert', 'create', 'update'].includes(mode) ? mode : 'upsert',
      // Goteo: segundos entre el arranque de un contacto y el siguiente (1s…1h).
      dripSeconds: Math.min(3600, Math.max(1, Number(dripSeconds) || 20)),
      tags: (Array.isArray(tags) ? tags : []).map((t) => String(t).trim()).filter(Boolean),
      groups: groupIds,
      workflows: workflowIds,
      whatsappOptIn: whatsappOptIn !== false,
      consentSource: String(consentSource || '').trim(),
      createdBy: req.user._id,
      createdByName: req.user.name,
    });
    // El job lo coge en el siguiente tick (máx. 1 min); no se espera aquí.
    res.status(201).json(batch);
  } catch (err) {
    res.status(500).json({ message: 'Error al crear la importación', error: err.message });
  }
};

/** Historial de importaciones (con su progreso). */
exports.list = async (req, res) => {
  try {
    const list = await ContactImport.find({ clinic: req.clinicId })
      .select('-filePath -mapping')
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.get = async (req, res) => {
  try {
    const batch = await ContactImport.findOne({ _id: req.params.id, clinic: req.clinicId }).select('-filePath');
    if (!batch) return res.status(404).json({ message: 'Importación no encontrada' });
    res.json(batch);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/** Deshacer: borra los contactos que creó ese lote. */
exports.revert = async (req, res) => {
  try {
    const batch = await ContactImport.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!batch) return res.status(404).json({ message: 'Importación no encontrada' });
    const r = await revertImport(batch._id);
    if (!r.ok) return res.status(409).json({ message: r.error });
    res.json(r);
  } catch (err) {
    res.status(500).json({ message: 'Error al deshacer', error: err.message });
  }
};

/** Informe de errores en CSV, para corregir el archivo y reintentar. */
exports.errorsCsv = async (req, res) => {
  try {
    const batch = await ContactImport.findOne({ _id: req.params.id, clinic: req.clinicId }).select('rowErrors fileName');
    if (!batch) return res.status(404).json({ message: 'Importación no encontrada' });
    const rows = [['fila', 'valor', 'motivo']];
    for (const e of batch.rowErrors || []) rows.push([e.row, e.value, e.reason]);
    const csv = rows
      .map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="errores_importacion.csv"`);
    res.send(`﻿${csv}`); // BOM: para que Excel respete los acentos
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/** Estimación previa: cuántos contactos hay ya con esos teléfonos. */
exports.stats = async (req, res) => {
  try {
    const total = await Contact.countDocuments({ clinic: req.clinicId });
    res.json({ total });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};
