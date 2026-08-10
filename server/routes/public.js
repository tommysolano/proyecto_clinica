const router = require('express').Router();
const Patient = require('../models/Patient');
const booking = require('../controllers/bookingPublicController');
const review = require('../controllers/reviewController');
const emailTracking = require('../controllers/emailTrackingController');
const media = require('../controllers/mediaController');

// Endpoints públicos (sin auth). Hoy: baja de email + auto-agendamiento + reseñas + media.

// Media autoalojada (imágenes de cabecera de plantilla, adjuntos del chat…).
router.get('/media/:id', media.serve);
// Adjunto que todavía vive dentro del mensaje (anterior a la migración de media).
router.get('/message-media/:messageId', media.serveMessageMedia);

// Auto-agendamiento público.
router.get('/booking/:token', booking.info);
router.get('/booking/:token/slots', booking.slots);
router.get('/booking/:token/lookup/:id', booking.lookup);
router.get('/booking/:token/email', booking.emailLookup);
router.post('/booking/:token', booking.book);

// Reputación: página de calificación + envío.
router.get('/review/:token', review.publicInfo);
router.post('/review/:token', review.publicSubmit);

// Tracking de email (apertura + clic).
router.get('/email/open/:trackingId', emailTracking.open);
router.get('/email/click/:trackingId', emailTracking.click);

// Botones CTA de workflows. El GET NO ejecuta la acción: WhatsApp y otros
// servicios visitan enlaces para generar previews y eso parecería un clic real.
// El navegador del usuario hace un POST al abrir la página y solo ahí se avanza.
router.get('/workflow-buttons/:token', (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[a-f0-9]{48}$/i.test(token)) {
    return res.status(404).send(page('Enlace no disponible', 'Este botón no es válido.'));
  }
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  return res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Abriendo…</title></head><body style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;color:#222"><p>Abriendo…</p><form id="go" method="post" action="/api/public/workflow-buttons/${token}/click"><button type="submit">Continuar</button></form><script>document.getElementById('go').submit()</script></body></html>`);
});

router.post('/workflow-buttons/:token/click', async (req, res) => {
  try {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const result = await require('../utils/workflowEngine').resumeOnButtonClick(req.params.token);
    if (!result.found || !result.destination) {
      return res.status(404).send(page('Enlace no disponible', 'Este botón ya no está disponible o el enlace no es válido.'));
    }
    return res.redirect(302, result.destination);
  } catch (err) {
    console.error('[workflow button] click error', err.message);
    return res.status(500).send(page('No se pudo abrir', 'Inténtalo de nuevo en unos segundos.'));
  }
});

const page = (title, msg) =>
  `<!doctype html><html lang="es"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title></head><body style="font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center;color:#222"><h2>${title}</h2><p>${msg}</p></body></html>`;

router.get('/unsubscribe/:patientId', async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.patientId);
    if (!patient) {
      return res.status(404).send(page('No encontrado', 'No pudimos procesar tu solicitud.'));
    }
    patient.marketing = {
      ...(patient.marketing?.toObject ? patient.marketing.toObject() : patient.marketing || {}),
      emailOptIn: false,
      optOutAt: patient.marketing?.optOutAt || new Date(),
      optOutReason: 'unsubscribe_email',
    };
    await patient.save();
    res.send(page('Baja confirmada', 'No volverás a recibir correos promocionales nuestros.'));
  } catch (err) {
    res.status(500).send(page('Error', 'Inténtalo de nuevo más tarde.'));
  }
});

module.exports = router;
