/**
 * Migra las fichas clínicas al esquema MSP HCU-form.002.
 *
 * Mueve los antecedentes en texto libre (legacy) al nuevo formato estructurado,
 * sin perder información y sin pisar datos ya migrados:
 *   - record.antecedentesPatologicos (personal)  -> record.datosRelevantes
 *   - record.antecedentesFamiliares  (familiar)  -> patologicosFamiliares[otro].detail
 *   - Como respaldo, si la ficha no tiene texto propio, usa el del Paciente
 *     (Patient.antecedentesPatologicos / antecedentesFamiliares).
 *
 *   node scripts/migrateClinicalRecordsMsp.js            (dry-run)
 *   node scripts/migrateClinicalRecordsMsp.js --commit   (aplica)
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');

async function main() {
  const opts = parseArgs();
  banner('Migración fichas → MSP HCU-form.002', opts);
  await connect();

  const filter = opts.clinic ? { clinic: opts.clinic } : {};
  const records = await ClinicalRecord.find(filter);
  console.log(`Fichas a revisar: ${records.length}\n`);

  let touched = 0;
  for (const rec of records) {
    // Idempotencia: si ya tiene antecedentes estructurados, no se toca.
    const yaMigrada =
      (rec.patologicosPersonales && rec.patologicosPersonales.length) ||
      (rec.patologicosFamiliares && rec.patologicosFamiliares.length) ||
      (rec.datosRelevantes && rec.datosRelevantes.trim());
    if (yaMigrada) continue;

    let patient = null;
    const personalTxt = (rec.antecedentesPatologicos || '').trim();
    const familiarTxt = (rec.antecedentesFamiliares || '').trim();
    let personal = personalTxt;
    let familiar = familiarTxt;

    if (!personal || !familiar) {
      patient = await Patient.findById(rec.patient).select('antecedentesPatologicos antecedentesFamiliares');
      if (!personal) personal = (patient?.antecedentesPatologicos || '').trim();
      if (!familiar) familiar = (patient?.antecedentesFamiliares || '').trim();
    }

    if (!personal && !familiar) continue;

    const changes = [];
    if (personal) {
      rec.datosRelevantes = personal;
      changes.push('datosRelevantes');
    }
    if (familiar) {
      rec.patologicosFamiliares = [{ key: 'otro', marked: true, detail: familiar }];
      changes.push('patologicosFamiliares[otro]');
    }

    console.log(`• Ficha ${rec._id} (paciente ${rec.patient}) → ${changes.join(', ')}`);
    touched++;
    if (opts.commit) await rec.save();
  }

  console.log(`\n${opts.commit ? 'Migradas' : 'Se migrarían'}: ${touched} fichas.`);
  await disconnect();
}

main().catch((e) => {
  console.error('Error en migración:', e);
  process.exit(1);
});
