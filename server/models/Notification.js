const mongoose = require('mongoose');

/**
 * Notificación / alerta interna por clínica. Uso actual: avisar de cambios de
 * categoría o estado de plantillas de WhatsApp detectados al sincronizar con
 * Meta (o vía webhook). Reutilizable para otras alertas del CRM.
 */
const notificationSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    type: { type: String, required: true, index: true }, // p.ej. 'template_category_changed'
    severity: { type: String, enum: ['info', 'warning', 'error'], default: 'info' },
    title: { type: String, required: true, trim: true },
    body: { type: String, trim: true, default: '' },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    read: { type: Boolean, default: false, index: true },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

notificationSchema.index({ clinic: 1, read: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
