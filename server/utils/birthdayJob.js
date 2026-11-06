const Patient = require('../models/Patient');
const { emitDomainEvent, DOMAIN_EVENTS } = require('./events');

const EC_OFFSET_MS = 5 * 60 * 60 * 1000; // Ecuador UTC-5
const CADA_HORA = 60 * 60 * 1000;

const esBisiesto = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * Los (mes, día) que se celebran HOY en hora de Ecuador. Los nacidos el 29 de
 * febrero se saludan el 28 en los años que no son bisiestos (si no, nunca).
 * La fecha de nacimiento se guarda a medianoche UTC ('1990-05-10'), por eso se
 * compara con $month/$dayOfMonth en UTC.
 */
function diasQueSeCelebran(now = new Date()) {
  const ec = new Date(now.getTime() - EC_OFFSET_MS);
  const month = ec.getUTCMonth() + 1;
  const day = ec.getUTCDate();
  const dias = [{ month, day }];
  if (month === 2 && day === 28 && !esBisiesto(ec.getUTCFullYear())) dias.push({ month: 2, day: 29 });
  return { key: `${ec.getUTCFullYear()}-${month}-${day}`, dias };
}

/**
 * Emite patient.birthday para los pacientes que cumplen años HOY (en hora de
 * Ecuador). El motor de workflows decide si hay alguna automatización suscrita,
 * la inscribe una sola vez al día y la deja esperando a la «Hora de envío» del
 * disparador (ver `horaSaludoCumple` en workflowEngine).
 */
async function runBirthdayCheck(now = new Date()) {
  try {
    const { dias } = diasQueSeCelebran(now);
    const patients = await Patient.find({
      active: true,
      birthDate: { $ne: null },
      $expr: {
        $or: dias.map(({ month, day }) => ({
          $and: [
            { $eq: [{ $month: '$birthDate' }, month] },
            { $eq: [{ $dayOfMonth: '$birthDate' }, day] },
          ],
        })),
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

/**
 * Antes corría al arrancar y luego cada 24 h desde ese momento: el día lo marcaba
 * la hora del último reinicio. Ahora revisa cada hora y procesa UNA vez por día
 * (en cuanto cambia el día en Ecuador), y solo en el backend LÍDER (`only`), para
 * que dos servidores vivos no emitan los mismos cumpleaños.
 */
function startBirthdayJob(only = (fn) => fn) {
  let ultimoDia = null;
  const tick = only(async () => {
    const { key } = diasQueSeCelebran();
    if (key === ultimoDia) return;
    ultimoDia = key;
    await runBirthdayCheck();
  });
  setTimeout(tick, 0);
  setInterval(tick, CADA_HORA);
}

module.exports = { runBirthdayCheck, startBirthdayJob, diasQueSeCelebran };
