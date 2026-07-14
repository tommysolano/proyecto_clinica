/**
 * MOTOR ÚNICO del flujo de caja diario.
 *
 * Todo (la API, el detalle de una celda, las alertas y el Excel) sale de aquí: no hay una
 * segunda fórmula en el frontend ni en la exportación. Es de SOLO LECTURA: consultar el
 * flujo jamás crea asientos, pagos ni aplicaciones.
 *
 * ── Fuentes de verdad ────────────────────────────────────────────────────────────────
 *   · saldo de caja y bancos → LIBRO MAYOR (JournalEntry sobre las cuentas configuradas)
 *   · obligaciones por pagar → SUBMAYOR (Payable.balance)
 *   · obligaciones por cobrar → SUBMAYOR (Receivable.balance)
 *   · previsiones sin documento → CashFlowManualItem
 *
 * ── Cómo se evita el doble conteo (la regla dura) ────────────────────────────────────
 * Cada día toma DOS cosas distintas que no pueden solaparse:
 *   (a) lo REAL: los movimientos del mayor sobre las cuentas de caja/banco de ese día;
 *   (b) lo PROYECTADO: el SALDO ABIERTO de las obligaciones cuya fecha efectiva cae ese día.
 * Pagar una CxP hace las dos cosas a la vez: crea el asiento (entra en «a») y reduce
 * `Payable.balance` (sale de «b»). Por eso una compra, su CxP y su pago nunca se cuentan
 * tres veces, y una factura cobrada a medias solo proyecta el resto.
 * Lo mismo del lado del ingreso: una venta al contado no abre CxC (solo la porción a
 * crédito la abre), así que el cobro real es su único registro.
 * La nómina y las declaraciones SRI entran EXCLUSIVAMENTE por su CxP (Fase 1): no se vuelve
 * a sumar `Payroll.totalNeto` ni el total de la declaración.
 */
const mongoose = require('mongoose');

const JournalEntry = require('../models/JournalEntry');
const ChartOfAccount = require('../models/ChartOfAccount');
const Payable = require('../models/Payable');
const Receivable = require('../models/Receivable');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const CashFlowConfig = require('../models/CashFlowConfig');
const CashFlowMapping = require('../models/CashFlowMapping');
const CashFlowManualItem = require('../models/CashFlowManualItem');
const CashFlowPlan = require('../models/CashFlowPlan');
const { getAccount } = require('../utils/accountMap');
const { effectivePaymentDate, nextBusinessDay, isBusinessDay, dayKey } = require('../utils/paymentSchedule');
const { defaultCategories, MODULE_DEFAULTS, SIN_CLASIFICAR } = require('../utils/cashFlowCategories');
const { resolveReceivableEconomicObligations } = require('./receivableObligations');

const r2 = (n) => +(Number(n) || 0).toFixed(2);
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

/**
 * Fecha del cliente ('2026-07-13') a Date LOCAL.
 *
 * `new Date('2026-07-13')` la interpretaría como medianoche UTC, que en Ecuador (UTC−5) es
 * el día ANTERIOR a las 19:00: el rango entero se correría un día y el Excel dejaría de
 * cuadrar con la API. Todo el sistema trabaja en America/Guayaquil (ver docs), así que una
 * fecha sin hora es medianoche LOCAL.
 */
function parseLocalDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value);
  const s = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ═══════════════════════════ CONFIGURACIÓN ═══════════════════════════

/**
 * Configuración de la clínica (find-or-create). La creación es idempotente: si dos
 * peticiones simultáneas la crean, el índice único deja una y se devuelve esa.
 */
async function getConfig(clinicId) {
  let cfg = await CashFlowConfig.findOne({ clinic: clinicId });
  if (cfg) {
    if (!cfg.categories?.INGRESO?.length) {
      const def = defaultCategories();
      cfg.categories = def;
      await cfg.save();
    }
    return cfg;
  }
  try {
    cfg = await CashFlowConfig.create({ clinic: clinicId, categories: defaultCategories() });
  } catch (e) {
    if (e.code !== 11000) throw e;
    cfg = await CashFlowConfig.findOne({ clinic: clinicId });
  }
  return cfg;
}

/**
 * Cuentas que forman el disponible. NUNCA se deducen del nombre («todo lo que diga banco»).
 * Prioridad:
 *   1. las cuentas configuradas explícitamente en CashFlowConfig;
 *   2. si no hay ninguna, los ROLES contables `caja`, `cajaChica` y `bancos`.
 * En ambos casos se añaden las cuentas HIJAS (jerarquía por código del plan) si la config
 * lo permite. El conjunto se deduplica por id, así que configurar a la vez una cuenta padre
 * y una hija NO puede duplicar el saldo: cada línea del asiento pertenece a una sola cuenta.
 */
async function resolveCashAccounts(clinicId, cfg) {
  const explicit = [...(cfg.cashAccounts || []), ...(cfg.bankAccounts || [])].map(String);
  let roots;
  if (explicit.length) {
    roots = await ChartOfAccount.find({ clinic: clinicId, _id: { $in: explicit.map(oid) } }).lean();
  } else {
    const porRol = await Promise.all(
      ['caja', 'cajaChica', 'bancos'].map((rol) => getAccount(clinicId, rol).catch(() => null))
    );
    roots = porRol.filter(Boolean).map((a) => (a.toObject ? a.toObject() : a));
  }
  if (!roots.length) return { accounts: [], ids: [], byId: new Map() };

  let all = roots;
  if (cfg.includeChildAccounts !== false) {
    const prefixes = roots.map((a) => `${a.code}.`);
    const hijas = await ChartOfAccount.find({
      clinic: clinicId,
      $or: prefixes.map((p) => ({ code: { $regex: `^${p.replace(/\./g, '\\.')}` } })),
    }).lean();
    all = [...roots, ...hijas];
  }
  // Dedupe por id: la consolidación padre/hijo no puede contar dos veces.
  const byId = new Map();
  for (const a of all) {
    const cashSet = new Set((cfg.cashAccounts || []).map(String));
    byId.set(String(a._id), {
      _id: a._id,
      code: a.code,
      name: a.name,
      kind: cashSet.has(String(a._id)) || /caja/i.test(a.name) ? 'CAJA' : 'BANCO',
    });
  }
  const ids = [...byId.keys()].map(oid);
  return { accounts: [...byId.values()].sort((a, b) => a.code.localeCompare(b.code)), ids, byId };
}

