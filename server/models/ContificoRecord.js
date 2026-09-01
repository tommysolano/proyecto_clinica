const mongoose = require('mongoose');

/** Copia sin perdida de cada registro leido desde Contifico. */
const schema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true },
    entity: { type: String, required: true, trim: true },
    externalId: { type: String, required: true, trim: true },
    // JSON original comprimido. El cluster Atlas de este proyecto tiene 512 MB; guardar el
    // mismo JSON expandido agotaba la cuota antes de poder proyectarlo a los modelos nativos.
    payloadCompressed: { type: Buffer, required: true },
    payloadEncoding: { type: String, enum: ['gzip-json'], default: 'gzip-json', required: true },
    checksum: { type: String, required: true },
    capturedAt: { type: Date, default: Date.now, required: true },
    migrationRun: { type: mongoose.Schema.Types.ObjectId, ref: 'ContificoMigrationRun', default: null },
    search: {
      date: { type: Date, default: null },
      number: { type: String, default: '' },
      identification: { type: String, default: '' },
      name: { type: String, default: '' },
      type: { type: String, default: '' },
      status: { type: String, default: '' },
      amount: { type: Number, default: null },
    },
    projection: {
      status: { type: String, enum: ['ARCHIVED', 'PROJECTED', 'LINKED_EXISTING', 'REVIEW', 'ERROR'], default: 'ARCHIVED' },
      links: {
        type: [{ model: String, ref: mongoose.Schema.Types.ObjectId, action: String, _id: false }],
        default: [],
      },
      warnings: { type: [String], default: [] },
      projectedAt: { type: Date, default: null },
    },
  },
  { timestamps: true, minimize: false }
);

schema.index({ clinic: 1, entity: 1, externalId: 1 }, { unique: true });
schema.index({ clinic: 1, entity: 1, 'search.date': -1 });
schema.index({ clinic: 1, entity: 1, 'search.number': 1 });
schema.index({ clinic: 1, 'projection.status': 1 });

module.exports = mongoose.model('ContificoRecord', schema);
