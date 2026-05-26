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

  doc.fillColor(GREEN).fontSize(20).text(clinic?.nombreComercial || clinic?.name || 'Consultorio Médico');
  doc.moveDown(0.2);
  doc.fillColor('#64748b').fontSize(10).text(`Cotización ${q.quotationNumber || ''}`);
  if (clinic?.direccion || clinic?.telefono) {
    doc.text(`${clinic?.direccion || ''}${clinic?.telefono ? ' · ' + clinic.telefono : ''}`);
  }
  doc.moveDown(0.8);

  doc.fillColor('#1e293b').fontSize(11);
  doc.text(`Cliente: ${q.clientName || ''}${q.clientCedula ? ` (${q.clientCedula})` : ''}`);
  doc.text(`Fecha: ${new Date(q.createdAt).toLocaleDateString('es-EC')}`);
  if (q.validUntil) doc.text(`Válida hasta: ${new Date(q.validUntil).toLocaleDateString('es-EC')}`);
  doc.moveDown(0.8);

  // Cabecera de tabla
  const startX = 40;
  const colX = { desc: startX, qty: 300, price: 350, disc: 430, sub: 490 };
  const drawRow = (y, c, bold) => {
    doc.fontSize(9).fillColor(bold ? GREEN : '#1e293b');
    if (bold) doc.font('Helvetica-Bold'); else doc.font('Helvetica');
    doc.text(c.desc, colX.desc, y, { width: 250 });
    doc.text(c.qty, colX.qty, y, { width: 40, align: 'center' });
    doc.text(c.price, colX.price, y, { width: 70, align: 'right' });
    doc.text(c.disc, colX.disc, y, { width: 50, align: 'right' });
    doc.text(c.sub, colX.sub, y, { width: 70, align: 'right' });
  };
  let y = doc.y;
  drawRow(y, { desc: 'Descripción', qty: 'Cant.', price: 'P. Unit.', disc: 'Desc.', sub: 'Subtotal' }, true);
  y += 16;
  doc.moveTo(startX, y - 3).lineTo(560, y - 3).strokeColor('#e2e8f0').stroke();

  (q.items || []).forEach((it) => {
    drawRow(y, {
      desc: it.productName || '',
      qty: String(it.quantity),
      price: fmtMoney(it.unitPrice),
      disc: `${Number(it.discount || 0)}%`,
      sub: fmtMoney(it.subtotal),
    }, false);
    y += 16;
    if (y > 720) { doc.addPage(); y = 50; }
  });

  doc.font('Helvetica').fontSize(11).fillColor('#1e293b');
  doc.moveDown(2);
  let ty = Math.max(y + 14, doc.y);
  doc.text(`Subtotal: ${fmtMoney(q.subtotal)}`, 350, ty, { width: 210, align: 'right' }); ty += 16;
  doc.text(`Descuento: ${fmtMoney(q.discountTotal)}`, 350, ty, { width: 210, align: 'right' }); ty += 18;
  doc.font('Helvetica-Bold').fillColor(GREEN).fontSize(15)
    .text(`Total: ${fmtMoney(q.total)}`, 350, ty, { width: 210, align: 'right' });

  if (q.notes) {
    doc.font('Helvetica').fillColor('#475569').fontSize(10).text(`Notas: ${q.notes}`, 40, ty + 30, { width: 520 });
  }
  doc.font('Helvetica').fillColor('#94a3b8').fontSize(8)
    .text(`Generado el ${new Date().toLocaleString('es-EC')}`, 40, 800, { width: 520 });

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
