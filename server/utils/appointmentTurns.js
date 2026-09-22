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
function sincronizarEspejo(apt, { colaReescrita = false } = {}) {
  const orden = turnosOrdenados(apt);

  // Clase del turno que tiene la pelota: de esto depende que la cita salga (o no)
  // en la bandeja de enfermería. Se guarda porque no se puede consultar el
  // "primer pendiente" de un arreglo desde una query.
  const enCurso = orden.find((t) => t.status === 'pendiente');
  apt.currentTurnKind = enCurso ? enCurso.kind : null;
  /**
   * Y QUIÉN lo tiene — de las DOS clases de turno, no solo de los doctores.
   *
   * En enfermería, `null` es «todavía sin dueño», o sea libre para cualquiera.
   * Que valga también para enfermería es lo que permite tener en la misma cola
   * un turno nombrado y otro abierto: sin esto, la bandeja tendría que
   * preguntar «¿hay algún turno de enfermería sin dueño?» y la cita le saldría
   * a todos los enfermeros mientras todavía es el turno de la que fue nombrada.
   *
   * No vale el espejo `doctor` para esto: si enfermería va delante, el espejo ya
   * apunta al doctor de detrás (es su cita, y así la leen las comisiones y los
   * reportes), pero en su agenda todavía no debe salir.
   */
  apt.currentTurnUser = enCurso ? enCurso.user || null : null;

  /**
   * Espejo de ENFERMERÍA, con el mismo criterio que el de `doctor`: quien la
   * tiene ahora, o la última que atendió cuando ya no queda turno suyo.
   *
   * Antes `attendedByNurse` se escribía a mano al reclamar y NO se soltaba
   * nunca: con dos turnos de enfermería seguidos, el campo se quedaba clavado
   * en la primera y la segunda no llegaba ni a ver la cita en su bandeja. Ahora
   * es un espejo —informa, no manda— y el dueño de verdad es `turns[].user`.
   */
  const enfEnCurso = enCurso && enCurso.kind === 'enfermeria' && enCurso.user ? enCurso : null;
  const ultimaEnf = [...orden].reverse().find((t) => t.kind === 'enfermeria' && t.user);
  const enfElegida = enfEnCurso || ultimaEnf;
  // Sin ningún turno de enfermería con dueño no se pisa lo que hubiera: una cita
  // vieja ya atendida no puede perder a su enfermera porque se reasigne la cola.
  if (enfElegida) {
    apt.attendedByNurse = enfElegida.user;
    apt.nurseClaimedAt = enfElegida.startedAt || apt.nurseClaimedAt;
  }

  const vigente = orden.find((t) => t.status === 'pendiente' && t.kind === 'doctor');
  const ultimoDoctor = [...orden].reverse().find((t) => t.kind === 'doctor' && t.user);
  const elegido = vigente && vigente.user ? vigente : ultimoDoctor;

  if (!elegido || !elegido.user) {
    /**
     * QUITAR AL DOCTOR DE LA COLA LO QUITA DE LA CITA.
     *
     * Antes esto se iba sin tocar el espejo, y el resultado era que una cita a la
     * que se le quitaba el doctor —porque se asignó por error, o porque al final
     * la atendió otro— seguía diciendo «Dr. Fulano» en la agenda, en el detalle y
     * en los reportes. El doctor no la había atendido y la cita lo nombraba
     * igual: quitarlo no servía de nada.
     *
     * Solo cuando la cola se ACABA DE REESCRIBIR (`colaReescrita`), que es cuando
     * la ausencia de doctores es una decisión de quien asignó. Al cerrar un turno
     * no: ahí una cita vieja sin turnos —de antes de que existieran— perdería su
     * médico sin que nadie lo hubiera pedido.
     *
     * Y si algún turno de doctor está COMPLETADO, arriba ya lo habría elegido: a
     * quien de verdad atendió no se le borra nunca por esta vía.
     */
    if (colaReescrita) {
      apt.doctor = null;
      apt.doctorAssignedAt = null;
      apt.doctorAssignedBy = null;
    }
    return apt;
  }

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
  const teniaTurnoDeEnfermeria = (apt.turns || []).some((t) => t.kind === 'enfermeria');
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
    /**
     * En enfermería el usuario es OPCIONAL: con id, el turno es de esa persona;
     * sin id, sale a la bandeja de todos. Antes se forzaba a `null` siempre, y
     * por eso no se podía dejar preparado «primero Ana y luego quien esté
     * libre», que es como se atiende un detox.
     */
    const user = paso?.user || null;
    if (!esEnfermeria && !user) continue;
    // A quien ya atendió no se le vuelve a poner en cola: su turno está cerrado
    // y su seguimiento escrito. (Enfermería sí puede repetirse: tomar signos
    // antes y aplicar algo después son dos pasos distintos, y los puede hacer
    // la misma persona.)
    if (!esEnfermeria && completados.some((t) => String(t.user) === String(user))) continue;
    nuevos.push({
      kind: esEnfermeria ? 'enfermeria' : 'doctor',
      user,
      order: order++,
      status: 'pendiente',
      assignedAt: new Date(),
      assignedBy: por,
      serviceName: String(paso?.serviceName || '').trim(),
      serviceItem: paso?.serviceItem || null,
      /**
       * El suero viaja con el paso, y con él su seguimiento ya escrito. Los DOS
       * hacen falta: sin `serum` la pantalla no puede enseñar lo que ya se
       * indicó al reabrir la asignación, y sin `serumFollowUp` reordenar la cola
       * volvería a escribirlo en la ficha (ver `Appointment.turns[].serum`).
       */
      serum: paso?.serum || undefined,
      serumFollowUp: paso?.serumFollowUp || null,
      serumMergeIntoService: !!paso?.serumMergeIntoService,
      // Lo que mostrador le escribió a enfermería para este paso (sep-2026):
      // la enfermera lo lee en su barra de atención, junto al suero.
      nurseInstructions: String(paso?.nurseInstructions || '').trim(),
      // HIDROTERAPIA (sep-2026): la marca mostrador al asignar; la enfermera
      // la ve en su barra de atención y da fe de si la realizó.
      hidroterapia: paso?.hidroterapia
        ? { solicitada: true, realizada: false, realizadaAt: null, realizadaBy: null }
        : undefined,
    });
  }

  apt.turns = [...completados, ...nuevos];
  // La cola se acaba de reescribir entera: si no quedó ningún doctor, es porque
  // se le quitó, no porque no se sepa.
  sincronizarEspejo(apt, { colaReescrita: true });
  /**
   * Si se retiró el turno de enfermería que todavía no se había realizado,
   * también se limpia su espejo. Los turnos completados están en `completados`
   * y se conservan arriba, por lo que nunca se borra aquí a quien sí atendió.
   * La condición inicial evita tocar citas antiguas sin turnos que solo guardan
   * `attendedByNurse`.
   */
  const conservaEnfermero = (apt.turns || []).some(
    (t) => t.kind === 'enfermeria' && t.user
  );
  if (teniaTurnoDeEnfermeria && !conservaEnfermero) {
    apt.attendedByNurse = null;
    apt.nurseClaimedAt = null;
    apt.nurseAttendedAt = null;
  }
  return apt;
}

