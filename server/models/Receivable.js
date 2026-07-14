const mongoose = require('mongoose');
const { buildLedgerDocumentSchema } = require('./ledgerDocumentSchema');

// Cuentas por cobrar (CxC). Saldo a favor de la clínica contra pacientes,
// aseguradoras u otros clientes.
const receivableSchema = buildLedgerDocumentSchema();

/**
 * `plannedCollectionDate` = "cuándo se planea COBRAR". Es el mismo concepto que
 * `plannedPaymentDate` en una CxP —cuándo se mueve el dinero— visto desde el otro lado.
 *
 * NO es un campo del modelo ni un virtual de Mongoose, a propósito:
 *   · un virtual NO existe en `.lean()` (que es lo que usa el motor del flujo) ni en las
 *     agregaciones, ni se puede filtrar u ordenar por él, así que sería una trampa;
 *   · un segundo campo persistido acabaría divergiendo del primero.
 *
 * El campo PERSISTIDO y canónico es `plannedPaymentDate`, uno solo. `plannedCollectionDate`
 * existe únicamente como NOMBRE DE API en las respuestas de flujo de caja para las CxC
 * (services/cashFlowService lo añade al serializar), con el mismo valor. Sigue siendo
 * distinto de `dueDate` (vencimiento legal), de `issueDate` y de la fecha efectiva.
 */

module.exports = mongoose.model('Receivable', receivableSchema);
