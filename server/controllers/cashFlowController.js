/**
 * API del flujo de caja diario, operativo y proyectado.
 *
 * Todo el cálculo vive en services/cashFlowService: aquí solo se validan entradas, se
 * resuelven permisos y se serializa. La API devuelve los saldos ya calculados para que el
 * frontend NO tenga que volver a sumarlos, y NUNCA acepta totales enviados por el cliente.
 *
 * Consultar el flujo es de solo lectura. Las únicas escrituras son las decisiones de la
 * clínica —reprogramar, reclasificar, excluir, partidas manuales y reglas— y ninguna de
 * ellas genera asientos ni toca el vencimiento legal (`dueDate`).
 */
const ExcelJS = require('exceljs');

const CashFlowConfig = require('../models/CashFlowConfig');
const CashFlowMapping = require('../models/CashFlowMapping');
const CashFlowManualItem = require('../models/CashFlowManualItem');
const CashFlowPlan = require('../models/CashFlowPlan');
const Payable = require('../models/Payable');
const Receivable = require('../models/Receivable');
const ChartOfAccount = require('../models/ChartOfAccount');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const svc = require('../services/cashFlowService');
const { createEntry, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { defaultCategories } = require('../utils/cashFlowCategories');
const {
  readIdempotencyKey, fingerprint, assertSameFingerprint, normalize: N, conflict,
} = require('../utils/idempotency');

const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });
const notFound = (msg) => Object.assign(new Error(msg), { status: 404 });
const fail = (res, e) => res.status(e.status || 400).json({ message: e.message });

const MODELS = { Payable, Receivable, CashFlowManualItem };

/**
 * Rango pedido, con horizonte por defecto de la configuración.
 * Las fechas 'YYYY-MM-DD' se leen como medianoche LOCAL (Ecuador), no UTC: si no, el rango
 * se correría un día y el Excel dejaría de cuadrar con la API.
 */
function parseRange(query, cfg) {
  const from = query.from ? svc.parseLocalDate(query.from) : new Date();
  if (!from) throw badRequest('Fecha "desde" inválida.');
  let to;
  if (query.to) {
    to = svc.parseLocalDate(query.to);
    if (!to) throw badRequest('Fecha "hasta" inválida.');
  } else {
    to = new Date(from.getTime() + (cfg.defaultHorizonDays - 1) * 86400000);
  }
  return { from, to };
}

function parseFilters(q) {
  return {
    category: q.category || null,
    subcategory: q.subcategory || null,
    direction: q.direction || null,
    party: q.party || null,
    onlyOverdue: q.onlyOverdue === 'true',
    onlyRescheduled: q.onlyRescheduled === 'true',
    onlyUnclassified: q.onlyUnclassified === 'true',
  };
}

// ═══════════════════════════ CONFIGURACIÓN ═══════════════════════════

exports.getConfig = async (req, res) => {
  try {
    const cfg = await svc.getConfig(req.clinicId);
    const { accounts } = await svc.resolveCashAccounts(req.clinicId, cfg);
    res.json({ config: cfg, cuentasResueltas: accounts });
  } catch (e) { fail(res, e); }
};

exports.updateConfig = async (req, res) => {
  try {
    const cfg = await svc.getConfig(req.clinicId);
    const b = req.body || {};
    const campos = [
      'cashAccounts', 'bankAccounts', 'includeChildAccounts', 'defaultHorizonDays', 'maxRangeDays',
      'includeSaturdays', 'holidays', 'sriDueDayOfMonth', 'categories',
      'minimumBalanceThreshold', 'showEmptyCategories', 'overdueBucket',
      'openingBalanceMode', 'openingBalanceManual',
    ];
    for (const k of campos) if (b[k] !== undefined) cfg[k] = b[k];
    if (b.resetCategories === true) cfg.categories = defaultCategories();
    cfg.version = (cfg.version || 1) + 1;
    cfg.updatedBy = req.user._id;
    await cfg.save();
    const { accounts } = await svc.resolveCashAccounts(req.clinicId, cfg);
    res.json({ config: cfg, cuentasResueltas: accounts });
  } catch (e) { fail(res, e); }
};

// ═══════════════════════════ PROYECCIÓN ═══════════════════════════

/** Proyección diaria. No devuelve el detalle completo (puede ser enorme): ver /cell. */
exports.projection = async (req, res) => {
  try {
    const cfg = await svc.getConfig(req.clinicId);
    const { from, to } = parseRange(req.query, cfg);
    const data = await svc.buildProjection(req.clinicId, { from, to, filters: parseFilters(req.query) });
    const { detalle, ...resto } = data;
    res.json({
      ...resto,
      documentos: detalle.length,
      sinProyectar: detalle.filter((d) => !d.day && !d.excluida).length,
      excluidos: detalle.filter((d) => d.excluida).length,
    });
  } catch (e) { fail(res, e); }
};

/**
 * Detalle de UNA celda (día + dirección + categoría/subcategoría), paginado.
 * Se recalcula con el MISMO servicio y se filtra: por construcción, la suma del detalle es
 * exactamente el valor de la celda.
 */
exports.cellDetail = async (req, res) => {
  try {
    const cfg = await svc.getConfig(req.clinicId);
    const { date, direction, category, subcategory } = req.query;
    if (!date) throw badRequest('Falta la fecha de la celda.');
    const { from, to } = parseRange(req.query, cfg);
    const data = await svc.buildProjection(req.clinicId, { from, to, filters: parseFilters(req.query) });

    let rows = data.detalle.filter((d) => d.day === date);
    if (direction) rows = rows.filter((d) => d.direction === direction);
    if (category) rows = rows.filter((d) => d.category === category);
    if (subcategory) rows = rows.filter((d) => d.subcategory === subcategory);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || 50));
    const total = svc.r2(rows.reduce((s, d) => s + (d.esReal ? d.total : d.saldo), 0));
    const dia = data.days.find((d) => d.date === date) || null;

    res.json({
      date,
      direction: direction || null,
      category: category || null,
      subcategory: subcategory || null,
      total,
      // Control de conciliación: la celda del resumen y la suma del detalle deben coincidir.
      celda: dia && direction && category
        ? svc.r2(dia.categorias?.[direction]?.[category]?.[subcategory ? 'subs' : 'total'] != null
          ? (subcategory
            ? (dia.categorias[direction][category].subs[subcategory] || 0)
            : dia.categorias[direction][category].total)
          : 0)
        : null,
      count: rows.length,
      page,
      pageSize,
      rows: rows.slice((page - 1) * pageSize, page * pageSize),
    });
  } catch (e) { fail(res, e); }
};

exports.movements = async (req, res) => {
  try {
    const cfg = await svc.getConfig(req.clinicId);
    const { from, to } = parseRange(req.query, cfg);
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(req.query.pageSize, 10) || 100));
    const data = await svc.realMovements(req.clinicId, {
      from,
      to,
      page,
      pageSize,
      filters: {
        account: req.query.account || null,
        direction: req.query.direction || null,
        party: req.query.party || null,
        method: req.query.method || null,
        category: req.query.category || null,
        sourceModel: req.query.sourceModel || null,
        user: req.query.user || null,
      },
    });
    res.json(data);
  } catch (e) { fail(res, e); }
};

