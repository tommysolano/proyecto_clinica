const mongoose = require('mongoose');
const ContificoRecord = require('../models/ContificoRecord');
const ContificoMigrationRun = require('../models/ContificoMigrationRun');
const { decodeCompressedJson } = require('../utils/compressedJson');

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const decode = (record) => {
  if (!record) return null;
  const plain = record.toObject ? record.toObject() : record;
  const payload = plain.payloadCompressed
    ? decodeCompressedJson(plain.payloadCompressed)
    : null;
  delete plain.payloadCompressed;
  return { ...plain, payload };
};

exports.summary = async (req, res) => {
  const clinic = new mongoose.Types.ObjectId(String(req.clinicId));
  const [entities, projections, lastRun] = await Promise.all([
    ContificoRecord.aggregate([
      { $match: { clinic } },
      { $group: { _id: '$entity', count: { $sum: 1 }, capturedAt: { $max: '$capturedAt' } } },
      { $sort: { _id: 1 } },
    ]),
    ContificoRecord.aggregate([
      { $match: { clinic } },
      { $group: { _id: '$projection.status', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    ContificoMigrationRun.findOne({ clinic }).sort({ createdAt: -1 }).lean(),
  ]);
  res.json({ entities, projections, lastRun });
};

exports.list = async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const filter = { clinic: req.clinicId };
  if (req.query.entity) filter.entity = String(req.query.entity);
  if (req.query.projectionStatus) filter['projection.status'] = String(req.query.projectionStatus);
  if (req.query.startDate || req.query.endDate) {
    filter['search.date'] = {};
    if (req.query.startDate) filter['search.date'].$gte = new Date(req.query.startDate);
    if (req.query.endDate) filter['search.date'].$lte = new Date(req.query.endDate);
  }
  if (req.query.search) {
    const regex = new RegExp(escapeRegex(req.query.search), 'i');
    filter.$or = [{ externalId: regex }, { 'search.number': regex }, { 'search.identification': regex }, { 'search.name': regex }];
  }
  const [items, total] = await Promise.all([
    ContificoRecord.find(filter).select('-payloadCompressed').sort({ 'search.date': -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    ContificoRecord.countDocuments(filter),
  ]);
  res.json({ items, total, page, pages: Math.ceil(total / limit) });
};

exports.detail = async (req, res) => {
  const record = await ContificoRecord.findOne({ clinic: req.clinicId, entity: req.params.entity, externalId: req.params.externalId });
  if (!record) return res.status(404).json({ message: 'Registro de Contifico no encontrado' });
  res.json(decode(record));
};

exports.runs = async (req, res) => {
  res.json(await ContificoMigrationRun.find({ clinic: req.clinicId }).sort({ createdAt: -1 }).limit(Math.min(100, Number(req.query.limit) || 25)).lean());
};

exports._decode = decode;
