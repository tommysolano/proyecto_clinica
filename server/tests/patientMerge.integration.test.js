const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const patients = require('../controllers/patientController');
const clinicalRecords = require('../controllers/clinicalRecordController');
const Patient = require('../models/Patient');
const PatientMerge = require('../models/PatientMerge');
const ClinicalRecord = require('../models/ClinicalRecord');
const PatientObservation = require('../models/PatientObservation');
const AgentTask = require('../models/AgentTask');

const ok = (result) => {
  assert.ok(result.statusCode < 400, JSON.stringify(result.payload));
  return result.payload;
};

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('fusiona perfiles, historias, archivos, observaciones y referencias sin perder datos', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const uploader = new H.mongoose.Types.ObjectId();
  const target = await Patient.create({
    clinic: clinicId,
    cedula: '0102030405',
    firstName: 'ANA',
    lastName: 'PEREZ',
    notes: 'Dato del perfil principal',
    tags: ['VIP'],
  });
  const source = await Patient.create({
    clinic: clinicId,
    cedula: '1790012345001',
    firstName: 'ANA MARIA',
    lastName: 'PEREZ',
    phone: '0991112233',
    notes: 'Dato del perfil duplicado',
    tags: ['CONTROL'],
  });

  await ClinicalRecord.create({
    clinic: clinicId,
    patient: target._id,
    alergias: 'Penicilina',
    followUps: [{ fecha: new Date('2026-01-10'), descripcion: 'Consulta inicial', createdBy: userId }],
  });
  await ClinicalRecord.create({
    clinic: clinicId,
    patient: source._id,
    antecedentesQuirurgicos: 'Apendicectomía',
    followUps: [{
      fecha: new Date('2026-02-10'),
      descripcion: 'Ecografía',
      createdBy: uploader,
      attachments: [{
        filename: 'estudio.pdf',
        originalName: 'Ecografia.pdf',
        uploadedBy: uploader,
        clinic: clinicId,
      }],
    }],
  });
  await PatientObservation.create({
    clinic: clinicId,
    patient: source._id,
    text: 'Trajo resultados anteriores',
    createdBy: userId,
    attachments: [{ filename: 'resultado.pdf', originalName: 'Resultado.pdf', uploadedBy: userId }],
  });
  await AgentTask.create({ clinic: clinicId, patient: source._id, title: 'Llamar para control' });

  const payload = ok(await H.runController(
    patients.mergePatient,
    H.mockReq(
      clinicId,
      userId,
      { sourcePatientId: String(source._id) },
      { role: 'admin', params: { id: String(target._id) } }
    )
  ));
  assert.equal(payload.patientId, String(target._id));

  const merged = await Patient.findById(target._id).lean();
  assert.equal(merged.phone, '0991112233', 'rellena campos vacíos desde el duplicado');
  assert.deepEqual(new Set(merged.tags), new Set(['VIP', 'CONTROL']));
  assert.ok(merged.notes.includes('Dato del perfil principal'));
  assert.ok(merged.notes.includes('Dato del perfil duplicado'));
  assert.deepEqual(merged.identificationAliases, ['1790012345001'], 'conserva el RUC como alias');

  const absorbed = await Patient.findById(source._id).lean();
  assert.equal(absorbed.active, false);
  assert.equal(String(absorbed.mergedInto), String(target._id));
  assert.equal(absorbed.cedula, '', 'libera el identificador del perfil inactivo');

  const record = await ClinicalRecord.findOne({ patient: target._id }).lean();
  assert.equal(record.followUps.length, 2);
  assert.equal(record.alergias, 'Penicilina');
  assert.equal(record.antecedentesQuirurgicos, 'Apendicectomía');
  assert.equal(record.followUps[1].attachments[0].originalName, 'Ecografia.pdf');
  assert.equal(await ClinicalRecord.countDocuments({ patient: source._id }), 0);

  const observation = await PatientObservation.findOne({ text: 'Trajo resultados anteriores' }).lean();
  assert.equal(String(observation.patient), String(target._id));
  assert.equal(observation.attachments[0].originalName, 'Resultado.pdf');
  assert.equal(String((await AgentTask.findOne()).patient), String(target._id));

  const audit = await PatientMerge.findOne({ sourcePatient: source._id }).lean();
  assert.equal(audit.status, 'DONE');
  assert.equal(audit.sourceSnapshot.cedula, '1790012345001');

  const foundByOldId = ok(await H.runController(
    patients.getPatients,
    H.mockReq(clinicId, userId, {}, { role: 'admin', query: { search: '1790012345001' } })
  ));
  assert.equal(foundByOldId.patients.length, 1, 'el RUC absorbido sigue encontrando el perfil principal');
  assert.equal(String(foundByOldId.patients[0]._id), String(target._id));

  const duplicateAgain = await H.runController(
    patients.createPatient,
    H.mockReq(clinicId, userId, { cedula: '1790012345001' }, { role: 'admin' })
  );
  assert.equal(duplicateAgain.statusCode, 400, 'el alias no puede volver a crear otro duplicado');
});

test('un doctor solo elimina el adjunto que él mismo subió', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const otherDoctor = new H.mongoose.Types.ObjectId();
  const patient = await Patient.create({ clinic: clinicId, firstName: 'LUIS' });
  const record = await ClinicalRecord.create({
    clinic: clinicId,
    patient: patient._id,
    followUps: [{
      fecha: new Date(),
      descripcion: 'Estudio',
      createdBy: otherDoctor,
      attachments: [
        { filename: 'mio.pdf', originalName: 'Mio.pdf', uploadedBy: userId, clinic: clinicId },
        { filename: 'ajeno.pdf', originalName: 'Ajeno.pdf', uploadedBy: otherDoctor, clinic: clinicId },
      ],
    }],
  });
  const followUp = record.followUps[0];

  const denied = await H.runController(
    clinicalRecords.deleteFollowUpAttachment,
    H.mockReq(clinicId, userId, {}, {
      role: 'doctor',
      params: {
        patientId: String(patient._id),
        followUpId: String(followUp._id),
        attachmentId: String(followUp.attachments[1]._id),
      },
    })
  );
  assert.equal(denied.statusCode, 403);

  const removed = ok(await H.runController(
    clinicalRecords.deleteFollowUpAttachment,
    H.mockReq(clinicId, userId, {}, {
      role: 'doctor',
      params: {
        patientId: String(patient._id),
        followUpId: String(followUp._id),
        attachmentId: String(followUp.attachments[0]._id),
      },
    })
  ));
  assert.equal(removed.message, 'Archivo eliminado');
  const after = await ClinicalRecord.findById(record._id);
  assert.equal(after.followUps[0].attachments.length, 1);
  assert.equal(after.followUps[0].attachments[0].originalName, 'Ajeno.pdf');
});