// ═══════════════════════════ PLAN DEL DOCUMENTO ═══════════════════════════

/** Carga el documento y comprueba que es de la clínica (aislamiento). */
async function loadDoc(clinicId, docModel, docRef) {
  const Model = MODELS[docModel];
  if (!Model) throw badRequest(`Tipo de documento no soportado: ${docModel}`);
  const doc = await Model.findOne({ _id: docRef, clinic: clinicId });
  if (!doc) throw notFound('Documento no encontrado en esta clínica.');
  return doc;
}

/** Plan del documento (find-or-create), resistente a la carrera del índice único. */
async function getOrCreatePlan(clinicId, docModel, docRef, direction, userId) {
  const filtro = { clinic: clinicId, docModel, docRef };
  const plan = await CashFlowPlan.findOne(filtro);
  if (plan) return plan;
  try {
    return await CashFlowPlan.create({ ...filtro, direction, createdBy: userId });
  } catch (e) {
    // Dos peticiones simultáneas crearon el plan: gana una y la otra usa la existente.
    if (e.code === 11000) return CashFlowPlan.findOne(filtro);
    throw e;
  }
}

/**
 * REPROGRAMAR: cambia la fecha PLANIFICADA de pago/cobro.
 *
 * Escribe `plannedPaymentDate` en el propio documento de cartera (el campo que consume la
 * proyección desde la Fase 1) y deja el cambio auditado en el plan: valor anterior, valor
 * nuevo, usuario, fecha y MOTIVO (obligatorio).
 *
 * `dueDate` (vencimiento legal) NO se toca: una obligación reprogramada después de su
 * vencimiento sigue apareciendo como vencida, solo que proyectada en otro día.
 */
exports.reschedule = async (req, res) => {
  try {
    const { docModel, docRef, newDate, reason } = req.body || {};
    if (!reason || !String(reason).trim()) throw badRequest('El motivo de la reprogramación es obligatorio.');
    if (!newDate) throw badRequest('Falta la nueva fecha.');
    // Fecha LOCAL: '2026-07-20' es el 20 en Ecuador, no la medianoche UTC (que sería el 19 a
    // las 19:00 y proyectaría la obligación un día antes).
    const nueva = svc.parseLocalDate(newDate);
    if (Number.isNaN(nueva.getTime())) throw badRequest('La nueva fecha es inválida.');

    const doc = await loadDoc(req.clinicId, docModel, docRef);
    const esManual = docModel === 'CashFlowManualItem';
    const direction = esManual ? doc.direction : (docModel === 'Payable' ? 'EGRESO' : 'INGRESO');
    const campo = direction === 'INGRESO' ? 'plannedCollectionDate' : 'plannedPaymentDate';
    const anterior = esManual ? doc.plannedDate : doc.plannedPaymentDate;

    const cambio = {
      field: campo,
      previousValue: anterior || null,
      newValue: nueva,
      reason: String(reason).trim(),
      changedBy: req.user._id,
      changedAt: new Date(),
    };

    if (esManual) {
      doc.plannedDate = nueva;
      doc.history.push(cambio);
      doc.updatedBy = req.user._id;
      await doc.save();
    } else {
      doc.plannedPaymentDate = nueva;   // el vencimiento legal (`dueDate`) queda intacto
      await doc.save();
      const plan = await getOrCreatePlan(req.clinicId, docModel, docRef, direction, req.user._id);
      plan.history.push(cambio);
      plan.updatedBy = req.user._id;
      await plan.save();
    }

    res.json({
      ok: true,
      docModel,
      docRef,
      dueDate: doc.dueDate || null,     // sin cambios, por contrato
      plannedDate: nueva,
      historial: cambio,
    });
  } catch (e) { fail(res, e); }
};

/**
 * RECLASIFICAR: override de categoría en este documento y, opcionalmente, regla para los
 * futuros (`saveRule: true` + `ruleMatch`).
 */
exports.classifyDoc = async (req, res) => {
  try {
    const { docModel, docRef, category, subcategory, saveRule, ruleMatch, reason } = req.body || {};
    if (!category) throw badRequest('Falta la categoría.');
    const doc = await loadDoc(req.clinicId, docModel, docRef);
    const direction = docModel === 'CashFlowManualItem'
      ? doc.direction
      : (docModel === 'Payable' ? 'EGRESO' : 'INGRESO');

    const plan = await getOrCreatePlan(req.clinicId, docModel, docRef, direction, req.user._id);
    plan.history.push({
      field: 'category',
      previousValue: plan.category || null,
      newValue: category,
      reason: reason || '',
      changedBy: req.user._id,
      changedAt: new Date(),
    });
    plan.category = category;
    plan.subcategory = subcategory || null;
    plan.updatedBy = req.user._id;
    await plan.save();

    let regla = null;
    if (saveRule === true) {
      if (!ruleMatch?.matchType || !ruleMatch?.matchValue) {
        throw badRequest('Para guardar una regla hay que indicar sobre qué casa (matchType y matchValue).');
      }
      const filtro = {
        clinic: req.clinicId,
        direction,
        matchType: ruleMatch.matchType,
        matchValue: String(ruleMatch.matchValue),
      };
      try {
        regla = await CashFlowMapping.create({
          ...filtro,
          category,
          subcategory: subcategory || null,
          priority: ruleMatch.priority ?? 100,
          createdBy: req.user._id,
        });
      } catch (e) {
        // Ya existía (o la creó otra petición en paralelo): se actualiza, no se duplica.
        if (e.code !== 11000) throw e;
        regla = await CashFlowMapping.findOneAndUpdate(
          filtro,
          { category, subcategory: subcategory || null, isActive: true, updatedBy: req.user._id },
          { new: true }
        );
      }
    }
    res.json({ ok: true, plan, regla });
  } catch (e) { fail(res, e); }
};

/** Deshacer la clasificación manual: vuelve a mandar la regla / el módulo. */
exports.unclassifyDoc = async (req, res) => {
  try {
    const { docModel, docRef } = req.body || {};
    await loadDoc(req.clinicId, docModel, docRef);
    const plan = await CashFlowPlan.findOne({ clinic: req.clinicId, docModel, docRef });
    if (!plan) return res.json({ ok: true, plan: null });
    plan.history.push({
      field: 'category',
      previousValue: plan.category,
      newValue: null,
      reason: 'Se deshizo la clasificación manual',
      changedBy: req.user._id,
      changedAt: new Date(),
    });
    plan.category = null;
    plan.subcategory = null;
    plan.updatedBy = req.user._id;
    await plan.save();
    res.json({ ok: true, plan });
  } catch (e) { fail(res, e); }
};

