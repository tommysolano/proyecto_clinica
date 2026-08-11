/**
 * HOJA «VENTAS» DEL EXCEL CONTABLE — una fila por venta, con el desglose por forma de pago.
 *
 * Es el archivo con el que la contadora cuadra caja, banco y CxC: el que se baja desde la
 * pantalla de Ventas. Vive aquí, y no dentro de un controlador, porque «Reportes de Ventas»
 * tiene que entregar EXACTAMENTE el mismo archivo (el usuario lo pidió así: el Excel del
 * reporte no le servía al contador porque tenía otro formato). Si cada pantalla armara su
 * propia hoja, volverían a discrepar a la primera columna que cambie.
 *
 * Uso:
 *   const sales = await findSalesForSheet(clinicId, { range, status, productIds });
 *   addSalesSheet(wb, sales);
 */
const Sale = require('../models/Sale');
// Fuente ÚNICA del desglose por forma de pago (distingue tarjeta débito/crédito por el
// snapshot de la venta y nunca adivina el tipo en las ventas antiguas).
const { normalizeSalePayments } = require('./salePayments');

const MONEY = '"$"#,##0.00';

/**
 * El método de pago va DESGLOSADO en una columna por forma, con el importe de cada una:
 * «mixto» o «tarjeta» a secas no le sirven al contador para cuadrar caja, banco ni CxC.
 * Las columnas suman exactamente el total de la venta (el backend valida el reparto).
 */
const SALES_COLUMNS = [
  { header: 'N° Venta', key: 'saleNumber', width: 14 },
  { header: 'Fecha', key: 'date', width: 20 },
  { header: 'Cliente', key: 'client', width: 30 },
  { header: 'Cédula/RUC', key: 'cedula', width: 16 },
  { header: 'Paciente registrado', key: 'patient', width: 28 },
  { header: 'Paciente nuevo', key: 'isFirst', width: 14 },
  { header: 'Subtotal', key: 'subtotal', width: 12 },
  { header: 'IVA', key: 'tax', width: 10 },
  { header: 'Total', key: 'total', width: 12 },
  { header: 'Forma de pago', key: 'method', width: 14 },
  { header: 'Efectivo', key: 'efectivo', width: 12 },
  { header: 'Transferencia', key: 'transferencia', width: 14 },
  { header: 'Tarjeta crédito', key: 'tarjetaCredito', width: 15 },
  { header: 'Tarjeta débito', key: 'tarjetaDebito', width: 14 },
  { header: 'Tarjeta (sin tipo)', key: 'tarjetaSinTipo', width: 16 },
  { header: 'Crédito (CxC)', key: 'credito', width: 13 },
  { header: 'Otros', key: 'otros', width: 10 },
  { header: 'Días crédito', key: 'creditDays', width: 12 },
  { header: 'Vence', key: 'dueDate', width: 12 },
  { header: 'Saldo pendiente', key: 'balance', width: 15 },
  { header: 'Diferido tarjeta', key: 'diferido', width: 18 },
  { header: 'Estado', key: 'status', width: 12 },
  { header: 'Factura', key: 'invoice', width: 22 },
  { header: 'Estado SRI', key: 'sri', width: 14 },
  { header: 'Registrado por', key: 'createdBy', width: 24 },
];

const MONEY_KEYS = [
  'subtotal', 'tax', 'total', 'efectivo', 'transferencia',
  'tarjetaCredito', 'tarjetaDebito', 'tarjetaSinTipo', 'credito', 'otros', 'balance',
];

/**
 * Reparto por forma de pago del RECIBO de la venta (no incluye cobros posteriores de la
 * CxC: esos son otro documento y se ven en Cobros).
 */
const COLUMNA = {
  efectivo: 'efectivo',
  transferencia: 'transferencia',
  deposito: 'transferencia',
  tarjeta_credito: 'tarjetaCredito',
  tarjeta_debito: 'tarjetaDebito',
  tarjeta_sin_tipo: 'tarjetaSinTipo',
  credito: 'credito',
};

const DIFERIDO_LABEL = {
  CORRIENTE: 'Corriente',
  SIN_INTERES: 'Diferido sin intereses',
  CON_INTERES: 'Diferido con intereses',
};

