const CreditDebitNote = require('../models/CreditDebitNote');
const Invoice = require('../models/Invoice');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const { createEntry, findAccount, reverseEntry, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');

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
    .sort({ fechaEmision: -1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit, 10));
  res.json({ items, total, pages: Math.ceil(total / limit), currentPage: parseInt(page, 10) });
};

exports.get = async (req, res) => {
  const note = await CreditDebitNote.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!note) return res.status(404).json({ message: 'No encontrada' });
  res.json(note);
};

function affectedSerie(origin) {
  return origin.serie || `${origin.estab || ''}-${origin.ptoEmi || ''}-${origin.secuencial || ''}`;
}

async function getOrigin(refModel, refDoc, clinicId, session) {
  if (refModel === 'Invoice') return Invoice.findOne({ _id: refDoc, clinic: clinicId }).session(session);
  if (refModel === 'PurchaseInvoice') return PurchaseInvoice.findOne({ _id: refDoc, clinic: clinicId }).session(session);
  return null;
}

exports.create = async (req, res) => {
  try {
    const noteId = await runInTransaction(async (session) => {
      const { kind, direction, refModel, refDoc, motivo, items, subtotal, iva, total, fechaEmision, estab, ptoEmi, secuencial } = req.body;
      if (!['NC', 'ND'].includes(kind)) throw Object.assign(new Error('kind invalido'), { status: 400 });
      if (!['EMITIDA', 'RECIBIDA'].includes(direction)) throw Object.assign(new Error('direction invalido'), { status: 400 });

      const noteDate = fechaEmision ? new Date(fechaEmision) : new Date();
      await assertPeriodOpen(req.clinicId, noteDate, { session });
      const noteSubtotal = +Number(subtotal || 0).toFixed(2);
      const noteIva = +Number(iva || 0).toFixed(2);
      const noteTotal = +Number(total || (noteSubtotal + noteIva)).toFixed(2);
      if (noteTotal <= 0) throw Object.assign(new Error('Total de nota invalido'), { status: 400 });

      const origin = await getOrigin(refModel, refDoc, req.clinicId, session);
      if (!origin) throw Object.assign(new Error('Documento referencia no encontrado'), { status: 404 });
      if (origin.estado === 'ANULADA' || origin.status === 'ANULADA') {
        throw Object.assign(new Error('No se puede emitir nota sobre documento anulado'), { status: 400 });
      }
      if (noteTotal > Number(origin.total || origin.importeTotal || 0) + 0.01) {
        throw Object.assign(new Error('La nota no puede exceder el total del documento afectado'), { status: 400 });
      }

      const serie = `${estab || '001'}-${ptoEmi || '001'}-${secuencial || ''}`;
      const [note] = await CreditDebitNote.create([{
        clinic: req.clinicId,
        kind,
        direction,
        refModel,
        refDoc,
        serieAfecta: affectedSerie(origin),
        fechaEmisionAfecta: origin.fechaEmision,
        estab,
        ptoEmi,
        secuencial,
        serie,
        fechaEmision: noteDate,
        motivo,
        items: items || [],
        subtotal: noteSubtotal,
        iva: noteIva,
        total: noteTotal,
        createdBy: req.user._id,
      }], { session });

      const lines = [];
      if (kind === 'NC' && direction === 'EMITIDA') {
        const ingreso = await getAccount(req.clinicId, 'ingresoProductos', { session });
        const ivaV = await getAccount(req.clinicId, 'ivaVentas', { session });
        const clientes = await getAccount(req.clinicId, 'clientes', { session });
        lines.push({ account: ingreso._id, debit: noteSubtotal, credit: 0, description: motivo });
        if (noteIva) lines.push({ account: ivaV._id, debit: noteIva, credit: 0, description: 'IVA NC' });
        lines.push({ account: clientes._id, debit: 0, credit: noteTotal, description: 'NC clientes' });
        if (refModel === 'Invoice') {
          origin.balance = Math.max(0, Number(origin.balance ?? origin.importeTotal ?? origin.total ?? 0) - noteTotal);
          origin.paid = origin.balance <= 0.005;
          await origin.save({ session });
        }
      } else if (kind === 'NC' && direction === 'RECIBIDA') {
        const gasto = await getAccount(req.clinicId, 'otrosGastos', { session });
        const ivaC = await getAccount(req.clinicId, 'ivaCompras', { session });
        const prov = await getAccount(req.clinicId, 'proveedores', { session });
        lines.push({ account: prov._id, debit: noteTotal, credit: 0, description: 'NC recibida' });
        lines.push({ account: gasto._id, debit: 0, credit: noteSubtotal, description: motivo });
        if (noteIva) lines.push({ account: ivaC._id, debit: 0, credit: noteIva, description: 'IVA NC' });
        if (refModel === 'PurchaseInvoice') {
          origin.balance = Math.max(0, Number(origin.balance ?? origin.total ?? 0) - noteTotal);
          origin.paid = origin.balance <= 0.005;
          if (origin.paid && origin.status !== 'ANULADA') origin.status = 'PAGADA';
          await origin.save({ session });
        }
      } else if (kind === 'ND' && direction === 'EMITIDA') {
        const ingreso = await getAccount(req.clinicId, 'otrosIngresos', { session });
        const ivaV = await getAccount(req.clinicId, 'ivaVentas', { session });
        const clientes = await getAccount(req.clinicId, 'clientes', { session });
        lines.push({ account: clientes._id, debit: noteTotal, credit: 0, description: 'ND clientes' });
        lines.push({ account: ingreso._id, debit: 0, credit: noteSubtotal, description: motivo });
        if (noteIva) lines.push({ account: ivaV._id, debit: 0, credit: noteIva, description: 'IVA ND' });
        if (refModel === 'Invoice') {
          origin.balance = +(Number(origin.balance || 0) + noteTotal).toFixed(2);
          origin.paid = false;
          await origin.save({ session });
        }
      } else {
        const gasto = await getAccount(req.clinicId, 'otrosGastos', { session });
        const ivaC = await getAccount(req.clinicId, 'ivaCompras', { session });
        const prov = await getAccount(req.clinicId, 'proveedores', { session });
        lines.push({ account: gasto._id, debit: noteSubtotal, credit: 0, description: motivo });
        if (noteIva) lines.push({ account: ivaC._id, debit: noteIva, credit: 0, description: 'IVA ND' });
        lines.push({ account: prov._id, debit: 0, credit: noteTotal, description: 'ND recibida' });
        if (refModel === 'PurchaseInvoice') {
          origin.balance = +(Number(origin.balance || 0) + noteTotal).toFixed(2);
          origin.paid = false;
          if (origin.status === 'PAGADA') origin.status = 'REGISTRADA';
          await origin.save({ session });
        }
      }

      const entry = await createEntry({
        clinicId: req.clinicId,
        date: note.fechaEmision,
        description: `${kind} ${direction} ${note.serie} - ${motivo || ''}`,
        source: kind,
        sourceRef: note._id,
        sourceModel: 'CreditDebitNote',
        sourceAction: 'POST',
        lines,
        userId: req.user._id,
        session,
      });
      note.journalEntry = entry._id;
      await note.save({ session });
      return note._id;
    });
    const note = await CreditDebitNote.findById(noteId);
    res.status(201).json(note);
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

exports.void = async (req, res) => {
  try {
    const result = await runInTransaction(async (session) => {
      const note = await CreditDebitNote.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!note) throw Object.assign(new Error('No encontrada'), { status: 404 });
      if (note.estado === 'ANULADA') throw Object.assign(new Error('Ya anulada'), { status: 400 });
      const reversalDate = req.body.date ? new Date(req.body.date) : new Date();
      await assertPeriodOpen(req.clinicId, reversalDate, { session });

      if (note.journalEntry) {
        await reverseEntry({
          clinicId: req.clinicId,
          entryId: note.journalEntry,
          userId: req.user._id,
          reason: 'Anulacion NC/ND',
          date: reversalDate,
          session,
        });
      }

      const origin = await getOrigin(note.refModel, note.refDoc, req.clinicId, session);
      if (origin) {
        const amount = Number(note.total || 0);
        if (note.kind === 'NC') {
          origin.balance = +(Number(origin.balance || 0) + amount).toFixed(2);
          origin.paid = false;
          if (origin.status === 'PAGADA') origin.status = 'REGISTRADA';
        } else {
          origin.balance = Math.max(0, Number(origin.balance || 0) - amount);
          origin.paid = origin.balance <= 0.005;
          if (origin.paid && origin.status && origin.status !== 'ANULADA') origin.status = 'PAGADA';
        }
        await origin.save({ session });
      }

      note.estado = 'ANULADA';
      await note.save({ session });
      return { message: 'Anulada' };
    });
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};