/** Excluir / volver a incluir un documento en la proyección (con motivo, auditado). */
exports.setExcluded = async (req, res) => {
  try {
    const { docModel, docRef, excluded, reason } = req.body || {};
    if (excluded === true && !String(reason || '').trim()) {
      throw badRequest('Para excluir un documento del flujo hay que indicar el motivo.');
    }
    const doc = await loadDoc(req.clinicId, docModel, docRef);
    const direction = docModel === 'CashFlowManualItem'
      ? doc.direction
      : (docModel === 'Payable' ? 'EGRESO' : 'INGRESO');
    const plan = await getOrCreatePlan(req.clinicId, docModel, docRef, direction, req.user._id);
    plan.history.push({
      field: 'excluded',
      previousValue: plan.excluded,
      newValue: !!excluded,
      reason: String(reason || '').trim(),
      changedBy: req.user._id,
      changedAt: new Date(),
    });
    plan.excluded = !!excluded;
    plan.excludedReason = excluded ? String(reason).trim() : '';
    plan.updatedBy = req.user._id;
    await plan.save();
    res.json({ ok: true, plan });
  } catch (e) { fail(res, e); }
};

exports.addNote = async (req, res) => {
  try {
    const { docModel, docRef, note } = req.body || {};
    const doc = await loadDoc(req.clinicId, docModel, docRef);
    const direction = docModel === 'CashFlowManualItem'
      ? doc.direction
      : (docModel === 'Payable' ? 'EGRESO' : 'INGRESO');
    const plan = await getOrCreatePlan(req.clinicId, docModel, docRef, direction, req.user._id);
    plan.history.push({
      field: 'notes',
      previousValue: plan.notes || '',
      newValue: note || '',
      changedBy: req.user._id,
      changedAt: new Date(),
    });
    plan.notes = note || '';
    plan.updatedBy = req.user._id;
    await plan.save();
    res.json({ ok: true, plan });
  } catch (e) { fail(res, e); }
};

/** Historial de planificación de un documento (auditoría completa). */
exports.docHistory = async (req, res) => {
  try {
    const { docModel, docRef } = req.query;
    const doc = await loadDoc(req.clinicId, docModel, docRef);
    const plan = await CashFlowPlan.findOne({ clinic: req.clinicId, docModel, docRef }).lean();
    const propio = docModel === 'CashFlowManualItem' ? (doc.history || []) : [];
    const historial = [...propio, ...(plan?.history || [])]
      .sort((a, b) => new Date(b.changedAt) - new Date(a.changedAt));
    res.json({ docModel, docRef, dueDate: doc.dueDate || null, historial });
  } catch (e) { fail(res, e); }
};

// ═══════════════════════════ PARTIDAS MANUALES ═══════════════════════════

exports.listManualItems = async (req, res) => {
  try {
    const q = { clinic: req.clinicId };
    if (req.query.status) q.status = req.query.status;
    if (req.query.direction) q.direction = req.query.direction;
    if (req.query.from || req.query.to) {
      q.plannedDate = {};
      if (req.query.from) q.plannedDate.$gte = svc.startOfDay(svc.parseLocalDate(req.query.from));
      if (req.query.to) q.plannedDate.$lte = svc.endOfDay(svc.parseLocalDate(req.query.to));
    }
    const items = await CashFlowManualItem.find(q).sort({ plannedDate: 1 }).lean();

    // Trazabilidad de las liquidadas: el asiento y el movimiento bancario que las respaldan,
    // para poder abrirlos desde la pantalla (una partida REALIZADA no se explica sola).
    const liquidadas = items.filter((i) => i.status === 'REALIZADO' && i.settledByRef);
    if (liquidadas.length) {
      const { JournalEntry, Payment } = MOVIMIENTOS_REALES;
      const refPorModelo = (m) => liquidadas.filter((i) => i.settledByModel === m).map((i) => i.settledByRef);
      const [propios, pagos, txs] = await Promise.all([
        JournalEntry.find({
          clinic: req.clinicId, sourceModel: 'CashFlowManualItem', sourceAction: 'SETTLE',
          sourceRef: { $in: liquidadas.map((i) => i._id) },
        }).select('number sourceRef').lean(),
        Payment.find({ clinic: req.clinicId, _id: { $in: refPorModelo('Payment') } })
          .select('number journalEntry bankTransaction').lean(),
        BankTransaction.find({ clinic: req.clinicId, _id: { $in: refPorModelo('BankTransaction') } })
          .select('journalEntry reference').lean(),
      ]);
      const asientoPorItem = new Map(propios.map((e) => [String(e.sourceRef), e]));
      const pagoPorId = new Map(pagos.map((p) => [String(p._id), p]));
      const txPorId = new Map(txs.map((t) => [String(t._id), t]));
      for (const i of liquidadas) {
        const ref = String(i.settledByRef);
        const propio = asientoPorItem.get(String(i._id));
        const pago = pagoPorId.get(ref);
        const tx = txPorId.get(ref);
        i.journalEntry = propio?._id || pago?.journalEntry || tx?.journalEntry
          || (i.settledByModel === 'JournalEntry' ? i.settledByRef : null);
        i.numeroAsiento = propio?.number || null;
        i.bankTransaction = i.settledByModel === 'BankTransaction' ? i.settledByRef : (pago?.bankTransaction || null);
      }
    }
    res.json(items);
  } catch (e) { fail(res, e); }
};

/**
 * Crear una partida manual. NO genera asiento: es una previsión.
 * Idempotente por `Idempotency-Key` (mismo contrato que los pagos de la Fase 1).
 */
exports.createManualItem = async (req, res) => {
  const idemKey = readIdempotencyKey(req);
  const b = req.body || {};
  const idemFingerprint = fingerprint({
    op: 'cashflow.manualItem.create',
    direction: b.direction || null,
    category: b.category || null,
    subcategory: b.subcategory || null,
    amount: N.num(b.amount),
    plannedDate: N.date(b.plannedDate),
    description: b.description || null,
    origin: b.origin || null,
  });
  try {
    if (idemKey) {
      const previa = await CashFlowManualItem.findOne({ clinic: req.clinicId, idempotencyKey: idemKey });
      if (previa) {
        assertSameFingerprint(previa.idempotencyFingerprint, idemFingerprint, 'partida manual');
        return res.json({ ...previa.toObject(), idempotentReplay: true });
      }
    }
    if (!b.direction || !['INGRESO', 'EGRESO'].includes(b.direction)) throw badRequest('Dirección inválida.');
    if (!b.category) throw badRequest('La categoría es obligatoria.');
    if (!b.description) throw badRequest('La descripción es obligatoria.');
    if (!(Number(b.amount) > 0)) throw badRequest('El importe debe ser mayor que cero.');
    if (!b.plannedDate) throw badRequest('La fecha planificada es obligatoria.');

    const item = await CashFlowManualItem.create({
      clinic: req.clinicId,
      direction: b.direction,
      category: b.category,
      subcategory: b.subcategory || null,
      partyName: b.partyName || '',
      partyModel: b.partyModel || null,
      partyRef: b.partyRef || null,
      description: b.description,
      amount: svc.r2(b.amount),
      // Fechas LOCALES (ver parseLocalDate): '2026-07-16' es el 16 en Ecuador. Con `new Date()`
      // se guardaba la medianoche UTC, que aquí es el día ANTERIOR a las 19:00, y la previsión
      // se proyectaba un día antes de lo que el usuario escribió.
      plannedDate: svc.parseLocalDate(b.plannedDate),
      dueDate: b.dueDate ? svc.parseLocalDate(b.dueDate) : null,
      origin: b.origin || 'OTRO',
      loan: b.origin === 'PRESTAMO' ? (b.loan || {}) : undefined,
      recurrence: b.recurrence || 'NONE',
      notes: b.notes || '',
      idempotencyKey: idemKey,
      idempotencyFingerprint: idemKey ? idemFingerprint : null,
      createdBy: req.user._id,
    });
    res.status(201).json(item);
  } catch (e) {
    if (e.code === 11000 && idemKey) {
      const previa = await CashFlowManualItem.findOne({ clinic: req.clinicId, idempotencyKey: idemKey });
      if (previa) {
        try {
          assertSameFingerprint(previa.idempotencyFingerprint, idemFingerprint, 'partida manual');
        } catch (c) { return res.status(409).json({ message: c.message }); }
        return res.json({ ...previa.toObject(), idempotentReplay: true });
      }
    }
    fail(res, e);
  }
};

