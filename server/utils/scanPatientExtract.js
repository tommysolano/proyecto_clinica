/**
 * Lectura de las FICHAS FÍSICAS escaneadas para registrar pacientes.
 *
 * En /scanner (Herramientas) hay PDF de fichas de "REGISTRO DE PACIENTES"
 * rellenadas A MANO. De cada una se sacan siete datos: fecha, nombres, cédula,
 * edad, celular, correo y dirección.
 *
 * QUIÉN LAS LEE: el asistente, fuera del sistema — NO hay llamada a la API de IA
 * desde el servidor, a propósito (decisión del usuario: sin costo por uso). El
 * procedimiento completo está en docs/IMPORTAR_FICHAS_ESCANEADAS.md; el resultado
 * es un JSON que consume scripts/importPatientsFromScans.js.
 *
 * QUÉ HACE ESTE ARCHIVO: la BARRERA DE VALIDACIÓN, que es lo que de verdad protege
 * la base. Da igual quién transcriba: es letra manuscrita, y una cédula con un
 * dígito mal leído no da un error, da un PACIENTE EQUIVOCADO. Así que aquí todo
 * dato se valida antes de entrar, y lo que no pasa se MARCA para revisarlo a mano
 * (apartado de revisión en /patients) en vez de darse por bueno.
 *
 * Todo lo de aquí es puro y está probado en tests/scanPatientExtract.test.js.
 */

/** Campos que se transcriben. El orden es el de la ficha impresa. */
const CAMPOS = ['fecha', 'nombres', 'apellidos', 'cedula', 'edad', 'celular', 'correo', 'direccion'];

/**
 * Texto del seguimiento que se crea al importar, encima del PDF adjunto.
 *
 * Vive aquí y no en el script porque la pantalla de revisión lo usa para saber
 * QUÉ seguimiento es el de la importación y moverle la fecha si se corrige la de
 * la ficha. Si las dos cadenas se separaran, la corrección de fecha dejaría de
 * encontrarlo y fallaría en silencio.
 */
const NOTA_SEGUIMIENTO =
  'Registro creado desde la ficha física escaneada. El documento original está adjunto a este seguimiento.';

// ───────────────────────── Normalización (pura) ─────────────────────────

const txt = (v) => String(v ?? '').trim();
const soloDigitos = (v) => txt(v).replace(/\D/g, '');

/**
 * Cédula ecuatoriana: 10 dígitos, provincia 01-24 (o 30, consulados) y dígito
 * verificador por módulo 10. Se valida porque `cedula` es CLAVE ÚNICA del
 * paciente: un dígito mal leído no da un error, da un paciente equivocado.
 */
function cedulaValida(valor) {
  const c = soloDigitos(valor);
  if (c.length !== 10) return false;
  const provincia = Number(c.slice(0, 2));
  if (provincia < 1 || (provincia > 24 && provincia !== 30)) return false;
  if (Number(c[2]) > 5) return false; // el tercer dígito < 6 en cédulas de persona natural
  let suma = 0;
  for (let i = 0; i < 9; i += 1) {
    let n = Number(c[i]);
    if (i % 2 === 0) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    suma += n;
  }
  const verificador = (10 - (suma % 10)) % 10;
  return verificador === Number(c[9]);
}

/**
 * Fecha escrita a mano: "1-06-26", "29/04/1955", "01.06.2026". Siempre dd/mm/aa(aa)
 * (formato de Ecuador). Devuelve Date a mediodía local o null.
 *
 * El mediodía evita que el desfase horario mueva la fecha un día atrás, que es el
 * mismo problema que ya se corrigió en los comprobantes del SRI.
 */
