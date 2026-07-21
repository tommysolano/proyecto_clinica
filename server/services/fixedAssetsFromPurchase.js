/**
 * ACTIVOS FIJOS QUE NACEN DE UNA COMPRA.
 *
 * Fuente única de la regla: la usan la compra (crear / editar / autorizar / re-contabilizar),
 * la anulación y el script de diagnóstico. No se duplica en ningún controlador.
 *
 * ── Qué se crea ─────────────────────────────────────────────────────────────────────────
 * Una línea `ACTIVO_FIJO` de 3 monitores son **TRES activos**, no uno: cada unidad se deprecia,
 * se ubica y se da de baja por separado. El costo de cada uno es `subtotal / cantidad`, y el
 * ÚLTIMO absorbe el centavo de redondeo para que la suma de los activos sea exactamente el
 * subtotal de la línea (y cuadre con el asiento de la compra).
 *
 * ── Identidad e idempotencia ────────────────────────────────────────────────────────────
 * `(clinic, purchaseInvoice, purchaseLineIndex, purchaseUnitIndex)` — respaldada por un índice
 * único parcial. Volver a contabilizar la compra RECONOCE cada activo por su identidad y lo
 * actualiza; no borra y recrea. El código anterior borraba los activos «sin depreciación» y
 * recreaba TODOS, así que una compra cuyo activo ya se había depreciado terminaba con DOS
 * activos (el viejo, intocable, y uno nuevo con otro código).
 *
 * ── Qué NUNCA se toca ───────────────────────────────────────────────────────────────────
 * Un activo con depreciación, dado de baja o vendido tiene historia contable: no se borra, no
 * se le cambia el costo ni las cuentas. Si la edición de la compra lo contradice, se BLOQUEA
 * con un mensaje contable claro.
 */
const FixedAsset = require('../models/FixedAsset');
const InventoryCategory = require('../models/InventoryCategory');
const { normalizeAssetConfig, assetCategoryIssues } = require('../utils/fixedAssetConfig');

const r2 = (n) => +Number(n || 0).toFixed(2);
const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });
const withSession = (q, session) => (session ? q.session(session) : q);

/** ¿El activo ya tiene historia contable? Entonces es intocable. */
function tieneHistoria(a) {
  return Number(a.accumulatedDepreciation || 0) > 0.005
    || (a.history || []).length > 0
    || a.status !== 'ACTIVO';
}

/**
 * COSTO CAPITALIZABLE de una línea de activo fijo.
 *
 * Es el `subtotal` de la línea: el precio unitario × cantidad **menos el descuento**, sin IVA
 * (el IVA de una compra va a crédito tributario, no al costo del activo) — exactamente la misma
 * base con la que `postPurchaseJournal` debita la cuenta de activo. Por eso la suma de los
 * activos de la línea tiene que ser ese subtotal al centavo: si no, el módulo de activos y el
 * mayor dirían cosas distintas.
 */
function capitalizableCost(item) {
  return r2(item.subtotal);
}

/**
 * Unidades de activo fijo que declara una compra. Función PURA: los tests y el diagnóstico la
 * ejercitan sin base de datos.
 *
 * @returns {Array<{lineIndex, lineId, unitIndex, units, cost, item}>} una entrada POR UNIDAD.
 */
function plannedAssetUnits(inv) {
  const out = [];
  (inv.items || []).forEach((it, lineIndex) => {
    if (it.lineType !== 'ACTIVO_FIJO') return;
    // Un activo fijo es un bien INDIVIDUALIZABLE: 2,5 laptops no existen. Una cantidad decimal
    // no se redondea a la callada (eso repartiría mal el costo): se rechaza.
    const qty = Number(it.quantity);
    if (!(qty > 0) || Math.abs(qty - Math.round(qty)) > 1e-9) {
      throw badRequest(
        `La línea de activo fijo "${it.description}" tiene una cantidad decimal (${it.quantity}). `
        + 'Un activo fijo se individualiza por unidades enteras: usa una cantidad entera o separa la línea.'
      );
    }
    const units = Math.round(qty);
    const subtotal = capitalizableCost(it);
    const unitario = r2(subtotal / units);
    for (let unitIndex = 0; unitIndex < units; unitIndex += 1) {
      // La última unidad absorbe el redondeo: Σ costos = costo capitalizable de la línea, exacto.
      const cost = unitIndex === units - 1 ? r2(subtotal - unitario * (units - 1)) : unitario;
      out.push({ lineIndex, lineId: it.lineId || null, unitIndex, units, cost, item: it });
    }
  });
  return out;
}

