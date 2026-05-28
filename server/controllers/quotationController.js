const Quotation = require('../models/Quotation');
const Product = require('../models/Product');

const POPULATE = [
  { path: 'patient', select: 'firstName lastName cedula phone email' },
  { path: 'createdBy', select: 'name email' },
  { path: 'items.product', select: 'name code category' },
];

exports.list = async (req, res) => {
  try {
    const { status, patient } = req.query;
    const query = { clinic: req.clinicId };
    if (status) query.status = status;
    if (patient) query.patient = patient;
    const quotations = await Quotation.find(query)
      .populate(POPULATE)
      .sort({ createdAt: -1 });
    res.json(quotations);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener cotizaciones', error: error.message });
  }
};

exports.get = async (req, res) => {
  try {
    const q = await Quotation.findOne({
      _id: req.params.id,
      clinic: req.clinicId,
    }).populate(POPULATE);
    if (!q) return res.status(404).json({ message: 'Cotización no encontrada' });
    res.json(q);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener cotización' });
  }
};

// Sin IVA. El descuento de cada ítem es un PORCENTAJE aplicado a (unit * qty).
const recalc = (items) => {
  let subtotal = 0;
  let discountTotal = 0;
  const computed = items.map((it) => {
    const qty = Number(it.quantity || 1);
    const unit = Number(it.unitPrice || 0);
    const discPct = Math.min(Math.max(Number(it.discount || 0), 0), 100);
    const baseSub = unit * qty;
    const discAmount = +(baseSub * (discPct / 100)).toFixed(2);
    const sub = +(baseSub - discAmount).toFixed(2);
    subtotal += baseSub;
    discountTotal += discAmount;
    return { ...it, taxRate: 0, subtotal: sub };
  });
  const total = +(subtotal - discountTotal).toFixed(2);
  return {
    items: computed,
    subtotal: +subtotal.toFixed(2),
    discountTotal: +discountTotal.toFixed(2),
    taxAmount: 0,
    total,
  };
};

exports.create = async (req, res) => {
  try {
    const items = req.body.items || [];
    if (items.length === 0) {
      return res.status(400).json({ message: 'Agrega al menos un ítem' });
    }
    const ids = items.map((i) => i.product).filter(Boolean);
    const products = await Product.find({ _id: { $in: ids }, clinic: req.clinicId });
    const byId = new Map(products.map((p) => [String(p._id), p]));

    const enriched = items.map((it) => {
      const p = byId.get(String(it.product));
      return {
        product: it.product,
        productCode: p?.code,
        productName: p?.name || it.productName,
        category: p?.category,
        quantity: Number(it.quantity || 1),
        unitPrice: Number(it.unitPrice ?? p?.salePrice ?? 0),
        taxRate: 0,
        discount: Number(it.discount || 0),
        subtotal: 0,
      };
    });
    const totals = recalc(enriched);

    const quotation = await Quotation.create({
      ...req.body,
      ...totals,
      clinic: req.clinicId,
      createdBy: req.user._id,
    });
    const populated = await Quotation.findById(quotation._id).populate(POPULATE);
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear cotización', error: error.message });
  }
};

exports.update = async (req, res) => {
  try {
    const update = { ...req.body };
    if (Array.isArray(update.items)) {
      const totals = recalc(update.items);
      Object.assign(update, totals);
    }
    const q = await Quotation.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      update,
      { new: true }
    ).populate(POPULATE);
    if (!q) return res.status(404).json({ message: 'Cotización no encontrada' });
    res.json(q);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar cotización' });
  }
};

