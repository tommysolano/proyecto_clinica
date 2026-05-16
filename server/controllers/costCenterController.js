const CostCenter = require('../models/CostCenter');

exports.list = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.active !== undefined) filter.active = req.query.active === 'true';
  const items = await CostCenter.find(filter).sort({ code: 1 });
  res.json(items);
};

exports.create = async (req, res) => {
  try {
    const { code, name, parent, description } = req.body;
    if (!code || !name) return res.status(400).json({ message: 'code y name requeridos' });
    const exists = await CostCenter.findOne({ clinic: req.clinicId, code });
    if (exists) return res.status(400).json({ message: 'Código ya existe' });
    const cc = await CostCenter.create({ clinic: req.clinicId, code, name, parent: parent || null, description: description || '' });
    res.status(201).json(cc);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.update = async (req, res) => {
  try {
    const cc = await CostCenter.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!cc) return res.status(404).json({ message: 'No encontrado' });
    ['code', 'name', 'parent', 'description', 'active'].forEach((f) => {
      if (req.body[f] !== undefined) cc[f] = req.body[f];
    });
    await cc.save();
    res.json(cc);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.remove = async (req, res) => {
  const cc = await CostCenter.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!cc) return res.status(404).json({ message: 'No encontrado' });
  await cc.deleteOne();
  res.json({ message: 'Eliminado' });
};
