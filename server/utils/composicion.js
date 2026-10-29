/**
 * COMPOSICIÓN FIJA DE UN PRODUCTO COMPUESTO (29-10-2026).
 *
 * El caso: «ÁCIDO ALPHALIPOICO 10 ML» es un compuesto de Contífico hecho con medio frasco
 * del de 20 ml. No tiene stock propio (Contífico lo deja siempre en 0), así que al cobrarlo
 * salía «sin stock disponible» aunque hubiera frascos de 20 ml.
 *
 * `Product.composition` dice qué lleva UNA unidad del compuesto, en la unidad de cada
 * componente (10 ml = 0,5 × frasco de 20 ml). Con eso:
 *   · lo DISPONIBLE del compuesto es lo que alcanzan sus componentes;
 *   · al cobrarlo salen del inventario los componentes, no el compuesto (saleController,
 *     por la vía de los ítems vinculados: kardex, costo y anulación).
 *
 * Es distinto de `components`, que en la receta es la lista de los que PUEDEN componerlo
 * y el doctor elige (clinicalRecordController). La API de Contífico no entrega la
 * composición: se carga en la ficha del producto.
 */
const EPS = 1e-9;

/** Líneas válidas de la composición (producto y cantidad > 0). */
const lineasDe = (product) => (Array.isArray(product?.composition) ? product.composition : [])
  .filter((c) => c?.product && Number(c.quantity) > 0);

/** ¿Se vende por sus componentes? */
const tieneComposicion = (product) => !!product?.isComposite && lineasDe(product).length > 0;

/**
 * Unidades del compuesto que alcanzan los componentes. `stockDe(id)` devuelve el stock
 * de cada componente. Nunca negativo; un componente agotado deja el compuesto en 0.
 */
function disponibleCompuesto(product, stockDe) {
  const lineas = lineasDe(product);
  if (!lineas.length) return 0;
  return Math.max(0, Math.min(...lineas.map((c) => Math.floor((Number(stockDe(String(c.product?._id || c.product))) || 0) / Number(c.quantity) + EPS))));
}

/**
 * Añade `compositeAvailable` a los compuestos de una lista (objetos lean). No toca `stock`:
 * el inventario sigue mostrando el del producto tal cual.
 */
async function anotarDisponibles(products) {
  const compuestos = products.filter(tieneComposicion);
  if (!compuestos.length) return products;
  const Product = require('../models/Product');
  const ids = [...new Set(compuestos.flatMap((p) => lineasDe(p).map((c) => String(c.product?._id || c.product))))];
  const comps = new Map((await Product.find({ _id: { $in: ids } }).select('stock name unit').lean()).map((p) => [String(p._id), p]));
  for (const p of compuestos) {
    p.compositeAvailable = disponibleCompuesto(p, (id) => Number(comps.get(id)?.stock) || 0);
    // Nombre, unidad y stock de cada componente: para explicar al cobrar por qué no alcanza.
    p.composition = lineasDe(p).map((c) => {
      const comp = comps.get(String(c.product)) || {};
      return { product: c.product, quantity: c.quantity, productName: comp.name || '', unit: comp.unit || '', stock: Number(comp.stock) || 0 };
    });
  }
  return products;
}

/**
 * Sanea la composición que llega de la ficha: sin repetidos, sin el propio producto, sin
 * otros compuestos con composición (no se anidan), solo físicos y cantidad > 0. Si no llega
 * la lista, no se toca (edición parcial).
 */
async function saneaComposicion(body, selfId = null) {
  if (!Array.isArray(body.composition)) return;
  const { isValidObjectId } = require('mongoose');
  const Product = require('../models/Product');
  const vistos = new Set();
  const lineas = body.composition
    .map((c) => ({ product: String(c?.product?._id || c?.product || ''), quantity: Number(c?.quantity) }))
    .filter((c) => {
      if (!c.product || !isValidObjectId(c.product) || c.product === String(selfId || '') || vistos.has(c.product)) return false;
      vistos.add(c.product);
      return true;
    });
  for (const c of lineas) {
    if (!(Number.isFinite(c.quantity) && c.quantity > 0)) {
      throw Object.assign(new Error('Cada componente necesita una cantidad mayor que 0'), { status: 400 });
    }
  }
  const prods = await Product.find({ _id: { $in: lineas.map((c) => c.product) } }).select('name category unlimited isComposite composition').lean();
  const porId = new Map(prods.map((p) => [String(p._id), p]));
  for (const c of lineas) {
    const p = porId.get(c.product);
    if (!p) throw Object.assign(new Error('Un componente ya no existe en el inventario'), { status: 400 });
    if (p.unlimited || p.category === 'servicio') {
      throw Object.assign(new Error(`«${p.name}» es un servicio: la composición solo lleva productos con stock`), { status: 400 });
    }
    if (tieneComposicion(p)) {
      throw Object.assign(new Error(`«${p.name}» también es un compuesto: use sus componentes directamente`), { status: 400 });
    }
  }
  body.composition = lineas.map((c) => ({ product: c.product, quantity: +c.quantity.toFixed(4) }));
}

module.exports = { lineasDe, tieneComposicion, disponibleCompuesto, anotarDisponibles, saneaComposicion };
