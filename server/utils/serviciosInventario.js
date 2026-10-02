const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const Product = require('../models/Product');

/**
 * LOS SERVICIOS DE LA AGENDA SALEN DEL INVENTARIO (oct-2026).
 *
 * Lo que se elige al agendar una cita —y al derivar desde un seguimiento— son
 * los productos de tipo SERVICIO del inventario, sin poder escribir otra cosa.
 * Pero la cita NO pasa a guardar el producto: sigue guardando su
 * `AppointmentServiceItem`, porque de él cuelgan la duración, la marca de
 * enfermería, el suero de serie, las reglas de comisión por servicio y unas
 * treinta pantallas que lo leen como escalar. Esto mantiene un registro de la
 * agenda por cada servicio del inventario.
 *
 * SE CASAN POR NOMBRE (el `slug`, sin tildes ni mayúsculas). Es lo que hace que
 * el «Ecocardiograma» que ya existía en la agenda —con sus citas, su duración y
 * sus comisiones— pase a ser el ECOCARDIOGRAMA del inventario en vez de quedar
 * dos. Y dos productos que se llaman igual son UNA opción en la agenda: para
 * quien agenda son el mismo servicio.
 *
 * Lo que sale del inventario (producto borrado, desactivado o renombrado) no se
 * borra: se le quita el enlace. Las citas que ya lo usan conservan su nombre;
 * simplemente deja de ofrecerse.
 */

// Una vez por minuto basta: el inventario de servicios cambia poco y el
// listado lo pide cada formulario que se abre. Crear o editar un producto
// fuerza la siguiente (ver `marcarServiciosPendientes`).
const CADA_MS = 60 * 1000;
let ultima = 0;
let enCurso = null;

const COLORES = [
  '#0f766e', '#0369a1', '#7c3aed', '#be123c', '#b45309',
  '#15803d', '#a21caf', '#0e7490', '#4d7c0f', '#9f1239',
];
const colorPorNombre = (nombre) => {
  let h = 0;
  for (const c of String(nombre)) h = (h * 31 + c.charCodeAt(0)) % 100000;
  return COLORES[h % COLORES.length];
};

async function sincronizar() {
  const slugify = AppointmentServiceItem.slugify;
  const productos = await Product.find({ category: 'servicio', active: true })
    .select('name clinic createdAt')
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  // Un producto por nombre: el más antiguo manda (es el que lleva más tiempo
  // usándose y el que tiene la historia).
  const porSlug = new Map();
  for (const p of productos) {
    const name = String(p.name || '').replace(/\s+/g, ' ').trim();
    const slug = slugify(name);
    if (slug && !porSlug.has(slug)) porSlug.set(slug, { ...p, name });
  }

  const items = await AppointmentServiceItem.find({}).select('slug name product active').lean();
  const itemPorSlug = new Map(items.map((i) => [i.slug, i]));

  const ops = [];
  for (const [slug, p] of porSlug) {
    const it = itemPorSlug.get(slug);
    if (!it) {
      ops.push({
        insertOne: {
          document: {
            clinic: p.clinic,
            name: p.name,
            slug,
            color: colorPorNombre(p.name),
            product: p._id,
            active: true,
          },
        },
      });
      continue;
    }
    const set = {};
    if (String(it.product || '') !== String(p._id)) {
      set.product = p._id;
      // Recién enlazado: si alguien lo había dado de baja en el catálogo viejo,
      // vuelve, porque el inventario dice que el servicio existe.
      if (!it.product) set.active = true;
    }
    // Se escribe como en el inventario: es el nombre con el que se factura.
    if (it.name !== p.name) set.name = p.name;
    if (Object.keys(set).length) ops.push({ updateOne: { filter: { _id: it._id }, update: { $set: set } } });
  }
  for (const it of items) {
    if (it.product && !porSlug.has(it.slug)) {
      ops.push({ updateOne: { filter: { _id: it._id }, update: { $set: { product: null } } } });
    }
  }

  if (ops.length) {
    // `ordered: false`: si otra instancia insertó el mismo slug un instante
    // antes, ese choque (E11000) no frena el resto.
    await AppointmentServiceItem.bulkWrite(ops, { ordered: false }).catch((err) => {
      const errores = Array.isArray(err?.writeErrors) ? err.writeErrors : [];
      const soloDuplicados = err?.code === 11000 || (errores.length > 0 && errores.every((e) => e.code === 11000));
      if (!soloDuplicados) throw err;
    });
  }
  return { productos: porSlug.size, cambios: ops.length };
}

/**
 * Sincroniza si hace falta (como mucho una vez por minuto). `force` la hace
 * ya. Nunca rompe a quien la llama: si falla, el listado sale con lo que haya.
 */
async function sincronizarServiciosInventario({ force = false } = {}) {
  if (enCurso) return enCurso;
  if (!force && Date.now() - ultima < CADA_MS) return null;
  enCurso = sincronizar()
    .then((r) => { ultima = Date.now(); return r; })
    .finally(() => { enCurso = null; });
  return enCurso;
}

/** Un producto de servicio cambió: la próxima lectura vuelve a sincronizar. */
function marcarServiciosPendientes() {
  ultima = 0;
}

module.exports = { sincronizarServiciosInventario, marcarServiciosPendientes };
