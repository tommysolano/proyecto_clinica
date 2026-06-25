const mongoose = require('mongoose');

/**
 * Convierte un id (string) a ObjectId para usarlo en pipelines de `aggregate`.
 *
 * En `find()` Mongoose castea el string al tipo del esquema, pero en `aggregate()` NO:
 * un `$match: { clinic: 'idString' }` contra un campo ObjectId no empareja nada. Por eso
 * `req.clinicId` (que viene como string del JWT) debe convertirse antes de agregar.
 * Si el valor no es un ObjectId válido, se devuelve tal cual.
 */
function asObjectId(value) {
  if (!value || !mongoose.Types.ObjectId.isValid(value)) return value;
  return new mongoose.Types.ObjectId(String(value));
}

module.exports = { asObjectId };
