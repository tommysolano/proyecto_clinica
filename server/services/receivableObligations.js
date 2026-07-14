/**
 * OBLIGACIONES ECONÓMICAS POR COBRAR: resolución ÚNICA de la cartera duplicada venta↔factura.
 *
 * Una venta a crédito que además se facturó puede tener DOS documentos de cartera para UNA
 * sola obligación económica (`scripts/migrateCarteraToSubledger` histórico abría cartera para
 * la venta Y para la factura). Sumarlas dos veces infla el flujo de caja y la antigüedad.
 *
 * Este servicio es la ÚNICA fuente de verdad de esa resolución: lo consumen el motor del flujo
 * de caja, el reporte de antigüedad, su exportación, el cobro/anulación de una factura y el
 * script de diagnóstico. No se duplica la lógica en ningún controlador.
 *
 * ── Identidad económica (inequívoca o nada) ──────────────────────────────────────────────
 * Dos documentos son la MISMA obligación solo si `Sale.invoice` apunta a la factura y ambos
 * son de la misma clínica. NUNCA se deduce por importe, cliente, fecha ni número iguales: dos
 * documentos legítimamente distintos con el mismo valor no se fusionan.
 *
 * ── Clasificación ───────────────────────────────────────────────────────────────────────
 *   UNICA                    → solo hay una cartera (o ninguna): nada que resolver.
 *   SAFE_DUPLICATE           → ninguna tiene actividad, o las dos reflejan LOS MISMOS cobros.
 *                              Consolidable automáticamente.
 *   DIVERGENT_BUT_RESOLVABLE → la actividad real está en UNA sola de las dos. Se usa como
 *                              saldo económico la que CONTIENE la actividad (no siempre la
 *                              venta: si los cobros se aplicaron a la factura, manda la factura).
 *   AMBIGUOUS                → aplicaciones distintas en ambas, importes que no concilian o
 *                              una anulación reflejada solo en una. NO se oculta ninguna: se
 *                              alerta, se muestran las dos referencias y se BLOQUEA la
 *                              consolidación automática hasta que alguien lo resuelva a mano.
 *
 * ── Saldo económico ─────────────────────────────────────────────────────────────────────
 *   saldo = importe original − cobros reales ÚNICOS
 * Los cobros se deduplican por `Payment._id`: el mismo cobro reflejado en los dos submayores
 * se cuenta UNA vez. Para AMBIGUOUS se aplica una política CONSERVADORA y explícita: se toma
 * el mayor cobro demostrable (el máximo entre lo aplicado en cada cartera y la suma de cobros
 * únicos) y el menor importe original, de modo que la cartera nunca quede sobrestimada.
 *
 * Este servicio es de SOLO LECTURA: no modifica, borra ni mueve aplicaciones históricas.
 */
const Receivable = require('../models/Receivable');
const Sale = require('../models/Sale');
const Payment = require('../models/Payment');

const r2 = (n) => +(Number(n) || 0).toFixed(2);
const EPS = 0.005;
const TOL = 0.01;

const RESOLUTION = {
  UNICA: 'UNICA',
  SAFE: 'SAFE_DUPLICATE',
  DIVERGENT: 'DIVERGENT_BUT_RESOLVABLE',
  AMBIGUOUS: 'AMBIGUOUS',
};

const withSession = (q, session) => (session ? q.session(session) : q);

/**
 * Ventas con factura enlazada. El ámbito se acota con `saleIds`/`invoiceIds` (el flujo solo
 * mira la cartera abierta); sin ámbito, devuelve TODOS los pares de la clínica (la antigüedad).
 */
async function findLinkedSales({ clinicId, saleIds = null, invoiceIds = null, session = null }) {
  const q = { clinic: clinicId, invoice: { $ne: null } };
  const or = [];
  if (saleIds?.length) or.push({ _id: { $in: saleIds } });
  if (invoiceIds?.length) or.push({ invoice: { $in: invoiceIds } });
  if (saleIds && invoiceIds && !or.length) return [];   // ámbito pedido pero vacío
  if (or.length) q.$or = or;
  return withSession(
    Sale.find(q).select('invoice saleNumber total balance clientName patient createdAt dueDate status').lean(),
    session
  );
}

/** Cobros (registrados y anulados) que tocan cualquiera de los documentos de los pares. */
async function loadCollections({ clinicId, docRefs, session }) {
  if (!docRefs.length) return [];
  return withSession(
    Payment.find({
      clinic: clinicId,
      type: 'COBRO',
      'applications.docRef': { $in: docRefs },
    }).select('number date total status applications').lean(),
    session
  );
}

