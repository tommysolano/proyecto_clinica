/**
 * Carga masiva por plantillas Excel para Marketing:
 *   - Plantillas de mensaje (MessageTemplate): se suben como BORRADOR; luego se
 *     revisan y se envían a Meta una por una desde la página de Plantillas.
 *   - Automatizaciones (Workflow): se suben INACTIVAS; se revisan y se activan
 *     manualmente. Formato multi-paso: varias filas por automatización, agrupadas
 *     por `nombre`; cada fila es un paso (mensaje / plantilla / espera / etiqueta…).
 *
 * Endpoints:
 *   GET  /message-templates/bulk/template  → descarga plantilla_plantillas_whatsapp.xlsx
 *   POST /message-templates/bulk           → sube el Excel lleno (multipart `file`)
 *   GET  /workflows/bulk/template          → descarga plantilla_automatizaciones.xlsx
 *   POST /workflows/bulk                    → sube el Excel lleno (multipart `file`)
 *
 * Reutiliza el mismo patrón de dataImportController (plantilla con hoja de
 * Instrucciones, alias de encabezados, lectura tolerante de celdas).
 */
const ExcelJS = require('exceljs');
const multer = require('multer');
const MessageTemplate = require('../models/MessageTemplate');
const Workflow = require('../models/Workflow');

exports.uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
}).single('file');

// ─── Helpers compartidos (mismos que dataImportController) ───────────────────
const norm = (s) => String(s ?? '')
  .trim().toUpperCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

const cellValue = (v) => {
  if (v && typeof v === 'object' && 'result' in v) v = v.result; // fórmula
  if (v && typeof v === 'object' && 'text' in v) v = v.text;     // rich text / link
  if (v && typeof v === 'object' && 'hyperlink' in v) v = v.text || v.hyperlink;
  return v;
};

const str = (v) => {
  const c = cellValue(v);
  return c === null || c === undefined ? '' : String(c).trim();
};

async function loadWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    const err = new Error('No se pudo leer el archivo Excel. Ábrelo en Excel/Google Sheets/LibreOffice, guárdalo de nuevo como .xlsx y vuelve a subirlo.');
    err.status = 400;
    throw err;
  }
  const ws = wb.worksheets[0];
  if (!ws) { const err = new Error('El archivo no tiene hojas'); err.status = 400; throw err; }
  return ws;
}

/** Mapea la fila 1 (encabezados) a claves usando alias normalizados. */
function mapHeaders(ws, aliases) {
  const lookup = new Map();
  for (const [key, list] of Object.entries(aliases)) for (const a of list) lookup.set(norm(a), key);
  const headerMap = {};
  ws.getRow(1).eachCell((cell, col) => {
    const key = lookup.get(norm(cellValue(cell.value)));
    if (key) headerMap[col] = key;
  });
  return headerMap;
}

/** Convierte las filas (desde la 2) en objetos { key: valor } + n° de fila. */
function rowsToObjects(ws, headerMap) {
  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const data = {};
    let hasData = false;
    Object.entries(headerMap).forEach(([col, key]) => {
      const v = cellValue(row.getCell(parseInt(col)).value);
      if (v !== null && v !== undefined && String(v).trim() !== '') hasData = true;
      data[key] = v;
    });
    if (hasData) rows.push({ __row: r, ...data });
  }
  return rows;
}

function templateWorkbook({ sheetName, columns, examples, instructions }) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
  (examples || []).forEach((ex) => ws.addRow(ex));
  const help = wb.addWorksheet('Instrucciones');
  help.getColumn(1).width = 130;
  (instructions || []).forEach((line) => help.addRow([line]));
  help.addRow(['No borre la fila de encabezados. Puede borrar la(s) fila(s) de ejemplo.']);
  return wb;
}

