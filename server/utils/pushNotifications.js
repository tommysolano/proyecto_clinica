/**
 * NOTIFICACIONES PUSH (Web Push) + bandeja de la campana.
 *
 * Cuando recepción asigna una cita, el doctor casi nunca está mirando la
 * pantalla: está en consulta, con el móvil en el bolsillo. El socket solo llega
 * a las pestañas abiertas, así que hace falta push de verdad — el aviso que
 * suena en el teléfono aunque la app esté cerrada. Es lo que la PWA instalada
 * hace posible (ver client/public/sw.js).
 *
 * LAS CLAVES VAPID SE GENERAN SOLAS Y SE GUARDAN EN LA BASE.
 * Web Push exige un par de claves que identifique al servidor. Podrían ir en el
 * .env, pero eso obliga a entrar al VPS a ponerlas antes de que la función sirva
 * de algo, y a repetirlo en cada entorno. Aquí se generan la primera vez y se
 * guardan en `settings`: el día del despliegue funciona solo. Si algún día se
 * quieren fijar por entorno, VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY mandan.
 *
 * OJO: cambiar las claves INVALIDA todas las suscripciones existentes (los
 * navegadores tendrían que volver a suscribirse). Por eso, una vez generadas, no
 * se regeneran nunca.
 */
const webpush = require('web-push');
const Notification = require('../models/Notification');
const PushSubscription = require('../models/PushSubscription');
const User = require('../models/User');
const { emitToUser, emitToRole } = require('../realtime');
const { ownerIdOf, restrictionIsActive } = require('./workflowChatRestriction');

const CLAVE_AJUSTE = 'webpush_vapid';
// Sin correo de contacto los servicios de push pueden rechazar el envío.
const CONTACTO = process.env.VAPID_SUBJECT || 'mailto:soporte@shiluvecuador.com';

let vapidCache = null;

/** Colección `settings` genérica: un documento por clave. */
async function coleccionAjustes() {
  const mongoose = require('mongoose');
  return mongoose.connection.collection('settings');
}

/** Par de claves VAPID, generándolo la primera vez. `null` si no se puede. */
async function obtenerVapid() {
  if (vapidCache) return vapidCache;

  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapidCache = {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    };
    return vapidCache;
  }

  try {
    const settings = await coleccionAjustes();
    const guardado = await settings.findOne({ key: CLAVE_AJUSTE });
    if (guardado?.value?.publicKey && guardado?.value?.privateKey) {
      vapidCache = guardado.value;
      return vapidCache;
    }
    const generado = webpush.generateVAPIDKeys();
    // upsert: si dos procesos arrancan a la vez, gana uno y el otro lee el suyo.
    await settings.updateOne(
      { key: CLAVE_AJUSTE },
      { $setOnInsert: { key: CLAVE_AJUSTE, value: generado, createdAt: new Date() } },
      { upsert: true }
    );
    const final = await settings.findOne({ key: CLAVE_AJUSTE });
    vapidCache = final?.value || generado;
    return vapidCache;
  } catch (err) {
    console.warn('[push] no se pudieron obtener las claves VAPID:', err.message);
    return null;
  }
}

/** Clave pública que el navegador necesita para suscribirse. */
async function clavePublica() {
  const vapid = await obtenerVapid();
  return vapid?.publicKey || null;
}

/** Envía a UNA suscripción. Borra la suscripción si el navegador ya no existe. */
async function enviarASuscripcion(sub, payload, options = {}) {
  const vapid = await obtenerVapid();
  if (!vapid) return false;
  webpush.setVapidDetails(CONTACTO, vapid.publicKey, vapid.privateKey);
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
      JSON.stringify(payload),
      options
    );
    await PushSubscription.updateOne({ _id: sub._id }, { lastSuccessAt: new Date() });
    return true;
  } catch (err) {
    // 404/410: el navegador desinstaló la app o revocó el permiso. La
    // suscripción está muerta y reintentarla solo gasta; se borra.
    if (err.statusCode === 404 || err.statusCode === 410) {
      await PushSubscription.deleteOne({ _id: sub._id }).catch(() => {});
      return false;
    }
    console.warn('[push] envío fallido (%s): %s', err.statusCode || '?', err.message);
    return false;
  }
}

/**
 * Usuarios que pueden ver una llamada entrante del CRM.
 *
 * Es el espejo del reparto de `emitToCallCenter`: marketing y super-admin son
 * supervisores; call center respeta la reserva temporal de los workflows. El
 * rol admin comun se excluye expresamente.
 */
async function usuariosParaLlamada(conversation) {
  const [supervisores, agentes] = await Promise.all([
    User.find({
      active: { $ne: false },
      $or: [
        { isSuperAdmin: true },
        { clinics: { $elemMatch: { role: 'marketing' } } },
      ],
    }).select('_id').lean(),
    User.find({
      active: { $ne: false },
      clinics: { $elemMatch: { role: 'call_center' } },
    }).select('_id').lean(),
  ]);

  const supervisorIds = supervisores.map((u) => String(u._id));
  const owner = String(ownerIdOf(conversation) || '');
  let agentIds = agentes.map((u) => String(u._id));
  if (owner && restrictionIsActive(conversation)) {
    agentIds = agentIds.filter((id) => id === owner);
  } else if (owner) {
    agentIds = agentIds.filter((id) => id !== owner);
  }
  return [...new Set([...supervisorIds, ...agentIds])];
}

