const EmailSend = require('../models/EmailSend');
const Campaign = require('../models/Campaign');

// GIF transparente 1x1 para el pixel de apertura.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function sendPixel(res) {
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.send(PIXEL);
}

// GET /api/public/email/open/:trackingId  → registra apertura, devuelve pixel.
exports.open = async (req, res) => {
  try {
    const es = await EmailSend.findOne({ trackingId: req.params.trackingId });
    if (es && !es.openedAt) {
      es.openedAt = new Date();
      if (es.status === 'sent') es.status = 'opened';
      await es.save();
      if (es.campaign) {
        await Campaign.updateOne({ _id: es.campaign }, { $inc: { 'stats.opened': 1 } }).catch(() => {});
      }
    }
  } catch {
    /* nunca romper la carga del email */
  }
  sendPixel(res);
};

// GET /api/public/email/click/:trackingId?u=<url>  → registra clic, redirige.
exports.click = async (req, res) => {
  const target = String(req.query.u || '');
  const safe = /^https?:\/\//i.test(target) ? target : '/';
  try {
    const es = await EmailSend.findOne({ trackingId: req.params.trackingId });
    if (es) {
      const firstClick = !es.clickedAt;
      es.clickedAt = new Date();
      es.status = 'clicked';
      if (!es.openedAt) es.openedAt = new Date();
      await es.save();
      if (es.campaign && firstClick) {
        await Campaign.updateOne({ _id: es.campaign }, { $inc: { 'stats.clicked': 1 } }).catch(() => {});
      }
    }
  } catch {
    /* ignorar y redirigir igual */
  }
  res.redirect(safe);
};
