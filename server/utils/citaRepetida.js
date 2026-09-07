/**
 * LA MISMA PERSONA NO CABE DOS VECES EN LA MISMA HORA.
 *
 * ─── QUÉ PASÓ ──────────────────────────────────────────────────────────────────
 * Nada impedía crear la MISMA cita otra vez. Quien agenda desde el chat rellena
 * las filas, guarda, y al minuto vuelve a abrir la ventana —para escribirle el
 * motivo, o porque no vio la cita aparecer y creyó que no se había guardado— y
 * la escribe igual. El sistema la creaba tan contento y en la agenda del día
 * salía el paciente dos veces, a la misma hora y con el mismo servicio.
 *
 * Casos reales del 7-sep-2026: KARINA ARIAS (dos filas repetidas 78 s después),
 * HUMBERTO MEDINA SALINAS (24 s después) y MONICA PALACIOS (5 min después). En
 * los tres, la segunda tanda era idéntica salvo el motivo de una fila.
 *
 * ─── POR QUÉ SE BLOQUEA Y NO SE AVISA SOLAMENTE ────────────────────────────────
 * Porque no es una preferencia: el paciente no puede estar en dos sitios a la
 * vez. Ojo con la regla de al lado, que es OTRA: un mismo DOCTOR sí puede tener
 * varias citas a la misma hora (varios pacientes en el mismo bloque), y eso se
 * dejó de bloquear a propósito. Lo que aquí se cierra es repetir al PACIENTE.
 *
 * Se mira en TODAS las sucursales, no solo en la de la cita nueva: si ya está
 * citado a las 11:30 en la otra sede, tampoco puede venir a esta.
 *
 * Una cita CANCELADA no ocupa: su hora vuelve a estar libre y volver a citar al
 * paciente ahí es justo lo que se quiere poder hacer.
 */

/** Estados que SÍ ocupan la hora del paciente. 'cancelada' libera; ver arriba. */
const ESTADOS_QUE_OCUPAN = ['pendiente', 'confirmada', 'asistida', 'no_asistio', 'completada'];

/**
 * Principio y fin del día local de una fecha. Las citas guardan el DÍA a las
 * 12:00 (ver `parseLocalDate`), pero las importadas y las de atención inmediata
 * no siempre, así que se compara por rango y no por igualdad.
 */
function limitesDelDia(fecha) {
  const d = fecha instanceof Date ? fecha : parsearDia(fecha);
  if (!d || Number.isNaN(d.getTime())) return null;
  return {
    desde: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0),
    hasta: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0),
  };
}

/** 'YYYY-MM-DD' o Date → Date al mediodía local (el mismo criterio de la agenda). */
function parsearDia(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Clave 'YYYY-MM-DD|HH:MM' para comparar dos filas entre sí. */
function claveDeHueco(fecha, startTime) {
  const d = parsearDia(fecha);
  if (!d) return null;
  const dia = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${dia}|${String(startTime || '').trim()}`;
}

/**
 * ¿Ya existe una cita de este paciente en ese día y esa hora?
 *
 * @param {Object} p
 * @param {Object} p.Appointment  el modelo (se inyecta para no cruzar requires)
 * @param {*}      p.patient      id del paciente
 * @param {*}      p.date         'YYYY-MM-DD' o Date
 * @param {string} p.startTime    'HH:MM'
 * @param {*}      [p.excludeId]  cita que NO cuenta (la que se está editando)
 * @returns {Promise<Object|null>} la cita que ya estaba, o null
 */
async function buscarCitaRepetida({ Appointment, patient, date, startTime, excludeId = null }) {
  if (!Appointment || !patient || !date || !startTime) return null;
  const limites = limitesDelDia(date);
  if (!limites) return null;

  const filtro = {
    patient,
    date: { $gte: limites.desde, $lt: limites.hasta },
    startTime: String(startTime).trim(),
    status: { $in: ESTADOS_QUE_OCUPAN },
  };
  if (excludeId) filtro._id = { $ne: excludeId };

  return Appointment.findOne(filtro)
    .select('_id date startTime serviceName status clinic')
    .lean();
}

/** dd/mm/aaaa, como se escribe en toda la aplicación. */
function diaLegible(fecha) {
  const d = parsearDia(fecha);
  if (!d) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

/**
 * El mensaje que ve quien agenda. Dice CUÁL es la cita que ya existe —día, hora
 * y servicio— porque el error útil no es «repetida», es «ya la agendaste».
 */
function mensajeDeCitaRepetida(cita, { fila = null } = {}) {
  const donde = fila ? `La cita #${fila}: ` : '';
  const servicio = cita?.serviceName ? ` («${cita.serviceName}»)` : '';
  return (
    `${donde}este paciente ya tiene una cita el ${diaLegible(cita?.date)} a las ${cita?.startTime}` +
    `${servicio}. No se creó otra: si quieres cambiar algo, edita la que ya existe.`
  );
}

/**
 * Revisa una TANDA entera antes de crear nada: primero que las filas no se
 * repitan entre sí, y luego que ninguna choque con lo que ya hay en la base.
 *
 * Se comprueba todo ANTES de crear la primera cita a propósito: si se validara
 * dentro del bucle, una tanda de tres con la última repetida dejaría las dos
 * primeras creadas y devolvería un error, que es el peor de los dos mundos.
 *
 * @returns {Promise<{ ok: true } | { ok: false, status: number, message: string }>}
 */
async function revisarTandaDeCitas({ Appointment, patient, filas }) {
  const vistas = new Map(); // clave de hueco → nº de fila que lo pidió primero
  for (let i = 0; i < filas.length; i++) {
    const fila = filas[i];
    const clave = claveDeHueco(fila.date, fila.startTime);
    if (!clave) continue;
    if (vistas.has(clave)) {
      return {
        ok: false,
        status: 400,
        message:
          `Las citas #${vistas.get(clave)} y #${i + 1} son la misma: ${diaLegible(fila.date)} ` +
          `a las ${fila.startTime}. Quita una de las dos.`,
      };
    }
    vistas.set(clave, i + 1);
  }

  for (let i = 0; i < filas.length; i++) {
    // eslint-disable-next-line no-await-in-loop
    const yaExiste = await buscarCitaRepetida({
      Appointment,
      patient,
      date: filas[i].date,
      startTime: filas[i].startTime,
    });
    if (yaExiste) {
      return {
        ok: false,
        status: 409,
        message: mensajeDeCitaRepetida(yaExiste, { fila: filas.length > 1 ? i + 1 : null }),
      };
    }
  }

  return { ok: true };
}

module.exports = {
  ESTADOS_QUE_OCUPAN,
  buscarCitaRepetida,
  revisarTandaDeCitas,
  mensajeDeCitaRepetida,
  claveDeHueco,
  diaLegible,
};
