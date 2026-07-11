/**
 * Mapa de documento origen de un asiento (JournalEntry.sourceModel) → etiqueta
 * legible y, cuando la página destino sabe abrir `?doc=<id>`, la ruta + `deep:true`.
 *
 * Solo los `deep:true` ofrecen navegación directa (la página lee el query `?doc=<id>`
 * vía useDocDeepLink y abre el documento). El resto se identifica por su etiqueta y
 * se consulta desde el modal del asiento. Así el Libro Mayor y la pantalla de
 * Asientos comparten una única fuente de verdad para la trazabilidad al origen.
 */
export const SOURCE_ROUTES = {
  Sale: { path: '/sales', label: 'Venta', deep: true },
  Invoice: { path: '/invoices', label: 'Factura de venta', deep: true },
  PurchaseInvoice: { path: '/accounting/purchases', label: 'Factura de compra', deep: true },
  FixedAsset: { path: '/accounting/assets', label: 'Activo fijo (depreciación)', deep: true },
  Payroll: { path: '/accounting/payroll', label: 'Nómina', deep: true },
  Payment: { path: '/accounting/payments', label: 'Pago / Cobro', deep: true },
  // Sin deep-link (solo etiqueta): el asiento se ve en el modal.
  BankTransaction: { label: 'Movimiento bancario' },
  CashDeposit: { label: 'Depósito de efectivo' },
  Reconciliation: { label: 'Conciliación' },
  CashClosing: { label: 'Cierre de caja' },
  CashMovement: { label: 'Movimiento de caja' },
  CommissionPosting: { label: 'Comisiones del personal' },
  CreditDebitNote: { label: 'Nota de crédito / débito' },
  RetentionVoucher: { label: 'Comprobante de retención' },
  DeferredIncome: { label: 'Ingreso diferido' },
  CardSettlement: { label: 'Liquidación de tarjeta' },
  CreditCardBatch: { label: 'Lote de tarjeta' },
  EmployeeDeduction: { label: 'Deducción de empleado' },
  PhysicalCount: { label: 'Toma física de inventario' },
  InventoryMovement: { label: 'Movimiento de inventario (traslado)' },
  JournalEntry: { label: 'Asiento (reversa)' },
};

/** Etiqueta del origen; cae al `source` del asiento o a "Asiento manual" si no hay. */
export const sourceLabel = (row) =>
  SOURCE_ROUTES[row?.sourceModel]?.label || row?.source || 'Asiento manual';

/** Verbo de acción para el botón ("Ver venta", "Ver factura de compra", …). */
export const sourceActionLabel = (row) => {
  const map = SOURCE_ROUTES[row?.sourceModel];
  return map?.deep ? `Ver ${map.label.toLowerCase()}` : null;
};

/** URL de deep-link al documento origen, o null si no hay navegación directa. */
export const sourceDeepLink = (row) => {
  const map = SOURCE_ROUTES[row?.sourceModel];
  if (!map?.deep || !row?.sourceRef) return null;
  return `${map.path}?doc=${row.sourceRef}`;
};
