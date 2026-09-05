/**
 * TEXTO Y DESTINO DE LOS AVISOS DE ATENCIÓN (campana + push).
 *
 * Dos reglas, y las dos salen de lo mismo: un aviso tiene que servir POR SÍ SOLO.
 *
 * 1. EL NOMBRE DEL PACIENTE VA SIEMPRE. Los avisos nacieron contando lo que
 *    acababa de pasar —«el doctor terminó su parte», «mostrador acaba de recetar
 *    un suero»— y eso deja a enfermería con media noticia: sabe que hay trabajo,
 *    pero no a por quién ir. Con seis avisos seguidos en la campana, todos con el
 *    mismo texto, la única salida era abrir la agenda y cruzarlos por la hora.
 *
 * 2. EL AVISO LLEVA A DONDE SE ATIENDE, que son los seguimientos del paciente y
 *    no la agenda. Mandar a /appointments obligaba a buscar otra vez, en una
 *    lista de decenas de citas, justo la que el aviso ya identificaba.
 *
 * Todo lo de aquí es a prueba de fallos: un aviso sin nombre es peor que uno con
 * nombre, pero perder el aviso —o tumbar la atención que lo dispara— por no
 * poder leer un nombre sería mucho peor. Por eso nada de esto lanza.
 */

/** Id de un campo que puede venir poblado o en crudo. */
const idDe = (v) => (v && typeof v === 'object' && v._id ? String(v._id) : v ? String(v) : null);

/** «JORGE AVILES VILLON», o el genérico si no hay de dónde sacarlo. */
function nombreDePaciente(patient) {
  const nombre = [patient?.firstName, patient?.lastName].filter(Boolean).join(' ').trim();
  return nombre || 'un paciente';
}

/**
 * Nombre del paciente de una cita, venga poblado o como id.
 *
 * Las citas llegan aquí de las dos formas: la que se manda por socket va
 * poblada, la que se acaba de guardar tiene el id pelado. Se resuelve leyendo
 * solo el nombre, que es lo único que se va a pintar.
 */
async function pacienteDeCita(apt) {
  const p = apt?.patient;
  if (p && typeof p === 'object' && (p.firstName || p.lastName)) return nombreDePaciente(p);
  const id = idDe(p);
  if (!id) return nombreDePaciente(null);
  try {
    const doc = await require('../models/Patient')
      .findById(id)
      .select('firstName lastName')
      .lean();
    return nombreDePaciente(doc);
  } catch {
    return nombreDePaciente(null);
  }
}

/**
 * Qué se le hace al paciente. El servicio DEL TURNO manda sobre el de la cita:
 * en un detox de dos pasos, cada turno tiene el suyo y el de la cita es el
 * genérico.
 */
function servicioDeCita(apt, turno = null) {
  return String(turno?.serviceName || apt?.serviceName || apt?.serviceItem?.name || '').trim();
}

/** «JORGE AVILES VILLON · Sueroterapia · 14:28 · El paciente está esperando.» */
function cuerpoDeAviso({ paciente, servicio = '', hora = '', motivo = '' }) {
  return [paciente, servicio, hora, motivo]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(' · ');
}

/**
 * A dónde lleva el aviso: la pantalla donde se atiende a ESE paciente.
 *
 * `tab` es 'seguimientos' salvo para el doctor que abre una consulta nueva, que
 * empieza por la ficha (los antecedentes antes de explorar). Sin paciente no hay
 * a dónde ir y se cae a la agenda, que es lo que hacía siempre.
 */
function urlDeAtencion(patient, appointment, tab = 'seguimientos') {
  const pid = idDe(patient);
  const aid = idDe(appointment);
  if (!pid) return '/appointments';
  return `/patients/${pid}?tab=${tab}${aid ? `&appointment=${aid}` : ''}`;
}

module.exports = {
  nombreDePaciente,
  pacienteDeCita,
  servicioDeCita,
  cuerpoDeAviso,
  urlDeAtencion,
};
