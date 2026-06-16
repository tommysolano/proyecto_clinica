/**
 * Construcción del XML de Factura electrónica SRI Ecuador (versión 2.1.0).
 *
 * IMPORTANTE: el XML debe generarse SIN pretty-print porque la canonicalización
 * (C14N) usada en la firma debe operar sobre el documento exacto que se envía.
 */
const { create } = require('xmlbuilder2');

function n2(v) {
  return Number(v || 0).toFixed(2);
}
function n6(v) {
  return Number(v || 0).toFixed(6);
}

/**
 * Construye el XML de una factura.
 *
 * @param {Object} factura
 * @param {Object} factura.infoTributaria
 * @param {Object} factura.infoFactura
 * @param {Array}  factura.detalles
 * @param {Array}  [factura.infoAdicional]   - [{nombre, valor}]
 */
function buildFacturaXml(factura) {
  const { infoTributaria, infoFactura, detalles, infoAdicional = [] } = factura;

  const root = create({ version: '1.0', encoding: 'UTF-8', standalone: false }).ele(
    'factura',
    { id: 'comprobante', version: '2.1.0' }
  );

  // infoTributaria
  const it = root.ele('infoTributaria');
  it.ele('ambiente').txt(infoTributaria.ambiente);
  it.ele('tipoEmision').txt(infoTributaria.tipoEmision || '1');
  it.ele('razonSocial').txt(infoTributaria.razonSocial);
  if (infoTributaria.nombreComercial) {
    it.ele('nombreComercial').txt(infoTributaria.nombreComercial);
  }
  it.ele('ruc').txt(infoTributaria.ruc);
  it.ele('claveAcceso').txt(infoTributaria.claveAcceso);
  it.ele('codDoc').txt(infoTributaria.codDoc || '01');
  it.ele('estab').txt(infoTributaria.estab);
  it.ele('ptoEmi').txt(infoTributaria.ptoEmi);
  it.ele('secuencial').txt(infoTributaria.secuencial);
  it.ele('dirMatriz').txt(infoTributaria.dirMatriz);
  if (infoTributaria.agenteRetencion) {
    it.ele('agenteRetencion').txt(infoTributaria.agenteRetencion);
  }
  if (infoTributaria.contribuyenteRimpe) {
    it.ele('contribuyenteRimpe').txt(infoTributaria.contribuyenteRimpe);
  }

  // infoFactura
  const inf = root.ele('infoFactura');
  inf.ele('fechaEmision').txt(infoFactura.fechaEmision);
  inf.ele('dirEstablecimiento').txt(infoFactura.dirEstablecimiento);
  if (infoFactura.contribuyenteEspecial) {
    inf.ele('contribuyenteEspecial').txt(infoFactura.contribuyenteEspecial);
  }
  inf.ele('obligadoContabilidad').txt(infoFactura.obligadoContabilidad || 'NO');
  inf.ele('tipoIdentificacionComprador').txt(infoFactura.tipoIdentificacionComprador);
  inf.ele('razonSocialComprador').txt(infoFactura.razonSocialComprador);
  inf.ele('identificacionComprador').txt(infoFactura.identificacionComprador);
  if (infoFactura.direccionComprador) {
    inf.ele('direccionComprador').txt(infoFactura.direccionComprador);
  }
  inf.ele('totalSinImpuestos').txt(n2(infoFactura.totalSinImpuestos));
  inf.ele('totalDescuento').txt(n2(infoFactura.totalDescuento || 0));

  const totConImp = inf.ele('totalConImpuestos');
  for (const ti of infoFactura.totalConImpuestos) {
    const e = totConImp.ele('totalImpuesto');
    e.ele('codigo').txt(ti.codigo);
    e.ele('codigoPorcentaje').txt(ti.codigoPorcentaje);
    e.ele('baseImponible').txt(n2(ti.baseImponible));
    e.ele('valor').txt(n2(ti.valor));
  }

  inf.ele('propina').txt(n2(infoFactura.propina || 0));
  inf.ele('importeTotal').txt(n2(infoFactura.importeTotal));
  inf.ele('moneda').txt(infoFactura.moneda || 'DOLAR');

  const pagos = inf.ele('pagos');
  for (const p of infoFactura.pagos) {
    const pago = pagos.ele('pago');
    pago.ele('formaPago').txt(p.formaPago);
    pago.ele('total').txt(n2(p.total));
    if (p.plazo !== undefined) pago.ele('plazo').txt(String(p.plazo));
    if (p.unidadTiempo) pago.ele('unidadTiempo').txt(p.unidadTiempo);
  }

  // detalles
  const det = root.ele('detalles');
  for (const d of detalles) {
    const detalle = det.ele('detalle');
    if (d.codigoPrincipal) detalle.ele('codigoPrincipal').txt(d.codigoPrincipal);
    if (d.codigoAuxiliar) detalle.ele('codigoAuxiliar').txt(d.codigoAuxiliar);
    detalle.ele('descripcion').txt(d.descripcion);
    detalle.ele('cantidad').txt(n6(d.cantidad));
    detalle.ele('precioUnitario').txt(n6(d.precioUnitario));
    detalle.ele('descuento').txt(n2(d.descuento || 0));
    detalle.ele('precioTotalSinImpuesto').txt(n2(d.precioTotalSinImpuesto));

    const imp = detalle.ele('impuestos');
    for (const i of d.impuestos) {
      const x = imp.ele('impuesto');
      x.ele('codigo').txt(i.codigo);
      x.ele('codigoPorcentaje').txt(i.codigoPorcentaje);
      x.ele('tarifa').txt(n2(i.tarifa));
      x.ele('baseImponible').txt(n2(i.baseImponible));
      x.ele('valor').txt(n2(i.valor));
    }
  }

  // infoAdicional
  if (Array.isArray(infoAdicional) && infoAdicional.length > 0) {
    const add = root.ele('infoAdicional');
    for (const a of infoAdicional) {
      if (!a.nombre || a.valor == null) continue;
      add.ele('campoAdicional', { nombre: a.nombre }).txt(String(a.valor));
    }
  }

  return root.end({ prettyPrint: false, headless: false });
}

