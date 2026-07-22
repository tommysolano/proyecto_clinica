/**
 * Lectura de los archivos de contactos (CSV y XLSX) en STREAMING.
 *
 * Por qué streaming y no "cargar y recorrer": el caso real son ~47k contactos.
 * ExcelJS.load() o un readFile de un CSV de 30 MB se comen la RAM del VPS (que
 * además tiene Chromium corriendo para los QR y los PDFs). Aquí se lee fila a
 * fila y nunca hay más de una en memoria.
 *
 * Dos operaciones:
 *   - `readHeaders`  → cabeceras + valores de muestra, para pintar el paso
 *                      "Asignar" del asistente (columna → campo).
 *   - `iterateRows`  → recorre las filas ya convertidas a objeto { cabecera: valor }.
 *
 * Las cabeceras se devuelven TAL CUAL vienen del archivo: el usuario las mapea a
 * mano, así que no hace falta adivinarlas (el importador viejo de plantillas sí
 * exigía nombres fijos, y por eso no servía para un Excel cualquiera).
 */
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const ExcelJS = require('exceljs');

const SAMPLE_SIZE = 3; // igual que Daplox: 3 valores de muestra por columna

function extOf(fileName) {
  return path.extname(String(fileName || '')).toLowerCase();
}

// .tsv/.txt = valores separados por TAB (Google Sheets: Archivo → Descargar →
// Valores separados por tabuladores). Se leen por la misma vía que el CSV.
const TEXT_EXTS = ['.csv', '.tsv', '.txt'];
function isTextFile(fileName) {
  return TEXT_EXTS.includes(extOf(fileName));
}

function isSupported(fileName) {
  return [...TEXT_EXTS, '.xlsx', '.xls'].includes(extOf(fileName));
}

// Una celda de ExcelJS puede ser fórmula, rich text o hipervínculo.
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return cellText(v.text);
    if ('hyperlink' in v) return cellText(v.text || v.hyperlink);
    if (v instanceof Date) return v.toISOString();
    if ('richText' in v) return (v.richText || []).map((t) => t.text).join('');
  }
  return String(v).trim();
}

/** Cabeceras únicas y no vacías. Una columna sin título se nombra "Columna N". */
function normalizeHeaders(raw) {
  const seen = new Map();
  return raw.map((h, i) => {
    let name = cellText(h) || `Columna ${i + 1}`;
    // Dos columnas con el mismo título romperían el mapeo (se pisarían).
    if (seen.has(name)) {
      const n = seen.get(name) + 1;
      seen.set(name, n);
      name = `${name} (${n})`;
    } else {
      seen.set(name, 1);
    }
    return name;
  });
}

// ─────────────────────────── CSV / TSV ───────────────────────────

/**
 * Detecta el separador leyendo la PRIMERA línea del archivo. Google Sheets y Excel
 * exportan CSV con distintos separadores según el idioma del equipo: en configuraciones
 * donde la coma es el separador decimal, el CSV sale con PUNTO Y COMA, y forzar la
 * coma metía todas las columnas en una sola → "el archivo no tiene cabeceras". Se
 * elige el separador (coma, punto y coma o tab) más frecuente en la cabecera.
 */
function detectDelimiter(filePath, fileName) {
  // .tsv/.txt son por definición separados por tabulador.
  if (['.tsv', '.txt'].includes(extOf(fileName))) return '\t';
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    let text = buf.slice(0, n).toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
    const firstLine = text.split(/\r?\n/)[0] || '';
    const counts = { ',': 0, ';': 0, '\t': 0 };
    for (const ch of firstLine) if (ch in counts) counts[ch] += 1;
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return best && best[1] > 0 ? best[0] : ',';
  } catch {
    return ',';
  }
}

function csvStream(filePath, fileName = filePath) {
  return fs.createReadStream(filePath).pipe(
    parse({
      bom: true,               // Excel/Sheets exportan CSV con BOM y ensucia la 1ª cabecera
      delimiter: detectDelimiter(filePath, fileName), // coma, ';' o tab según el archivo
      relax_column_count: true, // filas con columnas de más/menos no rompen la importación
      relax_quotes: true,       // comillas sueltas de Sheets/Excel no abortan la lectura
      skip_empty_lines: true,
      trim: true,
    })
  );
}

async function csvHeaders(filePath, fileName = filePath) {
  const stream = csvStream(filePath, fileName);
  let headers = null;
  const samples = new Map();
  let rows = 0;
  for await (const record of stream) {
    if (!headers) {
      headers = normalizeHeaders(record);
      headers.forEach((h) => samples.set(h, []));
      continue;
    }
    rows++;
    if (rows <= SAMPLE_SIZE) {
      headers.forEach((h, i) => {
        const v = cellText(record[i]);
        if (v) samples.get(h).push(v);
      });
    }
    // No se cuenta el archivo entero solo para la vista previa: con las muestras
    // basta y evitamos leer 30 MB antes de que el usuario decida nada.
    if (rows >= 200) break;
  }
  stream.destroy();
  return { headers: headers || [], samples };
}

async function csvIterate(filePath, onRow, fileName = filePath) {
  const stream = csvStream(filePath, fileName);
  let headers = null;
  let rowNo = 1;
  for await (const record of stream) {
    if (!headers) {
      headers = normalizeHeaders(record);
      continue;
    }
    rowNo++;
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cellText(record[i]); });
    await onRow(obj, rowNo);
  }
}

// ─────────────────────────── XLSX ───────────────────────────

