/**
 * OBSERVACIONES AUTOMÁTICAS (sep-2026, a petición de la clínica).
 *
 * La bitácora de Observaciones del paciente se llena SOLA únicamente con
 * COMPRAS (19-oct-2026, a petición de la clínica):
 *
 *  · VENTA — por venta con paciente (página de Ventas, o el cobro de la receta
 *    / de la cita desde la agenda): qué compró y por cuánto (y si se anuló).
 *  · COMPRA DE LA RECETA — lo que caja registra desde la agenda
 *    (`auto.kind: 'compra'`, en appointmentController).
 *
 * Antes también se escribía la RECETA de cada seguimiento (aunque el paciente no
 * comprara nada) y, hasta oct-2026, una VISITA por cada cita. La clínica pidió
 * quitarlas: la bitácora es para lo que el paciente compró.
 *
 * Cada registro es UNO por origen (`auto.kind` + `auto.ref`, índice único): se
 * REESCRIBE cuando el origen cambia, así que no se duplica con los reintentos y
 * siempre dice lo último.
 *
 * NUNCA rompe lo que la llamó: si falla, se avisa en consola y ya. Guardar un
 * cobro no puede caerse porque no se pudo escribir su constancia.
 */
const PatientObservation = require('../models/PatientObservation');

const TZ = 'America/Guayaquil';
const fechaHora = (d) => (d
  ? new Intl.DateTimeFormat('es-EC', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(d))
  : '');
const dinero = (n) => `$${(Number(n) || 0).toFixed(2)}`;

/**
 * Crea o reescribe el registro automático de ese origen.
 *
 * `fecha` (solo el relleno histórico) fecha el registro cuando PASÓ, no hoy: si
 * no, un año de ventas aparecería de golpe encima de todo como si fuera de hoy.
 */
async function guardar({ kind, ref, clinic, patient, userId, text, fecha: cuando = null }) {
  if (!patient || !ref || !text || !userId) return;
  const alta = { clinic, patient, createdBy: userId, auto: { kind, ref }, attachments: [] };
  if (cuando) {
    await PatientObservation.updateOne(
      { 'auto.kind': kind, 'auto.ref': ref },
      { $set: { text }, $setOnInsert: { ...alta, createdAt: cuando, updatedAt: cuando } },
      { upsert: true, timestamps: false }
    );
    return;
  }
  await PatientObservation.updateOne(
    { 'auto.kind': kind, 'auto.ref': ref },
    { $set: { text }, $setOnInsert: alta },
    { upsert: true }
  );
}

/* ------------------------------------------------------------------ COMPRA */

const TIPO_ITEM = { servicio: 'servicio', programa: 'programa', insumo: 'producto' };

/** Qué compró y por cuánto. Sin forma de pago, banco ni cajero (oct-2026). */
function textoDeVenta(sale) {
  const anulada = sale.status === 'anulada';
  const lineas = [`${anulada ? 'Compra ANULADA' : 'Compra'} · ${fechaHora(sale.createdAt)}`];
  for (const it of sale.items || []) {
    const tipo = TIPO_ITEM[it.category] || TIPO_ITEM[it.product?.category] || '';
    const nom = it.productName || it.product?.name || 'Ítem';
    lineas.push(`• ${nom} × ${it.quantity}${tipo ? ` (${tipo})` : ''}`);
  }
  lineas.push(`Total: ${dinero(sale.total)}`);
  if (anulada) lineas.push(`Anulada el ${fechaHora(sale.updatedAt)}`);
  return lineas.join('\n');
}

/** Registro de la COMPRA (solo si tiene paciente: consumidor final no tiene ficha). */
async function registrarVenta(saleOrId, userId, { fechaOriginal = false, lanzar = false } = {}) {
  try {
    const Sale = require('../models/Sale');
    const id = saleOrId?._id || saleOrId;
    const sale = await Sale.findById(id)
      .select('clinic patient status items total createdAt updatedAt createdBy')
      .populate('items.product', 'name category')
      .lean();
    if (!sale?.patient) return;
    await guardar({
      kind: 'venta',
      ref: sale._id,
      clinic: sale.clinic,
      patient: sale.patient,
      userId: userId || sale.createdBy,
      text: textoDeVenta(sale),
      fecha: fechaOriginal ? sale.createdAt : null,
    });
  } catch (e) {
    if (lanzar) throw e;
    console.warn('[observaciones automáticas] venta:', e.message);
  }
}

module.exports = { registrarVenta, textoDeVenta };
