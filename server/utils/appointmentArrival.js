/**
 * LA HORA A LA QUE LLEGÓ EL PACIENTE, Y CUÁNTO SE RETRASÓ.
 *
 * La cita era a las 9 y el paciente entra a las 9:40. Mostrador la marca
 * «asistida» y a partir de ahí es indistinguible de la de quien llegó puntual:
 * el doctor ve dos citas iguales y no sabe cuál le desmontó la mañana. Los
 * médicos pidieron poder separarlas (sep-2026), así que la marca de asistencia
 * deja además constancia de CUÁNDO se marcó y de la diferencia con la hora
 * agendada.
 *
 * FUENTE ÚNICA a propósito: una cita llega a 'asistida' por CUATRO puertas
 * distintas —el botón «Asistió», asignar la atención, el reclamo de enfermería y
 * el estado cambiado a mano en el formulario— y que cada una calculara el
 * retraso por su cuenta es como acaban dando respuestas distintas a la misma
 * pregunta.
 */
const { appointmentDateTime } = require('./appointmentDate');

/**
 * MARGEN DE CORTESÍA, en minutos. Por debajo de esto se considera que llegó a su
 * hora: nadie entra por la puerta en el minuto exacto, y marcar como impuntual a
 * quien llegó tres minutos tarde convertiría el aviso en ruido que se ignora.
 */
const TOLERANCIA_MINUTOS = 10;

/**
 * Sella la llegada del paciente en la cita (no guarda: eso es del llamador).
 *
 * Es IDEMPOTENTE: si la cita ya tiene hora de llegada no se toca nada. Hace
 * falta porque re-marcar asistencia es normal —se vuelve a abrir «Asignar
 * atención» para añadir un doctor, o el enfermero reclama su turno después de
 * que mostrador ya recibió al paciente— y cada uno de esos gestos correría la
 * hora de llegada a la de ese momento.
 *
 * @param {object} apt      documento de cita (mongoose)
 * @param {Date}   [at]     instante de la llegada (inyectable para tests)
 * @returns {boolean}       true si se acaba de sellar
 */
function registrarLlegada(apt, { at = new Date() } = {}) {
  if (!apt || apt.arrivedAt) return false;
  apt.arrivedAt = at;
  /**
   * SIN HORA DE INICIO NO HAY RETRASO QUE MEDIR, y hay que comprobarlo aquí:
   * `appointmentDateTime` devuelve la FECHA TAL CUAL cuando no puede leer la
   * hora, y esa fecha son las 12:00 del día. Restar contra ella diría que quien
   * entró a las 9:40 llegó dos horas ANTES de su cita.
   *
   * `null` significa «no se sabe», que es distinto de «llegó puntual»: quien
   * pinta la agenda se calla en vez de acusar a nadie (ver `llegoTarde`).
   */
  const horaValida = /^\d{1,2}:\d{2}$/.test(String(apt.startTime || ''));
  const programada = horaValida ? appointmentDateTime(apt.date, apt.startTime) : null;
  const ms = programada instanceof Date ? programada.getTime() : NaN;
  apt.arrivalDelayMinutes = Number.isNaN(ms)
    ? null
    : Math.round((at.getTime() - ms) / 60000);
  return true;
}

/** ¿Llegó tarde? `null`/sin dato = no se sabe, y entonces no se dice nada. */
function llegoTarde(apt) {
  const min = apt?.arrivalDelayMinutes;
  return typeof min === 'number' && min > TOLERANCIA_MINUTOS;
}

module.exports = { registrarLlegada, llegoTarde, TOLERANCIA_MINUTOS };
