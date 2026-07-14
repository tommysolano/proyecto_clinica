/**
 * CÓMO SE COBRÓ UNA VENTA: fuente ÚNICA para el reporte, el Excel y los diagnósticos.
 *
 * ── La regla que estaba rota ────────────────────────────────────────────────────────────
 * El reporte agrupaba por `Sale.paymentMethod`, que es un RESUMEN: una venta de 100 pagada
 * mitad en efectivo y mitad con tarjeta aparecía como **100 en "mixto"**. La fuente real es
 * `Sale.payments[]` (una fila por método), y `paymentMethod` queda solo como compatibilidad.
 *
 * ── La fila `credito` NO es un cobro ────────────────────────────────────────────────────
 * `Sale.payments[]` incluye una fila `credito` con la parte que quedó a deber: es la DECLARACIÓN
 * del reparto (por eso su suma cuadra con el total), no dinero recibido. Aquí se separa: esa
 * parte es CxC, no ingreso cobrado. El saldo se toma de `Sale.balance` (la CxC), nunca de la
 * fila. Así se cumple siempre:
 *
 *     total = cobrado + saldo        (cobrado = pagos reales de la venta + cobros posteriores)
 *
 * ── Cobros posteriores ──────────────────────────────────────────────────────────────────
 * Un cobro de la CxC vive en su propio `Payment` (type COBRO) y entra al reporte como una fila
 * más, con su método real y su fecha. Sin esto, cobrar una venta a crédito no aparecería en
 * ninguna columna de método.
 *
 * ── Legacy ──────────────────────────────────────────────────────────────────────────────
 * Una venta sin `payments[]` (anterior al pago dividido) se lee desde `paymentMethod` y la fila
 * se marca `LEGACY_FALLBACK`. Si era tarjeta, NO se inventa si fue débito o crédito: no hay
 * evidencia, y adivinarla falsearía el reporte.
 */
const Payment = require('../models/Payment');

const r2 = (n) => +Number(n || 0).toFixed(2);
const TOL = 0.01;

/** Métodos que el reporte muestra en columnas separadas. */
const METHODS = ['efectivo', 'transferencia', 'deposito', 'tarjeta_debito', 'tarjeta_credito', 'cheque', 'otro'];
const CREDITO = 'credito';

/** Método de reporte de una fila de pago de la venta (usa el SNAPSHOT de la tarjeta). */
function reportMethod(p) {
  if (p.method === 'tarjeta') {
    if (p.cardTypeSnapshot === 'DEBITO') return 'tarjeta_debito';
    if (p.cardTypeSnapshot === 'CREDITO' || p.cardTypeSnapshot === 'CORRIENTE') return 'tarjeta_credito';
    return 'tarjeta_sin_tipo';   // sin evidencia: no se adivina
  }
  if (p.method === 'efectivo') return 'efectivo';
  if (p.method === 'transferencia') return 'transferencia';
  if (p.method === CREDITO) return CREDITO;
  return 'otro';
}

/** Método de reporte de un cobro posterior (`Payment.method`). */
function reportMethodOfPayment(m) {
  const map = {
    EFECTIVO: 'efectivo',
    TRANSFERENCIA: 'transferencia',
    DEPOSITO: 'deposito',
    CHEQUE: 'cheque',
    TARJETA: 'tarjeta_credito',   // el cobro no distingue débito/crédito: se informa como tarjeta
    OTRO: 'otro',
  };
  return map[m] || 'otro';
}

/**
 * Filas de pago de UNA venta, ya normalizadas.
 *
 * @param {object} sale             venta (lean u objeto)
 * @param {Array}  cobrosPosteriores  `Payment` (COBRO, REGISTRADO) aplicados a esta venta
 * @returns {{rows, cobrado, credito, saldo, total, porMetodo, legacy, cuadra, descuadre}}
 */
