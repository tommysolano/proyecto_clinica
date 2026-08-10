/**
 * Utilidades compartidas de las cargas masivas por Excel (plantillas .xlsx):
 * normalización de encabezados, lectura de filas y armado/envío del libro.
 *
 * Las usan `dataImportController` (plan de cuentas, clientes, activos…) y
 * `patientImportController` (pacientes + ficha clínica + seguimientos).
 */
const ExcelJS = require('exceljs');

// Rango de diacríticos por escape (no con el carácter literal) para no depender
// de que el archivo se guarde en UTF-8.
const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g');

/** Texto comparable: sin tildes, en mayúsculas, con guiones/espacios unificados. */
const norm = (s) => String(s ?? '')
  .trim().toUpperCase()
  .normalize('NFD').replace(DIACRITICS, '')
  .replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

const parseBool = (v, def = false) => {
  const s = norm(v);
  if (!s) return def;
  return ['SI', 'S', 'TRUE', '1', 'X', 'YES'].includes(s);
};

const parseDate = (v) => {
  if (!v && v !== 0) return null;
  if (v instanceof Date) return v;
  const s = String(v).trim();
  // dd/mm/yyyy o dd-mm-yyyy
  let m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return new Date(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T12:00:00`);
  // yyyy-mm-dd
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T12:00:00`);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
};

/** Número o null (acepta coma decimal y celdas vacías). */
const parseNumber = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(',', '.').replace(/[^\d.-]/g, ''));
  return isNaN(n) ? null : n;
};

const cellValue = (v) => {
  if (v && typeof v === 'object' && 'result' in v) v = v.result; // fórmula
  if (v && typeof v === 'object' && 'text' in v) v = v.text;     // rich text / link
  if (v && typeof v === 'object' && 'hyperlink' in v) v = v.text || v.hyperlink;
  return v;
};

/** Abre el libro; `sheet` puede ser el nombre de una hoja (si no, la primera). */
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

/** Igual que `loadWorkbook` pero devuelve el libro completo (varias hojas). */
async function loadWorkbookFull(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    const err = new Error('No se pudo leer el archivo Excel. Ábrelo en Excel/Google Sheets/LibreOffice, guárdalo de nuevo como .xlsx y vuelve a subirlo.');
    err.status = 400;
    throw err;
  }
  if (!wb.worksheets.length) { const err = new Error('El archivo no tiene hojas'); err.status = 400; throw err; }
  return wb;
}

/** Busca una hoja por nombre (sin tildes ni mayúsculas). */
function findSheet(wb, name) {
  return wb.worksheets.find((w) => norm(w.name) === norm(name)) || null;
}

/** Mapea la fila 1 a claves usando alias normalizados. */
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

/** Da formato de encabezado (negrita + fondo verde) a la primera fila. */
function styleHeader(ws) {
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1FAE5' } };
}

/**
 * Libro de plantilla con VARIAS hojas de datos + hoja de Instrucciones y, si se
 * pasa, una hoja de catálogos (valores válidos para columnas de lista).
 *   sheets: [{ name, columns, examples: [{...}] }]
 */
function buildTemplate({ sheets, instructions = [], catalogs = null }) {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    ws.columns = s.columns;
    styleHeader(ws);
    (s.examples || []).forEach((ex) => ws.addRow(ex));
  }
  const help = wb.addWorksheet('Instrucciones');
  help.getColumn(1).width = 130;
  instructions.forEach((line) => help.addRow([line]));
  help.addRow(['No borre la fila de encabezados. Puede borrar la(s) fila(s) de ejemplo.']);
  if (catalogs) {
    const cat = wb.addWorksheet('Catalogos');
    cat.getColumn(1).width = 34;
    cat.getColumn(2).width = 80;
    cat.addRow(['LISTA', 'VALORES VÁLIDOS (separe varios con ; en la celda)']);
    styleHeader(cat);
    for (const [name, values] of Object.entries(catalogs)) cat.addRow([name, values.join(' ; ')]);
  }
  return wb;
}

/** Plantilla clásica de UNA hoja (compatibilidad con las plantillas existentes). */
function templateWorkbook({ sheetName, columns, example, instructions }) {
  return buildTemplate({
    sheets: [{ name: sheetName, columns, examples: example ? [example] : [] }],
    instructions,
  });
}

async function sendWorkbook(res, filename, wb) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

async function sendTemplate(res, filename, wbDef) {
  await sendWorkbook(res, filename, templateWorkbook(wbDef));
}

module.exports = {
  norm,
  parseBool,
  parseDate,
  parseNumber,
  cellValue,
  loadWorkbook,
  loadWorkbookFull,
  findSheet,
  mapHeaders,
  rowsToObjects,
  buildTemplate,
  templateWorkbook,
  sendWorkbook,
  sendTemplate,
};
