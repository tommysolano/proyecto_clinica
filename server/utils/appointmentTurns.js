/**
 * TURNOS DE ATENCIÓN de una cita.
 *
 * Antes una cita tenía UN doctor. Ahora puede pasar por varios profesionales en
 * orden —y por enfermería— y solo queda 'completada' cuando el último termina.
 *
 * ESTE ARCHIVO ES EL ÚNICO QUE ESCRIBE `appointment.doctor`. Ese campo pasó a ser
 * un espejo del turno vigente porque hay una treintena de sitios (agenda,
 * dashboards del doctor, comisiones, reportes, sockets, recordatorios) que lo
 * leen como un escalar; mantenerlo sincronizado desde un solo sitio es lo que
 * permite añadir los turnos sin reescribir todo eso. Si alguien lo asigna por su
 * cuenta, el espejo y los turnos se separan y nadie se entera hasta que un
 * doctor deja de ver su cita.
 */

/** Turnos ordenados por su posición. */
function turnosOrdenados(apt) {
  return [...(apt.turns || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
}

/** Turno que tiene la pelota ahora mismo: el primero sin completar ni omitir. */
function turnoVigente(apt) {
  return turnosOrdenados(apt).find((t) => t.status === 'pendiente') || null;
}

/** ¿Ya terminaron todos los turnos? (una cita sin turnos NO cuenta como terminada) */
function turnosTerminados(apt) {
  const turns = apt.turns || [];
  if (!turns.length) return false;
  return turns.every((t) => t.status !== 'pendiente');
}

/**
 * Sincroniza el espejo `doctor` (+ su auditoría) con los turnos.
 *
 * Apunta al doctor del turno vigente; si ya no quedan turnos pendientes, se
 * queda con el ÚLTIMO doctor que atendió, para que la cita no pierda su médico
 * en el historial, las comisiones ni los reportes. Los turnos de enfermería no
 * tocan `doctor`: para eso está `attendedByNurse`.
 */
function sincronizarEspejo(apt) {
  const orden = turnosOrdenados(apt);
  const vigente = orden.find((t) => t.status === 'pendiente' && t.kind === 'doctor');
  const ultimoDoctor = [...orden].reverse().find((t) => t.kind === 'doctor' && t.user);
  const elegido = vigente && vigente.user ? vigente : ultimoDoctor;

  // Sin ningún turno de doctor no se pisa lo que hubiera: una cita solo de
  // enfermería no debe borrar el doctor de una cita vieja ya atendida.
  if (!elegido || !elegido.user) return apt;

  apt.doctor = elegido.user;
  apt.doctorAssignedAt = elegido.assignedAt || apt.doctorAssignedAt;
  apt.doctorAssignedBy = elegido.assignedBy || apt.doctorAssignedBy;
  return apt;
}

/**
 * Reemplaza los turnos de la cita por los indicados.
 *
 * `doctores` es un arreglo de ids EN EL ORDEN en que atenderán. `enfermeria`
 * añade al final un turno sin dueño, que sale a la bandeja de todos los
 * enfermeros hasta que uno lo reclame.
 *
 * Los turnos YA COMPLETADOS se conservan: reasignar a mitad de la atención no
 * puede borrar el trabajo del que ya atendió (ni su seguimiento).
 */
function asignarTurnos(apt, { doctores = [], enfermeria = false, por = null } = {}) {
  const completados = (apt.turns || []).filter((t) => t.status === 'completado');
  let order = completados.length;
  const nuevos = [];

  for (const user of doctores) {
    if (!user) continue;
    // Si ese profesional ya atendió su turno, no se le vuelve a poner en cola.
    if (completados.some((t) => String(t.user) === String(user))) continue;
    nuevos.push({
      kind: 'doctor',
      user,
      order: order++,
      status: 'pendiente',
      assignedAt: new Date(),
      assignedBy: por,
    });
  }

  if (enfermeria) {
    nuevos.push({
      kind: 'enfermeria',
      user: null,
      order: order++,
      status: 'pendiente',
      assignedAt: new Date(),
      assignedBy: por,
    });
  }

  apt.turns = [...completados, ...nuevos];
  sincronizarEspejo(apt);
  return apt;
}

/**
 * Cierra el turno de `userId` (o el vigente) y devuelve qué pasa después.
 *
 * Devuelve { cerrado, siguiente, terminado }. El llamador decide con eso si la
 * cita queda 'completada' o si solo cambia de manos.
 */
function completarTurno(apt, { userId, followUpId = null } = {}) {
  const orden = turnosOrdenados(apt);
  const cerrado =
    orden.find((t) => t.status === 'pendiente' && String(t.user) === String(userId)) ||
    // Un doctor que guarda un seguimiento sin turno propio (cita vieja, o
    // reasignada) cierra el turno vigente: es quien está atendiendo de hecho.
    orden.find((t) => t.status === 'pendiente') ||
    null;

  if (cerrado) {
    cerrado.status = 'completado';
    cerrado.completedAt = new Date();
    if (followUpId) cerrado.followUp = followUpId;
    if (!cerrado.user) cerrado.user = userId;
  }

  sincronizarEspejo(apt);
  return {
    cerrado,
    siguiente: turnoVigente(apt),
    terminado: turnosTerminados(apt),
  };
}

/** Turno de enfermería pendiente (el que sale a la bandeja de los enfermeros). */
function turnoEnfermeriaPendiente(apt) {
  return turnosOrdenados(apt).find((t) => t.kind === 'enfermeria' && t.status === 'pendiente') || null;
}

/** Ids de los doctores con turno pendiente (a quienes hay que avisar). */
function doctoresPendientes(apt) {
  return turnosOrdenados(apt)
    .filter((t) => t.kind === 'doctor' && t.status === 'pendiente' && t.user)
    .map((t) => String(t.user));
}

module.exports = {
  turnosOrdenados,
  turnoVigente,
  turnosTerminados,
  sincronizarEspejo,
  asignarTurnos,
  completarTurno,
  turnoEnfermeriaPendiente,
  doctoresPendientes,
};
