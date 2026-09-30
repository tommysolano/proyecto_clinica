/**
 * Comisiones > Marketing: los agendamientos del call center.
 *
 * - Un agente DESACTIVADO sigue saliendo con lo que agendó en el período (hay
 *   que poder calcular lo que se le debe).
 * - El listado de pacientes nuevos trae quién los agendó, cuándo se agendaron y
 *   cuándo el sistema los dio por nuevos.
 * - El filtro puede ir por fecha de la cita o por fecha en que se agendó.
 * - Nuevo = primera cita ASISTIDA o COMPLETADA y sin seguimiento anterior ni
 *   ficha física (aunque la ficha se haya subido después de agendar).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const commissions = require('../controllers/commissionController');
const User = require('../models/User');
const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const Conversation = require('../models/Conversation');
const ClinicalRecord = require('../models/ClinicalRecord');
require('../models/Clinic'); // el populate de la sucursal

const ok = (result) => {
  assert.ok(result.statusCode < 400, JSON.stringify(result.payload));
  return result.payload;
};

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const activa = await User.create({
    name: 'Asesora Activa', email: 'activa@correo.com', password: 'x'.repeat(12),
    clinics: [{ clinic: clinicId, role: 'call_center' }],
  });
  const ida = await User.create({
    name: 'Asesora Que Se Fue', email: 'ida@correo.com', password: 'x'.repeat(12),
    active: false,
    clinics: [{ clinic: clinicId, role: 'call_center' }],
  });
  const nuevo = await Patient.create({ clinic: clinicId, firstName: 'PACIENTE', lastName: 'NUEVO' });
  const viejo = await Patient.create({ clinic: clinicId, firstName: 'PACIENTE', lastName: 'VIEJO' });

  const hoy = new Date();
  hoy.setHours(12, 0, 0, 0);
  const haceDiezDias = new Date(hoy.getTime() - 10 * 86400000);
  const cita = (extra) => Appointment.create({
    clinic: clinicId, date: hoy, startTime: '10:00', status: 'pendiente', ...extra,
  });
  // La asesora desactivada agendó a un paciente nuevo HACE 10 DÍAS para hoy.
  const citaNueva = await cita({
    patient: nuevo._id, createdBy: ida._id, createdByName: ida.name, createdByRole: 'call_center',
    isFirstVisit: true, status: 'asistida',
  });
  await Appointment.collection.updateOne({ _id: citaNueva._id }, { $set: { createdAt: haceDiezDias } });
  await cita({ patient: viejo._id, createdBy: activa._id, createdByRole: 'call_center', isFirstVisit: false });

  return { clinicId, userId, activa, ida, hoy, haceDiezDias };
}

test('la asesora desactivada sigue saliendo con lo que agendó', async () => {
  const { clinicId, userId, ida, hoy } = await seed();
  const res = ok(await H.runController(
    commissions.callCenterSummary,
    H.mockReq(clinicId, userId, {}, { role: 'marketing', query: { start: ymd(hoy), end: ymd(hoy), clinic: 'all' } })
  ));
  const suya = res.agents.find((a) => a.userId === String(ida._id));
  assert.ok(suya, 'aparece aunque su cuenta esté desactivada');
  assert.equal(suya.inactive, true);
  assert.equal(suya.total, 1);
  assert.equal(suya.nuevos, 1);
  assert.equal(res.totals.total, 2);
});

test('lista a los pacientes nuevos con quién y cuándo se agendaron', async () => {
  const { clinicId, userId, ida, hoy, haceDiezDias } = await seed();
  const res = ok(await H.runController(
    commissions.callCenterNewPatients,
    H.mockReq(clinicId, userId, {}, { role: 'marketing', query: { start: ymd(hoy), end: ymd(hoy), clinic: 'all' } })
  ));
  assert.equal(res.total, 1, 'solo el nuevo; el recurrente no entra');
  const [p] = res.patients;
  assert.equal(p.patient, 'PACIENTE NUEVO');
  assert.equal(p.agent, ida.name);
  assert.equal(p.agentInactive, true);
  assert.equal(new Date(p.scheduledAt).getTime(), haceDiezDias.getTime());
  // Cuenta como nuevo desde que asistió (sin hora de llegada: el día de la cita).
  assert.equal(new Date(p.markedNewAt).getTime(), hoy.getTime());
  assert.equal(p.status, 'asistida');

  // Filtrando por la fecha en que se AGENDÓ: hoy no hay ninguno, hace 10 días sí.
  const porAgendaHoy = ok(await H.runController(
    commissions.callCenterNewPatients,
    H.mockReq(clinicId, userId, {}, { role: 'marketing', query: { start: ymd(hoy), end: ymd(hoy), clinic: 'all', fecha: 'agendada' } })
  ));
  assert.equal(porAgendaHoy.total, 0);
  const porAgendaAntes = ok(await H.runController(
    commissions.callCenterNewPatients,
    H.mockReq(clinicId, userId, {}, {
      role: 'marketing',
      query: { start: ymd(haceDiezDias), end: ymd(haceDiezDias), clinic: 'all', fecha: 'agendada', agent: String(ida._id) },
    })
  ));
  assert.equal(porAgendaAntes.total, 1);
});

test('los pacientes nuevos vienen paginados, lo último agendado primero', async () => {
  const { clinicId, userId, activa, hoy } = await seed();
  const base = Date.now();
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const pac = await Patient.create({ clinic: clinicId, firstName: `PAG${i}` });
    // eslint-disable-next-line no-await-in-loop
    const c = await Appointment.create({
      clinic: clinicId, date: hoy, startTime: '11:00', status: 'asistida', patient: pac._id,
      createdBy: activa._id, createdByRole: 'call_center', isFirstVisit: true,
    });
    // eslint-disable-next-line no-await-in-loop
    await Appointment.collection.updateOne({ _id: c._id }, { $set: { createdAt: new Date(base + i * 60000) } });
  }
  const pedir = (page) => H.runController(
    commissions.callCenterNewPatients,
    H.mockReq(clinicId, userId, {}, {
      role: 'marketing', query: { start: ymd(hoy), end: ymd(hoy), clinic: 'all', page: String(page), limit: '2' },
    })
  ).then(ok);
  const p1 = await pedir(1);
  assert.equal(p1.total, 6, '5 nuevos + el de la asesora desactivada');
  assert.deepEqual(p1.pagination, { page: 1, limit: 2, total: 6, pages: 3 });
  assert.deepEqual(p1.patients.map((x) => x.patient), ['PAG4', 'PAG3']);
  const p3 = await pedir(3);
  assert.equal(p3.patients.length, 2);
  assert.equal(p3.patients[1].patient, 'PACIENTE NUEVO', 'el más antiguo, al final');
});

test('la primera cita que no quedó asistida no cuenta como nuevo', async () => {
  const { clinicId, userId, activa, hoy } = await seed();
  for (const status of ['pendiente', 'confirmada', 'no_asistio', 'cancelada']) {
    // eslint-disable-next-line no-await-in-loop
    const pac = await Patient.create({ clinic: clinicId, firstName: `SIN ASISTIR ${status}` });
    // eslint-disable-next-line no-await-in-loop
    await Appointment.create({
      clinic: clinicId, date: hoy, startTime: '09:00', status, patient: pac._id,
      createdBy: activa._id, createdByRole: 'call_center', isFirstVisit: true,
    });
  }
  const query = { start: ymd(hoy), end: ymd(hoy), clinic: 'all' };
  const resumen = ok(await H.runController(
    commissions.callCenterSummary, H.mockReq(clinicId, userId, {}, { role: 'marketing', query })
  ));
  const suya = resumen.agents.find((a) => a.userId === String(activa._id));
  assert.equal(suya.nuevos, 0);
  assert.equal(suya.nuevosSinAsistir, 4);
  assert.equal(resumen.totals.nuevos, 1, 'solo el asistido de la asesora desactivada');
  assert.equal(resumen.totals.nuevosSinAsistir, 4);

  const lista = ok(await H.runController(
    commissions.callCenterNewPatients, H.mockReq(clinicId, userId, {}, { role: 'marketing', query })
  ));
  assert.deepEqual(lista.patients.map((p) => p.patient), ['PACIENTE NUEVO']);
});

test('quien ya tenía un seguimiento anterior o ficha física no es nuevo, aunque se subiera después de agendar', async () => {
  const { clinicId, userId, activa, hoy } = await seed();
  const crear = async (firstName, extraPac = {}) => {
    const pac = await Patient.create({ clinic: clinicId, firstName, ...extraPac });
    const c = await Appointment.create({
      clinic: clinicId, date: hoy, startTime: '08:00', status: 'completada', patient: pac._id,
      createdBy: activa._id, createdByRole: 'call_center', isFirstVisit: true,
    });
    return { pac, c };
  };
  // La ficha de papel (consulta de 2023) se importó DESPUÉS de agendar.
  const { pac: papel } = await crear('CON FICHA DE PAPEL');
  await ClinicalRecord.create({
    clinic: clinicId, patient: papel._id, createdBy: userId,
    followUps: [{ fecha: new Date('2023-04-12'), motivoConsulta: 'Control', createdBy: userId }],
  });
  await crear('CON ARCHIVO FISICO', { scanImport: { importadoAt: new Date('2026-09-23') } });
  // El seguimiento que escribió la propia consulta (mismo día) no es pasado.
  const { pac: deHoy } = await crear('SEGUIMIENTO DE LA CITA');
  await ClinicalRecord.create({
    clinic: clinicId, patient: deHoy._id, createdBy: userId,
    followUps: [{ fecha: hoy, motivoConsulta: 'Primera consulta', createdBy: userId }],
  });

  const query = { start: ymd(hoy), end: ymd(hoy), clinic: 'all' };
  const lista = ok(await H.runController(
    commissions.callCenterNewPatients, H.mockReq(clinicId, userId, {}, { role: 'marketing', query })
  ));
  assert.deepEqual(lista.patients.map((p) => p.patient).sort(), ['PACIENTE NUEVO', 'SEGUIMIENTO DE LA CITA']);
  assert.equal(lista.total, 2);

  const resumen = ok(await H.runController(
    commissions.callCenterSummary, H.mockReq(clinicId, userId, {}, { role: 'marketing', query })
  ));
  const suya = resumen.agents.find((a) => a.userId === String(activa._id));
  assert.equal(suya.nuevos, 1);
  assert.equal(suya.recurrentes, 3, 'el paciente viejo + los dos con historia previa');
});

test('si faltó a la primera y se le creó OTRA cita, cuenta como nuevo cuando asiste a esa otra', async () => {
  const { clinicId, userId, activa, hoy } = await seed();
  const ayer = new Date(hoy.getTime() - 86400000);
  const pac = await Patient.create({ clinic: clinicId, firstName: 'FALTO Y VOLVIO' });
  const primera = await Appointment.create({
    clinic: clinicId, date: ayer, startTime: '09:00', status: 'no_asistio', patient: pac._id,
    createdBy: activa._id, createdByRole: 'call_center', isFirstVisit: true,
  });
  await Appointment.collection.updateOne({ _id: primera._id }, { $set: { createdAt: new Date(ayer.getTime() - 86400000) } });
  // Su suero de serie quedó escrito al agendar la primera: no es historia previa.
  await ClinicalRecord.create({
    clinic: clinicId, patient: pac._id, createdBy: userId,
    followUps: [{ _id: primera._id, fecha: ayer, motivoConsulta: 'Suero', createdBy: userId }],
  });
  await Appointment.collection.updateOne({ _id: primera._id }, { $set: { autoSerumFollowUp: primera._id } });
  // La segunda la agendó el sistema como NO primera vez (ya existía la otra).
  await Appointment.create({
    clinic: clinicId, date: hoy, startTime: '09:00', status: 'asistida', patient: pac._id,
    createdBy: activa._id, createdByRole: 'call_center', isFirstVisit: false,
  });

  const pedir = (fn, desde) => H.runController(fn, H.mockReq(clinicId, userId, {}, {
    role: 'marketing', query: { start: ymd(desde), end: ymd(hoy), clinic: 'all' },
  })).then(ok);
  const lista = await pedir(commissions.callCenterNewPatients, hoy);
  assert.ok(lista.patients.some((p) => p.patient === 'FALTO Y VOLVIO'), 'la cita a la que asistió cuenta');

  // Con los dos días: nuevo 1 vez (la atendida); la que faltó no suma ni como
  // «sin asistir» ni como recurrente.
  const resumen = await pedir(commissions.callCenterSummary, ayer);
  const suya = resumen.agents.find((a) => a.userId === String(activa._id));
  assert.equal(suya.total, 3, 'las dos del paciente + el recurrente del seed');
  assert.equal(suya.nuevos, 1);
  assert.equal(suya.nuevosSinAsistir, 0);
  assert.equal(suya.recurrentes, 1);

  // Una tercera cita, ya después de la atendida, es recurrente.
  await Appointment.create({
    clinic: clinicId, date: new Date(hoy.getTime() + 86400000), startTime: '09:00', status: 'completada',
    patient: pac._id, createdBy: activa._id, createdByRole: 'call_center', isFirstVisit: false,
  });
  const lista2 = ok(await H.runController(commissions.callCenterNewPatients, H.mockReq(clinicId, userId, {}, {
    role: 'marketing', query: { start: ymd(ayer), end: ymd(new Date(hoy.getTime() + 86400000)), clinic: 'all' },
  })));
  assert.equal(lista2.patients.filter((p) => p.patient === 'FALTO Y VOLVIO').length, 1, 'se cuenta una sola vez');
});

test('el paciente que nunca fue nuevo no se vuelve nuevo por asistir', async () => {
  const { clinicId, userId, activa, hoy } = await seed();
  const pac = await Patient.create({ clinic: clinicId, firstName: 'DE CONTIFICO' });
  // Su única cita se agendó ya como NO primera vez (tenía ventas, p. ej.).
  await Appointment.create({
    clinic: clinicId, date: hoy, startTime: '09:00', status: 'completada', patient: pac._id,
    createdBy: activa._id, createdByRole: 'call_center', isFirstVisit: false,
  });
  const lista = ok(await H.runController(commissions.callCenterNewPatients, H.mockReq(clinicId, userId, {}, {
    role: 'marketing', query: { start: ymd(hoy), end: ymd(hoy), clinic: 'all' },
  })));
  assert.ok(!lista.patients.some((p) => p.patient === 'DE CONTIFICO'));
});

test('cada paciente nuevo trae su chat: el vinculado o, si no, el de su teléfono', async () => {
  const { clinicId, userId, activa, hoy } = await seed();
  const conChat = await Patient.create({ clinic: clinicId, firstName: 'CON CHAT' });
  const porTel = await Patient.create({ clinic: clinicId, firstName: 'POR TELEFONO', phone: '0999111222' });
  const sinChat = await Patient.create({ clinic: clinicId, firstName: 'SIN CHAT', phone: '0988000000' });
  const vinculado = await Conversation.create({ clinic: clinicId, phone: '593977000000', patient: conChat._id });
  const delTelefono = await Conversation.create({ clinic: clinicId, phone: '593999111222' });
  for (const pac of [conChat, porTel, sinChat]) {
    // eslint-disable-next-line no-await-in-loop
    await Appointment.create({
      clinic: clinicId, date: hoy, startTime: '12:00', status: 'completada', patient: pac._id,
      createdBy: activa._id, createdByRole: 'call_center', isFirstVisit: true,
    });
  }
  const res = ok(await H.runController(
    commissions.callCenterNewPatients,
    H.mockReq(clinicId, userId, {}, { role: 'marketing', query: { start: ymd(hoy), end: ymd(hoy), clinic: 'all' } })
  ));
  const de = (nombre) => res.patients.find((x) => x.patient === nombre);
  assert.equal(de('CON CHAT').chatId, String(vinculado._id));
  assert.equal(de('POR TELEFONO').chatId, String(delTelefono._id));
  assert.equal(de('SIN CHAT').chatId, null);
  assert.ok(!('phone' in de('POR TELEFONO')), 'el teléfono no se expone');
});
