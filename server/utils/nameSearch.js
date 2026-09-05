/**
 * BUSCAR UN NOMBRE COMO LO DICE LA GENTE, no como está escrito en la base.
 *
 * El paciente se llama «TOMMY NELSON SOLANO PEÑAFIEL» y en el mostrador se le
 * conoce como «Tommy Solano». Con una sola expresión regular sobre el texto tal
 * cual —que es como estaba— eso no devolvía NADA: el buscador exigía escribir el
 * nombre entero, en el orden exacto, con sus tildes y sin un espacio de más. En
 * una recepción con el paciente delante eso es inservible, y lo que se hacía era
 * buscar por cédula o rendirse y crear el paciente otra vez.
 *
 * Aquí se busca **por palabras sueltas**: cada palabra tiene que aparecer en
 * ALGUNO de los campos, y el orden da igual. «solano tommy» encuentra lo mismo
 * que «tommy solano», y los espacios de más sobran solos.
 *
 * Y **sin tildes ni eñes**: «penafiel» encuentra «PEÑAFIEL» y al revés. Se hace
 * expandiendo cada letra a su clase de acentos en vez de guardar un campo
 * normalizado, para no tener que migrar los pacientes que ya existen ni
 * mantenerlo sincronizado en cada alta.
 *
 * NO cubre teléfonos: para eso está `phoneSearchRegex`, que compara dígitos y
 * tolera el 0 nacional y el indicativo de país. Quien busque por teléfono tiene
 * que combinar los dos (ver `getPatients`).
 *
 * Está ESPEJADO en el cliente en `client/src/utils/nameSearch.js` → `nameMatches`,
 * para los buscadores que se resuelven sobre una lista ya cargada. Si cambias
 * uno, cambia el otro.
 */

// Cada letra base con sus variantes acentuadas. La 'ñ' entra con la 'n' a
// propósito: es la confusión número uno al teclear un apellido.
const CLASES = {
  a: 'aáàäâã',
  e: 'eéèëê',
  i: 'iíìïî',
  o: 'oóòöôõ',
  u: 'uúùüû',
  n: 'nñ',
  c: 'cç',
};

/** Texto → minúsculas y sin tildes, para poder partirlo en palabras. */
const plano = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const ESCAPAR = /[.*+?^${}()|[\]\\]/;

/**
 * Una palabra → expresión regular que la encuentra escrita con o sin tildes.
 * `hola` queda como `h[oóòöôõ]l[aáàäâã]`.
 */
function regexDePalabra(palabra) {
  const patron = [...palabra]
    .map((c) => {
      if (CLASES[c]) return `[${CLASES[c]}]`;
      return ESCAPAR.test(c) ? `\\${c}` : c;
    })
    .join('');
  return new RegExp(patron, 'i');
}

/** El texto partido en palabras, ya normalizadas. '' y los espacios de más caen solos. */
function palabrasDe(texto) {
  return plano(texto).split(/\s+/).filter(Boolean);
}

/**
 * Condición de mongo para buscar `texto` en `campos`.
 *
 * Devuelve `{ $and: [ {$or: [...palabra1...]}, {$or: [...palabra2...]} ] }`:
 * TODAS las palabras tienen que estar, cada una en cualquiera de los campos. Es
 * lo que hace que «tommy solano» case con un nombre en un campo y un apellido en
 * otro — el caso que no funcionaba.
 *
 * Devuelve `null` si no hay nada que buscar, para que quien llama decida si eso
 * significa «todos» o «ninguno».
 */
function nameSearchFilter(texto, campos) {
  const palabras = palabrasDe(texto);
  if (!palabras.length || !campos?.length) return null;
  return {
    $and: palabras.map((p) => {
      const re = regexDePalabra(p);
      return { $or: campos.map((campo) => ({ [campo]: re })) };
    }),
  };
}

/** ¿Casan todas las palabras de `texto` con alguno de estos valores? (para listas en memoria) */
function nameMatches(texto, ...valores) {
  const palabras = palabrasDe(texto);
  if (!palabras.length) return true;
  const campos = valores.map((v) => plano(v));
  return palabras.every((p) => campos.some((c) => c.includes(p)));
}

module.exports = { nameSearchFilter, nameMatches, regexDePalabra, palabrasDe };
