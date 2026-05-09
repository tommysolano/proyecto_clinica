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

const recalc = (items) => {
  let subtotal = 0;
  let discountTotal = 0;
  let taxAmount = 0;
  const computed = items.map((it) => {
    const qty = Number(it.quantity || 1);
    const unit = Number(it.unitPrice || 0);
    const disc = Number(it.discount || 0);
    const tax = Number(it.taxRate || 0);
    const baseSub = unit * qty;
    const sub = +(baseSub - disc).toFixed(2);
    const t = +(sub * (tax / 100)).toFixed(2);
    subtotal += baseSub;
    discountTotal += disc;
    taxAmount += t;
    return { ...it, subtotal: sub };
  });
  const total = +(subtotal - discountTotal + taxAmount).toFixed(2);
  return {
    items: computed,
    subtotal: +subtotal.toFixed(2),
    discountTotal: +discountTotal.toFixed(2),
    taxAmount: +taxAmount.toFixed(2),
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
        taxRate: Number(it.taxRate ?? p?.taxRate ?? 15),
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
 * PDF descargable.
 */
exports.pdf = async (req, res) => {
  try {
    const q = await Quotation.findOne({
      _id: req.params.id,
      clinic: req.clinicId,
    }).populate(POPULATE);
    if (!q) return res.status(404).json({ message: 'Cotización no encontrada' });

    const Clinic = require('../models/Clinic');
    const clinic = await Clinic.findById(req.clinicId);
    const fmtMoney = (n) => `$${Number(n || 0).toFixed(2)}`;

    const itemsHtml = q.items
      .map(
        (it) => `
      <tr>
        <td style="padding:6px 8px;border:1px solid #e2e8f0">${it.productName || ''}</td>
        <td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:center">${it.quantity}</td>
        <td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right">${fmtMoney(it.unitPrice)}</td>
        <td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right">${fmtMoney(it.discount)}</td>
        <td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right">${fmtMoney(it.subtotal)}</td>
      </tr>`
      )
      .join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>
  body { font-family: Arial; padding: 30px; color: #1e293b; }
  h1 { color: #047857; margin: 0 0 4px 0; }
  table { width:100%; border-collapse: collapse; margin-top:10px; font-size: 12px; }
  th { background:#ecfdf5; text-align:left; padding:6px 8px; border:1px solid #e2e8f0; }
  .totals { margin-top: 10px; text-align:right; font-size: 13px; }
  .totals div { margin: 2px 0; }
  .grand { font-size: 18px; color: #047857; font-weight: bold; }
</style></head><body>
  <h1>${clinic?.nombreComercial || clinic?.name || 'Consultorio Médico'}</h1>
  <div style="font-size:12px;color:#64748b">Cotización ${q.quotationNumber}</div>
  <div style="margin-top:14px;font-size:13px">
    <strong>Cliente:</strong> ${q.clientName || ''} ${q.clientCedula ? `(${q.clientCedula})` : ''}<br/>
    <strong>Fecha:</strong> ${new Date(q.createdAt).toLocaleDateString('es-EC')}<br/>
    ${q.validUntil ? `<strong>Válida hasta:</strong> ${new Date(q.validUntil).toLocaleDateString('es-EC')}<br/>` : ''}
  </div>
  <table>
    <thead><tr><th>Descripción</th><th>Cant.</th><th>P. Unit.</th><th>Desc.</th><th>Subtotal</th></tr></thead>
    <tbody>${itemsHtml}</tbody>
  </table>
  <div class="totals">
    <div>Subtotal: ${fmtMoney(q.subtotal)}</div>
    <div>Descuento: ${fmtMoney(q.discountTotal)}</div>
    <div>IVA: ${fmtMoney(q.taxAmount)}</div>
    <div class="grand">Total: ${fmtMoney(q.total)}</div>
  </div>
  ${q.notes ? `<div style="margin-top:14px;font-size:12px;color:#475569"><strong>Notas:</strong> ${q.notes}</div>` : ''}
  <div style="margin-top:30px;font-size:11px;color:#64748b;border-top:1px dashed #cbd5e1;padding-top:8px">
    Generado por: ${q.createdBy?.name || ''} — ${new Date(q.createdAt).toLocaleString('es-EC')}
  </div>
</body></html>`;

    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const buffer = await page.pdf({ format: 'A4', margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' } });
    await browser.close();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="cotizacion_${q.quotationNumber}.pdf"`);
    res.end(buffer);
  } catch (error) {
    res.status(500).json({ message: 'Error al generar PDF', error: error.message });
  }
};
