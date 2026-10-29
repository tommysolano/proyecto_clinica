const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');
const Patient = require('../models/Patient');
const Clinic = require('../models/Clinic');
const InvoicingConfig = require('../models/InvoicingConfig');
const { loadForSigning } = require('./invoicingConfigController');

const { breakdownFromSale } = require('../utils/invoiceTaxBreakdown');

const { generarClaveAcceso } = require('../modules/invoicing/ec/accessKey');
const { buildFacturaXml } = require('../modules/invoicing/ec/xmlBuilder');
const { signXml } = require('../modules/invoicing/ec/xadesSigner');
const { checkSriAvailability } = require('../modules/invoicing/ec/sriClient');
const { buildRidePdf } = require('../modules/invoicing/ec/ride');
const { buildAnulacionXml } = require('../modules/invoicing/ec/anular');
const {
  processInvoice,
  runInvoiceRetryQueue,
} = require('../utils/invoiceRetry');
const { isPastDocumentDate } = require('../utils/fiscalDocumentDate');
const { serieDelEmisor, reservarSecuencial, puntoDelUsuario, ambienteDelPunto } = require('../services/puntoEmision');
const { scopedDocuments } = require('../services/scopedDocuments');

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

/** Datos del comprador de una venta (paciente o cliente escrito a mano). */
function datosComprador(sale) {
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

  return { compradorIdent, compradorNombre, compradorEmail, compradorTel, compradorDir };
}

/**
 * TOTAL DE DESCUENTO del comprobante = la suma del `descuento` de cada detalle, que va
 * SIN impuestos. Antes se mandaba `sale.discountTotal` (con el IVA dentro cuando el
 * precio lo incluye) y no cuadraba con la suma de las líneas.
 */
function totalDescuentoDe(sale) {
  return +(sale.items || [])
    .reduce((s, it) => s + +Number(it.discountTaxBase ?? it.discount ?? 0).toFixed(2), 0)
    .toFixed(2);
}

/**
 * ARMA LA FACTURA (el objeto que se convierte en XML) de una venta. La usan la emisión y
 * el reintento que vuelve a firmar (oct-2026): los dos tienen que producir el MISMO XML.
 * `serie`: { estab, ptoEmi, dirEstablecimiento, ambiente }.
 */
