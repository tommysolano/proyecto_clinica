const Treatment = require('../models/Treatment');
const { emitDomainEvent, DOMAIN_EVENTS } = require('./events');

/**
 * Abandono automático de tratamientos: si un tratamiento activo supera su umbral
 * de días sin actividad, pasa a 'abandonado' y se emite el evento de dominio
 * (dispara los workflows con trigger 'treatment_abandoned').
 *
 * Antes esta lógica vivía duplicada en treatmentController y
 * treatmentRemindersController y SOLO corría cuando alguien abría esas páginas:
 * si nadie entraba a Tratamientos, el trigger jamás disparaba. El job periódico
 * (startTreatmentAbandonmentJob) lo garantiza aunque nadie visite la página.
 */
async function applyAbandonment(treatments) {
  const now = Date.now();
  for (const t of treatments) {
    if (t.status !== 'activo') continue;
    const ref = t.lastActivityAt || t.startDate || t.createdAt;
    if (!ref) continue;
    const days = Math.floor((now - new Date(ref).getTime()) / 86400000);
    const limit = t.inactivityDaysToAbandon || 30;
    if (days >= limit) {
      t.status = 'abandonado';
      t.abandonedAt = new Date();
      // eslint-disable-next-line no-await-in-loop
      await t.save();
      emitDomainEvent(DOMAIN_EVENTS.TREATMENT_ABANDONED, {
        clinicId: String(t.clinic),
        patientId: t.patient ? String(t.patient._id || t.patient) : null,
        treatmentId: String(t._id),
        services: (t.items || []).map((it) => String(it.product?._id || it.product)).filter(Boolean),
      });
    }
  }
}

/** Barrido global (todas las clínicas): revisa los tratamientos activos. */
async function runAbandonmentSweep() {
  try {
    const treatments = await Treatment.find({ status: 'activo' });
    await applyAbandonment(treatments);
    return treatments.length;
  } catch (err) {
    console.error('[treatmentAbandonment] error:', err.message);
    return 0;
  }
}

/** Arranca el job: corre al inicio y luego cada 12 horas. */
function startTreatmentAbandonmentJob() {
  runAbandonmentSweep();
  setInterval(runAbandonmentSweep, 12 * 60 * 60 * 1000);
}

module.exports = { applyAbandonment, runAbandonmentSweep, startTreatmentAbandonmentJob };