/** Timbre efimero de llamada para las PWA instaladas. */
async function notificarLlamadaEntrante({ callId, conversation, contactName, phone }) {
  const ids = await usuariosParaLlamada(conversation);
  if (!ids.length) return { users: 0, subscriptions: 0, sent: 0 };

  const subs = await PushSubscription.find({
    user: { $in: ids },
    appMode: 'standalone',
  }).lean();
  if (!subs.length) return { users: ids.length, subscriptions: 0, sent: 0 };

  const caller = String(contactName || phone || 'un contacto').trim().slice(0, 80);
  const conversationId = conversation?._id || conversation;
  const baseUrl = `/chats?chat=${encodeURIComponent(String(conversationId || ''))}`;
  const encodedCallId = encodeURIComponent(String(callId || ''));
  const payload = {
    type: 'whatsapp_incoming_call',
    callId: String(callId || ''),
    title: `Llamada de ${caller}`,
    body: 'Llamada entrante de WhatsApp. Toca para abrir el CRM.',
    // Tocar el cuerpo muestra el panel; el boton Contestar lleva la intencion
    // explicita para que el cliente construya el WebRTC al abrirse.
    url: `${baseUrl}&incomingCall=${encodedCallId}`,
    answerUrl: `${baseUrl}&answerCall=${encodedCallId}`,
    tag: `whatsapp-call-${String(callId || conversationId || '').slice(-40)}`,
    timestamp: Date.now(),
  };
  const results = await Promise.all(
    subs.map((sub) => enviarASuscripcion(sub, payload, { TTL: 70, urgency: 'high' }))
  );
  return {
    users: ids.length,
    subscriptions: subs.length,
    sent: results.filter(Boolean).length,
  };
}

/**
 * Avisa a una lista de usuarios: campana + socket + push al móvil.
 *
 * Los tres canales son a propósito: la campana deja constancia (se puede mirar
 * más tarde), el socket refresca al instante la pestaña abierta, y el push llega
 * al teléfono. Que falle uno no impide los otros.
 */
async function notificarUsuarios(userIds, { clinicId, type, title, body, url, meta = {} }) {
  // Un id puede llegar poblado (el usuario entero) desde una cita con populate.
  // `String(documento)` daría "{ _id: ..., name: 'Ana' }" y Mongo rechazaría el
  // lote ENTERO: se perdía la notificación de todos por culpa de uno.
  const ids = [
    ...new Set(
      (userIds || [])
        .map((u) => (u && typeof u === 'object' && u._id ? String(u._id) : u ? String(u) : null))
        .filter((u) => /^[0-9a-fA-F]{24}$/.test(u || ''))
    ),
  ];
  if (!ids.length) return;

  await Notification.create(
    ids.map((user) => ({
      clinic: clinicId,
      user,
      type,
      title,
      body,
      meta: { ...meta, url },
    }))
  ).catch((err) => console.warn('[push] no se pudo guardar en la campana:', err.message));

  for (const id of ids) {
    emitToUser(id, 'notification:new', { type, title, body, url });
  }

  const subs = await PushSubscription.find({ user: { $in: ids } }).lean();
  await Promise.all(subs.map((s) => enviarASuscripcion(s, { title, body, url, type })));
}

/** Igual, pero a todos los usuarios con un rol en esa sucursal (enfermería). */
async function notificarRol(clinicId, role, datos) {
  // `enSucursal` monta el $elemMatch (y no dos condiciones sueltas: sin él, mongo
  // daría por bueno a quien es enfermero en OTRA sucursal y además tiene un rol
  // cualquiera en esta) e incluye a quien trabaja en todas las sedes — que si
  // puede atender aquí, tiene que enterarse de que hay alguien esperando.
  const usuarios = await User.find({
    ...User.enSucursal(clinicId, role),
    active: { $ne: false },
  })
    .select('_id worksInAllClinics activeClinicId')
    .lean();
  /**
   * ENFERMERÍA SOLO SE ENTERA DE SU SEDE (sep-2026).
   *
   * «Trabaja en todas las sucursales» ya no significa «le suena el móvil de
   * todas»: significa que atiende HOY en la que eligió al entrar
   * (`User.activeClinicId`, escrita en /auth/select-clinic). Enviarle avisos de
   * las demás era la mitad de la campana llena de citas que no podía ver — la
   * agenda de enfermería está filtrada por su sede activa, y un aviso de una
   * cita que no sale en su lista solo genera confusión.
   *
   * Al resto de roles no le cambia nada: el doctor que rota entre sedes sigue
   * enterándose de todo, que es lo que ese check prometía.
   */
  const ids = usuarios
    .filter(
      (u) =>
        role !== 'enfermero' ||
        !u.worksInAllClinics ||
        String(u.activeClinicId || '') === String(clinicId)
    )
    .map((u) => u._id);
  emitToRole(clinicId, role, 'notification:new', { ...datos });
  await notificarUsuarios(ids, { ...datos, clinicId });
}

module.exports = {
  clavePublica,
  notificarUsuarios,
  notificarRol,
  notificarLlamadaEntrante,
  usuariosParaLlamada,
};
