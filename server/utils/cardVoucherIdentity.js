/** Identidad del pago de tarjeta dentro de una venta. null significa legado sin renglón conocido. */
function paymentIndex(value) {
  if (value === null || value === undefined || value === '') return null;
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : NaN;
}

function key(item) {
  return `${String(item.sale)}:${paymentIndex(item.paymentIndex) ?? '*'}`;
}

function conflicts(a, b) {
  if (String(a.sale) !== String(b.sale)) return false;
  const ai = paymentIndex(a.paymentIndex);
  const bi = paymentIndex(b.paymentIndex);
  return ai === null || bi === null || ai === bi;
}

module.exports = { paymentIndex, key, conflicts };
