const AuditLog = require('../models/AuditLog');

exports.list = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.entity) filter.entity = req.query.entity;
  if (req.query.action) filter.action = req.query.action;
  if (req.query.user) filter.user = req.query.user;
  if (req.query.startDate || req.query.endDate) {
    filter.createdAt = {};
    if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate);
    if (req.query.endDate) filter.createdAt.$lte = new Date(req.query.endDate);
  }
  const items = await AuditLog.find(filter).sort({ createdAt: -1 }).limit(parseInt(req.query.limit) || 500);
  res.json(items);
};
