const Patient = require('../models/Patient');
const { emitDomainEvent, DOMAIN_EVENTS } = require('./events');

const EC_OFFSET_MS = 5 * 60 * 60 * 1000; // Ecuador UTC-5

/**
 * Emite patient.birthday para los pacientes que cumplen años HOY (en hora de
 * Ecuador). El motor de workflows decide si hay alguna automatización suscrita.
 * El anti-duplicado de inscripciones evita reenrolar al mismo paciente.
 */
async function runBirthdayCheck() {
  try {
    const ec = new Date(Date.now() - EC_OFFSET_MS);
    const month = ec.getUTCMonth() + 1;
    const day = ec.getUTCDate();

    const patients = await Patient.find({
      active: true,
      birthDate: { $ne: null },
      $expr: {
        $and: [
          { $eq: [{ $month: '$birthDate' }, month] },
          { $eq: [{ $dayOfMonth: '$birthDate' }, day] },
        ],
      },
    }).select('clinic');

    for (const p of patients) {
      emitDomainEvent(DOMAIN_EVENTS.PATIENT_BIRTHDAY, {
        clinicId: String(p.clinic),
        patientId: String(p._id),
      });
    }
    if (patients.length) console.log(`[birthdayJob] ${patients.length} cumpleaños hoy.`);
    return patients.length;
  } catch (err) {
    console.error('[birthdayJob] error:', err.message);
    return 0;
  }
}

function startBirthdayJob() {
  runBirthdayCheck();
  setInterval(runBirthdayCheck, 24 * 60 * 60 * 1000);
}

module.exports = { runBirthdayCheck, startBirthdayJob };
