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

/** Saldo disponible del paciente en la sucursal. */
async function saldoDisponible(clinicId, patientId, { session = null } = {}) {
  if (!clinicId || !patientId) return 0;
  const [fila] = await PatientCredit.aggregate([
    {
      $match: {
        clinic: new mongoose.Types.ObjectId(String(clinicId)),
        patient: new mongoose.Types.ObjectId(String(patientId)),
      },
    },
    { $group: { _id: null, saldo: { $sum: '$amount' } } },
  ]).session(session);
  return r2(fila?.saldo || 0);
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

module.exports = { saldoDisponible, registrar, revertirDe, r2 };
