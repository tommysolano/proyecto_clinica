/**
 * Push de los avisos de atención (oct-2026): prioridad ALTA, caducidad de una
 * hora y una etiqueta POR CITA. Ver `entregaDelAviso` en utils/pushNotifications.
 *
 * Sin esto, Android en reposo y el iPhone retrasaban los avisos hasta desbloquear
 * el teléfono, y cada «Cita para enfermería» borraba al anterior de la bandeja.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const webpush = require('web-push');
const PushSubscription = require('../models/PushSubscription');

const keys = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = keys.publicKey;
process.env.VAPID_PRIVATE_KEY = keys.privateKey;

const { notificarUsuarios } = require('../utils/pushNotifications');

const enviados = [];
const original = webpush.sendNotification;

test.before(async () => {
  await H.startDb();
  webpush.sendNotification = async (sub, payload, options) => {
    enviados.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), options });
    return { statusCode: 201 };
  };
});
test.after(async () => {
  webpush.sendNotification = original;
  await H.stopDb();
});
test.beforeEach(async () => {
  await H.resetDb();
  enviados.length = 0;
});

async function suscribir(user) {
  await PushSubscription.create({
    user,
    clinic: new H.mongoose.Types.ObjectId(),
    endpoint: `https://fcm.googleapis.com/fcm/send/${user}`,
    keys: { p256dh: 'p', auth: 'a' },
  });
}

test('los avisos de cita van con prioridad alta, TTL de 1 h y etiqueta de la cita', async () => {
  const enfermera = new H.mongoose.Types.ObjectId();
  await suscribir(enfermera);
  const citaA = new H.mongoose.Types.ObjectId();
  const citaB = new H.mongoose.Types.ObjectId();

  for (const cita of [citaA, citaB]) {
    await notificarUsuarios([enfermera], {
      clinicId: new H.mongoose.Types.ObjectId(),
      type: 'appointment_nursing',
      title: 'Cita para enfermería',
      body: 'ANA PÉREZ · Suero',
      url: `/appointments?cita=${cita}`,
      meta: { appointment: cita },
    });
  }

  assert.equal(enviados.length, 2);
  for (const e of enviados) {
    assert.equal(e.options.urgency, 'high');
    assert.equal(e.options.TTL, 3600);
    assert.equal(e.payload.type, 'appointment_nursing');
    assert.ok(e.payload.timestamp);
  }
  // Dos pacientes = dos etiquetas: el segundo aviso ya no borra al primero.
  assert.equal(enviados[0].payload.tag, `cita-${citaA}`);
  assert.equal(enviados[1].payload.tag, `cita-${citaB}`);
});

test('«Te toca atender» de la misma cita reemplaza al aviso anterior (misma etiqueta)', async () => {
  const doctor = new H.mongoose.Types.ObjectId();
  await suscribir(doctor);
  const cita = new H.mongoose.Types.ObjectId();
  for (const title of ['Cita asignada', 'Te toca atender']) {
    await notificarUsuarios([doctor], {
      clinicId: new H.mongoose.Types.ObjectId(),
      type: 'appointment_assigned',
      title,
      body: 'x',
      url: '/patients/1',
      meta: { appointment: cita },
    });
  }
  assert.deepEqual(enviados.map((e) => e.payload.tag), [`cita-${cita}`, `cita-${cita}`]);
});

test('cita SIN enfermero asignado (aviso a todo el rol): también prioridad alta y etiqueta de la cita', async () => {
  const User = require('../models/User');
  const { notificarRol } = require('../utils/pushNotifications');
  const clinicId = new H.mongoose.Types.ObjectId();
  const crear = (name) => User.create({ name, email: `${name}@t.com`, password: 'secreto123', clinics: [{ clinic: clinicId, role: 'enfermero' }] });
  const [a, b] = [await crear('enfa'), await crear('enfb')];
  await suscribir(a._id);
  await suscribir(b._id);
  const cita = new H.mongoose.Types.ObjectId();

  await notificarRol(clinicId, 'enfermero', {
    type: 'appointment_nursing',
    title: 'Cita para enfermería',
    body: 'ANA PÉREZ · Suero',
    url: `/appointments?cita=${cita}`,
    meta: { appointment: cita },
  });

  assert.equal(enviados.length, 2, 'les llega a las dos enfermeras');
  for (const e of enviados) {
    assert.equal(e.options.urgency, 'high');
    assert.equal(e.options.TTL, 3600);
    assert.equal(e.payload.tag, `cita-${cita}`);
  }
});

test('los demás avisos no cambian: sin prioridad forzada ni etiqueta de cita', async () => {
  const u = new H.mongoose.Types.ObjectId();
  await suscribir(u);
  await notificarUsuarios([u], {
    clinicId: new H.mongoose.Types.ObjectId(),
    type: 'social_post_failed',
    title: 'No se pudo publicar',
    body: 'x',
    url: '/social',
  });
  assert.equal(enviados.length, 1);
  assert.deepEqual(enviados[0].options, {});
  assert.equal(enviados[0].payload.tag, undefined);
});
