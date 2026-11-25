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

// ───────────── Corregir la autorización desde el ATS (nov-2026) ─────────────
test('el aviso identifica la compra (proveedor, tipo, fecha) y la autorización se corrige sin recontabilizar', async () => {
  const { clinicId, userId, gasto } = await setup();
  const { year, month } = periodoActual();
  const PurchaseInvoice = require('../models/PurchaseInvoice');
  const sup = await H.makeSupplier(clinicId, { ruc: '0912345678001', razonSocial: 'PROVEEDOR SIN AUT' });
  const creada = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(0), serie: '001-001-000000066', autorizacion: '',
    items: [{ description: 'Insumos', lineType: 'GASTO', quantity: 1, unitPrice: 50, ivaRate: 15, subtotal: 50, account: gasto._id }],
  }));
  const compraId = String(creada.payload._id);
  const antes = await PurchaseInvoice.findById(compraId).lean();

  const q = { query: { periodType: 'MONTHLY', year, month } };
  const prev = await H.runController(reports.atsPreview, H.mockReq(clinicId, userId, {}, q));
  const obs = prev.payload.observaciones.find((o) => o.campo === 'autorizacion');
  assert.ok(obs, JSON.stringify(prev.payload.observaciones));
  assert.equal(obs.compraId, compraId, 'el aviso lleva el id de la compra para corregirla');
  // La serie sola se repite entre proveedores: el texto debe decir de quién es.
  assert.match(obs.texto, /PROVEEDOR SIN AUT/);
  assert.match(obs.texto, /Factura 001-001-000000066/);

  // Longitud inválida ⇒ 400 y no se guarda.
  const mala = await H.runController(purchase.updateSriData, H.mockReq(clinicId, userId, { autorizacion: '12345' }, { params: { id: compraId } }));
  assert.equal(mala.statusCode, 400);

  // Aunque tenga retención emitida (la edición completa lo prohíbe), la autorización se corrige.
  await PurchaseInvoice.updateOne({ _id: compraId }, { $set: { retentionNumber: '001-001-000000009' } });
  const clave = '0101202601091234567800110010010000000661234567811';
  const ok = await H.runController(purchase.updateSriData, H.mockReq(clinicId, userId, { autorizacion: clave }, { params: { id: compraId } }));
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.payload));

  const despues = await PurchaseInvoice.findById(compraId).lean();
  assert.equal(despues.autorizacion, clave);
  assert.equal(String(despues.journalEntry), String(antes.journalEntry), 'no se reversa ni se recrea el asiento');
  assert.equal(despues.total, antes.total);

  const post = await H.runController(reports.atsPreview, H.mockReq(clinicId, userId, {}, q));
  assert.ok(!post.payload.observaciones.some((o) => o.compraId === compraId && o.campo === 'autorizacion'), 'el aviso desaparece');
  assert.equal(post.payload.compras.find((c) => c._id === compraId).autorizacion, clave, 'el XML usa la nueva autorización');

  // Una clave de acceso (49) no puede repetirse en otra compra.
  const otra = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(0), serie: '001-001-000000067', autorizacion: '',
    items: [{ description: 'Insumos', lineType: 'GASTO', quantity: 1, unitPrice: 10, ivaRate: 15, subtotal: 10, account: gasto._id }],
  }));
  const dup = await H.runController(purchase.updateSriData, H.mockReq(clinicId, userId, { autorizacion: clave }, { params: { id: String(otra.payload._id) } }));
  assert.equal(dup.statusCode, 409);
});

// ───── Compra de OTRO centro de costo: el ATS la incluye, Compras avisa (nov-2026) ─────
test('una compra de otro centro no sale en el listado del centro, pero se avisa y se abre por id', async () => {
  const { clinicId, userId, gasto } = await setup();
  const PurchaseInvoice = require('../models/PurchaseInvoice');
  const mongoose = require('mongoose');
  const sup = await H.makeSupplier(clinicId, { ruc: '0912345678001', razonSocial: 'LABORATORIO PROV' });
  const creada = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(0), serie: '001-001-000002739',
    autorizacion: '1133293678',
    items: [{ description: 'Reactivos', lineType: 'GASTO', quantity: 1, unitPrice: 79, ivaRate: 0, subtotal: 79, account: gasto._id }],
  }));
  const id = creada.payload._id;
  const ccCentral = new mongoose.Types.ObjectId();
  const ccLab = new mongoose.Types.ObjectId();
  await PurchaseInvoice.updateOne({ _id: id }, { $set: { costCenter: ccLab, 'items.$[].costCenter': ccLab } });

  // Sucursal ligada a CC CENTRAL buscando la serie de una compra de Laboratorio.
  const reqCentral = (extra) => Object.assign(H.mockReq(clinicId, userId, {}, extra), { costCenterScope: ccCentral, userClinicId: clinicId });
  const lista = await H.runController(purchase.list, reqCentral({ query: { q: '001-001-000002739' } }));
  assert.equal(lista.payload.total, 0, 'el listado del centro no la muestra');
  assert.equal(lista.payload.otrosCentros, 1, 'pero avisa que existe en otro centro');

  const porNumero = await H.runController(purchase.list, reqCentral({ query: { numero: '2739' } }));
  assert.equal(porNumero.payload.otrosCentros, 1);

  // Sin búsqueda no se calcula (consulta extra innecesaria).
  const sinBusqueda = await H.runController(purchase.list, reqCentral({ query: {} }));
  assert.equal(sinBusqueda.payload.otrosCentros, 0);

  // El detalle por id se abre igual (lo enlaza el ATS).
  const det = await H.runController(purchase.get, reqCentral({ params: { id: String(id) } }));
  assert.equal(det.statusCode || 200, 200, JSON.stringify(det.payload));
  assert.equal(String(det.payload._id), String(id));
});

