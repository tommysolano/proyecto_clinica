const RetentionRule = require('../models/RetentionRule');
const ChartOfAccount = require('../models/ChartOfAccount');
const { seedRetentionRules } = require('../utils/retentionRules');

const ALLOWED = ['type', 'code', 'description', 'rate', 'appliesTo', 'baseType', 'payableAccount', 'validFrom', 'validTo', 'active'];
function pick(body) {
  const out = {};
  for (const k of ALLOWED) if (body[k] !== undefined) out[k] = body[k];
  if (out.payableAccount === '' ) out.payableAccount = null;
  return out;
}

// Valida que la cuenta (si viene) exista y sea de la clínica.
async function assertAccount(clinicId, accountId) {
  if (!accountId) return;
  const acc = await ChartOfAccount.findOne({ _id: accountId, clinic: clinicId });
  if (!acc) throw Object.assign(new Error('La cuenta de retención por pagar no existe o no pertenece a la clínica'), { status: 400 });
}

const BASE_TYPES = ['SUBTOTAL_IVA', 'SUBTOTAL_0', 'SUBTOTAL_TOTAL', 'IVA'];

// Valida los campos obligatorios y rangos de una regla.
function assertRuleFields(data) {
  if (!data.type || !['RENTA', 'IVA'].includes(data.type)) throw Object.assign(new Error('El tipo debe ser RENTA o IVA'), { status: 400 });
  if (!data.code || !String(data.code).trim()) throw Object.assign(new Error('El código es obligatorio'), { status: 400 });
  if (data.baseType != null && !BASE_TYPES.includes(data.baseType)) throw Object.assign(new Error('Tipo de base inválido'), { status: 400 });
  const rate = Number(data.rate);
  if (!(rate >= 0 && rate <= 100)) throw Object.assign(new Error('El porcentaje debe estar entre 0 y 100'), { status: 400 });
}

const overlaps = (aFrom, aTo, bFrom, bTo) => {
  const s1 = aFrom ? new Date(aFrom).getTime() : -Infinity;
  const e1 = aTo ? new Date(aTo).getTime() : Infinity;
  const s2 = bFrom ? new Date(bFrom).getTime() : -Infinity;
  const e2 = bTo ? new Date(bTo).getTime() : Infinity;
  return s1 <= e2 && s2 <= e1;
};

/**
 * No permite dos reglas ACTIVAS con el mismo clínica+tipo+código cuya vigencia se
 * solape. Reglas inactivas o de códigos/tipos distintos pueden coexistir; también se
 * permiten versiones del mismo código en vigencias que NO se solapan (histórico).
 */
async function assertNoOverlap(clinicId, data, excludeId) {
  if (data.active === false) return; // una regla inactiva no compite por vigencia
  const q = { clinic: clinicId, type: data.type, code: String(data.code).trim(), active: true };
  if (excludeId) q._id = { $ne: excludeId };
  const others = await RetentionRule.find(q).select('validFrom validTo');
  for (const o of others) {
    if (overlaps(data.validFrom, data.validTo, o.validFrom, o.validTo)) {
      throw Object.assign(new Error(`Ya existe una regla activa ${data.type} ${data.code} con vigencia solapada`), { status: 400 });
    }
  }
}

/** GET /retention-rules?type=&active= — lista el catálogo de la clínica. */
exports.list = async (req, res) => {
  try {
    const filter = { clinic: req.clinicId };
    if (req.query.type) filter.type = req.query.type;
    if (req.query.active === 'true') filter.active = true;
    if (req.query.active === 'false') filter.active = false;
    const rules = await RetentionRule.find(filter)
      .populate('payableAccount', 'code name')
      .sort({ type: 1, code: 1 });
    res.json(rules);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/** POST /retention-rules — crea una regla. */
exports.create = async (req, res) => {
  try {
    const data = pick(req.body);
    assertRuleFields(data);
    await assertAccount(req.clinicId, data.payableAccount);
    await assertNoOverlap(req.clinicId, data, null);
    const rule = await RetentionRule.create({ ...data, clinic: req.clinicId, createdBy: req.user?._id || null });
    res.status(201).json(rule);
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ message: 'Ya existe una regla activa con ese tipo y código' });
    res.status(e.status || 400).json({ message: e.message });
  }
};

/** PUT /retention-rules/:id — edita una regla (conserva snapshots ya contabilizados). */
exports.update = async (req, res) => {
  try {
    const current = await RetentionRule.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!current) return res.status(404).json({ message: 'Regla no encontrada' });
    const data = pick(req.body);
    // Combina con el estado actual para validar tipo/código/vigencia/estado resultantes.
    const merged = {
      type: data.type ?? current.type,
      code: data.code ?? current.code,
      baseType: data.baseType ?? current.baseType,
      rate: data.rate ?? current.rate,
      validFrom: data.validFrom !== undefined ? data.validFrom : current.validFrom,
      validTo: data.validTo !== undefined ? data.validTo : current.validTo,
      active: data.active !== undefined ? data.active : current.active,
    };
    assertRuleFields(merged);
    await assertAccount(req.clinicId, data.payableAccount);
    await assertNoOverlap(req.clinicId, merged, current._id);
    Object.assign(current, data);
    await current.save();
    res.json(current);
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ message: 'Ya existe una regla activa con ese tipo y código' });
    res.status(e.status || 400).json({ message: e.message });
  }
};

/** PATCH /retention-rules/:id/toggle — activa/desactiva. */
exports.toggle = async (req, res) => {
  try {
    const rule = await RetentionRule.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!rule) return res.status(404).json({ message: 'Regla no encontrada' });
    const next = req.body.active != null ? !!req.body.active : !rule.active;
    // Al reactivar, no debe solaparse con otra regla activa del mismo tipo+código.
    if (next && !rule.active) await assertNoOverlap(req.clinicId, { type: rule.type, code: rule.code, validFrom: rule.validFrom, validTo: rule.validTo, active: true }, rule._id);
    rule.active = next;
    await rule.save();
    res.json(rule);
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/** POST /retention-rules/seed — crea las reglas por defecto que falten (idempotente). */
exports.seed = async (req, res) => {
  try {
    const r = await seedRetentionRules(req.clinicId, { createdBy: req.user?._id || null });
    res.json({ message: `Catálogo actualizado: ${r.created} creadas, ${r.existing} ya existían`, ...r });
  } catch (e) { res.status(500).json({ message: e.message }); }
};
