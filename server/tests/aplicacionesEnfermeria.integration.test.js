/**
 * QUÉ APLICÓ ENFERMERÍA, EN SU PROPIO PARTE.
 *
 * ─── EL PROBLEMA ───────────────────────────────────────────────────────────────
 * La aplicación de un suero se guarda DENTRO de la línea de la receta del doctor
 * que lo mandó (`followUps[N].recetaItems[K].administrations[]`). El parte del
 * turno de enfermería es OTRO seguimiento, casi siempre de otro día, y decía
 * literalmente «Aplicación de enfermería: Medicina General · Observaciones:
 * Servicio aplicado por enfermería». Ni el suero, ni el volumen, ni las
 * ampollas, ni lo que el paciente rechazó.
 *
 * Ahora el servidor copia esa información al parte (`followUps[].aplicaciones`)
 * al cerrar el turno. Es una FOTO: si mañana se corrige la receta, lo que se
 * puso sigue diciendo lo que se puso.
 *
 * Lo que vigilan estos tests:
 *  1. El parte lleva el detalle real de lo aplicado, no la frase genérica.
 *  2. Lo que NO se puso queda escrito, con su motivo.
 *  3. La ventana es POR TURNO: con dos turnos de la misma enfermera, el segundo
 *     parte no repite lo del primero.
 *  4. Sin nada aplicado, el parte sigue saliendo como siempre (no rompe nada).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const User = require('../models/User');
const ClinicalRecord = require('../models/ClinicalRecord');
const appt = require('../controllers/appointmentController');
const ctrl = require('../controllers/clinicalRecordController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
  });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });
  const crear = (name, role) =>
    User.create({
      name, email: `${name.toLowerCase()}@t.com`, password: 'secreto123',
      clinics: [{ clinic: clinicId, role }],
    });
  const doctor = await crear('DraSalas', 'doctor');
  const enfermera = await crear('Karla', 'enfermero');
  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(), startTime: '10:00', status: 'pendiente',
  });
  return { clinicId, userId, patient, doctor, enfermera, cita };
}

const params = (id) => ({ params: { id: String(id) } });
const comoEnfermero = (clinicId, userId, id, body = {}) =>
  H.mockReq(clinicId, userId, body, { role: 'enfermero', ...params(id) });

/** El doctor receta un suero con su composición. Devuelve ids de la línea. */
async function recetarSuero(clinicId, doctor, patient, cantidad = 3) {
  const r = await H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, doctor._id, {
      descripcion: 'Deshidratación',
      recetaItems: [{
        name: 'Sueroterapia',
        quantity: cantidad,
        isSerum: true,
        serumBase: { name: 'Cloruro', volumeMl: 500 },
        serumComponents: [
          { name: 'Vitamina C', grupo: 'ampolla', quantity: 2 },
          { name: 'Complejo B', grupo: 'ampolla', quantity: 1 },
        ],
      }],
    }, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const fu = rec.followUps[rec.followUps.length - 1];
  return { followUpId: String(fu._id), itemId: String(fu.recetaItems.find((i) => i.isSerum)._id) };
}

const administrar = (clinicId, quien, patient, followUpId, itemId, body = {}) =>
  H.runController(
    ctrl.administerSerum,
    H.mockReq(clinicId, quien._id, body, {
      role: 'enfermero',
      params: { patientId: String(patient._id), followUpId, itemId },
    }),
  );

const partes = async (patientId) => {
  const rec = await ClinicalRecord.findOne({ patient: patientId }).lean();
  return rec.followUps.filter((f) => f.kind === 'enfermeria');
};

// ─────────────────────────────────────────────────────────────

