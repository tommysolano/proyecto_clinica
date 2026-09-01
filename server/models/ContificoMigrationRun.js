const mongoose = require('mongoose');

const schema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    mode: { type: String, enum: ['DRY_RUN', 'COMMIT'], required: true },
    phase: { type: String, enum: ['EXTRACT', 'PROJECT'], required: true },
    status: { type: String, enum: ['RUNNING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED'], default: 'RUNNING' },
    range: { from: Date, through: Date, cutoff: Date },
    stages: { type: [mongoose.Schema.Types.Mixed], default: [] },
    issues: { type: [mongoose.Schema.Types.Mixed], default: [] },
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.model('ContificoMigrationRun', schema);
