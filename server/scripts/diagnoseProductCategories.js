/**
 * DIAGNÓSTICO de la clasificación de productos y servicios (SOLO LECTURA).
 *
 * Ver `docs/TAXONOMIA_CATEGORIAS.md`. Aquí solo se REPORTA lo que no encaja:
 *
 *   · SERVICIO_INVENTARIABLE   → un servicio con categoría de inventario o con stock: o es un
 *                                producto mal tipado, o alguien le puso inventario a un servicio.
 *   · INVENTARIABLE_SIN_CATEGORIA → un insumo sin `inventoryCategory`: sus compras no saben a qué
 *                                cuenta van y el kardex no lo puede clasificar.
 *   · SIN_CATEGORIA_COMERCIAL  → no se puede agrupar en los reportes de ventas.
 *   · SOLO_LEGACY              → tiene las cuentas viejas por código de texto
 *                                (`costAccountCode` / `inventoryAccountCode`) y ninguna categoría.
 *
 * NO corrige nada: un producto mal clasificado puede tener compras, ventas y capas detrás, y
 * cambiarle la categoría le cambia las cuentas. Lo decide una persona.
 *
 *   node scripts/diagnoseProductCategories.js --clinic=<id>
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Product = require('../models/Product');
const InventoryLayer = require('../models/InventoryLayer');

/** Diagnóstico puro (las pruebas ejercitan ESTE código). */
async function diagnose({ clinic = null } = {}) {
  const base = clinic ? { clinic } : {};
  const productos = await Product.find(base)
    .select('code name category categoria inventoryCategory unlimited stock costAccountCode inventoryAccountCode active')
    .lean();

  const conCapas = new Set(
    (await InventoryLayer.distinct('product', { ...base, qtyRemaining: { $gt: 0 } })).map(String)
  );

  const stats = {
    revisados: productos.length,
    servicios: 0,
    inventariables: 0,
    servicioInventariable: 0,
    inventariableSinCategoria: 0,
    sinCategoriaComercial: 0,
    soloLegacy: 0,
  };
  const filas = [];

  for (const p of productos) {
    const esServicio = p.category === 'servicio' || p.unlimited === true;
    if (esServicio) stats.servicios += 1; else stats.inventariables += 1;

    const problemas = [];
    if (esServicio && (p.inventoryCategory || conCapas.has(String(p._id)) || Number(p.stock) > 0)) {
      problemas.push('SERVICIO_INVENTARIABLE');
      stats.servicioInventariable += 1;
    }
    if (!esServicio && !p.inventoryCategory) {
      problemas.push('INVENTARIABLE_SIN_CATEGORIA');
      stats.inventariableSinCategoria += 1;
    }
    if (!p.categoria) {
      problemas.push('SIN_CATEGORIA_COMERCIAL');
      stats.sinCategoriaComercial += 1;
    }
    if (!p.inventoryCategory && (p.costAccountCode || p.inventoryAccountCode)) {
      problemas.push('SOLO_LEGACY');
      stats.soloLegacy += 1;
    }
    if (!problemas.length) continue;

    filas.push({
      product: String(p._id),
      code: p.code,
      name: p.name,
      tipo: p.category,
      categoriaComercial: p.categoria || '',
      inventoryCategory: p.inventoryCategory ? String(p.inventoryCategory) : null,
      stock: p.stock,
      conCapas: conCapas.has(String(p._id)),
      problemas,
      // Un producto con historia (capas vivas) NO se puede reclasificar a la ligera.
      seguroDeCorregir: !conCapas.has(String(p._id)) && !(Number(p.stock) > 0),
    });
  }

  console.log('Resultado:');
  console.log(`  Productos revisados ................... ${stats.revisados}`);
  console.log(`  · servicios / no inventariables ....... ${stats.servicios}`);
  console.log(`  · inventariables ...................... ${stats.inventariables}`);
  console.log(`  SERVICIO con inventario (revisar) ..... ${stats.servicioInventariable}`);
  console.log(`  INVENTARIABLE sin categoría contable .. ${stats.inventariableSinCategoria}`);
  console.log(`  Sin categoría comercial ............... ${stats.sinCategoriaComercial}`);
  console.log(`  Solo con cuentas legacy por código .... ${stats.soloLegacy}`);

  for (const f of filas.slice(0, 100)) {
    console.log(`\n  ── ${f.code} ${f.name} · tipo ${f.tipo} · [${f.problemas.join(', ')}]`);
    console.log(`     comercial: ${f.categoriaComercial || '—'} · inventario: ${f.inventoryCategory || '—'}`
      + ` · stock ${f.stock} · capas vivas: ${f.conCapas ? 'sí' : 'no'}`);
    if (!f.seguroDeCorregir) {
      console.log('     Tiene existencias: reclasificarlo le cambia las cuentas. NO se toca solo.');
    }
  }
  if (!filas.length) console.log('\n  Todo clasificado.');
  return { ...stats, filas };
}

async function run() {
  const { clinic, dryRun } = parseArgs();
  banner('Diagnóstico: categorías de productos y servicios', { dryRun: true, clinic });
  void dryRun;
  await connect();
  try {
    return await diagnose({ clinic });
  } finally {
    await disconnect();
  }
}

if (require.main === module) {
  run().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}

module.exports = { run, diagnose };
