const CreditDebitNote = require('../models/CreditDebitNote');
const Invoice = require('../models/Invoice');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const { createEntry, findAccount, reverseEntry, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const Clinic = require('../models/Clinic');
const { loadForSigning } = require('./invoicingConfigController');
const { generarClaveAcceso } = require('../modules/invoicing/ec/accessKey');
const { buildNotaCreditoXml } = require('../modules/invoicing/ec/xmlBuilder');
const { signXml } = require('../modules/invoicing/ec/xadesSigner');
const { enviarComprobante, autorizarComprobante } = require('../modules/invoicing/ec/sriClient');

function fmtFecha(d) {
  const dt = d ? new Date(d) : new Date();
  return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
}
function mapMensajes(node) {
  if (!node) return [];
  const arr = Array.isArray(node) ? node : [node];
  return arr.map((m) => ({ identificador: m.identificador, mensaje: m.mensaje, informacionAdicional: m.informacionAdicional, tipo: m.tipo }));
}

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

/**
 * Tarifa y desglose por tarifa de una nota de crédito/débito.
 *  - Si el cuerpo trae un `taxBreakdown` explícito, se respeta.
 *  - Si trae `ivaRate`, se usa esa tarifa.
 *  - Si no, se infiere del IVA: IVA>0 ⇒ toda la base es gravada (≠0%); IVA=0 ⇒ tarifa 0%.
 * La declaración SRI resta la nota de la base de su misma tarifa a partir de esto.
 */
function deriveNoteTax(body = {}, subtotal, iva) {
  const num = (x) => +Number(x || 0).toFixed(2);
  if (body.taxBreakdown && typeof body.taxBreakdown === 'object') {
    const tb = body.taxBreakdown;
    const taxBreakdown = {
      base0: num(tb.base0), baseGravada: num(tb.baseGravada), baseExento: num(tb.baseExento),
      baseNoObjeto: num(tb.baseNoObjeto), iva: num(tb.iva != null ? tb.iva : iva),
    };
    const rate = body.ivaRate != null ? Number(body.ivaRate) : (taxBreakdown.baseGravada > 0 ? 15 : 0);
    return { ivaRate: rate, taxBreakdown };
  }
  const rate = body.ivaRate != null ? Number(body.ivaRate) : (iva > 0 ? 15 : 0);
  const gravada = rate > 0 || iva > 0;
  return {
    ivaRate: rate,
    taxBreakdown: {
      base0: gravada ? 0 : num(subtotal),
      baseGravada: gravada ? num(subtotal) : 0,
      baseExento: 0,
      baseNoObjeto: 0,
      iva: num(iva),
    },
  };
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

      // Tarifa/desglose de la nota: para que las declaraciones SRI resten la nota de la
      // base de su MISMA tarifa. Se toma el desglose explícito si viene; si no, se infiere
      // del IVA (>0 ⇒ base gravada ≠0%, =0 ⇒ base tarifa 0%).
      const { ivaRate: noteRate, taxBreakdown: noteTb } = deriveNoteTax(req.body, noteSubtotal, noteIva);

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
        ivaRate: noteRate,
        taxBreakdown: noteTb,
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

/**
 * Emite electrónicamente una Nota de Crédito (cod 04) ya registrada que modifica
 * una factura electrónica: clave de acceso, XML firmado, envío y autorización SRI.
 */
exports.emit = async (req, res) => {
  let note;
  try {
    note = await CreditDebitNote.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!note) return res.status(404).json({ message: 'Nota no encontrada' });
    if (note.kind !== 'NC' || note.direction !== 'EMITIDA') {
      return res.status(400).json({ message: 'Solo se emiten electrónicamente notas de crédito emitidas' });
    }
    if (note.refModel !== 'Invoice') {
      return res.status(400).json({ message: 'La nota debe referenciar una factura electrónica' });
    }
    if (['AUTORIZADO', 'RECIBIDA', 'EN_PROCESO'].includes(note.estado)) {
      return res.status(400).json({ message: `La nota ya está en estado ${note.estado}` });
    }
    const invoice = await Invoice.findOne({ _id: note.refDoc, clinic: req.clinicId });
    if (!invoice) return res.status(400).json({ message: 'Factura referenciada no encontrada' });

    const { config, p12Buffer, password } = await loadForSigning(req.clinicId);
    const clinic = await Clinic.findById(req.clinicId);
    const secuencial = await config.reserveCreditNoteSequential();
    const fechaEmision = note.fechaEmision || new Date();
    const claveAcceso = generarClaveAcceso({
      fechaEmision, tipoComprobante: 'notaCredito', ruc: config.ruc, ambiente: config.ambiente,
      estab: config.establecimiento, puntoEmision: config.puntoEmision, secuencial,
    });

    const subtotal = +Number(note.subtotal || 0).toFixed(2);
    const iva = +Number(note.iva || 0).toFixed(2);
    const codigoPorcentaje = iva > 0 ? '4' : '0';
    const tarifa = iva > 0 ? 15 : 0;
    const numDocModificado = `${invoice.estab}-${invoice.ptoEmi}-${invoice.secuencial}`;

    const detalles = (Array.isArray(note.items) && note.items.length ? note.items : [{
      descripcion: note.motivo || 'Nota de crédito', cantidad: 1, precioUnitario: subtotal, base: subtotal, iva,
    }]).map((it) => {
      const cantidad = Number(it.cantidad || it.quantity || 1);
      const base = +Number(it.base ?? it.precioTotalSinImpuesto ?? it.subtotal ?? subtotal).toFixed(2);
      const valorIva = +Number(it.iva ?? it.valor ?? iva).toFixed(2);
      return {
        codigoInterno: it.codigoInterno || it.productCode || 'NC',
        descripcion: it.descripcion || it.productName || note.motivo || 'Nota de crédito',
        cantidad,
        precioUnitario: cantidad ? +(base / cantidad).toFixed(6) : base,
        descuento: 0,
        precioTotalSinImpuesto: base,
        impuestos: [{ codigo: '2', codigoPorcentaje, tarifa, baseImponible: base, valor: valorIva }],
      };
    });

    const nota = {
      infoTributaria: {
        ambiente: config.ambiente, tipoEmision: '1', razonSocial: config.razonSocial,
        nombreComercial: config.nombreComercial || undefined, ruc: config.ruc, claveAcceso,
        estab: config.establecimiento, ptoEmi: config.puntoEmision, secuencial, dirMatriz: config.direccionMatriz,
      },
      infoNotaCredito: {
        fechaEmision: fmtFecha(fechaEmision),
        dirEstablecimiento: config.direccionEstablecimiento || config.direccionMatriz,
        tipoIdentificacionComprador: invoice.tipoIdentificacionComprador,
        razonSocialComprador: invoice.razonSocialComprador,
        identificacionComprador: invoice.identificacionComprador,
        contribuyenteEspecial: config.contribuyenteEspecial || undefined,
        obligadoContabilidad: config.obligadoContabilidad || 'NO',
        codDocModificado: '01',
        numDocModificado,
        fechaEmisionDocSustento: typeof invoice.fechaEmision === 'string' ? invoice.fechaEmision : fmtFecha(invoice.fechaEmision),
        totalSinImpuestos: subtotal,
        valorModificacion: +Number(note.total || subtotal + iva).toFixed(2),
        moneda: 'DOLAR',
        totalConImpuestos: [{ codigo: '2', codigoPorcentaje, baseImponible: subtotal, valor: iva }],
        motivo: note.motivo || 'Nota de crédito',
      },
      detalles,
      infoAdicional: [clinic ? { nombre: 'Establecimiento', valor: clinic.name } : null].filter(Boolean),
    };

    note.estab = config.establecimiento;
    note.ptoEmi = config.puntoEmision;
    note.secuencial = secuencial;
    note.serie = `${config.establecimiento}-${config.puntoEmision}-${secuencial}`;
    note.claveAcceso = claveAcceso;
    note.estado = 'EN_COLA';
    await note.save();

    const xml = buildNotaCreditoXml(nota);
    const xmlFirmado = signXml(xml, p12Buffer, password);
    note.xmlFirmado = xmlFirmado;
    await note.save();

    const recepcion = await enviarComprobante(xmlFirmado, config.ambiente);
    note.estado = recepcion?.estado === 'RECIBIDA' ? 'RECIBIDA' : 'DEVUELTA';
    await note.save();
    if (note.estado !== 'RECIBIDA') {
      return res.status(400).json({ message: 'El SRI rechazó la nota de crédito', note, mensajes: mapMensajes(recepcion?.comprobantes?.comprobante?.mensajes?.mensaje) });
    }

    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const aut = await autorizarComprobante(claveAcceso, config.ambiente);
      const list = aut?.autorizaciones?.autorizacion;
      const item = Array.isArray(list) ? list[0] : list;
      if (item?.estado === 'AUTORIZADO') {
        note.estado = 'AUTORIZADO';
        note.autorizacion = item.numeroAutorizacion;
        note.xmlAutorizado = item.comprobante;
        break;
      } else if (item?.estado === 'NO AUTORIZADO') {
        note.estado = 'NO_AUTORIZADO';
        break;
      }
      note.estado = 'EN_PROCESO';
    }
    await note.save();
    res.json(note);
  } catch (error) {
    if (note) { note.estado = 'ERROR'; try { await note.save(); } catch (_) {} }
    res.status(500).json({ message: 'Error al emitir nota de crédito', error: error.message });
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
