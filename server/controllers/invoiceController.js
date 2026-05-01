const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');
const Patient = require('../models/Patient');
const Clinic = require('../models/Clinic');
const InvoicingConfig = require('../models/InvoicingConfig');
const { loadForSigning } = require('./invoicingConfigController');

const { generarClaveAcceso } = require('../modules/invoicing/ec/accessKey');
const { buildFacturaXml } = require('../modules/invoicing/ec/xmlBuilder');
const { signXml } = require('../modules/invoicing/ec/xadesSigner');
const {
  enviarComprobante,
  autorizarComprobante,
} = require('../modules/invoicing/ec/sriClient');
const { buildRidePdf } = require('../modules/invoicing/ec/ride');
const { buildAnulacionXml } = require('../modules/invoicing/ec/anular');

function fmtFechaEmision(d) {
  const dt = d ? new Date(d) : new Date();
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${dt.getFullYear()}`;
}

function tipoIdentificacion(cedula) {
  const c = String(cedula || '').trim();
  if (!c || c === '9999999999999') return '07'; // consumidor final
  if (/^\d{13}$/.test(c)) return '04'; // RUC
  if (/^\d{10}$/.test(c)) return '05'; // cédula
  return '06'; // pasaporte / otros
}

/**
 * Emite una factura electrónica a partir de una venta.
 * Roles permitidos: admin, cajero, contabilidad
 */
exports.emitFromSale = async (req, res) => {
  let invoice;
  try {
    const { saleId } = req.params;
    const sale = await Sale.findOne({ _id: saleId, clinic: req.clinicId }).populate(
      'patient',
      'firstName lastName cedula address phone email'
    );
    if (!sale) return res.status(404).json({ message: 'Venta no encontrada' });
    if (sale.invoice) {
      return res
        .status(400)
        .json({ message: 'La venta ya tiene una factura asociada' });
    }
    if (sale.status === 'anulada') {
      return res.status(400).json({ message: 'No se puede facturar una venta anulada' });
    }

    const { config, p12Buffer, password } = await loadForSigning(req.clinicId);
    const clinic = await Clinic.findById(req.clinicId);

    // Reservar secuencial atómicamente
    const secuencial = await config.reserveSequential();

    // Datos del comprador
    const compradorIdent =
      sale.clientCedula || (sale.patient && sale.patient.cedula) || '9999999999999';
    const compradorNombre =
      sale.clientName ||
      (sale.patient && `${sale.patient.firstName} ${sale.patient.lastName}`.trim()) ||
      'CONSUMIDOR FINAL';
    const compradorEmail = sale.clientEmail || (sale.patient && sale.patient.email) || '';
    const compradorTel = sale.clientPhone || (sale.patient && sale.patient.phone) || '';
    const compradorDir =
      sale.clientAddress || (sale.patient && sale.patient.address) || '';

    const fechaEmision = sale.createdAt || new Date();
    const claveAcceso = generarClaveAcceso({
      fechaEmision,
      tipoComprobante: 'factura',
      ruc: config.ruc,
      ambiente: config.ambiente,
      estab: config.establecimiento,
      puntoEmision: config.puntoEmision,
      secuencial,
    });

    // Mapear ítems
    const detalles = sale.items.map((it) => {
      const cantidad = Number(it.quantity);
      const precioUnitario = Number(it.unitPrice);
      const precioTotalSin = +(cantidad * precioUnitario).toFixed(2);
      const tarifa = Number(it.taxRate || 0);
      const valorIva = +(precioTotalSin * (tarifa / 100)).toFixed(2);
      // Códigos SRI IVA: 2 = IVA, codigoPorcentaje 0=0%, 2=12%, 3=14%, 4=15%
      let codigoPorcentaje = '0';
      if (tarifa === 12) codigoPorcentaje = '2';
      else if (tarifa === 14) codigoPorcentaje = '3';
      else if (tarifa === 15) codigoPorcentaje = '4';
      return {
        codigoPrincipal: it.productCode || String(it.product),
        descripcion: it.productName,
        cantidad,
        precioUnitario,
        descuento: 0,
        precioTotalSinImpuesto: precioTotalSin,
        impuestos: [
          {
            codigo: '2',
            codigoPorcentaje,
            tarifa,
            baseImponible: precioTotalSin,
            valor: valorIva,
          },
        ],
      };
    });

    // Totales por código de IVA (agrupados)
    const totalImpuestosMap = new Map();
    for (const d of detalles) {
      for (const imp of d.impuestos) {
        const key = `${imp.codigo}-${imp.codigoPorcentaje}`;
        const cur = totalImpuestosMap.get(key) || {
          codigo: imp.codigo,
          codigoPorcentaje: imp.codigoPorcentaje,
          baseImponible: 0,
          valor: 0,
        };
        cur.baseImponible += imp.baseImponible;
        cur.valor += imp.valor;
        totalImpuestosMap.set(key, cur);
      }
    }
    const totalConImpuestos = Array.from(totalImpuestosMap.values()).map((t) => ({
      ...t,
      baseImponible: +t.baseImponible.toFixed(2),
      valor: +t.valor.toFixed(2),
    }));

    // Forma de pago SRI: 01 sin sistema financiero | 16 débito | 19 crédito | 20 transferencia
    const FORMA_PAGO = {
      efectivo: '01',
      tarjeta_debito: '16',
      tarjeta_credito: '19',
      transferencia: '20',
    };

    const factura = {
      infoTributaria: {
        ambiente: config.ambiente,
        tipoEmision: '1',
        razonSocial: config.razonSocial,
        nombreComercial: config.nombreComercial,
        ruc: config.ruc,
        claveAcceso,
        codDoc: '01',
        estab: config.establecimiento,
        ptoEmi: config.puntoEmision,
        secuencial,
        dirMatriz: config.direccionMatriz,
        agenteRetencion: config.agenteRetencion || undefined,
      },
      infoFactura: {
        fechaEmision: fmtFechaEmision(fechaEmision),
        dirEstablecimiento: config.direccionEstablecimiento || config.direccionMatriz,
        contribuyenteEspecial: config.contribuyenteEspecial || undefined,
        obligadoContabilidad: config.obligadoContabilidad,
        tipoIdentificacionComprador: tipoIdentificacion(compradorIdent),
        razonSocialComprador: compradorNombre,
        identificacionComprador: compradorIdent,
        direccionComprador: compradorDir || undefined,
        totalSinImpuestos: sale.subtotal,
        totalDescuento: 0,
        totalConImpuestos,
        propina: 0,
        importeTotal: sale.total,
        moneda: 'DOLAR',
        pagos: [
          {
            formaPago: FORMA_PAGO[sale.paymentMethod] || '01',
            total: sale.total,
            plazo: 0,
            unidadTiempo: 'dias',
          },
        ],
      },
      detalles,
      infoAdicional: [
        compradorEmail ? { nombre: 'Email', valor: compradorEmail } : null,
        compradorTel ? { nombre: 'Telefono', valor: compradorTel } : null,
        clinic ? { nombre: 'Establecimiento', valor: clinic.name } : null,
      ].filter(Boolean),
    };

    // Construir Invoice en BD primero, en cola
    invoice = await Invoice.create({
      clinic: req.clinicId,
      sale: sale._id,
      claveAcceso,
      secuencial,
      estab: config.establecimiento,
      ptoEmi: config.puntoEmision,
      ambiente: config.ambiente,
      fechaEmision: fmtFechaEmision(fechaEmision),
      estado: 'EN_COLA',
      tipoIdentificacionComprador: tipoIdentificacion(compradorIdent),
      identificacionComprador: compradorIdent,
      razonSocialComprador: compradorNombre,
      direccionComprador: compradorDir,
      emailComprador: compradorEmail,
      telefonoComprador: compradorTel,
      totalSinImpuestos: sale.subtotal,
      totalDescuento: 0,
      totalImpuesto: sale.taxAmount,
      importeTotal: sale.total,
      createdBy: req.user._id,
    });

    sale.invoice = invoice._id;
    await sale.save();

    // Generar XML, firmar y enviar
    const xml = buildFacturaXml(factura);
    const xmlFirmado = signXml(xml, p12Buffer, password);
    invoice.xmlFirmado = xmlFirmado;
    await invoice.save();

    // Recepción
    const recepcion = await enviarComprobante(xmlFirmado, config.ambiente);
    invoice.estado = recepcion?.estado === 'RECIBIDA' ? 'RECIBIDA' : 'DEVUELTA';
    if (recepcion?.comprobantes?.comprobante?.mensajes) {
      const mensajes = recepcion.comprobantes.comprobante.mensajes.mensaje;
      invoice.mensajesSri = (Array.isArray(mensajes) ? mensajes : [mensajes]).map((m) => ({
        identificador: m.identificador,
        mensaje: m.mensaje,
        informacionAdicional: m.informacionAdicional,
        tipo: m.tipo,
      }));
    }
    await invoice.save();

    if (invoice.estado !== 'RECIBIDA') {
      return res.status(400).json({
        message: 'El SRI rechazó el comprobante',
        invoice,
      });
    }

    // Autorización (puede tardar; reintento ligero)
    let aut;
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      aut = await autorizarComprobante(claveAcceso, config.ambiente);
      const list = aut?.autorizaciones?.autorizacion;
      const item = Array.isArray(list) ? list[0] : list;
      if (item) {
        if (item.estado === 'AUTORIZADO') {
          invoice.estado = 'AUTORIZADO';
          invoice.numeroAutorizacion = item.numeroAutorizacion;
          invoice.fechaAutorizacion = item.fechaAutorizacion;
          invoice.xmlAutorizado = item.comprobante;
          break;
        } else if (item.estado === 'NO AUTORIZADO') {
          invoice.estado = 'NO_AUTORIZADO';
          if (item.mensajes?.mensaje) {
            const ms = Array.isArray(item.mensajes.mensaje)
              ? item.mensajes.mensaje
              : [item.mensajes.mensaje];
            invoice.mensajesSri = ms.map((m) => ({
              identificador: m.identificador,
              mensaje: m.mensaje,
              informacionAdicional: m.informacionAdicional,
              tipo: m.tipo,
            }));
          }
          break;
        }
      }
      invoice.estado = 'EN_PROCESO';
    }
    await invoice.save();

    res.status(201).json(invoice);
  } catch (error) {
    if (invoice) {
      invoice.estado = 'ERROR';
      invoice.mensajesSri = [
        ...(invoice.mensajesSri || []),
        { identificador: 'EXCEPTION', mensaje: error.message },
      ];
      try {
        await invoice.save();
      } catch (_) {}
    }
    res
      .status(500)
      .json({ message: 'Error al emitir factura', error: error.message });
  }
};

exports.list = async (req, res) => {
  try {
    const { startDate, endDate, estado, patient, page = 1, limit = 20 } = req.query;
    const query = { clinic: req.clinicId };
    if (estado) query.estado = estado;
    if (startDate && endDate) {
      query.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }
    if (patient) {
      const saleIds = await Sale.find({ clinic: req.clinicId, patient }).distinct('_id');
      query.sale = { $in: saleIds };
    }
    const invoices = await Invoice.find(query)
      .populate('sale', 'saleNumber total')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));
    const total = await Invoice.countDocuments(query);
    res.json({
      invoices,
      total,
      pages: Math.ceil(total / limit),
      currentPage: parseInt(page),
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener facturas' });
  }
};

exports.get = async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, clinic: req.clinicId })
      .populate({
        path: 'sale',
        populate: { path: 'items.product', select: 'name code' },
      });
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada' });
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener factura' });
  }
};

exports.getRidePdf = async (req, res) => {
  try {
    const invoice = await Invoice.findOne({
      _id: req.params.id,
      clinic: req.clinicId,
    }).populate('sale');
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada' });

    const config = await InvoicingConfig.findOne({ clinic: req.clinicId });
    const clinic = await Clinic.findById(req.clinicId);

    const pdf = await buildRidePdf({
      invoice,
      sale: invoice.sale,
      config,
      clinic,
      autorizacion: {
        fechaAutorizacion: invoice.fechaAutorizacion,
      },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="factura-${invoice.estab}-${invoice.ptoEmi}-${invoice.secuencial}.pdf"`
    );
    res.send(pdf);
  } catch (error) {
    res.status(500).json({ message: 'Error al generar PDF', error: error.message });
  }
};

