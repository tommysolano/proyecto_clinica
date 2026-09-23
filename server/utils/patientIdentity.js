/**
 * Una identificación absorbida en una fusión sigue identificando al mismo
 * paciente. Centralizar este filtro evita que una reserva o importación hecha
 * con el RUC antiguo vuelva a crear la ficha duplicada que acabamos de cerrar.
 */
function patientIdentificationFilter(value) {
  const identification = String(value || '').trim();
  return {
    $or: [
      { cedula: identification },
      { identificationAliases: identification },
    ],
  };
}

module.exports = { patientIdentificationFilter };