function armarFactura({ sale, config, clinic, serie, secuencial, claveAcceso, fechaEmision }) {
  const { compradorIdent, compradorNombre, compradorEmail, compradorTel, compradorDir } = datosComprador(sale);
  // Mapear ítems
  const detalles = sale.items.map((it) => {
    const cantidad = Number(it.quantity);
    const precioUnitario = +Number(it.unitPriceExcludingTax || it.unitPrice || 0).toFixed(2);
    const descuento = +Number(it.discountTaxBase ?? it.discount ?? 0).toFixed(2);
    const precioTotalSin = +Number(it.taxBase ?? (cantidad * precioUnitario - descuento)).toFixed(2);
    const tarifa = Number(it.taxRate || 0);
    const valorIva = +Number(it.taxAmount ?? (precioTotalSin * (tarifa / 100))).toFixed(2);
    // Códigos SRI IVA: 2 = IVA, codigoPorcentaje 0=0%, 2=12%, 3=14%, 4=15%
    let codigoPorcentaje = it.taxCodeSri || '0';
    if (!it.taxCodeSri) {
      if (tarifa === 12) codigoPorcentaje = '2';
      else if (tarifa === 14) codigoPorcentaje = '3';
      else if (tarifa === 15) codigoPorcentaje = '4';
    }
    return {
      codigoPrincipal: it.productCode || String(it.product),
      descripcion: it.productName,
      cantidad,
      precioUnitario,
      descuento,
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
    tarjeta: '19',
    tarjeta_debito: '16',
    tarjeta_credito: '19',
    transferencia: '20',
    credito: '20',
    // Pagada con el saldo a favor del paciente (anticipo): 15 = compensación de deudas.
    anticipo: '15',
  };

  const totalSinImpuestos = +(sale.items || [])
    .reduce((sum, item) => sum + Number(item.taxBase || item.subtotal || 0), 0)
    .toFixed(2);

  // Snapshot tributario por tarifa (0% / gravada 15% / exento / no objeto) para
  // que los reportes SRI separen ventas sin recalcular desde la venta origen.
  const tb = breakdownFromSale(sale);

  const factura = {
    infoTributaria: {
      ambiente: serie.ambiente,
      tipoEmision: '1',
      razonSocial: config.razonSocial,
      nombreComercial: config.nombreComercial,
      ruc: config.ruc,
      claveAcceso,
      codDoc: '01',
      estab: serie.estab,
      ptoEmi: serie.ptoEmi,
      secuencial,
      dirMatriz: config.direccionMatriz,
      agenteRetencion: config.agenteRetencion || undefined,
    },
    infoFactura: {
      fechaEmision: fmtFechaEmision(fechaEmision),
      dirEstablecimiento: serie.dirEstablecimiento,
      contribuyenteEspecial: config.contribuyenteEspecial || undefined,
      obligadoContabilidad: config.obligadoContabilidad,
      tipoIdentificacionComprador: tipoIdentificacion(compradorIdent),
      razonSocialComprador: compradorNombre,
      identificacionComprador: compradorIdent,
      direccionComprador: compradorDir || undefined,
      totalSinImpuestos,
      totalDescuento: totalDescuentoDe(sale),
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

  return { factura, totalSinImpuestos, tb };
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
      /**
       * Una factura NO AUTORIZADA por el SRI no tiene validez y su número ya no se puede
       * reenviar (el SRI registró la clave). La venta se vuelve a facturar con un número
       * nuevo; la rechazada queda en el listado como constancia (oct-2026).
       */
      const anterior = await Invoice.findById(sale.invoice).select('estado');
      if (!anterior || anterior.estado !== 'NO_AUTORIZADO') {
        return res
          .status(400)
          .json({ message: 'La venta ya tiene una factura asociada' });
      }
      sale.invoice = null;
    }
    if (sale.status === 'anulada') {
      return res.status(400).json({ message: 'No se puede facturar una venta anulada' });
    }

    const { config, p12Buffer, password } = await loadForSigning(req.clinicId);
    const clinic = await Clinic.findById(req.clinicId);

    // Serie del que EMITE: su punto de emisión (caja) o, si la sucursal no usa puntos, la de
    // la configuración. Sin punto asignado se corta aquí, antes de gastar un número.
    const serie = await serieDelEmisor(req.clinicId, req.user._id, config);
    // Reservar secuencial atómicamente
    const secuencial = await reservarSecuencial(serie, 'factura', config);

    const { compradorIdent, compradorNombre, compradorEmail, compradorTel, compradorDir } = datosComprador(sale);

    // FECHA DE EMISIÓN AUTOMÁTICA, nunca atrasada. Normalmente es el momento de la venta
    // (misma fecha que su asiento); si la venta es de un día anterior, la factura se emite HOY:
    // una factura electrónica no se emite con fecha pasada (y el SRI la rechazaría).
    // OJO: esto solo aplica al MOMENTO DE CREAR la factura. Un reintento por caída del SRI
    // reusa la fecha ya guardada (utils/invoiceRetry): jamás se regenera.
    const fechaEmision = isPastDocumentDate(sale.createdAt) ? new Date() : (sale.createdAt || new Date());
    const claveAcceso = generarClaveAcceso({
      fechaEmision,
      tipoComprobante: 'factura',
      ruc: config.ruc,
      // El ambiente (pruebas/producción) es el del PUNTO que emite (oct-2026).
      ambiente: serie.ambiente,
      estab: serie.estab,
      puntoEmision: serie.ptoEmi,
      secuencial,
    });

    const { factura, totalSinImpuestos, tb } = armarFactura({
      sale, config, clinic, serie, secuencial, claveAcceso, fechaEmision,
    });

    // Construir Invoice en BD primero, en cola
    invoice = await Invoice.create({
      clinic: req.clinicId,
      sale: sale._id,
      claveAcceso,
      secuencial,
      estab: serie.estab,
      ptoEmi: serie.ptoEmi,
      puntoEmision: serie.punto?._id || null,
      dirEstablecimiento: serie.dirEstablecimiento,
      ambiente: serie.ambiente,
      fechaEmision: fmtFechaEmision(fechaEmision),
      estado: 'EN_COLA',
      tipoIdentificacionComprador: tipoIdentificacion(compradorIdent),
      identificacionComprador: compradorIdent,
      razonSocialComprador: compradorNombre,
      direccionComprador: compradorDir,
      emailComprador: compradorEmail,
      telefonoComprador: compradorTel,
      totalSinImpuestos,
      totalDescuento: totalDescuentoDe(sale),
      totalImpuesto: sale.taxAmount,
      importeTotal: sale.total,
      taxBreakdown: {
        base0: tb.base0,
        baseGravada: tb.baseGravada,
        baseExento: tb.baseExento,
        baseNoObjeto: tb.baseNoObjeto,
        iva: tb.iva,
        rates: tb.rates,
        computed: true,
      },
      // Saldo/pagado según la venta (cubre crédito total y la parte a crédito de un pago dividido).
      balance: Number(sale.balance || 0),
      paid: !!sale.paid,
      createdBy: req.user._id,
    });

    sale.invoice = invoice._id;
    await sale.save();

    // Generar XML, firmar y guardar (queda "emitida localmente" en EN_COLA).
    const xml = buildFacturaXml(factura);
    const xmlFirmado = signXml(xml, p12Buffer, password);
    invoice.xmlFirmado = xmlFirmado;
    await invoice.save();

    // Enviar al SRI y consultar autorización. Si el SRI está caído, processInvoice
    // deja la factura EN_COLA (no la pierde) para que el job la reintente solo.
    await processInvoice(invoice, { authAttempts: 3, authDelayMs: 1500 });

    // Responder según el estado alcanzado.
    if (invoice.estado === 'AUTORIZADO') {
      return res.status(201).json(invoice);
    }
    if (['RECIBIDA', 'EN_PROCESO', 'EN_COLA'].includes(invoice.estado)) {
      const message =
        invoice.estado === 'EN_COLA'
          ? 'El SRI no está disponible en este momento. La factura quedó emitida localmente y en cola; el sistema la enviará automáticamente cuando el SRI responda.'
          : 'Factura enviada al SRI; pendiente de autorización. El sistema consultará la autorización automáticamente.';
      return res.status(202).json({ message, invoice });
    }
    if (['DEVUELTA', 'NO_AUTORIZADO'].includes(invoice.estado)) {
      return res.status(400).json({
        message: invoice.errorUltimo || 'El SRI rechazó el comprobante',
        invoice,
      });
    }
    return res
      .status(500)
      .json({ message: invoice.errorUltimo || 'Error al emitir la factura', invoice });
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
    // Errores de negocio (p. ej. sin punto de emisión asignado): el motivo tal cual.
    if (error.status && error.status < 500) {
      return res.status(error.status).json({ message: error.message, code: error.code });
    }
    res
      .status(500)
      .json({ message: 'Error al emitir factura', error: error.message });
  }
};

exports.list = async (req, res) => {
  try {
    const { startDate, endDate, estado, patient, puntoEmision, page = 1, limit = 20 } = req.query;
    const query = scopedDocuments(req);
    if (estado) query.estado = estado;
    if (puntoEmision) query.puntoEmision = puntoEmision;
    if (startDate && endDate) {
      query.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }
    if (patient) {
      const saleIds = await Sale.find({ ...scopedDocuments(req), patient }).distinct('_id');
      query.sale = { $in: saleIds };
    }
    const invoices = await Invoice.find(query)
      .populate({
        path: 'sale',
        select: 'saleNumber total isFirstVisit patient',
        populate: {
          path: 'patient',
          select: 'firstName lastName cedula phone',
        },
      })
      .populate('puntoEmision', 'establecimiento codigo nombre')
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

/**
 * Descarga masiva: genera los RIDE (PDF) de las facturas que cumplen el filtro
 * y los entrega en un único archivo ZIP. Por defecto solo facturas AUTORIZADO.
 */
exports.bulkPdf = async (req, res) => {
  try {
    const { startDate, endDate, estado, patient, client } = req.query;
    const query = { ...scopedDocuments(req), estado: estado || 'AUTORIZADO' };
    if (startDate && endDate) {
      query.createdAt = { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999') };
    }
    if (client) query.razonSocialComprador = { $regex: client, $options: 'i' };
    if (patient) {
      const saleIds = await Sale.find({ ...scopedDocuments(req), patient }).distinct('_id');
      query.sale = { $in: saleIds };
    }
    // Desde Ventas el cajero descarga solo sus facturas (lo mismo que ve en la lista).
    const delCajero = await require('../utils/soloDelCajero').filtroFacturasDelCajero(req);
    if (delCajero) query.$and = [...(query.$and || []), delCajero];

    const invoices = await Invoice.find(query).populate('sale').sort({ createdAt: -1 }).limit(300);
    if (!invoices.length) return res.status(404).json({ message: 'No hay facturas para descargar con esos filtros' });

    const clinicIds = [...new Set(invoices.map((invoice) => String(invoice.clinic)))];
    const [configs, clinics] = await Promise.all([
      InvoicingConfig.find({ clinic: { $in: clinicIds } }),
      Clinic.find({ _id: { $in: clinicIds } }),
    ]);
    const configByClinic = new Map(configs.map((config) => [String(config.clinic), config]));
    const clinicById = new Map(clinics.map((clinic) => [String(clinic._id), clinic]));
    const { createZip } = require('../utils/zip');

    const files = [];
    for (const inv of invoices) {
      try {
        const pdf = await buildRidePdf({
          invoice: inv,
          sale: inv.sale,
          config: configByClinic.get(String(inv.clinic)),
          clinic: clinicById.get(String(inv.clinic)),
          autorizacion: { fechaAutorizacion: inv.fechaAutorizacion },
        });
        const num = `${inv.estab}-${inv.ptoEmi}-${String(inv.secuencial).padStart(9, '0')}`;
        files.push({ name: `factura-${num}.pdf`, data: pdf });
      } catch (e) {
        // Saltar facturas cuyo PDF no se pueda generar; el resto continúa.
        console.warn('No se pudo generar RIDE de factura', inv._id, e.message);
      }
    }
    if (!files.length) return res.status(404).json({ message: 'No se pudo generar ningún PDF' });

    const zip = createZip(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="facturas-${Date.now()}.zip"`);
    res.send(zip);
  } catch (error) {
    res.status(500).json({ message: 'Error al generar descarga masiva', error: error.message });
  }
};

exports.get = async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, ...scopedDocuments(req) })
      .populate({
        path: 'sale',
        populate: [
          { path: 'items.product', select: 'name code' },
          { path: 'patient', select: 'firstName lastName cedula phone email address' },
        ],
      });
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada' });
    res.json(invoice);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener factura' });
  }
};

exports.getRidePdf = async (req, res) => {
  try {
    /**
     * La factura puede ser de OTRA sucursal que la persona alcanza (oct-2026): el perfil
     * del paciente lista sus facturas de toda la empresa y cada una se tiene que poder
     * abrir. El emisor (configuración y sucursal) es el de la factura, no el activo.
     */
    const { alcanzaSucursal } = require('../utils/clinicScope');
    const invoice = await Invoice.findOne({ _id: req.params.id }).populate('sale');
    if (!invoice || (String(invoice.clinic) !== String(req.clinicId) && !alcanzaSucursal(req, invoice.clinic))) {
      return res.status(404).json({ message: 'Factura no encontrada' });
    }

    const config = await InvoicingConfig.findOne({ clinic: invoice.clinic });
    const clinic = await Clinic.findById(invoice.clinic);

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

/**
 * VOLVER A FIRMAR UNA FACTURA QUE NO LLEGÓ AL SRI (oct-2026).
 *
 * El firmador tuvo dos fallos: primero no firmaba (la factura quedaba en ERROR y SIN XML,
 * y la venta ya no se podía volver a facturar porque tenía esa factura asociada) y después
 * firmaba mal (el SRI la DEVOLVÍA con «FIRMA INVALIDA» y reenviar el mismo XML no sirve).
 * Para esas, el reintento rearma el XML desde la venta con LOS MISMOS datos —clave de
 * acceso, número, serie, fecha y ambiente— y lo firma de nuevo. El SRI no registró la clave
 * (la devolvió en la recepción), así que puede recibirla otra vez.
 */
const ESTADOS_REFIRMABLES = ['EN_COLA', 'ERROR', 'DEVUELTA'];
// Marca del firmador anterior: su referencia al certificado llevaba este Id.
const MARCA_FIRMADOR_ANTERIOR = 'Reference-ID-Cert-';

function necesitaRefirmar(invoice) {
  if (!ESTADOS_REFIRMABLES.includes(invoice.estado)) return false;
  return !invoice.xmlFirmado || invoice.xmlFirmado.includes(MARCA_FIRMADOR_ANTERIOR);
}

async function refirmarFactura(invoice) {
  const sale = await Sale.findOne({ _id: invoice.sale, clinic: invoice.clinic })
    .populate('patient', 'firstName lastName cedula address phone email');
  if (!sale) throw Object.assign(new Error('La venta de esta factura ya no existe: no se puede volver a firmar.'), { status: 400 });
  const { config, p12Buffer, password } = await loadForSigning(invoice.clinic);
  const clinic = await Clinic.findById(invoice.clinic);
  const [dd, mm, yyyy] = String(invoice.fechaEmision || '').split('/').map(Number);
  const fechaEmision = dd && mm && yyyy ? new Date(yyyy, mm - 1, dd, 12) : new Date();
  const { factura } = armarFactura({
    sale,
    config,
    clinic,
    serie: {
      estab: invoice.estab,
      ptoEmi: invoice.ptoEmi,
      dirEstablecimiento: invoice.dirEstablecimiento || config.direccionEstablecimiento || config.direccionMatriz || '',
      ambiente: invoice.ambiente,
    },
    secuencial: invoice.secuencial,
    claveAcceso: invoice.claveAcceso,
    fechaEmision,
  });
  invoice.xmlFirmado = signXml(buildFacturaXml(factura), p12Buffer, password);
  invoice.estado = 'EN_COLA';
  invoice.errorUltimo = null;
  invoice.proximoReintento = null;
  invoice.mensajesSri = [];
  await invoice.save();
  return invoice;
}

/**
 * Reintenta manualmente UNA factura. A diferencia del job, fuerza el reintento
 * ignorando el backoff, y cubre todo el ciclo: reenvía a recepción si quedó
 * EN_COLA/ERROR (SRI caído) y consulta autorización si ya fue recibida.
 */
exports.retry = async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!invoice) return res.status(404).json({ message: 'Factura no encontrada' });
    if (['AUTORIZADO', 'ANULADA'].includes(invoice.estado)) {
      return res
        .status(400)
        .json({ message: `La factura ya está ${invoice.estado.toLowerCase()}` });
    }
    if (necesitaRefirmar(invoice)) await refirmarFactura(invoice);
    await processInvoice(invoice, { force: true, authAttempts: 2, authDelayMs: 1200 });
    const messages = {
      AUTORIZADO: 'Factura autorizada por el SRI',
      RECIBIDA: 'Factura recibida por el SRI; pendiente de autorización',
      EN_PROCESO: 'El SRI aún la está procesando; se consultará de nuevo automáticamente',
      EN_COLA: 'El SRI sigue sin responder; la factura queda en cola para reintento',
      DEVUELTA: invoice.errorUltimo || 'El SRI devolvió el comprobante',
      NO_AUTORIZADO: invoice.errorUltimo || 'El SRI no autorizó el comprobante',
      ERROR: invoice.errorUltimo || 'Error al reintentar',
    };
    res.json({ message: messages[invoice.estado] || 'Reintento procesado', invoice });
  } catch (error) {
    res.status(500).json({ message: 'Error al reintentar', error: error.message });
  }
};

/**
 * Reintenta TODAS las facturas pendientes de la clínica (botón "Reintentar
 * autorización"). Fuerza el reintento ignorando el backoff.
 */
exports.retryPending = async (req, res) => {
  try {
    // Las que quedaron sin XML o con la firma del firmador anterior se vuelven a firmar
    // antes de reenviarlas (si no, el SRI las devolvería otra vez con «FIRMA INVALIDA»).
    const porRefirmar = await Invoice.find({
      clinic: req.clinicId, estado: { $in: ESTADOS_REFIRMABLES },
    }).limit(100);
    for (const inv of porRefirmar) {
      if (!necesitaRefirmar(inv)) continue;
      // eslint-disable-next-line no-await-in-loop
      await refirmarFactura(inv).catch((e) => {
        inv.errorUltimo = `No se pudo volver a firmar: ${e.message}`;
        return inv.save();
      });
    }
    const result = await runInvoiceRetryQueue({
      clinicId: req.clinicId,
      force: true,
      limit: 100,
    });
    res.json({
      message: result.found
        ? `Se procesaron ${result.processed} factura(s) pendiente(s); ${result.autorizadas} autorizada(s).`
        : 'No hay facturas pendientes por reintentar.',
      ...result,
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: 'Error al reintentar pendientes', error: error.message });
  }
};

/**
 * Estado de disponibilidad del SRI + conteo de facturas pendientes de la clínica.
 * Alimenta el banner de la pantalla de facturación.
 */
exports.sriStatus = async (req, res) => {
  try {
    const config = await InvoicingConfig.findOne({ clinic: req.clinicId });
    // El ambiente de quien mira: el de su punto de emisión (o el de la configuración).
    const miPunto = await puntoDelUsuario(req.clinicId, req.user?._id).catch(() => null);
    const ambiente = ambienteDelPunto(miPunto, config);
    const [disponible, pendientes] = await Promise.all([
      checkSriAvailability(ambiente),
      Invoice.countDocuments({
        clinic: req.clinicId,
        estado: { $in: ['EN_COLA', 'RECIBIDA', 'EN_PROCESO', 'ERROR'] },
      }),
    ]);
    res.json({
      disponible,
      ambiente,
      pendientes,
      checkedAt: new Date(),
    });
  } catch (error) {
    res.json({ disponible: false, pendientes: 0, error: error.message, checkedAt: new Date() });
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
    if (!config) return res.status(400).json({ message: 'Configura la facturación antes de anular la factura' });
    const xmlAnulacion = buildAnulacionXml({
      claveAcceso: invoice.claveAcceso,
      ruc: config.ruc,
      razonSocial: config.razonSocial,
      motivo,
      secuencial: invoice.secuencial,
      fecha: invoice.fechaEmision,
    });

    // La anulación local de factura y el reverso operativo de su venta deben
    // confirmarse juntos: si un cobro ya se depositó, se rechazan ambos cambios.
    let saleReversed = false;
    const anularVenta = req.body.anularVenta !== false; // default true
    const { runInTransaction } = require('../utils/accounting');
    await runInTransaction(async (session) => {
      const current = await Invoice.findOne({ _id: invoice._id, clinic: req.clinicId }).session(session);
      if (!current || current.estado === 'ANULADA') throw Object.assign(new Error('Factura ya anulada'), { status: 409 });
      current.estado = 'ANULADA';
      current.anuladaAt = new Date();
      current.anuladaBy = req.user._id;
      current.motivoAnulacion = motivo;
      current.xmlAnulacion = xmlAnulacion;
      await current.save({ session });
      if (anularVenta && current.sale) {
        const { reverseSaleTx } = require('./saleController');
        await reverseSaleTx(session, { clinicId: req.clinicId, saleId: current.sale,
          userId: req.user._id, reversalDate: new Date(), allowInvoiced: true });
        saleReversed = true;
      }
    });
    if (saleReversed) require('../utils/observacionesAutomaticas').registrarVenta(invoice.sale, req.user._id);
    const updatedInvoice = await Invoice.findById(invoice._id);

    res.json({
      message:
        'Factura marcada como anulada localmente. Recuerde que la anulación efectiva debe realizarse en el portal del SRI (https://srienlinea.sri.gob.ec).',
      invoice: updatedInvoice,
      saleReversed,
      saleWarning: null,
    });
  } catch (error) {
    res.status(error.status || 500).json({ message: 'Error al anular factura', error: error.message });
  }
};
