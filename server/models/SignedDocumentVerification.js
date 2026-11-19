const mongoose = require('mongoose');

// Solo una huella: nunca se almacena el PDF ni información del paciente aquí.
const schema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  sha256: { type: String, required: true },
  tipo: { type: String, required: true },
}, { timestamps: true });

module.exports = mongoose.model('SignedDocumentVerification', schema);
