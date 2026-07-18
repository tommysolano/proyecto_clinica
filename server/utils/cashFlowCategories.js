/**
 * Árbol de categorías del flujo de caja.
 *
 * Es solo la SEMILLA por defecto: se copia a `CashFlowConfig.categories` la primera vez y
 * a partir de ahí manda la configuración de cada clínica (se pueden añadir, renombrar y
 * desactivar). El motor nunca asume estas etiquetas: recorre las de la configuración.
 *
 * La estructura reproduce la del Excel de referencia (FLUJO DE CAJA), con dos correcciones
 * conscientes que se documentan en docs/FLUJO_DE_CAJA.md:
 *   - el Excel deja los PRÉSTAMOS recibidos fuera de `TOTAL INGRESOS` (su SUM va de la fila
 *     10 a la 17 y el préstamo está en la 18); aquí sí suman;
 *   - el Excel solo tiene columnas de lunes a viernes; aquí el sábado es hábil salvo que la
 *     clínica lo apague (`includeSaturdays`).
 */

const SIN_CLASIFICAR = 'SIN_CLASIFICAR';

/** Categorías de INGRESO. `key` es estable; `label` es editable por la clínica. */
const DEFAULT_INCOME = [
  {
    key: 'CLIENTES',
    label: 'Clientes',
    order: 10,
    subcategories: [
      { key: 'CLIENTES_CXC', label: 'Cobro de facturas', order: 10 },
      { key: 'CLIENTES_CONTADO', label: 'Depósitos ventas al contado', order: 20 },
      { key: 'CLIENTES_TARJETA', label: 'Transferencias y cobros TC', order: 30 },
    ],
  },
  {
    key: 'OTROS_INGRESOS',
    label: 'Otros ingresos',
    order: 20,
    subcategories: [
      { key: 'APORTES', label: 'Aportes de socios', order: 10 },
      { key: 'DEVOLUCIONES', label: 'Devoluciones recibidas', order: 20 },
      { key: 'EXTRAORDINARIOS', label: 'Ingresos extraordinarios', order: 30 },
    ],
  },
  {
    key: 'PRESTAMOS_RECIBIDOS',
    label: 'Préstamos recibidos',
    order: 30,
    isLoan: true,
    subcategories: [],
  },
];

/**
 * Categorías de EGRESO. Subclasificación que pidió la contadora: los proveedores se ASIGNAN a
 * una de estas categorías (una regla `SUPPLIER` por proveedor) y desde ahí todas sus CxP caen
 * en su categoría con su vencimiento. Las etiquetas y el árbol son EDITABLES por la clínica.
 *
 * Las `key` son estables (reglas y overrides las referencian): «Proveedores de inventario» y
 * «Otros gastos» conservan las keys históricas PROVEEDORES / OTROS_PAGOS y solo cambian de
 * etiqueta; HONORARIOS_DOCTORES es la única realmente nueva.
 */
const DEFAULT_EXPENSE = [
  {
    key: 'PROVEEDORES',
    label: 'Proveedores de inventario',
    order: 10,
    subcategories: [],
  },
  {
    key: 'HONORARIOS_DOCTORES',
    label: 'Honorarios de doctores',
    order: 20,
    subcategories: [],
  },
  {
    key: 'OTROS_PAGOS',
    label: 'Otros gastos',
    order: 30,
    subcategories: [
      { key: 'VIATICOS', label: 'Viáticos', order: 10 },
      { key: 'DEV_CLIENTES', label: 'Devoluciones a clientes', order: 20 },
      { key: 'CAPACITACIONES', label: 'Capacitaciones', order: 30 },
      { key: 'MANTENIMIENTO', label: 'Mantenimiento', order: 40 },
      { key: 'IMPRENTA', label: 'Imprenta', order: 50 },
      { key: 'SUMINISTROS', label: 'Suministros', order: 60 },
      { key: 'CAJA_CHICA', label: 'Caja chica', order: 70 },
      { key: 'IMPORTACIONES', label: 'Importaciones', order: 80 },
      { key: 'GASTOS_LEGALES', label: 'Gastos legales', order: 90 },
      { key: 'OTROS', label: 'Otros', order: 100 },
    ],
  },
  {
    key: 'GASTOS_FIJOS',
    label: 'Gastos fijos',
    order: 40,
    subcategories: [
      { key: 'SUELDOS', label: 'Sueldos', order: 10 },
      { key: 'COMISIONES', label: 'Comisiones', order: 20 },
      { key: 'DECIMOS', label: 'Décimo tercero y cuarto', order: 30 },
      { key: 'IESS', label: 'IESS', order: 40 },
      { key: 'SRI', label: 'SRI', order: 50 },
      { key: 'SERVICIOS_BASICOS', label: 'Servicios básicos', order: 60 },
      { key: 'ALQUILERES', label: 'Alquileres', order: 70 },
      { key: 'TARJETAS_CORPORATIVAS', label: 'Tarjetas corporativas', order: 80 },
      { key: 'SERVICIOS_RECURRENTES', label: 'Servicios recurrentes', order: 90 },
      { key: 'UTILIDADES', label: 'Utilidades', order: 100 },
      { key: 'OTROS_FIJOS', label: 'Otros gastos fijos', order: 110 },
    ],
  },
  {
    key: 'PRESTAMOS_PAGADOS',
    label: 'Préstamos',
    order: 50,
    isLoan: true,
    subcategories: [
      { key: 'CAPITAL', label: 'Capital', order: 10 },
      { key: 'INTERES', label: 'Interés', order: 20 },
      { key: 'COMISION_BANCARIA', label: 'Comisión bancaria', order: 30 },
    ],
  },
];

