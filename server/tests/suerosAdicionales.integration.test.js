/**
 * SUEROS ADICIONALES EN UN MISMO PASO DE ENFERMERÍA (oct-2026).
 *
 * Hay pacientes a los que en la misma cita se les aplican dos sueros. Mostrador
 * añade el segundo en el mismo paso de enfermería y cada uno queda como su
 * propia receta en la ficha, que es lo que enfermería aplica.
 *
 * Y de paso, lo que se descubrió al hacerlo: un paso con VARIOS enfermeros
 * escribía el suero una vez por enfermero.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const User = require('../models/User');
const appt = require('../controllers/appointmentController');
const clinical = require('../controllers/clinicalRecordController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

const SUERO_A = { base: { volumeMl: 250 }, components: [{ name: 'APIMEL 2ML AMP', quantity: 1 }] };
const SUERO_B = { base: { volumeMl: 500 }, components: [{ name: 'VITAMINA C', quantity: 2 }] };

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
  });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });
  const crear = (name) => User.create({
    name, email: `${name.toLowerCase()}@t.com`, password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'enfermero' }],
  });
  const enf1 = await crear('Enf1');
  const enf2 = await crear('Enf2');
  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(), startTime: '10:00', status: 'pendiente',
  });
  return { clinicId, userId, patient, enf1, enf2, cita };
}

const asignar = (clinicId, userId, citaId, steps) =>
  H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, { steps }, {
    role: 'cajero', params: { id: String(citaId) },
  }));

const sueros = async (patientId) => {
  const rec = await ClinicalRecord.findOne({ patient: patientId }).lean();
  return (rec?.followUps || []).flatMap((f) => (f.recetaItems || []).filter((i) => i.isSerum));
};

test('dos sueros en el mismo paso: cada uno con su receta en la ficha', async () => {
  const { clinicId, userId, patient, cita } = await seed();
  ok(await asignar(clinicId, userId, cita._id, [{
    kind: 'enfermeria', serviceName: 'Detox', serum: SUERO_A, extraSerums: [{ serum: SUERO_B }],
  }]));

  const items = await sueros(patient._id);
  assert.equal(items.length, 2, 'dos recetas de suero');
  assert.deepEqual(items.map((i) => i.serumBase.volumeMl).sort(), [250, 500]);
  assert.ok(items.some((i) => i.name === 'Suero adicional (Detox)'), 'el segundo lleva nombre propio');

  const guardada = await Appointment.findById(cita._id).lean();
  const turno = guardada.turns[0];
  assert.ok(turno.serumFollowUp, 'el principal queda sellado');
  assert.ok(turno.extraSerums[0].serumFollowUp, 'y el adicional también');
  assert.notEqual(String(turno.serumFollowUp), String(turno.extraSerums[0].serumFollowUp));
  assert.equal(guardada.serumStatus, null, 'con el suero decidido la cita no se retiene');

  // Volver a guardar con las marcas no duplica nada.
  ok(await asignar(clinicId, userId, cita._id, [{
    kind: 'enfermeria', serviceName: 'Detox', serum: SUERO_A, serumFollowUp: String(turno.serumFollowUp),
    extraSerums: [{ serum: SUERO_B, serumFollowUp: String(turno.extraSerums[0].serumFollowUp) }],
  }]));
  assert.equal((await sueros(patient._id)).length, 2, 'siguen siendo dos');
});

test('enfermería ve los dos sueros al abrir la cita', async () => {
  const { clinicId, userId, enf1, cita } = await seed();
  ok(await asignar(clinicId, userId, cita._id, [{
    kind: 'enfermeria', user: String(enf1._id), serum: SUERO_A, extraSerums: [{ serum: SUERO_B }],
  }]));

  const r = ok(await H.runController(clinical.getFollowUpsByAppointment, H.mockReq(clinicId, enf1._id, {}, {
    role: 'enfermero', params: { appointmentId: String(cita._id) },
  })));
  const items = (r.followUps || []).flatMap((f) => (f.recetaItems || []).filter((i) => i.isSerum));
  assert.equal(items.length, 2, 'los dos sueros le aparecen a la enfermera');
});

test('corregir y quitar un suero adicional', async () => {
  const { clinicId, userId, patient, cita } = await seed();
  ok(await asignar(clinicId, userId, cita._id, [{
    kind: 'enfermeria', serum: SUERO_A, extraSerums: [{ serum: SUERO_B }],
  }]));
  const turno = (await Appointment.findById(cita._id).lean()).turns[0];
  const principal = String(turno.serumFollowUp);
  const adicional = String(turno.extraSerums[0].serumFollowUp);

  // Corregido: se reescribe AQUELLA receta, no se abre otra.
  ok(await asignar(clinicId, userId, cita._id, [{
    kind: 'enfermeria', serum: SUERO_A, serumFollowUp: principal,
    extraSerums: [{
      serum: { base: { volumeMl: 1000 }, components: [{ name: 'VITAMINA C', quantity: 3 }] },
      serumFollowUp: adicional, serumTocado: true,
    }],
  }]));
  let items = await sueros(patient._id);
  assert.equal(items.length, 2);
  assert.ok(items.some((i) => i.serumBase.volumeMl === 1000), 'el adicional quedó corregido');

  // Quitado: su receta se va de la ficha y el principal se queda.
  ok(await asignar(clinicId, userId, cita._id, [{
    kind: 'enfermeria', serum: SUERO_A, serumFollowUp: principal, extraSerums: [],
  }]));
  items = await sueros(patient._id);
  assert.equal(items.length, 1, 'solo queda el principal');
  assert.equal(items[0].serumBase.volumeMl, 250);
});

test('un paso con DOS enfermeros escribe cada suero UNA sola vez', async () => {
  const { clinicId, userId, patient, enf1, enf2, cita } = await seed();
  ok(await asignar(clinicId, userId, cita._id, [{
    kind: 'enfermeria', users: [String(enf1._id), String(enf2._id)],
    serum: SUERO_A, extraSerums: [{ serum: SUERO_B }],
  }]));

  assert.equal((await sueros(patient._id)).length, 2, 'una receta por suero, no por enfermero');
  const turnos = (await Appointment.findById(cita._id).lean()).turns;
  assert.equal(turnos.length, 2);
  assert.equal(String(turnos[0].serumFollowUp), String(turnos[1].serumFollowUp), 'los dos apuntan a la misma');
  assert.equal(
    String(turnos[0].extraSerums[0].serumFollowUp),
    String(turnos[1].extraSerums[0].serumFollowUp)
  );
});

test('las indicaciones para enfermería se guardan en el turno', async () => {
  const { clinicId, userId, cita } = await seed();
  ok(await asignar(clinicId, userId, cita._id, [{
    kind: 'enfermeria', nurseInstructions: '  Tomar signos antes de aplicar  ',
  }]));
  const guardada = await Appointment.findById(cita._id).lean();
  assert.equal(guardada.turns[0].nurseInstructions, 'Tomar signos antes de aplicar');
  assert.equal(guardada.serumStatus, null, 'solo indicaciones: sale a la bandeja');
});
