const InventoryCategory = require('../models/InventoryCategory');

/** Normaliza texto (mayúsculas/acentos/espacios) para comparar nombres de categoría. */
function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita tildes/diacríticos
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

/**
 * Un producto es físico/inventariable cuando es de tipo `insumo` y no es ilimitado.
 * Los servicios y programas (ilimitados) no manejan inventario.
 */
function isPhysicalProduct(category, unlimited) {
  return category === 'insumo' && unlimited !== true;
}

const NOT_FOUND_MSG = 'La categoría contable de inventario no existe o no está configurada';

/**
 * Precarga las categorías INVENTARIO de una clínica y devuelve índices por id y
 * por nombre normalizado, para resolver muchas filas sin consultar la BD por fila.
 * Incluye activas e inactivas (para distinguir "no existe" de "inactiva").
 */
async function buildInventoryCategoryIndex(clinicId) {
  const cats = await InventoryCategory.find({ clinic: clinicId, kind: 'INVENTARIO' }).lean();
  const byId = new Map(cats.map((c) => [String(c._id), c]));
  const byName = new Map();
  for (const c of cats) byName.set(normName(c.name), c); // si hay nombres repetidos, gana el último
  return { cats, byId, byName };
}

/**
 * Resuelve la categoría contable de inventario para UNA fila de carga masiva,
 * usando el índice precargado. NO crea categorías.
 *
 * @param {Object}  args
 * @param {Object}  args.index      resultado de buildInventoryCategoryIndex
 * @param {boolean} args.physical   si el producto es físico/inventariable
 * @param {string}  [args.idValue]  candidato ObjectId (inventoryCategory / inventoryCategoryId)
 * @param {string}  [args.textValue] candidato por nombre (categoriaContable / categoria)
 * @returns {{ category: Object|null, error: string|null }}
 *   - category: doc de InventoryCategory si resolvió; null si no.
 *   - error: mensaje si la fila debe rechazarse (categoría inválida/inactiva, o
 *            físico sin categoría). null si no hay error (incluye no-físico sin categoría).
 */
function resolveInventoryCategoryForRow({ index, physical, idValue, textValue }) {
  const id = idValue != null ? String(idValue).trim() : '';
  const text = textValue != null ? String(textValue).trim() : '';

  if (id) {
    const cat = index.byId.get(id);
    if (!cat) return { category: null, error: physical ? NOT_FOUND_MSG : null };
    if (cat.active === false) return { category: null, error: `La categoría contable "${cat.name}" está inactiva` };
    return { category: cat, error: null };
  }
  if (text) {
    const cat = index.byName.get(normName(text));
    if (cat) {
      if (cat.active === false) return { category: null, error: `La categoría contable "${cat.name}" está inactiva` };
      return { category: cat, error: null };
    }
    return { category: null, error: physical ? NOT_FOUND_MSG : null };
  }
  return { category: null, error: physical ? NOT_FOUND_MSG : null };
}

module.exports = { normName, isPhysicalProduct, buildInventoryCategoryIndex, resolveInventoryCategoryForRow, NOT_FOUND_MSG };
