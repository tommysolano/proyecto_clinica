/**
 * USUARIOS INACTIVOS FUERA DE LOS BUSCADORES (oct-2026).
 *
 * Quien está marcado como inactivo no debe ofrecerse en ningún selector de
 * personal. `/users` los devuelve a propósito (la página de Usuarios los pinta
 * en gris para poder reactivarlos), así que cada selector que se alimenta de
 * ahí los quita con esto.
 *
 * `conservar`: ids ya elegidos que se mantienen aunque estén inactivos. Un
 * registro viejo asignado a alguien que ya no trabaja no debe quedarse con el
 * desplegable en blanco ni perder el dato al guardar sin tocarlo.
 */
export function soloActivos(lista = [], ...conservar) {
  const keep = new Set(conservar.flat().filter(Boolean).map(String));
  return (lista || []).filter((u) => u && (u.active !== false || keep.has(String(u._id))));
}
