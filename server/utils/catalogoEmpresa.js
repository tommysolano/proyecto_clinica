/**
 * EL INVENTARIO ES UNO SOLO PARA TODA LA EMPRESA (nov-2026, regla del usuario).
 *
 * Un producto no «pertenece» a la sucursal desde la que se creó: `Product.clinic` solo dice
 * quién lo registró. Las sucursales se separan con las BODEGAS (y el kardex por bodega), no
 * con el catálogo. Buscar un producto con `clinic: req.clinicId` lo escondía cuando se había
 * creado desde otra sucursal: el DMSO PLUS 50ML (creado en «Extensión») no salía en la toma
 * física de Central, y comprar/ajustar/descontar desde Central fallaba con «no encontrado» o
 * no actualizaba nada.
 *
 * `filtroCatalogo(clinicId)` devuelve el filtro de `clinic` para cualquier consulta de
 * productos: todas las sucursales de la empresa (las de otra empresa siguen fuera).
 * Depende del mapa de empresas en memoria, que `middleware/auth` calienta en cada petición;
 * sin mapa cargado cae a la sucursal sola (el comportamiento de antes).
 */
const mongoose = require('mongoose');
const { sisterClinicsSync, ensureCompanyCache } = require('./companies');

function clinicasDelCatalogo(clinicId) {
  const ids = sisterClinicsSync(String(clinicId), { includeInactive: true });
  return (ids.length ? ids : [String(clinicId)]).map((id) => new mongoose.Types.ObjectId(String(id)));
}

const filtroCatalogo = (clinicId) => ({ $in: clinicasDelCatalogo(clinicId) });

module.exports = { clinicasDelCatalogo, filtroCatalogo, ensureCompanyCache };