function buildRetentionXml(voucher) {
  const {
    infoTributaria,
    infoCompRetencion,
    docsSustento = [],
    infoAdicional = [],
  } = voucher;

  const root = create({ version: '1.0', encoding: 'UTF-8', standalone: false }).ele(
    'comprobanteRetencion',
    { id: 'comprobante', version: '2.0.0' }
  );

  const it = root.ele('infoTributaria');
  it.ele('ambiente').txt(infoTributaria.ambiente);
  it.ele('tipoEmision').txt(infoTributaria.tipoEmision || '1');
  it.ele('razonSocial').txt(infoTributaria.razonSocial);
  if (infoTributaria.nombreComercial) it.ele('nombreComercial').txt(infoTributaria.nombreComercial);
  it.ele('ruc').txt(infoTributaria.ruc);
  it.ele('claveAcceso').txt(infoTributaria.claveAcceso);
  it.ele('codDoc').txt(infoTributaria.codDoc || '07');
  it.ele('estab').txt(infoTributaria.estab);
  it.ele('ptoEmi').txt(infoTributaria.ptoEmi);
  it.ele('secuencial').txt(infoTributaria.secuencial);
  it.ele('dirMatriz').txt(infoTributaria.dirMatriz);
  if (infoTributaria.agenteRetencion) it.ele('agenteRetencion').txt(infoTributaria.agenteRetencion);
  if (infoTributaria.contribuyenteRimpe) {
    it.ele('contribuyenteRimpe').txt(infoTributaria.contribuyenteRimpe);
  }

  const ic = root.ele('infoCompRetencion');
  ic.ele('fechaEmision').txt(infoCompRetencion.fechaEmision);
  ic.ele('dirEstablecimiento').txt(infoCompRetencion.dirEstablecimiento);
  if (infoCompRetencion.contribuyenteEspecial) {
    ic.ele('contribuyenteEspecial').txt(infoCompRetencion.contribuyenteEspecial);
  }
  ic.ele('obligadoContabilidad').txt(infoCompRetencion.obligadoContabilidad || 'NO');
  ic.ele('tipoIdentificacionSujetoRetenido').txt(infoCompRetencion.tipoIdentificacionSujetoRetenido);
  ic.ele('parteRel').txt(infoCompRetencion.parteRel || 'NO');
  ic.ele('razonSocialSujetoRetenido').txt(infoCompRetencion.razonSocialSujetoRetenido);
  ic.ele('identificacionSujetoRetenido').txt(infoCompRetencion.identificacionSujetoRetenido);
  ic.ele('periodoFiscal').txt(infoCompRetencion.periodoFiscal);

  const docs = root.ele('docsSustento');
  for (const d of docsSustento) {
    const doc = docs.ele('docSustento');
    doc.ele('codSustento').txt(d.codSustento || '01');
    doc.ele('codDocSustento').txt(d.codDocSustento || '01');
    doc.ele('numDocSustento').txt(d.numDocSustento);
    doc.ele('fechaEmisionDocSustento').txt(d.fechaEmisionDocSustento);
    if (d.fechaRegistroContable) doc.ele('fechaRegistroContable').txt(d.fechaRegistroContable);
    doc.ele('numAutDocSustento').txt(d.numAutDocSustento || d.numDocSustento);
    doc.ele('pagoLocExt').txt(d.pagoLocExt || '01');
    doc.ele('totalSinImpuestos').txt(n2(d.totalSinImpuestos));
    doc.ele('importeTotal').txt(n2(d.importeTotal));

    const impuestos = doc.ele('impuestosDocSustento');
    for (const i of d.impuestosDocSustento || []) {
      const imp = impuestos.ele('impuestoDocSustento');
      imp.ele('codImpuestoDocSustento').txt(i.codImpuestoDocSustento || '2');
      imp.ele('codigoPorcentaje').txt(i.codigoPorcentaje || '0');
      imp.ele('baseImponible').txt(n2(i.baseImponible));
      imp.ele('tarifa').txt(n2(i.tarifa || 0));
      imp.ele('valorImpuesto').txt(n2(i.valorImpuesto || 0));
    }

    const rets = doc.ele('retenciones');
    for (const r of d.retenciones || []) {
      const ret = rets.ele('retencion');
      ret.ele('codigo').txt(r.codigo);
      ret.ele('codigoRetencion').txt(r.codigoRetencion);
      ret.ele('baseImponible').txt(n2(r.baseImponible));
      ret.ele('porcentajeRetener').txt(n2(r.porcentajeRetener));
      ret.ele('valorRetenido').txt(n2(r.valorRetenido));
    }

    if (Array.isArray(d.pagos) && d.pagos.length) {
      const pagos = doc.ele('pagos');
      for (const p of d.pagos) {
        const pago = pagos.ele('pago');
        pago.ele('formaPago').txt(p.formaPago || '01');
        pago.ele('total').txt(n2(p.total));
      }
    }
  }

  if (Array.isArray(infoAdicional) && infoAdicional.length > 0) {
    const add = root.ele('infoAdicional');
    for (const a of infoAdicional) {
      if (!a.nombre || a.valor == null) continue;
      add.ele('campoAdicional', { nombre: a.nombre }).txt(String(a.valor));
    }
  }

  return root.end({ prettyPrint: false, headless: false });
}

module.exports = { buildFacturaXml, buildRetentionXml };
