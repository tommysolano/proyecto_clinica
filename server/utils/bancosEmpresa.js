/**
 * BANCOS DE LA EMPRESA (nov-2026).
 *
 * Las cuentas bancarias se crean una vez, en la sede que lleva la contabilidad de la empresa
 * (Central), y valen para TODAS sus sucursales: el cajero de Laboratorio o de Extensión cobra
 * por transferencia a esas cuentas y deposita en ellas. Antes cada sucursal buscaba bancos
 * propios (no tenía ninguno): el selector salía vacío y las transferencias quedaban sin banco,
 * fuera de la conciliación.
 *
 * El asiento sigue en el libro de la sucursal (con la copia de la cuenta contable del banco,
 * ver utils/planEmpresa) y el MOVIMIENTO DE BANCO se registra en la sede del banco, que es
 * donde se concilia.
 */
const BankAccount = require('../models/BankAccount');
const { hermanas } = require('./planEmpresa');

/** Sedes de la empresa de `clinicId` (incluida ella). */
async function sedesEmpresa(clinicId) {
  return hermanas(clinicId);
}

/** La cuenta bancaria `id` si es de la empresa de `clinicId`; si no, null. */
async function bancoDeEmpresa(id, clinicId, session = null) {
  if (!id) return null;
  const q = BankAccount.findOne({ _id: id, clinic: { $in: await sedesEmpresa(clinicId) } });
  return session ? q.session(session) : q;
}

module.exports = { sedesEmpresa, bancoDeEmpresa };
