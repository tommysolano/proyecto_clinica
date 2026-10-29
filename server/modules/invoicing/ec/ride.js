/**
 * RIDE (Representación Impresa del Documento Electrónico) de la factura, en PDF.
 *
 * Rehecho el 29-10-2026 con el formato de micartaonline (rideGenerator.js), que sigue la
 * ficha técnica del SRI: emisor, RUC, número, NÚMERO DE AUTORIZACIÓN, fecha y hora de
 * autorización, ambiente, emisión, CLAVE DE ACCESO con código de barras CODE128,
 * comprador, detalle (con descuento por línea), información adicional, forma de pago y
 * subtotales por tarifa.
 *
 * Los datos salen del XML AUTORIZADO o FIRMADO (lo que recibió el SRI), no de la venta:
 * así el PDF es siempre fiel al comprobante. Solo una factura sin XML todavía (en cola)
 * se arma desde la factura y su venta.
 *
 * Usa Puppeteer para renderizar el HTML.
 */
const puppeteer = require('puppeteer');
const { DOMParser } = require('@xmldom/xmldom');

const FORMAS_PAGO = {
  '01': 'SIN UTILIZACION DEL SISTEMA FINANCIERO',
  '15': 'COMPENSACIÓN DE DEUDAS',
  '16': 'TARJETA DE DÉBITO',
  '17': 'DINERO ELECTRÓNICO',
  '18': 'TARJETA PREPAGO',
  '19': 'TARJETA DE CRÉDITO',
  '20': 'OTROS CON UTILIZACIÓN DEL SISTEMA FINANCIERO',
  '21': 'ENDOSO DE TÍTULOS',
};

// codigoPorcentaje del IVA (tabla 17 de la ficha técnica) → rótulo de la tarifa.
const TARIFAS_IVA = {
  '0': '0%', '2': '12%', '3': '14%', '4': '15%', '5': '5%', '8': 'DIFERENCIADO', '10': '13%',
};

const n2 = (v) => Number(v || 0).toFixed(2);
const escape = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const num = (v) => parseFloat(v) || 0;

