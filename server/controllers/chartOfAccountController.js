const ChartOfAccount = require('../models/ChartOfAccount');
const { seedChartOfAccounts } = require('../utils/accounting');

exports.list = async (req, res) => {
  try {
    const { q, type, active } = req.query;
    const filter = { clinic: req.clinicId };
    if (type) filter.type = type;
    if (active !== undefined) filter.active = active === 'true';
    if (q) {
      filter.$or = [
        { code: new RegExp(q, 'i') },
        { name: new RegExp(q, 'i') },
      ];
    }
    const accounts = await ChartOfAccount.find(filter).sort({ code: 1 });
    res.json(accounts);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

exports.get = async (req, res) => {
  const acc = await ChartOfAccount.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!acc) return res.status(404).json({ message: 'Cuenta no encontrada' });
  res.json(acc);
};

/**
 * Sugiere el código, nivel, tipo y naturaleza para una nueva cuenta hija a partir
 * de su cuenta padre. Toma el siguiente correlativo libre entre los hijos directos,
 * conservando el ancho (relleno con ceros) de los hermanos existentes.
 * query: { parent } (id). Sin parent => sugiere una cuenta raíz nueva.
 */
exports.suggestChild = async (req, res) => {
  try {
    const all = await ChartOfAccount.find({ clinic: req.clinicId }).select('code type nature level parent').lean();
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    if (!req.query.parent) {
      // Cuenta raíz: siguiente dígito de primer nivel libre.
      const roots = all.filter((a) => !a.code.includes('.'));
      const maxNum = roots.reduce((m, a) => Math.max(m, parseInt(a.code.replace(/\D/g, ''), 10) || 0), 0);
      return res.json({ code: String(maxNum + 1), level: 1, type: 'ACTIVO', nature: 'DEBITO', parentCode: null });
    }

    const parent = all.find((a) => String(a._id) === String(req.query.parent));
    if (!parent) return res.status(404).json({ message: 'Cuenta padre no encontrada' });
    const prefix = parent.code + '.';
    const rx = new RegExp('^' + esc(prefix));
    // Hijos DIRECTOS: el sufijo tras el prefijo no contiene más puntos.
    const childSuffixes = all
      .filter((a) => rx.test(a.code))
      .map((a) => a.code.slice(prefix.length))
      .filter((s) => s && !s.includes('.'));
    const width = childSuffixes.length ? Math.max(...childSuffixes.map((s) => s.length)) : 2;
    const maxNum = childSuffixes.reduce((m, s) => Math.max(m, parseInt(s.replace(/\D/g, ''), 10) || 0), 0);
    const next = String(maxNum + 1).padStart(width, '0');
    res.json({
      code: prefix + next,
      level: parent.level + 1,
      type: parent.type,      // hereda del padre (editable en el front)
      nature: parent.nature,
      parentCode: parent.code,
    });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.create = async (req, res) => {
  try {
    const { code, name, type, nature, parent, allowsMovement, taxCode, description } = req.body;
    if (!code || !name || !type || !nature) {
      return res.status(400).json({ message: 'code, name, type y nature son requeridos' });
    }
    const exists = await ChartOfAccount.findOne({ clinic: req.clinicId, code });
    if (exists) return res.status(400).json({ message: 'Código ya existe' });
    const level = code.split('.').length;
    const acc = await ChartOfAccount.create({
      clinic: req.clinicId,
      code, name, type, nature,
      parent: parent || null,
      level,
      allowsMovement: allowsMovement !== false,
      taxCode: taxCode || null,
      description: description || '',
    });
    res.status(201).json(acc);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
};

exports.update = async (req, res) => {
  try {
    const acc = await ChartOfAccount.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!acc) return res.status(404).json({ message: 'No encontrada' });
    const fields = ['name', 'type', 'nature', 'parent', 'allowsMovement', 'taxCode', 'description', 'active'];
    fields.forEach((f) => { if (req.body[f] !== undefined) acc[f] = req.body[f]; });
    if (req.body.code && req.body.code !== acc.code) {
      if (acc.isSystem) return res.status(400).json({ message: 'No puede cambiar código de cuenta de sistema' });
      acc.code = req.body.code;
      acc.level = acc.code.split('.').length;
    }
    await acc.save();
    res.json(acc);
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const acc = await ChartOfAccount.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!acc) return res.status(404).json({ message: 'No encontrada' });
    if (acc.isSystem) return res.status(400).json({ message: 'No se puede eliminar cuenta de sistema' });
    await acc.deleteOne();
    res.json({ message: 'Eliminada' });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
};

exports.seed = async (req, res) => {
  try {
    const r = await seedChartOfAccounts(req.clinicId);
    res.json(r);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};
