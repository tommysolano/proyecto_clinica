/**
 * Vencimiento LEGAL de una compra. Fuente ÚNICA: todos los caminos que abren la CxP de una
 * factura de compra (creación, actualización, autorización, importación XML, contabilización
 * posterior y los pagos que abren cartera legacy) resuelven la fecha aquí, para que no
 * existan dos fórmulas distintas.
 *
 * Prioridad:
 *   1. `PurchaseInvoice.fechaVencimiento` explícita   → EXPLICITA
 *   2. días de crédito pactados en la propia compra   → COMPRA
 *   3. días de crédito del proveedor                  → PROVEEDOR
 *   4. nada de lo anterior                            → SIN_PLAZO (la CxP queda sin vencimiento)
 *
 *     dueDate = fechaEmision + creditDays días CALENDARIO
 *
 * El vencimiento legal NO se lleva a día hábil: un vencimiento en sábado sigue siendo sábado
 * y uno en domingo sigue siendo domingo. El desplazamiento (domingo → lunes) es la fecha
 * EFECTIVA de proyección y se calcula aparte, en utils/paymentSchedule, sin tocar el dato.
 */

const SOURCES = ['EXPLICITA', 'COMPRA', 'PROVEEDOR', 'SIN_PLAZO'];

/**
 * @param {{ fechaEmision?: Date, fechaVencimiento?: Date, creditDays?: number }} inv
 * @param {{ creditDays?: number }} [sup]
 * @returns {{ dueDate: Date|null, source: string, creditDays: number }}
 */
function resolvePurchaseDueDate(inv, sup) {
  if (inv?.fechaVencimiento) {
    return { dueDate: new Date(inv.fechaVencimiento), source: 'EXPLICITA', creditDays: 0 };
  }
  const propios = Number(inv?.creditDays) || 0;
  const proveedor = Number(sup?.creditDays) || 0;
  const dias = propios > 0 ? propios : (proveedor > 0 ? proveedor : 0);
  if (dias <= 0 || !inv?.fechaEmision) {
    return { dueDate: null, source: 'SIN_PLAZO', creditDays: 0 };
  }
  const due = new Date(inv.fechaEmision);
  due.setDate(due.getDate() + dias);   // días calendario, sin ajuste a día hábil
  return { dueDate: due, source: propios > 0 ? 'COMPRA' : 'PROVEEDOR', creditDays: dias };
}

module.exports = { resolvePurchaseDueDate, SOURCES };
