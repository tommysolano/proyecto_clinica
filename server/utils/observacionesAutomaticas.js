/**
 * OBSERVACIONES AUTOMÁTICAS (sep-2026, a petición de la clínica).
 *
 * La bitácora de Observaciones del paciente se llena SOLA con dos cosas, y
 * SOLO con esas dos (oct-2026):
 *
 *  · RECETA — por seguimiento con receta: qué se le recetó, quién y cuándo.
 *  · COMPRA — por venta con paciente: qué compró y por cuánto (y si se anuló).
 *
 * Antes también se escribía una VISITA por cada cita (servicios, quién atendió,
 * valor, adelanto, quién cobró, forma de pago…) y la venta traía el detalle de
 * caja (banco, tarjeta, cajero). La clínica pidió quitarlo: la bitácora se llenaba
 * de datos de caja y lo que el equipo busca ahí es qué se recetó y qué compró. Lo
 * que caja anota de la agenda (`auto.kind: 'compra'`, en appointmentController)
 * sigue: también es una compra.
 *
 * Cada registro es UNO por origen (`auto.kind` + `auto.ref`, índice único): se
 * REESCRIBE cuando el origen cambia, así que no se duplica con los reintentos y
 * siempre dice lo último.
 *
 * NUNCA rompe lo que la llamó: si falla, se avisa en consola y ya. Guardar una
 * receta o un cobro no puede caerse porque no se pudo escribir su constancia.
 */
const PatientObservation = require('../models/PatientObservation');

const TZ = 'America/Guayaquil';
const fecha = (d) => (d
  ? new Intl.DateTimeFormat('es-EC', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(d))
  : '');
const fechaHora = (d) => (d
  ? new Intl.DateTimeFormat('es-EC', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(d))
  : '');
const dinero = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const nombre = (u) => (u && typeof u === 'object' ? u.name || '' : '');

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

/* ------------------------------------------------------------------ RECETA */

/** Lo que va dentro de un suero, en una línea: «Cloruro 250 ml + Vitamina C ×2». */
function composicionSuero(it) {
  const partes = [];
  if (it.serumBase?.name || it.serumBase?.volumeMl) {
    partes.push([it.serumBase?.name || 'Cloruro', it.serumBase?.volumeMl ? `${it.serumBase.volumeMl} ml` : ''].filter(Boolean).join(' '));
  }
  for (const c of it.serumComponents || []) {
    if (!c?.name) continue;
    partes.push(`${c.name}${Number(c.quantity) > 1 ? ` ×${c.quantity}` : ''}`);
  }
  return partes.join(' + ');
}

/**
 * Texto de la receta de un seguimiento, o '' si no recetó nada.
 *
 * Solo la RECETA: lo que llegó como derivación (`fromDerivacion`) es un servicio
 * al que se le manda, no algo que se le receta.
 */
function textoDeReceta(fu) {
  const items = (fu.recetaItems || []).filter((it) => it && !it.fromDerivacion && String(it.name || '').trim());
  if (!items.length) return '';
  const quien = nombre(fu.createdBy);
  const lineas = [`Receta · ${fecha(fu.fecha || fu.createdAt)}${quien ? ` · ${quien}` : ''}`];
  for (const it of items) {
    const detalle = [it.dose, it.frequency, it.duration].map((x) => String(x || '').trim()).filter(Boolean).join(' · ');
    lineas.push(`• ${it.name} × ${it.quantity ?? 1}${detalle ? ` · ${detalle}` : ''}`);
    if (it.isSerum) {
      const comp = composicionSuero(it);
      if (comp) lineas.push(`  ${comp}`);
    }
    if (String(it.instructions || '').trim()) lineas.push(`  Indicaciones: ${String(it.instructions).trim()}`);
  }
  return lineas.join('\n');
}

/**
 * Registro de la RECETA de un seguimiento. Si el seguimiento se corrige y se
 * quita la receta entera, la constancia se borra: diría algo que ya no es.
 */
async function registrarReceta(patientId, followUpId, userId, { lanzar = false } = {}) {
  try {
    if (!patientId || !followUpId) return;
    const ClinicalRecord = require('../models/ClinicalRecord');
    const record = await ClinicalRecord.findOne({ patient: patientId })
      .select('clinic patient followUps')
      .populate('followUps.createdBy', 'name')
      .lean();
    const fu = (record?.followUps || []).find((f) => String(f._id) === String(followUpId));
    if (!fu) return;
    const text = textoDeReceta(fu);
    if (!text) {
      await PatientObservation.deleteOne({ 'auto.kind': 'receta', 'auto.ref': fu._id });
      return;
    }
    await guardar({
      kind: 'receta',
      ref: fu._id,
      clinic: record.clinic,
      patient: record.patient,
      userId: userId || fu.createdBy?._id || fu.createdBy,
      text,
    });
  } catch (e) {
    if (lanzar) throw e;
    console.warn('[observaciones automáticas] receta:', e.message);
  }
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

module.exports = { registrarReceta, registrarVenta, textoDeReceta, textoDeVenta };
