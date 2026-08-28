/**
 * DURACIÓN DE LOS SERVICIOS DE AGENDA.
 *
 * No todos ocupan lo mismo: un control son diez minutos y un tratamiento puede
 * llevar una hora. Sin esto, «Disponibilidad en este horario» miraba minuto a
 * minuto y una cita de 40 minutos empezada a las 14:00 desaparecía al consultar
 * las 14:20 — el hueco parecía libre y se agendaba encima del paciente que
 * seguía dentro.
 *
 * La regla de solapamiento se prueba AQUÍ y no solo en la pantalla porque es la
 * que decide si se agenda encima de alguien, y es la que hay que poder cambiar
 * sin miedo. Es la misma que aplica `client/src/components/SameSlotPanel.jsx`:
 * si una cambia, este test tiene que fallar.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const ctrl = require('../controllers/appointmentServiceItemController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// ───────────────────── la regla de solapamiento ─────────────────────

const aMinutos = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return h * 60 + (m || 0);
};

/**
 * Espejo EXACTO de `seSolapan` en SameSlotPanel.jsx. Las duraciones de 0 valen
 * un minuto para que «nada configurado» siga siendo la coincidencia exacta de
 * hora de siempre, en vez de no casar nunca por tener longitud cero.
 */
const seSolapan = (iniA, durA, iniB, durB) => {
  const finA = iniA + Math.max(durA, 1);
  const finB = iniB + Math.max(durB, 1);
  return iniA < finB && finA > iniB;
};

const choca = (horaA, durA, horaB, durB) =>
  seSolapan(aMinutos(horaA), durA, aMinutos(horaB), durB);

test('sin duración configurada, se comporta como la coincidencia exacta de antes', async () => {
  assert.equal(choca('14:00', 0, '14:00', 0), true, 'la misma hora sí');
  assert.equal(choca('14:00', 0, '14:20', 0), false, 'otra hora no');
  assert.equal(choca('14:00', 0, '14:01', 0), false, 'ni un minuto después');
});

test('EL CASO: una cita de 40 min sigue apareciendo pasados los 20', async () => {
  // Agenda en espacios de 20 min, servicio de 40. La cita de las 14:00 ocupa
  // hasta las 14:40.
  assert.equal(choca('14:00', 40, '14:20', 0), true, 'a las 14:20 sigue ocupado');
  assert.equal(choca('14:00', 40, '14:39', 0), true, 'hasta el último minuto');
  assert.equal(choca('14:00', 40, '14:40', 0), false, 'a las 14:40 ya está libre');
  assert.equal(choca('14:00', 40, '13:59', 0), false, 'antes de empezar, libre');
});

test('el servicio que se está agendando también cuenta', async () => {
  // Voy a agendar algo de 60 min a las 14:00: choca con lo que empiece dentro.
  assert.equal(choca('14:30', 0, '14:00', 60), true, 'una cita a las 14:30 estorba');
  assert.equal(choca('15:00', 0, '14:00', 60), false, 'una a las 15:00 ya no');
  // Y las dos cosas a la vez: 30 min desde las 13:45 contra 60 desde las 14:00.
  assert.equal(choca('13:45', 30, '14:00', 60), true, 'se pisan por 15 minutos');
  assert.equal(choca('13:30', 30, '14:00', 60), false, 'termina justo cuando empieza');
});

test('el borde no cuenta como choque: una cita puede empezar donde acaba la otra', async () => {
  assert.equal(choca('14:00', 30, '14:30', 30), false);
  assert.equal(choca('14:30', 30, '14:00', 30), false);
  assert.equal(choca('14:00', 30, '14:29', 30), true, 'un minuto antes sí choca');
});

// ───────────────────── la configuración ─────────────────────

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const item = await AppointmentServiceItem.create({
    clinic: clinicId, name: 'Detox', slug: 'detox', createdBy: userId,
  });
  return { clinicId, userId, item };
}

test('un servicio nace sin duración propia (usa la de la cita normal)', async () => {
  const { item } = await seed();
  assert.equal(item.durationMinutes, 0);
});

test('el administrador le pone una duración y se guarda', async () => {
  const { clinicId, userId, item } = await seed();
  const r = await H.runController(
    ctrl.update,
    H.mockReq(clinicId, userId, { durationMinutes: 40 }, { role: 'admin', params: { id: String(item._id) } }),
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  const guardado = await AppointmentServiceItem.findById(item._id).lean();
  assert.equal(guardado.durationMinutes, 40);
});

test('una duración absurda se rechaza con un mensaje entendible', async () => {
  const { clinicId, userId, item } = await seed();
  for (const valor of [-5, 999]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await H.runController(
      ctrl.update,
      H.mockReq(clinicId, userId, { durationMinutes: valor }, { role: 'admin', params: { id: String(item._id) } }),
    );
    assert.equal(r.statusCode, 400, `${valor} debería rechazarse`);
    assert.match(r.payload.message, /duración/i);
  }
  const guardado = await AppointmentServiceItem.findById(item._id).lean();
  assert.equal(guardado.durationMinutes, 0, 'no se tocó');
});

test('renombrar o cambiar el color NO borra la duración', async () => {
  const { clinicId, userId, item } = await seed();
  await H.runController(
    ctrl.update,
    H.mockReq(clinicId, userId, { durationMinutes: 60 }, { role: 'admin', params: { id: String(item._id) } }),
  );
  await H.runController(
    ctrl.update,
    H.mockReq(clinicId, userId, { name: 'Detox completo' }, { role: 'admin', params: { id: String(item._id) } }),
  );
  const guardado = await AppointmentServiceItem.findById(item._id).lean();
  assert.equal(guardado.name, 'Detox completo');
  assert.equal(guardado.durationMinutes, 60, 'la duración sobrevive al renombrado');
});

test('el catálogo devuelve la duración: es de donde la lee el panel', async () => {
  const { clinicId, userId, item } = await seed();
  await H.runController(
    ctrl.update,
    H.mockReq(clinicId, userId, { durationMinutes: 45 }, { role: 'admin', params: { id: String(item._id) } }),
  );
  const r = await H.runController(ctrl.list, H.mockReq(clinicId, userId, {}, { query: {} }));
  const encontrado = (r.payload || []).find((x) => String(x._id) === String(item._id));
  assert.ok(encontrado, 'el servicio sale en el catálogo');
  assert.equal(encontrado.durationMinutes, 45);
});