test('el parte de enfermería dice QUÉ se aplicó, no «servicio aplicado»', async () => {
  const { clinicId, userId, patient, doctor, enfermera, cita } = await seed();
  const { followUpId, itemId } = await recetarSuero(clinicId, doctor, patient, 3);

  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'enfermeria', user: String(enfermera._id), serviceName: 'Sueroterapia' }],
  }, params(cita._id)));
  await H.runController(appt.nurseClaim, comoEnfermero(clinicId, enfermera._id, cita._id));

  await administrar(clinicId, enfermera, patient, followUpId, itemId);

  const fin = await H.runController(appt.nurseComplete, comoEnfermero(clinicId, enfermera._id, cita._id));
  assert.equal(fin.statusCode < 400, true, JSON.stringify(fin.payload));

  const [parte] = await partes(patient._id);
  assert.ok(parte, 'tiene que quedar el parte de enfermería');
  assert.equal(parte.aplicaciones.length, 1, 'con la aplicación copiada dentro');

  const a = parte.aplicaciones[0];
  assert.equal(a.itemName, 'Sueroterapia');
  assert.equal(a.baseVolumeMl, 500, 'el volumen de cloruro que entró');
  assert.equal(a.byName, 'Karla', 'y quién lo puso, con el nombre guardado');
  assert.deepEqual(
    a.components.map((c) => [c.name, c.quantityApplied]),
    [['Vitamina C', 2], ['Complejo B', 1]],
  );

  assert.notEqual(
    parte.observaciones, 'Servicio aplicado por enfermería.',
    'la frase genérica es justo lo que no decía nada',
  );
  assert.match(parte.observaciones, /Cloruro 500 ml/);
  assert.match(parte.observaciones, /Vitamina C ×2/);
});

test('lo que el paciente RECHAZA queda escrito, con su motivo', async () => {
  const { clinicId, userId, patient, doctor, enfermera, cita } = await seed();
  const { followUpId, itemId } = await recetarSuero(clinicId, doctor, patient, 2);

  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'enfermeria', user: String(enfermera._id), serviceName: 'Sueroterapia' }],
  }, params(cita._id)));
  await H.runController(appt.nurseClaim, comoEnfermero(clinicId, enfermera._id, cita._id));

  await administrar(clinicId, enfermera, patient, followUpId, itemId, {
    baseVolumeMl: 250,
    components: [
      { name: 'Vitamina C', quantityPrescribed: 2, quantityApplied: 2 },
      { name: 'Complejo B', quantityPrescribed: 1, quantityApplied: 0, omitReason: 'El paciente la rechazó' },
    ],
  });
  await H.runController(appt.nurseComplete, comoEnfermero(clinicId, enfermera._id, cita._id));

  const [parte] = await partes(patient._id);
  const a = parte.aplicaciones[0];
  assert.equal(a.baseVolumeMl, 250, 'se pone lo que entró, no lo que estaba escrito');
  const rechazada = a.components.find((c) => c.name === 'Complejo B');
  assert.equal(rechazada.quantityApplied, 0);
  assert.equal(rechazada.omitReason, 'El paciente la rechazó');
});

test('dos turnos de la MISMA enfermera: el segundo parte no repite el primero', async () => {
  const { clinicId, userId, patient, doctor, enfermera, cita } = await seed();
  const { followUpId, itemId } = await recetarSuero(clinicId, doctor, patient, 4);

  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [
      { kind: 'enfermeria', user: String(enfermera._id), serviceName: 'Detox' },
      { kind: 'enfermeria', user: String(enfermera._id), serviceName: 'Sueroterapia' },
    ],
  }, params(cita._id)));

  // Turno 1: una dosis.
  await H.runController(appt.nurseClaim, comoEnfermero(clinicId, enfermera._id, cita._id));
  await administrar(clinicId, enfermera, patient, followUpId, itemId);
  await H.runController(appt.nurseComplete, comoEnfermero(clinicId, enfermera._id, cita._id));

  // Turno 2: otra dosis.
  await H.runController(appt.nurseClaim, comoEnfermero(clinicId, enfermera._id, cita._id));
  await administrar(clinicId, enfermera, patient, followUpId, itemId);
  await H.runController(appt.nurseComplete, comoEnfermero(clinicId, enfermera._id, cita._id));

  const lista = await partes(patient._id);
  assert.equal(lista.length, 2, 'un parte por turno');
  assert.equal(lista[0].aplicaciones.length, 1);
  assert.equal(
    lista[1].aplicaciones.length, 1,
    'el segundo parte cuenta desde que empezó SU turno: repetir la dosis anterior sería contarla dos veces',
  );
});