// ═══════════════════════════ SALDO INICIAL ═══════════════════════════

/**
 * Saldo del disponible al CIERRE del día anterior a `from`, leído del MAYOR.
 * Nunca de saldos manuales ni de `BankAccount.bookBalance` (que es un agregado de apoyo).
 *
 * Un solo `$group` por cuenta: no hay consulta por día ni por cuenta.
 */
async function openingBalance(clinicId, accountIds, from) {
  const cutoff = startOfDay(from);
  const base = { total: 0, cutoff, byAccount: [] };
  if (!accountIds.length) return base;

  const agg = await JournalEntry.aggregate([
    {
      $match: {
        clinic: oid(clinicId),
        status: 'CONTABILIZADO',
        date: { $lt: cutoff },
        'lines.account': { $in: accountIds },
      },
    },
    { $unwind: '$lines' },
    { $match: { 'lines.account': { $in: accountIds } } },
    {
      $group: {
        _id: '$lines.account',
        debit: { $sum: '$lines.debit' },
        credit: { $sum: '$lines.credit' },
      },
    },
  ]);
  const saldos = new Map(agg.map((a) => [String(a._id), r2((a.debit || 0) - (a.credit || 0))]));
  return { ...base, saldos };
}

// ═══════════════════════════ CLASIFICACIÓN ═══════════════════════════

/**
 * Reglas activas de la clínica, ordenadas por la prioridad del Bloque B:
 * tercero → cuenta/concepto → origen → descripción; y `priority` desempata dentro del tipo.
 */
async function loadMappings(clinicId) {
  const rules = await CashFlowMapping.find({ clinic: clinicId, isActive: true }).lean();
  const rank = CashFlowMapping.MATCH_RANK;
  return rules.sort((a, b) => (rank[a.matchType] - rank[b.matchType]) || (a.priority - b.priority));
}

/**
 * Clasifica un documento. Devuelve además POR QUÉ se asignó esa categoría (la UI lo muestra):
 *   OVERRIDE → REGLA(<tipo>) → MODULO → SIN_CLASIFICAR
 *
 * `attrs` trae los valores por los que una regla puede casar. Ninguna clasificación mira la
 * descripción salvo que exista una regla DESCRIPTION creada a mano por el usuario.
 */
function classify(attrs, mappings, plan) {
  if (plan?.category) {
    return { category: plan.category, subcategory: plan.subcategory || null, reason: 'OVERRIDE', ruleId: null };
  }
  const candidates = {
    SUPPLIER: attrs.partyRef,
    CUSTOMER: attrs.partyRef,
    ACCOUNT: attrs.accountIds,
    PURCHASE_CATEGORY: attrs.purchaseCategory,
    PAYROLL_CONCEPT: attrs.payrollConcept,
    SOURCE_MODEL: attrs.sourceModel,
    SOURCE_ACTION: attrs.sourceAction,
    DOC_TYPE: attrs.docType,
    DECLARATION_TYPE: attrs.declarationType,
    DESCRIPTION: attrs.description,
  };
  for (const rule of mappings) {
    if (rule.direction !== attrs.direction) continue;
    const value = candidates[rule.matchType];
    if (value == null) continue;
    let match = false;
    if (rule.matchType === 'DESCRIPTION') {
      match = String(value).toLowerCase().includes(String(rule.matchValue).toLowerCase());
    } else if (Array.isArray(value)) {
      match = value.some((v) => String(v) === String(rule.matchValue));
    } else {
      match = String(value) === String(rule.matchValue);
    }
    if (match) {
      return {
        category: rule.category,
        subcategory: rule.subcategory || null,
        reason: `REGLA_${rule.matchType}`,
        ruleId: rule._id,
      };
    }
  }
  const def = MODULE_DEFAULTS[`${attrs.docModel}:${attrs.sourceModel}`];
  if (def) return { ...def, reason: 'MODULO', ruleId: null };
  return { category: SIN_CLASIFICAR, subcategory: null, reason: 'SIN_CLASIFICAR', ruleId: null };
}

// ═══════════════════════════ CALENDARIO ═══════════════════════════

