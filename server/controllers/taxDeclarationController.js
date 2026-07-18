/**
 * DECLARACIONES SRI (Formularios 103 y 104) con ciclo de vida persistente.
 *
 * Flujo: borrador → recalcular → finalizar (asiento + CxP al SRI) → historial →
 * sustitutiva → pago de la obligación.
 *
 * Invariantes:
 *   - Un borrador NO toca contabilidad ni cartera.
 *   - Finalizar es TRANSACCIONAL e IDEMPOTENTE (sourceAction único por declaración).
 *   - Una declaración FINALIZED es INMUTABLE: corregir crea una versión nueva.
 *   - Al finalizar NUNCA se mueve Banco: solo se reconoce la obligación.
 *   - La CxP al SRI no genera un segundo crédito: el pasivo ya lo reconoció el asiento.
 */
const SriDeclaration = require('../models/SriDeclaration');
const Clinic = require('../models/Clinic');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const Payable = require('../models/Payable');
const { createEntry, reverseEntry, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const { openPayable, applyToPayable, voidPayable } = require('../utils/subledger');
const { resolveReportRange } = require('../utils/reportDateRange');
const { getDefinition, editableBoxes, validateCell, XML_DISCLAIMER } = require('../utils/sriForms/definitions');
const { compute104 } = require('../utils/sriForms/compute104');
const { compute103 } = require('../utils/sriForms/compute103');
const { buildDeclarationLines, buildDraftXml } = require('../utils/sriForms/posting');
const {
  readIdempotencyKey, fingerprint, assertSameFingerprint, assertSameTarget, normalize: N, conflict,
} = require('../utils/idempotency');

const r2 = (n) => +(Number(n) || 0).toFixed(2);
const periodKeyOf = (year, month) => `${year}-${String(month).padStart(2, '0')}`;
const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

/**
 * Huella determinista de una solicitud de creación (borrador o sustitutiva).
 *
 * Incluye SOLO lo que cambia el resultado: clínica, formulario, período, versión, la
 * declaración reemplazada, los casilleros editables normalizados y las fechas contable /
 * de vencimiento / planificada. NO incluye timestamps, ni el usuario, ni los casilleros
 * calculados (que el backend vuelve a obtener del origen), ni los campos del cliente que ya
 * se ignoran. Las claves se ordenan al serializar, así que el orden del JSON no la altera.
 *
 * Sirve para resolver una colisión concurrente: si la petición perdedora es EQUIVALENTE a
 * la ganadora se devuelve el documento existente; si pedía algo distinto se responde 409 y
 * NO se sobrescribe el documento ganador.
 */
function requestFingerprintOf({ clinicId, formType, periodKey, version, replaces, cells, accountingDate, dueDate, plannedPaymentDate }) {
  const normalizedCells = Object.keys(cells || {})
    .sort()
    .reduce((acc, box) => { acc[String(box)] = N.num(cells[box]); return acc; }, {});
  return fingerprint({
    clinic: String(clinicId),
    formType: String(formType),
    periodKey: String(periodKey),
    version: Number(version) || 1,
    replaces: N.id(replaces),
    cells: normalizedCells,
    accountingDate: N.date(accountingDate),
    dueDate: N.date(dueDate),
    plannedPaymentDate: N.date(plannedPaymentDate),
  });
}

/**
 * Resuelve una colisión: la solicitud perdedora frente al documento que ya existe.
 * Huella igual ⇒ replay (se devuelve el existente). Huella distinta ⇒ 409.
 */
function resolveCollision(existing, incomingFingerprint, what) {
  if (existing.requestFingerprint && existing.requestFingerprint !== incomingFingerprint) {
    throw conflict(
      `Otra solicitud simultánea ya creó ${what} de este período con contenido DIFERENTE `
      + `(${existing.formType} ${existing.periodKey} v${existing.version}). No se sobrescribió. `
      + 'Recargue la declaración existente y aplique sus cambios sobre ella.'
    );
  }
}

/** Fecha contable por defecto: último día del mes declarado (devengo del período). */
function defaultAccountingDate(year, month) {
  return new Date(year, month, 0, 23, 59, 59, 999);
}

/**
 * Importe YA PAGADO de una declaración. La CxP (submayor) es la fuente de verdad del
 * saldo: `applied` recoge todas las aplicaciones de pago.
 */
async function appliedAmountOf(clinicId, declarationId, session) {
  const payable = await Payable.findOne({
    clinic: clinicId, sourceModel: 'SriDeclaration', sourceRef: declarationId,
  }).session(session || null);
  return r2(payable?.applied || 0);
}

/**
 * Una sustitutiva REVERSA el asiento de la declaración a la que reemplaza. Si esa
 * declaración ya recibió pagos, reversarla dejaría el pago bancario (que sí ocurrió y no
 * se puede borrar) sin contrapartida: la cuenta «SRI por pagar» quedaría con saldo deudor
 * y la nueva obligación pediría pagar otra vez lo ya pagado.
 *
 * No existe todavía una política contable acordada para corregir una declaración pagada
 * (¿nota de crédito del SRI? ¿anticipo a favor? ¿pago en exceso?), así que en vez de
 * corromper el historial se BLOQUEA y se explica el procedimiento requerido.
 */
async function assertSubstitutable(clinicId, declaration, session) {
  const applied = await appliedAmountOf(clinicId, declaration._id, session);
  if (applied > 0) {
    throw badRequest(
      `La declaración ya tiene pagos aplicados por $${applied.toFixed(2)}. Sustituirla exigiría reversar el asiento que respalda ese pago y el pago bancario quedaría sin contrapartida (y la nueva obligación cobraría de nuevo lo ya pagado). `
      + 'Primero debe registrarse la reversión del pago con su contador (el sistema aún no tiene un procedimiento seguro para corregir declaraciones pagadas) y recién entonces crear la sustitutiva.'
    );
  }
  return applied;
}

/**
 * Acepta SOLO los casilleros declarados EDITABLE y valida su tipo. Los calculados, los
 * totales y el snapshot que venga del cliente se rechazan/ignoran: el backend los recalcula
 * desde el origen. Los TOPES (que dependen del cálculo del período) se validan en `update`
 * y de nuevo al finalizar.
 * @returns {object} mapa {box: number} normalizado
 */
function validateEditableCells(formType, incoming) {
  const allowed = new Set(editableBoxes(formType));
  const out = {};
  for (const [box, value] of Object.entries(incoming || {})) {
    if (!allowed.has(String(box))) {
      throw badRequest(`El casillero ${box} no existe o es calculado por el sistema: no se puede editar.`);
    }
    if (typeof value !== 'number' && typeof value !== 'string') throw badRequest(`El casillero ${box} debe ser un número.`);
    const numeric = typeof value === 'number' ? value : Number(String(value).trim());
    if (String(value).trim() === '' || !Number.isFinite(numeric)) throw badRequest(`El casillero ${box} debe ser un número válido.`);
    out[String(box)] = numeric;
  }
  return out;
}

function cellsToMap(cells) {
  const out = {};
  for (const c of cells || []) out[c.box] = Number(c.value) || 0;
  return out;
}
function mapToCells(map) {
  return Object.entries(map || {}).map(([box, value]) => ({ box: String(box), value: r2(value) }));
}

/** Ejecuta el motor de cálculo del formulario para el período. */
async function computeForm({ clinicId, formType, year, month, editable }) {
  const range = resolveReportRange({ periodType: 'MONTHLY', year, month });
  if (formType === '104') return compute104({ clinicId, range, editable });
  return compute103({ clinicId, range });
}

/** Vuelve a calcular una declaración en BORRADOR conservando lo capturado. */
async function recomputeDraft(decl, clinicId) {
  const result = await computeForm({
    clinicId,
    formType: decl.formType,
    year: decl.year,
    month: decl.month,
    editable: cellsToMap(decl.editableCells),
  });
  decl.computedCells = mapToCells(result.computed);
  decl.editableCells = mapToCells(result.editable);
  decl.totals = result.totals;
  decl.snapshot = {
    ...result.snapshot,
    conciliaciones: result.conciliaciones,
    warnings: result.warnings,
    computedAt: new Date(),
  };
  return result;
}

/**
 * Respuesta enriquecida para la UI: declaración + definición + conciliaciones + estado de
 * la obligación. La UI NO deriva el saldo de los totales (que son del período declarado):
 * lo lee de la CxP, que es la fuente de verdad de lo pagado y lo pendiente. Así no ofrece
 * "Pagar" sobre una obligación liquidada ni "Sustituir" sobre una declaración ya pagada.
 */
async function present(clinicId, decl, extra = {}) {
  const def = getDefinition(decl.formType);
  const payable = await Payable.findOne({
    clinic: clinicId, sourceModel: 'SriDeclaration', sourceRef: decl._id,
  }).lean();
  return {
    declaration: decl,
    definition: def,
    cells: decl.cellMap(),
    conciliaciones: decl.snapshot?.conciliaciones || [],
    warnings: decl.snapshot?.warnings || [],
    obligacion: payable
      ? {
          total: r2(payable.total),
          applied: r2(payable.applied),
          balance: r2(payable.balance),
          status: payable.status,
          dueDate: payable.dueDate,
          plannedPaymentDate: payable.plannedPaymentDate || null,
        }
      : null,
    xmlDisclaimer: XML_DISCLAIMER,
    ...extra,
  };
}

// ─────────────────────────────── Consulta ───────────────────────────────

/** GET /tax-declarations/definition?formType=104 — estructura declarativa del formulario. */
exports.definition = async (req, res) => {
  try {
    res.json({ definition: getDefinition(req.query.formType || '104'), xmlDisclaimer: XML_DISCLAIMER });
  } catch (e) { res.status(e.status || 500).json({ message: e.message }); }
};

/** GET /tax-declarations?formType&year&month — historial (todas las versiones). */
exports.list = async (req, res) => {
  try {
    const filter = { clinic: req.clinicId };
    if (req.query.formType) filter.formType = String(req.query.formType);
    if (req.query.year) filter.year = parseInt(req.query.year, 10);
    if (req.query.month) filter.month = parseInt(req.query.month, 10);
    const items = await SriDeclaration.find(filter)
      .sort({ year: -1, month: -1, version: -1 })
      .populate('finalizedBy', 'name')
      .limit(200);
    res.json({ items });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.get = async (req, res) => {
  try {
    const decl = await SriDeclaration.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!decl) return res.status(404).json({ message: 'Declaración no encontrada' });
    res.json(await present(req.clinicId, decl));
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ─────────────────────────────── Borrador ───────────────────────────────

/**
 * POST /tax-declarations/draft { formType, year, month, cells?, accountingDate?, dueDate?, plannedPaymentDate? }
 *
 * Crea el borrador del período (o devuelve el existente, recalculado). Solo puede haber un
 * DRAFT por (clínica, formulario, período): lo garantiza el índice único parcial.
 *
 * Ante una colisión concurrente se compara la HUELLA de la solicitud:
 *   - equivalente  → se devuelve el borrador existente (`idempotentReplay: true`);
 *   - diferente    → 409, sin sobrescribir el borrador ganador.
 */
exports.draft = async (req, res) => {
  try {
    const formType = String(req.body?.formType || '');
    const year = parseInt(req.body?.year, 10);
    const month = parseInt(req.body?.month, 10);
    const def = getDefinition(formType);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      throw badRequest('Período inválido: indique año y mes.');
    }
    const periodKey = periodKeyOf(year, month);

    // Contenido opcional de la solicitud (lo que la hace distinta de otra).
    const cells = validateEditableCells(formType, req.body?.cells);
    const dates = {
      accountingDate: req.body?.accountingDate || null,
      dueDate: req.body?.dueDate || null,
      plannedPaymentDate: req.body?.plannedPaymentDate || null,
    };

    const existing = await SriDeclaration.findOne({ clinic: req.clinicId, formType, periodKey, status: 'DRAFT' });
    const last = existing
      || await SriDeclaration.findOne({ clinic: req.clinicId, formType, periodKey }).sort({ version: -1 });
    if (!existing && last && last.status === 'FINALIZED') {
      throw badRequest('El período ya tiene una declaración finalizada. Cree una SUSTITUTIVA para corregirla.');
    }
    const version = existing ? existing.version : (last ? last.version + 1 : 1);
    const fp = requestFingerprintOf({
      clinicId: req.clinicId, formType, periodKey, version, replaces: null, cells, ...dates,
    });

    if (existing) {
      // Ya hay borrador: si la solicitud pide lo mismo, se devuelve; si pide otra cosa, 409.
      resolveCollision(existing, fp, 'el borrador');
      await recomputeDraft(existing, req.clinicId);
      await existing.save();
      return res.json({ ...(await present(req.clinicId, existing)), idempotentReplay: true });
    }

    const decl = new SriDeclaration({
      clinic: req.clinicId,
      formType,
      year,
      month,
      periodKey,
      version,
      status: 'DRAFT',
      definitionVersion: def.definitionVersion,
      editableCells: mapToCells(cells),
      accountingDate: dates.accountingDate ? new Date(dates.accountingDate) : null,
      dueDate: dates.dueDate ? new Date(dates.dueDate) : null,
      plannedPaymentDate: dates.plannedPaymentDate ? new Date(dates.plannedPaymentDate) : null,
      requestFingerprint: fp,
      createdBy: req.user._id,
    });
    await recomputeDraft(decl, req.clinicId);
    try {
      await decl.save();
    } catch (e) {
      // Índice único parcial (un solo DRAFT por período): otra petición simultánea lo creó
      // primero. Se compara la huella en vez de devolver un E11000 crudo.
      if (e.code === 11000) {
        const winner = await SriDeclaration.findOne({ clinic: req.clinicId, formType, periodKey, status: 'DRAFT' });
        if (winner) {
          resolveCollision(winner, fp, 'el borrador');
          return res.json({ ...(await present(req.clinicId, winner)), idempotentReplay: true });
        }
      }
      throw e;
    }
    res.json(await present(req.clinicId, decl));
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/** POST /tax-declarations/:id/recompute — recalcula el borrador con los datos actuales. */
exports.recompute = async (req, res) => {
  try {
    const decl = await SriDeclaration.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!decl) return res.status(404).json({ message: 'Declaración no encontrada' });
    if (decl.status !== 'DRAFT') throw badRequest('Solo se recalcula un borrador. Una declaración finalizada es inmutable.');
    await recomputeDraft(decl, req.clinicId);
    await decl.save();
    res.json(await present(req.clinicId, decl));
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/**
 * PUT /tax-declarations/:id { cells: { '565': 12.3 }, dueDate, plannedPaymentDate, notes }
 * Guarda los casilleros EDITABLES (los calculados se ignoran) y recalcula.
 */
exports.update = async (req, res) => {
  try {
    const decl = await SriDeclaration.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!decl) return res.status(404).json({ message: 'Declaración no encontrada' });
    if (decl.status !== 'DRAFT') throw badRequest('Solo se edita un borrador. Para corregir una declaración finalizada cree una sustitutiva.');

    // Solo casilleros EDITABLE, con tipo validado (un 'abc' no se convierte en 0 en silencio).
    // Los calculados, los totales y el snapshot del cliente se recalculan desde el origen.
    const merged = { ...cellsToMap(decl.editableCells), ...validateEditableCells(decl.formType, req.body?.cells) };

    // Se valida contra los TOPES vigentes (IVA disponible, base 0% real...).
    const result = await computeForm({
      clinicId: req.clinicId, formType: decl.formType, year: decl.year, month: decl.month, editable: merged,
    });
    for (const box of Object.keys(merged)) {
      const error = validateCell(decl.formType, box, merged[box], result.limits);
      if (error) throw badRequest(error);
    }

    decl.editableCells = mapToCells(result.editable);
    decl.computedCells = mapToCells(result.computed);
    decl.totals = result.totals;
    decl.snapshot = { ...result.snapshot, conciliaciones: result.conciliaciones, warnings: result.warnings, computedAt: new Date() };
    if (req.body?.dueDate !== undefined) decl.dueDate = req.body.dueDate ? new Date(req.body.dueDate) : null;
    if (req.body?.plannedPaymentDate !== undefined) {
      decl.plannedPaymentDate = req.body.plannedPaymentDate ? new Date(req.body.plannedPaymentDate) : null;
    }
    if (req.body?.accountingDate !== undefined) {
      decl.accountingDate = req.body.accountingDate ? new Date(req.body.accountingDate) : null;
    }
    if (req.body?.notes !== undefined) decl.notes = String(req.body.notes || '');
    await decl.save();
    res.json(await present(req.clinicId, decl));
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

// ─────────────────────────────── Finalizar ───────────────────────────────

/**
 * POST /tax-declarations/:id/finalize { accountingDate?, dueDate?, plannedPaymentDate? }
 *
 * Cierra el período tributario: reclasifica el IVA no deducible, cierra IVA ventas/compras
 * (104) o las retenciones (103), reconoce la CxP al SRI y congela el snapshot. Si es
 * SUSTITUTIVA, primero reversa el asiento y anula la CxP de la declaración reemplazada.
 */
exports.finalize = async (req, res) => {
  try {
    const declId = await runInTransaction(async (session) => {
      const decl = await SriDeclaration.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!decl) throw Object.assign(new Error('Declaración no encontrada'), { status: 404 });
      if (decl.status !== 'DRAFT') throw badRequest('La declaración ya fue finalizada. Cree una sustitutiva para corregirla.');

      // Fecha contable: la del body, si no la prevista en el borrador, y si no el último día
      // del período declarado.
      const accountingDate = req.body?.accountingDate
        ? new Date(req.body.accountingDate)
        : (decl.accountingDate || defaultAccountingDate(decl.year, decl.month));
      await assertPeriodOpen(req.clinicId, accountingDate, { session });

      // Recalcula contra los datos vigentes (nadie finaliza un snapshot rancio) y
      // re-valida lo capturado.
      const result = await computeForm({
        clinicId: req.clinicId, formType: decl.formType, year: decl.year, month: decl.month,
        editable: cellsToMap(decl.editableCells),
      });
      for (const box of Object.keys(cellsToMap(decl.editableCells))) {
        const error = validateCell(decl.formType, box, cellsToMap(decl.editableCells)[box], result.limits);
        if (error) throw badRequest(error);
      }
      const blocking = (result.warnings || []).filter((w) => w.severity !== 'info' && [
        'IVA_GASTO_EXCEDE', 'IVA_GASTO_NEGATIVO', 'IMPUESTO_Y_CREDITO', 'BASE_0_DESCUADRADA', 'BASE_EXCEDE_COMPRAS', 'RETENCION_DUPLICADA',
      ].includes(w.code));
      if (blocking.length) throw badRequest(`No se puede finalizar: ${blocking.map((w) => w.message).join(' · ')}`);

      decl.computedCells = mapToCells(result.computed);
      decl.editableCells = mapToCells(result.editable);
      decl.totals = result.totals;
      decl.snapshot = { ...result.snapshot, conciliaciones: result.conciliaciones, warnings: result.warnings, computedAt: new Date() };

      // Sustitutiva: revierte el efecto contable de la declaración reemplazada ANTES de
      // registrar el nuevo (no se duplica el pasivo ni el cierre de impuestos).
      let replaced = null;
      if (decl.replaces) {
        replaced = await SriDeclaration.findOne({ _id: decl.replaces, clinic: req.clinicId }).session(session);
        if (replaced && replaced.status === 'FINALIZED') {
          // El pago pudo registrarse DESPUÉS de crear este borrador sustitutivo: se vuelve
          // a comprobar aquí, que es el punto en que se reversaría el asiento pagado.
          await assertSubstitutable(req.clinicId, replaced, session);
          if (replaced.journalEntry) {
            await reverseEntry({
              clinicId: req.clinicId,
              entryId: replaced.journalEntry,
              userId: req.user._id,
              reason: `Declaración sustitutiva ${decl.formType} ${decl.periodKey} v${decl.version}`,
              date: accountingDate,
              session,
            });
          }
          await voidPayable(
            { clinicId: req.clinicId, sourceModel: 'SriDeclaration', sourceRef: replaced._id },
            { session }
          );
          replaced.status = 'SUBSTITUTIVE';
          replaced.replacedBy = decl._id;
          await replaced.save({ session });
        }
      }

      const { lines, obligacion, controlAccount } = await buildDeclarationLines(req.clinicId, decl, session);
      if (lines.length >= 2) {
        const entry = await createEntry({
          clinicId: req.clinicId,
          date: accountingDate,
          description: `Declaración Formulario ${decl.formType} · ${decl.periodKey}${decl.version > 1 ? ` (sustitutiva v${decl.version})` : ''}`,
          source: 'AJUSTE',
          sourceRef: decl._id,
          sourceModel: 'SriDeclaration',
          sourceAction: 'FINALIZE',
          lines,
          userId: req.user._id,
          session,
        });
        decl.journalEntry = entry._id;
      }

      // CxP al SRI: submayor de la obligación que el asiento ya reconoció (sin doble pasivo).
      if (obligacion > 0) {
        if (req.body?.dueDate !== undefined) decl.dueDate = req.body.dueDate ? new Date(req.body.dueDate) : decl.dueDate;
        if (req.body?.plannedPaymentDate !== undefined) {
          decl.plannedPaymentDate = req.body.plannedPaymentDate ? new Date(req.body.plannedPaymentDate) : decl.plannedPaymentDate;
        }
        const payable = await openPayable({
          clinic: req.clinicId,
          party: { model: 'Clinic', ref: null, name: 'Servicio de Rentas Internas' },
          sourceModel: 'SriDeclaration',
          sourceRef: decl._id,
          docType: 'OTRO',
          number: `F${decl.formType}-${decl.periodKey}${decl.version > 1 ? `-v${decl.version}` : ''}`,
          issueDate: accountingDate,
          dueDate: decl.dueDate || null,
          // Solo para la proyección de flujo de caja: no altera el vencimiento legal.
          plannedPaymentDate: decl.plannedPaymentDate || null,
          total: obligacion,
          account: controlAccount,
          notes: `Formulario ${decl.formType} · ${decl.periodKey}`,
        }, { session });
        decl.payableRef = payable._id;
      }

      const clinic = await Clinic.findById(req.clinicId).session(session);
      const { xml, hash } = buildDraftXml(decl, clinic);
      decl.xmlSnapshot = xml;
      decl.xmlHash = hash;
      decl.status = 'FINALIZED';
      decl.finalizedAt = new Date();
      decl.finalizedBy = req.user._id;
      await decl.save({ session });
      return decl._id;
    });

    const decl = await SriDeclaration.findById(declId);
    res.json(await present(req.clinicId, decl));
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/**
 * POST /tax-declarations/:id/substitute { cells?, accountingDate?, dueDate?, plannedPaymentDate? }
 *
 * Nueva versión (borrador) que reemplaza a una finalizada. La anterior conserva su snapshot
 * intacto hasta que la sustituta se finalice. Por defecto arranca de lo capturado en la
 * original; se puede pedir la sustitutiva ya con otros valores.
 *
 * Ante una colisión concurrente se compara la HUELLA: equivalente → se devuelve la
 * sustitutiva existente; diferente → 409 sin sobrescribir la ganadora.
 */
exports.substitute = async (req, res) => {
  try {
    const original = await SriDeclaration.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!original) return res.status(404).json({ message: 'Declaración no encontrada' });
    if (original.status !== 'FINALIZED') throw badRequest('Solo se sustituye una declaración finalizada.');
    await assertSubstitutable(req.clinicId, original);

    const formType = original.formType;
    const periodKey = original.periodKey;
    // Contenido pedido: por defecto, lo de la original.
    const overrides = validateEditableCells(formType, req.body?.cells);
    const cells = { ...cellsToMap(original.editableCells), ...overrides };
    const dates = {
      accountingDate: req.body?.accountingDate ?? original.accountingDate ?? null,
      dueDate: req.body?.dueDate ?? original.dueDate ?? null,
      plannedPaymentDate: req.body?.plannedPaymentDate ?? original.plannedPaymentDate ?? null,
    };

    const last = await SriDeclaration.findOne({ clinic: req.clinicId, formType, periodKey }).sort({ version: -1 });
    const existingDraft = await SriDeclaration.findOne({
      clinic: req.clinicId, formType, periodKey, status: 'DRAFT',
    });
    const version = existingDraft ? existingDraft.version : last.version + 1;
    const fp = requestFingerprintOf({
      clinicId: req.clinicId, formType, periodKey, version, replaces: original._id, cells, ...dates,
    });

    if (existingDraft) {
      resolveCollision(existingDraft, fp, 'la sustitutiva');
      return res.json({ ...(await present(req.clinicId, existingDraft)), idempotentReplay: true });
    }

    const decl = new SriDeclaration({
      clinic: req.clinicId,
      formType,
      year: original.year,
      month: original.month,
      periodKey,
      version,
      status: 'DRAFT',
      definitionVersion: getDefinition(formType).definitionVersion,
      editableCells: mapToCells(cells),
      accountingDate: dates.accountingDate ? new Date(dates.accountingDate) : null,
      dueDate: dates.dueDate ? new Date(dates.dueDate) : null,
      plannedPaymentDate: dates.plannedPaymentDate ? new Date(dates.plannedPaymentDate) : null,
      replaces: original._id,
      requestFingerprint: fp,
      createdBy: req.user._id,
    });
    await recomputeDraft(decl, req.clinicId);
    try {
      await decl.save();
    } catch (e) {
      // Dos sustitutivas simultáneas: los índices únicos (versión y un solo DRAFT) dejan
      // pasar una; la perdedora compara huellas en vez de devolver un E11000 crudo.
      if (e.code === 11000) {
        const winner = await SriDeclaration.findOne({ clinic: req.clinicId, formType, periodKey, status: 'DRAFT' });
        if (winner) {
          resolveCollision(winner, fp, 'la sustitutiva');
          return res.json({ ...(await present(req.clinicId, winner)), idempotentReplay: true });
        }
      }
      throw e;
    }
    res.json(await present(req.clinicId, decl));
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/** POST /tax-declarations/:id/void { reason } — anula: reversa el asiento y la CxP. */
exports.void = async (req, res) => {
  try {
    const declId = await runInTransaction(async (session) => {
      const decl = await SriDeclaration.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!decl) throw Object.assign(new Error('Declaración no encontrada'), { status: 404 });
      if (decl.status === 'VOID') throw badRequest('La declaración ya está anulada.');
      // Mismo motivo que la sustitutiva: anular reversaría el asiento que respalda un pago
      // bancario que no se puede borrar. La CxP es la fuente de verdad de lo aplicado.
      const applied = await appliedAmountOf(req.clinicId, decl._id, session);
      if (applied > 0) {
        throw badRequest(`La declaración tiene pagos aplicados por $${applied.toFixed(2)}: primero debe reversarse el pago con su contador. Anularla dejaría el movimiento bancario sin contrapartida.`);
      }

      if (decl.status === 'FINALIZED' && decl.journalEntry) {
        await reverseEntry({
          clinicId: req.clinicId,
          entryId: decl.journalEntry,
          userId: req.user._id,
          reason: req.body?.reason || `Anulación declaración ${decl.formType} ${decl.periodKey}`,
          date: req.body?.date ? new Date(req.body.date) : new Date(),
          session,
        });
      }
      await voidPayable({ clinicId: req.clinicId, sourceModel: 'SriDeclaration', sourceRef: decl._id }, { session });
      decl.status = 'VOID';
      decl.voidReason = req.body?.reason || '';
      await decl.save({ session });
      return decl._id;
    });
    const decl = await SriDeclaration.findById(declId);
    res.json(await present(req.clinicId, decl));
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/**
 * DELETE /tax-declarations/:id — elimina FÍSICAMENTE un borrador.
 *
 * Solo borradores: no tocan contabilidad ni cartera, así que borrarlos no deja movimientos
 * huérfanos. Una declaración FINALIZED (con asiento y CxP) NUNCA se borra: se ANULA (void)
 * para conservar la trazabilidad contable. Sirve para limpiar borradores de prueba.
 */
exports.remove = async (req, res) => {
  try {
    const decl = await SriDeclaration.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!decl) return res.status(404).json({ message: 'Declaración no encontrada' });
    if (decl.status !== 'DRAFT') {
      throw badRequest('Solo se eliminan borradores. Una declaración finalizada se ANULA (no se borra), para conservar el rastro contable.');
    }
    // Un borrador no debería tener asiento ni CxP; si por algún motivo los tuviera, no se
    // borra en silencio (evita dejar contabilidad huérfana): se pide anularlo.
    if (decl.journalEntry || decl.payableRef) {
      throw badRequest('El borrador tiene efectos contables asociados: anúlelo en vez de eliminarlo.');
    }
    await SriDeclaration.deleteOne({ _id: decl._id, clinic: req.clinicId });
    res.json({ ok: true, deleted: String(decl._id) });
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/**
 * POST /tax-declarations/:id/pay { bankAccountId, date, amount?, reference? }
 * Header: `Idempotency-Key` (o body.idempotencyKey por compatibilidad).
 *
 * ÚNICO punto en que el Banco se ve afectado: D SRI por pagar / H Banco, aplicando la CxP.
 * Admite pago parcial. Impide pagar más que el saldo (lo valida el submayor).
 *
 * IDEMPOTENCIA (mismo contrato que el pago de nómina): misma clave + mismo contenido ⇒
 * replay del pago ya registrado (sin otro asiento, ni otro movimiento bancario, ni otra
 * aplicación); misma clave + contenido distinto ⇒ 409; claves distintas ⇒ pagos distintos.
 */
exports.pay = async (req, res) => {
  const idemKey = readIdempotencyKey(req);
  // La huella incluye la IDENTIDAD DEL DESTINO (`declaration`, del parámetro de ruta) y el
  // tipo de operación: la misma clave en otra declaración nunca es un reintento de esta.
  const idemFingerprint = fingerprint({
    op: 'declaration.pay',
    sourceModel: 'SriDeclaration',
    sourceRef: String(req.params.id),
    declaration: String(req.params.id),
    amount: N.num(req.body?.amount),
    bankAccount: N.id(req.body?.bankAccountId),
    date: N.date(req.body?.date),
    reference: req.body?.reference || null,
  });

  try {
    // Replay rápido (doble clic / reintento de red) antes de abrir la transacción. La clave
    // se busca en TODA la clínica (el índice único es de clínica): si la ganó OTRA
    // declaración ⇒ 409, nunca se devuelve su pago como si fuera el de esta.
    if (idemKey) {
      const previa = await SriDeclaration.findOne({
        clinic: req.clinicId, 'payments.idempotencyKey': idemKey,
      });
      if (previa) {
        assertSameTarget(previa._id, req.params.id, 'el pago de declaración');
        const pago = previa.payments.find((x) => x.idempotencyKey === idemKey);
        assertSameFingerprint(pago?.fingerprint, idemFingerprint, 'pago de declaración');
        return res.json({ ...(await present(req.clinicId, previa)), idempotentReplay: true });
      }
    }

    const result = await runInTransaction(async (session) => {
      const decl = await SriDeclaration.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!decl) throw Object.assign(new Error('Declaración no encontrada'), { status: 404 });

      // Dentro de la transacción: la clave pudo ganarla otra petición concurrente (de esta
      // declaración ⇒ replay; de otra ⇒ 409).
      if (idemKey) {
        const dueña = await SriDeclaration.findOne({
          clinic: req.clinicId, 'payments.idempotencyKey': idemKey,
        }).session(session);
        if (dueña) {
          assertSameTarget(dueña._id, decl._id, 'el pago de declaración');
          const yaAplicado = dueña.payments.find((x) => x.idempotencyKey === idemKey);
          assertSameFingerprint(yaAplicado?.fingerprint, idemFingerprint, 'pago de declaración');
          return { declId: decl._id, replay: true };
        }
      }

      if (decl.status !== 'FINALIZED') throw badRequest('Solo se paga una declaración finalizada.');

      const payable = await Payable.findOne({
        clinic: req.clinicId, sourceModel: 'SriDeclaration', sourceRef: decl._id,
      }).session(session);
      if (!payable || payable.status === 'ANULADO') throw badRequest('La declaración no tiene obligación pendiente.');
      const saldo = r2(payable.balance);
      if (saldo <= 0) throw badRequest('La obligación ya está pagada.');

      const amount = req.body?.amount != null ? r2(req.body.amount) : saldo;
      if (amount <= 0) throw badRequest('Monto inválido.');
      if (amount > saldo + 0.005) throw badRequest(`El monto excede el saldo de la obligación (${saldo.toFixed(2)}).`);

      const bank = await BankAccount.findOne({ _id: req.body?.bankAccountId, clinic: req.clinicId }).session(session);
      if (!bank) throw badRequest('Cuenta bancaria no encontrada.');
      if (!bank.chartAccount) throw badRequest('La cuenta bancaria no tiene cuenta contable asociada.');

      const txDate = req.body?.date ? new Date(req.body.date) : new Date();
      await assertPeriodOpen(req.clinicId, txDate, { session });
      const sriPorPagar = await getAccount(req.clinicId, 'sriPorPagar', { session });

      // sourceAction único por pago: permite pagos parciales sin colisionar con la
      // idempotencia del asiento (un mismo pago repetido reusa su asiento).
      const seq = (decl.payments || []).length + 1;
      const entry = await createEntry({
        clinicId: req.clinicId,
        date: txDate,
        description: `Pago Formulario ${decl.formType} · ${decl.periodKey}`,
        source: 'PAGO',
        sourceRef: decl._id,
        sourceModel: 'SriDeclaration',
        sourceAction: `PAY:${seq}`,
        lines: [
          { account: sriPorPagar._id, debit: amount, credit: 0, description: `Pago F${decl.formType} ${decl.periodKey}` },
          { account: bank.chartAccount, debit: 0, credit: amount, description: `Pago F${decl.formType} ${decl.periodKey}` },
        ],
        userId: req.user._id,
        session,
      });

      const [bankTx] = await BankTransaction.create([{
        clinic: req.clinicId,
        bankAccount: bank._id,
        date: txDate,
        type: 'PAGO',
        amount,
        direction: -1,
        description: `Pago Formulario ${decl.formType} ${decl.periodKey}`,
        reference: req.body?.reference || '',
        journalEntry: entry._id,
        sourceModel: 'SriDeclaration',
        sourceRef: decl._id,
        createdBy: req.user._id,
      }], { session });

      await applyToPayable(
        { clinicId: req.clinicId, sourceModel: 'SriDeclaration', sourceRef: decl._id, amount },
        { session }
      );
      decl.payments.push({
        date: txDate,
        amount,
        bankAccount: bank._id,
        journalEntry: entry._id,
        bankTransaction: bankTx._id,
        reference: req.body?.reference || '',
        paidBy: req.user._id,
        idempotencyKey: idemKey,
        fingerprint: idemKey ? idemFingerprint : null,
      });
      if (!decl.paymentJournalEntry) decl.paymentJournalEntry = entry._id;
      await decl.save({ session });
      return { declId: decl._id, replay: false };
    });

    const decl = await SriDeclaration.findById(result.declId);
    const body = await present(req.clinicId, decl);
    res.json(result.replay ? { ...body, idempotentReplay: true } : body);
  } catch (e) {
    // Carrera contra el índice único de la clave (que es de clínica, no de declaración):
    // se resuelve en vez de devolver un E11000 crudo. Si la ganó otra declaración ⇒ 409.
    if (e.code === 11000 && idemKey) {
      const previa = await SriDeclaration.findOne({
        clinic: req.clinicId, 'payments.idempotencyKey': idemKey,
      });
      if (previa) {
        try {
          assertSameTarget(previa._id, req.params.id, 'el pago de declaración');
          const pago = previa.payments.find((x) => x.idempotencyKey === idemKey);
          assertSameFingerprint(pago?.fingerprint, idemFingerprint, 'pago de declaración');
        } catch (conflictErr) {
          return res.status(conflictErr.status || 409).json({ message: conflictErr.message });
        }
        return res.json({ ...(await present(req.clinicId, previa)), idempotentReplay: true });
      }
    }
    res.status(e.status || 400).json({ message: e.message });
  }
};

/**
 * GET /tax-declarations/:id/draft.xml — descarga el BORRADOR TÉCNICO.
 * No es el XML oficial del SRI (ver definitions.js → XML_DISCLAIMER).
 */
exports.draftXml = async (req, res) => {
  try {
    const decl = await SriDeclaration.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!decl) return res.status(404).json({ message: 'Declaración no encontrada' });
    const clinic = await Clinic.findById(req.clinicId);
    const { xml } = decl.xmlSnapshot ? { xml: decl.xmlSnapshot } : buildDraftXml(decl, clinic);
    res.setHeader('Content-Type', 'application/xml');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="borrador-tecnico-F${decl.formType}-${decl.periodKey}-v${decl.version}.xml"`
    );
    res.send(xml);
  } catch (e) { res.status(e.status || 500).json({ message: e.message }); }
};