exports.updateManualItem = async (req, res) => {
  try {
    const item = await CashFlowManualItem.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!item) throw notFound('Partida no encontrada.');
    if (item.status === 'REALIZADO') throw badRequest('Una partida ya realizada no se edita: se refleja por su documento real.');
    const b = req.body || {};
    const audit = (field, nuevo) => {
      if (nuevo === undefined || String(item[field] ?? '') === String(nuevo ?? '')) return;
      item.history.push({
        field,
        previousValue: item[field] ?? null,
        newValue: nuevo,
        reason: b.reason || '',
        changedBy: req.user._id,
        changedAt: new Date(),
      });
      item[field] = nuevo;
    };
    audit('amount', b.amount !== undefined ? svc.r2(b.amount) : undefined);
    audit('category', b.category);
    audit('subcategory', b.subcategory);
    audit('notes', b.notes);
    if (b.plannedDate) {
      const nueva = svc.parseLocalDate(b.plannedDate);
      if (String(nueva) !== String(item.plannedDate)) {
        if (!String(b.reason || '').trim()) throw badRequest('Cambiar la fecha planificada exige un motivo.');
        item.history.push({
          field: 'plannedPaymentDate',
          previousValue: item.plannedDate,
          newValue: nueva,
          reason: b.reason,
          changedBy: req.user._id,
          changedAt: new Date(),
        });
        item.plannedDate = nueva;
      }
    }
    for (const k of ['description', 'partyName', 'origin', 'loan']) if (b[k] !== undefined) item[k] = b[k];
    item.updatedBy = req.user._id;
    await item.save();
    res.json(item);
  } catch (e) { fail(res, e); }
};

/**
 * LIQUIDAR una partida manual. Cambiar el estado NO basta: una previsión no puede volverse
 * un movimiento real por decreto. Solo hay dos caminos seguros, y el estado se toca al final:
 *
 *   A · `mode: 'CREAR'`    → se CONTABILIZA el movimiento (asiento balanceado + movimiento
 *                            bancario) dentro de una transacción, y solo entonces la partida
 *                            pasa a REALIZADO. Idempotente por `Idempotency-Key`.
 *   B · `mode: 'VINCULAR'` → se enlaza un documento real YA registrado (un cobro/pago, un
 *                            movimiento bancario o un asiento), validando clínica, dirección,
 *                            importe y que no esté ya enlazado a otra partida.
 *
 * Cualquier fallo intermedio revierte todo y la partida sigue PLANIFICADA.
 */
