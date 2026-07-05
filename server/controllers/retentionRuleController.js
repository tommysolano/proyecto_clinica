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
    if (!data.type || !data.code || data.rate == null) {
      return res.status(400).json({ message: 'type, code y rate son obligatorios' });
    }
    await assertAccount(req.clinicId, data.payableAccount);
    const rule = await RetentionRule.create({ ...data, clinic: req.clinicId, createdBy: req.user?._id || null });
    res.status(201).json(rule);
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ message: 'Ya existe una regla con ese tipo y código' });
    res.status(e.status || 400).json({ message: e.message });
  }
};

/** PUT /retention-rules/:id — edita una regla (conserva snapshots ya contabilizados). */
exports.update = async (req, res) => {
  try {
    const data = pick(req.body);
    await assertAccount(req.clinicId, data.payableAccount);
    const rule = await RetentionRule.findOneAndUpdate({ _id: req.params.id, clinic: req.clinicId }, data, { new: true });
    if (!rule) return res.status(404).json({ message: 'Regla no encontrada' });
    res.json(rule);
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ message: 'Ya existe una regla con ese tipo y código' });
    res.status(e.status || 400).json({ message: e.message });
  }
};

/** PATCH /retention-rules/:id/toggle — activa/desactiva. */
exports.toggle = async (req, res) => {
  try {
    const rule = await RetentionRule.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!rule) return res.status(404).json({ message: 'Regla no encontrada' });
    rule.active = req.body.active != null ? !!req.body.active : !rule.active;
    await rule.save();
    res.json(rule);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/** POST /retention-rules/seed — crea las reglas por defecto que falten (idempotente). */
exports.seed = async (req, res) => {
  try {
    const r = await seedRetentionRules(req.clinicId, { createdBy: req.user?._id || null });
    res.json({ message: `Catálogo actualizado: ${r.created} creadas, ${r.existing} ya existían`, ...r });
  } catch (e) { res.status(500).json({ message: e.message }); }
};
