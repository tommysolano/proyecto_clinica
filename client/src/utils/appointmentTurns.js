/**
 * Turnos de una cita, en el cliente.
 *
 * Una cita puede pasar por varios profesionales en orden (ver
 * server/utils/appointmentTurns.js). Lo que hace falta en pantalla es saber
 * CUÁNDO EMPEZÓ EL TURNO EN CURSO, y eso vive en dos sitios porque el
 * cronómetro y el aviso de "tiempo finalizado" lo usan igual.
 */

/** Turno que tiene la pelota ahora: el primero sin completar. */
export function turnoVigente(apt) {
  return (apt?.turns || [])
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .find((t) => t.status === 'pendiente') || null;
}

/**
 * Cuándo empezó el turno en curso, en milisegundos, o null si aún no empezó.
 *
 * El cronómetro arranca de cero para cada profesional. Medir desde
 * `consultationStartedAt` —que es de la cita entera— hacía que el segundo doctor
 * entrara con el tiempo del primero ya corrido y le saltara el aviso de "tiempo
 * finalizado" nada más abrir la ficha.
 *
 * Las citas sin turnos (anteriores al cambio) siguen midiendo desde
 * `consultationStartedAt`, que es lo único que tienen.
 */
export function inicioDeMiTurno(apt) {
  const turno = turnoVigente(apt);
  const marca = turno?.startedAt || (!(apt?.turns || []).length ? apt?.consultationStartedAt : null);
  const ms = marca ? new Date(marca).getTime() : NaN;
  return Number.isNaN(ms) ? null : ms;
}
