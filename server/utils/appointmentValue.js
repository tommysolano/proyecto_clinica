/**
 * EL VALOR DE UNA CITA Y SU PAGO ADELANTADO.
 *
 * Es un dato OPERATIVO: lo que se acordó que va a pagar el paciente por esta
 * visita y lo que dejó pagado por adelantado. No genera venta, ni factura, ni
 * asiento — todo eso vive en su propio módulo, y separarlos fue una decisión
 * del proyecto.
 *
 * VIVE AQUÍ, fuera del controlador, porque entra por CINCO puertas y las cinco
 * tienen que tratarlo igual: al crear la cita, al asignar la atención, al
 * marcar asistencia, al corregirlo después (`service-value`) y al agendar desde
 * el chat del call center. Cada copia que se hizo de estas reglas acabó
 * olvidándose de una: la del PUT de la cita no sabía del pago adelantado y
 * dejaba fijar el precio sin comprobar el rol.
 */
/**
 * ¿Este rol puede poner o cambiar el VALOR de una cita (y su pago adelantado)?
 *
 * Quien VENDE la cita: administración, caja y —desde sep-2026— el call center.
 * Se le sumó porque cierra la cita por teléfono y cobra en el momento: es quien
 * sabe cuánto se acordó y si el paciente abonó o pagó entero. Sin esto lo
 * apuntaba en el motivo de la cita, donde no lo lee ningún reporte.
 *
 * Quien ATIENDE sigue fuera, que era el motivo original de esta guardia: el
 * valor es lo que se le va a cobrar al paciente y un doctor no lo negocia desde
 * su seguimiento.
 */
const puedeFijarValor = (req) =>
  !!req.user?.isSuperAdmin || ['admin', 'cajero', 'call_center'].includes(req.role);

/**
 * Aplica sobre la cita el valor acordado y/o el canje que venga en el cuerpo de
 * la petición. Devuelve `true` si tocó algo.
 *
 * Vive aparte porque entra por TRES puertas —al asignar la atención, al marcar
 * asistencia y al corregirlo después— y las tres tienen que tratarlo igual: un
 * canje deja el importe en 0, y cualquier cambio deja registrado quién fue.
 *
 * Los campos son OPCIONALES: si no vienen, la cita se queda como estaba. Eso es
 * lo que permite que recepción reciba al paciente sin saber todavía el importe
 * y lo anote más tarde, sin que el flujo se lo exija.
 */
function aplicarValorDeCita(apt, body, req) {
  if (!puedeFijarValor(req)) return false;

  const traeCanje = body.isCanje !== undefined;
  const traeValor = body.agreedValue !== undefined;
  const traeAdelanto = body.advancePayment !== undefined || body.advanceAmount !== undefined;
  if (!traeCanje && !traeValor && !traeAdelanto) return false;

  /**
   * PAGO POR ADELANTADO. `advancePayment` manda ('' | 'abono' | 'total') y
   * `paidInAdvance` es su espejo, que se conserva porque ya lo leía el Excel de
   * citas — nadie debe escribirlo por su cuenta.
   *
   * «Total» no necesita importe aparte: lo pagado es el valor de la cita, y
   * duplicarlo en dos campos es la forma segura de que un día no cuadren.
   */
  if (traeAdelanto) {
    const modo = ['abono', 'total'].includes(body.advancePayment) ? body.advancePayment : '';
    apt.advancePayment = modo;
    apt.paidInAdvance = modo !== '';
    if (modo === '') {
      apt.advanceAmount = 0;
    } else if (modo === 'abono') {
      const abonado = Number(body.advanceAmount);
      apt.advanceAmount = Number.isFinite(abonado) && abonado > 0 ? abonado : 0;
    }
    // 'total' se resuelve abajo, cuando ya se sabe el valor final de la cita.
  }

  if (traeCanje) apt.isCanje = !!body.isCanje;

  if (apt.isCanje) {
    // Canje = no entró dinero. Ver el comentario del modelo.
    apt.agreedValue = 0;
  } else if (traeValor) {
    const crudo = body.agreedValue;
    // '' y null significan "bórralo", no "cero": son lo que manda el formulario
    // cuando el campo se deja vacío.
    if (crudo === null || crudo === '') {
      apt.agreedValue = null;
    } else {
      const num = Number(crudo);
      if (!Number.isFinite(num) || num < 0) return false;
      apt.agreedValue = num;
    }
  }

  /**
   * «Pagó todo» = lo pagado ES el valor de la cita, y se resuelve al final para
   * que dé igual el orden en que lleguen los campos. Un canje no es un pago:
   * si no entró dinero, no hay adelanto que anotar.
   */
  if (apt.isCanje) {
    apt.advancePayment = '';
    apt.paidInAdvance = false;
    apt.advanceAmount = 0;
  } else if (apt.advancePayment === 'total') {
    apt.advanceAmount = Number(apt.agreedValue) > 0 ? Number(apt.agreedValue) : 0;
  }

  apt.valueSetAt = new Date();
  apt.valueSetBy = req.user._id;
  return true;
}

module.exports = { puedeFijarValor, aplicarValorDeCita };
