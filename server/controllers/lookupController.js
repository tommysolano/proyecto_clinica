const Patient = require('../models/Patient');
const { lookupTaxId } = require('../utils/cedulaLookup');

/**
 * Consulta genérica de cédula/RUC contra el SRI para autocompletar formularios
 * (pacientes, clientes de ventas/cotizaciones, proveedores, empleados, etc.).
 *
 * Devuelve los datos públicos del SRI + `alreadyExists` (si ya hay un paciente
 * con esa identificación). NO devuelve datos personales del paciente: solo el
 * booleano, para poder usar este endpoint desde cualquier rol sin exponer PII.
 */
exports.taxIdLookup = async (req, res) => {
  const id = (req.params.id || '').trim();
  try {
    const [result, existing] = await Promise.all([
      lookupTaxId(id),
      Patient.exists({ cedula: id, active: true }),
    ]);
    res.json({ ...result, alreadyExists: !!existing });
  } catch (error) {
    if (error.code === 'INVALID_CEDULA') {
      const isRuc = id.length === 13;
      return res.status(400).json({ message: isRuc ? 'RUC inválido' : 'Cédula inválida' });
    }
    res.status(500).json({ message: 'Error al consultar el SRI' });
  }
};