exports.settleManualItem = async (req, res) => {
  const idemKey = readIdempotencyKey(req);
  const b = req.body || {};
  const idemFingerprint = fingerprint({
    op: 'cashflow.manualItem.settle',
    item: String(req.params.id),
    mode: b.mode || null,
    bankAccount: N.id(b.bankAccountId),
    cashAccount: N.id(b.cashAccountId),
    counterAccount: N.id(b.counterAccountId),
    amount: N.num(b.amount),
    date: N.date(b.date),
    method: b.method || null,
    reference: b.reference || null,
    settledByModel: b.settledByModel || null,
    settledByRef: N.id(b.settledByRef),
  });

  try {
    const item = await CashFlowManualItem.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!item) throw notFound('Partida no encontrada.');

    // Doble liquidación: se devuelve la partida ya liquidada, no se contabiliza otra vez.
    if (item.status === 'REALIZADO') {
      if (idemKey && item.idempotencyKey === idemKey) {
        assertSameFingerprint(item.idempotencyFingerprint, idemFingerprint, 'liquidación de partida');
      }
      return res.json({ ...item.toObject(), idempotentReplay: true });
    }
    if (item.status === 'CANCELADO') throw badRequest('Una partida cancelada no se puede liquidar.');

    const mode = b.mode || (b.settledByModel ? 'VINCULAR' : null);
    if (!mode) {
      throw badRequest('Una partida planificada no se convierte en movimiento real cambiando su estado. '
        + 'Indica mode: "CREAR" (para contabilizar el movimiento) o mode: "VINCULAR" '
        + '(para enlazar un cobro/pago o movimiento bancario ya registrado).');
    }

    // ── B · vincular un movimiento REAL ya existente ────────────────────────────────────
    if (mode === 'VINCULAR') {
      const { settledByModel, settledByRef } = b;
      if (!MOVIMIENTOS_REALES[settledByModel]) {
        throw badRequest(`Solo se puede vincular un ${Object.keys(MOVIMIENTOS_REALES).join(', ')}.`);
      }
      const Model = MOVIMIENTOS_REALES[settledByModel];
      const doc = await Model.findOne({ _id: settledByRef, clinic: req.clinicId });
      if (!doc) throw notFound('El movimiento indicado no existe en esta clínica.');

      const yaEnlazada = await CashFlowManualItem.findOne({
        clinic: req.clinicId,
        settledByModel,
        settledByRef,
        _id: { $ne: item._id },
      });
      if (yaEnlazada) {
        throw conflict(`Ese movimiento ya respalda la partida "${yaEnlazada.description}". `
          + 'Un mismo movimiento real no puede liquidar dos previsiones.');
      }

      const { direccion, importe } = describirMovimiento(settledByModel, doc);
      if (direccion && direccion !== item.direction) {
        throw badRequest(`La partida es un ${item.direction} y el movimiento es un ${direccion}.`);
      }
      if (importe != null && Math.abs(importe - item.amount) > 0.01) {
        throw badRequest(`El importe del movimiento (${importe.toFixed(2)}) no coincide con el de la `
          + `partida (${item.amount.toFixed(2)}).`);
      }

      item.status = 'REALIZADO';
      item.settledByModel = settledByModel;
      item.settledByRef = settledByRef;
      item.settledAt = doc.date || new Date();
      item.updatedBy = req.user._id;
      await item.save();
      // El asiento del movimiento enlazado, para poder abrirlo desde la UI.
      const asiento = settledByModel === 'JournalEntry' ? doc._id : (doc.journalEntry || null);
      return res.json({ ...item.toObject(), journalEntry: asiento });
    }

    // ── A · contabilizar el movimiento ─────────────────────────────────────────────────
    if (mode !== 'CREAR') throw badRequest('mode debe ser "CREAR" o "VINCULAR".');
    if (!b.counterAccountId) throw badRequest('Falta la cuenta de contrapartida.');
    if (!b.bankAccountId && !b.cashAccountId) throw badRequest('Falta la cuenta de caja o banco.');
    const monto = svc.r2(b.amount ?? item.amount);
    if (!(monto > 0)) throw badRequest('El importe debe ser mayor que cero.');
    const fecha = svc.parseLocalDate(b.date) || new Date();

    const result = await runInTransaction(async (session) => {
      // Relee dentro de la transacción: dos peticiones simultáneas no pueden contabilizar dos veces.
      const fresco = await CashFlowManualItem.findOne({ _id: item._id, clinic: req.clinicId }).session(session);
      if (fresco.status === 'REALIZADO') return { id: fresco._id, replay: true };

      await assertPeriodOpen(req.clinicId, fecha, { session });

      const contra = await ChartOfAccount.findOne({ _id: b.counterAccountId, clinic: req.clinicId }).session(session);
      if (!contra) throw badRequest('La cuenta de contrapartida no existe en esta clínica.');

      let liquidez;
      let bank = null;
      if (b.bankAccountId) {
        bank = await BankAccount.findOne({ _id: b.bankAccountId, clinic: req.clinicId }).session(session);
        if (!bank) throw badRequest('La cuenta bancaria no existe en esta clínica.');
        liquidez = await ChartOfAccount.findOne({ _id: bank.chartAccount, clinic: req.clinicId }).session(session);
      } else {
        liquidez = await ChartOfAccount.findOne({ _id: b.cashAccountId, clinic: req.clinicId }).session(session);
      }
      if (!liquidez) throw badRequest('La cuenta de caja/banco no existe en esta clínica.');

      const entra = fresco.direction === 'INGRESO';
      const lines = entra
        ? [{ account: liquidez._id, debit: monto, credit: 0, description: fresco.description, costCenter: b.costCenter || null },
          { account: contra._id, debit: 0, credit: monto, description: fresco.description, costCenter: b.costCenter || null }]
        : [{ account: contra._id, debit: monto, credit: 0, description: fresco.description, costCenter: b.costCenter || null },
          { account: liquidez._id, debit: 0, credit: monto, description: fresco.description, costCenter: b.costCenter || null }];

      const entry = await createEntry({
        clinicId: req.clinicId,
        date: fecha,
        description: `Flujo de caja · ${fresco.description}`,
        source: bank ? 'BANCO' : 'CAJA',
        sourceModel: 'CashFlowManualItem',
        sourceRef: fresco._id,
        sourceAction: 'SETTLE',     // único por partida: no puede haber dos asientos
        lines,
        userId: req.user._id,
        session,
      });

      let bankTx = null;
      if (bank) {
        [bankTx] = await BankTransaction.create([{
          clinic: req.clinicId,
          bankAccount: bank._id,
          date: fecha,
          type: entra ? 'DEPOSITO' : 'PAGO',
          amount: monto,
          direction: entra ? 1 : -1,
          description: fresco.description,
          reference: b.reference || '',
          sourceModel: 'CashFlowManualItem',
          sourceRef: fresco._id,
          journalEntry: entry._id,
          createdBy: req.user._id,
        }], { session });
      }

      // El estado cambia SOLO después de contabilizar.
      fresco.status = 'REALIZADO';
      fresco.settledByModel = bankTx ? 'BankTransaction' : 'JournalEntry';
      fresco.settledByRef = bankTx ? bankTx._id : entry._id;
      fresco.settledAt = fecha;
      fresco.accountingDate = fecha;
      if (idemKey) {
        fresco.idempotencyKey = idemKey;
        fresco.idempotencyFingerprint = idemFingerprint;
      }
      fresco.updatedBy = req.user._id;
      await fresco.save({ session });
      return { id: fresco._id, replay: false, entry: entry._id, bankTx: bankTx?._id || null };
    });

    const final = await CashFlowManualItem.findById(result.id);
    return res.json({
      ...final.toObject(),
      journalEntry: result.entry || null,
      bankTransaction: result.bankTx || null,
      ...(result.replay ? { idempotentReplay: true } : {}),
    });
  } catch (e) {
    if (e.code === 11000 && idemKey) {
      const previa = await CashFlowManualItem.findOne({ clinic: req.clinicId, idempotencyKey: idemKey });
      if (previa) return res.json({ ...previa.toObject(), idempotentReplay: true });
    }
    return fail(res, e);
  }
};

/** Modelos que pueden respaldar una partida (Alternativa B). */
const MOVIMIENTOS_REALES = {
  Payment: require('../models/Payment'),
  BankTransaction: require('../models/BankTransaction'),
  JournalEntry: require('../models/JournalEntry'),
};

/**
 * Buscador de movimientos REALES ya registrados para liquidar una partida (modo VINCULAR).
 *
 * Solo devuelve movimientos de la clínica y con la dirección de la partida. Los que ya
 * respaldan otra partida se devuelven marcados (`yaVinculado`) en vez de desaparecer, para que
 * el usuario entienda por qué no puede elegirlos, y los de importe distinto se marcan
 * `compatible:false` con su `diferencia`: el backend los rechazaría igualmente.
 */
exports.settlementCandidates = async (req, res) => {
  try {
    const Payment = MOVIMIENTOS_REALES.Payment;
    const item = req.query.itemId
      ? await CashFlowManualItem.findOne({ _id: req.query.itemId, clinic: req.clinicId }).lean()
      : null;
    const direction = req.query.direction || item?.direction;
    if (!['INGRESO', 'EGRESO'].includes(direction)) throw badRequest('Indica la dirección (INGRESO o EGRESO).');
    const importe = Number(req.query.amount ?? item?.amount ?? 0) || 0;

    const rango = {};
    if (req.query.from) rango.$gte = svc.startOfDay(svc.parseLocalDate(req.query.from));
    if (req.query.to) rango.$lte = svc.endOfDay(svc.parseLocalDate(req.query.to));
    const fecha = Object.keys(rango).length ? { date: rango } : {};

    const [pagos, movs] = await Promise.all([
      Payment.find({
        clinic: req.clinicId,
        status: 'REGISTRADO',
        type: direction === 'INGRESO' ? 'COBRO' : 'PAGO',
        ...fecha,
      }).sort({ date: -1 }).limit(100).lean(),
      BankTransaction.find({
        clinic: req.clinicId,
        voided: false,
        direction: direction === 'INGRESO' ? 1 : -1,
        ...(req.query.bankAccount ? { bankAccount: req.query.bankAccount } : {}),
        ...fecha,
      }).sort({ date: -1 }).limit(100).populate('bankAccount', 'name bank').lean(),
    ]);

    const candidatos = [
      ...pagos.map((p) => ({
        settledByModel: 'Payment',
        id: String(p._id),
        numero: p.number || '',
        date: p.date,
        amount: svc.r2(p.total),
        tercero: p.partyName || '',
        referencia: p.reference || '',
        metodo: p.method || '',
        cuenta: null,
        journalEntry: p.journalEntry ? String(p.journalEntry) : null,
      })),
      ...movs.map((t) => ({
        settledByModel: 'BankTransaction',
        id: String(t._id),
        numero: t.voucherNumber || '',
        date: t.date,
        amount: svc.r2(t.amount),
        tercero: t.description || '',
        referencia: t.reference || '',
        metodo: t.type || '',
        cuenta: t.bankAccount ? `${t.bankAccount.bank || ''} ${t.bankAccount.name || ''}`.trim() : null,
        journalEntry: t.journalEntry ? String(t.journalEntry) : null,
      })),
    ];

    // Ya enlazados a otra partida: se marcan, no se ocultan.
    const enlazadas = await CashFlowManualItem.find({
      clinic: req.clinicId,
      settledByRef: { $in: candidatos.map((c) => c.id) },
      ...(item ? { _id: { $ne: item._id } } : {}),
    }).select('settledByModel settledByRef description').lean();
    const porRef = new Map(enlazadas.map((e) => [`${e.settledByModel}:${e.settledByRef}`, e.description]));

    const texto = String(req.query.q || '').toLowerCase();
    const rows = candidatos
      .map((c) => {
        const dif = importe ? svc.r2(c.amount - importe) : 0;
        return {
          ...c,
          diferencia: dif,
          compatible: !importe || Math.abs(dif) <= 0.01,
          yaVinculado: porRef.get(`${c.settledByModel}:${c.id}`) || null,
        };
      })
      .filter((c) => !texto
        || `${c.numero} ${c.tercero} ${c.referencia}`.toLowerCase().includes(texto))
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ rows, direction, amount: importe });
  } catch (e) { fail(res, e); }
};

