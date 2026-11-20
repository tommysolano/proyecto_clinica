const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const User = require('../models/User');
const ClinicalRecord = require('../models/ClinicalRecord');
const ctrl = require('../controllers/clinicalRecordController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });

test('receta, formulario 002 e historial 005 producen PDF con Chromium real', async () => {
  const clinic = await Clinic.create({ name: 'Clinica de prueba' });
  const doctor = await User.create({ name: 'Doctora Prueba', email: 'pdf-real@example.test',
    password: 'secreto123', clinics: [{ clinic: clinic._id, role: 'doctor' }] });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Paciente', lastName: 'Prueba' });
  const record = await ClinicalRecord.create({ clinic: clinic._id, patient: patient._id, createdBy: doctor._id,
    followUps: [{ descripcion: 'Control de prueba', createdBy: doctor._id }] });
  const params = { patientId: String(patient._id), followUpId: String(record.followUps[0]._id) };
  for (const handler of [ctrl.printFollowUp, ctrl.printMspForm, ctrl.printHcu005]) {
    const state = { statusCode: 200, headers: {} };
    const res = {
      status: (code) => { state.statusCode = code; return res; },
      json: (body) => { state.body = body; return res; },
      setHeader: (key, value) => { state.headers[key] = value; return res; },
      end: (body) => { state.body = body; return res; },
    };
    await handler(H.mockReq(clinic._id, doctor._id, {}, { role: 'doctor', params }), res);
    assert.equal(state.statusCode, 200, JSON.stringify(state.body));
    assert.equal(state.headers['Content-Type'], 'application/pdf');
    assert.ok(Buffer.isBuffer(state.body));
    assert.equal(state.body.subarray(0, 5).toString(), '%PDF-');
  }
});
