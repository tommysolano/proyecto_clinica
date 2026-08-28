/**
 * FIRMA ELECTRÓNICA DEL PROFESIONAL (.p12) Y RECETAS FIRMADAS.
 *
 * La firma dejó de ser una IMAGEN escaneada (que no firma nada, solo se parece a
 * una firma) y pasó a ser un certificado. Lo que vigilan estos tests:
 *
 *  1. Que un .p12 con contraseña equivocada, corrupto o vencido se rechace AL
 *     SUBIRLO y no el día que haya que firmar una receta.
 *  2. Que la contraseña se guarde CIFRADA y no vuelva nunca al cliente.
 *  3. Que la receta salga firmada de verdad (PKCS#7 dentro del PDF) y con el
 *     certificado del médico que ATENDIÓ, no del que pulsa imprimir.
 *  4. Que sin certificado la receta se siga emitiendo — sin firma, pero se
 *     emite: dejar al paciente sin receta sería peor.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const H = require('./_integrationHelpers');

process.env.INVOICE_ENCRYPTION_KEY = process.env.INVOICE_ENCRYPTION_KEY || 'clave-de-pruebas-muy-larga-123456';

const ClinicalRecord = require('../models/ClinicalRecord');
const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const User = require('../models/User');
const userCtrl = require('../controllers/userController');
const recordCtrl = require('../controllers/clinicalRecordController');
const { decrypt } = require('../modules/invoicing/ec/crypto');
const { USER_CERTS_DIR, rutaCertificado } = require('../utils/pdfSignature');

// El PDF de verdad lo genera puppeteer; aquí se sustituye por un PDF mínimo
// pero VÁLIDO, porque la firma sí se ejecuta de verdad sobre él.
const pdfMinimo = () => {
  const PDFDocument = require('pdfkit');
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.fontSize(12).text('Receta', 50, 50);
    doc.end();
  });
};
let htmlCapturado = '';
const rutaPuppeteer = require.resolve('puppeteer');
require.cache[rutaPuppeteer] = {
  id: rutaPuppeteer, filename: rutaPuppeteer, loaded: true,
  exports: {
    launch: async () => ({
      newPage: async () => ({
        setContent: async (html) => { htmlCapturado = html; },
        pdf: async () => pdfMinimo(),
      }),
      close: async () => {},
    }),
  },
};

/** Un .p12 autofirmado de juguete, como el que subiría un médico. */
function hacerP12({ password, cn = 'JUAN PEREZ MEDICO', dias = 365 }) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '0102';
  cert.validity.notBefore = new Date(Date.now() - 2 * 86400000);
  cert.validity.notAfter = new Date(Date.now() + dias * 86400000);
  const attrs = [
    { name: 'commonName', value: cn },
    { name: 'countryName', value: 'EC' },
    { name: 'organizationName', value: 'SECURITY DATA' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([{ name: 'basicConstraints', cA: false }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

test.before(async () => { await H.startDb(); });
test.after(async () => {
  await H.stopDb();
  // Los .p12 de prueba no se quedan en el repo.
  try { fs.rmSync(USER_CERTS_DIR, { recursive: true, force: true }); } catch { /* da igual */ }
});
test.beforeEach(async () => { await H.resetDb(); htmlCapturado = ''; });

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  await Clinic.create({ _id: clinicId, name: 'Shiluv', nombreComercial: 'Shiluv Norte' });
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
  });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });
  const doctor = await User.create({
    name: 'Dra. Salas', email: 'doc@t.com', password: 'x123456', specialty: 'Medicina general',
    clinics: [{ clinic: clinicId, role: 'doctor' }],
  });
  const cajero = await User.create({
    name: 'Recepción', email: 'caja@t.com', password: 'x123456',
    clinics: [{ clinic: clinicId, role: 'cajero' }],
  });
  return { clinicId, patient, doctor, cajero };
}

/** Sube un .p12 como si viniera del formulario (multer ya procesó el archivo). */
const subirCert = (quien, buffer, password) => {
  const req = H.mockReq(null, quien._id, { password }, { role: 'doctor' });
  req.user = quien;
  req.file = { buffer, originalname: 'firma.p12', mimetype: 'application/x-pkcs12' };
  return H.runController(userCtrl.uploadMySignatureCert, req);
};

