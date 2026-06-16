const mongoose = require('mongoose');
const { buildLedgerDocumentSchema } = require('./ledgerDocumentSchema');

// Cuentas por cobrar (CxC). Saldo a favor de la clínica contra pacientes,
// aseguradoras u otros clientes.
const receivableSchema = buildLedgerDocumentSchema();

module.exports = mongoose.model('Receivable', receivableSchema);
