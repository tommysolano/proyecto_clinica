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
