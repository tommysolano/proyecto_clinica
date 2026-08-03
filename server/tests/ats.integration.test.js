/**
 * ATS — Anexo Transaccional Simplificado.
 *
 * Lo que se comprueba aquí es lo que hace que el SRI ACEPTE o RECHACE el archivo, que no es
 * la aritmética (esa la cubre el 104) sino la forma:
 *
 *   · los códigos de las tablas del SRI (tipo de identificación, sustento, comprobante),
 *     que son DISTINTOS en compras y en ventas y es el error que más rebota el anexo;
 *   · el ORDEN de los elementos del XML: el XSD lo valida por secuencia, así que un nodo
 *     bien calculado pero fuera de sitio invalida el archivo entero;
 *   · que las ventas se agrupen como el ATS las pide y que los anulados aparezcan;
 *   · que los datos que faltan se avisen ANTES de subirlo al portal.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const reports = require('../controllers/accountingReportsController');
const { tpIdProv, tpIdCliente, codSustento, atsDate, atsFileName } = require('../utils/sriForms/ats');
const ChartOfAccount = require('../models/ChartOfAccount');
const Invoice = require('../models/Invoice');
const Clinic = require('../models/Clinic');
const InvoicingConfig = require('../models/InvoicingConfig');
const purchase = require('../controllers/purchaseInvoiceController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const RUC_EMPRESA = '0992345678001';

/** Período mensual = el mes de hoy (es el que declara el ATS). */
const periodoActual = () => {
  const hoy = new Date();
  return { year: hoy.getFullYear(), month: hoy.getMonth() + 1 };
};

async function setup() {
  const { clinicId, userId } = await H.seedClinic();
  await Clinic.create({ _id: clinicId, name: 'Clínica Test', ruc: RUC_EMPRESA, razonSocial: 'CLINICA TEST S.A.' });
  await InvoicingConfig.create({
    clinic: clinicId, ruc: RUC_EMPRESA, razonSocial: 'CLINICA TEST S.A.',
    establecimiento: '001', puntoEmision: '001', ambiente: '1',
  });
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  return { clinicId, userId, gasto };
}

/** Factura de venta AUTORIZADA (solo esas entran al ATS). */
const makeInvoice = (clinicId, over = {}) => Invoice.create({
  clinic: clinicId,
  claveAcceso: `CA${Math.random().toString().slice(2, 20)}${Date.now()}`,
  estab: '001', ptoEmi: '001', secuencial: '000000001',
  ambiente: '1',
  fechaEmision: atsDate(new Date()),
  estado: 'AUTORIZADO',
  numeroAutorizacion: '1234567890',
  tipoIdentificacionComprador: '05', identificacionComprador: '0912345678',
  razonSocialComprador: 'PACIENTE UNO',
  totalSinImpuestos: 100, totalImpuesto: 15, importeTotal: 115,
  taxBreakdown: { base0: 0, baseGravada: 100, baseExento: 0, baseNoObjeto: 0, iva: 15 },
  formaPago: 'efectivo',
  ...over,
});

// ────────────────────── Códigos de las tablas del SRI ────────────────────────
test('tipo de identificación: compras usa 01/02/03 y ventas 04/05/06/07 (no son la misma tabla)', () => {
  // COMPRAS (tabla 2 — proveedor)
  assert.equal(tpIdProv({ ruc: '0992345678001' }), '01', 'RUC de 13 dígitos');
  assert.equal(tpIdProv({ ruc: '0912345678' }), '02', 'cédula de 10 dígitos');
  assert.equal(tpIdProv({ ruc: 'AB12345' }), '03', 'pasaporte');
  assert.equal(tpIdProv({ ruc: '0912345678', tipoIdentificacion: 'PASAPORTE' }), '03', 'manda lo declarado');

  // VENTAS (cliente) — códigos distintos para el MISMO tipo de documento.
  assert.equal(tpIdCliente('0992345678001'), '04', 'RUC en ventas es 04, no 01');
  assert.equal(tpIdCliente('0912345678'), '05', 'cédula en ventas es 05, no 02');
  assert.equal(tpIdCliente('9999999999999'), '07', 'consumidor final');
  assert.equal(tpIdCliente(''), '07', 'sin identificación ⇒ consumidor final');
  assert.equal(tpIdCliente('X12345'), '06', 'pasaporte');
});

