/**
 * BUSCAR UN NOMBRE COMO LO DICE LA GENTE — espejo de `server/utils/nameSearch.js`.
 *
 * El paciente se llama «TOMMY NELSON SOLANO PEÑAFIEL» y en el mostrador se le
 * conoce como «Tommy Solano». Comparando la cadena entera con `includes()` eso
 * no encuentra NADA: hay que escribir el nombre en el orden exacto, con sus
 * tildes y sin un espacio de más.
 *
 * Aquí se compara **por palabras sueltas** (todas tienen que estar, en cualquier
 * campo y en cualquier orden) y **sin tildes ni eñes**.
 *
 * Esto es para los buscadores que filtran una lista YA CARGADA en el navegador.
 * Los que preguntan al servidor usan `nameSearchFilter` allí, y las dos reglas
 * tienen que ir a la par: si cambias una, cambia la otra.
 */
const plano = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** ¿Casan todas las palabras de `texto` con alguno de estos valores? */
export function nameMatches(texto, ...valores) {
  const palabras = plano(texto).split(/\s+/).filter(Boolean);
  // Sin nada escrito no se filtra: la lista se ve entera.
  if (!palabras.length) return true;
  const campos = valores.map((v) => plano(v));
  return palabras.every((p) => campos.some((c) => c.includes(p)));
}

export default nameMatches;
