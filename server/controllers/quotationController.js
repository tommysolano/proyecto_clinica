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
 * Genera el PDF de la cotización con pdfkit (sin navegador headless), de modo
 * que funcione de forma confiable en cualquier entorno de despliegue.
 */
async function buildQuotationPdf(q, clinic, res, filename) {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  doc.pipe(res);

  const fmtMoney = (n) => `$${Number(n || 0).toFixed(2)}`;
  const GREEN = '#047857';
  const LIGHT = '#ecfdf5';
  const BORDER = '#d1fae5';
  const SLATE = '#1e293b';
  const MUTED = '#64748b';

  // ========== Banda superior con logo + nombre ==========
  doc.rect(0, 0, doc.page.width, 110).fill(LIGHT);

  // Intento de pintar el logo (data URL base64). Si falla, se ignora.
  let logoBuffer = null;
  if (clinic?.logoUrl && typeof clinic.logoUrl === 'string') {
    const m = clinic.logoUrl.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
    if (m) {
      try { logoBuffer = Buffer.from(m[2], 'base64'); } catch (_) { logoBuffer = null; }
    }
  }
  if (logoBuffer) {
    try { doc.image(logoBuffer, 40, 22, { fit: [70, 70] }); } catch (_) { /* ignore */ }
  }

  const textX = logoBuffer ? 125 : 40;
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(20)
    .text(clinic?.nombreComercial || clinic?.name || 'Consultorio Médico', textX, 28, { width: 350 });
  doc.fillColor(MUTED).font('Helvetica').fontSize(9);
  if (clinic?.ruc) doc.text(`RUC: ${clinic.ruc}`, textX, 54);
  if (clinic?.address) doc.text(clinic.address, textX, 68, { width: 350 });
  if (clinic?.phone || clinic?.email) {
    doc.text(`${clinic?.phone || ''}${clinic?.phone && clinic?.email ? ' · ' : ''}${clinic?.email || ''}`, textX, 82, { width: 350 });
  }

  // Caja "Cotización N°" a la derecha
  doc.roundedRect(420, 25, 140, 70, 6).fill('#ffffff').stroke(BORDER);
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(11).text('COTIZACIÓN', 432, 34);
  doc.fillColor(SLATE).font('Helvetica-Bold').fontSize(14).text(q.quotationNumber || '—', 432, 50);
  doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
    .text(`Emitida: ${new Date(q.createdAt).toLocaleDateString('es-EC')}`, 432, 70);
  if (q.validUntil) {
    doc.text(`Válida hasta: ${new Date(q.validUntil).toLocaleDateString('es-EC')}`, 432, 82);
  }

  // ========== Datos del paciente ==========
  let y = 130;
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(10).text('PACIENTE', 40, y);
  y += 14;
  doc.roundedRect(40, y, 520, 60, 6).fillAndStroke('#f8fafc', '#e2e8f0');
  doc.fillColor(SLATE).font('Helvetica-Bold').fontSize(12)
    .text(q.clientName || 'Sin nombre', 52, y + 8);
  doc.font('Helvetica').fillColor(MUTED).fontSize(9);
  if (q.clientCedula) doc.text(`Cédula/RUC: ${q.clientCedula}`, 52, y + 26);
  if (q.clientEmail) doc.text(`Email: ${q.clientEmail}`, 52, y + 38);
  if (q.clientPhone) doc.text(`Teléfono: ${q.clientPhone}`, 280, y + 38);
  y += 75;

  // ========== Tabla de ítems ==========
  const startX = 40;
  const colX = { desc: startX + 8, qty: 320, price: 370, disc: 450, sub: 500 };

  // Cabecera con fondo
  doc.rect(startX, y, 520, 22).fill(GREEN);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9);
  doc.text('DESCRIPCIÓN', colX.desc, y + 7, { width: 260 });
  doc.text('CANT.', colX.qty, y + 7, { width: 40, align: 'center' });
  doc.text('P. UNIT.', colX.price, y + 7, { width: 70, align: 'right' });
  doc.text('DESC.', colX.disc, y + 7, { width: 40, align: 'right' });
  doc.text('SUBTOTAL', colX.sub, y + 7, { width: 60, align: 'right' });
  y += 22;

  // Filas
  doc.font('Helvetica').fontSize(9.5).fillColor(SLATE);
  let zebra = false;
  (q.items || []).forEach((it) => {
    if (zebra) doc.rect(startX, y, 520, 20).fill('#fafbfc');
    zebra = !zebra;
    doc.fillColor(SLATE);
    doc.text(it.productName || '', colX.desc, y + 6, { width: 260 });
    doc.text(String(it.quantity || 0), colX.qty, y + 6, { width: 40, align: 'center' });
    doc.text(fmtMoney(it.unitPrice), colX.price, y + 6, { width: 70, align: 'right' });
    doc.text(`${Number(it.discount || 0)}%`, colX.disc, y + 6, { width: 40, align: 'right' });
    doc.font('Helvetica-Bold').text(fmtMoney(it.subtotal), colX.sub, y + 6, { width: 60, align: 'right' });
    doc.font('Helvetica');
    y += 20;
    if (y > 700) { doc.addPage(); y = 50; }
  });

  // Línea divisoria
  doc.moveTo(startX, y).lineTo(startX + 520, y).strokeColor('#cbd5e1').lineWidth(0.5).stroke();
  y += 12;

  // ========== Totales ==========
  const totalsX = 340;
  doc.font('Helvetica').fontSize(10).fillColor(MUTED);
  doc.text('Subtotal:', totalsX, y, { width: 130, align: 'right' });
  doc.fillColor(SLATE).text(fmtMoney(q.subtotal), totalsX + 135, y, { width: 80, align: 'right' });
  y += 16;
  doc.fillColor(MUTED).text('Descuento:', totalsX, y, { width: 130, align: 'right' });
  doc.fillColor(SLATE).text(`- ${fmtMoney(q.discountTotal)}`, totalsX + 135, y, { width: 80, align: 'right' });
  y += 22;
  doc.roundedRect(totalsX, y - 6, 220, 30, 4).fill(GREEN);
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#ffffff')
    .text('TOTAL', totalsX + 10, y + 2);
  doc.text(fmtMoney(q.total), totalsX + 135, y + 2, { width: 75, align: 'right' });

  y += 50;

  // ========== Notas y términos ==========
  if (q.notes) {
    doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(10).text('NOTAS / TÉRMINOS', 40, y);
    y += 14;
    doc.roundedRect(40, y, 520, 50, 4).fillAndStroke('#fffbeb', '#fde68a');
    doc.fillColor(SLATE).font('Helvetica').fontSize(9).text(q.notes, 52, y + 8, { width: 500 });
    y += 60;
  }

  // ========== Pie de página ==========
  doc.fillColor('#94a3b8').font('Helvetica').fontSize(8)
    .text(`Documento generado el ${new Date().toLocaleString('es-EC')}`, 40, 800, { width: 520, align: 'center' });

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
