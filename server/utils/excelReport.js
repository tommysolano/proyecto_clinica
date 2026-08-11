/**
 * EXPORTACIÓN A EXCEL DE LOS REPORTES CONTABLES — utilidades compartidas.
 *
 * Pedido del contador: "todos los reportes y consultas del sistema se deben poder descargar en
 * Excel". Antes cada exportación se escribía a mano (columnas, cabecera, formatos, totales), así
 * que agregar una era caro y las pocas que existían no se parecían entre sí.
 *
 * Aquí vive el patrón único:
 *
 *   const data = await captureJson(exports.miReporte, req);   // reutiliza el controlador JSON
 *   const wb = newWorkbook();
 *   addSheet(wb, { title: 'Mayor', columns: [...], rows: data.rows, totals: {...}, meta: [...] });
 *   await sendWorkbook(res, wb, 'mayor.xlsx');
 *
 * La clave es `captureJson`: el Excel sale del MISMO controlador que pinta la pantalla, así que
 * pantalla y archivo no pueden discrepar. Duplicar la consulta era la vía segura para que el
 * Excel dijera una cosa y el sistema otra.
 */
const ExcelJS = require('exceljs');

const MONEY_FORMAT = '"$"#,##0.00';
const HEADER_FILL = 'FFD1FAE5';   // emerald-100: mismo verde de las tablas de la app
const TOTAL_FILL = 'FFF1F5F9';    // slate-100

/** Nuevo libro con los metadatos del sistema. */
function newWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Shiluv';
  wb.created = new Date();
  return wb;
}

/**
 * Ejecuta un controlador que responde con `res.json(...)` y devuelve ESE payload en vez de
 * enviarlo. Permite que la ruta `.xlsx` reutilice íntegramente el controlador de pantalla.
 *
 * Si el controlador responde con un `status(4xx/5xx)`, se propaga como error con ese status
 * (si no, el Excel se generaría vacío y en silencio sobre un mensaje de error).
 */
function captureJson(handler, req) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const res = {
      json: (payload) => {
        if (statusCode >= 400) {
          reject(Object.assign(new Error(payload?.message || 'Error al generar el reporte'), { status: statusCode }));
        } else resolve(payload);
        return res;
      },
      status: (code) => { statusCode = code; return res; },
      setHeader: () => res,
      send: (payload) => { resolve(payload); return res; },
      end: () => res,
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

/**
 * Fecha en formato ecuatoriano para celdas de texto.
 *
 * Una fecha SUELTA ("2026-01-01", la que mandan los filtros de pantalla) no lleva hora:
 * `new Date()` la lee como medianoche UTC y en Ecuador (UTC−5) retrocede al día anterior,
 * así que la cabecera de los reportes decía "31/12/2025" para un reporte de enero de 2026.
 * Se formatea tal cual, sin pasar por la zona horaria.
 */
const xlsDate = (d) => {
  if (!d) return '';
  const soloFecha = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.trim());
  if (soloFecha) {
    const [y, m, dd] = d.trim().split('-');
    return `${Number(dd)}/${Number(m)}/${y}`;
  }
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('es-EC', { timeZone: 'America/Guayaquil' });
};

/**
 * Agrega una hoja al libro.
 *
 * @param {ExcelJS.Workbook} wb
 * @param {object}   opts
 * @param {string}   opts.title    nombre de la hoja
 * @param {Array}    opts.columns  [{ header, key, width?, money?, date?, number? }]
 * @param {Array}    opts.rows     objetos con las claves de `columns`
 * @param {Array}    [opts.meta]   [[etiqueta, valor]] que se imprime ARRIBA (período, cuenta…)
 * @param {object}   [opts.totals] fila de totales por key ({ debit: 100, credit: 100 })
 * @param {string}   [opts.totalsLabel]
 * @param {Array}    [opts.notes]  líneas de texto al final (advertencias, notas del reporte)
 * @returns {ExcelJS.Worksheet}
 */