/** Una fila del Excel a partir de una venta ya poblada (paciente, usuario y factura). */
function salesSheetRow(s) {
  const { rows } = normalizeSalePayments(s);
  const porColumna = {};
  for (const row of rows) {
    const key = COLUMNA[row.method] || 'otros';
    porColumna[key] = +((porColumna[key] || 0) + Number(row.amount || 0)).toFixed(2);
  }
  // Días de crédito: el plazo pactado si se guardó; si no, la distancia entre la venta y
  // el vencimiento (las ventas antiguas solo tienen la fecha).
  let dias = null;
  if (Number(s.creditDays) > 0) dias = Number(s.creditDays);
  else if (s.dueDate && s.createdAt) {
    dias = Math.max(0, Math.round((new Date(s.dueDate) - new Date(s.createdAt)) / 86400000));
  }
  const conDiferido = (s.payments || []).find((p) => p.cardDeferredType && p.cardDeferredType !== 'CORRIENTE');
  return {
    saleNumber: s.saleNumber,
    date: new Date(s.createdAt).toLocaleString('es-EC'),
    client: s.clientName,
    cedula: s.clientCedula,
    patient: s.patient ? `${s.patient.firstName} ${s.patient.lastName}` : '—',
    isFirst: s.isFirstVisit ? 'SÍ' : '',
    subtotal: Number(s.subtotal || 0),
    tax: Number(s.taxAmount || 0),
    total: Number(s.total || 0),
    method: s.paymentMethod,
    efectivo: porColumna.efectivo || 0,
    transferencia: porColumna.transferencia || 0,
    tarjetaCredito: porColumna.tarjetaCredito || 0,
    tarjetaDebito: porColumna.tarjetaDebito || 0,
    tarjetaSinTipo: porColumna.tarjetaSinTipo || 0,
    credito: porColumna.credito || 0,
    otros: porColumna.otros || 0,
    creditDays: dias === null ? '' : dias,
    dueDate: s.dueDate ? new Date(s.dueDate).toLocaleDateString('es-EC') : '',
    balance: Number(s.balance || 0),
    diferido: conDiferido
      ? `${DIFERIDO_LABEL[conDiferido.cardDeferredType] || conDiferido.cardDeferredType}${conDiferido.cardDeferredMonths ? ` · ${conDiferido.cardDeferredMonths} meses` : ''}`
      : '',
    status: s.status,
    invoice: s.invoice ? `${s.invoice.estab}-${s.invoice.ptoEmi}-${s.invoice.secuencial}` : '—',
    sri: s.invoice?.estado || '—',
    createdBy: s.createdBy?.name || '—',
  };
}

/** Agrega la hoja «Ventas» al libro y la devuelve. */
function addSalesSheet(wb, sales, { title = 'Ventas' } = {}) {
  const ws = wb.addWorksheet(title);
  ws.columns = SALES_COLUMNS;
  sales.forEach((s) => ws.addRow(salesSheetRow(s)));
  MONEY_KEYS.forEach((k) => { ws.getColumn(k).numFmt = MONEY; });
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF047857' } };
  ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'left' };
  return ws;
}

/**
 * Ventas del período con TODO lo que la hoja necesita poblado.
 *
 * @param {string} clinicId
 * @param {object} opts
 * @param {object} [opts.range]       rango de `createdAt` ({ $gte, $lte })
 * @param {string} [opts.status]      filtro de estado (vacío = todas, incluidas las anuladas)
 * @param {string[]} [opts.productIds] solo ventas que contengan alguno de estos productos
 */
function findSalesForSheet(clinicId, { range, status, productIds } = {}) {
  const query = { clinic: clinicId };
  if (range) query.createdAt = range;
  if (status) query.status = status;
  if (productIds && productIds.length) query['items.product'] = { $in: productIds };
  return Sale.find(query)
    .populate('patient', 'firstName lastName cedula')
    .populate('createdBy', 'name email')
    .populate('invoice', 'estado claveAcceso secuencial estab ptoEmi')
    .sort({ createdAt: -1 });
}

module.exports = { addSalesSheet, findSalesForSheet, salesSheetRow, SALES_COLUMNS };
