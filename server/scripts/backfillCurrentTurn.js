/**
 * Backfill: rellena `currentTurnKind` y `currentTurnUser` en las citas que ya
 * tienen turnos asignados.
 *
 * POR QUÉ HACE FALTA: la agenda del doctor pasó a filtrar por `currentTurnUser`
 * (el turno que tiene la pelota AHORA) en vez de por el espejo `doctor`. El
 * motivo es que con enfermería por delante el espejo ya apunta al doctor de
 * detrás —correcto para comisiones y reportes— y su cita se le anunciaba antes
 * de tiempo. La bandeja de enfermería filtra igual, por `currentTurnKind`.
 *
 * Las citas asignadas ANTES de este cambio tienen `turns[]` pero no esos dos
 * campos. Sin rellenarlos, en el primer arranque tras el despliegue el doctor
 * abre su agenda y su paciente NO ESTÁ, y a los enfermeros les desaparece la
 * bandeja: el filtro no encuentra por dónde entrar. Las citas sin turnos no se
 * tocan (esas siguen filtrando por el espejo, que es lo que tienen).
 *
 * Es idempotente: recalcula desde `turns[]`, que es la verdad. Correrlo dos
 * veces deja lo mismo.
 *
 *   node scripts/backfillCurrentTurn.js            (dry-run: cuenta y no escribe)
 *   node scripts/backfillCurrentTurn.js --commit   (escribe)
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Appointment = require('../models/Appointment');
const { sincronizarEspejo } = require('../utils/appointmentTurns');

async function run() {
  const opts = parseArgs();
  banner('Rellenar el turno vigente de las citas ya asignadas', opts);

  await connect();
  try {
    // Solo las que tienen turnos: el resto no usa estos campos.
    const citas = await Appointment.find({ 'turns.0': { $exists: true } }).select('turns doctor currentTurnKind currentTurnUser');
    console.log(`Citas con turnos: ${citas.length}`);

    let cambiadas = 0;
    for (const cita of citas) {
      const antesKind = cita.currentTurnKind || null;
      const antesUser = cita.currentTurnUser ? String(cita.currentTurnUser) : null;

      sincronizarEspejo(cita);

      const ahoraKind = cita.currentTurnKind || null;
      const ahoraUser = cita.currentTurnUser ? String(cita.currentTurnUser) : null;
      if (antesKind === ahoraKind && antesUser === ahoraUser) continue;

      cambiadas += 1;
      if (opts.commit) await cita.save();
    }

    console.log(
      opts.commit
        ? `Actualizadas: ${cambiadas}`
        : `Se actualizarían: ${cambiadas} (usa --commit para escribir)`
    );
  } finally {
    await disconnect();
  }
}

run().catch((err) => {
  console.error('Falló el relleno del turno vigente:', err.message);
  process.exit(1);
});