const imprimirReceta = async (clinicId, quien, role, patient, followUpId) => {
  const state = { statusCode: 200, payload: undefined, headers: {} };
  const res = {
    status: (c) => { state.statusCode = c; return res; },
    json: (p) => { state.payload = p; return res; },
    setHeader: (n, v) => { state.headers[n] = v; return res; },
    end: (b) => { state.payload = b; return res; },
  };
  await recordCtrl.printFollowUp(
    H.mockReq(clinicId, quien._id, {}, {
      role, params: { patientId: String(patient._id), followUpId },
    }),
    res,
  );
  return state;
};

const crearSeguimiento = async (clinicId, doctor, patient) => {
  await H.runController(
    recordCtrl.addFollowUp,
    H.mockReq(clinicId, doctor._id, {
      descripcion: 'Control',
      recetaItems: [{ name: 'Paracetamol 500 mg', quantity: 10, dose: '1 tableta' }],
    }, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );
  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  return String(rec.followUps[0]._id);
};

// ───────────────────── subir el certificado ─────────────────────

test('un .p12 válido se acepta y guarda la contraseña CIFRADA', async () => {
  const { doctor } = await seed();
  const p12 = hacerP12({ password: 'clave123' });

  const r = await subirCert(doctor, p12, 'clave123');
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  assert.equal(r.payload.tiene, true);
  assert.equal(r.payload.puedeFirmar, true);
  assert.equal(r.payload.info.commonName, 'JUAN PEREZ MEDICO');
  assert.equal(r.payload.password, undefined, 'la contraseña NUNCA vuelve al cliente');

  const guardado = await User.findById(doctor._id).lean();
  assert.ok(guardado.signatureCert.password, 'se guardó algo');
  assert.notEqual(guardado.signatureCert.password, 'clave123', 'pero no en claro');
  assert.equal(decrypt(guardado.signatureCert.password), 'clave123', 'y descifra bien');
  assert.ok(fs.existsSync(rutaCertificado(doctor._id)), 'el archivo está en disco');
  assert.equal(guardado.signatureImage, undefined, 'ya no existe la firma escaneada');
});

test('una contraseña equivocada se rechaza al subir, no al firmar', async () => {
  const { doctor } = await seed();
  const p12 = hacerP12({ password: 'la-buena' });

  const r = await subirCert(doctor, p12, 'la-mala');
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /contraseña/i);

  const guardado = await User.findById(doctor._id).lean();
  assert.ok(!guardado.signatureCert?.filename, 'no se guardó nada');
});

test('un archivo que no es un certificado se rechaza', async () => {
  const { doctor } = await seed();
  const r = await subirCert(doctor, Buffer.from('esto no es un p12'), 'x');
  assert.equal(r.statusCode, 400);
});

test('un certificado vencido se rechaza', async () => {
  const { doctor } = await seed();
  const p12 = hacerP12({ password: 'clave123', dias: -1 });
  const r = await subirCert(doctor, p12, 'clave123');
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /vencido/i);
});

test('se puede quitar la firma y el archivo desaparece del disco', async () => {
  const { doctor } = await seed();
  await subirCert(doctor, hacerP12({ password: 'clave123' }), 'clave123');
  assert.ok(fs.existsSync(rutaCertificado(doctor._id)));

  const req = H.mockReq(null, doctor._id, {}, { role: 'doctor' });
  req.user = doctor;
  const r = await H.runController(userCtrl.deleteMySignatureCert, req);
  assert.equal(r.statusCode < 400, true);
  assert.equal(fs.existsSync(rutaCertificado(doctor._id)), false);

  const guardado = await User.findById(doctor._id).lean();
  assert.ok(!guardado.signatureCert?.filename);
});

// ───────────────────── la receta firmada ─────────────────────

