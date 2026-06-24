const test = require('node:test');
const assert = require('node:assert/strict');
const { _parseSriReport } = require('../controllers/purchaseInvoiceController');

// Extracto real del reporte "Comprobantes electrónicos recibidos" del SRI (TSV con cabecera).
const SRI_TXT = [
  'RUC_EMISOR\tRAZON_SOCIAL_EMISOR\tTIPO_COMPROBANTE\tSERIE_COMPROBANTE\tCLAVE_ACCESO\tFECHA_AUTORIZACION\tFECHA_EMISION\tIDENTIFICACION_RECEPTOR\tVALOR_SIN_IMPUESTOS\tIVA\tIMPORTE_TOTAL\tNUMERO_DOCUMENTO_MODIFICADO',
  '0990004196001\tCORPORACION EL ROSADO S.A.\tFactura\t002-201-000118601\t0106202601099000419600120022010001186010011860110\t01/06/2026 10:03:32\t01/06/2026\t0993404160001\t14.11\t2.12\t16.23\t',
  '1790283380001\tBANCO DINERS CLUB DEL ECUADOR S.A.\tFactura\t001-014-016216090\t0106202601179028338000120010140162160901621609012\t01/06/2026 15:37:19\t01/06/2026\t0993404160001\t16.24\t2.44\t18.68\t',
  '1790283380001\tBANCO DINERS CLUB DEL ECUADOR S.A.\tFactura\t001-014-016207044\t0106202601179028338000120010140162070441620704410\t01/06/2026 15:41:26\t01/06/2026\t0993404160001\t2.77\t.42\t3.19\t',
  '1768184680001\tACESS\tFactura\t001-006-000273296\t0106202601176818468000120010060002732961234567819\t01/06/2026 11:45:57\t01/06/2026\t0993404160001\t155.16\t0\t155.16\t',
  '0992538902001\tSERVINCREIBLE S.A.\tFactura\t002-001-000010124\t0106202601099253890200120020010000101244104798110\t01/06/2026 08:43:31\t01/06/2026\t0993404160001\t1050\t157.5\t1207.5\t',
].join('\n');

test('parsea cada factura con su propio subtotal, IVA y total (no valores repetidos)', () => {
  const { rows, errors } = _parseSriReport(SRI_TXT);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(rows.length, 5);

  // El bug original ponía el mismo subtotal/iva/total en todas las filas: aquí deben variar.
  assert.deepEqual(rows.map((r) => r.subtotal), [14.11, 16.24, 2.77, 155.16, 1050]);
  assert.deepEqual(rows.map((r) => r.iva), [2.12, 2.44, 0.42, 0, 157.5]);
  assert.deepEqual(rows.map((r) => r.total), [16.23, 18.68, 3.19, 155.16, 1207.5]);
});

test('usa FECHA_EMISION (01/06/2026 = 1 de junio) y no la interpreta como enero', () => {
  const { rows } = _parseSriReport(SRI_TXT);
  const d = rows[0].fechaEmision;
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 5, 'mes debe ser junio (índice 5)');
  assert.equal(d.getDate(), 1);
});

test('descompone la serie y deriva la tarifa de IVA', () => {
  const { rows } = _parseSriReport(SRI_TXT);
  assert.deepEqual(rows[0], {
    line: 2,
    ruc: '0990004196001',
    razonSocial: 'CORPORACION EL ROSADO S.A.',
    docType: 'FACTURA',
    serie: '002-201-000118601',
    estab: '002', ptoEmi: '201', secuencial: '000118601',
    claveAcceso: '0106202601099000419600120022010001186010011860110',
    fechaEmision: rows[0].fechaEmision,
    subtotal: 14.11, iva: 2.12, total: 16.23, ivaRate: 15,
  });
  // Factura exenta (ACESS): IVA 0 → tarifa 0%.
  assert.equal(rows[3].ivaRate, 0);
});

test('tolera archivo sin cabecera usando el orden posicional oficial', () => {
  const noHeader = SRI_TXT.split('\n').slice(1).join('\n');
  const { rows, errors } = _parseSriReport(noHeader);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(rows.length, 5);
  assert.equal(rows[0].subtotal, 14.11);
  assert.equal(rows[4].total, 1207.5);
});

test('maneja decimales con punto inicial (".42")', () => {
  const { rows } = _parseSriReport(SRI_TXT);
  assert.equal(rows[2].iva, 0.42);
});
