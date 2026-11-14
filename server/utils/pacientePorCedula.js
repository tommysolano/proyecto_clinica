/**
 * CLIENTE = PACIENTE CUANDO ES LA MISMA PERSONA (nov-2026).
 *
 * Las personas con rol CLIENTE se migraron de Contífico y casi todas son también pacientes
 * (misma cédula, o su RUC = cédula + «001»). Si el cajero elegía la fila «Cliente» del
 * buscador, o escribía la cédula a mano, la venta quedaba SIN paciente: no salían «Para citas
 * futuras» ni «Se lo lleva / Se lo aplica aquí», y la compra no aparecía en su historia.
 *
 * Devuelve el _id del paciente cuya cédula coincide con la identificación de la factura, o
 * null si no hay ninguno, si hay más de uno (no se adivina) o si es Consumidor Final.
 * Los pacientes son de toda la organización: no se filtra por sucursal.
 */
const Patient = require('../models/Patient');

const candidatas = (identificacion) => {
  const id = String(identificacion || '').replace(/\s+/g, '').trim();
  if (!/^\d{10}$|^\d{13}$/.test(id) || /^9{10,13}$/.test(id)) return [];
  return id.length === 13 && id.endsWith('001') ? [id, id.slice(0, 10)] : [id];
};

async function pacientePorCedula(identificacion, { session = null } = {}) {
  const ids = candidatas(identificacion);
  if (!ids.length) return null;
  const q = Patient.find({ cedula: { $in: ids } }).select('_id').limit(2).lean();
  if (session) q.session(session);
  const encontrados = await q;
  return encontrados.length === 1 ? encontrados[0]._id : null;
}

module.exports = { pacientePorCedula, candidatas };