/**
 * CAMBIA (o QUITA) el doctor de una cita desde el formulario de edición.
 *
 * El campo «Doctor asignado» del formulario escribía el espejo `doctor` a pelo y
 * no tocaba la cola. Con eso, quitar al doctor no quitaba nada: su TURNO seguía
 * ahí, la cita continuaba en su agenda (que va por `currentTurnUser`) y, en
 * cuanto guardaba cualquier cosa, `completarTurno` volvía a poner su nombre en
 * el espejo. El resultado que se veía: «le quité el doctor y sigue diciendo que
 * la atendió él».
 *
 * Reemplaza el turno de doctor PENDIENTE por el nuevo —en su misma posición,
 * para no adelantar ni retrasar a enfermería—, o lo quita si no hay doctor. A
 * los turnos ya COMPLETADOS no los toca: ese profesional ya atendió y su
 * seguimiento está escrito a su nombre.
 */
function fijarDoctorDeLaCita(apt, userId, { por = null } = {}) {
  const orden = turnosOrdenados(apt);
  const esDoctorPendiente = (t) => t.kind === 'doctor' && t.status === 'pendiente';
  const posicionOriginal = orden.findIndex(esDoctorPendiente);
  const resto = orden.filter((t) => !esDoctorPendiente(t));
  let cola = resto;
  if (userId) {
    const nuevo = {
      kind: 'doctor',
      user: userId,
      status: 'pendiente',
      assignedAt: new Date(),
      assignedBy: por,
    };
    const en = posicionOriginal >= 0 ? Math.min(posicionOriginal, resto.length) : resto.length;
    cola = [...resto.slice(0, en), nuevo, ...resto.slice(en)];
  }
  apt.turns = cola.map((t, i) => ({ ...(t.toObject ? t.toObject() : t), order: i }));
  sincronizarEspejo(apt, { colaReescrita: true });
  return apt;
}

