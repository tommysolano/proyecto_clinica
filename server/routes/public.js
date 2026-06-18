const router = require('express').Router();
const Patient = require('../models/Patient');
const booking = require('../controllers/bookingPublicController');
const review = require('../controllers/reviewController');
const emailTracking = require('../controllers/emailTrackingController');

// Endpoints públicos (sin auth). Hoy: baja de email + auto-agendamiento + reseñas.

// Auto-agendamiento público.
router.get('/booking/:token', booking.info);
router.get('/booking/:token/slots', booking.slots);
router.post('/booking/:token', booking.book);

// Reputación: página de calificación + envío.
router.get('/review/:token', review.publicInfo);
router.post('/review/:token', review.publicSubmit);

// Tracking de email (apertura + clic).
router.get('/email/open/:trackingId', emailTracking.open);
router.get('/email/click/:trackingId', emailTracking.click);

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
