/**
 * Migración: Product.categoria (texto legacy) → InventoryCategory (kind INVENTARIO).
 *
 * Para cada clínica con productos físicos (tipo `insumo`, no ilimitados) que tengan
 * `categoria` pero no `inventoryCategory`:
 *   1. Normaliza el nombre (mayúsculas/tildes/espacios) para evitar duplicados.
 *   2. Reutiliza la InventoryCategory INVENTARIO que ya exista con ese nombre.
 *   3. Si no existe, la crea con cuentas por defecto de accountMap:
 *        assetAccount   = inventario        (1.1.04.01)
 *        expenseAccount = costoProductos    (5.1.01)
 *        incomeAccount  = ingresoProductos  (4.1.02)
 *   4. Asigna `inventoryCategory` al producto (mantiene `categoria` como legacy).
 *
 * NO sobrescribe categorías ni cuentas ya configuradas manualmente.
 * Idempotente: sólo toca productos con inventoryCategory null; en la 2ª corrida
 * no hay nada que migrar. Dry-run por defecto.
 *
 *   node scripts/migrateProductCategoriesToInventoryCategories.js            (dry-run)
 *   node scripts/migrateProductCategoriesToInventoryCategories.js --commit   (aplica)
 *   node scripts/migrateProductCategoriesToInventoryCategories.js --clinic=<id> --commit
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Product = require('../models/Product');
const InventoryCategory = require('../models/InventoryCategory');
const { getAccount } = require('../utils/accountMap');

/** Normaliza texto (mayúsculas/acentos/espacios) para comparar nombres de categoría. */
function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

/** Siguiente código INV-NNN libre para la clínica (evita colisiones). */
function nextCategoryCode(usedCodes) {
  let n = 1;
  let code;
  do { code = `INV-${String(n).padStart(3, '0')}`; n += 1; } while (usedCodes.has(code));
  usedCodes.add(code);
  return code;
}

/**
 * Ejecuta la migración. Asume mongoose YA conectado (para poder llamarse desde
 * tests). El CLI de abajo se encarga de connect/disconnect.
 *
 * @returns {Promise<{clinics, categoriesCreated, productsAssigned, productsSkipped}>}
 */
async function migrate({ commit = false, clinic = null, log = () => {} } = {}) {
  const base = clinic ? { clinic } : {};
  const clinicIds = clinic ? [clinic] : await Product.distinct('clinic', {
    category: 'insumo', unlimited: { $ne: true }, inventoryCategory: null,
    categoria: { $nin: [null, ''] },
  });

  const stats = { clinics: 0, categoriesCreated: 0, productsAssigned: 0, productsSkipped: 0 };

  for (const clinicId of clinicIds) {
    const products = await Product.find({
      ...base, clinic: clinicId, category: 'insumo', unlimited: { $ne: true },
      inventoryCategory: null, categoria: { $nin: [null, ''] },
    });
    if (!products.length) continue;
    stats.clinics += 1;

    // Índice de categorías INVENTARIO por nombre normalizado + códigos ocupados.
    const invCats = await InventoryCategory.find({ clinic: clinicId, kind: 'INVENTARIO' });
    const byNorm = new Map(invCats.map((cat) => [normName(cat.name), cat]));
    const usedCodes = new Set((await InventoryCategory.find({ clinic: clinicId }).select('code')).map((c) => c.code));

    // Cuentas por defecto (solo se resuelven/crean en modo commit).
    let inv = null; let cost = null; let income = null;
    if (commit) {
      inv = await getAccount(clinicId, 'inventario');
      cost = await getAccount(clinicId, 'costoProductos');
      income = await getAccount(clinicId, 'ingresoProductos');
    }

    for (const p of products) {
      const key = normName(p.categoria);
      if (!key) { stats.productsSkipped += 1; continue; }
      let cat = byNorm.get(key);
      if (!cat) {
        const code = nextCategoryCode(usedCodes);
        log(`  [${clinicId}] + categoría INVENTARIO "${p.categoria}" (${code})`);
        if (commit) {
          cat = await InventoryCategory.create({
            clinic: clinicId, code, name: p.categoria, kind: 'INVENTARIO', active: true,
            assetAccount: inv._id, expenseAccount: cost._id, incomeAccount: income._id,
          });
        } else {
          cat = { _id: null, name: p.categoria, __placeholder: true };
        }
        byNorm.set(key, cat);
        stats.categoriesCreated += 1;
      }
      log(`      → ${p.code} "${p.name}"  ⇐  "${cat.name}"`);
      if (commit && cat._id) {
        p.inventoryCategory = cat._id;
        await p.save(); // `categoria` (texto) se conserva como legacy.
      }
      stats.productsAssigned += 1;
    }
  }
  return stats;
}

async function main() {
  const opts = parseArgs();
  banner('Migración categorías de producto → InventoryCategory (INVENTARIO)', opts);
  await connect();
  try {
    const stats = await migrate({ commit: opts.commit, clinic: opts.clinic, log: console.log });
    console.log(`\nClínicas migradas: ${stats.clinics}. Categorías creadas: ${stats.categoriesCreated}. Productos asignados: ${stats.productsAssigned}. Omitidos: ${stats.productsSkipped}.`);
    if (opts.dryRun) console.log('DRY-RUN: nada se escribió. Usa --commit para aplicar.');
  } finally {
    await disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}

module.exports = { migrate, normName };