/**
 * Cobros del par, deduplicados por `Payment._id`. Un mismo cobro aplicado a la venta Y a la
 * factura es UN cobro, no dos: se cuenta una sola vez (por eso se toma el máximo de las dos
 * aplicaciones y no su suma).
 */
function collectionsOfPair(pagos, saleId, invoiceId) {
  const cobros = [];
  for (const p of pagos) {
    let onSale = 0;
    let onInvoice = 0;
    for (const a of p.applications || []) {
      if (!a.docRef || !a.amount) continue;
      if (a.docModel === 'Sale' && String(a.docRef) === saleId) onSale = r2(onSale + a.amount);
      if (a.docModel === 'Invoice' && String(a.docRef) === invoiceId) onInvoice = r2(onInvoice + a.amount);
    }
    if (!onSale && !onInvoice) continue;
    cobros.push({
      paymentId: String(p._id),
      numero: p.number || '',
      date: p.date,
      status: p.status,
      onSale,
      onInvoice,
      // El importe económico del cobro: el mismo pago reflejado en las dos carteras cuenta una vez.
      amount: r2(Math.max(onSale, onInvoice)),
      enAmbas: onSale > EPS && onInvoice > EPS,
    });
  }
  return cobros;
}

/** Clasifica el par y elige el documento canónico. Ver la cabecera del fichero. */
function classifyPair({ venta, rv, rf, cobros }) {
  const registrados = cobros.filter((c) => c.status !== 'ANULADO');
  const anulados = cobros.filter((c) => c.status === 'ANULADO');
  const cobrosUnicos = r2(registrados.reduce((s, c) => s + c.amount, 0));

  const SALE = { sourceModel: 'Sale', sourceRef: String(venta._id) };
  const INV = { sourceModel: 'Invoice', sourceRef: String(venta.invoice) };

  // Sin las dos carteras no hay duplicidad de submayor, pero SÍ dos documentos fuente (venta y
  // factura) que la antigüedad mostraría por separado: el par se resuelve igual, en una fila.
  if (!rv || !rf) {
    const cxc = rv || rf;
    const canonical = rv ? SALE : (rf ? INV : SALE);
    const total = cxc ? r2(cxc.total) : r2(venta.total);
    // Sin cartera (clínica no migrada) el saldo sale de los documentos, con la MISMA regla:
    // manda el documento que tiene la actividad.
    const applied = cxc ? r2(cxc.applied) : r2(Number(venta.total || 0) - Number(venta.balance || 0));
    return {
      resolution: RESOLUTION.UNICA,
      reason: cxc
        ? `Una sola cartera (${rv ? 'la de la venta' : 'la de la factura'}): no hay duplicidad de submayor.`
        : 'Sin cartera en el submayor: el saldo sale de los documentos fuente.',
      canonical,
      total,
      applied,
      cobrosUnicos,
      anulados,
      autoFixable: true,
    };
  }

  const totalV = r2(rv.total);
  const totalF = r2(rf.total);
  const appliedV = r2(rv.applied);
  const appliedF = r2(rf.applied);
  const actV = appliedV > EPS;
  const actF = appliedF > EPS;
  const mismoTotal = Math.abs(totalV - totalF) <= TOL;

  const regSale = r2(registrados.reduce((s, c) => s + c.onSale, 0));
  const regInv = r2(registrados.reduce((s, c) => s + c.onInvoice, 0));
  // ¿Lo aplicado en cada cartera está respaldado por cobros REGISTRADOS? Si no lo está y hay
  // cobros ANULADOS de por medio, la anulación se reflejó en una sola: nadie puede afirmar
  // cuál de las dos dice la verdad.
  const explicadoV = Math.abs(appliedV - regSale) <= TOL;
  const explicadoF = Math.abs(appliedF - regInv) <= TOL;
  const anulacionAsimetrica = anulados.length > 0 && (!explicadoV || !explicadoF);

  const base = { cobrosUnicos, anulados };
  const ambiguo = (reason, applied) => ({
    ...base,
    resolution: RESOLUTION.AMBIGUOUS,
    reason,
    // Se informa cuál tiene más actividad, pero NO se oculta la otra ni se consolida sola.
    canonical: appliedF > appliedV ? INV : SALE,
    // Política conservadora y explícita: el mayor cobro demostrable y el menor importe original.
    total: mismoTotal ? totalV : Math.min(totalV, totalF),
    applied: Math.max(appliedV, appliedF, cobrosUnicos, applied || 0),
    autoFixable: false,
  });

  if (!mismoTotal) {
    return ambiguo(`Los importes originales no concilian (venta ${totalV.toFixed(2)} · factura ${totalF.toFixed(2)}).`);
  }
  if (anulacionAsimetrica) {
    return ambiguo('Hay un cobro anulado cuya reversión no se reflejó en las dos carteras: '
      + `aplicado venta ${appliedV.toFixed(2)} · factura ${appliedF.toFixed(2)} · cobros vigentes ${cobrosUnicos.toFixed(2)}.`);
  }
  if (!actV && !actF) {
    return { ...base, resolution: RESOLUTION.SAFE, reason: 'Ninguna de las dos carteras tiene cobros aplicados.',
      canonical: SALE, total: totalV, applied: 0, autoFixable: true };
  }
  if (actV && !actF) {
    return { ...base, resolution: RESOLUTION.DIVERGENT, canonical: SALE, total: totalV, applied: appliedV,
      autoFixable: true,
      reason: `Los cobros están aplicados solo sobre la cartera de la VENTA (${appliedV.toFixed(2)}).` };
  }
  if (!actV && actF) {
    return { ...base, resolution: RESOLUTION.DIVERGENT, canonical: INV, total: totalF, applied: appliedF,
      autoFixable: true,
      reason: `Los cobros están aplicados solo sobre la cartera de la FACTURA (${appliedF.toFixed(2)}). `
        + 'La venta no se actualizó: manda la factura, que es donde está la actividad real.' };
  }

  // Las dos tienen actividad: solo es seguro si es EL MISMO cobro reflejado en ambas.
  const mismosCobros = registrados.length > 0
    && registrados.every((c) => c.enAmbas && Math.abs(c.onSale - c.onInvoice) <= TOL)
    && Math.abs(appliedV - appliedF) <= TOL
    && explicadoV && explicadoF;
  if (mismosCobros) {
    return { ...base, resolution: RESOLUTION.SAFE, canonical: SALE, total: totalV, applied: appliedV,
      autoFixable: true,
      reason: `Las dos carteras reflejan los MISMOS ${registrados.length} cobro(s) (${cobrosUnicos.toFixed(2)}): `
        + 'se cuentan una sola vez.' };
  }
  return ambiguo('Las dos carteras tienen aplicaciones distintas: '
    + `venta ${appliedV.toFixed(2)} · factura ${appliedF.toFixed(2)} · cobros únicos ${cobrosUnicos.toFixed(2)}.`);
}

