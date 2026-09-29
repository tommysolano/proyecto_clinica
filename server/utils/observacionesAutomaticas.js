/**
 * OBSERVACIONES AUTOMÁTICAS (sep-2026, a petición de la clínica).
 *
 * La bitácora de Observaciones del paciente se llena SOLA con lo que pasa en
 * caja y en la consulta: qué servicios se hizo, quién lo atendió, cuánto se
 * cobró, quién lo cobró, cómo pagó y qué se llevó de la receta. Antes eso
 * había que ir a buscarlo a la agenda, a Ventas y a la cita, cada cosa por su
 * lado — o anotarlo a mano.
 *
 * Dos registros, cada uno UNO por origen (`auto.kind` + `auto.ref`, índice
 * único): se REESCRIBEN cuando el origen cambia, así que no se duplican con
 * los reintentos y siempre dicen lo último.
 *
 *  · VISITA — por cita atendida (o con valor anotado): servicios, profesionales
 *    que atendieron, valor o canje, adelanto y quién registró el cobro.
 *  · VENTA  — por venta con paciente: productos/servicios, total, forma de
 *    pago (con banco o tarjeta), quién cobró y, si se anuló, que se anuló.
 *
 * NUNCA rompe lo que la llamó: si falla, se avisa en consola y ya. Un cobro no
 * puede caerse porque no se pudo escribir su constancia.
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
/** Nombre de la sede, aparte: poblar `clinic` la dejaría en null si no se encuentra. */
async function nombreDeSede(clinicId) {
  if (!clinicId) return '';
  const Clinic = require('../models/Clinic');
  const c = await Clinic.findById(clinicId).select('name nombreComercial').lean();
  return c?.nombreComercial || c?.name || '';
}
const nombre = (u) => (u && typeof u === 'object' ? u.name || '' : '');

const FORMA_OPERATIVA = {
  efectivo: 'Efectivo',
  transferencia: 'Transferencia',
  tarjeta_credito: 'Tarjeta de crédito',
  tarjeta_debito: 'Tarjeta de débito',
};
const FORMA_VENTA = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  transferencia: 'Transferencia',
  credito: 'Crédito (por cobrar)',
  mixto: 'Pago dividido',
};
const TIPO_ITEM = { servicio: 'servicio', programa: 'programa', insumo: 'producto' };

/**
 * Crea o reescribe el registro automático de ese origen.
 *
 * `fecha` (solo el relleno histórico) fecha el registro cuando PASÓ, no hoy: si
 * no, un año de ventas aparecería de golpe encima de todo como si fuera de hoy.
 */
