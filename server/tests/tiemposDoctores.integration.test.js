/**
 * Oct-2026 (Fénix → «Tiempos de Doctores»): cuánto tarda cada doctor por
 * atención, su promedio y qué está haciendo ahora. Ver utils/tiemposDoctores.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const User = require('../models/User');
const reports = require('../controllers/reportController');
const { asignarTurnos } = require('../utils/appointmentTurns');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const hoyAlMediodia = () => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d;
};
const haceMin = (m) => new Date(Date.now() - m * 60000);

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const crear = (name, role = 'doctor') =>
    User.create({ name, email: `${name.toLowerCase()}@t.com`, password: 'secreto123', clinics: [{ clinic: clinicId, role }] });
  const ana = await crear('Ana');
  const beto = await crear('Beto', 'ginecologia');
  await crear('Libre');
  await crear('Enfer', 'enfermero');
  let n = 0;
  const paciente = async () =>
    Patient.create({ clinic: clinicId, firstName: `P${(n += 1)}`, lastName: 'Test', cedula: `01020304${10 + n}` });
  const cita = async (pasos, extra = {}) => {
    const p = await paciente();
    const a = new Appointment({ clinic: clinicId, patient: p._id, date: hoyAlMediodia(), startTime: '09:00', status: 'asistida', attentionAssignedAt: new Date(), ...extra });
    if (pasos) asignarTurnos(a, { pasos });
    return a;
  };
  return { clinicId, userId, ana, beto, cita };
}

test('tiempos por atención, promedio y estado en vivo de cada doctor', async () => {
  const { clinicId, userId, ana, beto, cita } = await seed();

  // Ana: dos atenciones cerradas hoy, de 15 y 25 minutos.
  for (const [ini, fin] of [[60, 45], [40, 15]]) {
    const a = await cita([{ kind: 'doctor', user: ana._id }], { status: 'completada' });
    a.turns[0].status = 'completado';
    a.turns[0].startedAt = haceMin(ini);
    a.turns[0].completedAt = haceMin(fin);
    await a.save();
  }
  // Ana: ahora mismo en consulta desde hace 10 min.
  const enCurso = await cita([{ kind: 'doctor', user: ana._id }]);
  enCurso.turns[0].startedAt = haceMin(10);
  await enCurso.save();
  // Beto primero y Ana DESPUÉS: Beto tiene al paciente esperando, Ana en cola.
  await (await cita([{ kind: 'doctor', user: beto._id }, { kind: 'doctor', user: ana._id }])).save();
  // Beto: cita agendada de hoy a la que el paciente aún no llegó.
  await (await cita([{ kind: 'doctor', user: beto._id }], { status: 'pendiente', attentionAssignedAt: null, startTime: '16:30' })).save();
  // Beto: atención cerrada sin haber pulsado «Atender» (sin cronómetro).
  const sinReloj = await cita([{ kind: 'doctor', user: beto._id }], { status: 'completada' });
  sinReloj.turns[0].status = 'completado';
  sinReloj.turns[0].completedAt = new Date();
  await sinReloj.save();

  const r = await H.runController(reports.doctorTimes, H.mockReq(clinicId, userId, {}, { role: 'admin', query: {} }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const porNombre = Object.fromEntries(r.payload.doctores.map((d) => [d.name, d]));

  const A = porNombre.Ana;
  assert.equal(A.ahora.estado, 'en_consulta');
  assert.ok(A.ahora.minutos >= 9 && A.ahora.minutos <= 11, `minutos en consulta: ${A.ahora.minutos}`);
  assert.match(A.ahora.paciente, /^P\d+ TEST$/i, A.ahora.paciente);
  assert.equal(A.resumen.atenciones, 2);
  assert.equal(A.resumen.promedioMin, 20);
  assert.equal(A.resumen.minMin, 15);
  assert.equal(A.resumen.maxMin, 25);
  assert.equal(A.proximas.length, 1);
  assert.equal(A.proximas[0].tipo, 'en_cola');
  assert.equal(A.proximas[0].antes.nombre, 'Beto');

  const B = porNombre.Beto;
  assert.equal(B.ahora.estado, 'libre');
  assert.deepEqual(B.proximas.map((p) => p.tipo), ['esperando', 'agendada']);
  assert.equal(B.proximas[1].hora, '16:30');
  assert.equal(B.resumen.atenciones, 1);
  assert.equal(B.resumen.sinCronometro, 1);
  assert.equal(B.resumen.promedioMin, null);

  // Un doctor sin nada hoy sale igual, como libre; la enfermera no es doctor.
  assert.equal(porNombre.Libre.ahora.estado, 'libre');
  assert.equal(porNombre.Enfer, undefined);

  // Primero quien está en consulta.
  assert.equal(r.payload.doctores[0].name, 'Ana');
  assert.equal(r.payload.resumen.enConsulta, 1);
  assert.equal(r.payload.resumen.promedioMin, 20);
});

test('el rango de fechas filtra el historial y se valida', async () => {
  const { clinicId, userId, ana, cita } = await seed();
  const vieja = await cita([{ kind: 'doctor', user: ana._id }], { status: 'completada', date: new Date(2026, 8, 1, 12) });
  vieja.turns[0].status = 'completado';
  vieja.turns[0].startedAt = new Date(2026, 8, 1, 9, 0);
  vieja.turns[0].completedAt = new Date(2026, 8, 1, 9, 30);
  await vieja.save();

  const pedir = (query) => H.runController(reports.doctorTimes, H.mockReq(clinicId, userId, {}, { role: 'admin', query }));
  const dia = await pedir({ startDate: '2026-09-01', endDate: '2026-09-01' });
  const ana1 = dia.payload.doctores.find((d) => d.name === 'Ana');
  assert.equal(ana1.resumen.atenciones, 1);
  assert.equal(ana1.resumen.promedioMin, 30);

  const hoy = await pedir({});
  assert.equal(hoy.payload.doctores.find((d) => d.name === 'Ana').resumen.atenciones, 0);

  assert.equal((await pedir({ startDate: '2026-01-01', endDate: '2026-09-01' })).statusCode, 400);
  assert.equal((await pedir({ startDate: '2026-09-02', endDate: '2026-09-01' })).statusCode, 400);
});