function fechaHoraEc(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleString('es-EC', {
    timeZone: 'America/Guayaquil', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).replace(',', '');
}

function texto(parent, tag) {
  if (!parent) return '';
  const nodes = parent.getElementsByTagName(tag);
  return nodes.length && nodes[0].firstChild ? nodes[0].firstChild.nodeValue || '' : '';
}

/** Lee la factura del XML firmado o de la respuesta de autorización (comprobante en CDATA). */
function parseInvoiceXml(xml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  let factura = doc.getElementsByTagName('factura')[0];
  if (!factura) {
    const comprobante = doc.getElementsByTagName('comprobante')[0];
    const interno = comprobante?.firstChild?.nodeValue;
    if (interno) factura = parser.parseFromString(interno.replace(/<!\[CDATA\[|\]\]>/g, ''), 'text/xml').getElementsByTagName('factura')[0];
  }
  if (!factura) throw new Error('No se encontró el elemento factura en el XML');

  const it = factura.getElementsByTagName('infoTributaria')[0];
  const inf = factura.getElementsByTagName('infoFactura')[0];
  const aut = doc.getElementsByTagName('autorizacion')[0];

  const totalImpuestos = [];
  const tci = inf.getElementsByTagName('totalConImpuestos')[0];
  for (const t of Array.from(tci ? tci.getElementsByTagName('totalImpuesto') : [])) {
    totalImpuestos.push({
      codigo: texto(t, 'codigo'), codigoPorcentaje: texto(t, 'codigoPorcentaje'),
      baseImponible: num(texto(t, 'baseImponible')), valor: num(texto(t, 'valor')),
    });
  }
  const pagosNode = inf.getElementsByTagName('pagos')[0];
  const pagos = Array.from(pagosNode ? pagosNode.getElementsByTagName('pago') : []).map((p) => ({
    formaPago: texto(p, 'formaPago'), total: num(texto(p, 'total')),
    plazo: texto(p, 'plazo'), unidadTiempo: texto(p, 'unidadTiempo'),
  }));
  const detallesNode = factura.getElementsByTagName('detalles')[0];
  const productos = Array.from(detallesNode ? detallesNode.getElementsByTagName('detalle') : []).map((d) => ({
    codigoPrincipal: texto(d, 'codigoPrincipal'),
    codigoAuxiliar: texto(d, 'codigoAuxiliar'),
    descripcion: texto(d, 'descripcion'),
    cantidad: num(texto(d, 'cantidad')),
    precioUnitario: num(texto(d, 'precioUnitario')),
    descuento: num(texto(d, 'descuento')),
    precioTotalSinImpuesto: num(texto(d, 'precioTotalSinImpuesto')),
    detallesAdicionales: Array.from(d.getElementsByTagName('detAdicional'))
      .map((x) => `${x.getAttribute('nombre')}: ${x.getAttribute('valor')}`),
  }));
  const infoAdicional = factura.getElementsByTagName('infoAdicional')[0];
  const camposAdicionales = Array.from(infoAdicional ? infoAdicional.getElementsByTagName('campoAdicional') : [])
    .map((c) => ({ nombre: c.getAttribute('nombre'), valor: c.firstChild ? c.firstChild.nodeValue : '' }));

  return {
    numeroAutorizacion: texto(aut, 'numeroAutorizacion') || texto(it, 'claveAcceso'),
    fechaAutorizacion: texto(aut, 'fechaAutorizacion'),
    emisor: {
      ambiente: texto(it, 'ambiente'),
      tipoEmision: texto(it, 'tipoEmision'),
      razonSocial: texto(it, 'razonSocial'),
      nombreComercial: texto(it, 'nombreComercial'),
      ruc: texto(it, 'ruc'),
      claveAcceso: texto(it, 'claveAcceso'),
      estab: texto(it, 'estab'),
      ptoEmi: texto(it, 'ptoEmi'),
      secuencial: texto(it, 'secuencial'),
      dirMatriz: texto(it, 'dirMatriz'),
      agenteRetencion: texto(it, 'agenteRetencion'),
      contribuyenteRimpe: texto(it, 'contribuyenteRimpe'),
    },
    factura: {
      fechaEmision: texto(inf, 'fechaEmision'),
      dirEstablecimiento: texto(inf, 'dirEstablecimiento'),
      contribuyenteEspecial: texto(inf, 'contribuyenteEspecial'),
      obligadoContabilidad: texto(inf, 'obligadoContabilidad') || 'NO',
      razonSocialComprador: texto(inf, 'razonSocialComprador'),
      identificacionComprador: texto(inf, 'identificacionComprador'),
      direccionComprador: texto(inf, 'direccionComprador'),
      guiaRemision: texto(inf, 'guiaRemision'),
      totalSinImpuestos: num(texto(inf, 'totalSinImpuestos')),
      totalDescuento: num(texto(inf, 'totalDescuento')),
      propina: num(texto(inf, 'propina')),
      importeTotal: num(texto(inf, 'importeTotal')),
    },
    totalImpuestos,
    productos,
    pagos,
    camposAdicionales,
  };
}

/**
 * Factura todavía SIN XML (en cola): los mismos datos armados desde la factura y su venta.
 * Las líneas de la venta guardan los valores ya calculados como en el XML.
 */
function dataFromSale({ invoice, sale, config }) {
  const items = sale?.items || [];
  const porTarifa = new Map();
  for (const i of items) {
    const tarifa = Number(i.taxRate || 0);
    const cod = i.taxCodeSri || (tarifa === 15 ? '4' : tarifa === 12 ? '2' : tarifa === 5 ? '5' : '0');
    const cur = porTarifa.get(cod) || { codigo: '2', codigoPorcentaje: cod, baseImponible: 0, valor: 0 };
    cur.baseImponible += Number(i.taxBase || 0);
    cur.valor += Number(i.taxAmount || 0);
    porTarifa.set(cod, cur);
  }
  return {
    numeroAutorizacion: invoice.numeroAutorizacion || invoice.claveAcceso,
    fechaAutorizacion: '',
    emisor: {
      ambiente: invoice.ambiente,
      tipoEmision: '1',
      razonSocial: config?.razonSocial,
      nombreComercial: config?.nombreComercial,
      ruc: config?.ruc,
      claveAcceso: invoice.claveAcceso,
      estab: invoice.estab,
      ptoEmi: invoice.ptoEmi,
      secuencial: invoice.secuencial,
      dirMatriz: config?.direccionMatriz,
      agenteRetencion: config?.agenteRetencion,
    },
    factura: {
      fechaEmision: invoice.fechaEmision,
      dirEstablecimiento: invoice.dirEstablecimiento || config?.direccionEstablecimiento,
      contribuyenteEspecial: config?.contribuyenteEspecial,
      obligadoContabilidad: config?.obligadoContabilidad || 'NO',
      razonSocialComprador: invoice.razonSocialComprador,
      identificacionComprador: invoice.identificacionComprador,
      direccionComprador: invoice.direccionComprador,
      totalSinImpuestos: Number(invoice.totalSinImpuestos || 0),
      totalDescuento: Number(invoice.totalDescuento || 0),
      propina: 0,
      importeTotal: Number(invoice.importeTotal || sale?.total || 0),
    },
    totalImpuestos: [...porTarifa.values()],
    productos: items.map((i) => ({
      codigoPrincipal: i.productCode || String(i.product || ''),
      codigoAuxiliar: '',
      descripcion: i.productName,
      cantidad: Number(i.quantity || 0),
      precioUnitario: Number(i.unitPriceExcludingTax || i.unitPrice || 0),
      descuento: Number(i.discountTaxBase ?? i.discount ?? 0),
      precioTotalSinImpuesto: Number(i.taxBase ?? i.subtotal ?? 0),
      detallesAdicionales: [],
    })),
    pagos: [{ formaPago: '01', total: Number(invoice.importeTotal || sale?.total || 0) }],
    camposAdicionales: invoice.emailComprador ? [{ nombre: 'Email', valor: invoice.emailComprador }] : [],
  };
}

/** Código de barras CODE128 (juego B) en SVG, como el de micartaonline. */
const CODE128 = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100', '10001001100', '10011001000', '10011000100',
  '10001100100', '11001001000', '11001000100', '11000100100', '10110011100', '10011011100', '10011001110', '10111001100',
  '10011101100', '10011100110', '11001110010', '11001011100', '11001001110', '11011100100', '11001110100', '11101101110',
  '11101001100', '11100101100', '11100100110', '11101100100', '11100110100', '11100110010', '11011011000', '11011000110',
  '11000110110', '10100011000', '10001011000', '10001000110', '10110001000', '10001101000', '10001100010', '11010001000',
  '11000101000', '11000100010', '10110111000', '10110001110', '10001101110', '10111011000', '10111000110', '10001110110',
  '11101110110', '11010001110', '11000101110', '11011101000', '11011100010', '11011101110', '11101011000', '11101000110',
  '11100010110', '11101101000', '11101100010', '11100011010', '11101111010', '11001000010', '11110001010', '10100110000',
  '10100001100', '10010110000', '10010000110', '10000101100', '10000100110', '10110010000', '10110000100', '10011010000',
  '10011000010', '10000110100', '10000110010', '11000010010', '11001010000', '11110111010', '11000010100', '10001111010',
  '10100111100', '10010111100', '10010011110', '10111100100', '10011110100', '10011110010', '11110100100', '11110010100',
  '11110010010', '11011011110', '11011110110', '11110110110', '10101111000', '10100011110', '10001011110',
  // 95–102: no son caracteres imprimibles, pero el dígito de control puede caer aquí
  // (micartaonline no los tenía y en esos casos el código salía sin control: ilegible).
  '10111101000', '10111100010', '11110101000', '11110100010', '10111011110', '10111101110', '11101011110', '11110101110',
];
function barcodeSvg(code) {
  const START_B = '11010010000';
  const STOP = '1100011101011';
  let pattern = START_B;
  let checksum = 104;
  [...String(code || '')].forEach((ch, i) => {
    const v = ch.charCodeAt(0) - 32;
    if (v < 0 || v > 94) return;
    pattern += CODE128[v];
    checksum += v * (i + 1);
  });
  pattern += CODE128[checksum % 103] + STOP;
  const bar = 2;
  const height = 150;
  let rects = '';
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === '1') rects += `<rect x="${i * bar}" y="0" width="${bar}" height="${height}" fill="black"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pattern.length * bar} ${height}" preserveAspectRatio="none" style="width:100%;height:15mm;">${rects}</svg>`;
}