async function guardar({ kind, ref, clinic, patient, userId, text, fecha = null }) {
  if (!patient || !ref || !text || !userId) return;
  const alta = { clinic, patient, createdBy: userId, auto: { kind, ref }, attachments: [] };
  if (fecha) {
    await PatientObservation.updateOne(
      { 'auto.kind': kind, 'auto.ref': ref },
      { $set: { text }, $setOnInsert: { ...alta, createdAt: fecha, updatedAt: fecha } },
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

/* ------------------------------------------------------------------ VISITA */

function textoDeVisita(apt, sede = '') {
  const lineas = ['Atención registrada automáticamente'];
  lineas.push(`Cita: ${[fecha(apt.date), apt.startTime, sede].filter(Boolean).join(' · ')}`);

  const servicios = [
    apt.serviceName || apt.serviceItem?.name || '',
    ...(apt.additionalServices || []).map((s) => s.name || s.serviceItem?.name || ''),
    ...(apt.services || []).map((s) => s.name || s.product?.name || ''),
  ].map((s) => String(s).trim()).filter(Boolean);
  const unicos = [...new Set(servicios)];
  if (unicos.length) {
    lineas.push('', 'Servicios:');
    for (const s of unicos) lineas.push(`• ${s}`);
  }

  // Quién atendió: los turnos cerrados, en orden; en las citas viejas, los espejos.
  const atendieron = [];
  const turnos = [...(apt.turns || [])].sort((a, b) => (a.order || 0) - (b.order || 0));
  for (const t of turnos) {
    if (t.status !== 'completado' || !nombre(t.user)) continue;
    atendieron.push(`${nombre(t.user)} (${t.kind === 'enfermeria' ? 'enfermería' : 'médico'})`);
  }
  if (!turnos.length) {
    if (nombre(apt.doctor)) atendieron.push(`${nombre(apt.doctor)} (médico)`);
    if (nombre(apt.attendedByNurse)) atendieron.push(`${nombre(apt.attendedByNurse)} (enfermería)`);
  }
  const vigente = turnos.find((t) => t.status === 'pendiente' && nombre(t.user));
  if (atendieron.length) lineas.push('', `Atendido por: ${[...new Set(atendieron)].join(', ')}`);
  else if (vigente) lineas.push('', `Asignado a: ${nombre(vigente.user)}`);

  // Lo que se cobra por la visita (dato operativo de mostrador).
  const cobro = [];
  if (apt.isCanje) cobro.push('Canje (sin cobro en dinero)');
  else if (apt.agreedValue != null) cobro.push(`Valor de la cita: ${dinero(apt.agreedValue)}`);
  // «No pagó aún» se dice tal cual: un valor sin pago no es un cobro.
  if (!apt.isCanje && !apt.advancePayment && apt.agreedValue != null) cobro.push('Pago: no pagó aún');
  if (apt.advancePayment) {
    const forma = FORMA_OPERATIVA[apt.advanceMethod] ? ` · ${FORMA_OPERATIVA[apt.advanceMethod]}` : '';
    if (apt.advancePayment === 'total') cobro.push(`Pagó todo por adelantado${forma}`);
    else if (apt.advancePayment === 'prepagado') cobro.push(`Prepagado${forma}`);
    else cobro.push(`Abono por adelantado: ${dinero(apt.advanceAmount)}${forma}`);
  }
  if (cobro.length) {
    lineas.push('', ...cobro);
    const quien = nombre(apt.valueSetBy);
    const cuando = apt.valueSetAt ? ` (${fechaHora(apt.valueSetAt)})` : '';
    if (quien) lineas.push(`${apt.advancePayment ? 'Cobro registrado por' : 'Valor anotado por'}: ${quien}${cuando}`);
  }
  if (apt.status === 'completada') lineas.push('', 'Estado: atención terminada');
  else if (apt.status === 'asistida') lineas.push('', 'Estado: en atención');
  return lineas.join('\n');
}

/**
 * Registro de la VISITA. Solo cuando ya hay algo que contar: el paciente vino
 * (asistida/completada) o mostrador anotó lo que se cobra. Una cita agendada
 * sin más no es historia del paciente todavía.
 */
async function registrarVisita(aptOrId, userId, { fechaOriginal = false, lanzar = false } = {}) {
  try {
    const Appointment = require('../models/Appointment');
    const id = aptOrId?._id || aptOrId;
    const apt = await Appointment.findById(id)
      .populate('turns.user', 'name')
      .populate('doctor', 'name')
      .populate('attendedByNurse', 'name')
      .populate('valueSetBy', 'name')
      .populate('serviceItem', 'name')
      .lean();
    if (!apt?.patient) return;
    const vino = ['asistida', 'completada'].includes(apt.status);
    const conValor = apt.isCanje || apt.agreedValue != null || !!apt.advancePayment;
    if (!vino && !conValor) return;
    await guardar({
      kind: 'visita',
      ref: apt._id,
      clinic: apt.clinic,
      patient: apt.patient,
      userId: userId || apt.valueSetBy?._id || apt.createdBy,
      text: textoDeVisita(apt, await nombreDeSede(apt.clinic)),
      fecha: fechaOriginal ? (apt.consultationEndedAt || apt.arrivedAt || apt.date) : null,
    });
  } catch (e) {
    if (lanzar) throw e;
    console.warn('[observaciones automáticas] visita:', e.message);
  }
}

/* ------------------------------------------------------------------- VENTA */

function formaDePago(p) {
  const base = FORMA_VENTA[p.method] || p.method || '';
  const extra = [];
  if (p.bankAccount && typeof p.bankAccount === 'object') {
    extra.push([p.bankAccount.bank, p.bankAccount.name].filter(Boolean).join(' '));
  }
  if (p.method === 'tarjeta') {
    const tarjeta = (p.creditCard && typeof p.creditCard === 'object' && p.creditCard.name) || p.cardBrandSnapshot || '';
    if (tarjeta) extra.push(tarjeta);
    if (p.cardTypeSnapshot) extra.push(p.cardTypeSnapshot.toLowerCase());
    if (p.cardDeferredMonths > 0) extra.push(`diferido ${p.cardDeferredMonths} meses`);
  }
  if (p.reference) extra.push(`ref. ${p.reference}`);
  return extra.length ? `${base} (${extra.join(' · ')})` : base;
}

function textoDeVenta(sale, sede = '') {
  const lineas = [sale.status === 'anulada' ? 'Venta ANULADA' : 'Venta registrada automáticamente'];
  lineas.push([sale.saleNumber ? `N.º ${sale.saleNumber}` : '', fechaHora(sale.createdAt), sede].filter(Boolean).join(' · '));
  if (sale.appointment) {
    const a = sale.appointment;
    const cita = typeof a === 'object' ? [fecha(a.date), a.startTime, a.serviceName].filter(Boolean).join(' · ') : '';
    lineas.push(`Cobro de la cita${cita ? `: ${cita}` : ''}`);
  }

  lineas.push('', 'Detalle:');
  for (const it of sale.items || []) {
    const tipo = TIPO_ITEM[it.category] || TIPO_ITEM[it.product?.category] || '';
    const nom = it.productName || it.product?.name || 'Ítem';
    const total = it.lineTotal || it.subtotal || 0;
    lineas.push(`• ${nom} × ${it.quantity}${tipo ? ` (${tipo})` : ''} · ${dinero(total)}`);
  }
  if (sale.discountTotal > 0) lineas.push(`Descuento: ${dinero(sale.discountTotal)}`);
  lineas.push('', `Total cobrado: ${dinero(sale.total)}`);

  const pagos = (sale.payments || []).filter((p) => p && p.method);
  if (pagos.length > 1) {
    lineas.push('Forma de pago:');
    for (const p of pagos) lineas.push(`• ${formaDePago(p)} · ${dinero(p.amount)}`);
  } else {
    const unico = pagos[0] || {
      method: sale.paymentMethod,
      bankAccount: sale.bankAccount,
      creditCard: sale.creditCard,
      cardDeferredMonths: sale.cardDeferredMonths,
    };
    lineas.push(`Forma de pago: ${formaDePago(unico)}`);
  }
  if (sale.balance > 0 && sale.status !== 'anulada') lineas.push(`Saldo pendiente: ${dinero(sale.balance)}`);

  const cobro = nombre(sale.createdBy) || nombre(sale.cashier);
  if (cobro) lineas.push(`Cobrado por: ${cobro}`);
  const atendio = [nombre(sale.doctor), nombre(sale.nurse)].filter(Boolean);
  if (atendio.length) lineas.push(`Atendido por: ${atendio.join(', ')}`);
  if (nombre(sale.recommendedBy)) lineas.push(`Recomendado por: ${nombre(sale.recommendedBy)}`);
  if (sale.status === 'anulada') lineas.push('', `Anulada el ${fechaHora(sale.updatedAt)}`);
  return lineas.join('\n');
}

/** Registro de la VENTA (solo si tiene paciente: consumidor final no tiene ficha). */
async function registrarVenta(saleOrId, userId, { fechaOriginal = false, lanzar = false } = {}) {
  try {
    const Sale = require('../models/Sale');
    const id = saleOrId?._id || saleOrId;
    const sale = await Sale.findById(id)
      .populate('createdBy', 'name')
      .populate('cashier', 'name')
      .populate('doctor', 'name')
      .populate('nurse', 'name')
      .populate('recommendedBy', 'name')
      .populate('appointment', 'date startTime serviceName')
      .populate('items.product', 'name category')
      .populate('bankAccount', 'name bank')
      .populate('creditCard', 'name')
      .populate('payments.bankAccount', 'name bank')
      .populate('payments.creditCard', 'name')
      .lean();
    if (!sale?.patient) return;
    await guardar({
      kind: 'venta',
      ref: sale._id,
      clinic: sale.clinic,
      patient: sale.patient,
      userId: userId || sale.createdBy?._id,
      text: textoDeVenta(sale, await nombreDeSede(sale.clinic)),
      fecha: fechaOriginal ? sale.createdAt : null,
    });
  } catch (e) {
    if (lanzar) throw e;
    console.warn('[observaciones automáticas] venta:', e.message);
  }
}

module.exports = { registrarVisita, registrarVenta, textoDeVisita, textoDeVenta };
