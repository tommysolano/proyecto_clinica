const spend = require('../utils/whatsappSpend');

/**
 * Gasto de WhatsApp (lo que Meta nos ha cobrado por los mensajes de plantilla).
 * Todas las cifras vienen de Meta; ver utils/whatsappSpend.js.
 */

/** Rango pedido, saneado. Por defecto, los últimos 30 días (en hora de Ecuador). */
function parseRange(query) {
  const today = spend.todayEc();
  const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const to = isYmd(query.to) ? query.to : today;
  const from = isYmd(query.from)
    ? query.from
    : spend.ecDate(spend.ecDayStartMs(to) - 29 * 24 * 60 * 60 * 1000);
  // Si vienen al revés, se ordenan en vez de devolver un rango vacío.
  return from <= to ? { from, to } : { from: to, to: from };
}

/**
 * GET /whatsapp-spend?from=&to=
 *
 * Devuelve lo ya sincronizado. Si el rango toca días RECIENTES (hoy o ayer) se
 * vuelve a pedir a Meta antes de responder: el día en curso está incompleto hasta
 * que cierra. Los días viejos no se re-piden (no cambian) para que la página abra
 * rápido y no se gasten llamadas a la API.
 */
exports.get = async (req, res) => {
  try {
    const { from, to } = parseRange(req.query);
    const today = spend.todayEc();
    const yesterday = spend.ecDate(spend.ecDayStartMs(today) - 24 * 60 * 60 * 1000);

    let syncError = '';
    if (to >= yesterday) {
      const fresh = await spend.syncSpend({ from: from > yesterday ? from : yesterday, to });
      if (!fresh.ok && fresh.reason !== 'not_configured') syncError = fresh.error || fresh.reason;
    }

    const data = await spend.readSpend({ from, to });
    const byTemplate = await spend.readByTemplate({ clinicId: req.clinicId, from, to });
    res.json({ ...data, byTemplate, syncError });
  } catch (err) {
    res.status(500).json({ message: 'Error al consultar el gasto de WhatsApp', error: err.message });
  }
};

/**
 * POST /whatsapp-spend/sync?from=&to=
 * Re-pregunta a Meta TODO el rango (botón "Actualizar desde Meta"). Es lo que hay
 * que usar para traer histórico la primera vez.
 */
exports.sync = async (req, res) => {
  try {
    const { from, to } = parseRange({ ...req.query, ...req.body });
    const r = await spend.syncSpend({ from, to });
    if (!r.ok) {
      if (r.reason === 'not_configured') return res.status(400).json({ message: r.error });
      return res.status(502).json({ message: 'Meta no devolvió el gasto', error: r.error });
    }
    res.json({ ...r, from, to });
  } catch (err) {
    res.status(500).json({ message: 'Error al sincronizar el gasto', error: err.message });
  }
};