test('la receta sale FIRMADA con el certificado del médico', async () => {
  const { clinicId, patient, doctor } = await seed();
  await subirCert(doctor, hacerP12({ password: 'clave123' }), 'clave123');
  const followUpId = await crearSeguimiento(clinicId, doctor, patient);

  const r = await imprimirReceta(clinicId, doctor, 'doctor', patient, followUpId);
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  assert.equal(r.headers['X-Firma-Electronica'], 'si');

  const pdf = r.payload.toString('latin1');
  assert.ok(pdf.startsWith('%PDF'), 'sigue siendo un PDF');
  assert.match(pdf, /\/ByteRange/, 'lleva el rango firmado');
  assert.match(pdf, /adbe\.pkcs7\.detached/, 'con firma PKCS#7 desprendida');
  assert.match(pdf, /\/Type\s*\/Sig/);

  // Y el recuadro visible, que es lo único que se ve en papel.
  assert.match(htmlCapturado, /FIRMADO ELECTRÓNICAMENTE POR/);
  assert.match(htmlCapturado, /JUAN PEREZ MEDICO/);
});

test('firma el médico que ATENDIÓ, aunque el PDF lo imprima recepción', async () => {
  const { clinicId, patient, doctor, cajero } = await seed();
  await subirCert(doctor, hacerP12({ password: 'clave123', cn: 'DRA SALAS' }), 'clave123');
  const followUpId = await crearSeguimiento(clinicId, doctor, patient);

  // Imprime el cajero, que no tiene certificado ninguno.
  const r = await imprimirReceta(clinicId, cajero, 'cajero', patient, followUpId);
  assert.equal(r.headers['X-Firma-Electronica'], 'si', 'se firma igual');
  assert.match(htmlCapturado, /DRA SALAS/, 'y con el nombre del que atendió');
  assert.match(r.payload.toString('latin1'), /adbe\.pkcs7\.detached/);
});

test('sin certificado la receta se emite igual, pero sin firma ni promesas', async () => {
  const { clinicId, patient, doctor } = await seed();
  const followUpId = await crearSeguimiento(clinicId, doctor, patient);

  const r = await imprimirReceta(clinicId, doctor, 'doctor', patient, followUpId);
  assert.equal(r.statusCode < 400, true, 'el paciente se lleva su receta');
  assert.equal(r.headers['X-Firma-Electronica'], 'no');
  assert.ok(r.payload.toString('latin1').startsWith('%PDF'));

  // Aparece el nombre, pero NO se dice que esté firmado.
  assert.match(htmlCapturado, /Dra\. Salas/);
  assert.doesNotMatch(htmlCapturado, /FIRMADO ELECTRÓNICAMENTE POR/);
});

test('un certificado que caducó después de subirlo deja de firmar', async () => {
  const { clinicId, patient, doctor } = await seed();
  await subirCert(doctor, hacerP12({ password: 'clave123' }), 'clave123');
  // Se vence sin tocar el archivo: es lo que pasa con el paso del tiempo.
  await User.findByIdAndUpdate(doctor._id, {
    $set: { 'signatureCert.info.validTo': new Date(Date.now() - 86400000) },
  });
  const followUpId = await crearSeguimiento(clinicId, doctor, patient);

  const r = await imprimirReceta(clinicId, doctor, 'doctor', patient, followUpId);
  assert.equal(r.statusCode < 400, true, 'la receta se sigue emitiendo');
  assert.equal(r.headers['X-Firma-Electronica'], 'no', 'pero sin firmar');
  assert.doesNotMatch(htmlCapturado, /FIRMADO ELECTRÓNICAMENTE POR/,
    'y sin decir que lo está: firmar con uno vencido es peor que no firmar');
});

test('el certificado se guarda por usuario, no se pisan entre médicos', async () => {
  const { doctor, cajero } = await seed();
  await subirCert(doctor, hacerP12({ password: 'a1', cn: 'MEDICO UNO' }), 'a1');
  await subirCert(cajero, hacerP12({ password: 'b2', cn: 'MEDICO DOS' }), 'b2');

  const d = await User.findById(doctor._id).lean();
  const c = await User.findById(cajero._id).lean();
  assert.equal(d.signatureCert.info.commonName, 'MEDICO UNO');
  assert.equal(c.signatureCert.info.commonName, 'MEDICO DOS');
  assert.notEqual(d.signatureCert.filename, c.signatureCert.filename);
  assert.ok(fs.existsSync(path.join(USER_CERTS_DIR, d.signatureCert.filename)));
  assert.ok(fs.existsSync(path.join(USER_CERTS_DIR, c.signatureCert.filename)));
});
