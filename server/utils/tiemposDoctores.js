/**
 * TIEMPOS DE ATENCIÓN DE LOS DOCTORES (oct-2026, Fénix → «Tiempos de Doctores»).
 *
 * Dos preguntas distintas sobre la agenda, y cada una se lee de un sitio:
 *
 *  · CUÁNTO TARDÓ cada atención. Se mide por TURNO, no por cita: con «ginecología
 *    → medicina general» la cita entera mide lo de las dos doctoras y no dice
 *    nada de ninguna. El turno de doctor sella `startedAt` al pulsar «Atender»
 *    (POST /:id/start) y `completedAt` al cerrar su parte. Las citas de antes de
 *    los turnos solo tienen el reloj de la cita (`consultationStartedAt/EndedAt`).
 *
 *  · QUÉ ESTÁ HACIENDO AHORA. Sale de los turnos PENDIENTES de las citas de hoy:
 *      en_consulta → su turno es el vigente y ya pulsó «Atender»;
 *      esperando   → su turno es el vigente: el paciente ya está y le toca a él;
 *      en_cola     → tiene turno, pero antes va otro profesional (otro doctor o
 *                    enfermería): le llega cuando ese termine;
 *      agendada    → cita de hoy con su nombre a la que el paciente aún no llegó.
 *
 * Funciones PURAS sobre citas ya leídas (con `patient`, `clinic` y `turns.user`
 * poblados o no): el controlador hace las consultas y esto solo cuenta, así se
 * puede probar sin base de datos.
 */
const { turnosOrdenados, turnoVigente } = require('./appointmentTurns');

/** Una atención de más de 4 h no es una consulta: es un turno que nadie cerró. */
const MAX_MINUTOS = 240;

const idDe = (v) => String(v?._id || v || '');

const nombrePaciente = (p) =>
  p && typeof p === 'object' ? `${p.firstName || ''} ${p.lastName || ''}`.trim() : '';

const nombreSucursal = (c) =>
  c && typeof c === 'object' ? c.nombreComercial || c.name || '' : '';

/** Lo común de una cita para enseñarla en una fila. */
const datosCita = (apt) => ({
  appointmentId: idDe(apt._id),
  fecha: apt.date,
  hora: apt.startTime || '',
  paciente: nombrePaciente(apt.patient),
  servicio: apt.serviceName || '',
  sucursal: nombreSucursal(apt.clinic),
});

/**
 * Las atenciones TERMINADAS de una cita, una por doctor que atendió.
 * Devuelve [{ doctorId, inicio, fin, minutos, valida, motivo }].
 */
function atencionesDeCita(apt) {
  const out = [];
  const turnos = turnosOrdenados(apt);
  if (turnos.length) {
    for (const t of turnos) {
      if (t.kind !== 'doctor' || t.status !== 'completado' || !t.user) continue;
      out.push(medir(idDe(t.user), t.startedAt, t.completedAt));
    }
    return out;
  }
  // Cita anterior a los turnos: el reloj de la cita y el espejo `doctor`.
  if (apt.doctor && apt.consultationEndedAt) {
    out.push(medir(idDe(apt.doctor), apt.consultationStartedAt, apt.consultationEndedAt));
  }
  return out;
}

function medir(doctorId, inicio, fin) {
  const a = inicio ? new Date(inicio) : null;
  const b = fin ? new Date(fin) : null;
  if (!a || Number.isNaN(a.getTime()) || !b || Number.isNaN(b.getTime())) {
    // Cerró sin haber pulsado «Atender»: hubo atención, pero no reloj.
    return { doctorId, inicio: a, fin: b, minutos: null, valida: false, motivo: 'sin_cronometro' };
  }
  const minutos = Math.round(((b - a) / 60000) * 10) / 10;
  if (minutos <= 0 || minutos > MAX_MINUTOS) {
    return { doctorId, inicio: a, fin: b, minutos, valida: false, motivo: 'atipica' };
  }
  return { doctorId, inicio: a, fin: b, minutos, valida: true, motivo: null };
}

/**
 * Lo que la cita le dice HOY a cada doctor que tiene en ella un turno pendiente.
 * Devuelve [{ doctorId, tipo, desde, antes }].
 */
function estadoEnVivo(apt) {
  if (['cancelada', 'no_asistio'].includes(apt.status)) return [];
  const turnos = turnosOrdenados(apt);
  const out = [];

  if (!turnos.length) {
    // Cita vieja sin turnos: manda el espejo y el reloj de la cita.
    if (!apt.doctor || apt.status === 'completada') return out;
    const doctorId = idDe(apt.doctor);
    if (apt.consultationStartedAt && !apt.consultationEndedAt) {
      out.push({ doctorId, tipo: 'en_consulta', desde: apt.consultationStartedAt, antes: null });
    } else if (apt.status === 'asistida') {
      out.push({ doctorId, tipo: 'esperando', desde: null, antes: null });
    } else {
      out.push({ doctorId, tipo: 'agendada', desde: null, antes: null });
    }
    return out;
  }

  const vigente = turnoVigente(apt);
  // El paciente todavía no llegó: la cita es solo una hora en la agenda.
  const sinLlegar = ['pendiente', 'confirmada'].includes(apt.status) && !apt.attentionAssignedAt;
  for (const t of turnos) {
    if (t.kind !== 'doctor' || t.status !== 'pendiente' || !t.user) continue;
    const doctorId = idDe(t.user);
    if (sinLlegar) {
      out.push({ doctorId, tipo: 'agendada', desde: null, antes: null });
    } else if (t === vigente) {
      out.push(
        t.startedAt
          ? { doctorId, tipo: 'en_consulta', desde: t.startedAt, antes: null }
          : { doctorId, tipo: 'esperando', desde: null, antes: null }
      );
    } else {
      // Antes va otro: quién, para que se lea «después de la Dra. X».
      out.push({
        doctorId,
        tipo: 'en_cola',
        desde: null,
        antes: vigente
          ? {
              kind: vigente.kind,
              nombre: vigente.user?.name || (vigente.kind === 'enfermeria' ? 'Enfermería' : ''),
            }
          : null,
      });
    }
  }
  return out;
}

