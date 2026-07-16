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

function isSupported(fileName) {
  return ['.csv', '.xlsx', '.xls'].includes(extOf(fileName));
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

// ─────────────────────────── CSV ───────────────────────────

function csvStream(filePath) {
  return fs.createReadStream(filePath).pipe(
    parse({
      bom: true,               // Excel exporta CSV con BOM y ensucia la 1ª cabecera
      relax_column_count: true, // filas con columnas de más/menos no rompen la importación
      skip_empty_lines: true,
      trim: true,
    })
  );
}

async function csvHeaders(filePath) {
  const stream = csvStream(filePath);
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

async function csvIterate(filePath, onRow) {
  const stream = csvStream(filePath);
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

// ─────────────────────────── API ───────────────────────────

/**
 * Cabeceras + hasta 3 valores de muestra por columna (paso "Asignar").
 * @returns {{ headers: string[], samples: Array<{ column, values: string[] }> }}
 */
async function readHeaders(filePath, fileName = filePath) {
  const fn = extOf(fileName) === '.csv' ? csvHeaders : xlsxHeaders;
  const { headers, samples } = await fn(filePath);
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
  const fn = extOf(fileName) === '.csv' ? csvIterate : xlsxIterate;
  return fn(filePath, onRow);
}

module.exports = { readHeaders, iterateRows, isSupported, extOf, SAMPLE_SIZE };
