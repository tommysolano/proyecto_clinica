const PDFDocument = require('pdfkit');

/**
 * PDF del comprobante de asiento contable (comprobante de diario).
 * Incluye: empresa, número, fecha, origen (módulo + documento), usuario que lo
 * generó, fecha/hora de registro, líneas debe/haber con cuentas afectadas,
 * totales y estado (incluida la reversa si aplica).
 */

// Etiquetas legibles del documento origen (espejo de client sourceDocs.js).
const SOURCE_LABELS = {
  Sale: 'Venta',
  Invoice: 'Factura de venta',
  PurchaseInvoice: 'Factura de compra',
  FixedAsset: 'Activo fijo (depreciación)',
  Payroll: 'Rol de nómina',
  Payment: 'Pago / Cobro',
  BankTransaction: 'Movimiento bancario',
  CashDeposit: 'Depósito de efectivo',
  Reconciliation: 'Conciliación bancaria',
  CashClosing: 'Cierre de caja',
  CashMovement: 'Movimiento de caja',
  CommissionPosting: 'Comisiones del personal',
  CreditDebitNote: 'Nota de crédito / débito',
  RetentionVoucher: 'Comprobante de retención',
  DeferredIncome: 'Ingreso diferido',
  CardSettlement: 'Liquidación de tarjeta',
  CreditCardBatch: 'Lote de tarjeta',
  EmployeeDeduction: 'Deducción de empleado',
  PhysicalCount: 'Toma física de inventario',
  InventoryMovement: 'Movimiento de inventario (traslado)',
  JournalEntry: 'Asiento (reversa)',
};

const TZ = 'America/Guayaquil';
const money = (n) => Number(n || 0).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('es-EC', { timeZone: TZ }) : '');
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('es-EC', { timeZone: TZ }) : '');

function sourceLabel(entry) {
  return SOURCE_LABELS[entry.sourceModel] || entry.source || 'Asiento manual';
}

