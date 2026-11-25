/**
 * Reportes de impuestos: solo comprobantes del SRI (nov-2026, contador). Los DNA importados de
 * Contífico (series «SO274785») y los anticipos a proveedor no entran.
 */
const test = require('node:test');
const assert = require('node:assert');
const { esComprobanteSri } = require('../utils/comprobantesSri');

test('factura, nota de venta, liquidación y notas con serie del SRI SÍ entran', () => {
  for (const docType of ['FACTURA', 'NOTA_VENTA', 'LIQUIDACION', 'NOTA_CREDITO_REC', 'NOTA_DEBITO_REC']) {
    assert.equal(esComprobanteSri({ docType, serie: '006-006-000000217' }), true, docType);
  }
  // Compra antigua sin `serie` pero con sus tres partes; y sin tipo (= factura).
  assert.equal(esComprobanteSri({ docType: 'FACTURA', estab: '001', ptoEmi: '002', secuencial: '45' }), true);
  assert.equal(esComprobanteSri({ serie: '001-001-000000001' }), true);
});

test('los DNA y los anticipos a proveedor NO entran', () => {
  assert.equal(esComprobanteSri({ docType: 'NOTA_DEBITO_REC', serie: 'SO274785' }), false);
  assert.equal(esComprobanteSri({ docType: 'NOTA_DEBITO_REC', serie: '202602000001' }), false);
  assert.equal(esComprobanteSri({ docType: 'NOTA_DEBITO_REC', serie: '0002410' }), false);
  assert.equal(esComprobanteSri({ docType: 'ANTICIPO_PROVEEDOR', serie: '001-001-000000010' }), false);
  assert.equal(esComprobanteSri({ docType: 'NO_AUTORIZADO', serie: '001-001-000000010' }), false, 'documento no autorizado');
});