/** Dirección e importe de un movimiento real, para validar que encaja con la partida. */
function describirMovimiento(model, doc) {
  if (model === 'Payment') {
    return { direccion: doc.type === 'COBRO' ? 'INGRESO' : 'EGRESO', importe: Number(doc.total) };
  }
  if (model === 'BankTransaction') {
    return { direccion: doc.direction === 1 ? 'INGRESO' : 'EGRESO', importe: Number(doc.amount) };
  }
  // Un asiento no tiene "dirección" por sí mismo: se valida solo la clínica y su existencia.
  return { direccion: null, importe: null };
}

/**
 * Cancelar una PREVISIÓN. Nunca borra ni reversa un movimiento contable real: si la partida
 * ya está liquidada, la contabilidad manda y hay que anular el movimiento por su propia vía.
 */
exports.cancelManualItem = async (req, res) => {
  try {
    const item = await CashFlowManualItem.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!item) throw notFound('Partida no encontrada.');
    if (item.status === 'REALIZADO') {
      throw badRequest('La partida ya está liquidada y respaldada por un movimiento contable real. '
        + 'Cancelarla no puede borrar ni reversar ese movimiento: anúlalo desde su propio documento '
        + `(${item.settledByModel}) y la partida quedará libre.`);
    }
    if (!String(req.body?.reason || '').trim()) throw badRequest('Cancelar una partida exige un motivo.');
    item.history.push({
      field: 'excluded',
      previousValue: item.status,
      newValue: 'CANCELADO',
      reason: req.body.reason,
      changedBy: req.user._id,
      changedAt: new Date(),
    });
    item.status = 'CANCELADO';
    item.updatedBy = req.user._id;
    await item.save();
    res.json(item);
  } catch (e) { fail(res, e); }
};

// ═══════════════════════════ REGLAS ═══════════════════════════

exports.listMappings = async (req, res) => {
  try {
    const rules = await CashFlowMapping.find({ clinic: req.clinicId }).sort({ matchType: 1, priority: 1 }).lean();
    res.json({ rules, matchTypes: CashFlowMapping.MATCH_TYPES });
  } catch (e) { fail(res, e); }
};

exports.createMapping = async (req, res) => {
  try {
    const b = req.body || {};
    if (!['INGRESO', 'EGRESO'].includes(b.direction)) throw badRequest('Dirección inválida.');
    if (!CashFlowMapping.MATCH_TYPES.includes(b.matchType)) throw badRequest('Tipo de coincidencia inválido.');
    if (!b.matchValue) throw badRequest('Falta el valor sobre el que casa la regla.');
    if (!b.category) throw badRequest('Falta la categoría.');
    const filtro = {
      clinic: req.clinicId,
      direction: b.direction,
      matchType: b.matchType,
      matchValue: String(b.matchValue),
    };
    try {
      const rule = await CashFlowMapping.create({
        ...filtro,
        category: b.category,
        subcategory: b.subcategory || null,
        priority: b.priority ?? 100,
        notes: b.notes || '',
        createdBy: req.user._id,
      });
      return res.status(201).json(rule);
    } catch (e) {
      if (e.code !== 11000) throw e;
      // Otra petición (o el usuario antes) ya creó esta misma regla: no se duplica ni se
      // devuelve un E11000 crudo. Si pedía algo distinto para la misma llave ⇒ 409.
      const existente = await CashFlowMapping.findOne(filtro);
      if (existente && (existente.category !== b.category
        || (existente.subcategory || null) !== (b.subcategory || null))) {
        throw conflict(`Ya existe una regla para ese ${b.matchType} con otra categoría (${existente.category}). `
          + 'Edítela en vez de crear una segunda.');
      }
      return res.json({ ...existente.toObject(), idempotentReplay: true });
    }
  } catch (e) { fail(res, e); }
};

exports.updateMapping = async (req, res) => {
  try {
    const rule = await CashFlowMapping.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!rule) throw notFound('Regla no encontrada.');
    for (const k of ['category', 'subcategory', 'priority', 'isActive', 'notes']) {
      if (req.body?.[k] !== undefined) rule[k] = req.body[k];
    }
    rule.updatedBy = req.user._id;
    await rule.save();
    res.json(rule);
  } catch (e) { fail(res, e); }
};