/** Resumen de una lista de atenciones: cuántas, promedio, la más corta y la más larga. */
function resumir(atenciones) {
  const validas = atenciones.filter((a) => a.valida);
  const mins = validas.map((a) => a.minutos);
  const total = mins.reduce((s, m) => s + m, 0);
  return {
    atenciones: atenciones.length,
    conTiempo: validas.length,
    sinCronometro: atenciones.filter((a) => a.motivo === 'sin_cronometro').length,
    atipicas: atenciones.filter((a) => a.motivo === 'atipica').length,
    totalMin: Math.round(total * 10) / 10,
    promedioMin: validas.length ? Math.round((total / validas.length) * 10) / 10 : null,
    minMin: mins.length ? Math.min(...mins) : null,
    maxMin: mins.length ? Math.max(...mins) : null,
  };
}

const PRIORIDAD = { en_consulta: 0, esperando: 1, en_cola: 2, agendada: 3 };

/**
 * Arma la respuesta de la página.
 *
 * @param {Array} doctores   usuarios doctor ({ _id, name, specialty }).
 * @param {Array} historial  citas del rango pedido (para los tiempos).
 * @param {Array} deHoy      citas de hoy (para el estado en vivo).
 * @param {Date}  ahora
 */
function construirTiempos({ doctores = [], historial = [], deHoy = [], ahora = new Date() }) {
  const porId = new Map();
  const fila = (id, nombre = '', especialidad = '') => {
    if (!porId.has(id)) {
      porId.set(id, { _id: id, name: nombre, specialty: especialidad, atenciones: [], vivo: [] });
    }
    return porId.get(id);
  };
  doctores.forEach((d) => fila(idDe(d._id), d.name || '', d.specialty || ''));

  // Nombre de un doctor que aparece en una cita pero no en la lista (otra sede, dado de baja).
  const nombreEnCita = (apt, id) => {
    const t = (apt.turns || []).find((x) => idDe(x.user) === id && x.user?.name);
    return t?.user?.name || (idDe(apt.doctor) === id ? apt.doctor?.name || '' : '');
  };

  for (const apt of historial) {
    for (const a of atencionesDeCita(apt)) {
      const f = fila(a.doctorId, nombreEnCita(apt, a.doctorId));
      if (!f.name) f.name = nombreEnCita(apt, a.doctorId);
      f.atenciones.push({ ...datosCita(apt), ...a });
    }
  }

  for (const apt of deHoy) {
    for (const v of estadoEnVivo(apt)) {
      const f = fila(v.doctorId, nombreEnCita(apt, v.doctorId));
      if (!f.name) f.name = nombreEnCita(apt, v.doctorId);
      f.vivo.push({ ...datosCita(apt), ...v });
    }
  }

  const doctoresOut = [...porId.values()].map((f) => {
    const enConsulta = f.vivo
      .filter((v) => v.tipo === 'en_consulta')
      .sort((a, b) => new Date(b.desde) - new Date(a.desde))[0] || null;
    const proximas = f.vivo
      .filter((v) => v.tipo !== 'en_consulta')
      .sort((a, b) => PRIORIDAD[a.tipo] - PRIORIDAD[b.tipo] || String(a.hora).localeCompare(String(b.hora)));
    const atenciones = f.atenciones.sort((a, b) => new Date(b.fin || b.fecha) - new Date(a.fin || a.fecha));
    return {
      _id: f._id,
      name: f.name || 'Doctor',
      specialty: f.specialty,
      ahora: enConsulta
        ? {
            estado: 'en_consulta',
            ...enConsulta,
            minutos: Math.max(0, Math.round((ahora - new Date(enConsulta.desde)) / 60000)),
          }
        : { estado: 'libre' },
      proximas,
      resumen: resumir(atenciones),
      atenciones,
    };
  });

  // Primero quien está atendiendo, luego quien tiene pacientes esperando, y el resto
  // por cuántas atenciones lleva.
  const peso = (d) => (d.ahora.estado === 'en_consulta' ? 0 : d.proximas.length ? 1 : 2);
  doctoresOut.sort(
    (a, b) => peso(a) - peso(b) || b.resumen.atenciones - a.resumen.atenciones || a.name.localeCompare(b.name)
  );

  const todas = doctoresOut.flatMap((d) => d.atenciones);
  return {
    generadoEn: ahora,
    resumen: {
      ...resumir(todas),
      enConsulta: doctoresOut.filter((d) => d.ahora.estado === 'en_consulta').length,
      conPacientesEsperando: doctoresOut.filter((d) => d.proximas.some((p) => p.tipo === 'esperando')).length,
    },
    doctores: doctoresOut,
  };
}

module.exports = { atencionesDeCita, estadoEnVivo, resumir, construirTiempos, MAX_MINUTOS };
