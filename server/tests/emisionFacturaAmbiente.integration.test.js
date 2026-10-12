/**
 * EMITIR UNA FACTURA DE VERDAD (firma incluida) con el ambiente del PUNTO (oct-2026).
 *
 * El SRI se simula (recepción + autorización), todo lo demás es real: configuración,
 * certificado .p12 autofirmado, serie del punto, clave de acceso, XML y firma XAdES.
 * Fija que la emisión no se rompe con el ambiente por punto y que usa:
 *   · sin puntos en la sucursal → el ambiente de la configuración;
 *   · con punto → el del punto (aunque la configuración diga otro);
 *   · punto creado antes del cambio, sin ambiente → el de la configuración.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const H = require('./_integrationHelpers');

process.env.INVOICE_ENCRYPTION_KEY = process.env.INVOICE_ENCRYPTION_KEY || 'clave-de-pruebas-muy-larga-123456';

// SRI simulado: recibe y autoriza. Se registra el ambiente con que se llamó.
const llamadas = [];
const rutaSri = require.resolve('../modules/invoicing/ec/sriClient');
const sriReal = require(rutaSri);
require.cache[rutaSri].exports = {
  ...sriReal,
  enviarComprobante: async (_xml, ambiente) => { llamadas.push(['envio', ambiente]); return { estado: 'RECIBIDA' }; },
  autorizarComprobante: async (clave, ambiente) => {
    llamadas.push(['autorizacion', ambiente]);
    return { autorizaciones: { autorizacion: { estado: 'AUTORIZADO', numeroAutorizacion: clave, fechaAutorizacion: new Date().toISOString(), comprobante: '<x/>' } } };
  },
};

const invoices = require('../controllers/invoiceController');
const sales = require('../controllers/saleController');
const InvoicingConfig = require('../models/InvoicingConfig');
const PuntoEmision = require('../models/PuntoEmision');
const User = require('../models/User');
const { encrypt } = require('../modules/invoicing/ec/crypto');

const CERTS_DIR = path.join(__dirname, '..', 'storage', 'certs');
const certificados = [];

function hacerP12(password) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '0103';
  cert.validity.notBefore = new Date(Date.now() - 2 * 86400000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [{ name: 'commonName', value: 'CLINICA PRUEBA' }, { name: 'countryName', value: 'EC' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

test.before(async () => { await H.startDb(); });
test.after(async () => {
  await H.stopDb();
  for (const f of certificados) { try { fs.unlinkSync(f); } catch { /* ya no está */ } }
});
test.beforeEach(async () => { await H.resetDb(); llamadas.length = 0; });

async function preparar(ambienteConfig) {
  const { clinicId, userId } = await H.seedClinic();
  fs.mkdirSync(CERTS_DIR, { recursive: true });
  const nombre = `test-emision-${Date.now()}-${Math.random().toString(36).slice(2)}.p12`;
  const ruta = path.join(CERTS_DIR, nombre);
  fs.writeFileSync(ruta, hacerP12('secreto'));
  certificados.push(ruta);
  await InvoicingConfig.create({
    clinic: clinicId, ruc: '0999999999001', razonSocial: 'Clinica Prueba', direccionMatriz: 'Av. Siempre Viva',
    establecimiento: '001', puntoEmision: '001', ambiente: ambienteConfig,
    certificateFilename: nombre, certificatePassword: encrypt('secreto'),
  });
  const prod = await H.makeProduct(clinicId, { name: 'Consulta', category: 'servicio', salePrice: 20, taxCategory: 'IVA_0', taxRate: 0 });
  const vender = async (uid) => {
    const r = await H.runController(sales.createSale, H.mockReq(clinicId, uid, {
      clientName: 'Consumidor Final', clientCedula: '9999999999999',
      items: [{ product: String(prod._id), quantity: 1, unitPrice: 20 }], paymentMethod: 'efectivo',
    }));
    assert.ok(r.statusCode < 400, JSON.stringify(r.payload));
    return r.payload;
  };
  const emitir = (uid, saleId) => H.runController(invoices.emitFromSale, H.mockReq(clinicId, uid, {}, { params: { saleId: String(saleId) } }));
  return { clinicId, userId, vender, emitir };
}

test('sin puntos: emite con el ambiente de la configuración', async () => {
  const { userId, vender, emitir } = await preparar('2');
  const venta = await vender(userId);
  const r = await emitir(userId, venta._id);
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.estado, 'AUTORIZADO');
  assert.equal(r.payload.ambiente, '2');
  assert.equal(r.payload.claveAcceso.charAt(23), '2', 'el ambiente va en la clave de acceso (posición 24)');
  assert.deepEqual(llamadas, [['envio', '2'], ['autorizacion', '2']]);
});

test('con punto: emite con el ambiente del punto aunque la configuración diga otro', async () => {
  const { clinicId, vender, emitir } = await preparar('2');
  const cajero = await User.create({ name: 'Caja', email: `c${Date.now()}@t.local`, password: 'secreto123', clinics: [{ clinic: clinicId, role: 'cajero' }] });
  await PuntoEmision.create({ clinic: clinicId, establecimiento: '001', codigo: '002', usuario: cajero._id, ambiente: '1' });
  const venta = await vender(cajero._id);
  const r = await emitir(cajero._id, venta._id);
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.ambiente, '1');
  assert.equal(r.payload.ptoEmi, '002');
  assert.deepEqual(llamadas, [['envio', '1'], ['autorizacion', '1']]);
});

test('punto sin ambiente propio (creado antes): emite con el de la configuración', async () => {
  const { clinicId, vender, emitir } = await preparar('2');
  const cajero = await User.create({ name: 'Caja', email: `v${Date.now()}@t.local`, password: 'secreto123', clinics: [{ clinic: clinicId, role: 'cajero' }] });
  await PuntoEmision.create({ clinic: clinicId, establecimiento: '001', codigo: '003', usuario: cajero._id });
  const venta = await vender(cajero._id);
  const r = await emitir(cajero._id, venta._id);
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.ambiente, '2');
});
