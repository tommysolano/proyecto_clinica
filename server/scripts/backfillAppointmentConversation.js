/**
 * Backfill: vincula las citas ANTIGUAS con el chat del que nacieron
 * (Appointment.conversation), para que el panel de Supervisión pueda contarlas.
 *
 * POR QUÉ HACE FALTA: el campo `conversation` se añadió cuando el panel empezó a
 * medir "citas creadas desde el chat". Las citas anteriores no lo guardaban, así
 * que el panel las cuenta como 0 aunque se agendaran desde el CRM.
 *
 * EL PROBLEMA: en el histórico no hay una marca infalible de "esta cita nació en
 * el chat". Se usan dos criterios, de más a menos fiable:
 *
 *   1) SEGURO — el motivo es el automático que ponía el backend cuando el agente
 *      dejaba el motivo en blanco: "Cita desde chat <teléfono>". El teléfono
 *      identifica la conversación exacta. Sin ambigüedad.
 *   2) PROBABLE (--por-paciente) — la cita es de un paciente que tiene UN chat, y
 *      la creó el mismo usuario. Recupera las citas en las que el agente sí
 *      escribió un motivo, pero puede colar alguna agendada desde la página de
 *      Citas para un paciente que además tiene chat. Es una suposición: se activa
 *      a mano y se informa aparte.
 *
 * El dry-run no escribe: enseña cuántas encajan por cada criterio para decidir.
 *
 *   node scripts/backfillAppointmentConversation.js                        (dry-run: informe)
 *   node scripts/backfillAppointmentConversation.js --commit               (solo las SEGURAS)
 *   node scripts/backfillAppointmentConversation.js --por-paciente --commit (también las probables)
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Appointment = require('../models/Appointment');
const Conversation = require('../models/Conversation');

// El motivo automático que ponía createAppointmentFromChat sin motivo del agente.
const AUTO_REASON = /^Cita desde chat (\d+)$/;

async function run() {
  const opts = parseArgs();
  const byPatient = process.argv.includes('--por-paciente');
  banner('Vincular citas antiguas con su chat de origen', opts);

  await connect();
  try {
    const pending = await Appointment.find({
      $or: [{ conversation: null }, { conversation: { $exists: false } }],
    })
      .select('_id patient reason createdBy createdAt')
      .lean();

    console.log(`Citas sin chat de origen: ${pending.length}`);
    if (!pending.length) return;

    // ── Criterio 1: el teléfono va dentro del motivo automático ──
    const convByPhone = new Map();
    for (const c of await Conversation.find({ channel: 'whatsapp' }).select('_id phone').lean()) {
      convByPhone.set(String(c.phone), c._id);
    }

    const sure = [];
    const rest = [];
    for (const a of pending) {
      const m = AUTO_REASON.exec(String(a.reason || '').trim());
      const convId = m ? convByPhone.get(m[1]) : null;
      if (convId) sure.push({ appointment: a._id, conversation: convId });
      else rest.push(a);
    }
    console.log(`  · SEGURAS  (motivo "Cita desde chat <tel>"): ${sure.length}`);

    // ── Criterio 2: el paciente tiene UN solo chat ──
    const probable = [];
    const ambiguous = [];
    if (rest.length) {
      const patientIds = [...new Set(rest.map((a) => String(a.patient)).filter(Boolean))];
      const convs = await Conversation.find({ patient: { $in: patientIds } })
        .select('_id patient')
        .lean();
      const byPatient2 = new Map();
      for (const c of convs) {
        const k = String(c.patient);
        if (!byPatient2.has(k)) byPatient2.set(k, []);
        byPatient2.get(k).push(c._id);
      }
      for (const a of rest) {
        const list = byPatient2.get(String(a.patient)) || [];
        if (list.length === 1) probable.push({ appointment: a._id, conversation: list[0] });
        else if (list.length > 1) ambiguous.push(a);
      }
    }
    console.log(`  · PROBABLES (el paciente tiene un único chat):  ${probable.length}`);
    console.log(`  · Con varios chats (no se tocan):               ${ambiguous.length}`);
    console.log(`  · Sin chat del paciente (no vienen del CRM):    ${rest.length - probable.length - ambiguous.length}`);

    const toApply = byPatient ? [...sure, ...probable] : sure;
    console.log(`\nSe vincularían: ${toApply.length} cita(s)${byPatient ? ' (SEGURAS + PROBABLES)' : ' (solo SEGURAS)'}`);
    if (!byPatient && probable.length) {
      console.log('Para incluir también las probables, repite con --por-paciente.');
    }

    if (opts.dryRun) {
      console.log('\nDry-run: no se escribió nada. Repite con --commit para aplicar.');
      return;
    }
    if (!toApply.length) return;

    const ops = toApply.map((x) => ({
      updateOne: { filter: { _id: x.appointment }, update: { $set: { conversation: x.conversation } } },
    }));
    const r = await Appointment.bulkWrite(ops);
    console.log(`\nListo: ${r.modifiedCount} cita(s) vinculadas a su chat.`);
  } finally {
    await disconnect();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