exports.retry = async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada' });
    if (!['ERROR', 'DEVUELTA', 'EN_PROCESO'].includes(invoice.estado)) {
      return res
        .status(400)
        .json({ message: `No se puede reintentar en estado ${invoice.estado}` });
    }
    const { config } = await loadForSigning(req.clinicId);
    const aut = await autorizarComprobante(invoice.claveAcceso, config.ambiente);
    const list = aut?.autorizaciones?.autorizacion;
    const item = Array.isArray(list) ? list[0] : list;
    if (item?.estado === 'AUTORIZADO') {
      invoice.estado = 'AUTORIZADO';
      invoice.numeroAutorizacion = item.numeroAutorizacion;
      invoice.fechaAutorizacion = item.fechaAutorizacion;
      invoice.xmlAutorizado = item.comprobante;
      await invoice.save();
    }
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ message: 'Error al reintentar', error: error.message });
  }
};

exports.anular = async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada' });
    if (invoice.estado === 'ANULADA') {
      return res.status(400).json({ message: 'La factura ya está anulada' });
    }
    const { motivo } = req.body;
    if (!motivo || motivo.length < 5) {
      return res
        .status(400)
        .json({ message: 'El motivo de anulación es requerido (mínimo 5 caracteres)' });
    }

    const config = await InvoicingConfig.findOne({ clinic: req.clinicId });
    const xmlAnulacion = buildAnulacionXml({
      claveAcceso: invoice.claveAcceso,
      ruc: config.ruc,
      razonSocial: config.razonSocial,
      motivo,
      secuencial: invoice.secuencial,
      fecha: invoice.fechaEmision,
    });

    invoice.estado = 'ANULADA';
    invoice.anuladaAt = new Date();
    invoice.anuladaBy = req.user._id;
    invoice.motivoAnulacion = motivo;
    invoice.xmlAnulacion = xmlAnulacion;
    await invoice.save();

    res.json({
      message:
        'Factura marcada como anulada localmente. Recuerde que la anulación efectiva debe realizarse en el portal del SRI (https://srienlinea.sri.gob.ec).',
      invoice,
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al anular factura', error: error.message });
  }
};
