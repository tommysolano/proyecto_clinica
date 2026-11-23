/**
 * SALDO A FAVOR DEL PACIENTE (oct-2026). Ver models/PatientCredit.js.
 *
 * Lo usan la venta (deja excedente / paga con saldo), el cobro con anticipo, sus
 * anulaciones y la ficha del paciente. Todo dentro de la MISMA sesión de la
 * transacción contable: el asiento y el movimiento del saldo nacen o se caen
 * juntos.
 */
const mongoose = require('mongoose');
const PatientCredit = require('../models/PatientCredit');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Sucursales en las que vale el saldo: las de la EMPRESA de `clinicId` (nov-2026). Antes el
 * saldo era de la sede donde se cobró y en las demás el paciente aparecía con $0: pagó de más
 * en Extensión y en Central nadie lo veía ni se lo descontaba. El plan de cuentas es de la
 * empresa, así que el anticipo (2.1.01.03) se puede consumir desde cualquier sede.
 */
async function sucursalesDelSaldo(clinicId) {
  const { sucursalesDeLaEmpresa } = require('./sesionesPrepagadas');
  const empresa = await sucursalesDeLaEmpresa(clinicId);
  const ids = empresa && empresa.length ? empresa.map(String) : [String(clinicId)];
  if (!ids.includes(String(clinicId))) ids.push(String(clinicId));
  return ids.map((id) => new mongoose.Types.ObjectId(id));
}

/** Saldo disponible del paciente en la empresa de la sucursal. */
async function saldoDisponible(clinicId, patientId, { session = null } = {}) {
  if (!clinicId || !patientId) return 0;
  const [fila] = await PatientCredit.aggregate([
    {
      $match: {
        clinic: { $in: await sucursalesDelSaldo(clinicId) },
        patient: new mongoose.Types.ObjectId(String(patientId)),
      },
    },
    { $group: { _id: null, saldo: { $sum: '$amount' } } },
  ]).session(session);
  return r2(fila?.saldo || 0);
}

/**
 * Pacientes con saldo a favor en la empresa de `clinicId`: [{ patient, saldo, ultimo }],
 * de mayor a menor. Para el reporte del contador.
 */
async function saldosPorPaciente(clinicId) {
  return PatientCredit.aggregate([
    { $match: { clinic: { $in: await sucursalesDelSaldo(clinicId) } } },
    { $group: { _id: '$patient', saldo: { $sum: '$amount' }, ultimo: { $max: '$date' }, movimientos: { $sum: 1 } } },
    { $match: { saldo: { $gt: 0.005 } } },
    { $sort: { saldo: -1 } },
  ]);
}

async function registrar(datos, { session = null } = {}) {
  const [mov] = await PatientCredit.create([{ ...datos, amount: r2(datos.amount) }], { session });
  return mov;
}

/**
 * Deshace los movimientos de un documento (venta o cobro) anulado. Si deshacer
 * un ANTICIPO dejaría el saldo en negativo —ya se usó en otra venta—, no se
 * permite: primero hay que anular la venta que lo consumió.
 */
async function revertirDe({ clinicId, filtro, userId, date = new Date(), session = null }) {
  const movs = await PatientCredit.find({ clinic: clinicId, ...filtro, type: { $ne: 'REVERSO' } }).session(session);
  if (!movs.length) return [];
  const yaRevertidos = new Set(
    (await PatientCredit.find({ reverses: { $in: movs.map((m) => m._id) } }).select('reverses').session(session))
      .map((m) => String(m.reverses))
  );
  const pendientes = movs.filter((m) => !yaRevertidos.has(String(m._id)));
  // Por paciente: lo que se quita no puede superar lo que queda.
  const porPaciente = new Map();
  for (const m of pendientes) {
    const k = String(m.patient);
    porPaciente.set(k, r2((porPaciente.get(k) || 0) - m.amount));
  }
  for (const [patient, cambio] of porPaciente) {
    if (cambio >= 0) continue;
    const saldo = await saldoDisponible(clinicId, patient, { session });
    if (saldo + cambio < -0.005) {
      throw Object.assign(
        new Error(
          `No se puede anular: el saldo a favor que dejó ($${(-cambio).toFixed(2)}) ya se usó en otra venta `
          + `(le quedan $${saldo.toFixed(2)}). Anula primero la venta que lo consumió.`
        ),
        { status: 400, code: 'SALDO_A_FAVOR_USADO' }
      );
    }
  }
  const creados = [];
  for (const m of pendientes) {
    creados.push(await registrar({
      clinic: m.clinic,
      patient: m.patient,
      type: 'REVERSO',
      amount: -m.amount,
      date,
      sale: m.sale,
      payment: m.payment,
      reverses: m._id,
      description: `Anulación: ${m.description || m.type}`,
      createdBy: userId || null,
    }, { session }));
  }
  return creados;
}

module.exports = { saldoDisponible, saldosPorPaciente, sucursalesDelSaldo, registrar, revertirDe, r2 };
