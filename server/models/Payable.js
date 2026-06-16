const mongoose = require('mongoose');
const { buildLedgerDocumentSchema } = require('./ledgerDocumentSchema');

// Cuentas por pagar (CxP). Saldo que la clínica debe a proveedores o empleados.
const payableSchema = buildLedgerDocumentSchema();

module.exports = mongoose.model('Payable', payableSchema);