test('código de sustento: crédito tributario (01) cuando hay IVA con crédito; costo/gasto (02) si no', () => {
  assert.equal(codSustento({ subtotal15: 100, vatCreditAmount: 15 }), '01');
  assert.equal(codSustento({ subtotal15: 100, vatCreditAmount: 0 }), '02', 'IVA sin crédito ⇒ costo o gasto');
  assert.equal(codSustento({ subtotal0: 100 }), '02', 'compra 0% ⇒ costo o gasto');
  assert.equal(codSustento({ subtotal5: 100, vatCreditAmount: 5 }), '01', 'la tarifa 5% también da crédito');
});

test('la fecha del ATS va en DD/MM/AAAA', () => {
  assert.equal(atsDate(new Date(2026, 6, 5)), '05/07/2026');
  assert.equal(atsDate(null), '');
});

test('el archivo se llama ATmmaaaa.xml, como pide el SRI', () => {
  assert.equal(atsFileName(2026, 7), 'AT072026.xml');
  assert.equal(atsFileName(2026, 12), 'AT122026.xml');
});

// ────────────────────────── Contenido del anexo ──────────────────────────────
test('el ATS incluye compras, ventas agrupadas, ventas por establecimiento y anulados', async () => {
  const { clinicId, userId, gasto } = await setup();
  const { year, month } = periodoActual();
  const sup = await H.makeSupplier(clinicId, { ruc: '0912345678001', razonSocial: 'PROVEEDOR UNO' });

  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(0), serie: '001-001-000000501',
    autorizacion: '0101202601099234567800110010010000005011234567819',
    items: [{ description: 'Insumos', lineType: 'GASTO', quantity: 1, unitPrice: 200, ivaRate: 15, subtotal: 200, account: gasto._id }],
  }));

  // Dos ventas al MISMO cliente ⇒ una sola fila agrupada con numeroComprobantes = 2.
  await makeInvoice(clinicId, { secuencial: '000000001' });
  await makeInvoice(clinicId, { secuencial: '000000002' });
  // Otra a consumidor final.
  await makeInvoice(clinicId, {
    secuencial: '000000003', identificacionComprador: '9999999999999',
    tipoIdentificacionComprador: '07', razonSocialComprador: 'CONSUMIDOR FINAL',
  });
  // Y una ANULADA.
  await makeInvoice(clinicId, { secuencial: '000000004', estado: 'ANULADA' });

  const r = await H.runController(reports.atsPreview, H.mockReq(clinicId, userId, {}, {
    query: { periodType: 'MONTHLY', year, month },
  }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const d = r.payload;

  assert.equal(d.informante.ruc, RUC_EMPRESA);
  assert.equal(d.informante.codigoOperativo, 'IVA');
  assert.equal(d.informante.mes, String(month).padStart(2, '0'));

  assert.equal(d.compras.length, 1, 'una fila por comprobante de compra');
  assert.equal(d.compras[0].tpIdProv, '01');
  assert.equal(d.compras[0].idProv, '0912345678001');
  assert.equal(d.compras[0].baseImpGrav, 200);
  assert.equal(d.compras[0].montoIva, 30);

  // Ventas agrupadas: 2 filas (el paciente con 2 comprobantes + consumidor final).
  assert.equal(d.ventas.length, 2, 'las ventas se agrupan por cliente');
  const paciente = d.ventas.find((v) => v.idCliente === '0912345678');
  assert.equal(paciente.numeroComprobantes, 2, 'dos facturas del mismo cliente ⇒ una fila con 2');
  assert.equal(paciente.tpIdCliente, '05');
  assert.equal(paciente.baseImpGrav, 200);
  assert.equal(paciente.montoIva, 30);
  const cf = d.ventas.find((v) => v.idCliente === '9999999999999');
  assert.equal(cf.tpIdCliente, '07');

  // La anulada NO suma en ventas, pero SÍ aparece en anulados.
  assert.equal(d.totals.ventasCount, 3, 'la anulada no cuenta como venta');
  assert.equal(d.anulados.length, 1);
  assert.equal(d.anulados[0].secuencialInicio, '000000004');
  assert.equal(d.anulados[0].secuencialInicio, d.anulados[0].secuencialFin, 'un comprobante por fila');

  assert.ok(d.ventasEstablecimiento.length >= 1, 'se declara el total por establecimiento');
  assert.equal(d.ventasEstablecimiento[0].codEstab, '001');
});