/** Días (columnas) del rango: hábiles según la configuración de la clínica. */
function buildDays(from, to, calendar) {
  const days = [];
  const cur = startOfDay(from);
  const last = startOfDay(to);
  while (cur <= last) {
    if (isBusinessDay(cur, calendar)) days.push(dayKey(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

/**
 * Columna a la que pertenece una fecha.
 *  · anterior al rango  → primer día (obligación vencida) o null si la config las oculta;
 *  · dentro del rango   → su día hábil (un domingo cae en el lunes);
 *  · posterior al rango → fuera del horizonte.
 *
 * `clampFuture` distingue los dos usos, que necesitan respuestas distintas:
 *   · una OBLIGACIÓN cuya fecha efectiva se sale del rango simplemente no entra: el dinero
 *     se mueve después de la ventana pedida y forzarla al último día sería mentir;
 *   · un movimiento REAL ya ocurrió y su importe está en el mayor. Si su fecha no tiene
 *     columna (un cobro en domingo cuyo lunes cae fuera del rango), se ancla al último día
 *     en vez de perderse: si no, el saldo final dejaría de conciliar con el mayor.
 */
function columnFor(date, days, calendar, { bucketPast = true, clampFuture = false } = {}) {
  if (!date || !days.length) return null;
  const d = startOfDay(date);
  const firstD = days[0];
  const lastD = days[days.length - 1];
  const k = dayKey(d);
  if (k < firstD) return bucketPast ? firstD : null;
  if (k > lastD) return clampFuture ? lastD : null;
  const shifted = dayKey(nextBusinessDay(d, calendar));
  if (shifted > lastD) return clampFuture ? lastD : null;
  return days.includes(shifted) ? shifted : null;
}

// ═══════════════════════════ TRANSFERENCIAS INTERNAS ═══════════════════════════

/**
 * Descompone las líneas de LIQUIDEZ de un asiento (las que tocan cuentas configuradas) en
 * su parte de transferencia INTERNA y su efecto EXTERNO real sobre el conjunto configurado.
 *
 * Un traspaso de Banco A a Banco B es un solo asiento con un débito y un crédito, ambos en
 * cuentas incluidas. Contando línea a línea, ese asiento inflaba a la vez los ingresos y los
 * egresos del día en 5.000 aunque el efecto consolidado de caja fuera CERO. Aquí se netea:
 *
 *     interno    = min(Σ entradas, Σ salidas)     → efecto consolidado nulo
 *     externalIn = Σ entradas − interno           → entrada real al conjunto
 *     externalOut= Σ salidas  − interno           → salida real del conjunto
 *
 * Con eso salen bien los cuatro casos:
 *   · Caja → Banco (ambas incluidas): interno = todo, efecto externo 0.
 *   · Incluida → NO incluida: no hay entradas, así que todo es salida real.
 *   · NO incluida → incluida: no hay salidas, así que todo es entrada real.
 *   · Traspaso con comisión bancaria (D BancoB 4.990 / D Gasto 10 / H BancoA 5.000):
 *     interno = 4.990 y queda un egreso REAL de 10, que es exactamente la comisión.
 * Y también con más de dos líneas de liquidez en el mismo asiento.
 */
function splitLiquidity(entry, accSet) {
  const liq = [];
  for (const l of entry.lines) {
    if (!accSet.has(String(l.account))) continue;
    const neto = r2((l.debit || 0) - (l.credit || 0));
    if (neto) liq.push({ line: l, neto });
  }
  const entradas = r2(liq.filter((x) => x.neto > 0).reduce((s, x) => s + x.neto, 0));
  const salidas = r2(liq.filter((x) => x.neto < 0).reduce((s, x) => s - x.neto, 0));
  const interno = r2(Math.min(entradas, salidas));
  return {
    liq,
    interno,
    externalIn: r2(entradas - interno),
    externalOut: r2(salidas - interno),
    origen: liq.filter((x) => x.neto < 0).map((x) => x.line),
    destino: liq.filter((x) => x.neto > 0).map((x) => x.line),
    contrapartidas: entry.lines.filter((l) => !accSet.has(String(l.account))).map((l) => String(l.account)),
  };
}

// ═══════════════════════════ PROYECCIÓN ═══════════════════════════

/**
 * Proyección diaria completa.
 *
 * @returns {{ config, cuentas, days[], detalle[], alertas[], totales, rango }}
 *   `days[i] = { date, saldoInicial, ingresos, egresos, saldoFinal, categorias, alertas }`
 *   `detalle` es la lista plana de TODO lo que compone las celdas (una fila por documento).
 *   La suma del detalle por (día, dirección, categoría) es exactamente la celda: el Excel y
 *   el modal de detalle se construyen desde aquí, así que no pueden discrepar.
 */
async function buildProjection(clinicId, { from, to, filters = {} } = {}) {
  const cfg = await getConfig(clinicId);
  const calendar = cfg.calendarOptions();

  const desde = startOfDay(parseLocalDate(from) || new Date());
  const hasta = endOfDay(parseLocalDate(to) || new Date(desde.getTime() + (cfg.defaultHorizonDays - 1) * 86400000));
  if (hasta < desde) throw badRequest('El rango de fechas es inválido: "hasta" es anterior a "desde".');
  const dias = Math.round((startOfDay(hasta) - desde) / 86400000) + 1;
  if (dias > cfg.maxRangeDays) {
    throw badRequest(`El rango solicitado (${dias} días) supera el máximo configurado (${cfg.maxRangeDays}).`);
  }

  const { accounts, ids: accountIds } = await resolveCashAccounts(clinicId, cfg);
  const days = buildDays(desde, hasta, calendar);
  if (!days.length) throw badRequest('El rango no contiene ningún día hábil.');

  const hoy = startOfDay(new Date());

  // ── Carga por lotes (sin N+1: una consulta por colección, no una por día ni por documento)
  const abierto = { clinic: clinicId, status: { $in: ['ABIERTO', 'PARCIAL'] }, balance: { $gt: 0.005 } };
  const [opening, mappings, payables, receivables, manuales] = await Promise.all([
    openingBalance(clinicId, accountIds, desde),
    loadMappings(clinicId),
    Payable.find(abierto).lean(),
    Receivable.find(abierto).lean(),
    CashFlowManualItem.find({ clinic: clinicId, status: 'PLANIFICADO', plannedDate: { $lte: hasta } }).lean(),
  ]);

  // Planes (override/exclusión) de todos los documentos de golpe.
  const docIds = [...payables, ...receivables, ...manuales].map((d) => d._id);
  const planes = await CashFlowPlan.find({ clinic: clinicId, docRef: { $in: docIds } }).lean();
  const planBy = new Map(planes.map((p) => [`${p.docModel}:${p.docRef}`, p]));

  // ── CxC DUPLICADAS entre una venta y su factura ──────────────────────────────────────
  // Una venta a crédito facturada pudo quedar con DOS carteras para UNA sola obligación
  // económica. La resolución NO se decide aquí: la da el servicio compartido, el mismo que usan
  // la antigüedad de cartera y su exportación, para que el flujo y el aging muestren SIEMPRE el
  // mismo saldo. El servicio elige el documento canónico (no siempre la venta: si los cobros se
  // aplicaron a la factura, manda la factura) y marca los casos AMBIGUOS, que se ven y se
  // alertan pero no se consolidan solos.
  const obligaciones = await resolveReceivableEconomicObligations({
    clinicId,
    saleIds: receivables.filter((r) => r.sourceModel === 'Sale').map((r) => r.sourceRef),
    invoiceIds: receivables.filter((r) => r.sourceModel === 'Invoice').map((r) => r.sourceRef),
  });
  const duplicadas = [];
  const ambiguas = [];

  // Cuentas de gasto de las compras: permiten reglas ACCOUNT sobre una CxP de proveedor.
  const compraIds = payables.filter((p) => p.sourceModel === 'PurchaseInvoice').map((p) => p.sourceRef);
  const compras = compraIds.length
    ? await PurchaseInvoice.find({ clinic: clinicId, _id: { $in: compraIds } })
      .select('items.account items.inventoryCategory').lean()
    : [];
  const cuentasCompra = new Map(compras.map((c) => [
    String(c._id),
    (c.items || []).map((i) => i.account).filter(Boolean).map(String),
  ]));

  // ── Estructura por día
  const porDia = new Map(days.map((d) => [d, {
    date: d,
    saldoInicial: 0,
    ingresos: 0,
    egresos: 0,
    saldoFinal: 0,
    ingresosReales: 0,
    egresosReales: 0,
    ingresosProyectados: 0,
    egresosProyectados: 0,
    categorias: {},                // { INGRESO: { CAT: { total, subs:{} } }, EGRESO: {...} }
    transferenciasInternas: 0,     // efecto consolidado CERO: no suma a ingresos ni egresos
    vencidas: 0,
    acumuladoVencido: 0,           // vencidos de antes del rango, arrastrados al primer día
    reprogramadas: 0,
    sinClasificar: 0,
  }]));

  const detalle = [];
  const bump = (day, direction, category, subcategory, amount) => {
    const d = porDia.get(day);
    if (!d) return;
    const dir = (d.categorias[direction] ||= {});
    const cat = (dir[category] ||= { total: 0, subs: {} });
    cat.total = r2(cat.total + amount);
    if (subcategory) cat.subs[subcategory] = r2((cat.subs[subcategory] || 0) + amount);
    if (direction === 'INGRESO') d.ingresos = r2(d.ingresos + amount);
    else d.egresos = r2(d.egresos + amount);
  };

  // ── 1. Obligaciones abiertas (PROYECTADO) ────────────────────────────────────────────
  const proyectar = (doc, docModel, direction) => {
    const plan = planBy.get(`${docModel}:${doc._id}`);
    const { effectiveDate, shifted, basedOn } = effectivePaymentDate(doc, calendar);
    const legalOverdue = !!(doc.dueDate && startOfDay(doc.dueDate) < hoy);
    const reprogramada = !!doc.plannedPaymentDate;

    const attrs = {
      docModel,
      direction,
      sourceModel: doc.sourceModel,
      sourceAction: null,
      docType: doc.docType,
      partyRef: doc.party?.ref ? String(doc.party.ref) : null,
      accountIds: docModel === 'Payable' ? (cuentasCompra.get(String(doc.sourceRef)) || []) : [],
      description: `${doc.party?.name || ''} ${doc.number || ''}`.trim(),
      declarationType: null,
    };
    const cls = classify(attrs, mappings, plan);

    const row = {
      id: String(doc._id),
      docModel,
      docRef: String(doc.sourceRef || doc._id),
      sourceModel: doc.sourceModel,
      direction,
      tercero: doc.party?.name || '—',
      terceroRef: attrs.partyRef,
      numero: doc.number || '',
      docType: doc.docType,
      issueDate: doc.issueDate || null,
      dueDate: doc.dueDate || null,
      plannedDate: doc.plannedPaymentDate || null,
      // Nombre de API del mismo dato en una CxC. El campo PERSISTIDO es uno solo
      // (`plannedPaymentDate`): no hay dos fechas que puedan divergir.
      ...(direction === 'INGRESO' ? { plannedCollectionDate: doc.plannedPaymentDate || null } : {}),
      effectiveDate,
      basedOn,
      desplazadaAHabil: shifted,
      total: r2(doc.total),
      aplicado: r2(doc.applied),
      saldo: r2(doc.balance),
      estado: doc.status,
      diasVencidos: doc.dueDate ? Math.floor((hoy - startOfDay(doc.dueDate)) / 86400000) : null,
      vencida: legalOverdue,
      reprogramada,
      excluida: !!plan?.excluded,
      excludedReason: plan?.excludedReason || '',
      category: cls.category,
      subcategory: cls.subcategory,
      clasificadaPor: cls.reason,
      notas: plan?.notes || '',
      esReal: false,
    };

    // Excluida a mano: no suma, pero se sigue viendo (con su motivo).
    if (plan?.excluded) { row.day = null; detalle.push(row); return; }

    // ── Obligación económica: una venta y su factura son UNA sola ──────────────────────
    const vinculo = docModel === 'Receivable' ? obligaciones.byReceivable.get(String(doc._id)) : null;
    if (vinculo) {
      const { obligation: o, canonical } = vinculo;
      row.resolution = o.resolution;
      row.resolutionReason = o.reason;
      row.formula = o.formula;
      // Un ambiguo se proyecta con el saldo conservador, pero NUNCA se presenta como un cobro
      // confirmado: la fila va marcada como estimada y con las dos referencias para abrirlas.
      row.estimado = o.requiresReview;
      row.requiresReview = o.requiresReview;
      row.vinculos = {
        venta: o.venta,
        factura: o.factura,
        carteraVenta: o.receivables.venta?.id || null,
        carteraFactura: o.receivables.factura?.id || null,
      };
      if (!canonical) {
        // La otra cartera del par ya representa esta obligación: se VE (con las dos
        // referencias y el motivo), pero NO suma. Nunca se borra ni se fusiona por nuestra
        // cuenta: eso es una decisión contable.
        row.day = null;
        row.duplicada = true;
        row.duplicadaDe = {
          docModel: 'Receivable',
          sourceModel: o.canonical.sourceModel,
          sourceRef: o.canonical.sourceRef,
          numero: o.numero,
        };
        duplicadas.push(row);
        if (o.resolution === 'AMBIGUOUS') ambiguas.push(row);
        detalle.push(row);
        return;
      }
      // Canónica: proyecta el saldo ECONÓMICO (cobros deduplicados por `Payment._id`), que es
      // exactamente el que muestra la antigüedad de cartera.
      row.saldo = o.balance;
      row.aplicado = o.applied;
      row.total = o.total;
      if (o.resolution === 'AMBIGUOUS') ambiguas.push(row);
    }

    const day = columnFor(effectiveDate, days, calendar, { bucketPast: cfg.overdueBucket === 'FIRST_DAY' });
    row.day = day;
    // Una obligación ABIERTA cuya proyección cae ANTES del rango no puede desaparecer: se
    // acumula en el primer día (marcada, con su fecha de proyección original intacta) y se
    // suma UNA sola vez. Aplica también a los históricos sin `dueDate` que se proyectan por
    // su emisión. `overdue` cubre las dos cosas: vencida legalmente o arrastrada del pasado.
    row.acumuladoVencido = !!(day && effectiveDate && dayKey(startOfDay(effectiveDate)) < days[0]);
    row.proyeccionOriginal = effectiveDate;
    row.overdue = legalOverdue || row.acumuladoVencido;
    detalle.push(row);
    if (!day) return;

    bump(day, direction, cls.category, cls.subcategory, row.saldo);
    const d = porDia.get(day);
    if (direction === 'INGRESO') d.ingresosProyectados = r2(d.ingresosProyectados + row.saldo);
    else d.egresosProyectados = r2(d.egresosProyectados + row.saldo);
    if (row.overdue) d.vencidas = r2(d.vencidas + row.saldo);
    if (row.acumuladoVencido) d.acumuladoVencido = r2((d.acumuladoVencido || 0) + row.saldo);
    if (reprogramada) d.reprogramadas = r2(d.reprogramadas + row.saldo);
    if (cls.category === SIN_CLASIFICAR) d.sinClasificar = r2(d.sinClasificar + row.saldo);
  };

  const pasaFiltro = (row) => {
    if (filters.category && row.category !== filters.category) return false;
    if (filters.subcategory && row.subcategory !== filters.subcategory) return false;
    if (filters.direction && row.direction !== filters.direction) return false;
    if (filters.party && !String(row.tercero || '').toLowerCase().includes(String(filters.party).toLowerCase())) return false;
    if (filters.onlyOverdue && !row.overdue) return false;
    if (filters.onlyRescheduled && !row.reprogramada) return false;
    if (filters.onlyUnclassified && row.category !== SIN_CLASIFICAR) return false;
    return true;
  };

  for (const p of payables) proyectar(p, 'Payable', 'EGRESO');
  for (const r of receivables) proyectar(r, 'Receivable', 'INGRESO');

  // ── 2. Partidas manuales (PROYECTADO, sin efecto contable) ───────────────────────────
  for (const m of manuales) {
    const plan = planBy.get(`CashFlowManualItem:${m._id}`);
    const { effectiveDate, shifted } = effectivePaymentDate(
      { plannedPaymentDate: m.plannedDate, dueDate: m.dueDate }, calendar
    );
    const legalOverdue = !!(m.dueDate && startOfDay(m.dueDate) < hoy);
    const row = {
      id: String(m._id),
      docModel: 'CashFlowManualItem',
      docRef: String(m._id),
      sourceModel: 'CashFlowManualItem',
      direction: m.direction,
      tercero: m.partyName || '—',
      terceroRef: m.partyRef ? String(m.partyRef) : null,
      numero: '',
      docType: m.origin,
      issueDate: m.createdAt,
      dueDate: m.dueDate || null,
      plannedDate: m.plannedDate,
      effectiveDate,
      basedOn: 'PLANIFICADA',
      desplazadaAHabil: shifted,
      total: r2(m.amount),
      aplicado: 0,
      saldo: r2(m.amount),
      estado: m.status,
      diasVencidos: m.dueDate ? Math.floor((hoy - startOfDay(m.dueDate)) / 86400000) : null,
      vencida: legalOverdue,
      reprogramada: (m.history || []).some((h) => h.field === 'plannedPaymentDate'),
      excluida: !!plan?.excluded,
      excludedReason: plan?.excludedReason || '',
      category: plan?.category || m.category,
      subcategory: plan?.subcategory || m.subcategory || null,
      clasificadaPor: plan?.category ? 'OVERRIDE' : 'MANUAL',
      descripcion: m.description,
      origin: m.origin,
      loan: m.origin === 'PRESTAMO' ? m.loan : null,
      notas: m.notes || '',
      esReal: false,
    };
    if (plan?.excluded) { row.day = null; detalle.push(row); continue; }
    const day = columnFor(effectiveDate, days, calendar, { bucketPast: cfg.overdueBucket === 'FIRST_DAY' });
    row.day = day;
    detalle.push(row);
    if (!day) continue;
    bump(day, m.direction, row.category, row.subcategory, row.saldo);
    const d = porDia.get(day);
    if (m.direction === 'INGRESO') d.ingresosProyectados = r2(d.ingresosProyectados + row.saldo);
    else d.egresosProyectados = r2(d.egresosProyectados + row.saldo);
    if (legalOverdue) d.vencidas = r2(d.vencidas + row.saldo);
    if (row.category === SIN_CLASIFICAR) d.sinClasificar = r2(d.sinClasificar + row.saldo);
  }

  // ── 3. Movimientos REALES del mayor dentro del rango ─────────────────────────────────
  // Son los del pasado y los de hoy. No pueden solaparse con lo proyectado porque cobrar o
  // pagar reduce el saldo del submayor (ver cabecera).
  const accSet = new Set(accountIds.map(String));
  const entries = accountIds.length
    ? await JournalEntry.find({
      clinic: clinicId,
      status: 'CONTABILIZADO',
      date: { $gte: desde, $lte: hasta },
      'lines.account': { $in: accountIds },
    }).lean()
    : [];

  for (const e of entries) {
    // Un movimiento REAL nunca se pierde: si su día no tiene columna, se ancla (ver
    // columnFor). Así el saldo final del rango sigue conciliando con el mayor.
    const day = columnFor(e.date, days, calendar, { bucketPast: true, clampFuture: true });
    if (!day) continue;
    const d = porDia.get(day);
    const s = splitLiquidity(e, accSet);
    if (!s.liq.length) continue;

    const filaBase = {
      docModel: 'JournalEntry',
      docRef: String(e.sourceRef || e._id),
      journalEntry: String(e._id),
      sourceModel: e.sourceModel,
      sourceAction: e.sourceAction,
      tercero: e.description || '—',
      numero: e.number,
      docType: null,
      issueDate: e.date,
      dueDate: null,
      plannedDate: null,
      effectiveDate: e.date,
      basedOn: 'REAL',
      desplazadaAHabil: false,
      saldo: 0,
      estado: 'REALIZADO',
      diasVencidos: null,
      vencida: false,
      overdue: false,
      reprogramada: false,
      excluida: false,
      descripcion: e.description || '',
      day,
      esReal: true,
    };

    // (a) TRANSFERENCIA INTERNA: el dinero cambia de cuenta pero no entra ni sale del
    // conjunto configurado. Se registra para poder verla, pero NO suma a ingresos ni a
    // egresos: su efecto consolidado es cero y el saldo del día no se mueve.
    if (s.interno > 0) {
      detalle.push({
        ...filaBase,
        id: `${e._id}:interno`,
        direction: 'INTERNO',
        transferenciaInterna: true,
        origen: s.origen.map((l) => ({ code: l.accountCode, name: l.accountName })),
        destino: s.destino.map((l) => ({ code: l.accountCode, name: l.accountName })),
        total: s.interno,
        aplicado: s.interno,
        category: 'TRANSFERENCIA_INTERNA',
        subcategory: null,
        clasificadaPor: 'TRANSFERENCIA_INTERNA',
      });
      d.transferenciasInternas = r2(d.transferenciasInternas + s.interno);
    }

    // (b) Efecto EXTERNO real sobre el conjunto (lo que de verdad entró o salió).
    const externo = [
      ['INGRESO', s.externalIn],
      ['EGRESO', s.externalOut],
    ];
    for (const [direction, monto] of externo) {
      if (monto <= 0) continue;
      const lineas = direction === 'INGRESO' ? s.destino : s.origen;
      const cls = classify({
        docModel: 'JournalEntry',
        direction,
        sourceModel: e.sourceModel,
        sourceAction: e.sourceAction,
        docType: null,
        partyRef: null,
        accountIds: s.contrapartidas,
        description: e.description || '',
        declarationType: null,
      }, mappings, null);

      detalle.push({
        ...filaBase,
        id: `${e._id}:${direction}`,
        direction,
        total: monto,
        aplicado: monto,
        category: cls.category,
        subcategory: cls.subcategory,
        clasificadaPor: cls.reason,
        cuenta: lineas[0]?.accountCode || null,
      });
      bump(day, direction, cls.category, cls.subcategory, monto);
      if (direction === 'INGRESO') d.ingresosReales = r2(d.ingresosReales + monto);
      else d.egresosReales = r2(d.egresosReales + monto);
      if (cls.category === SIN_CLASIFICAR) d.sinClasificar = r2(d.sinClasificar + monto);
    }
  }

  // ── 4. Filtros (se aplican al detalle Y a los totales: el Excel filtrado concilia) ────
  const hayFiltros = Object.values(filters).some((v) => v != null && v !== '' && v !== false);
  let detalleFinal = detalle;
  if (hayFiltros) {
    detalleFinal = detalle.filter(pasaFiltro);
    for (const d of porDia.values()) {
      Object.assign(d, {
        ingresos: 0, egresos: 0, ingresosReales: 0, egresosReales: 0,
        ingresosProyectados: 0, egresosProyectados: 0, transferenciasInternas: 0,
        categorias: {}, vencidas: 0, acumuladoVencido: 0, reprogramadas: 0, sinClasificar: 0,
      });
    }
    for (const row of detalleFinal) {
      if (!row.day) continue;
      const d = porDia.get(row.day);
      const monto = row.esReal ? row.total : row.saldo;
      // Las transferencias internas se ven pero no suman: efecto consolidado cero.
      if (row.transferenciaInterna) {
        d.transferenciasInternas = r2(d.transferenciasInternas + monto);
        continue;
      }
      bump(row.day, row.direction, row.category, row.subcategory, monto);
      if (row.esReal) {
        if (row.direction === 'INGRESO') d.ingresosReales = r2(d.ingresosReales + monto);
        else d.egresosReales = r2(d.egresosReales + monto);
      } else if (row.direction === 'INGRESO') d.ingresosProyectados = r2(d.ingresosProyectados + monto);
      else d.egresosProyectados = r2(d.egresosProyectados + monto);
      if (row.overdue) d.vencidas = r2(d.vencidas + monto);
      if (row.acumuladoVencido) d.acumuladoVencido = r2(d.acumuladoVencido + monto);
      if (row.reprogramada) d.reprogramadas = r2(d.reprogramadas + monto);
      if (row.category === SIN_CLASIFICAR) d.sinClasificar = r2(d.sinClasificar + monto);
    }
  }

  // ── 5. Roll-forward: el saldo final de un día es el inicial del siguiente ─────────────
  const saldosCuenta = opening.saldos || new Map();
  const cuentasConSaldo = accounts.map((a) => ({
    ...a,
    _id: String(a._id),
    saldoInicial: saldosCuenta.get(String(a._id)) || 0,
  }));
  let saldo = r2(cuentasConSaldo.reduce((s, a) => s + a.saldoInicial, 0));
  const saldoInicialTotal = saldo;

  const resultado = [];
  for (const k of days) {
    const d = porDia.get(k);
    d.saldoInicial = saldo;
    d.saldoFinal = r2(saldo + d.ingresos - d.egresos);
    saldo = d.saldoFinal;
    resultado.push(d);
  }

  // ── 6. Alertas ───────────────────────────────────────────────────────────────────────
  const alertas = [];
  const umbral = Number(cfg.minimumBalanceThreshold) || 0;
  for (const d of resultado) {
    if (d.saldoFinal < 0) {
      alertas.push({ tipo: 'SALDO_NEGATIVO', severidad: 'alta', date: d.date, valor: d.saldoFinal,
        mensaje: `El ${d.date} el saldo proyectado queda en ${d.saldoFinal.toFixed(2)}.` });
    } else if (umbral > 0 && d.saldoFinal < umbral) {
      alertas.push({ tipo: 'SALDO_BAJO', severidad: 'media', date: d.date, valor: d.saldoFinal,
        mensaje: `El ${d.date} el saldo (${d.saldoFinal.toFixed(2)}) cae por debajo del mínimo configurado (${umbral.toFixed(2)}).` });
    }
    if (d.sinClasificar > 0) {
      alertas.push({ tipo: 'SIN_CLASIFICAR', severidad: 'baja', date: d.date, valor: d.sinClasificar,
        mensaje: `El ${d.date} hay ${d.sinClasificar.toFixed(2)} sin clasificar.` });
    }
  }
  const vencidasEgreso = r2(detalleFinal.filter((x) => x.overdue && x.direction === 'EGRESO' && !x.esReal && x.day)
    .reduce((s, x) => s + x.saldo, 0));
  const vencidasIngreso = r2(detalleFinal.filter((x) => x.overdue && x.direction === 'INGRESO' && !x.esReal && x.day)
    .reduce((s, x) => s + x.saldo, 0));
  const acumulado = r2(detalleFinal.filter((x) => x.acumuladoVencido && x.day).reduce((s, x) => s + x.saldo, 0));
  if (acumulado > 0) {
    alertas.push({ tipo: 'VENCIDOS_ACUMULADOS', severidad: 'media', date: days[0], valor: acumulado,
      mensaje: `${acumulado.toFixed(2)} de obligaciones cuya fecha de proyección es anterior al rango se `
        + `acumulan en el ${days[0]} (conservan su vencimiento y sus días de mora reales).` });
  }
  if (vencidasEgreso > 0) {
    alertas.push({ tipo: 'OBLIGACIONES_VENCIDAS', severidad: 'alta', valor: vencidasEgreso,
      mensaje: `Hay ${vencidasEgreso.toFixed(2)} en obligaciones ya vencidas y sin pagar.` });
  }
  if (vencidasIngreso > 0) {
    alertas.push({ tipo: 'COBROS_VENCIDOS', severidad: 'media', valor: vencidasIngreso,
      mensaje: `Hay ${vencidasIngreso.toFixed(2)} en cobros vencidos y no recibidos.` });
  }
  const sinFecha = detalleFinal.filter((x) => !x.esReal && !x.effectiveDate && !x.duplicada).length;
  if (sinFecha) {
    alertas.push({ tipo: 'SIN_FECHA', severidad: 'media', valor: sinFecha,
      mensaje: `${sinFecha} documento(s) no tienen ninguna fecha con la que proyectarse.` });
  }
  const resueltas = duplicadas.filter((x) => x.resolution !== 'AMBIGUOUS');
  if (resueltas.length) {
    const importe = r2(resueltas.reduce((s, x) => s + x.saldo, 0));
    alertas.push({
      tipo: 'CXC_DUPLICADA',
      severidad: 'media',
      valor: importe,
      mensaje: `${resueltas.length} cuenta(s) por cobrar duplicadas entre una venta y su factura `
        + `(${importe.toFixed(2)}). Se proyecta una sola vez, por el documento que tiene la actividad real. `
        + 'Revísalo con scripts/diagnoseDuplicateReceivables.js antes de corregir la cartera.',
      documentos: resueltas.map((x) => ({ id: x.id, numero: x.numero, saldo: x.saldo, duplicadaDe: x.duplicadaDe, resolution: x.resolution })),
    });
  }
  if (ambiguas.length) {
    // No se oculta ninguno de los dos documentos: se muestran las dos referencias, se dice por
    // qué no pudo resolverse y la consolidación automática queda bloqueada. Y el importe se
    // presenta como ESTIMADO, no como un cobro confirmado.
    const unicas = [...new Map(ambiguas.map((x) => [x.vinculos?.venta?.id, x])).values()];
    const estimado = r2(unicas.filter((x) => x.day).reduce((s, x) => s + x.saldo, 0));
    alertas.push({
      tipo: 'CXC_DUPLICADA_AMBIGUA',
      severidad: 'alta',
      valor: unicas.length,
      estimado,
      mensaje: `${unicas.length} obligación(es) tienen dos carteras (venta y factura) que NO concilian. `
        + `El ingreso proyectado por ellas (${estimado.toFixed(2)}) es una ESTIMACIÓN conservadora, no un `
        + 'cobro confirmado: requiere conciliación humana (scripts/diagnoseDuplicateReceivables.js).',
      documentos: unicas.map((x) => ({
        id: x.id, numero: x.numero, saldo: x.saldo, estimado: true,
        motivo: x.resolutionReason, formula: x.formula, vinculos: x.vinculos,
      })),
    });
  }

  // Conciliación submayor ↔ celdas: la suma del detalle proyectado tiene que ser la suma de
  // las columnas de proyección. Si no cuadra, se avisa en vez de mostrar un número mudo.
  const sumaDetalleProy = r2(detalleFinal.filter((x) => !x.esReal && x.day)
    .reduce((s, x) => s + (x.direction === 'INGRESO' ? x.saldo : -x.saldo), 0));
  const sumaCeldasProy = r2(resultado.reduce((s, d) => s + d.ingresosProyectados - d.egresosProyectados, 0));
  if (Math.abs(sumaDetalleProy - sumaCeldasProy) > 0.01) {
    alertas.push({ tipo: 'DESCUADRE_DETALLE', severidad: 'alta', valor: r2(sumaDetalleProy - sumaCeldasProy),
      mensaje: 'El detalle no concilia con los totales de las celdas.' });
  }

  return {
    rango: { from: desde, to: startOfDay(hasta), dias: days.length, calendario: calendar },
    config: {
      minimumBalanceThreshold: umbral,
      includeSaturdays: cfg.includeSaturdays !== false,
      overdueBucket: cfg.overdueBucket,
      showEmptyCategories: cfg.showEmptyCategories,
      categories: cfg.categories,
    },
    cuentas: cuentasConSaldo,
    saldoInicial: saldoInicialTotal,
    saldoFinal: saldo,
    days: resultado,
    detalle: detalleFinal,
    alertas,
    totales: {
      ingresos: r2(resultado.reduce((s, d) => s + d.ingresos, 0)),
      egresos: r2(resultado.reduce((s, d) => s + d.egresos, 0)),
      // Parte de `ingresos` que NO es cartera confirmada, sino la estimación conservadora de
      // obligaciones con dos carteras que no concilian.
      ingresosEstimados: r2(detalleFinal.filter((x) => x.estimado && x.day && x.direction === 'INGRESO')
        .reduce((s, x) => s + x.saldo, 0)),
      // Se informan aparte: NO están en ingresos ni en egresos (efecto consolidado cero).
      transferenciasInternas: r2(resultado.reduce((s, d) => s + d.transferenciasInternas, 0)),
      vencidas: vencidasEgreso,
      cobrosVencidos: vencidasIngreso,
      acumuladoVencido: acumulado,
    },
  };
}

// ═══════════════════════════ MOVIMIENTOS REALES ═══════════════════════════

/**
 * Vista SEPARADA de lo ya realizado (nunca mezclada con lo previsto). Sale del mayor, que
 * es la fuente de verdad del efectivo, y se enriquece con el movimiento bancario cuando
 * existe (método de pago, referencia, conciliación).
 */
async function realMovements(clinicId, { from, to, filters = {}, page = 1, pageSize = 100 } = {}) {
  const cfg = await getConfig(clinicId);
  const { ids: accountIds, byId } = await resolveCashAccounts(clinicId, cfg);
  if (!accountIds.length) return { rows: [], total: 0, page, pageSize, totalIn: 0, totalOut: 0 };

  const desde = startOfDay(parseLocalDate(from) || new Date());
  const hasta = endOfDay(parseLocalDate(to) || new Date());
  const accSet = new Set(accountIds.map(String));

  const match = {
    clinic: clinicId,
    status: 'CONTABILIZADO',
    date: { $gte: desde, $lte: hasta },
    'lines.account': { $in: accountIds },
  };
  if (filters.account) match['lines.account'] = oid(filters.account);
  if (filters.sourceModel) match.sourceModel = filters.sourceModel;
  if (filters.user) match.createdBy = oid(filters.user);

  const [entries, mappings] = await Promise.all([
    JournalEntry.find(match).sort({ date: 1, number: 1 }).lean(),
    loadMappings(clinicId),
  ]);

  const BankTransaction = require('../models/BankTransaction');
  const bankTx = await BankTransaction.find({
    clinic: clinicId, date: { $gte: desde, $lte: hasta }, voided: false,
  }).populate('bankAccount', 'name bank accountNumber').lean();
  const txByEntry = new Map(bankTx.filter((t) => t.journalEntry).map((t) => [String(t.journalEntry), t]));

  const rows = [];
  let totalIn = 0;
  let totalOut = 0;
  let totalInterno = 0;
  for (const e of entries) {
    const tx = txByEntry.get(String(e._id));
    // El movimiento bancario se USA (método, referencia, conciliación) pero no se recorre
    // como una segunda fuente: las filas salen SOLO del asiento, así que un movimiento con
    // JournalEntry y BankTransaction a la vez no puede aparecer dos veces.
    const s = splitLiquidity(e, accSet);
    if (!s.liq.length) continue;
    const comun = {
      date: e.date,
      bancaria: tx?.bankAccount
        ? { name: tx.bankAccount.name, bank: tx.bankAccount.bank, number: tx.bankAccount.accountNumber }
        : null,
      contraparte: e.description || '—',
      metodo: tx?.type || null,
      documento: e.sourceModel ? { model: e.sourceModel, ref: e.sourceRef } : null,
      journalEntry: e._id,
      numeroAsiento: e.number,
      origen: e.source || e.sourceModel || 'Manual',
      referencia: tx?.reference || tx?.voucherNumber || '',
      estado: tx?.voided ? 'ANULADO' : 'CONTABILIZADO',
      conciliado: tx ? !!tx.reconciled : null,
      descripcion: e.description || '',
    };

    // (a) Traspaso entre cuentas del propio conjunto: se muestra con ORIGEN y DESTINO, pero
    // no suma a los totales (el efecto consolidado de caja es cero).
    if (s.interno > 0 && !filters.direction && !filters.category) {
      totalInterno = r2(totalInterno + s.interno);
      rows.push({
        ...comun,
        id: `${e._id}:interno`,
        cuenta: byId.get(String(s.origen[0]?.account)) || null,
        direction: 'INTERNO',
        transferenciaInterna: true,
        metodo: comun.metodo || 'TRANSFERENCIA_INTERNA',
        origenCuentas: s.origen.map((l) => ({ code: l.accountCode, name: l.accountName })),
        destinoCuentas: s.destino.map((l) => ({ code: l.accountCode, name: l.accountName })),
        ingreso: 0,
        egreso: 0,
        monto: s.interno,
        category: 'TRANSFERENCIA_INTERNA',
        subcategory: null,
      });
    }

    // (b) Lo que de verdad entró o salió del conjunto configurado.
    for (const [direction, monto] of [['INGRESO', s.externalIn], ['EGRESO', s.externalOut]]) {
      if (monto <= 0) continue;
      if (filters.direction && filters.direction !== direction) continue;
      const lineas = direction === 'INGRESO' ? s.destino : s.origen;
      const l = lineas[0]?.line || lineas[0];
      if (filters.account && !lineas.some((x) => String(x.account) === String(filters.account))) continue;
      const cls = classify({
        docModel: 'JournalEntry', direction, sourceModel: e.sourceModel, sourceAction: e.sourceAction,
        accountIds: s.contrapartidas, description: e.description || '',
      }, mappings, null);
      if (filters.category && cls.category !== filters.category) continue;
      if (filters.method && tx?.type !== filters.method) continue;
      if (filters.party && !String(e.description || '').toLowerCase().includes(String(filters.party).toLowerCase())) continue;

      if (direction === 'INGRESO') totalIn = r2(totalIn + monto);
      else totalOut = r2(totalOut + monto);
      rows.push({
        ...comun,
        id: `${e._id}:${direction}`,
        cuenta: byId.get(String(l?.account)) || null,
        direction,
        ingreso: direction === 'INGRESO' ? monto : 0,
        egreso: direction === 'EGRESO' ? monto : 0,
        category: cls.category,
        subcategory: cls.subcategory,
        costCenter: l?.costCenter || null,
      });
    }
  }
  const start = (Math.max(1, page) - 1) * pageSize;
  return {
    rows: rows.slice(start, start + pageSize),
    total: rows.length,
    page,
    pageSize,
    totalIn,
    totalOut,
    // Fuera de los totales operativos a propósito: un traspaso no es ingreso ni egreso.
    totalTransferenciasInternas: totalInterno,
  };
}

module.exports = {
  getConfig,
  resolveCashAccounts,
  splitLiquidity,
  openingBalance,
  loadMappings,
  classify,
  buildDays,
  columnFor,
  buildProjection,
  realMovements,
  parseLocalDate,
  startOfDay,
  endOfDay,
  r2,
};