/** Escribe el PDF del asiento directamente sobre `res`. */
function streamJournalEntryPdf({ entry, clinic, res, filename }) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename || `asiento_${entry.number}.pdf`}"`);
  doc.pipe(res);

  const GREEN = '#047857';
  const SLATE = '#334155';
  const LIGHT = '#f1f5f9';
  const LEFT = 40;
  const RIGHT = 555;
  const WIDTH = RIGHT - LEFT;

  // --- Encabezado empresa + título ---
  doc.fillColor(GREEN).fontSize(14).font('Helvetica-Bold')
    .text(clinic?.razonSocial || clinic?.name || 'Empresa', LEFT, 42);
  doc.fillColor(SLATE).fontSize(8.5).font('Helvetica');
  if (clinic?.ruc) doc.text(`RUC: ${clinic.ruc}`);
  if (clinic?.address) doc.text(clinic.address);

  doc.fillColor(SLATE).fontSize(13).font('Helvetica-Bold')
    .text('COMPROBANTE DE ASIENTO CONTABLE', LEFT, 42, { width: WIDTH, align: 'right' });
  doc.fontSize(11).fillColor(GREEN).text(entry.number || '', LEFT, 60, { width: WIDTH, align: 'right' });
  const statusColor = entry.status === 'ANULADO' ? '#e11d48' : entry.status === 'BORRADOR' ? '#d97706' : GREEN;
  doc.fontSize(9).fillColor(statusColor).font('Helvetica-Bold')
    .text(entry.status || 'CONTABILIZADO', LEFT, 76, { width: WIDTH, align: 'right' });

  // --- Bloque de metadatos ---
  let y = 110;
  doc.roundedRect(LEFT, y, WIDTH, 66, 6).fillAndStroke(LIGHT, '#e2e8f0');
  const meta = [
    ['Fecha del asiento:', fmtDate(entry.date)],
    ['Origen:', sourceLabel(entry)],
    ['Documento origen:', entry.sourceRef ? `${sourceLabel(entry)} (${String(entry.sourceRef)})` : '—'],
    ['Generado por:', entry.createdBy?.name || '—'],
    ['Registrado el:', fmtDateTime(entry.createdAt)],
    ['Descripción:', entry.description || '—'],
  ];
  doc.fontSize(8.5);
  meta.forEach((pair, i) => {
    const col = i % 2; // 2 columnas
    const row = Math.floor(i / 2);
    const x = LEFT + 10 + col * (WIDTH / 2);
    const yy = y + 10 + row * 18;
    doc.fillColor('#64748b').font('Helvetica-Bold').text(pair[0], x, yy, { continued: true, width: WIDTH / 2 - 20 });
    doc.fillColor(SLATE).font('Helvetica').text(` ${pair[1]}`, { width: WIDTH / 2 - 20 });
  });
  y += 80;

  // --- Aviso de reversa ---
  if (entry.isReversed || entry.reverses) {
    doc.fontSize(8.5).fillColor('#b91c1c').font('Helvetica-Bold');
    if (entry.isReversed) doc.text(`⚠ Asiento REVERSADO${entry.reversalReason ? ` — Motivo: ${entry.reversalReason}` : ''}`, LEFT, y);
    if (entry.reverses) doc.text('Este asiento es la REVERSA de un asiento anterior.', LEFT, y);
    y += 16;
  }

  // --- Tabla de líneas ---
  const COLS = [
    { key: 'code', label: 'Código', x: LEFT, w: 75, align: 'left' },
    { key: 'name', label: 'Cuenta', x: LEFT + 75, w: 165, align: 'left' },
    { key: 'desc', label: 'Detalle', x: LEFT + 240, w: 135, align: 'left' },
    { key: 'debit', label: 'Debe', x: LEFT + 375, w: 70, align: 'right' },
    { key: 'credit', label: 'Haber', x: LEFT + 445, w: 70, align: 'right' },
  ];
  const drawHeader = () => {
    doc.rect(LEFT, y, WIDTH, 18).fill(GREEN);
    doc.fillColor('white').fontSize(8.5).font('Helvetica-Bold');
    COLS.forEach((c) => doc.text(c.label, c.x + 4, y + 5, { width: c.w - 8, align: c.align }));
    y += 18;
  };
  drawHeader();

  doc.font('Helvetica').fontSize(8.5);
  for (const l of entry.lines || []) {
    const cells = {
      code: l.accountCode || '',
      name: l.accountName || '',
      desc: l.description || '',
      debit: l.debit ? money(l.debit) : '',
      credit: l.credit ? money(l.credit) : '',
    };
    const h = Math.max(
      14,
      doc.heightOfString(cells.name, { width: COLS[1].w - 8 }) + 6,
      doc.heightOfString(cells.desc, { width: COLS[2].w - 8 }) + 6
    );
    if (y + h > 760) { doc.addPage(); y = 50; drawHeader(); doc.font('Helvetica').fontSize(8.5); }
    doc.fillColor(SLATE);
    COLS.forEach((c) => doc.text(cells[c.key], c.x + 4, y + 3, { width: c.w - 8, align: c.align }));
    doc.moveTo(LEFT, y + h).lineTo(RIGHT, y + h).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    y += h;
  }

  // --- Totales ---
  if (y + 24 > 760) { doc.addPage(); y = 50; }
  doc.rect(LEFT, y, WIDTH, 20).fill(LIGHT);
  doc.fillColor(SLATE).font('Helvetica-Bold').fontSize(9);
  doc.text('TOTALES', LEFT + 4, y + 5, { width: 330, align: 'right' });
  doc.text(money(entry.totalDebit), COLS[3].x + 4, y + 5, { width: COLS[3].w - 8, align: 'right' });
  doc.text(money(entry.totalCredit), COLS[4].x + 4, y + 5, { width: COLS[4].w - 8, align: 'right' });
  y += 34;

  // --- Firmas ---
  if (y + 70 > 780) { doc.addPage(); y = 60; }
  const sigW = 150;
  const positions = [LEFT + 20, LEFT + WIDTH / 2 - sigW / 2, RIGHT - sigW - 20];
  ['ELABORADO POR', 'REVISADO POR', 'APROBADO POR'].forEach((label, i) => {
    doc.moveTo(positions[i], y + 40).lineTo(positions[i] + sigW, y + 40).strokeColor('#94a3b8').lineWidth(0.7).stroke();
    doc.fontSize(7.5).fillColor('#64748b').font('Helvetica').text(label, positions[i], y + 44, { width: sigW, align: 'center' });
  });

  doc.fontSize(7).fillColor('#94a3b8')
    .text(`Generado el ${fmtDateTime(new Date())} · Sistema de gestión clínica`, LEFT, 800, { width: WIDTH, align: 'center' });

  doc.end();
}

module.exports = { streamJournalEntryPdf, SOURCE_LABELS };