// ───── Documento NO AUTORIZADO: se contabiliza pero no entra a ningún reporte del SRI (nov-2026) ─────
test('un documento no autorizado se contabiliza, no lleva autorización ni retención y no sale en ATS/103/104', async () => {
  const { clinicId, userId, gasto } = await setup();
  const { year, month } = periodoActual();
  const PurchaseInvoice = require('../models/PurchaseInvoice');
  const { compute103 } = require('../utils/sriForms/compute103');
  const { compute104 } = require('../utils/sriForms/compute104');
  const sup = await H.makeSupplier(clinicId, { ruc: '0912345678001', razonSocial: 'PROVEEDOR RECIBO' });
  const linea = { description: 'Movilización', lineType: 'GASTO', quantity: 1, unitPrice: 40, ivaRate: 0, subtotal: 40, account: gasto._id };

  // La autorización que llegue se descarta: este documento no la tiene.
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, docType: 'NO_AUTORIZADO', fechaEmision: H.docDate(0), serie: 'REC-0045', autorizacion: '1234567890', items: [linea],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const inv = await PurchaseInvoice.findById(r.payload._id).lean();
  assert.equal(inv.docType, 'NO_AUTORIZADO');
  assert.equal(inv.autorizacion, '');
  assert.ok(inv.journalEntry, 'sí se contabiliza');
  assert.equal(inv.balance, 40, 'queda por pagar');

  // Aunque su número tenga forma de serie del SRI, el tipo lo deja fuera.
  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, docType: 'NO_AUTORIZADO', fechaEmision: H.docDate(0), serie: '001-001-000000999', items: [linea],
  }));

  const q = { query: { periodType: 'MONTHLY', year, month } };
  const prev = await H.runController(reports.atsPreview, H.mockReq(clinicId, userId, {}, q));
  assert.equal(prev.payload.compras.length, 0, 'no entra al ATS');
  assert.equal((prev.payload.observaciones || []).length, 0, 'ni genera avisos de autorización');

  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  const f103 = await compute103({ clinicId, range: { start, end, year, month } });
  assert.equal(f103.totals.comprasBase, 0, 'no entra al 103');
  const f104 = await compute104({ clinicId, range: { start, end, year, month } });
  assert.equal(f104.totals.comprasBase, 0, 'no entra al 104');

  // Retención: no se admite.
  const conRet = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, docType: 'NO_AUTORIZADO', fechaEmision: H.docDate(0), serie: 'REC-0046',
    items: [{ ...linea, retentions: [{ code: '332', type: 'RENTA' }] }],
  }));
  assert.equal(conRet.statusCode, 400, JSON.stringify(conRet.payload));
  assert.match(conRet.payload.message, /no admite retenciones/);
});

test('una compra importada se puede reclasificar como documento no autorizado sin recontabilizarla', async () => {
  const { clinicId, userId, gasto } = await setup();
  const PurchaseInvoice = require('../models/PurchaseInvoice');
  const sup = await H.makeSupplier(clinicId, { ruc: '0912345678001', razonSocial: 'PROVEEDOR DNA' });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, docType: 'NOTA_DEBITO_REC', fechaEmision: H.docDate(0), serie: 'SO274785',
    items: [{ description: 'Gasto', lineType: 'GASTO', quantity: 1, unitPrice: 20, ivaRate: 0, subtotal: 20, account: gasto._id }],
  }));
  const id = String(r.payload._id);
  await PurchaseInvoice.updateOne({ _id: id }, { $set: { sourceModel: 'ContificoRecord', journalEntry: null, status: 'PAGADA', balance: 0, paid: true } });
  const d = (await PurchaseInvoice.findById(id)).toObject();
  const body = { ...JSON.parse(JSON.stringify(d)), docType: 'NO_AUTORIZADO', fechaEmision: new Date(String(d.fechaEmision.toISOString()).slice(0, 10)).toISOString() };
  const ed = await H.runController(purchase.update, H.mockReq(clinicId, userId, body, { params: { id } }));
  assert.equal(ed.statusCode || 200, 200, JSON.stringify(ed.payload));
  const inv = await PurchaseInvoice.findById(id).lean();
  assert.equal(inv.docType, 'NO_AUTORIZADO');
  assert.equal(inv.journalEntry, null, 'sin asiento nuevo');
  assert.equal(inv.status, 'PAGADA');
});