// ─────────────────────────── Forma del XML (XSD) ─────────────────────────────
test('el XML respeta el ORDEN del XSD y usa el nombre de archivo oficial', async () => {
  const { clinicId, userId, gasto } = await setup();
  const { year, month } = periodoActual();
  const sup = await H.makeSupplier(clinicId, { ruc: '0912345678001', razonSocial: 'PROVEEDOR UNO' });
  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(0), serie: '001-001-000000601',
    autorizacion: '0101202601099234567800110010010000006011234567819',
    items: [{ description: 'Insumos', lineType: 'GASTO', quantity: 1, unitPrice: 100, ivaRate: 15, subtotal: 100, account: gasto._id }],
  }));
  await makeInvoice(clinicId, { secuencial: '000000010' });

  const r = await H.runController(reports.ats, H.mockReq(clinicId, userId, {}, {
    query: { periodType: 'MONTHLY', year, month },
  }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const xml = String(r.payload);

  assert.match(r.headers['Content-Disposition'], new RegExp(`AT${String(month).padStart(2, '0')}${year}\\.xml`));

  // Cabecera: el XSD exige esta secuencia exacta.
  const cabecera = ['<TipoIDInformante>', '<IdInformante>', '<razonSocial>', '<Anio>', '<Mes>',
    '<numEstabRuc>', '<totalVentas>', '<codigoOperativo>'];
  let prev = -1;
  for (const tag of cabecera) {
    const pos = xml.indexOf(tag);
    assert.ok(pos > prev, `${tag} está fuera de orden en el XML`);
    prev = pos;
  }

  // Bloques principales, en el orden del esquema.
  const bloques = ['<compras>', '<ventas>', '<ventasEstablecimiento>'];
  prev = -1;
  for (const tag of bloques) {
    const pos = xml.indexOf(tag);
    assert.ok(pos > prev, `${tag} está fuera de orden`);
    prev = pos;
  }

  // Secuencia dentro de detalleCompras (la parte que más rechaza el SRI).
  const compra = xml.slice(xml.indexOf('<detalleCompras>'), xml.indexOf('</detalleCompras>'));
  const orden = ['<codSustento>', '<tpIdProv>', '<idProv>', '<tipoComprobante>', '<parteRel>',
    '<fechaRegistro>', '<establecimiento>', '<puntoEmision>', '<secuencial>', '<fechaEmision>',
    '<autorizacion>', '<baseNoGraIva>', '<baseImponible>', '<baseImpGrav>', '<baseImpExe>',
    '<montoIce>', '<montoIva>'];
  prev = -1;
  for (const tag of orden) {
    const pos = compra.indexOf(tag);
    assert.ok(pos > prev, `${tag} está fuera de orden dentro de detalleCompras`);
    prev = pos;
  }

  // Todos los importes con 2 decimales y positivos (lo exige la ficha técnica).
  for (const m of xml.matchAll(/<(baseImpGrav|montoIva|totalVentas|baseImponible)>([^<]*)<\//g)) {
    assert.match(m[2], /^\d+\.\d{2}$/, `${m[1]} debe ir positivo y con 2 decimales, llegó "${m[2]}"`);
  }
});

test('el ATS solo se genera por MES: un rango anual se rechaza con un mensaje claro', async () => {
  const { clinicId, userId } = await setup();
  const r = await H.runController(reports.ats, H.mockReq(clinicId, userId, {}, {
    query: { periodType: 'ANNUAL', year: periodoActual().year },
  }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /MES/i);
});

test('avisa ANTES de generar el XML cuando falta un dato que el SRI exige', async () => {
  const { clinicId, userId, gasto } = await setup();
  const { year, month } = periodoActual();
  // Compra SIN número de autorización: el SRI rechaza el anexo por esto.
  const sup = await H.makeSupplier(clinicId, { ruc: '0912345678001', razonSocial: 'PROVEEDOR SIN AUT' });
  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(0), serie: '001-001-000000701', autorizacion: '',
    items: [{ description: 'Insumos', lineType: 'GASTO', quantity: 1, unitPrice: 50, ivaRate: 15, subtotal: 50, account: gasto._id }],
  }));

  const bloqueado = await H.runController(reports.ats, H.mockReq(clinicId, userId, {}, {
    query: { periodType: 'MONTHLY', year, month },
  }));
  assert.equal(bloqueado.statusCode, 409, JSON.stringify(bloqueado.payload));
  assert.equal(bloqueado.payload.code, 'ATS_INCOMPLETO');
  assert.ok(bloqueado.payload.errores.some((e) => /autorización/i.test(e)), JSON.stringify(bloqueado.payload.errores));

  // Con `force` se genera igual, para poder revisarlo.
  const forzado = await H.runController(reports.ats, H.mockReq(clinicId, userId, {}, {
    query: { periodType: 'MONTHLY', year, month, force: 'true' },
  }));
  assert.equal(forzado.statusCode, 200);
  assert.match(String(forzado.payload), /<iva>/);
});