/**
 * Cierra el turno de `userId` (o el vigente) y devuelve qué pasa después.
 *
 * Devuelve { cerrado, siguiente, terminado }. El llamador decide con eso si la
 * cita queda 'completada' o si solo cambia de manos.
 *
 * `tomarVigente` (por defecto true) habilita el RESPALDO de cerrar el turno
 * vigente sin tener uno propio. Es para quien está atendiendo de hecho —el
 * doctor de una cita reasignada—. Quien NO atiende pacientes (mostrador,
 * administración) documentando un seguimiento no debe cerrarle el turno a
 * nadie: le ponía su nombre a la cita y la sacaba de la agenda del
 * profesional que venía detrás.
 */
function completarTurno(apt, { userId, followUpId = null, tomarVigente = true } = {}) {
  const orden = turnosOrdenados(apt);
  const propio = orden.find((t) => t.status === 'pendiente' && String(t.user) === String(userId));
  /**
   * ¿Ya cerró SU turno en esta cita?
   *
   * El respaldo de abajo —cerrar el turno vigente sin tener uno propio— existe
   * para el doctor de una cita vieja o reasignada: es quien está atendiendo de
   * hecho. Pero NO vale para quien ya terminó lo suyo aquí, porque entonces
   * cerraría el del profesional que viene detrás: la cita pasaría a
   * «completada» con el paciente sin atender y desaparecería de su agenda.
   *
   * Pasa de verdad desde que enfermería escribe seguimientos: la enfermera
   * cierra su parte, vuelve atrás a anotar lo que aplicó, guarda, y sin esto se
   * lleva por delante el turno del doctor que la seguía. Igual si su primer
   * guardado falló al subir un adjunto y vuelve a darle.
   */
  const yaCerroElSuyo = orden.some(
    (t) => t.status === 'completado' && String(t.user) === String(userId)
  );
  const cerrado = propio
    || (yaCerroElSuyo || !tomarVigente ? null : orden.find((t) => t.status === 'pendiente'))
    || null;

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
 * El turno de enfermería que `userId` puede tomar AHORA, o null.
 *
 * Es el turno VIGENTE, y solo si es suyo o no tiene dueño. La cola es estricta
 * también dentro de enfermería: con «primero Ana, después quien esté libre», el
 * segundo turno no existe para nadie hasta que Ana cierre el suyo. Dejarlo
 * abierto pondría a dos personas con el mismo paciente y un solo registro, que
 * es justo lo que el reclamo atómico existe para impedir.
 */
function turnoEnfermeriaParaUsuario(apt, userId) {
  const vigente = turnoVigente(apt);
  if (!vigente || vigente.kind !== 'enfermeria') return null;
  if (vigente.user && String(idDe(vigente.user)) !== String(userId)) return null;
  return vigente;
}

/**
 * Condición de Mongo con las citas que un enfermero debe ver en su bandeja.
 *
 * Tres casos, y los tres hacen falta:
 *  1. La que puede tomar AHORA: el turno vigente es de enfermería y está libre
 *     (`currentTurnUser: null`) o es suyo.
 *  2. TURNOS PARALELOS (sep-2026): un turno de enfermería con SU nombre sigue
 *     pendiente, aunque la cita esté con un doctor o con otra enfermera. La
 *     clínica pidió que VARIOS enfermeros puedan atender al mismo paciente a la
 *     vez —cada uno su parte—, no que el segundo esperara a que el primero
 *     cerrara. Solo los NOMBRADOS van aquí: los abiertos siguen saliendo por
 *     su orden en la cola, para no ofertar a todos el paso de un momento que
 *     todavía no llegó.
 *  3. Las que YA atendió, para que no se le caigan de la lista al pasar el turno
 *     a la siguiente compañera.
 *
 * NO se mira `attendedByNurse`: ese campo es ahora un espejo del último turno de
 * enfermería y nunca se suelta, así que filtrar por él escondía la cita a la
 * segunda enfermera aunque el turno fuera suyo.
 */
function filtroCitasDeEnfermeria(userId) {
  return {
    /**
     * RETENIDAS POR EL SUERO (sep-2026): mientras la cita diga «falta asignar
     * suero» o «suero pendiente», no sale a la bandeja de NADIE de enfermería,
     * ni libre ni nombrada — el suero que le va a llegar lo tiene que escoger
     * mostrador primero (ver `Appointment.serumStatus`). `{ null }` también
     * pega con las citas que no tienen el campo: es el estado normal.
     */
    serumStatus: null,
    $or: [
      {
        currentTurnKind: 'enfermeria',
        $or: [{ currentTurnUser: null }, { currentTurnUser: userId }],
      },
      {
        turns: {
          $elemMatch: { kind: 'enfermeria', user: userId, status: 'pendiente' },
        },
      },
      // Solo las COMPLETADAS. Sin el estado, un turno suyo que todavía está
      // detrás de un doctor le saldría ya en la bandeja, y la cola dejaría de
      // valer para nada: el paciente sigue en consulta.
      { turns: { $elemMatch: { kind: 'enfermeria', user: userId, status: 'completado' } } },
    ],
  };
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
 * A quién hay que avisar cuando el turno vigente es de enfermería.
 *
 * Devuelve el id del enfermero nombrado, o `null` si el turno está abierto —y
 * entonces el aviso va al ROL entero, que es lo que ya hacía antes—. Es la
 * misma distinción que hace recepción al asignar, leída del turno.
 */
function enfermeroEnTurno(apt) {
  const vigente = turnoVigente(apt);
  return vigente && vigente.kind === 'enfermeria' ? idDe(vigente.user) : null;
}

/** ¿El turno vigente es de enfermería? (con o sin dueño) */
function turnoVigenteEsEnfermeria(apt) {
  const vigente = turnoVigente(apt);
  return !!vigente && vigente.kind === 'enfermeria';
}

/** Ids de los enfermeros que han atendido (o atienden) esta cita, sin repetir. */
function enfermerosDeLaCita(apt) {
  return [
    ...new Set(
      turnosOrdenados(apt)
        .filter((t) => t.kind === 'enfermeria' && t.user)
        .map((t) => idDe(t.user))
        .filter(Boolean)
    ),
  ];
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
  fijarDoctorDeLaCita,
  completarTurno,
  turnoEnfermeriaPendiente,
  turnoEnfermeriaParaUsuario,
  filtroCitasDeEnfermeria,
  doctoresPendientes,
  doctorEnTurno,
  enfermeroEnTurno,
  turnoVigenteEsEnfermeria,
  enfermerosDeLaCita,
  filtroCitasDelDoctor,
};