function parseFechaEc(valor) {
  const m = txt(valor).match(/^(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{2}|\d{4})$/);
  if (!m) return null;
  const dia = Number(m[1]);
  const mes = Number(m[2]);
  let anio = Number(m[3]);
  if (m[3].length === 2) {
    // Dos cifras: 26 → 2026. Un año futuro no tiene sentido en una ficha ya
    // rellenada, así que por encima del actual se interpreta como del siglo pasado.
    const actual = new Date().getFullYear();
    anio = 2000 + anio > actual ? 1900 + anio : 2000 + anio;
  }
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  if (anio < 1900 || anio > new Date().getFullYear()) return null;
  const d = new Date(anio, mes - 1, dia, 12, 0, 0, 0);
  // Rechaza fechas imposibles que Date "corrige" sola (31/02 → 03/03).
  if (d.getFullYear() !== anio || d.getMonth() !== mes - 1 || d.getDate() !== dia) return null;
  return d;
}

/** Celular ecuatoriano: 10 dígitos empezando en 09, o fijo de 9 con código de área. */
function normalizarCelular(valor) {
  let c = soloDigitos(valor);
  if (c.startsWith('593')) c = `0${c.slice(3)}`;
  if (/^9\d{8}$/.test(c)) c = `0${c}`; // le faltaba el 0 inicial
  if (/^0[2-9]\d{7,8}$/.test(c)) return c;
  return '';
}

const CORREO_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

/**
 * Deja los datos listos para crear el paciente y devuelve TODO lo que no cuadró.
 *
 * `dudosos` viene de la IA (lo que leyó con poca seguridad); a eso se le suma lo
 * que falla la validación aquí. Las dos cosas van a la misma lista porque para el
 * usuario que revisa son lo mismo: "esto hay que mirarlo".
 */
function normalizarExtraccion(raw) {
  const r = raw || {};
  const dudas = new Set((Array.isArray(r.dudosos) ? r.dudosos : []).filter((d) => CAMPOS.includes(d)));

  const nombres = txt(r.nombres);
  const apellidos = txt(r.apellidos);
  if (!nombres) dudas.add('nombres');
  if (!apellidos) dudas.add('apellidos');

  // Cédula: se conserva si tiene los 10 dígitos, aunque falle el verificador —
  // en la base real hay cédulas cargadas a mano que no cuadran, y descartarlas
  // perdería un dato que probablemente se leyó bien. Lo que no cuadra se MARCA.
  // Con menos de 10 dígitos sí se deja vacía: está incompleta y `cedula` es clave
  // única, así que guardar un fragmento arriesga chocar con otro paciente.
  const cedula = soloDigitos(r.cedula);
  let cedulaFinal = '';
  if (cedula.length === 10) {
    cedulaFinal = cedula;
    if (!cedulaValida(cedula)) dudas.add('cedula');
  } else if (txt(r.cedula)) {
    dudas.add('cedula');
  }

  const fecha = parseFechaEc(r.fecha);
  if (!fecha && txt(r.fecha)) dudas.add('fecha');

  const edadNum = Number.parseInt(soloDigitos(r.edad), 10);
  const edad = Number.isFinite(edadNum) && edadNum > 0 && edadNum <= 120 ? edadNum : null;
  if (edad == null && txt(r.edad)) dudas.add('edad');

  const celular = normalizarCelular(r.celular);
  if (!celular && txt(r.celular)) dudas.add('celular');

  const correoBruto = txt(r.correo).toLowerCase();
  const correo = CORREO_RE.test(correoBruto) ? correoBruto : '';
  if (!correo && correoBruto) dudas.add('correo');

  return {
    datos: {
      fecha,
      nombres,
      apellidos,
      cedula: cedulaFinal,
      edad,
      celular,
      correo,
      direccion: txt(r.direccion),
    },
    // Sin nombre no hay a quién registrar: se avisa aparte de las dudas de campo.
    utilizable: Boolean(nombres || apellidos),
    dudas: [...dudas],
    crudo: {
      fecha: txt(r.fecha), cedula: txt(r.cedula), edad: txt(r.edad),
      celular: txt(r.celular), correo: correoBruto,
    },
  };
}

module.exports = {
  CAMPOS,
  NOTA_SEGUIMIENTO,
  cedulaValida,
  parseFechaEc,
  normalizarCelular,
  normalizarExtraccion,
};
