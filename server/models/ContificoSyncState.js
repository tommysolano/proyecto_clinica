const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  _id: { type: String },
  state: { type: String, required: true },
  trigger: { type: String, default: '' },
  host: { type: String, default: '' },
  startedAt: Date,
  completedAt: Date,
  lastSuccessfulAt: Date,
  months: { type: [mongoose.Schema.Types.Mixed], default: [] },
  failures: { type: [mongoose.Schema.Types.Mixed], default: [] },
  lastError: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('ContificoSyncState', schema);
