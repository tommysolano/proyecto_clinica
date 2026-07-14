/**
 * DIAGNÓSTICO de activos fijos que deberían existir por una compra y no existen (o sobran).
 *
 * Motivo: en la reunión aparecieron compras con líneas de activo fijo cuyos activos no estaban
 * en el módulo. Las causas reales, comprobadas en el código, son varias y hay que distinguirlas
 * antes de tocar nada:
 *
 *   · SIN_CONTABILIZAR   → la compra está POR_AUTORIZAR (todas las importadas por XML/TXT nacen
 *                          así). Los activos se crean al CONTABILIZAR: no es un bug, pero nadie
 *                          lo veía. Se corrige autorizando la compra, no con este script.
 *   · FALTANTE           → compra contabilizada, línea de activo fijo, y falta el activo de esa
 *                          unidad. Antes se creaba UN activo por línea aunque la cantidad fuera
 *                          3, así que faltan las unidades 2..N.
 *   · COSTO_DE_LINEA     → existe un activo con el costo de la línea COMPLETA (el bug viejo):
 *                          hay que decidir a mano si se divide.
 *   · DUPLICADO          → dos o más activos para la misma unidad (los creaba el borra-y-recrea
 *                          cuando el activo ya tenía depreciación).
 *   · SIN_IDENTIDAD      → activo creado por una compra pero sin línea/unidad (histórico).
 *   · CONFIG_INCOMPLETA  → la categoría de activo fijo no tiene cuentas/vida útil: no se puede
 *                          crear el activo aunque se quiera.
 *
 * SOLO LECTURA por defecto. `--commit` únicamente crea los activos FALTANTES de compras
 * contabilizadas cuya categoría está completa y que no tienen ningún activo ambiguo en la misma
 * línea: lo demostrablemente seguro. Nunca borra, nunca fusiona, nunca reescribe un activo con
 * depreciación.
 *
 *   node scripts/diagnoseFixedAssetsFromPurchases.js                    (todas, dry-run)
 *   node scripts/diagnoseFixedAssetsFromPurchases.js --clinic=<id>
 *   node scripts/diagnoseFixedAssetsFromPurchases.js --clinic=<id> --commit
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const FixedAsset = require('../models/FixedAsset');
const InventoryCategory = require('../models/InventoryCategory');
const { assetCategoryIssues } = require('../utils/fixedAssetConfig');
const { plannedAssetUnits, syncFixedAssetsForInvoice, tieneHistoria } = require('../services/fixedAssetsFromPurchase');

const money = (n) => Number(n || 0).toFixed(2);
const CONTABILIZADAS = ['REGISTRADA', 'PAGADA'];

/** Diagnóstico puro (sin conectar/desconectar): las pruebas ejercitan ESTE código. */
async function diagnose({ clinic = null, commit = false, userId = null } = {}) {
  const base = clinic ? { clinic } : {};
  const compras = await PurchaseInvoice.find({ ...base, 'items.lineType': 'ACTIVO_FIJO' })
    .sort({ fechaEmision: 1 });

  const stats = {
    comprasRevisadas: 0,
    lineasElegibles: 0,
    unidadesEsperadas: 0,
    activosExistentes: 0,
    faltantes: 0,
    duplicados: 0,
    sinIdentidad: 0,
    costoDeLinea: 0,
    sinContabilizar: 0,
    configIncompleta: 0,
    creados: 0,
    ambiguos: 0,
  };
  const casos = [];

  for (const inv of compras) {
    stats.comprasRevisadas += 1;
    const planeadas = plannedAssetUnits(inv);
    const lineas = new Set(planeadas.map((p) => p.lineIndex));
    stats.lineasElegibles += lineas.size;
    stats.unidadesEsperadas += planeadas.length;

    const assets = await FixedAsset.find({ clinic: inv.clinic, purchaseInvoice: inv._id }).lean();
    stats.activosExistentes += assets.length;

    const contabilizada = CONTABILIZADAS.includes(inv.status);
    if (!contabilizada) {
      stats.sinContabilizar += 1;
      casos.push({
        compra: inv, tipo: 'SIN_CONTABILIZAR', detalle:
          `Estado ${inv.status}: los activos se crean al contabilizar. Autorízala desde Compras.`,
        esperadas: planeadas.length, existentes: assets.length,
      });
      continue;
    }

    // ¿La categoría de cada línea permite crear el activo?
    const problemasConfig = [];
    for (const li of lineas) {
      const fa = inv.items[li].fixedAsset || {};
      const cat = fa.category
        ? await InventoryCategory.findOne({ _id: fa.category, clinic: inv.clinic }).lean()
        : null;
      if (!cat) { problemasConfig.push(`línea ${li + 1}: sin categoría de activo fijo`); continue; }
      const issues = assetCategoryIssues(cat);
      if (issues.length) problemasConfig.push(`línea ${li + 1} (${cat.name}): falta ${issues.join(', ')}`);
    }
    if (problemasConfig.length) {
      stats.configIncompleta += 1;
      casos.push({ compra: inv, tipo: 'CONFIG_INCOMPLETA', detalle: problemasConfig.join(' · '),
        esperadas: planeadas.length, existentes: assets.length });
      continue;
    }

    const porIdentidad = new Map();
    let sinIdentidad = 0;
    for (const a of assets) {
      if (a.purchaseLineIndex == null || a.purchaseUnitIndex == null) { sinIdentidad += 1; continue; }
      const k = `${a.purchaseLineIndex}:${a.purchaseUnitIndex}`;
      porIdentidad.set(k, [...(porIdentidad.get(k) || []), a]);
    }
    stats.sinIdentidad += sinIdentidad;

    const duplicados = [...porIdentidad.entries()].filter(([, v]) => v.length > 1);
    stats.duplicados += duplicados.length;

    const faltan = planeadas.filter((p) => !porIdentidad.has(`${p.lineIndex}:${p.unitIndex}`));
    // Un activo histórico con el costo de la LÍNEA completa (el bug viejo): no es un faltante
    // cualquiera, hay que decidir a mano si se divide en unidades.
    const costoDeLinea = assets.filter((a) => {
      const li = a.purchaseLineIndex;
      const item = li != null ? inv.items[li] : null;
      const units = item ? Math.max(1, Math.round(Number(item.quantity) || 1)) : 1;
      return units > 1 && Math.abs(Number(a.acquisitionCost) - Number(item.subtotal)) <= 0.01;
    });
    stats.costoDeLinea += costoDeLinea.length;

    // Ambiguo: hay activos que no encajan (duplicados, sin identidad o con el costo de la línea).
    // No se toca nada: crear los que faltan podría duplicar el valor del activo.
    const ambiguo = duplicados.length > 0 || sinIdentidad > 0 || costoDeLinea.length > 0;
    if (ambiguo) stats.ambiguos += 1;

    if (!faltan.length && !ambiguo) continue;
    stats.faltantes += faltan.length;

    casos.push({
      compra: inv,
      tipo: ambiguo ? 'AMBIGUO' : 'FALTANTE',
      detalle: ambiguo
        ? `duplicados: ${duplicados.length} · sin identidad: ${sinIdentidad} · con costo de línea: ${costoDeLinea.length}`
        : `faltan ${faltan.length} unidad(es) de ${planeadas.length}`,
      esperadas: planeadas.length,
      existentes: assets.length,
      faltan,
      corregible: !ambiguo && faltan.length > 0,
    });

    if (commit && !ambiguo && faltan.length) {
      // Seguro: la compra está contabilizada, la categoría está completa, no hay nada ambiguo y
      // el servicio es idempotente por identidad (no puede duplicar lo que ya existe).
      const doc = await PurchaseInvoice.findById(inv._id);
      const r = await syncFixedAssetsForInvoice(doc, { clinicId: inv.clinic, userId });
      stats.creados += r.creados;
    }
  }

  console.log('Resultado:');
  console.log(`  Compras con líneas de activo fijo ..... ${stats.comprasRevisadas}`);
  console.log(`  Líneas elegibles ...................... ${stats.lineasElegibles}`);
  console.log(`  Unidades de activo esperadas .......... ${stats.unidadesEsperadas}`);
  console.log(`  Activos existentes .................... ${stats.activosExistentes}`);
  console.log(`  · FALTANTES ........................... ${stats.faltantes}`);
  console.log(`  · duplicados (misma unidad) ........... ${stats.duplicados}`);
  console.log(`  · sin identidad de línea (histórico) .. ${stats.sinIdentidad}`);
  console.log(`  · con el costo de la LÍNEA completa ... ${stats.costoDeLinea}`);
  console.log(`  Compras SIN contabilizar .............. ${stats.sinContabilizar}`);
  console.log(`  Compras con categoría incompleta ...... ${stats.configIncompleta}`);
  console.log(`  Compras AMBIGUAS (no se tocan) ........ ${stats.ambiguos}`);
  if (commit) console.log(`  Activos CREADOS ....................... ${stats.creados}`);

  for (const c of casos) {
    const inv = c.compra;
    console.log(`\n  ── ${inv.serie || inv._id} · ${new Date(inv.fechaEmision).toLocaleDateString('es-EC')} · `
      + `${money(inv.total)} · [${c.tipo}]`);
    console.log(`     Estado: ${inv.status} · esperadas ${c.esperadas} · existentes ${c.existentes}`);
    console.log(`     ${c.detalle}`);
    if (c.tipo === 'AMBIGUO') {
      console.log('     NO se corrige solo: revisar a mano (podría duplicar el valor del activo).');
    } else if (c.corregible) {
      console.log(`     Corregible automáticamente: ${commit ? 'CREADO' : 'usa --commit'}`);
    }
  }

  if (stats.sinContabilizar) {
    console.log('\n  Las compras importadas (XML/TXT) nacen POR_AUTORIZAR y sus activos NO existen');
    console.log('  hasta que se contabilizan. Ese es el motivo más frecuente de "el activo no aparece".');
  }
  if (!casos.length) console.log('\n  Todas las compras contabilizadas tienen sus activos.');

  return { ...stats, casos };
}

async function run() {
  const { clinic, commit, dryRun } = parseArgs();
  banner('Diagnóstico: activos fijos de compras', { dryRun, clinic });
  await connect();
  try {
    return await diagnose({ clinic, commit });
  } finally {
    await disconnect();
  }
}

if (require.main === module) {
  run().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}

module.exports = { run, diagnose, tieneHistoria };