/**
 * Resuelve las obligaciones económicas por cobrar de una clínica.
 *
 * @param {object}   o
 * @param {ObjectId} o.clinicId
 * @param {Array}    [o.saleIds]     acota el ámbito (ventas candidatas)
 * @param {Array}    [o.invoiceIds]  acota el ámbito (facturas candidatas)
 * @returns {{ obligations, byReceivable, bySale, byInvoice, ambiguas, duplicadas }}
 *   · `obligations`  una entrada por obligación ECONÓMICA (no por documento).
 *   · `byReceivable` Map(receivableId → { obligation, canonical:boolean }): lo que el flujo
 *      necesita para saber si una cartera suma o solo se muestra como duplicada.
 */
async function resolveReceivableEconomicObligations({ clinicId, saleIds = null, invoiceIds = null, session = null } = {}) {
  const vacio = {
    obligations: [], byReceivable: new Map(), bySale: new Map(), byInvoice: new Map(),
    ambiguas: [], duplicadas: [], summary: summarize([]),
  };
  const ventas = await findLinkedSales({ clinicId, saleIds, invoiceIds, session });
  if (!ventas.length) return vacio;

  const sIds = ventas.map((v) => v._id);
  const iIds = ventas.map((v) => v.invoice);
  const [cxc, pagos] = await Promise.all([
    withSession(Receivable.find({
      clinic: clinicId,
      $or: [
        { sourceModel: 'Sale', sourceRef: { $in: sIds } },
        { sourceModel: 'Invoice', sourceRef: { $in: iIds } },
      ],
    }).lean(), session),
    loadCollections({ clinicId, docRefs: [...sIds, ...iIds], session }),
  ]);

  const cxcSale = new Map();
  const cxcInv = new Map();
  for (const c of cxc) {
    if (c.sourceModel === 'Sale') cxcSale.set(String(c.sourceRef), c);
    else if (c.sourceModel === 'Invoice') cxcInv.set(String(c.sourceRef), c);
  }

  const out = { ...vacio, byReceivable: new Map(), bySale: new Map(), byInvoice: new Map() };
  for (const venta of ventas) {
    const saleId = String(venta._id);
    const invoiceId = String(venta.invoice);
    const rv = cxcSale.get(saleId) || null;
    const rf = cxcInv.get(invoiceId) || null;
    const cobros = collectionsOfPair(pagos, saleId, invoiceId);
    const c = classifyPair({ venta, rv, rf, cobros });

    const canonicalCxc = c.canonical.sourceModel === 'Sale' ? rv : rf;
    const otraCxc = c.canonical.sourceModel === 'Sale' ? rf : rv;
    const total = r2(c.total);
    const applied = Math.min(r2(c.applied), total);
    const saldo = Math.max(0, r2(total - applied));
    // Un saldo AMBIGUO es una ESTIMACIÓN, no cartera conciliada: se informa aparte para que
    // nadie lo lea como dinero confirmado. El flujo puede usarlo (es conservador), pero
    // etiquetado como estimado.
    const ambigua = c.resolution === RESOLUTION.AMBIGUOUS;

    const obligation = {
      key: `Sale:${saleId}`,
      resolution: c.resolution,
      reason: c.reason,
      autoFixable: c.autoFixable,
      canonical: c.canonical,
      venta: { id: saleId, numero: venta.saleNumber || '', total: r2(venta.total), balance: r2(venta.balance) },
      factura: { id: invoiceId },
      receivables: {
        venta: rv ? { id: String(rv._id), total: r2(rv.total), applied: r2(rv.applied), balance: r2(rv.balance), status: rv.status } : null,
        factura: rf ? { id: String(rf._id), total: r2(rf.total), applied: r2(rf.applied), balance: r2(rf.balance), status: rf.status } : null,
      },
      canonicalReceivableId: canonicalCxc ? String(canonicalCxc._id) : null,
      duplicateReceivableId: otraCxc ? String(otraCxc._id) : null,
      cobros,
      cobrosUnicos: r2(c.cobrosUnicos),
      anulaciones: c.anulados.map((a) => ({ paymentId: a.paymentId, numero: a.numero, amount: a.amount })),
      // Saldo ECONÓMICO: el mismo que usan el flujo, la antigüedad y su exportación.
      total,
      applied,
      balance: saldo,
      // Presentación: confirmado ≠ estimado. `operationalBalance` es lo que usa el flujo.
      operationalBalance: saldo,
      confirmedBalance: ambigua ? 0 : saldo,
      ambiguousEstimatedBalance: ambigua ? saldo : 0,
      requiresReview: ambigua,
      estimado: ambigua,
      formula: ambigua
        ? `${total.toFixed(2)} (menor importe original de los dos documentos) − ${applied.toFixed(2)} `
          + `(mayor cobro demostrable) = ${saldo.toFixed(2)} ESTIMADO — requiere conciliación humana`
        : `${total.toFixed(2)} − ${applied.toFixed(2)} (cobros únicos) = ${saldo.toFixed(2)}`,
      party: {
        name: canonicalCxc?.party?.name || venta.clientName || '',
        ref: canonicalCxc?.party?.ref || venta.patient || null,
      },
      issueDate: canonicalCxc?.issueDate || venta.createdAt || null,
      dueDate: canonicalCxc?.dueDate || venta.dueDate || null,
      plannedPaymentDate: canonicalCxc?.plannedPaymentDate || null,
      numero: venta.saleNumber || canonicalCxc?.number || '',
    };

    out.obligations.push(obligation);
    out.bySale.set(saleId, obligation);
    out.byInvoice.set(invoiceId, obligation);
    if (rv) out.byReceivable.set(String(rv._id), { obligation, canonical: c.canonical.sourceModel === 'Sale' });
    if (rf) out.byReceivable.set(String(rf._id), { obligation, canonical: c.canonical.sourceModel === 'Invoice' });
    if (rv && rf) out.duplicadas.push(obligation);
    if (ambigua) out.ambiguas.push(obligation);
  }
  out.summary = summarize(out.obligations);
  return out;
}

