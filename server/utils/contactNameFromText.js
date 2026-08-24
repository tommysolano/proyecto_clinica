/**
 * EL NOMBRE QUE EL PROPIO CONTACTO ESCRIBE EN EL CHAT.
 *
 * En la bandeja casi todos los chats se llamaban como el PERFIL de WhatsApp:
 * "Yo…!!!", "🌸Mi vida🌸", "0987…" — apodos que no le dicen nada al asesor. Y sin
 * embargo el contacto sí da su nombre: lo escribe en el primer mensaje ("Hola, me
 * llamo Ana Pérez") o cuando la automatización se lo pregunta.
 *
 * Esta función lee ESE nombre del texto de un mensaje entrante. El chat lo adopta
 * con la prioridad 'chat' (ver messaging.applyContactName): pisa el apodo del
 * perfil, pero nunca el nombre escrito a mano ni el que trae el Excel del CRM.
 *
 * ES DELIBERADAMENTE DESCONFIADA. Un falso positivo renombra el chat de una
 * persona real con una frase suelta, así que ante la duda devuelve ''. Por eso:
 *   · las fórmulas explícitas ("me llamo X", "mi nombre es X", "Nombre: X") se
 *     aceptan con hasta 4 palabras;
 *   · "soy X" es mucho más ambigua ("soy de Portoviejo", "soy paciente de…") y
 *     solo se acepta si TODAS las palabras parecen un nombre propio;
 *   · un mensaje que es SOLO un nombre ("Ana Pérez") —la respuesta típica a
 *     "¿cuál es tu nombre?"— se acepta únicamente cuando el chat todavía no tiene
 *     ningún nombre, para no pisar nada por una coincidencia.
 * Es PURA (sin BD) a propósito: toda la casuística se prueba en tests unitarios.
 */

// Palabras que jamás forman parte de un nombre propio. Si aparece una, el
// candidato se descarta entero: es la red que separa "soy Ana" de "soy de Manta".
const NOT_A_NAME = new Set([
  'a', 'al', 'ante', 'con', 'contra', 'de', 'del', 'desde', 'en', 'entre', 'hacia',
  'hasta', 'para', 'por', 'segun', 'sin', 'sobre', 'tras', 'y', 'o', 'u', 'e',
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'lo', 'que', 'quien',
  'yo', 'tu', 'usted', 'ustedes', 'nosotros', 'ella', 'ellos', 'mi', 'mis', 'su',
  'sus', 'me', 'te', 'se', 'nos', 'les', 'le',
  'hola', 'buenas', 'buenos', 'dias', 'tardes', 'noches', 'gracias', 'muchas',
  'favor', 'porfavor', 'ok', 'okay', 'listo', 'perfecto', 'claro', 'si', 'no',
  'bien', 'mal', 'aqui', 'alli', 'ahi', 'ahora', 'hoy', 'manana', 'ayer',
  'paciente', 'cliente', 'contacto', 'usuario', 'persona', 'senor', 'senora',
  'senorita', 'don', 'dona', 'doctor', 'doctora', 'dr', 'dra', 'licenciado',
  'licenciada', 'ing', 'sr', 'sra', 'srta',
  'cita', 'citas', 'consulta', 'turno', 'precio', 'precios', 'costo', 'valor',
  'informacion', 'info', 'interesa', 'interesada', 'interesado', 'quiero',
  'necesito', 'quisiera', 'deseo', 'llamar', 'llamada', 'whatsapp', 'numero',
  'telefono', 'celular', 'correo', 'email', 'direccion', 'ubicacion', 'horario',
  'nombre', 'nombres', 'apellido', 'apellidos', 'llamo', 'llama', 'soy', 'es',
  'esta', 'estoy', 'tengo', 'hay', 'como', 'cuando', 'donde', 'cuanto', 'cual',
  'para', 'pero', 'tambien', 'muy', 'mucho', 'poco', 'todo', 'nada', 'algo',
]);

/** Sin acentos y en minúsculas, para comparar contra NOT_A_NAME. */
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Una palabra de nombre propio: solo letras (con acentos y ñ), apóstrofo o guion.
const WORD_RE = /^[a-záéíóúüñ]+(?:[’'-][a-záéíóúüñ]+)*$/i;

/** ¿Esta palabra suelta puede ser parte de un nombre propio? */
function wordLooksLikeName(word) {
  if (!WORD_RE.test(word)) return false;
  if (word.length < 2 || word.length > 20) return false;
  return !NOT_A_NAME.has(fold(word));
}

/**
 * Limpia y valida un candidato a nombre.
 * `maxWords` acota cuántas palabras se aceptan (un nombre completo ecuatoriano
 * son 2 nombres + 2 apellidos).
 */
function cleanName(raw, { maxWords = 4 } = {}) {
  const words = String(raw || '')
    .replace(/[.,;:!¡?¿"“”()]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length || words.length > maxWords) return '';
  if (!words.every(wordLooksLikeName)) return '';
  // "Ana Perez" → "Ana Perez"; "ANA PEREZ" y "ana perez" → "Ana Perez".
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// Fórmulas EXPLÍCITAS: quien las escribe está diciendo su nombre a propósito.
const EXPLICIT = [
  /\bme\s+llamo\s+([^\n.,;!?]{2,60})/i,
  /\bmi\s+nombre\s+(?:es|seria|ser[íi]a)\s+([^\n.,;!?]{2,60})/i,
  /^\s*(?:mi\s+)?nombre[s]?\s*[:\-]\s*([^\n.,;!?]{2,60})/i,
  /\bnombre\s+completo\s*[:\-]?\s*([^\n.,;!?]{2,60})/i,
];

// "soy X": la misma frase sirve para el nombre y para media docena de cosas más.
const AMBIGUOUS = [/\bsoy\s+([^\n.,;!?]{2,40})/i];

/**
 * @param {string} text        cuerpo del mensaje entrante
 * @param {object} opts
 * @param {boolean} opts.allowBare  aceptar un mensaje que sea SOLO el nombre
 *                                  (verdadero solo si el chat no tiene ninguno)
 * @returns {string} el nombre detectado, o '' si no hay nada seguro
 */
function contactNameFromText(text, { allowBare = false } = {}) {
  const body = String(text || '').trim();
  if (!body || body.length > 300) return '';

  for (const re of EXPLICIT) {
    const m = body.match(re);
    if (m) {
      const name = cleanName(m[1]);
      if (name) return name;
    }
  }

  for (const re of AMBIGUOUS) {
    const m = body.match(re);
    if (m) {
      // Aquí no se perdona nada: 1-3 palabras y todas con pinta de nombre.
      const name = cleanName(m[1], { maxWords: 3 });
      if (name) return name;
    }
  }

  // Mensaje que es SOLO un nombre ("Ana Pérez"), la respuesta típica a "¿cuál es
  // tu nombre?". Se exigen 2 palabras como mínimo: con una sola, cualquier
  // "Buenas" o "Emily" de paso renombraría el chat.
  if (allowBare) {
    const name = cleanName(body, { maxWords: 4 });
    if (name && name.split(' ').length >= 2) return name;
  }
  return '';
}

module.exports = { contactNameFromText, cleanName, wordLooksLikeName };