function rideHtml(data, logoUrl) {
  const { emisor, factura, productos, pagos, camposAdicionales, totalImpuestos } = data;
  const numero = `${emisor.estab}-${emisor.ptoEmi}-${String(emisor.secuencial || '').padStart(9, '0')}`;

  // Subtotales e IVA por tarifa. 15% (o la tarifa general vigente), 0%, no objeto y exento
  // salen siempre; las demás tarifas (5%, 12%…) solo si la factura las usa.
  const base = (cods) => totalImpuestos.filter((t) => t.codigo === '2' && cods.includes(t.codigoPorcentaje))
    .reduce((s, t) => s + t.baseImponible, 0);
  const iva = (cods) => totalImpuestos.filter((t) => t.codigo === '2' && cods.includes(t.codigoPorcentaje))
    .reduce((s, t) => s + t.valor, 0);
  const otrasTarifas = [...new Set(totalImpuestos
    .filter((t) => t.codigo === '2' && !['0', '4', '6', '7'].includes(t.codigoPorcentaje))
    .map((t) => t.codigoPorcentaje))];
  const ice = totalImpuestos.filter((t) => t.codigo === '3').reduce((s, t) => s + t.valor, 0);
  const irbpnr = totalImpuestos.filter((t) => t.codigo === '5').reduce((s, t) => s + t.valor, 0);
  const fila = (label, valor) => `<tr><td class="total-label">${label}</td><td class="total-value">${n2(valor)}</td></tr>`;

  const productosHtml = productos.map((p) => `
      <tr>
        <td class="text-center">${escape(p.codigoPrincipal)}</td>
        <td class="text-center">${escape(p.codigoAuxiliar)}</td>
        <td class="text-center">${n2(p.cantidad)}</td>
        <td>${escape(p.descripcion)}</td>
        <td class="text-center">${escape(p.detallesAdicionales.join(', '))}</td>
        <td class="text-right">${n2(p.precioUnitario)}</td>
        <td class="text-right">${n2(p.descuento)}</td>
        <td class="text-right">${n2(p.precioTotalSinImpuesto || (p.cantidad * p.precioUnitario - p.descuento))}</td>
      </tr>`).join('');

  const infoAdicionalHtml = camposAdicionales.length
    ? camposAdicionales.map((c) => `<tr><td class="info-label">${escape(c.nombre)}:</td><td class="info-value">${escape(c.valor)}</td></tr>`).join('')
    : '<tr><td class="info-value" colspan="2">&nbsp;</td></tr>';

  const pagosHtml = pagos.map((p) => `
      <tr>
        <td>${escape(p.formaPago)} - ${escape(FORMAS_PAGO[p.formaPago] || 'OTRO')}${Number(p.plazo) > 0 ? ` (${escape(p.plazo)} ${escape(p.unidadTiempo)})` : ''}</td>
        <td class="text-right">${n2(p.total)}</td>
      </tr>`).join('');

  const logoHtml = logoUrl
    ? `<img src="${escape(logoUrl)}" alt="Logo" class="logo" />`
    : `<div class="no-logo">${escape(emisor.nombreComercial || emisor.razonSocial)}</div>`;

  const fechaAut = fechaHoraEc(data.fechaAutorizacion);

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>RIDE - Factura ${escape(numero)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 9pt; line-height: 1.3; color: #000; background: #fff; }
  .header { display: flex; gap: 5mm; margin-bottom: 5mm; align-items: stretch; }
  .header-left { flex: 1; display: flex; flex-direction: column; }
  .logo-container { height: 32mm; display: flex; align-items: center; justify-content: center; }
  .logo { max-width: 100%; max-height: 32mm; object-fit: contain; }
  .no-logo { font-size: 16pt; font-weight: bold; text-align: center; }
  .emisor-box { border: 1px solid #000; border-radius: 8px; padding: 3mm 4mm; margin-top: 3mm; flex: 1; }
  .emisor-name { font-size: 10pt; margin-bottom: 3mm; }
  .emisor-commercial { margin-bottom: 3mm; }
  .emisor-detail { display: table; width: 100%; margin-bottom: 3mm; font-size: 8pt; }
  .emisor-label { display: table-cell; width: 25mm; vertical-align: top; }
  .emisor-value { display: table-cell; }
  .contabilidad-row { display: flex; justify-content: space-between; margin-top: 2mm; font-size: 8pt; gap: 3mm; }
  .header-right { flex: 1; border: 1px solid #000; border-radius: 8px; padding: 3mm; }
  .ruc-line { font-size: 11pt; margin-bottom: 3mm; }
  .ruc-label { margin-right: 8mm; }
  .ruc-value { font-size: 14pt; }
  .doc-type { font-size: 12pt; margin-bottom: 3mm; }
  .doc-number { margin-bottom: 3mm; }
  .doc-number-label { margin-right: 8mm; }
  .auth-title { margin-bottom: 2mm; }
  .auth-number { font-size: 8pt; word-break: break-all; margin-bottom: 3mm; }
  .info-row { display: flex; margin-bottom: 2mm; }
  .info-row-label { min-width: 40mm; }
  .barcode-title { margin: 3mm 0 2mm; }
  .barcode { width: 100%; line-height: 0; }
  .barcode-number { font-size: 7pt; word-break: break-all; text-align: center; margin-top: 1mm; }
  .comprador-box { border: 1px solid #000; padding: 2mm 3mm; margin-bottom: 2mm; }
  .comprador-table { width: 100%; border-collapse: collapse; font-size: 8pt; }
  .comprador-table td { padding: 0.8mm 0; vertical-align: top; }
  .comprador-table .lbl { width: 45mm; }
  .products-table { width: 100%; border-collapse: collapse; margin-bottom: 4mm; font-size: 8pt; }
  .products-table th { border: 1px solid #000; padding: 1.5mm; font-weight: normal; text-align: center; }
  .products-table td { border: 1px solid #000; padding: 1.2mm; }
  .text-center { text-align: center; }
  .text-right { text-align: right; }
  .footer { display: flex; gap: 5mm; align-items: flex-start; }
  .footer-left { flex: 62; }
  .footer-right { flex: 38; }
  .info-adicional-box { border: 1px solid #000; margin-bottom: 2mm; }
  .info-adicional-title { text-align: center; padding: 1mm 2mm; border-bottom: 1px solid #000; font-size: 8pt; }
  .info-adicional-table { width: 100%; font-size: 7.5pt; }
  .info-adicional-table td { padding: 0.8mm 2mm; vertical-align: top; }
  .info-label { width: 35%; }
  .pagos-table { width: 100%; border-collapse: collapse; font-size: 7.5pt; }
  .pagos-table th, .pagos-table td { border: 1px solid #000; padding: 1.2mm 2mm; font-weight: normal; }
  .pagos-table td:last-child { text-align: right; width: 25%; }
  .totals-table { width: 100%; border-collapse: collapse; font-size: 7.5pt; }
  .totals-table td { border: 1px solid #000; padding: 1mm; }
  .totals-table .total-value { text-align: right; width: 22mm; }
  .totals-table .total-final td { font-weight: bold; }
  .estado { margin-top: 3mm; font-size: 7.5pt; color: #444; }
</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="logo-container">${logoHtml}</div>
      <div class="emisor-box">
        <div class="emisor-name">${escape(emisor.razonSocial)}</div>
        ${emisor.nombreComercial ? `<div class="emisor-commercial">${escape(emisor.nombreComercial)}</div>` : ''}
        <div class="emisor-detail"><span class="emisor-label">Dirección<br>Matriz:</span><span class="emisor-value">${escape(emisor.dirMatriz)}</span></div>
        <div class="emisor-detail"><span class="emisor-label">Dirección<br>Sucursal:</span><span class="emisor-value">${escape(factura.dirEstablecimiento || emisor.dirMatriz)}</span></div>
        ${factura.contribuyenteEspecial ? `<div class="contabilidad-row"><span>Contribuyente Especial Nro</span><span>${escape(factura.contribuyenteEspecial)}</span></div>` : ''}
        <div class="contabilidad-row"><span>OBLIGADO A LLEVAR CONTABILIDAD</span><span>${escape(factura.obligadoContabilidad)}</span></div>
        ${emisor.agenteRetencion ? `<div class="contabilidad-row"><span>Agente de Retención Resolución No.</span><span>${escape(emisor.agenteRetencion)}</span></div>` : ''}
        ${emisor.contribuyenteRimpe ? `<div class="contabilidad-row"><span>${escape(emisor.contribuyenteRimpe)}</span></div>` : ''}
      </div>
    </div>
    <div class="header-right">
      <div class="ruc-line"><span class="ruc-label">R.U.C.:</span><span class="ruc-value">${escape(emisor.ruc)}</span></div>
      <div class="doc-type">FACTURA</div>
      <div class="doc-number"><span class="doc-number-label">No.</span>${escape(numero)}</div>
      <div class="auth-title">NÚMERO DE AUTORIZACIÓN</div>
      <div class="auth-number">${escape(data.numeroAutorizacion)}</div>
      <div class="info-row"><span class="info-row-label">FECHA Y HORA DE<br>AUTORIZACIÓN:</span><span>${escape(fechaAut)}</span></div>
      <div class="info-row"><span class="info-row-label">AMBIENTE:</span><span>${emisor.ambiente === '2' ? 'PRODUCCIÓN' : 'PRUEBAS'}</span></div>
      <div class="info-row"><span class="info-row-label">EMISIÓN:</span><span>${emisor.tipoEmision === '2' ? 'CONTINGENCIA' : 'NORMAL'}</span></div>
      <div class="barcode-title">CLAVE DE ACCESO</div>
      <div class="barcode">${barcodeSvg(emisor.claveAcceso)}</div>
      <div class="barcode-number">${escape(emisor.claveAcceso)}</div>
    </div>
  </div>

  <div class="comprador-box">
    <table class="comprador-table">
      <tr><td class="lbl">Razón Social / Nombres y Apellidos:</td><td>${escape(factura.razonSocialComprador)}</td></tr>
      <tr><td class="lbl">Identificación:</td><td>${escape(factura.identificacionComprador)}</td></tr>
      <tr><td class="lbl">Fecha de Emisión:</td><td>${escape(factura.fechaEmision)}${factura.guiaRemision ? ` &nbsp;&nbsp; Guía de Remisión: ${escape(factura.guiaRemision)}` : ''}</td></tr>
      <tr><td class="lbl">Dirección:</td><td>${factura.direccionComprador && factura.direccionComprador !== 'S/N' ? escape(factura.direccionComprador) : ''}</td></tr>
    </table>
  </div>

  <table class="products-table">
    <thead>
      <tr>
        <th>Cod. Principal</th><th>Cod. Auxiliar</th><th>Cantidad</th><th>Descripción</th>
        <th>Detalle Adicional</th><th>Precio Unitario</th><th>Descuento</th><th>Precio Total</th>
      </tr>
    </thead>
    <tbody>${productosHtml}</tbody>
  </table>

  <div class="footer">
    <div class="footer-left">
      <div class="info-adicional-box">
        <div class="info-adicional-title">Información Adicional</div>
        <table class="info-adicional-table">${infoAdicionalHtml}</table>
      </div>
      <table class="pagos-table">
        <thead><tr><th>Forma de pago</th><th>Valor</th></tr></thead>
        <tbody>${pagosHtml}</tbody>
      </table>
    </div>
    <div class="footer-right">
      <table class="totals-table">
        ${fila('SUBTOTAL 15%', base(['4']))}
        ${otrasTarifas.map((c) => fila(`SUBTOTAL ${TARIFAS_IVA[c] || c}`, base([c]))).join('')}
        ${fila('SUBTOTAL 0%', base(['0']))}
        ${fila('SUBTOTAL NO OBJETO DE IVA', base(['6']))}
        ${fila('SUBTOTAL EXENTO DE IVA', base(['7']))}
        ${fila('SUBTOTAL SIN IMPUESTOS', factura.totalSinImpuestos)}
        ${fila('TOTAL DESCUENTO', factura.totalDescuento)}
        ${fila('ICE', ice)}
        ${fila('IVA 15%', iva(['4']))}
        ${otrasTarifas.map((c) => fila(`IVA ${TARIFAS_IVA[c] || c}`, iva([c]))).join('')}
        ${fila('IRBPNR', irbpnr)}
        ${fila('PROPINA', factura.propina)}
        <tr class="total-final"><td class="total-label">VALOR TOTAL</td><td class="total-value">${n2(factura.importeTotal)}</td></tr>
      </table>
    </div>
  </div>
  ${data.estado && data.estado !== 'AUTORIZADO' ? `<div class="estado">Estado en el SRI: ${escape(data.estado)}</div>` : ''}
</body>
</html>`;
}

/**
 * HTML del RIDE. Firma de siempre: { invoice, sale, config, clinic, autorizacion }.
 */
function buildRideHtml({ invoice, sale, config, clinic, autorizacion }) {
  const xml = invoice.xmlAutorizado || invoice.xmlFirmado;
  let data;
  try {
    data = xml ? parseInvoiceXml(xml) : null;
  } catch {
    data = null;
  }
  if (!data) data = dataFromSale({ invoice, sale, config });
  if (!data.fechaAutorizacion) data.fechaAutorizacion = autorizacion?.fechaAutorizacion || invoice.fechaAutorizacion || '';
  if (invoice.numeroAutorizacion) data.numeroAutorizacion = invoice.numeroAutorizacion;
  data.estado = invoice.estado;
  return rideHtml(data, clinic?.logoUrl || null);
}

async function renderPdf(html) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
    });
  } finally {
    await browser.close();
  }
}

async function buildRidePdf(ctx) {
  return renderPdf(buildRideHtml(ctx));
}

module.exports = { buildRidePdf, buildRideHtml, parseInvoiceXml, barcodeSvg, FORMAS_PAGO };