async function sendTemplate(res, filename, wbDef) {
  const wb = templateWorkbook(wbDef);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

// Nombre válido de plantilla WhatsApp (igual que messageTemplateController.create).
const normTemplateName = (name) => String(name).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');

// Variables {{...}} usadas en el cuerpo (para documentarlas).
function extractVariables(body = '') {
  const found = new Map();
  const re = /\{\{\s*([\w]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(body))) if (!found.has(m[1])) found.set(m[1], { key: m[1], example: '' });
  return [...found.values()];
}

// ─── PLANTILLAS DE MENSAJE ───────────────────────────────────────────────────
const PLANTILLA_ALIASES = {
  name: ['nombre', 'name'],
  language: ['idioma', 'language', 'lang'],
  category: ['categoria', 'category'],
  body: ['cuerpo', 'mensaje', 'body', 'texto', 'contenido'],
  footer: ['pie', 'footer'],
  headerText: ['encabezado', 'header', 'titulo', 'title'],
  button1: ['boton1', 'boton 1', 'button1', 'boton'],
  button2: ['boton2', 'boton 2', 'button2'],
  button3: ['boton3', 'boton 3', 'button3'],
};

const CATEGORY_MAP = {
  MARKETING: 'MARKETING', MERCADEO: 'MARKETING', PROMOCION: 'MARKETING',
  UTILITY: 'UTILITY', UTILIDAD: 'UTILITY',
  AUTHENTICATION: 'AUTHENTICATION', AUTENTICACION: 'AUTHENTICATION', OTP: 'AUTHENTICATION',
};

const plantillasTemplateDef = {
  sheetName: 'Plantillas',
  columns: [
    { header: 'nombre', key: 'name', width: 28 },
    { header: 'idioma', key: 'language', width: 10 },
    { header: 'categoria', key: 'category', width: 16 },
    { header: 'cuerpo', key: 'body', width: 60 },
    { header: 'pie', key: 'footer', width: 24 },
    { header: 'encabezado', key: 'headerText', width: 24 },
    { header: 'boton1', key: 'button1', width: 16 },
    { header: 'boton2', key: 'button2', width: 16 },
    { header: 'boton3', key: 'button3', width: 16 },
  ],
  examples: [
    { name: 'recordatorio_cita', language: 'es', category: 'UTILITY', body: 'Hola {{1}}, te recordamos tu cita para el {{2}}. ¡Te esperamos!', footer: 'Clínica Shiluv', headerText: '', button1: 'Confirmar', button2: 'Reagendar', button3: '' },
    { name: 'promo_bienvenida', language: 'es', category: 'MARKETING', body: '¡Hola {{1}}! Gracias por escribirnos. Este mes tenemos 20% de descuento en tu primera valoración.', footer: '', headerText: '¡Bienvenido!', button1: 'Quiero mi cita', button2: '', button3: '' },
  ],
  instructions: [
    'PLANTILLAS DE MENSAJE (WhatsApp) — carga masiva.',
    'Cada fila crea UNA plantilla en estado BORRADOR. Luego la revisas y la envías a Meta desde Marketing → Plantillas (botón "Enviar a Meta"). Meta la aprueba o rechaza.',
    '',
    'Columnas:',
    '- nombre: obligatorio. Solo minúsculas, números y guion bajo (los espacios/símbolos se convierten en "_"). Ej: recordatorio_cita',
    '- idioma: código del idioma. Por defecto "es".',
    '- categoria: MARKETING (promociones), UTILITY (recordatorios/avisos) o AUTHENTICATION (códigos). Por defecto MARKETING.',
    '- cuerpo: obligatorio. El texto del mensaje. Variables posicionales estilo Meta: {{1}}, {{2}}, ... (se detectan solas).',
    '- pie: texto pequeño al pie (opcional).',
    '- encabezado: título de texto arriba del mensaje (opcional).',
    '- boton1 / boton2 / boton3: botones de respuesta rápida (opcional). Solo el texto del botón.',
    '',
    'Si ya existe una plantilla con ese nombre, la fila se OMITE (no se duplica).',
  ],
};

async function importPlantillas(rows, clinicId, userId) {
  const result = { total: rows.length, created: 0, skipped: 0, errors: [], warnings: [] };
  for (const row of rows) {
    const rawName = str(row.name);
    const body = str(row.body);
    if (!rawName) { result.errors.push(`Fila ${row.__row}: falta el nombre de la plantilla`); continue; }
    if (!body) { result.errors.push(`Fila ${row.__row}: falta el cuerpo/mensaje de la plantilla`); continue; }
    const name = normTemplateName(rawName);
    // eslint-disable-next-line no-await-in-loop
    const exists = await MessageTemplate.findOne({ clinic: clinicId, channel: 'whatsapp', name }).select('_id');
    if (exists) { result.skipped++; result.warnings.push(`Fila ${row.__row}: la plantilla "${name}" ya existe, se omitió.`); continue; }
    const buttons = ['button1', 'button2', 'button3']
      .map((k) => str(row[k]))
      .filter(Boolean)
      .map((text) => ({ type: 'quick_reply', text }));
    const headerText = str(row.headerText);
    try {
      // eslint-disable-next-line no-await-in-loop
      await MessageTemplate.create({
        clinic: clinicId,
        channel: 'whatsapp',
        name,
        language: str(row.language) || 'es',
        category: CATEGORY_MAP[norm(row.category)] || 'MARKETING',
        headerType: headerText ? 'text' : 'none',
        headerText,
        body,
        footer: str(row.footer),
        buttons,
        variables: extractVariables(body),
        status: 'draft',
        createdBy: userId,
      });
      result.created++;
    } catch (err) {
      if (err.code === 11000) { result.skipped++; result.warnings.push(`Fila ${row.__row}: la plantilla "${name}" ya existe, se omitió.`); }
      else result.errors.push(`Fila ${row.__row}: ${err.message}`);
    }
  }
  return result;
}

// ─── AUTOMATIZACIONES (Workflows) ────────────────────────────────────────────
const AUTO_ALIASES = {
  name: ['nombre', 'name', 'automatizacion'],
  folder: ['carpeta', 'folder'],
  trigger: ['disparador', 'trigger', 'evento'],
  keywords: ['palabras_clave', 'palabras clave', 'keywords', 'palabra clave'],
  step: ['paso', 'orden', 'step', 'n'],
  stepType: ['tipo_paso', 'tipo de paso', 'tipo', 'accion', 'step type'],
  content: ['contenido', 'mensaje', 'valor', 'content', 'texto', 'plantilla'],
  language: ['idioma', 'language', 'lang'],
};

// Disparador amable → tipo canónico del modelo Workflow.
const TRIGGER_MAP = {
  'NUEVA CONVERSACION': 'new_conversation',
  'CONVERSACION NUEVA': 'new_conversation',
  'MENSAJE ENTRANTE': 'inbound_message',
  'MENSAJE': 'inbound_message',
  'PALABRA CLAVE': 'keyword',
  'KEYWORD': 'keyword',
  'CITA AGENDADA': 'appointment_created',
  'CITA CREADA': 'appointment_created',
  'CITA CONFIRMADA': 'appointment_confirmed',
  'CITA REAGENDADA': 'appointment_rescheduled',
  'CITA ASISTIDA': 'appointment_attended',
  'CITA ATENDIDA': 'appointment_attended',
  'NO ASISTIO': 'appointment_no_show',
  'NO SHOW': 'appointment_no_show',
  'CITA CANCELADA': 'appointment_cancelled',
  'TRATAMIENTO ABANDONADO': 'treatment_abandoned',
  'CUMPLEANOS': 'patient_birthday',
  'CUMPLEANOS DEL PACIENTE': 'patient_birthday',
  'PACIENTE CREADO': 'patient_created',
  'VENTA': 'sale_created',
  'VENTA REGISTRADA': 'sale_created',
  'PAGO': 'payment_received',
  'PAGO RECIBIDO': 'payment_received',
  'COTIZACION ENVIADA': 'quotation_sent',
  'ETIQUETA ANADIDA': 'tag_added',
  'ETIQUETA AGREGADA': 'tag_added',
  'ANUNCIO': 'ctwa_ad',
  'ANUNCIO META': 'ctwa_ad',
};

const STEP_MAP = {
  MENSAJE: 'send_message', TEXTO: 'send_message', 'MENSAJE TEXTO': 'send_message',
  PLANTILLA: 'send_template',
  ESPERA: 'wait', ESPERAR: 'wait', 'ESPERA MINUTOS': 'wait',
  'ESPERA CITA': 'wait_until', 'ESPERAR CITA': 'wait_until', RECORDATORIO: 'wait_until', 'ANTES DE LA CITA': 'wait_until',
  ETIQUETA: 'add_tag', 'AGREGAR ETIQUETA': 'add_tag', 'ANADIR ETIQUETA': 'add_tag',
  'QUITAR ETIQUETA': 'remove_tag', 'REMOVER ETIQUETA': 'remove_tag',
  // "etapa" del Excel = crear/actualizar la oportunidad en esa etapa (el paso
  // create_opportunity sustituyó a move_stage y hace lo mismo, pero completo).
  ETAPA: 'create_opportunity', 'MOVER ETAPA': 'create_opportunity', OPORTUNIDAD: 'create_opportunity',
};

const STAGE_MAP = { NUEVO: 'nuevo', CONTACTADO: 'contactado', INTERESADO: 'interesado', AGENDADO: 'agendado', GANADO: 'ganado', PERDIDO: 'perdido' };

function resolveTrigger(raw) {
  const s = norm(raw);
  if (TRIGGER_MAP[s]) return TRIGGER_MAP[s];
  const canon = String(raw || '').trim().toLowerCase();
  if (Workflow.TRIGGER_TYPES.includes(canon)) return canon;
  return null;
}

// Construye un paso (workflowStepSchema) a partir de tipo + contenido. Devuelve
// null y empuja el error si algo no cuadra.
function buildStep(stepTypeRaw, contentRaw, languageRaw, rowNo, errors) {
  const t = STEP_MAP[norm(stepTypeRaw)];
  const text = str(contentRaw);
  if (!t) { errors.push(`Fila ${rowNo}: tipo de paso desconocido "${stepTypeRaw}". Usa: mensaje, plantilla, espera, espera_cita, etiqueta, quitar_etiqueta, etapa.`); return null; }
  if (t === 'send_message') {
    if (!text) { errors.push(`Fila ${rowNo}: el paso "mensaje" no tiene texto (columna contenido).`); return null; }
    return { type: 'send_message', body: text };
  }
  if (t === 'send_template') {
    if (!text) { errors.push(`Fila ${rowNo}: el paso "plantilla" no tiene nombre de plantilla (columna contenido).`); return null; }
    return { type: 'send_template', templateName: normTemplateName(text), templateLanguage: str(languageRaw) || 'es' };
  }
  if (t === 'wait') {
    const mins = Number(text);
    if (!Number.isFinite(mins) || mins <= 0) { errors.push(`Fila ${rowNo}: "espera" debe ser un número de minutos mayor a 0.`); return null; }
    return { type: 'wait', waitMinutes: Math.round(mins) };
  }
  if (t === 'wait_until') {
    const hours = Number(text);
    if (!Number.isFinite(hours) || hours <= 0) { errors.push(`Fila ${rowNo}: "espera_cita" debe ser un número de horas antes de la cita mayor a 0.`); return null; }
    return { type: 'wait_until', waitEvent: 'appointment_date', waitMode: 'offset', offsetMinutes: -Math.round(hours * 60) };
  }
  if (t === 'add_tag' || t === 'remove_tag') {
    if (!text) { errors.push(`Fila ${rowNo}: falta la etiqueta (columna contenido).`); return null; }
    return { type: t, tag: text };
  }
  if (t === 'create_opportunity') {
    const stage = STAGE_MAP[norm(text)];
    if (!stage) { errors.push(`Fila ${rowNo}: etapa desconocida "${text}". Usa: nuevo, contactado, interesado, agendado, ganado, perdido.`); return null; }
    return { type: 'create_opportunity', stage, ifExists: 'update' };
  }
  return null;
}

const automatizacionesTemplateDef = {
  sheetName: 'Automatizaciones',
  columns: [
    { header: 'nombre', key: 'name', width: 26 },
    { header: 'carpeta', key: 'folder', width: 16 },
    { header: 'disparador', key: 'trigger', width: 22 },
    { header: 'palabras_clave', key: 'keywords', width: 22 },
    { header: 'paso', key: 'step', width: 8 },
    { header: 'tipo_paso', key: 'stepType', width: 16 },
    { header: 'contenido', key: 'content', width: 50 },
    { header: 'idioma', key: 'language', width: 10 },
  ],
  examples: [
    { name: 'Bienvenida', folder: 'General', trigger: 'nueva_conversacion', keywords: '', step: 1, stepType: 'mensaje', content: '¡Hola {{nombre}}! Gracias por escribirnos. ¿En qué podemos ayudarte?', language: '' },
    { name: 'Bienvenida', folder: '', trigger: '', keywords: '', step: 2, stepType: 'espera', content: '60', language: '' },
    { name: 'Bienvenida', folder: '', trigger: '', keywords: '', step: 3, stepType: 'plantilla', content: 'promo_bienvenida', language: 'es' },
    { name: 'Precios', folder: 'Ventas', trigger: 'palabra_clave', keywords: 'precio,costo,valor', step: 1, stepType: 'mensaje', content: 'Nuestros precios varían según el tratamiento. ¿Cuál te interesa?', language: '' },
    { name: 'Recordatorio 24h', folder: 'Citas', trigger: 'cita_agendada', keywords: '', step: 1, stepType: 'espera_cita', content: '24', language: '' },
    { name: 'Recordatorio 24h', folder: '', trigger: '', keywords: '', step: 2, stepType: 'plantilla', content: 'recordatorio_cita', language: 'es' },
  ],
  instructions: [
    'AUTOMATIZACIONES (Workflows) — carga masiva multi-paso.',
    'Se suben INACTIVAS. Luego las revisas y las activas a mano en Marketing → Automatizaciones.',
    '',
    'Cada automatización usa VARIAS filas con el MISMO "nombre". Cada fila es un PASO, en el orden de la columna "paso" (o el orden en que aparecen).',
    'Los datos generales (carpeta, disparador, palabras_clave) se leen de la PRIMERA fila del grupo; en las demás filas puedes dejarlos vacíos.',
    '',
    'Columnas:',
    '- nombre: agrupa las filas de una misma automatización. Obligatorio en todas sus filas.',
    '- carpeta: carpeta donde se guarda (por defecto "General").',
    '- disparador: qué la inicia. Valores: nueva_conversacion, mensaje_entrante, palabra_clave, cita_agendada, cita_confirmada, cita_reagendada, cita_asistida, no_asistio, cita_cancelada, tratamiento_abandonado, cumpleanos, paciente_creado, venta, pago, cotizacion_enviada, etiqueta_anadida, anuncio.',
    '- palabras_clave: solo si el disparador es "palabra_clave". Varias separadas por coma. Ej: precio,costo,valor',
    '- paso: número de orden del paso (1, 2, 3...). Opcional; si lo dejas vacío se usa el orden de las filas.',
    '- tipo_paso: mensaje | plantilla | espera | espera_cita | etiqueta | quitar_etiqueta | etapa',
    '- contenido: depende del tipo de paso:',
    '     mensaje      → el texto a enviar (admite {{nombre}}, {{apellido}}, negrita *texto*, etc.)',
    '     plantilla    → el nombre EXACTO de una plantilla aprobada (para escribir fuera de la ventana de 24h)',
    '     espera       → número de MINUTOS a esperar',
    '     espera_cita  → número de HORAS antes de la cita (para recordatorios; requiere un disparador de cita)',
    '     etiqueta / quitar_etiqueta → el nombre de la etiqueta',
    '     etapa        → nuevo | contactado | interesado | agendado | ganado | perdido',
    '- idioma: solo para el paso "plantilla" (por defecto "es").',
    '',
    'Si ya existe una automatización con ese nombre, el grupo se OMITE (no se duplica).',
    'Para flujos con condiciones/ramas usa el editor visual; el Excel crea flujos lineales (paso tras paso).',
  ],
};

async function importAutomatizaciones(rows, clinicId, userId) {
  const result = { total: 0, created: 0, skipped: 0, errors: [], warnings: [] };

  // Agrupar por nombre (preservando el orden de aparición).
  const groups = new Map();
  for (const row of rows) {
    const name = str(row.name);
    if (!name) { result.errors.push(`Fila ${row.__row}: falta el nombre de la automatización.`); continue; }
    const key = name.toLowerCase();
    if (!groups.has(key)) groups.set(key, { name, rows: [] });
    groups.get(key).rows.push(row);
  }
  result.total = groups.size;

  const existing = new Set(
    (await Workflow.find({ clinic: clinicId }).select('name').lean()).map((w) => String(w.name).trim().toLowerCase())
  );
  const templateNames = new Set(
    (await MessageTemplate.find({ clinic: clinicId, channel: 'whatsapp' }).select('name').lean()).map((t) => t.name)
  );

  for (const { name, rows: grows } of groups.values()) {
    if (existing.has(name.toLowerCase())) {
      result.skipped++;
      result.warnings.push(`"${name}": ya existe una automatización con ese nombre, se omitió.`);
      continue;
    }
    const firstRowNo = grows[0].__row;
    const meta = grows.find((r) => str(r.trigger)) || grows[0];
    const triggerType = resolveTrigger(meta.trigger);
    if (!triggerType) {
      result.errors.push(`"${name}" (fila ${firstRowNo}): disparador inválido o faltante "${str(meta.trigger)}".`);
      continue;
    }
    const kwRaw = str(grows.find((r) => str(r.keywords))?.keywords);
    const keywords = kwRaw ? kwRaw.split(',').map((k) => k.trim()).filter(Boolean) : [];
    if (triggerType === 'keyword' && keywords.length === 0) {
      result.errors.push(`"${name}": el disparador "palabra clave" necesita palabras (columna palabras_clave).`);
      continue;
    }
    const folder = str(grows.find((r) => str(r.folder))?.folder) || 'General';

    // Pasos ordenados: por la columna "paso" si es numérica; si no, por orden de fila.
    const ordered = grows
      .map((r, idx) => ({ r, idx, ord: Number(str(r.step)) }))
      .sort((a, b) => {
        const ao = Number.isFinite(a.ord) && a.ord > 0 ? a.ord : a.idx + 1;
        const bo = Number.isFinite(b.ord) && b.ord > 0 ? b.ord : b.idx + 1;
        return ao - bo || a.idx - b.idx;
      });

    const steps = [];
    let hadError = false;
    for (const { r } of ordered) {
      const stepTypeRaw = str(r.stepType);
      if (!stepTypeRaw) continue; // fila sin paso (p.ej. solo metadatos): se ignora
      const step = buildStep(stepTypeRaw, r.content, r.language, r.__row, result.errors);
      if (!step) { hadError = true; continue; }
      if (step.type === 'send_template' && !templateNames.has(step.templateName)) {
        result.warnings.push(`"${name}": la plantilla "${step.templateName}" aún no existe; créala/apruébala antes de activar.`);
      }
      steps.push(step);
    }
    if (hadError) continue;
    if (steps.length === 0) { result.errors.push(`"${name}": no tiene pasos válidos.`); continue; }

    const trig = { type: triggerType, ...(keywords.length ? { keywords, matchType: 'contains' } : {}) };
    try {
      // eslint-disable-next-line no-await-in-loop
      await Workflow.create({
        clinic: clinicId,
        folder,
        name,
        active: false,
        trigger: trig,
        triggers: [trig],
        steps,
        nodes: [],
        edges: [],
        createdBy: userId,
      });
      existing.add(name.toLowerCase());
      result.created++;
    } catch (err) {
      result.errors.push(`"${name}": ${err.message}`);
    }
  }
  return result;
}

// ─── Endpoints ───────────────────────────────────────────────────────────────
exports.downloadPlantillasTemplate = async (req, res) => {
  try { await sendTemplate(res, 'plantilla_plantillas_whatsapp.xlsx', plantillasTemplateDef); }
  catch (err) { res.status(500).json({ message: 'Error al generar la plantilla', error: err.message }); }
};

exports.downloadAutomatizacionesTemplate = async (req, res) => {
  try { await sendTemplate(res, 'plantilla_automatizaciones.xlsx', automatizacionesTemplateDef); }
  catch (err) { res.status(500).json({ message: 'Error al generar la plantilla', error: err.message }); }
};

exports.importPlantillasExcel = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Sube el archivo Excel (.xlsx) lleno.' });
    const ws = await loadWorkbook(req.file.buffer);
    const headerMap = mapHeaders(ws, PLANTILLA_ALIASES);
    const keys = Object.values(headerMap);
    if (!keys.includes('name') || !keys.includes('body')) {
      return res.status(400).json({ message: 'La plantilla no tiene las columnas obligatorias (nombre, cuerpo). Descarga la plantilla oficial y úsala como base.' });
    }
    const rows = rowsToObjects(ws, headerMap);
    const result = await importPlantillas(rows, req.clinicId, req.user._id);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'Error al importar plantillas' });
  }
};

exports.importAutomatizacionesExcel = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Sube el archivo Excel (.xlsx) lleno.' });
    const ws = await loadWorkbook(req.file.buffer);
    const headerMap = mapHeaders(ws, AUTO_ALIASES);
    const keys = Object.values(headerMap);
    if (!keys.includes('name') || !keys.includes('trigger') || !keys.includes('stepType')) {
      return res.status(400).json({ message: 'La plantilla no tiene las columnas obligatorias (nombre, disparador, tipo_paso). Descarga la plantilla oficial y úsala como base.' });
    }
    const rows = rowsToObjects(ws, headerMap);
    const result = await importAutomatizaciones(rows, req.clinicId, req.user._id);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ message: err.message || 'Error al importar automatizaciones' });
  }
};
