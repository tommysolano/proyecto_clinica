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

  // Clase del turno que tiene la pelota: de esto depende que la cita salga (o no)
  // en la bandeja de enfermería. Se guarda porque no se puede consultar el
  // "primer pendiente" de un arreglo desde una query.
  const enCurso = orden.find((t) => t.status === 'pendiente');
  apt.currentTurnKind = enCurso ? enCurso.kind : null;
  // Y QUIÉN lo tiene. No vale el espejo `doctor` para esto: si enfermería va
  // delante, el espejo ya apunta al doctor de detrás (es su cita, y así la leen
  // las comisiones y los reportes), pero en su agenda todavía no debe salir.
  apt.currentTurnUser = enCurso && enCurso.kind === 'doctor' ? enCurso.user || null : null;

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
function asignarTurnos(apt, { doctores = [], enfermeria = false, pasos = null, por = null } = {}) {
  /**
   * La cola es UNA sola y enfermería es un paso más dentro de ella.
   *
   * Antes enfermería era un sí/no que siempre caía al final, y eso dejaba fuera
   * el caso más común: que enfermería tome los signos ANTES de que pase el
   * doctor. Con `pasos` el orden lo pone quien asigna. `doctores`+`enfermeria`
   * se sigue aceptando (clientes viejos) y equivale a los doctores en fila con
   * enfermería detrás.
   */
  const secuencia =
    Array.isArray(pasos) && pasos.length
      ? pasos
      : [
          ...doctores.filter(Boolean).map((user) => ({ kind: 'doctor', user })),
          ...(enfermeria ? [{ kind: 'enfermeria' }] : []),
        ];

  const completados = (apt.turns || []).filter((t) => t.status === 'completado');
  let order = completados.length;
  const nuevos = [];

  for (const paso of secuencia) {
    const esEnfermeria = paso?.kind === 'enfermeria';
    const user = esEnfermeria ? null : paso?.user;
    if (!esEnfermeria && !user) continue;
    // A quien ya atendió no se le vuelve a poner en cola: su turno está cerrado
    // y su seguimiento escrito. (Enfermería sí puede repetirse: tomar signos
    // antes y aplicar algo después son dos pasos distintos.)
    if (!esEnfermeria && completados.some((t) => String(t.user) === String(user))) continue;
    nuevos.push({
      kind: esEnfermeria ? 'enfermeria' : 'doctor',
      user,
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

/**
 * Id de un campo que puede venir poblado o en crudo.
 *
 * Los turnos se leen tanto de la cita recién guardada (ObjectId pelado) como de
 * la poblada que se manda por socket (`turns.user` es el usuario entero). Sin
 * esto, `String(user)` sobre el documento poblado devuelve "{ _id: ..., name:
 * 'DocA' }" y el aviso se manda a un id que no existe: la notificación se pierde
 * y en el log solo queda un "Cast to ObjectId failed".
 */
const idDe = (v) => (v && typeof v === 'object' && v._id ? String(v._id) : v ? String(v) : null);

/** Ids de los doctores con turno pendiente (a quienes hay que avisar). */
function doctoresPendientes(apt) {
  return turnosOrdenados(apt)
    .filter((t) => t.kind === 'doctor' && t.status === 'pendiente' && t.user)
    .map((t) => idDe(t.user));
}

/**
 * El doctor al que le toca AHORA, o null si el turno en curso es de enfermería.
 *
 * La cola es estricta: al segundo doctor no se le anuncia nada mientras el
 * paciente siga con el primero. Anunciárselo a los tres a la vez es peor que no
 * avisar — tres consultorios esperando al mismo paciente.
 */
function doctorEnTurno(apt) {
  const vigente = turnoVigente(apt);
  return vigente && vigente.kind === 'doctor' ? idDe(vigente.user) : null;
}

/**
 * Condición de Mongo con las citas que un doctor debe ver en su agenda.
 *
 * Tres casos, y los tres hacen falta:
 *  1. La que tiene AHORA (`currentTurnUser`). No se usa el espejo `doctor`: con
 *     enfermería por delante, el espejo ya apunta al doctor de detrás.
 *  2. Las que YA atendió, para que no se le caigan del historial al pasar el
 *     turno al siguiente.
 *  3. Las citas SIN turnos (anteriores al cambio), donde manda el espejo.
 */
function filtroCitasDelDoctor(userId) {
  return {
    $or: [
      { currentTurnUser: userId },
      { turns: { $elemMatch: { user: userId, status: 'completado' } } },
      { $and: [{ turns: { $in: [null, []] } }, { doctor: userId }] },
    ],
  };
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
  doctorEnTurno,
  filtroCitasDelDoctor,
};
