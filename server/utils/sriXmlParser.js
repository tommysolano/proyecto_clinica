const { DOMParser } = require('@xmldom/xmldom');

const text = (node, tag) => {
  const el = node.getElementsByTagName(tag)[0];
  return el && el.textContent != null ? el.textContent.trim() : '';
};
const num = (node, tag) => {
  const v = parseFloat(text(node, tag));
  return isNaN(v) ? 0 : v;
};
// Convierte fecha SRI dd/mm/yyyy a Date
const parseFecha = (s) => {
  if (!s) return new Date();
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00`);
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date() : d;
};

/**
 * Extrae el nodo <factura> de un XML, que puede venir:
 *  - directo (<factura>...)
 *  - dentro de <autorizacion><comprobante><![CDATA[<factura>...]]>
 */
function extractFacturaXml(raw) {
  let xml = raw;
  // Si viene autorización con comprobante embebido (CDATA o escapado)
  const doc = new DOMParser().parseFromString(raw, 'text/xml');
  const comp = doc.getElementsByTagName('comprobante')[0];
  if (comp && comp.textContent && comp.textContent.includes('<factura')) {
    xml = comp.textContent;
  }
  return xml;
}

/**
 * Parsea un XML de factura electrónica del SRI (Ecuador) y devuelve un objeto
 * normalizado listo para crear una PurchaseInvoice.
 * Soporta documento <factura> directo o envuelto en <autorizacion>.
 */
function parsePurchaseInvoiceXml(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('XML vacío');
  const xml = extractFacturaXml(raw);
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const factura = doc.getElementsByTagName('factura')[0] || doc.documentElement;
  if (!factura) throw new Error('No es un XML de factura válido');

  const infoTributaria = factura.getElementsByTagName('infoTributaria')[0] || factura;
  const infoFactura = factura.getElementsByTagName('infoFactura')[0] || factura;

  const ruc = text(infoTributaria, 'ruc');
  const razonSocial = text(infoTributaria, 'razonSocial');
  const estab = text(infoTributaria, 'estab');
  const ptoEmi = text(infoTributaria, 'ptoEmi');
  const secuencial = text(infoTributaria, 'secuencial');
  const claveAcceso = text(infoTributaria, 'claveAcceso');
  const serie = estab && ptoEmi && secuencial ? `${estab}-${ptoEmi}-${secuencial}` : claveAcceso;

  // Autorización: en algunos XML es el número de autorización == claveAcceso
  let autorizacion = claveAcceso;
  const numAut = doc.getElementsByTagName('numeroAutorizacion')[0];
  if (numAut && numAut.textContent) autorizacion = numAut.textContent.trim();

  const fechaEmision = parseFecha(text(infoFactura, 'fechaEmision'));

  // Detalles → items
  const items = [];
  const detalles = factura.getElementsByTagName('detalle');
  for (let i = 0; i < detalles.length; i++) {
    const d = detalles[i];
    const cantidad = num(d, 'cantidad') || 1;
    const precioUnitario = num(d, 'precioUnitario');
    const descuento = num(d, 'descuento');
    const baseSin = num(d, 'precioTotalSinImpuesto');
    // Tarifa de IVA del detalle
    let ivaRate = 0;
    const imps = d.getElementsByTagName('impuesto');
    for (let j = 0; j < imps.length; j++) {
      const codigo = text(imps[j], 'codigo');
      if (codigo === '2') { // IVA
        const tarifa = num(imps[j], 'tarifa');
        ivaRate = tarifa;
      }
    }
    items.push({
      description: text(d, 'descripcion') || `Ítem ${i + 1}`,
      quantity: cantidad,
      unitPrice: precioUnitario,
      discount: descuento,
      subtotal: +(baseSin || cantidad * precioUnitario - descuento).toFixed(2),
      ivaRate,
      ivaAmount: +(baseSin * ivaRate / 100).toFixed(2),
    });
  }

  // Totales
  const totalSinImpuestos = num(infoFactura, 'totalSinImpuestos');
  const importeTotal = num(infoFactura, 'importeTotal');
  // IVA total: suma de totalImpuesto con codigo 2
  let iva = 0;
  const totalImpuestos = infoFactura.getElementsByTagName('totalImpuesto');
  for (let i = 0; i < totalImpuestos.length; i++) {
    if (text(totalImpuestos[i], 'codigo') === '2') iva += num(totalImpuestos[i], 'valor');
  }

  return {
    ruc, razonSocial, estab, ptoEmi, secuencial, serie, claveAcceso, autorizacion,
    fechaEmision, items,
    subtotal: +totalSinImpuestos.toFixed(2),
    iva: +iva.toFixed(2),
    total: +importeTotal.toFixed(2),
  };
}

module.exports = { parsePurchaseInvoiceXml };
