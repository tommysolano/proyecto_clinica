/**
 * EL SUERO QUE RECETÓ EL DOCTOR, CORREGIDO POR MOSTRADOR (oct-2026).
 *
 * Caja escoge en «Asignar atención» el suero que recetó el doctor y le añade o
 * le quita una ampolla. La clínica reportó que a enfermería le llegaba el suero
 * TAL CUAL lo recetó el doctor: la corrección se perdía.
 *
 * La pantalla edita la PRIMERA línea de suero PENDIENTE de ese seguimiento
 * (`pendingSerums(fu)[0]`), pero el servidor reescribía la primera línea de
 * suero A SECAS, y si esa tenía alguna dosis puesta, se negaba entera. Las
 * recetas del doctor suelen ser de varias sesiones («×5») o llevar más de un
 * suero, así que en cuanto se aplicaba la primera sesión ninguna corrección
 * llegaba ya a enfermería.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const User = require('../models/User');
const appt = require('../controllers/appointmentController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

const BERBERIS = { code: 'BERB01', name: 'BERBERIS 2ML AMP', grupo: 'ampolla', quantity: 1 };
const VITC = { code: 'VITC01', name: 'VITAMINA C 5ML AMP', grupo: 'ampolla', quantity: 1 };
const APIMEL = { code: 'APIM01', name: 'APIMEL 2ML AMP', grupo: 'ampolla', quantity: 1 };

const lineaDeSuero = (name, componentes, quantity = 1, administrations = []) => ({
  name, quantity, isSerum: true,
  serumBase: { name: 'Cloruro', volumeMl: 250 },
  serumComponents: componentes,
  administrations,
});

async function seed(recetaItems) {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
  });
  const doctora = await User.create({
    name: 'Doc', email: 'doc@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'doctor' }],
  });
  const enfermera = await User.create({
    name: 'Enf', email: 'enf@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'enfermero' }],
  });
  // La receta del doctor, escrita en su consulta.
  const rec = await ClinicalRecord.create({
    clinic: clinicId, patient: patient._id, createdBy: userId,
    followUps: [{
      fecha: new Date(), descripcion: 'Consulta', createdBy: doctora._id, createdByRole: 'doctor',
      recetaItems,
    }],
  });
  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(), startTime: '10:00', status: 'pendiente',
  });
  return { clinicId, userId, patient, enfermera, cita, followUpId: String(rec.followUps[0]._id) };
}

const asignar = (clinicId, userId, citaId, steps) =>
  H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, { steps }, {
    role: 'cajero', params: { id: String(citaId) },
  }));

const lineas = async (patientId) => {
  const rec = await ClinicalRecord.findOne({ patient: patientId }).lean();
  return (rec?.followUps || []).flatMap((f) => (f.recetaItems || []).filter((i) => i.isSerum));
};
const pendientes = (items) => items.filter((i) => (i.administrations || []).length < (i.quantity || 0));
const nombres = (i) => (i.serumComponents || []).map((c) => c.name).sort();

test('receta del doctor sin aplicar: añadir una ampolla le llega a enfermería', async () => {
  const s = await seed([
    { name: 'Paracetamol', quantity: 10, isSerum: false },
    lineaDeSuero('Suero del doctor', [BERBERIS]),
  ]);
  ok(await asignar(s.clinicId, s.userId, s.cita._id, [{
    kind: 'enfermeria', user: String(s.enfermera._id),
    serumFollowUp: s.followUpId, serumTocado: true,
    serum: { base: { name: 'Cloruro', volumeMl: 250 }, components: [BERBERIS, VITC] },
  }]));

  const items = await lineas(s.patient._id);
  assert.equal(items.length, 1, 'sigue siendo una sola receta de suero');
  assert.deepEqual(nombres(items[0]), [BERBERIS.name, VITC.name]);
  assert.equal(items[0].name, 'Suero del doctor', 'conserva el nombre que le puso el doctor');
});

test('suero de VARIAS sesiones con una ya puesta: la corrección vale para las que faltan', async () => {
  const s = await seed([
    lineaDeSuero('Suero del doctor', [BERBERIS, APIMEL], 5, [{ at: new Date(), byName: 'Enf' }]),
  ]);
  const r = ok(await asignar(s.clinicId, s.userId, s.cita._id, [{
    kind: 'enfermeria', user: String(s.enfermera._id),
    serumFollowUp: s.followUpId, serumTocado: true,
    // Quita APIMEL y añade VITAMINA C.
    serum: { base: { name: 'Cloruro', volumeMl: 250 }, components: [BERBERIS, VITC] },
  }]));
  assert.ok(!(r.autoSerum?.avisos || []).length, `sin avisos de «ya aplicado»: ${JSON.stringify(r.autoSerum?.avisos)}`);

  const items = await lineas(s.patient._id);
  const aplicada = items.find((i) => (i.administrations || []).length);
  assert.deepEqual(nombres(aplicada), [APIMEL.name, BERBERIS.name], 'la sesión puesta queda como se puso');
  assert.equal(aplicada.quantity, 1, 'y queda cerrada: ya no sale como pendiente');

  const pend = pendientes(items);
  assert.equal(pend.length, 1, 'lo que falta es UNA receta pendiente');
  assert.deepEqual(nombres(pend[0]), [BERBERIS.name, VITC.name], 'con la corrección de caja');
  assert.equal(pend[0].quantity, 4, 'por las cuatro sesiones que faltaban');
});

test('el seguimiento con dos sueros: se corrige el PENDIENTE, no el primero ya aplicado', async () => {
  const s = await seed([
    lineaDeSuero('Suero 1', [APIMEL], 1, [{ at: new Date(), byName: 'Enf' }]),
    lineaDeSuero('Suero 2', [BERBERIS]),
  ]);
  ok(await asignar(s.clinicId, s.userId, s.cita._id, [{
    kind: 'enfermeria', user: String(s.enfermera._id),
    serumFollowUp: s.followUpId, serumTocado: true,
    serum: { base: { name: 'Cloruro', volumeMl: 250 }, components: [VITC] },
  }]));

  const items = await lineas(s.patient._id);
  assert.equal(items.length, 2);
  assert.deepEqual(nombres(items.find((i) => i.name === 'Suero 1')), [APIMEL.name], 'el aplicado no se toca');
  assert.deepEqual(nombres(items.find((i) => i.name === 'Suero 2')), [VITC.name], 'el pendiente sí se corrige');
});

test('lo ya aplicado entero sigue sin tocarse, y se avisa', async () => {
  const s = await seed([
    lineaDeSuero('Suero del doctor', [BERBERIS], 1, [{ at: new Date(), byName: 'Enf' }]),
  ]);
  const r = ok(await asignar(s.clinicId, s.userId, s.cita._id, [{
    kind: 'enfermeria', user: String(s.enfermera._id),
    serumFollowUp: s.followUpId, serumTocado: true,
    serum: { base: { name: 'Cloruro', volumeMl: 250 }, components: [VITC] },
  }]));
  const items = await lineas(s.patient._id);
  assert.deepEqual(nombres(items[0]), [BERBERIS.name]);
  assert.ok((r.autoSerum?.avisos || []).some((a) => /ya se le aplicó/.test(a)));
});

test('quitar del paso el suero del doctor NO le borra la receta: queda pendiente para otra visita', async () => {
  const s = await seed([lineaDeSuero('Suero del doctor', [BERBERIS])]);
  // Caja lo escoge para enfermería…
  ok(await asignar(s.clinicId, s.userId, s.cita._id, [{
    kind: 'enfermeria', user: String(s.enfermera._id),
    serumFollowUp: s.followUpId,
    serum: { base: { name: 'Cloruro', volumeMl: 250 }, components: [BERBERIS] },
  }]));
  // …y luego lo quita: hoy no se lo pone.
  ok(await asignar(s.clinicId, s.userId, s.cita._id, [{
    kind: 'enfermeria', user: String(s.enfermera._id), serum: null,
  }]));
  const items = await lineas(s.patient._id);
  assert.equal(items.length, 1, 'la receta del doctor sigue en la ficha');
  assert.deepEqual(nombres(items[0]), [BERBERIS.name]);

  // Y borrar la cita tampoco se la lleva.
  ok(await asignar(s.clinicId, s.userId, s.cita._id, [{
    kind: 'enfermeria', user: String(s.enfermera._id),
    serumFollowUp: s.followUpId,
    serum: { base: { name: 'Cloruro', volumeMl: 250 }, components: [BERBERIS] },
  }]));
  ok(await H.runController(appt.deleteAppointment, H.mockReq(s.clinicId, s.userId, {}, {
    role: 'admin', params: { id: String(s.cita._id) },
  })));
  assert.equal((await lineas(s.patient._id)).length, 1, 'borrar la cita no borra la receta del doctor');
});