/**
 * OJO: el lector en streaming de exceljs 4.4.0 tiene un fallo que se manifiesta
 * como un error ALEATORIO (~1 de cada 4) al leer .xlsx: difería la hoja a un
 * temporal con `tmp.file()` (asíncrono), así que el .pipe() se enganchaba tarde y
 * se perdían datos de la entrada del zip. La iteración moría antes de leer
 * sharedStrings/workbook.xml y reventaba con "Cannot read properties of undefined
 * (reading 'sheets')". Está corregido en patches/exceljs+4.4.0.patch (patch-package
 * lo aplica solo en el postinstall). No quitar ese parche sin volver a probarlo en
 * bucle: un solo intento no reproduce el fallo.
 */
function xlsxReader(filePath) {
  return new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    entries: 'emit',
    sharedStrings: 'cache', // sin esto las celdas de texto llegan vacías
    worksheets: 'emit',
  });
}

async function xlsxHeaders(filePath) {
  const wb = xlsxReader(filePath);
  let headers = null;
  const samples = new Map();
  let rows = 0;
  for await (const worksheet of wb) {
    for await (const row of worksheet) {
      const values = row.values.slice(1); // ExcelJS indexa desde 1
      if (!headers) {
        headers = normalizeHeaders(values);
        headers.forEach((h) => samples.set(h, []));
        continue;
      }
      rows++;
      if (rows <= SAMPLE_SIZE) {
        headers.forEach((h, i) => {
          const v = cellText(values[i]);
          if (v) samples.get(h).push(v);
        });
      }
      if (rows >= 200) break;
    }
    break; // solo la primera hoja
  }
  return { headers: headers || [], samples };
}

async function xlsxIterate(filePath, onRow) {
  const wb = xlsxReader(filePath);
  let headers = null;
  let rowNo = 1;
  for await (const worksheet of wb) {
    for await (const row of worksheet) {
      const values = row.values.slice(1);
      if (!headers) {
        headers = normalizeHeaders(values);
        continue;
      }
      rowNo++;
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cellText(values[i]); });
      await onRow(obj, rowNo);
    }
    break;
  }
}

// ── Respaldo XLSX en carga completa ──
// El lector en STREAMING de exceljs es delicado con .xlsx generados por otras
// herramientas (Google Sheets, LibreOffice, exportadores) que omiten estructuras
// que exceljs espera (dimension, sharedStrings) → "Cannot read properties of
// undefined". Cargar el libro entero es más tolerante. Solo se usa como RESPALDO
// (y con archivos de tamaño razonable) para no comerse la RAM con 47k filas.
const FULL_LOAD_MAX_BYTES = 12 * 1024 * 1024;

async function xlsxWorkbookRows(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };
  const rows = [];
  let headers = null;
  ws.eachRow((row) => {
    const values = row.values.slice(1);
    if (!headers) { headers = normalizeHeaders(values); return; }
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cellText(values[i]); });
    rows.push(obj);
  });
  return { headers: headers || [], rows };
}

function tooBigToFullLoad(filePath) {
  try { return fs.statSync(filePath).size > FULL_LOAD_MAX_BYTES; } catch { return false; }
}

async function xlsxHeadersSafe(filePath) {
  try {
    return await xlsxHeaders(filePath);
  } catch (err) {
    if (tooBigToFullLoad(filePath)) throw err; // demasiado grande: no cargar entero
    const { headers, rows } = await xlsxWorkbookRows(filePath);
    const samples = new Map();
    headers.forEach((h) => samples.set(h, []));
    rows.slice(0, SAMPLE_SIZE).forEach((r) => headers.forEach((h) => { if (r[h]) samples.get(h).push(r[h]); }));
    return { headers, samples };
  }
}

async function xlsxIterateSafe(filePath, onRow) {
  try {
    return await xlsxIterate(filePath, onRow);
  } catch (err) {
    if (tooBigToFullLoad(filePath)) throw err;
    const { rows } = await xlsxWorkbookRows(filePath);
    let rowNo = 1;
    for (const obj of rows) { rowNo += 1; await onRow(obj, rowNo); }
    return undefined;
  }
}

// ─────────────────────────── API ───────────────────────────

/**
 * Cabeceras + hasta 3 valores de muestra por columna (paso "Asignar").
 * @returns {{ headers: string[], samples: Array<{ column, values: string[] }> }}
 */
function guardUnsupported(fileName) {
  const ext = extOf(fileName);
  // Google Sheets ofrece .ods, que exceljs NO sabe leer: un mensaje claro evita el
  // error críptico y le dice al usuario cómo exportar bien desde Google Sheets.
  if (ext === '.ods') {
    throw new Error('Los archivos .ods (OpenDocument) no se admiten. En Google Sheets usa Archivo → Descargar → Microsoft Excel (.xlsx) o Valores separados por comas (.csv).');
  }
}

async function readHeaders(filePath, fileName = filePath) {
  guardUnsupported(fileName);
  const { headers, samples } = isTextFile(fileName)
    ? await csvHeaders(filePath, fileName)
    : await xlsxHeadersSafe(filePath);
  return {
    headers,
    samples: headers.map((h) => ({ column: h, values: samples.get(h) || [] })),
  };
}

/**
 * Recorre las filas. `onRow(obj, rowNo)` puede ser async; rowNo es el número real
 * de fila del archivo (2 = primera fila de datos), para que los errores que ve el
 * usuario coincidan con lo que tiene abierto en Excel.
 */
async function iterateRows(filePath, fileName, onRow) {
  guardUnsupported(fileName);
  return isTextFile(fileName)
    ? csvIterate(filePath, onRow, fileName)
    : xlsxIterateSafe(filePath, onRow);
}

module.exports = { readHeaders, iterateRows, isSupported, extOf, SAMPLE_SIZE };
