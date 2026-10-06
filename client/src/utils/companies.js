/**
 * EMPRESAS en el cliente (oct-2026): agrupar sucursales por empresa. Las sucursales
 * llegan del servidor con `company: { _id, name }` (auth y /clinics?scope=names).
 */
export const companyKey = (clinic) => String(clinic?.company?._id || clinic?.company || '');

/**
 * ¿Son de la misma empresa estas dos sucursales? Al cambiar de empresa el servicio
 * elegido deja de valer (cada empresa tiene su catálogo) y el formulario lo limpia.
 */
export function sameCompany(clinics, a, b) {
  if (!a || !b) return true;
  const find = (id) => (clinics || []).find((c) => String(c._id) === String(id));
  return companyKey(find(a)) === companyKey(find(b));
}

/** Las sucursales activas agrupadas por empresa: [{ _id, name, clinics }]. */
export function companiesOf(clinics) {
  const map = new Map();
  for (const clinic of clinics || []) {
    if (clinic.active === false) continue;
    const key = companyKey(clinic);
    if (!map.has(key)) map.set(key, { _id: key, name: clinic.company?.name || 'Sin empresa', clinics: [] });
    map.get(key).clinics.push(clinic);
  }
  return [...map.values()];
}

/**
 * Para las listas que no se agrupan (filtros de workflows, envíos masivos): con más
 * de una empresa, el nombre de cada sucursal lleva delante el de su empresa, porque
 * dos empresas pueden tener una «Central». Con una sola, la lista no cambia.
 */
export function withCompanyLabels(clinics) {
  if (companiesOf(clinics).length <= 1) return clinics || [];
  return (clinics || []).map((c) => {
    const empresa = c.company?.name;
    if (!empresa) return c;
    return { ...c, name: `${empresa} · ${c.name}`, nombreComercial: `${empresa} · ${c.nombreComercial || c.name}` };
  });
}