/**
 * Resumen que NUNCA mezcla lo conciliado con lo estimado.
 *   confirmedBalance          → obligaciones resueltas de forma segura;
 *   ambiguousEstimatedBalance → estimación conservadora de las ambiguas (NO es cartera conciliada);
 *   operationalBalance        → lo que usa el flujo de caja (la suma de las dos).
 */
function summarize(rows) {
  const s = {
    confirmedBalance: 0, ambiguousEstimatedBalance: 0, operationalBalance: 0, ambiguousCount: 0,
  };
  for (const o of rows) {
    s.confirmedBalance = r2(s.confirmedBalance + (o.confirmedBalance || 0));
    s.ambiguousEstimatedBalance = r2(s.ambiguousEstimatedBalance + (o.ambiguousEstimatedBalance || 0));
    s.operationalBalance = r2(s.operationalBalance + (o.operationalBalance ?? o.balance ?? 0));
    if (o.requiresReview) s.ambiguousCount += 1;
  }
  s.warning = s.ambiguousCount
    ? `${s.ambiguousCount} obligación(es) tienen dos carteras que no concilian: su saldo `
      + `(${s.ambiguousEstimatedBalance.toFixed(2)}) es una ESTIMACIÓN conservadora, no cartera `
      + 'confirmada, y requiere conciliación humana.'
    : null;
  return s;
}

