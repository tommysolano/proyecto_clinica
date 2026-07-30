/**
 * Chequeo DIARIO del estado de las plantillas de WhatsApp.
 *
 * Ya existe un sondeo cada hora (TEMPLATE_SYNC_INTERVAL_MIN) más el webhook de
 * Meta, que avisan al instante. Este job es la garantía de que TODOS los días, a
 * una hora fija, alguien pregunta a Meta cómo están las plantillas — y, sobre
 * todo, de que si NO se pudo preguntar quede constancia visible: el peligro no es
 * solo que Meta recategorice una plantilla a MARKETING (más caro), es enterarse
 * un mes después.
 *
 * Corre solo en el backend LÍDER (ver instanceRegistry en index.js).
 */
const { resolveCallCenterClinicId } = require('./callCenterClinic');

const EC_OFFSET_MS = 5 * 60 * 60 * 1000; // Ecuador UTC-5, sin horario de verano
const DAY_MS = 24 * 60 * 60 * 1000;

// Hora (Ecuador) del chequeo diario. 8:00 = a primera hora, cuando alguien puede
// reaccionar; configurable por si conviene otra.
const CHECK_HOUR_EC = Math.min(Math.max(Number(process.env.TEMPLATE_DAILY_CHECK_HOUR) || 8, 0), 23);

/** Milisegundos hasta la próxima vez que sean las CHECK_HOUR_EC en Ecuador. */
function msUntilNextCheck(now = Date.now()) {
  const ec = new Date(now - EC_OFFSET_MS);
  const next = new Date(ec);
  next.setUTCHours(CHECK_HOUR_EC, 0, 0, 0);
  if (next.getTime() <= ec.getTime()) next.setTime(next.getTime() + DAY_MS);
  return next.getTime() - ec.getTime();
}

/**
 * ¿Ya se avisó de un fallo de verificación en las últimas 20 horas? Sin esta
 * guardia, un token caducado llenaría la campana de la misma notificación.
 */
async function alreadyWarned(clinicId) {
  const Notification = require('../models/Notification');
  const since = new Date(Date.now() - 20 * 60 * 60 * 1000);
  return !!(await Notification.exists({
    clinic: clinicId,
    type: 'template_check_failed',
    createdAt: { $gte: since },
  }));
}

/**
 * Verifica las plantillas contra Meta. Los cambios de categoría/estado los
 * notifica la propia sincronización (una alerta por plantilla); aquí solo se
 * añade el aviso de "no se pudo verificar".
 */
async function runDailyTemplateCheck() {
  const templates = require('../controllers/messageTemplateController');
  try {
    const clinicId = await resolveCallCenterClinicId();
    if (!clinicId) return { ok: false, reason: 'no_clinic' };

    const result = await templates.syncTemplatesFromMeta(clinicId);

    if (!result.ok) {
      // 'not_configured' = todavía no hay número Cloud API conectado: no es una
      // avería que deba molestar cada día al usuario.
      if (result.reason !== 'not_configured' && !(await alreadyWarned(clinicId))) {
        await templates.raiseTemplateAlert(clinicId, {
          type: 'template_check_failed',
          severity: 'warning',
          title: 'No se pudo verificar el estado de las plantillas',
          body: `Meta no respondió a la revisión diaria: ${result.error || result.reason}. Revisa el token de WhatsApp en Configuración del Call Center.`,
          meta: { reason: result.reason || '', error: result.error || '' },
        });
      }
      console.warn(`[templateDailyCheck] no se pudo verificar: ${result.reason} ${result.error || ''}`);
      return result;
    }

    console.log(
      `[templateDailyCheck] ${result.synced} plantillas verificadas` +
        (result.alerts ? ` — ${result.alerts} cambio(s) detectado(s)` : '')
    );
    return result;
  } catch (err) {
    console.error('[templateDailyCheck] error:', err.message);
    return { ok: false, reason: 'exception', error: err.message };
  }
}

/**
 * Programa el chequeo a la hora fijada y luego una vez al día. `wrap` es
 * `registry.leaderOnly`: si este proceso deja de ser el líder, el chequeo no
 * dispara (dos backends verificando a la vez duplicarían las notificaciones).
 */
function startDailyTemplateCheckJob(wrap = (fn) => fn) {
  const run = wrap(() => { runDailyTemplateCheck().catch(() => {}); });
  setTimeout(() => {
    run();
    setInterval(run, DAY_MS);
  }, msUntilNextCheck());
}

module.exports = { runDailyTemplateCheck, startDailyTemplateCheckJob, msUntilNextCheck, CHECK_HOUR_EC };