exports.deleteMapping = async (req, res) => {
  try {
    const rule = await CashFlowMapping.findOneAndDelete({ _id: req.params.id, clinic: req.clinicId });
    if (!rule) throw notFound('Regla no encontrada.');
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
};

// ═══════════════════════════ ASIGNACIÓN DE PROVEEDORES A CATEGORÍAS ═══════════════════════════
//
// Un proveedor se ASIGNA a una categoría de egreso con una regla SUPPLIER (misma infraestructura
// de clasificación): desde ahí TODAS sus CxP caen en esa categoría con su vencimiento. La lista
// de "disponibles" (lo que ofrece el botón «Agregar» de cada categoría) EXCLUYE a los proveedores
// ya asignados a cualquier categoría (exclusión progresiva).

/** Proveedores con CxP abierta: disponibles (sin categoría) y asignados (con su categoría). */
exports.suppliers = async (req, res) => {
  try {
    const Supplier = require('../models/Supplier');
    const cfg = await svc.getConfig(req.clinicId);
    const catLabel = new Map((cfg.categories?.EGRESO || []).map((c) => [c.key, c.label]));

    const [payables, rules] = await Promise.all([
      Payable.find({
        clinic: req.clinicId, status: { $in: ['ABIERTO', 'PARCIAL'] }, balance: { $gt: 0.005 }, 'party.model': 'Supplier',
      }).lean(),
      CashFlowMapping.find({ clinic: req.clinicId, direction: 'EGRESO', matchType: 'SUPPLIER', isActive: true }).lean(),
    ]);
    const ruleByRef = new Map(rules.map((r) => [String(r.matchValue), r]));

    // Proveedores con saldo pendiente, agregados por proveedor.
    const pend = new Map();
    for (const p of payables) {
      const ref = p.party?.ref ? String(p.party.ref) : null;
      if (!ref) continue;
      const cur = pend.get(ref) || { ref, name: p.party?.name || '—', pendiente: 0, docs: 0 };
      cur.pendiente = svc.r2(cur.pendiente + (Number(p.balance) || 0));
      cur.docs += 1;
      pend.set(ref, cur);
    }

    // Disponibles = con CxP abierta y SIN regla (exclusión progresiva).
    const disponibles = [...pend.values()]
      .filter((s) => !ruleByRef.has(s.ref))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Asignados = reglas SUPPLIER, con el nombre del proveedor y su pendiente (0 si ya no debe).
    const refs = rules.map((r) => r.matchValue).filter(Boolean);
    const sups = refs.length
      ? await Supplier.find({ _id: { $in: refs } }).select('razonSocial name').lean()
      : [];
    const supName = new Map(sups.map((s) => [String(s._id), s.razonSocial || s.name || '—']));
    const asignados = rules.map((r) => {
      const ref = String(r.matchValue);
      const p = pend.get(ref);
      return {
        ref,
        mappingId: String(r._id),
        name: p?.name || supName.get(ref) || '—',
        category: r.category,
        categoryLabel: catLabel.get(r.category) || r.category,
        subcategory: r.subcategory || null,
        pendiente: p?.pendiente || 0,
        docs: p?.docs || 0,
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    res.json({ disponibles, asignados });
  } catch (e) { fail(res, e); }
};

/** Asigna (o reasigna) un proveedor a una categoría de egreso: crea/actualiza la regla SUPPLIER. */
exports.assignSupplier = async (req, res) => {
  try {
    const { supplierId, category, subcategory } = req.body || {};
    if (!supplierId) throw badRequest('Falta el proveedor.');
    if (!category) throw badRequest('Falta la categoría.');
    const cfg = await svc.getConfig(req.clinicId);
    const cat = (cfg.categories?.EGRESO || []).find((c) => c.key === category && c.isActive !== false);
    if (!cat) throw badRequest('La categoría de egreso no existe o está inactiva.');

    const filtro = {
      clinic: req.clinicId, direction: 'EGRESO', matchType: 'SUPPLIER', matchValue: String(supplierId),
    };
    let rule;
    try {
      rule = await CashFlowMapping.create({
        ...filtro, category, subcategory: subcategory || null, createdBy: req.user._id,
      });
    } catch (e) {
      // Ya estaba asignado (reasignación): se actualiza la categoría, no se duplica.
      if (e.code !== 11000) throw e;
      rule = await CashFlowMapping.findOneAndUpdate(
        filtro,
        { category, subcategory: subcategory || null, isActive: true, updatedBy: req.user._id },
        { new: true }
      );
    }
    res.json({ ok: true, rule });
  } catch (e) { fail(res, e); }
};

/** Quita un proveedor de su categoría (borra la regla): vuelve a estar disponible en todas. */
exports.unassignSupplier = async (req, res) => {
  try {
    const { supplierId } = req.body || {};
    if (!supplierId) throw badRequest('Falta el proveedor.');
    await CashFlowMapping.findOneAndDelete({
      clinic: req.clinicId, direction: 'EGRESO', matchType: 'SUPPLIER', matchValue: String(supplierId),
    });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
};

// ═══════════════════════════ EXCEL ═══════════════════════════

const MONEY = '"$"#,##0.00';
const HDR = 'FF1F2937';
const fmtDay = (k) => k;

/**
 * Exportación. Usa EXACTAMENTE el mismo servicio que la API (mismos filtros incluidos), así
 * que la hoja `Detalle` concilia con la hoja `Flujo` por construcción.
 *
 * No se inventa la columna "cheques posfechados" del Excel de referencia: no existe una
 * entidad de cheque posfechado en el sistema y no se va a rellenar con datos falsos.
 */
exports.projectionExcel = async (req, res) => {
  try {
    const cfg = await svc.getConfig(req.clinicId);
    const { from, to } = parseRange(req.query, cfg);
    const filters = parseFilters(req.query);
    const data = await svc.buildProjection(req.clinicId, { from, to, filters });
    const movs = await svc.realMovements(req.clinicId, { from, to, pageSize: 100000 });

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Sistema clínico';

    // ── Hoja Flujo (fechas en columnas, categorías en filas) ─────────────────────────
    const ws = wb.addWorksheet('Flujo', { views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }] });
    const dias = data.days;
    ws.getColumn(1).width = 42;
    dias.forEach((_, i) => { ws.getColumn(i + 2).width = 14; });

    const titulo = ws.addRow(['FLUJO DE CAJA PROYECTADO', ...dias.map(() => '')]);
    titulo.font = { bold: true, size: 13 };
    const cab = ws.addRow(['', ...dias.map((d) => fmtDay(d.date))]);
    cab.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cab.eachCell((c, i) => {
      if (i === 1) return;
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HDR } };
      c.alignment = { horizontal: 'center' };
    });

    const linea = (label, values, opts = {}) => {
      const row = ws.addRow([label, ...values]);
      const font = {};
      if (opts.bold) font.bold = true;
      // Fuente más clara para las sublíneas de proveedor (estilo diferenciado, como en la matriz).
      if (opts.light) { font.italic = true; font.color = { argb: 'FF6B7280' }; }
      if (Object.keys(font).length) row.font = font;
      if (opts.fill) {
        row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } }; });
      }
      if (opts.indent) row.getCell(1).alignment = { indent: opts.indent };
      for (let i = 2; i <= dias.length + 1; i += 1) row.getCell(i).numFmt = MONEY;
      return row;
    };

    linea('SALDO BANCARIO INICIAL', dias.map((d) => d.saldoInicial), { bold: true, fill: 'FFE5E7EB' });
    ws.addRow([]);

    const bloque = (direction, etiqueta, color) => {
      linea(etiqueta, dias.map(() => null), { bold: true, fill: color });
      const cats = (cfg.categories?.[direction] || []).filter((c) => c.isActive !== false);
      for (const cat of cats) {
        const valores = dias.map((d) => d.categorias?.[direction]?.[cat.key]?.total || 0);
        if (!cfg.showEmptyCategories && !valores.some((v) => v)) continue;
        linea(cat.label, valores, { bold: true, indent: 1 });
        for (const sub of (cat.subcategories || []).filter((s) => s.isActive !== false)) {
          const vs = dias.map((d) => d.categorias?.[direction]?.[cat.key]?.subs?.[sub.key] || 0);
          if (!cfg.showEmptyCategories && !vs.some((v) => v)) continue;
          linea(`· ${sub.label}`, vs, { indent: 3 });
        }
        // Sublíneas por PROVEEDOR (solo egresos): "a quién le debo" dentro de la categoría. La
        // suma de las filas de proveedor = la fila de la categoría (mismo origen que la matriz).
        if (direction === 'EGRESO') {
          for (const prov of (data.proveedoresPorCategoria?.[cat.key] || [])) {
            linea(`   ↳ ${prov.name}`, dias.map((d) => prov.byDay?.[d.date] || 0), { indent: 3, light: true });
          }
        }
      }
      const totales = dias.map((d) => (direction === 'INGRESO' ? d.ingresos : d.egresos));
      linea(direction === 'INGRESO' ? 'TOTAL INGRESOS' : 'TOTAL EGRESOS', totales, { bold: true, fill: 'FFF3F4F6' });
      ws.addRow([]);
    };
    bloque('INGRESO', 'INGRESOS', 'FFD1FAE5');
    bloque('EGRESO', 'EGRESOS', 'FFFEE2E2');

    // Neutral: un traspaso entre cuentas propias no es ingreso ni egreso y no mueve el saldo.
    if (dias.some((d) => d.transferenciasInternas)) {
      linea('Transferencias internas (no suman)', dias.map((d) => d.transferenciasInternas || 0));
      ws.addRow([]);
    }

    const final = linea('SALDO PROYECTADO', dias.map((d) => d.saldoFinal), { bold: true, fill: 'FFDBEAFE' });
    dias.forEach((d, i) => {
      if (d.saldoFinal < 0) {
        const c = final.getCell(i + 2);
        c.font = { bold: true, color: { argb: 'FFB91C1C' } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
      }
    });

    // ── Hoja Saldos bancarios ────────────────────────────────────────────────────────
    const wsb = wb.addWorksheet('Saldos bancarios');
    wsb.columns = [
      { header: 'Código', key: 'code', width: 14 },
      { header: 'Cuenta', key: 'name', width: 36 },
      { header: 'Tipo', key: 'kind', width: 10 },
      { header: 'Saldo inicial', key: 'saldo', width: 16 },
      { header: 'Fecha de corte', key: 'corte', width: 16 },
    ];
    wsb.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    wsb.getRow(1).eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HDR } }; });
    const corte = new Date(data.rango.from);
    corte.setDate(corte.getDate() - 1);
    const corteStr = corte.toLocaleDateString('es-EC');
    for (const a of data.cuentas) {
      wsb.addRow({ code: a.code, name: a.name, kind: a.kind, saldo: a.saldoInicial, corte: corteStr });
    }
    const tb = wsb.addRow({ name: 'TOTAL CONSOLIDADO', saldo: data.saldoInicial, corte: corteStr });
    tb.font = { bold: true };
    wsb.getColumn('saldo').numFmt = MONEY;

    // ── Hoja Detalle (una fila por documento; concilia con Flujo) ────────────────────
    const wsd = wb.addWorksheet('Detalle');
    wsd.columns = [
      { header: 'Fecha proyectada', key: 'day', width: 16 },
      { header: 'Fecha legal', key: 'due', width: 14 },
      { header: 'Fecha efectiva', key: 'eff', width: 14 },
      { header: 'Categoría', key: 'cat', width: 20 },
      { header: 'Subcategoría', key: 'sub', width: 20 },
      { header: 'Dirección', key: 'dir', width: 10 },
      { header: 'Tercero', key: 'party', width: 30 },
      { header: 'Documento', key: 'num', width: 18 },
      { header: 'Origen', key: 'src', width: 18 },
      { header: 'Importe original', key: 'total', width: 16 },
      { header: 'Pagado/cobrado', key: 'aplicado', width: 16 },
      { header: 'Saldo pendiente', key: 'saldo', width: 16 },
      { header: 'Estado', key: 'estado', width: 14 },
      { header: 'Vencida', key: 'vencida', width: 10 },
      { header: 'Reprogramada', key: 'repro', width: 14 },
      { header: 'Motivo exclusión', key: 'motivo', width: 26 },
      { header: 'Cuenta', key: 'cuenta', width: 14 },
      { header: 'ID documento', key: 'id', width: 26 },
      { header: 'ID cartera', key: 'docId', width: 26 },
    ];
    wsd.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    wsd.getRow(1).eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HDR } }; });
    for (const d of data.detalle) {
      wsd.addRow({
        day: d.day || (d.excluida ? 'EXCLUIDO' : 'FUERA DE RANGO'),
        due: d.dueDate ? new Date(d.dueDate).toLocaleDateString('es-EC') : '',
        eff: d.effectiveDate ? new Date(d.effectiveDate).toLocaleDateString('es-EC') : '',
        cat: d.category,
        sub: d.subcategory || '',
        dir: d.direction,
        party: d.tercero,
        num: d.numero || d.descripcion || '',
        src: d.esReal ? `REAL · ${d.sourceModel || 'Asiento'}` : (d.sourceModel || d.docModel),
        total: d.total,
        aplicado: d.aplicado,
        saldo: d.esReal ? d.total : d.saldo,
        estado: d.estado,
        vencida: d.vencida ? 'SÍ' : '',
        repro: d.reprogramada ? 'SÍ' : '',
        motivo: d.excludedReason || '',
        cuenta: d.cuenta || '',
        id: d.docRef,
        docId: d.id,
      });
    }
    ['total', 'aplicado', 'saldo'].forEach((k) => { wsd.getColumn(k).numFmt = MONEY; });

    // ── Hoja Movimientos reales ─────────────────────────────────────────────────────
    const wsm = wb.addWorksheet('Movimientos reales');
    wsm.columns = [
      { header: 'Fecha', key: 'date', width: 14 },
      { header: 'Cuenta', key: 'cuenta', width: 30 },
      { header: 'Tercero', key: 'party', width: 32 },
      { header: 'Ingreso', key: 'in', width: 14 },
      { header: 'Egreso', key: 'out', width: 14 },
      { header: 'Método', key: 'metodo', width: 16 },
      { header: 'Documento', key: 'doc', width: 22 },
      { header: 'Asiento', key: 'asiento', width: 16 },
      { header: 'Referencia', key: 'ref', width: 20 },
    ];
    wsm.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    wsm.getRow(1).eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HDR } }; });
    for (const m of movs.rows) {
      wsm.addRow({
        date: new Date(m.date).toLocaleDateString('es-EC'),
        cuenta: m.cuenta ? `${m.cuenta.code} ${m.cuenta.name}` : '',
        party: m.contraparte,
        in: m.ingreso || null,
        out: m.egreso || null,
        metodo: m.metodo || '',
        doc: m.documento ? `${m.documento.model}` : '',
        asiento: m.numeroAsiento,
        ref: m.referencia,
      });
    }
    ['in', 'out'].forEach((k) => { wsm.getColumn(k).numFmt = MONEY; });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="flujo_caja_${Date.now()}.xlsx"`);
    const buffer = await wb.xlsx.writeBuffer();
    res.send(Buffer.from(buffer));
  } catch (e) { fail(res, e); }
};
