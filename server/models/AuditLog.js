const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    userName: String,
    role: String,
    action: { type: String, required: true }, // CREATE | UPDATE | DELETE | LOGIN | LOGOUT | POST | REVERSE | CLOSE | OPEN | LIQUIDATE
    entity: { type: String, required: true }, // nombre modelo
    entityId: String,
    description: String,
    method: String,
    path: String,
    ip: String,
    before: mongoose.Schema.Types.Mixed,
    after: mongoose.Schema.Types.Mixed,
    success: { type: Boolean, default: true },
    errorMessage: String,
  },
  { timestamps: true }
);

auditLogSchema.index({ clinic: 1, createdAt: -1 });
auditLogSchema.index({ entity: 1, entityId: 1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