/**
 * Documento de cartera sobre el que debe aplicarse un cobro/una anulación de un documento.
 *
 * Cobrar desde la FACTURA de una venta enlazada tiene que reducir la obligación económica
 * canónica (y anular el cobro devolvérselo a la MISMA), o el saldo se repartiría entre dos
 * carteras y el par se volvería irresoluble.
 *
 * Si el par es AMBIGUOUS no se redirige nada: mover aplicaciones en un caso que ya no concilia
 * solo empeoraría el diagnóstico. Se aplica donde pide el documento y la alerta sigue viva.
 *
 * @returns {{sourceModel, sourceRef, redirected, resolution}|null} null → usar el documento tal cual.
 */
async function canonicalReceivableTarget({ clinicId, sourceModel, sourceRef, session = null } = {}) {
  if (!['Sale', 'Invoice'].includes(sourceModel)) return null;
  const res = await resolveReceivableEconomicObligations({
    clinicId,
    saleIds: sourceModel === 'Sale' ? [sourceRef] : [],
    invoiceIds: sourceModel === 'Invoice' ? [sourceRef] : [],
    session,
  });
  const obl = sourceModel === 'Sale' ? res.bySale.get(String(sourceRef)) : res.byInvoice.get(String(sourceRef));
  if (!obl) return null;
  if (obl.resolution === RESOLUTION.AMBIGUOUS) return null;
  return {
    sourceModel: obl.canonical.sourceModel,
    sourceRef: obl.canonical.sourceRef,
    redirected: obl.canonical.sourceModel !== sourceModel,
    resolution: obl.resolution,
    obligation: obl,
  };
}

/**
 * ¿Sobre QUÉ cartera se aplicó realmente un cobro ANTIGUO (sin `applications[].appliedTo`)?
 *
 * Los cobros nuevos guardan su destino. Los históricos no, y con una venta facturada puede
 * haber DOS carteras: si se anula contra la que no era, una queda reducida para siempre y la
 * otra recibe un saldo que nunca tuvo. Y el destino NO puede deducirse recalculando el
 * documento canónico con los saldos de hoy: los saldos de hoy ya incluyen el efecto del cobro
 * que se está anulando, así que eso sería razonar en círculo.
 *
 * Se reconstruye por EVIDENCIA: cuánto de lo aplicado en cada cartera NO está explicado por los
 * demás cobros vigentes (`residuo`). Si el residuo de una cartera es exactamente el importe de
 * esta aplicación, esa cartera lo contiene de forma demostrable.
 *
 *   · una sola lo demuestra           → se des-aplica ahí;
 *   · las dos lo demuestran           → es el MISMO cobro espejado en las dos (cartera duplicada):
 *                                       se devuelve el saldo a las dos, pero el efecto ECONÓMICO
 *                                       es UNO (solo la canónica suma en el flujo y en el aging);
 *   · ninguna refleja nada (residuos 0) → el cobro nunca tocó el submayor (bug histórico): se
 *                                       anula sin tocar cartera;
 *   · hay saldo aplicado que no cuadra con este cobro → se BLOQUEA: no se adivina.
 *
 * @returns {{target, mirror, blocked, reason, message}} `target: null` ⇒ no hay nada que des-aplicar.
 */