// Categorías auto-sembradas con el nombre viejo que se renombran (sin pisar personalizaciones).
const EXPENSE_RELABEL = {
  PROVEEDORES: { from: 'Proveedores', to: 'Proveedores de inventario' },
  OTROS_PAGOS: { from: 'Otros pagos', to: 'Otros gastos' },
};

/** Categoría comodín: nunca se oculta, para que un documento sin regla no desaparezca. */
const UNCLASSIFIED = {
  key: SIN_CLASIFICAR,
  label: 'Sin clasificar',
  order: 999,
  subcategories: [],
};

function defaultCategories() {
  return {
    INGRESO: [...DEFAULT_INCOME, { ...UNCLASSIFIED }].map((c) => ({ ...c, isActive: true })),
    EGRESO: [...DEFAULT_EXPENSE, { ...UNCLASSIFIED }].map((c) => ({ ...c, isActive: true })),
  };
}

/**
 * Fusiona en una config EXISTENTE las categorías de egreso por defecto que falten (idempotente
 * y NO destructivo). Añade las nuevas por `key`, aplica los renombres de las auto-sembradas
 * (solo si conservan el label viejo, para no pisar personalizaciones) y ordena por `order`
 * dejando «Sin clasificar» al final. Devuelve true si cambió algo (para guardar solo entonces).
 */
function mergeExpenseDefaults(categories) {
  if (!categories) return false;
  const list = categories.EGRESO || (categories.EGRESO = []);
  const byKey = new Map(list.map((c) => [c.key, c]));
  let changed = false;
  for (const def of DEFAULT_EXPENSE) {
    const existing = byKey.get(def.key);
    if (!existing) {
      list.push({ ...def, isActive: true });
      changed = true;
      continue;
    }
    const rel = EXPENSE_RELABEL[def.key];
    if (rel && existing.label === rel.from) { existing.label = rel.to; changed = true; }
  }
  // La compra de un proveedor sin regla cae en SIN_CLASIFICAR y necesita su fila en la matriz:
  // si una config vieja no tuviera el comodín, se añade (nunca se oculta).
  if (!byKey.has(SIN_CLASIFICAR)) {
    list.push({ ...UNCLASSIFIED, isActive: true });
    changed = true;
  }
  if (changed) {
    // Reordenar respetando `order`; «Sin clasificar» (999) queda al final.
    list.sort((a, b) => (a.order || 0) - (b.order || 0));
  }
  return changed;
}

/**
 * Clasificación por defecto del MÓDULO de origen (nivel 5 de la prioridad del Bloque B).
 * Es lo que se aplica cuando no hay override en el documento ni regla configurada.
 *
 * Deliberadamente NO mira la descripción: un préstamo, un impuesto o un gasto fijo se
 * reconocen por su origen (`sourceModel`) o por una regla explícita, nunca por buscar
 * palabras sueltas en un texto libre.
 *
 * OJO — las COMPRAS de proveedor (`Payable:PurchaseInvoice`) NO tienen default a propósito:
 * una CxP de un proveedor que la clínica todavía NO clasificó cae en SIN_CLASIFICAR (el
 * fallback de `classify`), NO en «Proveedores de inventario». Meterla ahí por defecto
 * mezclaba montos ajenos —honorarios de doctores, servicios, préstamos— en esa categoría y
 * distorsionaba su total. Así el monto se ve, pero separado en su propia fila «Sin
 * clasificar», junto con el aviso de nombres del panel derecho. En cuanto se asigna el
 * proveedor a una categoría (regla SUPPLIER), TODAS sus CxP se mueven ahí en el próximo cálculo.
 */
const MODULE_DEFAULTS = {
  // Ingresos
  'Receivable:Sale': { category: 'CLIENTES', subcategory: 'CLIENTES_CXC' },
  'Receivable:Invoice': { category: 'CLIENTES', subcategory: 'CLIENTES_CXC' },
  // Egresos (las compras de proveedor sin regla quedan SIN_CLASIFICAR — ver nota de arriba).
  'Payable:Payroll': { category: 'GASTOS_FIJOS', subcategory: 'SUELDOS' },
  'Payable:SriDeclaration': { category: 'GASTOS_FIJOS', subcategory: 'SRI' },
};

module.exports = {
  defaultCategories,
  mergeExpenseDefaults,
  MODULE_DEFAULTS,
  SIN_CLASIFICAR,
  UNCLASSIFIED,
};