function normalizeSalePayments(sale, cobrosPosteriores = []) {
  const total = r2(sale.total);
  const rows = [];
  let legacy = false;

  const detalle = Array.isArray(sale.payments) ? sale.payments.filter((p) => Number(p.amount) > 0) : [];
  if (detalle.length) {
    for (const p of detalle) {
      rows.push({
        origen: 'VENTA',
        method: reportMethod(p),
        methodRaw: p.method,
        amount: r2(p.amount),
        date: p.date || sale.createdAt || null,
        bankAccount: p.bankAccount || null,
        creditCard: p.creditCard || null,
        cardType: p.cardTypeSnapshot || null,
        cardBrand: p.cardBrandSnapshot || '',
        reference: p.reference || p.cardVoucher || p.cardLote || '',
        // La parte a crédito no es un cobro: es la CxC declarada en el reparto.
        esCredito: p.method === CREDITO,
        legacy: false,
        estado: sale.status === 'anulada' ? 'ANULADA' : 'REGISTRADO',
      });
    }
  } else if (total > 0) {
    // LEGACY: no hay desglose. Se sintetiza UNA fila desde el método resumen y se marca.
    legacy = true;
    const m = sale.paymentMethod || 'efectivo';
    rows.push({
      origen: 'VENTA',
      method: m === 'tarjeta' ? 'tarjeta_sin_tipo' : reportMethod({ method: m }),
      methodRaw: m,
      amount: m === CREDITO ? total : r2(total - Number(sale.balance || 0)),
      date: sale.createdAt || null,
      bankAccount: sale.bankAccount || null,
      creditCard: sale.creditCard || null,
      cardType: null,          // sin evidencia: NO se inventa débito/crédito
      cardBrand: '',
      reference: sale.cardVoucher || '',
      esCredito: m === CREDITO,
      legacy: true,
      legacyReason: 'LEGACY_FALLBACK: la venta no tiene desglose de pagos; se deriva de paymentMethod.',
      estado: sale.status === 'anulada' ? 'ANULADA' : 'REGISTRADO',
    });
  }

  // Cobros POSTERIORES de la CxC: son dinero real, con su método y su fecha.
  for (const p of cobrosPosteriores) {
    const aplicado = (p.applications || [])
      .filter((a) => a.docModel === 'Sale' && String(a.docRef) === String(sale._id))
      .reduce((s, a) => s + Number(a.amount || 0), 0);
    if (aplicado <= 0) continue;
    rows.push({
      origen: 'COBRO_CXC',
      method: reportMethodOfPayment(p.method),
      methodRaw: p.method,
      amount: r2(aplicado),
      date: p.date,
      bankAccount: p.bankAccount || null,
      creditCard: null,
      cardType: null,
      cardBrand: '',
      reference: p.number || p.reference || '',
      esCredito: false,
      legacy: false,
      estado: 'REGISTRADO',
      paymentRef: String(p._id),
    });
  }

  const saldo = r2(sale.balance || 0);
  // Cobrado: TODO lo que no es la fila de crédito. Y el saldo viene de la CxC, no de la fila.
  const cobrado = r2(rows.filter((x) => !x.esCredito).reduce((s, x) => s + x.amount, 0));
  const credito = r2(rows.filter((x) => x.esCredito).reduce((s, x) => s + x.amount, 0));

  const porMetodo = {};
  for (const x of rows) {
    if (x.esCredito) continue;   // la CxC no es un método de cobro
    porMetodo[x.method] = r2((porMetodo[x.method] || 0) + x.amount);
  }
  if (saldo > 0.005) porMetodo[CREDITO] = saldo;   // lo pendiente se informa como CxC

  const esperado = r2(cobrado + saldo);
  const anulada = sale.status === 'anulada';
  return {
    rows,
    total,
    cobrado,
    credito,
    saldo,
    porMetodo,
    legacy,
    // Conciliación por venta: total = cobrado + saldo (una venta anulada no concilia por diseño).
    cuadra: anulada || Math.abs(esperado - total) <= TOL,
    descuadre: anulada ? 0 : r2(total - esperado),
  };
}

/** Carga los cobros posteriores (CxC) de un lote de ventas, sin N+1. */
async function loadLaterCollections(clinicId, saleIds) {
  if (!saleIds.length) return new Map();
  const pagos = await Payment.find({
    clinic: clinicId,
    type: 'COBRO',
    status: 'REGISTRADO',
    'applications.docModel': 'Sale',
    'applications.docRef': { $in: saleIds },
  }).select('number date method bankAccount reference applications').lean();

  const porVenta = new Map();
  for (const p of pagos) {
    for (const a of p.applications || []) {
      if (a.docModel !== 'Sale') continue;
      const k = String(a.docRef);
      porVenta.set(k, [...(porVenta.get(k) || []), p]);
    }
  }
  return porVenta;
}

module.exports = {
  METHODS,
  CREDITO,
  normalizeSalePayments,
  loadLaterCollections,
  reportMethod,
  reportMethodOfPayment,
};
