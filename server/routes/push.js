const router = require('express').Router();
const { auth, requireClinic } = require('../middleware/auth');
const PushSubscription = require('../models/PushSubscription');
const { clavePublica, notificarUsuarios } = require('../utils/pushNotifications');

/**
 * Alta y baja de notificaciones push del navegador.
 *
 * Cualquier usuario con sesión: quién recibe QUÉ se decide al enviar (ver
 * utils/pushNotifications.js), no aquí. Un doctor y un enfermero se suscriben
 * igual; lo que cambia es qué avisos les llegan.
 */
router.use(auth, requireClinic);

// GET /push/public-key → la clave que el navegador necesita para suscribirse.
router.get('/public-key', async (_req, res) => {
  const key = await clavePublica();
  if (!key) return res.status(503).json({ message: 'Las notificaciones push no están disponibles' });
  res.json({ publicKey: key });
});

// POST /push/subscribe — el navegador entrega su endpoint y sus claves.
router.post('/subscribe', async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ message: 'Suscripción incompleta' });
    }
    // Por endpoint, no por usuario: el mismo aparato puede cambiar de manos (el
    // ordenador de recepción), y entonces la suscripción pasa a ser del nuevo.
    const sub = await PushSubscription.findOneAndUpdate(
      { endpoint },
      {
        endpoint,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
        user: req.user._id,
        clinic: req.clinicId,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
      },
      { new: true, upsert: true }
    );
    res.status(201).json({ ok: true, id: sub._id });
  } catch (error) {
    res.status(500).json({ message: 'No se pudo registrar el aparato', error: error.message });
  }
});

/**
 * POST /push/test — un aviso de prueba a los aparatos del propio usuario.
 *
 * Sin esto, activar las notificaciones es un acto de fe: el doctor le da al
 * botón, no pasa nada visible, y no hay forma de saber si fallará justo el día
 * que le asignen un paciente. Solo se manda a UNO MISMO.
 */
router.post('/test', async (req, res) => {
  try {
    const subs = await PushSubscription.countDocuments({ user: req.user._id });
    if (!subs) return res.status(409).json({ message: 'Este aparato todavía no está registrado' });
    await notificarUsuarios([req.user._id], {
      clinicId: req.clinicId,
      type: 'push_test',
      title: 'Prueba de notificaciones',
      body: 'Si ves esto, los avisos de citas te van a llegar.',
      url: '/',
    });
    res.json({ ok: true, dispositivos: subs });
  } catch (error) {
    res.status(500).json({ message: 'No se pudo enviar la prueba', error: error.message });
  }
});

// POST /push/unsubscribe — al revocar el permiso o cerrar sesión.
router.post('/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (endpoint) await PushSubscription.deleteOne({ endpoint });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: 'Error al dar de baja', error: error.message });
  }
});

module.exports = router;
