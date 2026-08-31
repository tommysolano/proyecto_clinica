/**
 * OTROS SERVICIOS DE LA VISITA (`additionalServices`).
 *
 * El paciente entra por una consulta y de paso le hacen una ecografía. Hasta
 * ahora la cita tenía UN servicio, así que había que elegir cuál de los dos se
 * anotaba y el otro desaparecía.
 *
 * Se añaden por la MISMA puerta que corrige el servicio y el valor
 * (`PATCH /appointments/:id/service-value`), y por el mismo motivo: casi siempre
 * se sabe al final, con la cita ya completada. De ahí lo que se vigila aquí:
 *
 *   · se pueden añadir con la cita CERRADA, sin que eso reabra nada ni toque a
 *     quien atendió — que es la única línea que esa puerta no puede cruzar;
 *   · llega la lista COMPLETA, no un "añade este": quitar uno es mandarla sin él;
 *   · ninguna línea se repite, ni entre ellas ni contra el servicio principal;
 *   · el nombre es un SNAPSHOT: renombrar el ítem del catálogo no reescribe lo
 *     que se hizo hace tres meses;
 *   · reguardar sin cambios no falsea la fecha en que se añadió cada uno, ni
 *     infla el contador de uso del catálogo (que ordena las sugerencias).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const appt = require('../controllers/appointmentController');
const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const User = require('../models/User');

const HOY = new Date();
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function seedCase() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'P' });
  const doc = await User.create({
    clinic: clinicId, name: 'DocA', email: `doc${Date.now()}@t.com`, password: 'secret123', role: 'doctor',
  });
  const servicio = (name) =>
    AppointmentServiceItem.create({
      clinic: clinicId,
      name,
      slug: AppointmentServiceItem.slugify(name),
    });
  const consulta = await servicio('Consulta');
  const eco = await servicio('Ecografía');
  const curacion = await servicio('Curación');

  // La cita del caso real: ya atendida y cerrada.
  const cerrada = (extra = {}) =>
    Appointment.create({
      clinic: clinicId,
      patient: patient._id,
      date: new Date(`${ymd(HOY)}T12:00:00`),
      startTime: '12:40',
      status: 'completada',
      serviceItem: consulta._id,
      serviceName: 'Consulta',
      doctor: doc._id,
      consultationEndedAt: new Date(),
      createdBy: userId,
      ...extra,
    });
  return { clinicId, userId, doc, consulta, eco, curacion, cerrada };
}

const guardar = (clinicId, userId, aptId, body) =>
  H.runController(
    appt.updateServiceAndValue,
    H.mockReq(clinicId, userId, body, { role: 'cajero', params: { id: String(aptId) } })
  );

const ok = (r) => {
  assert.equal(r.statusCode, 200, `esperaba éxito: ${JSON.stringify(r.payload)}`);
  return r.payload;
};

const nombres = (apt) => (apt.additionalServices || []).map((s) => s.name);

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// ─────────────────────────────────────────────────────────────────────────────
test('a una cita YA COMPLETADA se le añaden otros servicios', async () => {
  const { clinicId, userId, doc, eco, curacion, cerrada } = await seedCase();
  const apt = await cerrada();

  ok(await guardar(clinicId, userId, apt._id, {
    additionalServices: [String(eco._id), String(curacion._id)],
  }));

  const enBase = await Appointment.findById(apt._id);
  assert.deepEqual(nombres(enBase), ['Ecografía', 'Curación']);
  assert.equal(enBase.serviceName, 'Consulta', 'el servicio por el que vino no se toca');
  assert.equal(enBase.status, 'completada', 'añadir no reabre la cita');
  assert.equal(String(enBase.doctor), String(doc._id), 'ni cambia quién atendió');
});

test('se guarda quién lo añadió y cuándo: son líneas puestas con la cita cerrada', async () => {
  const { clinicId, userId, eco, cerrada } = await seedCase();
  const apt = await cerrada();
  const antes = Date.now();

  ok(await guardar(clinicId, userId, apt._id, { additionalServices: [String(eco._id)] }));

  const [linea] = (await Appointment.findById(apt._id)).additionalServices;
  assert.equal(String(linea.addedBy), String(userId));
  assert.ok(linea.addedAt.getTime() >= antes, 'la fecha es la de ahora, no la de la cita');
});

test('manda la lista COMPLETA: mandarla sin uno lo quita', async () => {
  const { clinicId, userId, eco, curacion, cerrada } = await seedCase();
  const apt = await cerrada();

  ok(await guardar(clinicId, userId, apt._id, {
    additionalServices: [String(eco._id), String(curacion._id)],
  }));
  ok(await guardar(clinicId, userId, apt._id, { additionalServices: [String(curacion._id)] }));

  assert.deepEqual(nombres(await Appointment.findById(apt._id)), ['Curación']);

  // Y la lista vacía los quita todos: es como se deshace un añadido por error.
  ok(await guardar(clinicId, userId, apt._id, { additionalServices: [] }));
  assert.deepEqual(nombres(await Appointment.findById(apt._id)), []);
});

test('no se pisan: ni repetido en la misma petición, ni igual al principal', async () => {
  const { clinicId, userId, eco, consulta, cerrada } = await seedCase();
  const apt = await cerrada();

  ok(await guardar(clinicId, userId, apt._id, {
    // La ecografía dos veces, y encima la consulta, que ya es el servicio de la cita.
    additionalServices: [String(eco._id), String(eco._id), String(consulta._id)],
  }));

  assert.deepEqual(
    nombres(await Appointment.findById(apt._id)),
    ['Ecografía'],
    'una cita no puede decir que la misma ecografía se hizo dos veces',
  );
});

test('ascender un adicional a servicio principal no lo deja duplicado abajo', async () => {
  const { clinicId, userId, eco, cerrada } = await seedCase();
  const apt = await cerrada();
  ok(await guardar(clinicId, userId, apt._id, { additionalServices: [String(eco._id)] }));

  // «Entró por consulta, pero en realidad lo que se hizo fue la ecografía»: la
  // pantalla manda el nuevo principal y la lista de abajo tal como estaba.
  ok(await guardar(clinicId, userId, apt._id, {
    serviceItem: String(eco._id),
    additionalServices: [String(eco._id)],
  }));

  const enBase = await Appointment.findById(apt._id);
  assert.equal(enBase.serviceName, 'Ecografía');
  assert.deepEqual(nombres(enBase), [], 'quedarse con una sola línea es lo que se quiso hacer');
});

test('el nombre es un snapshot: renombrar el catálogo no reescribe la historia', async () => {
  const { clinicId, userId, eco, cerrada } = await seedCase();
  const apt = await cerrada();
  ok(await guardar(clinicId, userId, apt._id, { additionalServices: [String(eco._id)] }));

  await AppointmentServiceItem.findByIdAndUpdate(eco._id, { name: 'Ecografía obstétrica' });

  assert.deepEqual(
    nombres(await Appointment.findById(apt._id)),
    ['Ecografía'],
    'lo que se hizo ese día se llamaba así',
  );
});

test('reguardar sin cambios no mueve la fecha ni infla el contador de uso', async () => {
  const { clinicId, userId, eco, cerrada } = await seedCase();
  const apt = await cerrada();

  ok(await guardar(clinicId, userId, apt._id, { additionalServices: [String(eco._id)] }));
  const primera = (await Appointment.findById(apt._id)).additionalServices[0];
  const usoTrasAñadir = (await AppointmentServiceItem.findById(eco._id)).usageCount;

  // Otro usuario abre el modal, cambia solo el valor y guarda.
  const otro = await User.create({
    clinic: clinicId, name: 'Caja2', email: `caja${Date.now()}@t.com`, password: 'secret123', role: 'cajero',
  });
  ok(await guardar(clinicId, otro._id, apt._id, {
    additionalServices: [String(eco._id)],
    agreedValue: 45,
  }));

  const segunda = (await Appointment.findById(apt._id)).additionalServices[0];
  assert.equal(segunda.addedAt.getTime(), primera.addedAt.getTime(), 'la fecha es la del día en que se añadió');
  assert.equal(String(segunda.addedBy), String(userId), 'y el autor, quien lo añadió');
  assert.equal(
    (await AppointmentServiceItem.findById(eco._id)).usageCount,
    usoTrasAñadir,
    'ese contador ordena las sugerencias: reguardar no puede hacerlo subir',
  );
});

test('un servicio que ya no existe se rechaza sin guardar nada a medias', async () => {
  const { clinicId, userId, eco, cerrada } = await seedCase();
  const apt = await cerrada();
  const fantasma = String(new (require('mongoose').Types.ObjectId)());

  const r = await guardar(clinicId, userId, apt._id, {
    serviceItem: null,
    additionalServices: [String(eco._id), fantasma],
  });
  assert.equal(r.statusCode, 400);

  const enBase = await Appointment.findById(apt._id);
  assert.deepEqual(nombres(enBase), [], 'la ecografía buena tampoco entra: o todo o nada');
  assert.equal(enBase.serviceName, 'Consulta', 'y el servicio principal se queda como estaba');
});

test('sin mandar la lista, los adicionales que ya había se quedan', async () => {
  const { clinicId, userId, eco, cerrada } = await seedCase();
  const apt = await cerrada();
  ok(await guardar(clinicId, userId, apt._id, { additionalServices: [String(eco._id)] }));

  // Una pantalla vieja (o el modal de asignar) que solo manda el valor no puede
  // borrar de rebote lo que otro añadió.
  ok(await guardar(clinicId, userId, apt._id, { agreedValue: 30 }));

  assert.deepEqual(nombres(await Appointment.findById(apt._id)), ['Ecografía']);
});
