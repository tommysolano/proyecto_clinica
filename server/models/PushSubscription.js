const mongoose = require('mongoose');

/**
 * Suscripción de notificaciones push de un navegador concreto.
 *
 * Una persona tiene tantas como aparatos use (el móvil, el de recepción, el de
 * casa). El `endpoint` que devuelve el navegador es la clave: es único por
 * aparato+navegador y es lo que hay que dar al servicio de push (FCM, Mozilla,
 * Apple) para llegar a él.
 *
 * Las suscripciones CADUCAN solas: si el usuario desinstala la app, limpia los
 * datos del sitio o el navegador la revoca, el envío responde 404/410 y hay que
 * borrarla (lo hace `utils/pushNotifications.js`). Por eso esto no es una lista
 * de "quién quiere recibir avisos" sino de "a qué aparatos podemos llegar hoy".
 */
const pushSubscriptionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Sucursal activa cuando se suscribió. Sirve para no mandar a un aparato
    // avisos de una sede en la que esa persona no trabaja.
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userAgent: { type: String, trim: true, default: '' },
    // Las llamadas entrantes solo deben despertar instalaciones reales de la
    // PWA. Los avisos normales siguen pudiendo llegar tambien al navegador.
    appMode: {
      type: String,
      enum: ['browser', 'standalone'],
      default: 'browser',
      index: true,
    },
    lastSuccessAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PushSubscription', pushSubscriptionSchema);