test('sin cita: dos partes el MISMO día no repiten las dosis del primero', async () => {
  /**
   * El paciente prepagado que viene a diario a su serie: entra por la mañana y
   * vuelve por la tarde. El corte entre un parte y el siguiente sale de
   * `createdAt` (la hora real de guardado) y no de `fecha` —que la elige quien
   * escribe y para los dos partes de hoy es la misma medianoche—. Con `fecha`,
   * el parte de la tarde repetía la dosis de la mañana.
   */
  const { clinicId, patient, doctor, enfermera } = await seed();
  const { followUpId, itemId } = await recetarSuero(clinicId, doctor, patient, 4);

  const escribirParte = () =>
    H.runController(
      ctrl.addFollowUp,
      H.mockReq(clinicId, enfermera._id, { descripcion: 'Sueroterapia' }, {
        role: 'enfermero', params: { patientId: String(patient._id) },
      }),
    );

  // Mañana: una dosis y su parte.
  await administrar(clinicId, enfermera, patient, followUpId, itemId);
  const r1 = await escribirParte();
  assert.equal(r1.statusCode < 400, true, JSON.stringify(r1.payload));

  // Tarde: otra dosis y otro parte.
  await administrar(clinicId, enfermera, patient, followUpId, itemId);
  const r2 = await escribirParte();
  assert.equal(r2.statusCode < 400, true, JSON.stringify(r2.payload));

  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const suyos = rec.followUps.filter(
    (f) => String(f.createdBy) === String(enfermera._id)
  );
  assert.equal(suyos.length, 2);
  assert.equal(suyos[0].aplicaciones.length, 1);
  assert.equal(
    suyos[1].aplicaciones.length, 1,
    'el segundo parte solo cuenta lo aplicado DESPUÉS del primero',
  );
});

test('quien YA cerró su turno no puede cerrar el del siguiente al guardar', async () => {
  /**
   * `completarTurno` tiene un respaldo: si quien guarda no tiene turno propio
   * pendiente, cierra el vigente (pensado para el doctor de una cita vieja o
   * reasignada). Desde que enfermería escribe seguimientos ese respaldo era una
   * trampa: la enfermera cierra su parte, vuelve atrás a anotar lo que aplicó y,
   * al guardar, se llevaba por delante el turno del doctor que la seguía — la
   * cita quedaba «completada» con el paciente sin atender y desaparecía de la
   * agenda del médico.
   */
  const { clinicId, userId, patient, doctor, enfermera, cita } = await seed();

  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [
      { kind: 'enfermeria', user: String(enfermera._id), serviceName: 'Sueroterapia' },
      { kind: 'doctor', user: String(doctor._id) },
    ],
  }, params(cita._id)));

  await H.runController(appt.nurseClaim, comoEnfermero(clinicId, enfermera._id, cita._id));
  await H.runController(appt.nurseComplete, comoEnfermero(clinicId, enfermera._id, cita._id));

  const media = await Appointment.findById(cita._id).lean();
  assert.equal(media.status, 'asistida', 'la cita sigue viva: falta el doctor');
  assert.equal(media.turns[1].status, 'pendiente');

  // La enfermera vuelve a la ficha (el botón de atrás del navegador) y guarda.
  const r = await H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, enfermera._id, {
      descripcion: 'Anoto lo que apliqué',
      appointmentId: String(cita._id),
    }, { role: 'enfermero', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const despues = await Appointment.findById(cita._id).lean();
  assert.equal(
    despues.turns[1].status, 'pendiente',
    'el turno del doctor NO se cierra: él todavía no ha atendido',
  );
  assert.equal(despues.status, 'asistida', 'y la cita no puede darse por completada');
});

test('sin nada aplicado el parte sale como siempre', async () => {
  const { clinicId, userId, patient, enfermera, cita } = await seed();

  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'enfermeria', user: String(enfermera._id), serviceName: 'Curación' }],
  }, params(cita._id)));
  await H.runController(appt.nurseClaim, comoEnfermero(clinicId, enfermera._id, cita._id));
  await H.runController(appt.nurseComplete, comoEnfermero(clinicId, enfermera._id, cita._id));

  const [parte] = await partes(patient._id);
  assert.deepEqual(parte.aplicaciones, [], 'sin dosis, el arreglo va vacío y no se pinta nada');
  assert.equal(parte.observaciones, 'Servicio aplicado por enfermería.');
  assert.match(parte.motivoConsulta, /Curación/);
});
