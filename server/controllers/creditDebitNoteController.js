const CreditDebitNote = require('../models/CreditDebitNote');
const Invoice = require('../models/Invoice');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const { createEntry, findAccount, reverseEntry } = require('../utils/accounting');

exports.list = async (req, res) => {
  const { kind, direction, startDate, endDate, page = 1, limit = 20 } = req.query;
  const filter = { clinic: req.clinicId };
  if (kind) filter.kind = kind;
  if (direction) filter.direction = direction;
  if (startDate || endDate) {
    filter.fechaEmision = {};
    if (startDate) filter.fechaEmision.$gte = new Date(startDate);
    if (endDate) filter.fechaEmision.$lte = new Date(endDate);
  }
  const total = await CreditDebitNote.countDocuments(filter);
  const items = await CreditDebitNote.find(filter)
    .sort({ fechaEmision: -1 }).skip((page - 1) * limit).limit(parseInt(limit));
  res.json({ items, total, pages: Math.ceil(total / limit), currentPage: parseInt(page) });
};

exports.get = async (req, res) => {
  const n = await CreditDebitNote.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!n) return res.status(404).json({ message: 'No encontrada' });
  res.json(n);
};

/**
 * Crea NC/ND. Para emitidas (NC venta) genera asiento que reversa parcialmente la venta.
 */
exports.create = async (req, res) => {
  try {
    const { kind, direction, refModel, refDoc, motivo, items, subtotal, iva, total, fechaEmision, estab, ptoEmi, secuencial } = req.body;
    if (!['NC', 'ND'].includes(kind)) return res.status(400).json({ message: 'kind inválido' });
    if (!['EMITIDA', 'RECIBIDA'].includes(direction)) return res.status(400).json({ message: 'direction inválido' });

    let origin = null;
    if (refModel === 'Invoice') origin = await Invoice.findOne({ _id: refDoc, clinic: req.clinicId });
    else origin = await PurchaseInvoice.findOne({ _id: refDoc, clinic: req.clinicId });
    if (!origin) return res.status(404).json({ message: 'Documento referencia no encontrado' });

    const serie = `${estab || '001'}-${ptoEmi || '001'}-${secuencial || ''}`;
    const note = await CreditDebitNote.create({
      clinic: req.clinicId, kind, direction, refModel, refDoc,
      serieAfecta: origin.serie || `${origin.estab}-${origin.ptoEmi}-${origin.secuencial}`,
      fechaEmisionAfecta: origin.fechaEmision,
      estab, ptoEmi, secuencial, serie,
      fechaEmision: fechaEmision ? new Date(fechaEmision) : new Date(),
      motivo, items: items || [], subtotal: subtotal || 0, iva: iva || 0, total: total || 0,
      createdBy: req.user._id,
    });

    // Asiento contable
    const lines = [];
    if (kind === 'NC' && direction === 'EMITIDA') {
      // Disminuir ingresos y IVA en ventas, y disminuir CxC clientes
      const ingreso = await findAccount(req.clinicId, { code: '4.1.02' });
      const ivaV = await findAccount(req.clinicId, { taxCode: 'IVA_VENTAS' });
      const clientes = await findAccount(req.clinicId, { code: '1.1.02.01' });
      lines.push({ account: ingreso._id, debit: subtotal || 0, credit: 0, description: motivo });
      if (iva) lines.push({ account: ivaV._id, debit: iva, credit: 0, description: 'IVA NC' });
      lines.push({ account: clientes._id, debit: 0, credit: total || 0, description: 'NC clientes' });
    } else if (kind === 'NC' && direction === 'RECIBIDA') {
      // Disminuye gasto/inventario, disminuye IVA compras, disminuye CxP
      const gasto = await findAccount(req.clinicId, { code: '6.1.99' });
      const ivaC = await findAccount(req.clinicId, { taxCode: 'IVA_COMPRAS' });
      const prov = await findAccount(req.clinicId, { code: '2.1.01.01' });
      lines.push({ account: prov._id, debit: total || 0, credit: 0, description: 'NC recibida' });
      lines.push({ account: gasto._id, debit: 0, credit: subtotal || 0, description: motivo });
      if (iva) lines.push({ account: ivaC._id, debit: 0, credit: iva, description: 'IVA NC' });
    } else if (kind === 'ND' && direction === 'EMITIDA') {
      const ingreso = await findAccount(req.clinicId, { code: '4.2.02' });
      const ivaV = await findAccount(req.clinicId, { taxCode: 'IVA_VENTAS' });
      const clientes = await findAccount(req.clinicId, { code: '1.1.02.01' });
      lines.push({ account: clientes._id, debit: total || 0, credit: 0, description: 'ND clientes' });
      lines.push({ account: ingreso._id, debit: 0, credit: subtotal || 0, description: motivo });
      if (iva) lines.push({ account: ivaV._id, debit: 0, credit: iva, description: 'IVA ND' });
    } else {
      const gasto = await findAccount(req.clinicId, { code: '6.1.99' });
      const ivaC = await findAccount(req.clinicId, { taxCode: 'IVA_COMPRAS' });
      const prov = await findAccount(req.clinicId, { code: '2.1.01.01' });
      lines.push({ account: gasto._id, debit: subtotal || 0, credit: 0, description: motivo });
      if (iva) lines.push({ account: ivaC._id, debit: iva, credit: 0, description: 'IVA ND' });
      lines.push({ account: prov._id, debit: 0, credit: total || 0, description: 'ND recibida' });
    }
    const entry = await createEntry({
      clinicId: req.clinicId, date: note.fechaEmision,
      description: `${kind} ${direction} ${note.serie} - ${motivo || ''}`,
      source: kind, sourceRef: note._id, sourceModel: 'CreditDebitNote',
      lines, userId: req.user._id,
    });
    note.journalEntry = entry._id;
    await note.save();
    res.status(201).json(note);
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

exports.void = async (req, res) => {
  try {
    const n = await CreditDebitNote.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!n) return res.status(404).json({ message: 'No encontrada' });
    if (n.estado === 'ANULADA') return res.status(400).json({ message: 'Ya anulada' });
    if (n.journalEntry) await reverseEntry({ clinicId: req.clinicId, entryId: n.journalEntry, userId: req.user._id, reason: 'Anulación NC/ND' });
    n.estado = 'ANULADA';
    await n.save();
    res.json({ message: 'Anulada' });
  } catch (e) { res.status(400).json({ message: e.message }); }
};
