const RetentionVoucher = require('../models/RetentionVoucher');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Supplier = require('../models/Supplier');
const Clinic = require('../models/Clinic');
const { loadForSigning } = require('./invoicingConfigController');
const { generarClaveAcceso } = require('../modules/invoicing/ec/accessKey');
const { buildRetentionXml } = require('../modules/invoicing/ec/xmlBuilder');
const { signXml } = require('../modules/invoicing/ec/xadesSigner');
const { enviarComprobante, autorizarComprobante } = require('../modules/invoicing/ec/sriClient');

function fmtFecha(d) {
  const dt = d ? new Date(d) : new Date();
  return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
}

function periodoFiscal(d) {
  const dt = d ? new Date(d) : new Date();
  return `${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
}

const monthIdx = (d) => d.getFullYear() * 12 + d.getMonth();

/**
 * PERIODO FISCAL de una retención (regla de los 5 días que explicó la contadora): la retención
 * pertenece al periodo de la FACTURA SUSTENTO, no al de su emisión. Por defecto = mes/año del
 * sustento; el usuario puede cambiarlo en el formulario. Validación (TAREA 3d): no anterior al
 * mes del sustento ni posterior al mes de emisión de la retención.
 * @returns {{ month, year, str }} o { error }
 */
function resolveRetentionPeriodo(body, sustentoDate, emissionDate) {
  const s = sustentoDate ? new Date(sustentoDate) : new Date();
  const e = emissionDate ? new Date(emissionDate) : new Date();
  let month = s.getMonth() + 1;
  let year = s.getFullYear();
  if (body && (body.periodMonth || body.periodYear || body.periodoFiscal)) {
    if (body.periodoFiscal && /^\d{1,2}\/\d{4}$/.test(String(body.periodoFiscal))) {
      const [mm, yy] = String(body.periodoFiscal).split('/');
      month = parseInt(mm, 10); year = parseInt(yy, 10);
    } else {
      month = parseInt(body.periodMonth, 10) || month;
      year = parseInt(body.periodYear, 10) || year;
    }
  }
  if (!(month >= 1 && month <= 12) || !(year >= 2000 && year <= 3000)) return { error: 'Periodo fiscal inválido.' };
  const chosen = year * 12 + (month - 1);
  const p = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  if (chosen < monthIdx(s)) return { error: `El periodo fiscal (${String(month).padStart(2, '0')}/${year}) no puede ser anterior al mes de la factura sustento (${p(s)}).` };
  if (chosen > monthIdx(e)) return { error: `El periodo fiscal (${String(month).padStart(2, '0')}/${year}) no puede ser posterior al mes de emisión de la retención (${p(e)}).` };
  return { month, year, str: `${String(month).padStart(2, '0')}/${year}` };
}

function tipoIdentificacionSujeto(supplier) {
  if (supplier.tipoIdentificacion === 'CEDULA') return '05';
  if (supplier.tipoIdentificacion === 'PASAPORTE') return '06';
  return '04'; // RUC
}

// codigo de impuesto SRI en el bloque retencion: 1=Renta, 2=IVA, 6=ISD
function impuestoCodigo(type) {
  if (type === 'IVA') return '2';
  if (type === 'ISD') return '6';
  return '1'; // RENTA
}

function mapMensajes(node) {
  if (!node) return [];
  const arr = Array.isArray(node) ? node : [node];
  return arr.map((m) => ({
    identificador: m.identificador,
    mensaje: m.mensaje,
    informacionAdicional: m.informacionAdicional,
    tipo: m.tipo,
  }));
}

/**
 * Emite el comprobante de retención electrónico (cod 07) a partir de una compra
 * que tiene retenciones registradas. El asiento contable ya se generó al
 * registrar la compra (Retenciones por pagar); aquí se produce el documento
 * fiscal: clave de acceso, XML firmado, envío y autorización del SRI.
 */
exports.emitFromPurchase = async (req, res) => {
  let voucher;
  try {
    const inv = await PurchaseInvoice.findOne({ _id: req.params.purchaseId, clinic: req.clinicId });
    if (!inv) return res.status(404).json({ message: 'Compra no encontrada' });
    if (inv.status === 'ANULADA') return res.status(400).json({ message: 'La compra está anulada' });
    if (!inv.retentions?.length || !(inv.retentionTotal > 0)) {
      return res.status(400).json({ message: 'La compra no tiene retenciones que declarar' });
    }
    const existing = await RetentionVoucher.findOne({ clinic: req.clinicId, purchaseInvoice: inv._id });
    if (existing) return res.status(200).json(existing);

    const supplier = await Supplier.findOne({ _id: inv.supplier, clinic: req.clinicId });
    if (!supplier) return res.status(400).json({ message: 'Proveedor no encontrado' });

    const { config, p12Buffer, password } = await loadForSigning(req.clinicId);
    const clinic = await Clinic.findById(req.clinicId);

    // TAREA 4 — serie multi-sucursal: el usuario elige establecimiento y punto de emisión
    // (por defecto los de la config). El secuencial es AUTOMÁTICO por serie (no se digita).
    const estab = String(req.body?.estab || config.establecimiento || '001');
    const ptoEmi = String(req.body?.ptoEmi || config.puntoEmision || '001');
    const series = config.availableSeries();
    if (!series.some((s) => s.estab === estab && (s.puntosEmision || []).includes(ptoEmi))) {
      return res.status(400).json({ message: `La serie ${estab}-${ptoEmi} no está configurada. Agréguela en Facturación electrónica → Establecimientos y puntos de emisión.` });
    }

    // Periodo fiscal: manda lo que envíe la emisión; si no viene, el que se eligió en el
    // formulario de la COMPRA (pestaña «Retención», como en Contífico) y, en último término,
    // el mes de la factura sustento. Editable y validado en los tres casos.
    const fechaEmision = new Date();
    const periodoBody = (req.body?.periodMonth || req.body?.periodYear || req.body?.periodoFiscal)
      ? req.body
      : { periodMonth: inv.retentionPeriodMonth || undefined, periodYear: inv.retentionPeriodYear || undefined };
    const periodo = resolveRetentionPeriodo(periodoBody, inv.fechaEmision, fechaEmision);
    if (periodo.error) return res.status(400).json({ message: periodo.error });

    const secuencial = await config.constructor.reserveRetentionSeries(req.clinicId, estab, ptoEmi);
    const claveAcceso = generarClaveAcceso({
      fechaEmision,
      tipoComprobante: 'comprobanteRetencion',
      ruc: config.ruc,
      ambiente: config.ambiente,
      estab,
      puntoEmision: ptoEmi,
      secuencial,
    });
    const serie = `${estab}-${ptoEmi}-${String(secuencial).padStart(9, '0')}`;

    // Impuestos del documento soporte (la compra): IVA.
    const impuestosDoc = [];
    // Base de la retención de IVA = TODA la base gravada (incluye la tarifa del 5 %).
    const baseGravadaInv = +(Number(inv.subtotal5 || 0) + Number(inv.subtotal12 || 0) + Number(inv.subtotal15 || 0)).toFixed(2);
    if (inv.iva > 0 || baseGravadaInv > 0) {
      const base = baseGravadaInv || +Number(inv.subtotal || 0).toFixed(2);
      impuestosDoc.push({
        codImpuestoDocSustento: '2',
        codigoPorcentaje: Number(inv.subtotal15) > 0 ? '4' : '2',
        baseImponible: base,
        tarifa: Number(inv.subtotal15) > 0 ? 15 : 12,
        valorImpuesto: +Number(inv.iva || 0).toFixed(2),
      });
    }
    if (Number(inv.subtotal0) > 0) {
      impuestosDoc.push({ codImpuestoDocSustento: '2', codigoPorcentaje: '0', baseImponible: +Number(inv.subtotal0).toFixed(2), tarifa: 0, valorImpuesto: 0 });
    }

    const retenciones = inv.retentions.map((r) => ({
      codigo: impuestoCodigo(r.type),
      codigoRetencion: r.code,
      baseImponible: +Number(r.baseAmount || 0).toFixed(2),
      porcentajeRetener: +Number(r.percentage || 0).toFixed(2),
      valorRetenido: +Number(r.amount || 0).toFixed(2),
    }));

    const voucherXmlInput = {
      infoTributaria: {
        ambiente: config.ambiente,
        tipoEmision: '1',
        razonSocial: config.razonSocial,
        nombreComercial: config.nombreComercial || undefined,
        ruc: config.ruc,
        claveAcceso,
        codDoc: '07',
        estab,
        ptoEmi,
        secuencial: String(secuencial).padStart(9, '0'),
        dirMatriz: config.direccionMatriz,
        agenteRetencion: config.agenteRetencion || undefined,
      },
      infoCompRetencion: {
        fechaEmision: fmtFecha(fechaEmision),
        dirEstablecimiento: config.direccionEstablecimiento || config.direccionMatriz,
        contribuyenteEspecial: config.contribuyenteEspecial || undefined,
        obligadoContabilidad: config.obligadoContabilidad || 'NO',
        tipoIdentificacionSujetoRetenido: tipoIdentificacionSujeto(supplier),
        parteRel: 'NO',
        razonSocialSujetoRetenido: supplier.razonSocial,
        identificacionSujetoRetenido: supplier.ruc,
        periodoFiscal: periodo.str,
      },
      docsSustento: [
        {
          codSustento: inv.codSustento || '01',
          codDocSustento: '01',
          numDocSustento: (inv.serie || '').replace(/-/g, '').slice(-15) || (inv.serie || ''),
          fechaEmisionDocSustento: fmtFecha(inv.fechaEmision),
          numAutDocSustento: inv.autorizacion || inv.claveAcceso || '',
          pagoLocExt: '01',
          totalSinImpuestos: +Number(inv.subtotal || 0).toFixed(2),
          importeTotal: +Number(inv.total || 0).toFixed(2),
          impuestosDocSustento: impuestosDoc,
          retenciones,
        },
      ],
      infoAdicional: [
        supplier.email ? { nombre: 'Email', valor: supplier.email } : null,
        clinic ? { nombre: 'Establecimiento', valor: clinic.name } : null,
      ].filter(Boolean),
    };

    voucher = await RetentionVoucher.create({
      clinic: req.clinicId,
      purchaseInvoice: inv._id,
      supplier: supplier._id,
      supplierName: supplier.razonSocial,
      supplierId: supplier.ruc,
      supplierIdType: tipoIdentificacionSujeto(supplier),
      estab,
      ptoEmi,
      secuencial: String(secuencial).padStart(9, '0'),
      serie,
      claveAcceso,
      ambiente: config.ambiente,
      fechaEmision,
      periodoFiscal: periodo.str,
      purchaseSerie: inv.serie || '',
      purchaseAuthorization: inv.autorizacion || '',
      purchaseIssueDate: inv.fechaEmision || null,
      purchaseTotal: +Number(inv.total || 0).toFixed(2),
      purchaseTaxBase: +Number(inv.subtotal || 0).toFixed(2),
      codSustento: inv.codSustento || '01',
      retentions: inv.retentions.map((r) => ({
        type: r.type === 'IVA' ? 'IVA' : 'RENTA',
        sriTaxCode: impuestoCodigo(r.type),
        code: r.code,
        description: r.description || '',
        baseAmount: +Number(r.baseAmount || 0).toFixed(2),
        percentage: +Number(r.percentage || 0).toFixed(2),
        amount: +Number(r.amount || 0).toFixed(2),
      })),
      totalRetenido: +Number(inv.retentionTotal || 0).toFixed(2),
      estado: 'EN_COLA',
      journalEntry: inv.journalEntry || null,
      createdBy: req.user._id,
    });

    inv.retentionVoucher = voucher._id;
    await inv.save();

    // Firmar y enviar
    const xml = buildRetentionXml(voucherXmlInput);
    voucher.xml = xml;
    const xmlFirmado = signXml(xml, p12Buffer, password);
    voucher.xmlFirmado = xmlFirmado;
    voucher.estado = 'FIRMADO';
    await voucher.save();

    const recepcion = await enviarComprobante(xmlFirmado, config.ambiente);
    voucher.estado = recepcion?.estado === 'RECIBIDA' ? 'RECIBIDA' : 'DEVUELTA';
    voucher.mensajesSri = mapMensajes(recepcion?.comprobantes?.comprobante?.mensajes?.mensaje);
    await voucher.save();

    if (voucher.estado !== 'RECIBIDA') {
      return res.status(400).json({ message: 'El SRI rechazó el comprobante de retención', voucher });
    }

    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const aut = await autorizarComprobante(claveAcceso, config.ambiente);
      const list = aut?.autorizaciones?.autorizacion;
      const item = Array.isArray(list) ? list[0] : list;
      if (item) {
        if (item.estado === 'AUTORIZADO') {
          voucher.estado = 'AUTORIZADO';
          voucher.numeroAutorizacion = item.numeroAutorizacion;
          voucher.fechaAutorizacion = item.fechaAutorizacion;
          voucher.xmlAutorizado = item.comprobante;
          voucher.isPreliminary = false;
          break;
        } else if (item.estado === 'NO AUTORIZADO') {
          voucher.estado = 'NO_AUTORIZADO';
          voucher.mensajesSri = mapMensajes(item.mensajes?.mensaje);
          break;
        }
      }
    }
    await voucher.save();
    res.status(201).json(voucher);
  } catch (error) {
    if (voucher) {
      voucher.estado = 'ERROR';
      voucher.mensajesSri = [...(voucher.mensajesSri || []), { identificador: 'EXCEPTION', mensaje: error.message }];
      try { await voucher.save(); } catch (_) {}
    }
    // Errores de configuración/certificado son de negocio (accionables), no fallos del servidor.
    const msg = String(error.message || '');
    if (/config|certificad|incompleta|firma|p12|contraseñ/i.test(msg)) {
      return res.status(400).json({
        message: `No se pudo emitir la retención: ${msg}. Revise la configuración de facturación electrónica (RUC, establecimiento, punto de emisión y certificado .p12) en Ajustes → Facturación electrónica.`,
      });
    }
    res.status(error.status || 500).json({ message: 'Error al emitir retención', error: msg });
  }
};

/**
 * Contexto para emitir una retención: series disponibles (estab-ptoEmi) y los valores por
 * defecto de la sucursal. El periodo fiscal sugerido lo calcula el front desde la fecha de la
 * factura sustento (regla de los 5 días).
 */
exports.config = async (req, res) => {
  try {
    const InvoicingConfig = require('../models/InvoicingConfig');
    const cfg = await InvoicingConfig.findOne({ clinic: req.clinicId });
    if (!cfg) return res.json({ configured: false, series: [], defaultEstab: '001', defaultPtoEmi: '001' });
    res.json({
      configured: true,
      series: cfg.availableSeries(),
      defaultEstab: cfg.establecimiento || '001',
      defaultPtoEmi: cfg.puntoEmision || '001',
      ambiente: cfg.ambiente,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

exports.list = async (req, res) => {
  try {
    const q = { clinic: req.clinicId };
    if (req.query.estado) q.estado = req.query.estado;
    if (req.query.supplier) q.supplier = req.query.supplier;
    const items = await RetentionVoucher.find(q).sort({ fechaEmision: -1 }).limit(1000);
    res.json(items);
  } catch (e) {
    res.status(500).json({ message: 'Error al listar retenciones', error: e.message });
  }
};

exports.get = async (req, res) => {
  try {
    const v = await RetentionVoucher.findOne({ _id: req.params.id, clinic: req.clinicId })
      .populate('supplier', 'razonSocial ruc')
      .populate('purchaseInvoice', 'serie total fechaEmision');
    if (!v) return res.status(404).json({ message: 'No encontrada' });
    res.json(v);
  } catch (e) {
    res.status(500).json({ message: 'Error al obtener retención', error: e.message });
  }
};

exports.retry = async (req, res) => {
  try {
    const v = await RetentionVoucher.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!v) return res.status(404).json({ message: 'No encontrada' });
    if (!['ERROR', 'DEVUELTA', 'EN_COLA', 'FIRMADO'].includes(v.estado)) {
      return res.status(400).json({ message: `No se puede reintentar en estado ${v.estado}` });
    }
    const { config } = await loadForSigning(req.clinicId);
    const aut = await autorizarComprobante(v.claveAcceso, config.ambiente);
    const list = aut?.autorizaciones?.autorizacion;
    const item = Array.isArray(list) ? list[0] : list;
    if (item?.estado === 'AUTORIZADO') {
      v.estado = 'AUTORIZADO';
      v.numeroAutorizacion = item.numeroAutorizacion;
      v.fechaAutorizacion = item.fechaAutorizacion;
      v.xmlAutorizado = item.comprobante;
      v.isPreliminary = false;
      await v.save();
    }
    res.json(v);
  } catch (e) {
    res.status(500).json({ message: 'Error al reintentar', error: e.message });
  }
};