/** Siguiente código libre `AF-####` de la clínica (no depende de `countDocuments`, que se repite). */
async function nextAssetCode(clinicId, usados, session) {
  const existentes = await withSession(
    FixedAsset.find({ clinic: clinicId, code: /^AF-\d+$/ }).select('code').lean(),
    session
  );
  let max = 0;
  for (const a of [...existentes.map((x) => x.code), ...usados]) {
    const m = /^AF-(\d+)$/.exec(a || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return (n) => `AF-${String(max + n).padStart(4, '0')}`;
}

/**
 * Sincroniza los activos fijos de una compra CONTABILIZADA.
 *
 * @returns {{creados, actualizados, conservados, eliminados}}
 */
async function syncFixedAssetsForInvoice(inv, { clinicId, userId, session = null } = {}) {
  const planeadas = plannedAssetUnits(inv);
  const existentes = await withSession(
    FixedAsset.find({ clinic: clinicId, purchaseInvoice: inv._id }),
    session
  );

  /**
   * Identidad de un activo dentro de la compra. Manda el `lineId` (estable): con él, borrar o
   * reordenar líneas NO rebindea los activos a la línea equivocada. El índice posicional solo
   * se usa con los activos/compras históricos que no tienen `lineId`.
   */
  const porLineId = new Map(
    existentes.filter((a) => a.purchaseLineId).map((a) => [`${a.purchaseLineId}:${a.purchaseUnitIndex}`, a])
  );
  // El índice sigue siendo la RED DE SEGURIDAD: el cliente puede reenviar las líneas sin su
  // `lineId` (un formulario que reconstruye el ítem), y ahí la posición es lo único que hay.
  // Se intenta primero por `lineId` —que sobrevive a reordenar y borrar líneas— y solo si no
  // hay, por posición; al casar por posición se re-ancla el `lineId` nuevo.
  const porIndice = new Map(
    existentes
      .filter((a) => a.purchaseLineIndex != null && a.purchaseUnitIndex != null)
      .map((a) => [`${a.purchaseLineIndex}:${a.purchaseUnitIndex}`, a])
  );
  // ÚLTIMO RECURSO: por CÓDIGO. Un activo de ESTA compra que ya usa el código personalizado que
  // esta unidad volvería a asignar es EL MISMO activo, aunque no lo reconozcan ni el `lineId` ni el
  // índice. Sin esto, reprocesar la compra (editar, o agregar una retención, que re-guarda la
  // compra) intentaba CREAR un segundo activo con ese código y reventaba con el crudo
  // `E11000 duplicate key {clinic, code}` en la cara del usuario. Ocurre con activos legacy sin
  // identidad de línea (creados antes de que existieran estos campos) y cuando se reordena o quita
  // una línea sin conservar su `lineId` (el front regenera el `lineId` en cada envío).
  const porCodigo = new Map(existentes.filter((a) => a.code).map((a) => [a.code, a]));
  const codigoDe = (p) => {
    const raw = p.item && p.item.fixedAsset && p.item.fixedAsset.code;
    return (raw && String(raw).trim() && p.units === 1) ? String(raw).trim() : null;
  };
  const buscarExistente = (p) => {
    if (p.lineId) {
      const porLinea = porLineId.get(`${p.lineId}:${p.unitIndex}`);
      if (porLinea) return porLinea;
    }
    const porPos = porIndice.get(`${p.lineIndex}:${p.unitIndex}`);
    if (porPos) return porPos;
    const cod = codigoDe(p);
    return (cod && porCodigo.get(cod)) || null;
  };

  const stats = {
    creados: 0, actualizados: 0, conservados: 0, eliminados: 0, huerfanos: [],
  };

  // ── Activos que ya NO declara la compra (se quitó la línea o bajó la cantidad) ──────────
  const vivos = new Set(planeadas.map((p) => String(buscarExistente(p)?._id || '')).filter(Boolean));
  for (const a of existentes) {
    // Los activos legacy (sin identidad de línea) NO se borran nunca: no sabemos a qué unidad
    // corresponden. Se informan para que el diagnóstico los revise.
    if (a.purchaseLineIndex == null || a.purchaseUnitIndex == null) {
      stats.huerfanos.push(String(a._id));
      stats.conservados += 1;
      continue;
    }
    if (vivos.has(String(a._id))) continue;
    if (tieneHistoria(a)) {
      throw badRequest(
        `No se puede quitar la unidad ${a.purchaseUnitIndex + 1} de la línea ${a.purchaseLineIndex + 1}: `
        + `el activo ${a.code} (${a.name}) ya tiene depreciación o baja registrada. `
        + 'Da de baja el activo por su propia vía antes de editar la compra.'
      );
    }
    await a.deleteOne({ session });
    stats.eliminados += 1;
  }

  if (!planeadas.length) return stats;

  const codigosNuevos = [];
  const codeFor = await nextAssetCode(clinicId, codigosNuevos, session);
  let nuevo = 0;

  for (const p of planeadas) {
    const fa = p.item.fixedAsset || {};
    const cat = fa.category
      ? await withSession(InventoryCategory.findOne({ _id: fa.category, clinic: clinicId }), session)
      : null;
    if (!cat) throw badRequest('La línea de activo fijo requiere una categoría de activo fijo');
    const issues = assetCategoryIssues(cat);
    if (issues.length) {
      throw badRequest(`La categoría de activo fijo no tiene configuración contable completa (falta: ${issues.join(', ')})`);
    }
    const cfg = normalizeAssetConfig(cat);   // fuente ÚNICA de cuentas y depreciación
    const residualValue = r2(p.cost * (cfg.residualPercent / 100));
    const monthly = (cfg.noDepreciate || !cfg.usefulLifeMonths)
      ? 0
      : r2((p.cost - residualValue) / cfg.usefulLifeMonths);
    const acqDate = fa.acquisitionDate || inv.fechaEmision || new Date();
    const sufijo = p.units > 1 ? ` (${p.unitIndex + 1}/${p.units})` : '';

    const contable = {
      category: cat._id,
      assetAccount: cfg.assetAccount,
      depreciationAccount: cfg.depreciationAccount,
      accumDepreciationAccount: cfg.accumDepreciationAccount,
      usefulLifeMonths: cfg.usefulLifeMonths,
      residualPercent: cfg.residualPercent,
      depreciationRate: cfg.depreciationRate,
      expenseType: cfg.expenseType,
      acquisitionCost: p.cost,
      residualValue,
      monthlyDepreciation: monthly,
      bookValue: p.cost,
    };
    const descriptivo = {
      name: ((fa.name && String(fa.name).trim()) || p.item.description) + sufijo,
      assetType: fa.assetType || null,
      serial: p.units > 1 ? '' : (fa.serial || ''),   // una serie no puede repetirse en 3 unidades
      location: fa.location || '',
      locationClinic: fa.locationClinic || null,
      responsible: fa.responsible || null,
      acquisitionDate: acqDate,
      startDate: fa.startDate || acqDate,
      // Trazabilidad de la compra (se conserva aunque la compra se edite después).
      purchaseInvoice: inv._id,
      journalEntry: inv.journalEntry || null,
      supplier: inv.supplier || null,
      costCenter: p.item.costCenter || null,
      warehouse: p.item.warehouse || null,
    };

    const ya = buscarExistente(p);
    if (ya) {
      // Con historia contable NO se reescribe el costo ni las cuentas: se conserva y se avisa.
      if (tieneHistoria(ya)) {
        if (Math.abs(Number(ya.acquisitionCost) - p.cost) > 0.01) {
          throw badRequest(
            `El activo ${ya.code} (${ya.name}) ya tiene depreciación registrada y la compra pretende `
            + `cambiar su costo de ${Number(ya.acquisitionCost).toFixed(2)} a ${p.cost.toFixed(2)}. `
            + 'Reescribir el costo de un activo depreciado falsearía la contabilidad: da de baja el '
            + 'activo o corrige por nota de crédito.'
          );
        }
        stats.conservados += 1;
        continue;
      }
      Object.assign(ya, contable, descriptivo);
      // La posición pudo cambiar (se borró una línea anterior): se reancla sin perder identidad.
      ya.purchaseLineIndex = p.lineIndex;
      ya.purchaseUnitIndex = p.unitIndex;
      if (p.lineId) ya.purchaseLineId = p.lineId;
      ya.updatedBy = userId;
      await ya.save({ session });
      stats.actualizados += 1;
    } else {
      nuevo += 1;
      const code = (fa.code && String(fa.code).trim() && p.units === 1)
        ? String(fa.code).trim()
        : codeFor(nuevo);
      codigosNuevos.push(code);
      const [asset] = await FixedAsset.create([{
        clinic: clinicId,
        code,
        ...contable,
        ...descriptivo,
        purchaseLineIndex: p.lineIndex,
        purchaseUnitIndex: p.unitIndex,
        purchaseLineId: p.lineId || null,
        accumulatedDepreciation: 0,
        createdBy: userId,
      }], session ? { session } : {});
      stats.creados += 1;
      // La línea recuerda el PRIMER activo creado (compatibilidad con la UI actual).
      if (p.unitIndex === 0) {
        p.item.fixedAsset = { ...fa, createdAsset: asset._id };
      }
    }
  }

  if (stats.creados > 0) await inv.save({ session });
  return stats;
}

/**
 * Qué hacer con los activos al ANULAR la compra.
 *
 * Un activo sin historia se elimina (nunca existió económicamente). Uno con depreciación, baja
 * o venta NO se toca ni se borra: tiene asientos. Se bloquea la anulación con un mensaje claro
 * para que el contador dé de baja el activo por su propia vía.
 */
async function removeFixedAssetsForInvoice(inv, { clinicId, session = null } = {}) {
  const assets = await withSession(
    FixedAsset.find({ clinic: clinicId, purchaseInvoice: inv._id }),
    session
  );
  const conHistoria = assets.filter(tieneHistoria);
  if (conHistoria.length) {
    throw badRequest(
      `No se puede anular la compra: ${conHistoria.length} activo(s) fijo(s) ya tienen depreciación o `
      + `baja registrada (${conHistoria.map((a) => a.code).join(', ')}). Borrarlos destruiría asientos `
      + 'contables. Da de baja los activos y reversa su depreciación antes de anular la compra.'
    );
  }
  let eliminados = 0;
  for (const a of assets) {
    await a.deleteOne({ session });
    eliminados += 1;
  }
  return { eliminados };
}

module.exports = {
  plannedAssetUnits,
  syncFixedAssetsForInvoice,
  removeFixedAssetsForInvoice,
  tieneHistoria,
};