async function legacyUnapplyTarget({ clinicId, payment, application, session = null } = {}) {
  const invoiceId = String(application.docRef);
  const monto = r2(application.amount);
  const INV = { sourceModel: 'Invoice', sourceRef: application.docRef };

  const venta = await withSession(
    Sale.findOne({ clinic: clinicId, invoice: application.docRef }).select('_id saleNumber').lean(),
    session
  );
  // Sin venta enlazada no hay dos carteras posibles: manda el propio documento (como siempre).
  if (!venta) return { target: INV, mirror: null, blocked: false, reason: 'SIN_VINCULO' };

  const saleId = String(venta._id);
  const [cxc, otros] = await Promise.all([
    withSession(Receivable.find({
      clinic: clinicId,
      $or: [
        { sourceModel: 'Sale', sourceRef: venta._id },
        { sourceModel: 'Invoice', sourceRef: application.docRef },
      ],
    }).lean(), session),
    withSession(Payment.find({
      clinic: clinicId,
      type: 'COBRO',
      status: 'REGISTRADO',
      _id: { $ne: payment._id },
      'applications.docRef': { $in: [venta._id, application.docRef] },
    }).select('applications').lean(), session),
  ]);
  const rv = cxc.find((c) => c.sourceModel === 'Sale') || null;
  const rf = cxc.find((c) => c.sourceModel === 'Invoice') || null;
  const SALE = { sourceModel: 'Sale', sourceRef: venta._id };

  // Lo aplicado por los DEMÁS cobros vigentes sobre cada documento.
  let otrosVenta = 0;
  let otrosFactura = 0;
  for (const p of otros) {
    for (const a of p.applications || []) {
      if (!a.docRef || !a.amount) continue;
      if (a.docModel === 'Sale' && String(a.docRef) === saleId) otrosVenta = r2(otrosVenta + a.amount);
      if (a.docModel === 'Invoice' && String(a.docRef) === invoiceId) otrosFactura = r2(otrosFactura + a.amount);
    }
  }
  const residuoVenta = rv ? r2(rv.applied - otrosVenta) : 0;
  const residuoFactura = rf ? r2(rf.applied - otrosFactura) : 0;
  const demVenta = !!rv && Math.abs(residuoVenta - monto) <= TOL;
  const demFactura = !!rf && Math.abs(residuoFactura - monto) <= TOL;

  if (demVenta && demFactura) {
    return {
      target: SALE, mirror: INV, blocked: false, reason: 'ESPEJADO_EN_AMBAS',
      message: 'El cobro está reflejado en las dos carteras (venta y factura) de la misma obligación.',
    };
  }
  if (demVenta) return { target: SALE, mirror: null, blocked: false, reason: 'EVIDENCIA_EN_VENTA' };
  if (demFactura) return { target: INV, mirror: null, blocked: false, reason: 'EVIDENCIA_EN_FACTURA' };

  // Ninguna cartera refleja NADA sin explicar: este cobro nunca llegó al submayor (durante mucho
  // tiempo cobrar una factura no aplicaba a su CxC). No hay nada que devolver y no hay duda.
  if (residuoVenta <= EPS && residuoFactura <= EPS) {
    return { target: null, mirror: null, blocked: false, reason: 'SIN_APLICACION_EN_CARTERA' };
  }

  return {
    target: null,
    mirror: null,
    blocked: true,
    reason: 'AMBIGUO',
    message: 'Este cobro es anterior al registro del destino de sus aplicaciones y no se puede demostrar '
      + `sobre qué cartera se aplicó: la venta ${venta.saleNumber || saleId} y su factura tienen `
      + `saldos aplicados que no cuadran con este cobro (${monto.toFixed(2)}) — sin explicar: venta `
      + `${residuoVenta.toFixed(2)}, factura ${residuoFactura.toFixed(2)}. Anularlo a ciegas descuadraría `
      + 'la cartera. Concílialo a mano (scripts/diagnoseDuplicateReceivables.js) y vuelve a intentarlo.',
  };
}

module.exports = {
  RESOLUTION,
  resolveReceivableEconomicObligations,
  canonicalReceivableTarget,
  legacyUnapplyTarget,
  summarize,
  classifyPair,
  collectionsOfPair,
  findLinkedSales,
};