function addSheet(wb, { title, columns, rows = [], meta = [], totals = null, totalsLabel = 'TOTALES', notes = [] }) {
  // Excel limita el nombre de hoja a 31 caracteres y prohíbe : \ / ? * [ ]
  const safeTitle = String(title || 'Hoja').replace(/[:\\/?*[\]]/g, '-').slice(0, 31);
  const ws = wb.addWorksheet(safeTitle);

  // Cabecera de contexto: qué reporte es, de qué período y con qué filtros. Un Excel suelto
  // sin esto es inauditable (nadie sabe a qué corte corresponde).
  let headerRowIndex = 1;
  if (meta.length) {
    for (const [label, value] of meta) {
      const r = ws.addRow([label, value == null ? '' : value]);
      r.getCell(1).font = { bold: true, size: 10 };
      r.getCell(2).font = { size: 10 };
    }
    ws.addRow([]);
    headerRowIndex = meta.length + 2;
  }

  ws.addRow(columns.map((c) => c.header));
  const header = ws.getRow(headerRowIndex);
  header.font = { bold: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  header.alignment = { vertical: 'middle', wrapText: true };

  columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width || 18; });

  for (const row of rows) {
    ws.addRow(columns.map((c) => {
      const v = row[c.key];
      if (c.date) return xlsDate(v);
      if (c.money || c.number) return v == null || v === '' ? null : Number(v);
      return v == null ? '' : v;
    }));
  }

  columns.forEach((c, i) => {
    if (c.money) ws.getColumn(i + 1).numFmt = MONEY_FORMAT;
    else if (c.number) ws.getColumn(i + 1).numFmt = '#,##0.####';
  });

  if (totals) {
    const r = ws.addRow(columns.map((c, i) => {
      if (i === 0) return totalsLabel;
      const v = totals[c.key];
      if (v == null) return null;
      return c.money || c.number ? Number(v) : v;
    }));
    r.font = { bold: true };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_FILL } };
  }

  if (notes.length) {
    ws.addRow([]);
    for (const n of notes) {
      const r = ws.addRow([String(n)]);
      r.getCell(1).font = { size: 9, italic: true, color: { argb: 'FF64748B' } };
    }
  }

  // Fila de encabezado congelada: en un mayor de cientos de filas es la diferencia entre
  // poder leerlo y no.
  ws.views = [{ state: 'frozen', ySplit: headerRowIndex }];
  ws.autoFilter = {
    from: { row: headerRowIndex, column: 1 },
    to: { row: headerRowIndex, column: columns.length },
  };
  return ws;
}

/** Hoja de pares etiqueta/valor (estados financieros, indicadores, resúmenes). */
function addKeyValueSheet(wb, { title, meta = [], sections = [], notes = [] }) {
  const rows = [];
  for (const s of sections) {
    if (s.title) rows.push({ concepto: s.title, valor: null, _section: true });
    for (const [label, value] of s.rows || []) rows.push({ concepto: label, valor: value });
    if (s.total) rows.push({ concepto: s.total[0], valor: s.total[1], _total: true });
    rows.push({ concepto: '', valor: null });
  }
  const ws = addSheet(wb, {
    title,
    meta,
    columns: [
      { header: 'Concepto', key: 'concepto', width: 52 },
      { header: 'Valor', key: 'valor', width: 20, money: true },
    ],
    rows,
    notes,
  });
  // Resalta títulos de sección y totales (se localizan por el texto ya escrito).
  const offset = meta.length ? meta.length + 2 : 1;
  rows.forEach((r, i) => {
    const excelRow = ws.getRow(offset + 1 + i);
    if (r._section) {
      excelRow.font = { bold: true };
      excelRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    } else if (r._total) {
      excelRow.font = { bold: true };
      excelRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TOTAL_FILL } };
    }
  });
  return ws;
}

/** Envía el libro como descarga .xlsx. */
async function sendWorkbook(res, wb, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

/**
 * Envuelve un generador de Excel con el manejo de errores correcto: un fallo NO puede acabar
 * en un .xlsx corrupto de 0 bytes (el cliente `downloadFile` sabe leer el JSON de error, pero
 * solo si llega antes de empezar a escribir el archivo).
 */
function excelHandler(build) {
  return async (req, res) => {
    try {
      await build(req, res);
    } catch (e) {
      if (res.headersSent) return res.end();
      return res.status(e.status || 500).json({ message: e.message || 'Error al generar el Excel' });
    }
  };
}

/** Etiqueta legible del período de un reporte (para la cabecera de contexto). */
function periodLabel(query = {}) {
  if (query.startDate && query.endDate) return `${xlsDate(query.startDate)} — ${xlsDate(query.endDate)}`;
  if (query.startDate) return `Desde ${xlsDate(query.startDate)}`;
  if (query.endDate) return `Hasta ${xlsDate(query.endDate)}`;
  return 'Todo el histórico';
}

module.exports = {
  newWorkbook,
  addSheet,
  addKeyValueSheet,
  sendWorkbook,
  captureJson,
  excelHandler,
  periodLabel,
  xlsDate,
  MONEY_FORMAT,
};
