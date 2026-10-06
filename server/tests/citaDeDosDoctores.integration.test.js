/**
 * UNA CITA DE DOS DOCTORES CUENTA PARA LOS DOS (oct-2026).
 *
 * En Central una ginecóloga atiende primero y después pasa el paciente a
 * medicina general. El espejo `doctor` de la cita es el ÚLTIMO que atendió, así
 * que filtrar la agenda o Comisiones por él dejaba a la primera doctora con dos
 * días trabajados cuando fueron veinte.
 *
 * Lo que fijan estos tests:
 *   1. el filtro de doctor de la agenda (lista y calendario) encuentra la cita
 *      por el TURNO, no solo por el espejo;
 *   2. Comisiones > Doctores le cuenta la cita a cada doctor, con SUS tarifas,
 *      y los totales de arriba cuentan la cita una sola vez;
 *   3. el detalle de citas filtrado por la primera dice que la fila es suya;
 *   4. el reporte contable también le paga a quien atendió primero;
 *   5. un turno OMITIDO no cuenta.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const User = require('../models/User');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const appt = require('../controllers/appointmentController');
const comisiones = require('../controllers/commissionController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  // Comisiones puebla la sucursal de la cita para buscar las tarifas: tiene que existir.
  await Clinic.create({ _id: clinicId, name: 'Central', nombreComercial: 'Central', active: true });
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Pérez' });
  const gine = await User.create({
    name: 'Gine Primera', email: 'gine@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'ginecologia' }],
  });
  const general = await User.create({
    name: 'General Segundo', email: 'general@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'doctor' }],
  });
  const omitido = await User.create({
    name: 'Omitido Tercero', email: 'omitido@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'doctor' }],
  });
  const servicio = await AppointmentServiceItem.create({ clinic: clinicId, name: 'Mujer Sana', slug: 'mujer sana' });
  const dia = H.docDate();
  // La cita de los dos: el espejo apunta al SEGUNDO, como en producción.
  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: dia, startTime: '09:00', status: 'completada',
    serviceItem: servicio._id, serviceName: servicio.name, agreedValue: 100,
    doctor: general._id,
    turns: [
      { kind: 'doctor', user: gine._id, status: 'completado', order: 0 },
      { kind: 'doctor', user: general._id, status: 'completado', order: 1 },
      { kind: 'doctor', user: omitido._id, status: 'omitido', order: 2 },
    ],
  });
  return { clinicId, userId, gine, general, omitido, servicio, dia, cita };
}

test('la agenda encuentra la cita al filtrar por el doctor que atendió PRIMERO', async () => {
  const { clinicId, userId, gine, general, omitido, dia } = await seed();
  const pedir = (handler, doctor) => H.runController(handler, H.mockReq(clinicId, userId, {}, {
    role: 'admin',
    query: { startDate: ymd(dia), endDate: ymd(dia), clinic: 'all', doctor: String(doctor._id) },
  }));

  const cal = await pedir(appt.getCalendarSummary, gine);
  assert.equal(cal.statusCode < 400, true, JSON.stringify(cal.payload));
  assert.equal(cal.payload.length, 1, 'el día sale en el calendario de la primera doctora');
  assert.equal(cal.payload[0].total, 1);

  const lista = await pedir(appt.getAppointments, gine);
  assert.equal(lista.statusCode < 400, true, JSON.stringify(lista.payload));
  const citas = Array.isArray(lista.payload) ? lista.payload : lista.payload.appointments;
  assert.equal(citas.length, 1, 'y la cita en la lista del día');

  const delEspejo = await pedir(appt.getCalendarSummary, general);
  assert.equal(delEspejo.payload[0]?.total, 1, 'al segundo (el espejo) le sigue saliendo');

  const delOmitido = await pedir(appt.getCalendarSummary, omitido);
  assert.equal(delOmitido.payload.length, 0, 'un turno omitido no es haber atendido');
});

test('Comisiones > Doctores le cuenta la cita a cada doctor con sus tarifas', async () => {
  const { clinicId, userId, gine, general, omitido, servicio, dia } = await seed();
  const req = (extra, body = {}) => H.mockReq(clinicId, userId, body, { role: 'admin', ...extra });

  // Tarifa de servicio para la ginecóloga ($10) y para el general ($4).
  for (const [doc, value] of [[gine, 10], [general, 4]]) {
    const r = await H.runController(comisiones.saveDoctorServiceRule, req({}, {
      doctor: String(doc._id), service: String(servicio._id), clinics: [String(clinicId)], amountType: 'fixed', value,
    }));
    assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  }

  const rango = { start: ymd(dia), end: ymd(dia) };

  // Sin filtro: una fila por doctor, la cita contada UNA vez en los totales.
  const todos = await H.runController(comisiones.doctorSummary, req({ query: rango }));
  assert.equal(todos.statusCode < 400, true, JSON.stringify(todos.payload));
  const fila = (id) => todos.payload.doctors.find((d) => d.doctorId === String(id));
  assert.equal(fila(gine._id)?.total, 1, 'la primera doctora tiene su cita');
  assert.equal(fila(gine._id).commissionTotal, 10);
  assert.equal(fila(general._id)?.total, 1);
  assert.equal(fila(general._id).commissionTotal, 4);
  assert.equal(fila(omitido._id), undefined, 'el turno omitido no suma');
  assert.equal(todos.payload.totals.byStatus.completada, 1, 'la cita se cuenta una sola vez arriba');
  assert.equal(todos.payload.totals.generated, 100, 'y lo generado tampoco se duplica');
  assert.equal(todos.payload.totals.commissions, 14);

  // Filtrando por la primera: solo su fila y solo su comisión.
  const suyo = await H.runController(comisiones.doctorSummary, req({ query: { ...rango, doctor: String(gine._id) } }));
  assert.deepEqual(suyo.payload.doctors.map((d) => d.doctorId), [String(gine._id)]);
  assert.equal(suyo.payload.doctors[0].commissionTotal, 10);

  // El detalle filtrado por ella dice que la fila es suya.
  const detalle = await H.runController(comisiones.doctorAppointments, req({ query: { ...rango, doctor: String(gine._id) } }));
  assert.equal(detalle.payload.appointments.length, 1);
  assert.equal(detalle.payload.appointments[0].doctorId, String(gine._id));
  assert.equal(detalle.payload.appointments[0].visitNumber, 1);

  // El reporte contable también le paga a quien atendió primero.
  const reporte = await H.runController(comisiones.report, req({ query: rango }));
  const pagado = (id) => reporte.payload.detail.filter((d) => d.userId === String(id)).reduce((t, d) => t + d.amount, 0);
  assert.equal(pagado(gine._id), 10);
  assert.equal(pagado(general._id), 4);
});
