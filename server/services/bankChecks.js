const BankCheck = require('../models/BankCheck');
const BankAccount = require('../models/BankAccount');

/**
 * CONTROL DE LA CHEQUERA — una sola puerta para girar y liberar cheques.
 *
 * El problema real: se podía pagar con el cheque N° 60 cuando la chequera registrada llegaba
 * hasta el 50, y el cheque usado seguía figurando como DISPONIBLE en la pantalla de Cheques.
 * Dos causas distintas:
 *   · Nadie validaba el número contra la chequera (ni en Bancos ni en Pagos).
 *   · El pago por cheque (`paymentController`) ni siquiera tocaba el `BankCheck`; solo el
 *     movimiento manual de Bancos lo hacía, y con un `findOneAndUpdate` sin `upsert` que,
 *     al no existir el número, no actualizaba nada y no se quejaba.
 *
 * Aquí viven las dos operaciones y sus reglas, para que el pago y el movimiento manual no
 * puedan volver a divergir.
 */

/** Nombre legible de una cuenta bancaria para los mensajes de error. */
async function nombreBanco(bankId, session) {
  const b = await BankAccount.findById(bankId).select('name bank').session(session || null);
  if (!b) return 'la cuenta';
  return b.bank ? `${b.name} (${b.bank})` : b.name;
}

const fecha = (d) => (d ? new Date(d).toLocaleDateString('es-EC', { timeZone: 'America/Guayaquil' }) : '');

/**
 * Gira un cheque: comprueba que EXISTE en la chequera de esa cuenta y que está DISPONIBLE, y lo
 * marca como GIRADO con su beneficiario, monto, fecha y el documento en que se usó.
 *
 * @throws Error con `status` 400 si el número no existe o ya se usó.
 */
async function girarCheque({
  clinicId, bankId, number, beneficiary = '', amount = 0, date = new Date(),
  transactionId = null, paymentId = null, session = null,
}) {
  const n = parseInt(number, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw Object.assign(new Error('El número de cheque debe ser un número entero.'), { status: 400 });
  }

  const chk = await BankCheck.findOne({ clinic: clinicId, bankAccount: bankId, number: n }).session(session);
  if (!chk) {
    const total = await BankCheck.countDocuments({ clinic: clinicId, bankAccount: bankId }).session(session);
    const banco = await nombreBanco(bankId, session);
    if (!total) {
      throw Object.assign(new Error(
        `No hay ninguna chequera registrada para ${banco}. Regístrala en Bancos → Cheques `
        + '(«Generar chequera») antes de pagar con cheque.'
      ), { status: 400 });
    }
    // Se dice el rango existente: es la información que hace evidente el error de digitación.
    const [min, max] = await Promise.all([
      BankCheck.findOne({ clinic: clinicId, bankAccount: bankId }).sort({ number: 1 }).select('number').session(session),
      BankCheck.findOne({ clinic: clinicId, bankAccount: bankId }).sort({ number: -1 }).select('number').session(session),
    ]);
    throw Object.assign(new Error(
      `El cheque N° ${n} no existe en la chequera de ${banco} (registrada del ${min?.number} al ${max?.number}). `
      + 'Verifica el número o genera el rango que falta en Bancos → Cheques.'
    ), { status: 400 });
  }

  if (chk.status === 'ANULADO') {
    throw Object.assign(new Error(`El cheque N° ${n} está ANULADO: no se puede usar.`), { status: 400 });
  }
  if (chk.status !== 'DISPONIBLE') {
    const detalle = [
      chk.beneficiary ? `a ${chk.beneficiary}` : null,
      chk.amount ? `por $${Number(chk.amount).toFixed(2)}` : null,
      chk.date ? `el ${fecha(chk.date)}` : null,
    ].filter(Boolean).join(' ');
    throw Object.assign(new Error(
      `El cheque N° ${n} ya fue usado${detalle ? ` (${detalle})` : ''}. Usa un número disponible.`
    ), { status: 400 });
  }

  chk.status = 'GIRADO';
  chk.beneficiary = beneficiary || chk.beneficiary || '';
  chk.amount = +Number(amount || 0).toFixed(2);
  chk.date = date || new Date();
  chk.transaction = transactionId || null;
  chk.payment = paymentId || null;
  await chk.save({ session });
  return chk;
}

/**
 * Devuelve un cheque a DISPONIBLE al anular el pago/movimiento que lo giró. No toca los cheques
 * ya COBRADOS (ese dinero salió del banco) ni los ANULADOS a mano.
 */
async function liberarCheque({ clinicId, bankId, number, session = null }) {
  const n = parseInt(number, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const chk = await BankCheck.findOne({
    clinic: clinicId, bankAccount: bankId, number: n, status: 'GIRADO',
  }).session(session);
  if (!chk) return null;
  chk.status = 'DISPONIBLE';
  chk.beneficiary = '';
  chk.amount = 0;
  chk.date = null;
  chk.transaction = null;
  chk.payment = null;
  await chk.save({ session });
  return chk;
}

module.exports = { girarCheque, liberarCheque };
