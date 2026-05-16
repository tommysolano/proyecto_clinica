const Supplier = require('../models/Supplier');

exports.list = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.q) filter.$or = [
    { ruc: new RegExp(req.query.q, 'i') },
    { razonSocial: new RegExp(req.query.q, 'i') },
    { nombreComercial: new RegExp(req.query.q, 'i') },
  ];
  if (req.query.active !== undefined) filter.active = req.query.active === 'true';
  const items = await Supplier.find(filter).populate('defaultExpenseAccount defaultPayableAccount', 'code name').sort({ razonSocial: 1 });
  res.json(items);
};

exports.get = async (req, res) => {
  const s = await Supplier.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!s) return res.status(404).json({ message: 'No encontrado' });
  res.json(s);
};

exports.create = async (req, res) => {
  try {
    const data = { ...req.body, clinic: req.clinicId };
    const s = await Supplier.create(data);
    res.status(201).json(s);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.update = async (req, res) => {
  try {
    const s = await Supplier.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!s) return res.status(404).json({ message: 'No encontrado' });
    Object.assign(s, req.body);
    await s.save();
    res.json(s);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.remove = async (req, res) => {
  const s = await Supplier.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!s) return res.status(404).json({ message: 'No encontrado' });
  await s.deleteOne();
  res.json({ message: 'Eliminado' });
};
