/**
 * BUSCAR UN NOMBRE COMO LO DICE LA GENTE.
 *
 * El paciente se llama «TOMMY NELSON SOLANO PEÑAFIEL» y en el mostrador se le
 * conoce como «Tommy Solano». Con la expresión regular del texto tal cual —que
 * es como estaba— eso no devolvía NADA: había que escribir el nombre entero, en
 * el orden exacto, con sus tildes y sin un espacio de más. Con el paciente
 * delante eso es inservible, y lo que se hacía era buscar por cédula o rendirse
 * y volver a crear el paciente.
 *
 * Se vigila que la regla sea la misma en las dos pantallas donde se busca —el
 * listado de pacientes y la agenda— y que lo que ya funcionaba (cédula, teléfono
 * en cualquier formato) siga funcionando.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const patients = require('../controllers/patientController');
const appt = require('../controllers/appointmentController');
const { nameMatches, nameSearchFilter } = require('../utils/nameSearch');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  await Clinic.create({ _id: clinicId, name: 'Central' });
  const crear = (firstName, lastName, extra = {}) =>
    Patient.create({ clinic: clinicId, firstName, lastName, ...extra });

  const tommy = await crear('TOMMY NELSON', 'SOLANO PEÑAFIEL', {
    cedula: '0102030405', phone: '593988535561',
  });
  const otro = await crear('MARIA JOSE', 'SOLANO ANDRADE', { cedula: '0908070605' });
  const tercero = await crear('Ana', 'Muñoz', { cedula: '1122334455' });
  return { clinicId, userId, tommy, otro, tercero };
}

const buscar = (clinicId, userId, search) =>
  H.runController(patients.getPatients, H.mockReq(clinicId, userId, {}, { role: 'admin', query: { search } }));

const nombres = (payload) => payload.patients.map((p) => `${p.firstName} ${p.lastName}`).sort();

test('T1) «tommy solano»: palabras sueltas de nombre Y apellido', async () => {
  const { clinicId, userId } = await seed();
  assert.deepEqual(nombres(ok(await buscar(clinicId, userId, 'tommy solano'))), [
    'TOMMY NELSON SOLANO PEÑAFIEL',
  ]);
});

test('T2) el ORDEN da igual, y los espacios de más sobran solos', async () => {
  const { clinicId, userId } = await seed();
  for (const texto of ['solano tommy', '  tommy   solano  ', 'SOLANO   TOMMY']) {
    assert.deepEqual(
      nombres(ok(await buscar(clinicId, userId, texto))),
      ['TOMMY NELSON SOLANO PEÑAFIEL'],
      `falló con «${texto}»`
    );
  }
});

test('T3) las tildes y la eñe no hacen falta (ni estorban)', async () => {
  const { clinicId, userId } = await seed();
  // Escrito sin eñe, guardado con eñe.
  assert.deepEqual(nombres(ok(await buscar(clinicId, userId, 'penafiel'))), [
    'TOMMY NELSON SOLANO PEÑAFIEL',
  ]);
  assert.deepEqual(nombres(ok(await buscar(clinicId, userId, 'munoz'))), ['ANA MUÑOZ']);
  // Y al revés: escrito con eñe.
  assert.deepEqual(nombres(ok(await buscar(clinicId, userId, 'muñoz'))), ['ANA MUÑOZ']);
});

test('T4) una palabra suelta sigue trayendo a TODOS los que la llevan', async () => {
  const { clinicId, userId } = await seed();
  assert.deepEqual(nombres(ok(await buscar(clinicId, userId, 'solano'))), [
    'MARIA JOSE SOLANO ANDRADE',
    'TOMMY NELSON SOLANO PEÑAFIEL',
  ]);
});

test('T5) cédula y teléfono siguen funcionando, y el teléfono en cualquier formato', async () => {
  const { clinicId, userId } = await seed();
  assert.deepEqual(nombres(ok(await buscar(clinicId, userId, '0102030405'))), [
    'TOMMY NELSON SOLANO PEÑAFIEL',
  ]);
  // Guardado en E.164, tecleado como lo tiene apuntado la gente.
  assert.deepEqual(nombres(ok(await buscar(clinicId, userId, '0988535561'))), [
    'TOMMY NELSON SOLANO PEÑAFIEL',
  ]);
});

test('T6) lo que NO está no aparece (no se busca de más)', async () => {
  const { clinicId, userId } = await seed();
  assert.deepEqual(nombres(ok(await buscar(clinicId, userId, 'tommy andrade'))), []);
  assert.deepEqual(nombres(ok(await buscar(clinicId, userId, 'pepito'))), []);
});

test('T7) un texto de solo signos no revienta la consulta', async () => {
  const { clinicId, userId } = await seed();
  // '(' y '+' son normales en un teléfono copiado y pegado; sin escapar tiran un 500.
  for (const texto of ['(', '+', '((( )))', '***']) {
    const r = await buscar(clinicId, userId, texto);
    assert.ok(r.statusCode < 400, `«${texto}» devolvió ${r.statusCode}`);
  }
});

test('T8) la AGENDA busca igual que el listado', async () => {
  const { clinicId, userId, tommy } = await seed();
  const hoy = new Date(); hoy.setHours(12, 0, 0, 0);
  await Appointment.create({
    clinic: clinicId, patient: tommy._id, date: hoy, startTime: '10:00', createdBy: userId,
  });

  const agenda = (q) =>
    H.runController(appt.getAppointments, H.mockReq(clinicId, userId, {}, { role: 'admin', query: { q } }));

  const encontradas = ok(await agenda('tommy solano'));
  const lista = Array.isArray(encontradas) ? encontradas : encontradas.appointments || [];
  assert.equal(lista.length, 1, 'la cita aparece buscando «tommy solano»');

  const vacio = ok(await agenda('tommy andrade'));
  const lista2 = Array.isArray(vacio) ? vacio : vacio.appointments || [];
  assert.equal(lista2.length, 0, 'y no aparece con un nombre que no es');
});

test('T9) el espejo del cliente decide lo mismo que el del servidor', () => {
  // `nameMatches` es lo que usan los buscadores que filtran una lista ya cargada
  // (Ventas). Si las dos reglas se separan, el mismo texto encuentra cosas
  // distintas según la pantalla.
  const casos = [
    ['tommy solano', true],
    ['solano tommy', true],
    ['  tommy   solano ', true],
    ['penafiel', true],
    ['PEÑAFIEL', true],
    ['tommy andrade', false],
    ['', true], // sin nada escrito no se filtra
  ];
  for (const [texto, esperado] of casos) {
    assert.equal(
      nameMatches(texto, 'TOMMY NELSON', 'SOLANO PEÑAFIEL'),
      esperado,
      `nameMatches falló con «${texto}»`
    );
  }
  // Y el del servidor no monta condición cuando no hay nada que buscar.
  assert.equal(nameSearchFilter('   ', ['firstName']), null);
});