exports.remove = async (req, res) => {
  try {
    const q = await Quotation.findOneAndDelete({
      _id: req.params.id,
      clinic: req.clinicId,
    });
    if (!q) return res.status(404).json({ message: 'Cotización no encontrada' });
    res.json({ message: 'Cotización eliminada' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar cotización' });
  }
};

/**
 * Resuelve el buffer de imagen para usar como logo en el PDF.
 *  1. Si la clínica tiene logo configurado (data URL base64), se usa ese.
 *  2. Si no, se usa el logo por defecto del sistema (server/assets/Shiluv-logo-4.png).
 *  3. Si ninguno está disponible, devuelve null.
 */
function resolveLogoBuffer(clinic) {
  if (clinic?.logoUrl && typeof clinic.logoUrl === 'string') {
    const m = clinic.logoUrl.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
    if (m) {
      try {
        return Buffer.from(m[2], 'base64');
      } catch (_) {
        /* ignore */
      }
    }
  }
  try {
    const fs = require('fs');
    const path = require('path');
    const fallback = path.join(__dirname, '..', 'assets', 'Shiluv-logo-4.png');
    if (fs.existsSync(fallback)) {
      return fs.readFileSync(fallback);
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

const fmtLocalDate = (value) => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mo}/${yyyy}`;
};

/**
 * Genera el PDF de la cotización con pdfkit. Diseño 2.0: encabezado con banda
 * de marca, logo a la izquierda, panel de cotización a la derecha, sección de
 * paciente con tarjeta, tabla de ítems con cabecera marcada, totales
 * destacados y pie de página con marca del sistema.
 */
async function buildQuotationPdf(q, clinic, res, filename) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  doc.pipe(res);

  // --- Paleta ---
  const fmtMoney = (n) => `$${Number(n || 0).toFixed(2)}`;
  const GREEN = '#047857';       // verde principal
  const GREEN_DARK = '#065f46';
  const TEAL = '#0d9488';
  const LIGHT = '#ecfdf5';       // verde muy claro
  const BORDER = '#d1fae5';      // borde verde
  const SLATE = '#0f172a';       // texto principal
  const SLATE_SOFT = '#334155';
  const MUTED = '#64748b';       // texto secundario
  const PAGE_W = doc.page.width; // 595
  const M = 40;                  // margen
  const CONTENT_W = PAGE_W - M * 2; // 515

  // ========== Encabezado con banda decorativa ==========
  // Banda principal
  doc.rect(0, 0, PAGE_W, 130).fill(LIGHT);
  // Franja inferior de acento (degradado simulado con dos rectángulos)
  doc.rect(0, 126, PAGE_W, 3).fill(GREEN);
  doc.rect(0, 129, PAGE_W, 2).fill(TEAL);

  // Logo a la izquierda con fondo blanco redondeado
  const logoBuffer = resolveLogoBuffer(clinic);
  if (logoBuffer) {
    // Caja blanca para que el logo siempre se vea bien sobre el verde claro.
    doc.roundedRect(M, 22, 80, 80, 10).fill('#ffffff').stroke(BORDER);
    try {
      doc.image(logoBuffer, M + 6, 28, { fit: [68, 68], align: 'center', valign: 'center' });
    } catch (_) {
      /* ignore */
    }
  }
  const textX = logoBuffer ? M + 92 : M;

  doc.fillColor(GREEN_DARK).font('Helvetica-Bold').fontSize(19)
    .text(clinic?.nombreComercial || clinic?.name || 'Consultorio Médico', textX, 28, {
      width: 310,
      lineBreak: false,
      ellipsis: true,
    });

  doc.fillColor(MUTED).font('Helvetica').fontSize(8.5);
  let infoY = 52;
  if (clinic?.razonSocial && clinic.razonSocial !== clinic.nombreComercial) {
    doc.text(clinic.razonSocial, textX, infoY, { width: 310 });
    infoY += 11;
  }
  if (clinic?.ruc) {
    doc.text(`RUC: ${clinic.ruc}`, textX, infoY, { width: 310 });
    infoY += 11;
  }
  if (clinic?.address) {
    doc.text(clinic.address, textX, infoY, { width: 310 });
    infoY += 11;
  }
  if (clinic?.phone || clinic?.email) {
    doc.text(
      `${clinic?.phone || ''}${clinic?.phone && clinic?.email ? ' · ' : ''}${clinic?.email || ''}`,
      textX,
      infoY,
      { width: 310 }
    );
  }

  // Caja "Cotización" a la derecha
  const boxX = PAGE_W - M - 160;
  doc.roundedRect(boxX, 22, 160, 84, 10).fill('#ffffff').stroke(BORDER);
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(9).text('COTIZACIÓN', boxX + 14, 32, {
    width: 132,
    characterSpacing: 1.2,
  });
  doc.fillColor(SLATE).font('Helvetica-Bold').fontSize(16)
    .text(q.quotationNumber || '—', boxX + 14, 48, { width: 132 });
  doc.fillColor(MUTED).font('Helvetica').fontSize(8.5);
  doc.text(`Emitida: ${fmtLocalDate(q.createdAt)}`, boxX + 14, 74, { width: 132 });
  if (q.validUntil) {
    doc.text(`Válida hasta: ${fmtLocalDate(q.validUntil)}`, boxX + 14, 88, { width: 132 });
  }

  // ========== Datos del paciente ==========
  let y = 150;
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(9)
    .text('PACIENTE', M, y, { characterSpacing: 1.2 });
  y += 14;

  // Tarjeta del paciente con borde lateral verde
  const cardH = 64;
  doc.roundedRect(M, y, CONTENT_W, cardH, 8).fillAndStroke('#f8fafc', '#e2e8f0');
  // Acento lateral
  doc.rect(M, y, 4, cardH).fill(GREEN);

  doc.fillColor(SLATE).font('Helvetica-Bold').fontSize(13)
    .text(q.clientName || 'Sin nombre', M + 16, y + 10, { width: CONTENT_W - 32 });

  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  const col1X = M + 16;
  const col2X = M + 16 + (CONTENT_W - 32) / 2;
  let detY = y + 32;
  if (q.clientCedula) {
    doc.fillColor(MUTED).text('Cédula / RUC:', col1X, detY);
    doc.fillColor(SLATE_SOFT).text(q.clientCedula, col1X + 60, detY);
  }
  if (q.clientPhone) {
    doc.fillColor(MUTED).text('Teléfono:', col2X, detY);
    doc.fillColor(SLATE_SOFT).text(q.clientPhone, col2X + 50, detY);
  }
  detY += 13;
  if (q.clientEmail) {
    doc.fillColor(MUTED).text('Email:', col1X, detY);
    doc.fillColor(SLATE_SOFT).text(q.clientEmail, col1X + 60, detY);
  }
  y += cardH + 18;

  // ========== Tabla de ítems ==========
  const tableX = M;
  const tableW = CONTENT_W;
  // Columnas (suman tableW)
  const cols = {
    desc:  { x: tableX + 10, w: 250, align: 'left' },
    qty:   { x: tableX + 270, w: 40, align: 'center' },
    price: { x: tableX + 318, w: 70, align: 'right' },
    disc:  { x: tableX + 392, w: 50, align: 'right' },
    sub:   { x: tableX + 448, w: 60, align: 'right' },
  };

  // Cabecera con esquinas redondeadas
  doc.roundedRect(tableX, y, tableW, 24, 6).fill(GREEN);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5);
  doc.text('DESCRIPCIÓN', cols.desc.x, y + 8, { width: cols.desc.w, characterSpacing: 1 });
  doc.text('CANT.',       cols.qty.x,  y + 8, { width: cols.qty.w, align: 'center', characterSpacing: 1 });
  doc.text('P. UNIT.',    cols.price.x,y + 8, { width: cols.price.w, align: 'right', characterSpacing: 1 });
  doc.text('DESC.',       cols.disc.x, y + 8, { width: cols.disc.w, align: 'right', characterSpacing: 1 });
  doc.text('SUBTOTAL',    cols.sub.x,  y + 8, { width: cols.sub.w, align: 'right', characterSpacing: 1 });
  y += 24;

  // Filas con zebra
  let zebra = false;
  for (const it of (q.items || [])) {
    if (y > 720) {
      doc.addPage();
      y = M;
    }
    const rowH = 22;
    if (zebra) doc.rect(tableX, y, tableW, rowH).fill('#fafbfc');
    zebra = !zebra;
    doc.fillColor(SLATE).font('Helvetica').fontSize(9.5);
    doc.text(it.productName || '', cols.desc.x, y + 7, { width: cols.desc.w, lineBreak: false, ellipsis: true });
    doc.text(String(it.quantity || 0), cols.qty.x, y + 7, { width: cols.qty.w, align: 'center' });
    doc.text(fmtMoney(it.unitPrice), cols.price.x, y + 7, { width: cols.price.w, align: 'right' });
    doc.text(`${Number(it.discount || 0)}%`, cols.disc.x, y + 7, { width: cols.disc.w, align: 'right' });
    doc.font('Helvetica-Bold').fillColor(GREEN_DARK)
      .text(fmtMoney(it.subtotal), cols.sub.x, y + 7, { width: cols.sub.w, align: 'right' });
    y += rowH;
  }

  // Línea divisoria
  doc.moveTo(tableX, y).lineTo(tableX + tableW, y).strokeColor(BORDER).lineWidth(1).stroke();
  y += 14;

  // ========== Totales ==========
  const totalsW = 230;
  const totalsX = tableX + tableW - totalsW;
  // Subtotal
  doc.font('Helvetica').fontSize(10).fillColor(MUTED)
    .text('Subtotal', totalsX, y, { width: 110, align: 'left' });
  doc.fillColor(SLATE).font('Helvetica-Bold')
    .text(fmtMoney(q.subtotal), totalsX + 110, y, { width: 120, align: 'right' });
  y += 16;
  // Descuento
  doc.fillColor(MUTED).font('Helvetica')
    .text('Descuento', totalsX, y, { width: 110, align: 'left' });
  doc.fillColor(SLATE).font('Helvetica-Bold')
    .text(`− ${fmtMoney(q.discountTotal)}`, totalsX + 110, y, { width: 120, align: 'right' });
  y += 20;
  // Total destacado
  doc.roundedRect(totalsX, y, totalsW, 38, 8).fill(GREEN);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11)
    .text('TOTAL', totalsX + 16, y + 13, { characterSpacing: 1.5 });
  doc.fontSize(16).text(fmtMoney(q.total), totalsX + 110, y + 11, { width: 110, align: 'right' });
  y += 56;

  // ========== Notas y términos ==========
  if (q.notes) {
    if (y > 700) {
      doc.addPage();
      y = M;
    }
    doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(9)
      .text('NOTAS / TÉRMINOS', M, y, { characterSpacing: 1.2 });
    y += 14;
    const notesH = 60;
    doc.roundedRect(M, y, CONTENT_W, notesH, 8).fillAndStroke('#fffbeb', '#fde68a');
    doc.fillColor(SLATE_SOFT).font('Helvetica').fontSize(9.5)
      .text(q.notes, M + 14, y + 10, { width: CONTENT_W - 28, height: notesH - 16 });
    y += notesH + 14;
  }

  // ========== Pie de página ==========
  const footerY = doc.page.height - 50;
  doc.moveTo(M, footerY).lineTo(PAGE_W - M, footerY).strokeColor(BORDER).lineWidth(0.5).stroke();
  doc.fillColor(MUTED).font('Helvetica').fontSize(8)
    .text(
      `${clinic?.nombreComercial || clinic?.name || ''}  ·  Cotización ${q.quotationNumber || ''}  ·  ${fmtLocalDate(q.createdAt)}`,
      M,
      footerY + 6,
      { width: CONTENT_W, align: 'left' }
    );
  doc.text('Página 1', M, footerY + 6, { width: CONTENT_W, align: 'right' });
  doc.fillColor('#94a3b8').fontSize(7.5)
    .text('Documento generado por el sistema · Gracias por su preferencia', M, footerY + 22, {
      width: CONTENT_W,
      align: 'center',
    });

  doc.end();
}

/**
 * PDF descargable (autenticado).
 */
exports.pdf = async (req, res) => {
  try {
    const q = await Quotation.findOne({ _id: req.params.id, clinic: req.clinicId }).populate(POPULATE);
    if (!q) return res.status(404).json({ message: 'Cotización no encontrada' });
    const Clinic = require('../models/Clinic');
    const clinic = await Clinic.findById(req.clinicId);
    await buildQuotationPdf(q, clinic, res, `cotizacion_${q.quotationNumber}.pdf`);
  } catch (error) {
    res.status(500).json({ message: 'Error al generar PDF', error: error.message });
  }
};

/**
 * Genera (o reutiliza) un enlace público para compartir el PDF por WhatsApp.
 * Devuelve la URL absoluta del PDF y la URL de wa.me con un mensaje prellenado.
 */
exports.shareWhatsapp = async (req, res) => {
  try {
    const crypto = require('crypto');
    const q = await Quotation.findOne({ _id: req.params.id, clinic: req.clinicId }).populate(POPULATE);
    if (!q) return res.status(404).json({ message: 'Cotización no encontrada' });

    if (!q.shareToken) {
      q.shareToken = crypto.randomBytes(16).toString('hex');
      if (q.status === 'borrador') q.status = 'enviada';
      await q.save();
    }

    const base = process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`;
    const pdfUrl = `${base}/api/quotations/public/${q.shareToken}/pdf`;

    const phone = (req.query.phone || q.clientPhone || '').replace(/\D/g, '');
    const msg =
      `Hola ${q.clientName || ''}, aquí está su cotización ${q.quotationNumber} ` +
      `por un total de $${Number(q.total || 0).toFixed(2)}.\n${pdfUrl}`;
    const waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;

    res.json({ pdfUrl, waUrl, shareToken: q.shareToken });
  } catch (error) {
    res.status(500).json({ message: 'Error al compartir cotización', error: error.message });
  }
};

/**
 * PDF público por token (sin autenticación) — para enlaces de WhatsApp.
 */
exports.publicPdf = async (req, res) => {
  try {
    const q = await Quotation.findOne({ shareToken: req.params.token }).populate(POPULATE);
    if (!q) return res.status(404).json({ message: 'Cotización no encontrada' });
    const Clinic = require('../models/Clinic');
    const clinic = await Clinic.findById(q.clinic);
    await buildQuotationPdf(q, clinic, res, `cotizacion_${q.quotationNumber}.pdf`);
  } catch (error) {
    res.status(500).json({ message: 'Error al generar PDF', error: error.message });
  }
};
