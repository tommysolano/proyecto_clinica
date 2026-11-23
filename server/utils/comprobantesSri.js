/**
 * COMPROBANTES DE COMPRA VÁLIDOS PARA LOS REPORTES DE IMPUESTOS (nov-2026, contador).
 *
 * En los reportes tributarios (Compras/Ventas SRI, 104, 103, ATS) solo entran los documentos
 * autorizados por el SRI: factura, nota de venta, liquidación de compra, notas de crédito y
 * débito (y los que se agreguen con el mismo formato). Fuera quedan:
 *   - los DNA (documentos no autorizados) importados de Contífico, guardados como
 *     NOTA_DEBITO_REC con series internas tipo «SO274785» o «2026…»;
 *   - los anticipos a proveedor (no son un comprobante).
 * La marca de un comprobante del SRI es su serie: establecimiento-punto-secuencial
 * («001-001-000000123»).
 *
 *   PurchaseInvoice.find({ ...otrosFiltros, ...FILTRO_COMPROBANTE_SRI })
 *   compras.filter(esComprobanteSri)
 */
const TIPOS_SRI = ['FACTURA', 'NOTA_VENTA', 'LIQUIDACION', 'NOTA_DEBITO_REC', 'NOTA_CREDITO_REC'];
const SERIE_SRI = /^\d{3}-\d{3}-\d{9}$/;

/** Serie del documento: la guardada o la que forman estab-ptoEmi-secuencial. */
function serieDe(p) {
  if (p?.serie) return String(p.serie).trim();
  if (p?.estab && p?.ptoEmi && p?.secuencial) {
    return `${p.estab}-${p.ptoEmi}-${String(p.secuencial).padStart(9, '0')}`;
  }
  return '';
}

/** Filtro de Mongo (las compras antiguas sin `serie` pero con sus tres partes también valen). */
const FILTRO_COMPROBANTE_SRI = {
  docType: { $in: [...TIPOS_SRI, null] }, // sin tipo = factura (compras antiguas)
  $or: [
    { serie: SERIE_SRI },
    { serie: { $in: [null, ''] }, estab: /^\d{3}$/, ptoEmi: /^\d{3}$/, secuencial: /^\d{1,9}$/ },
  ],
};

function esComprobanteSri(p) {
  return TIPOS_SRI.includes(p?.docType || 'FACTURA') && SERIE_SRI.test(serieDe(p));
}

module.exports = { TIPOS_SRI, SERIE_SRI, FILTRO_COMPROBANTE_SRI, esComprobanteSri };
