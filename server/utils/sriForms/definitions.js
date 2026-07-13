/**
 * DEFINICIÓN DECLARATIVA Y VERSIONADA DE LOS CASILLEROS (Formularios SRI 103 y 104).
 *
 * La estructura del formulario NO vive en el JSX: vive aquí. La pantalla se dibuja
 * recorriendo `sections` + `cells`, y el backend valida y calcula contra la misma
 * definición. Cambiar el formulario = publicar una nueva versión en este archivo.
 *
 * ─────────────────────────── ADVERTENCIA DE VERIFICACIÓN ───────────────────────────
 * La NUMERACIÓN de casilleros y la estructura de estas definiciones fueron derivadas
 * del formulario de IVA/retenciones de uso corriente, pero NO han sido validadas
 * contra el formulario e instructivo VIGENTES publicados por el SRI (los PDF oficiales
 * son imágenes escaneadas y no se pudieron contrastar automáticamente). Por eso:
 *
 *   - `verified: false` a nivel de definición y `boxVerified: false` por casillero.
 *   - La salida XML es un BORRADOR TÉCNICO. NO es el XML oficial, NO es un archivo
 *     DIMM y NO está listo para subir al SRI. Ver `XML_DISCLAIMER`.
 *   - Los IMPORTES sí son auditables: salen de las ventas/compras/nóminas del período
 *     y de las conciliaciones. Lo que falta confirmar es a qué casillero va cada uno.
 *
 * Validación externa pendiente (para el contador):
 *   1. Confirmar número y etiqueta de cada casillero contra el instructivo vigente.
 *   2. Confirmar la definición de la base del casillero laboral del 103 (ingresos
 *      gravados vs. base imponible neta de aporte personal IESS).
 *   3. Confirmar si la retención de IVA efectuada como agente se declara y paga con
 *      el 104 (así está modelado) y con qué casilleros.
 *   4. Obtener la especificación del XML de importación (XSD) para reemplazar el
 *      borrador técnico por un archivo válido.
 *   5. ATRIBUCIÓN DEL IVA DE COMPRAS (limitación conocida). La compra solo distingue
 *      «deducible» de «no deducible»; NO registra si el IVA es de atribución DIRECTA a
 *      ventas con derecho a crédito, DIRECTA a ventas sin derecho, o COMÚN (el único que
 *      en rigor debería someterse al factor de proporcionalidad). El sistema NO inventa esa
 *      clasificación: trata todo el IVA acreditable como COMÚN, lo advierte en la
 *      conciliación y deja el casillero de IVA al gasto editable para que el contador
 *      ajuste. Si se confirma la regla, el paso siguiente es agregar la clasificación en la
 *      línea de compra y aplicar el factor solo al IVA común.
 *
 * Estructura de un casillero:
 *   box          número de casillero (string)
 *   section      clave de la sección
 *   order        orden dentro de la sección
 *   label        etiqueta visible
 *   source       origen del dato (texto auditable: de dónde sale)
 *   formula      fórmula legible (los cálculos reales viven en compute103/compute104)
 *   kind         COMPUTED (calculado) | EDITABLE (captura el contador) | FORMULA (derivado)
 *   validations  { min, max, maxBox, integer }  → se aplican en el backend al guardar
 *   format       MONEY | PERCENT | NUMBER
 *   help         instrucción/tooltip
 *   boxVerified  ¿el número de casillero está confirmado contra el SRI vigente?
 */

const XML_DISCLAIMER =
  'BORRADOR TÉCNICO generado por el sistema. NO es el XML oficial del SRI, NO es un ' +
  'archivo DIMM y NO está listo para cargar. Falta validar la estructura contra la ' +
  'definición (XSD) vigente del SRI. Úselo solo para revisión y respaldo interno.';

const MONEY = 'MONEY';
const COMPUTED = 'COMPUTED';
const EDITABLE = 'EDITABLE';
const FORMULA = 'FORMULA';

// ─────────────────────────────── FORMULARIO 104 (IVA) ───────────────────────────────
const FORM_104 = {
  formType: '104',
  definitionVersion: '104-borrador-2026.1',
  title: 'Formulario 104 — Declaración del Impuesto al Valor Agregado',
  verified: false,
  sections: [
    { key: 'VENTAS', order: 1, label: 'Ventas y otras operaciones del período' },
    { key: 'COMPRAS', order: 2, label: 'Adquisiciones y pagos del período' },
    { key: 'CREDITO', order: 3, label: 'Factor de proporcionalidad y crédito tributario' },
    { key: 'RESUMEN', order: 4, label: 'Resumen impositivo' },
    { key: 'AGENTE', order: 5, label: 'Retenciones de IVA efectuadas como agente' },
    { key: 'PAGO', order: 6, label: 'Obligación con el SRI' },
  ],
  cells: [
    // ── Ventas
    {
      box: '401', section: 'VENTAS', order: 1, kind: COMPUTED, format: MONEY, boxVerified: false,
      label: 'Ventas locales gravadas con tarifa diferente de 0%',
      source: 'Facturas de venta AUTORIZADAS del período (base gravada del desglose por tarifa).',
      help: 'Solo entran facturas electrónicas autorizadas. Las ventas sin autorizar no se declaran.',
    },
    {
      box: '403', section: 'VENTAS', order: 2, kind: EDITABLE, format: MONEY, boxVerified: false,
      label: 'Ventas locales gravadas con tarifa 0% que NO dan derecho a crédito tributario',
      source: 'Reparto de la base tarifa 0% de las ventas del período (lo define el contador).',
      formula: '403 + 405 = base total tarifa 0% de las ventas',
      validations: { min: 0, maxBox: '_base0Total' },
      help: 'Por defecto TODA la base 0% se clasifica aquí. Mueva a 405 la parte que sí da derecho a crédito. La suma 403+405 no puede exceder la base 0% real: no se duplican totales.',
    },
    {
      box: '405', section: 'VENTAS', order: 3, kind: EDITABLE, format: MONEY, boxVerified: false,
      label: 'Ventas locales gravadas con tarifa 0% que SÍ dan derecho a crédito tributario',
      source: 'Reparto de la base tarifa 0% de las ventas del período (lo define el contador).',
      validations: { min: 0, maxBox: '_base0Total' },
      help: 'Aumenta el factor de proporcionalidad: estas ventas 0% permiten usar el IVA de compras como crédito.',
    },
    {
      box: '431', section: 'VENTAS', order: 4, kind: COMPUTED, format: MONEY, boxVerified: false,
      label: 'Transferencias no objeto de IVA',
      source: 'Base "no objeto" del desglose tributario de las facturas del período.',
    },
    {
      box: '434', section: 'VENTAS', order: 5, kind: COMPUTED, format: MONEY, boxVerified: false,
      label: 'Transferencias exentas de IVA',
      source: 'Base "exenta" del desglose tributario de las facturas del período.',
    },
    {
      box: '419', section: 'VENTAS', order: 6, kind: FORMULA, format: MONEY, boxVerified: false,
      label: 'Total ventas y otras operaciones',
      formula: '401 + 403 + 405 + 431 + 434',
    },
    {
      box: '499', section: 'VENTAS', order: 7, kind: COMPUTED, format: MONEY, boxVerified: false,
      label: 'IVA generado en ventas',
      source: 'IVA de las facturas autorizadas del período (cuenta IVA en ventas).',
    },

    // ── Compras
    {
      box: '500', section: 'COMPRAS', order: 1, kind: COMPUTED, format: MONEY, boxVerified: false,
      label: 'Adquisiciones gravadas tarifa diferente de 0% CON derecho a crédito tributario',
      source: 'Compras no anuladas del período marcadas como deducibles (base gravada).',
    },
    {
      box: '507', section: 'COMPRAS', order: 2, kind: COMPUTED, format: MONEY, boxVerified: false,
      label: 'Adquisiciones gravadas tarifa diferente de 0% SIN derecho a crédito tributario',
      source: 'Compras del período marcadas como NO deducibles (su IVA ya se cargó al gasto al registrarlas).',
    },
    {
      box: '517', section: 'COMPRAS', order: 3, kind: COMPUTED, format: MONEY, boxVerified: false,
      label: 'Adquisiciones gravadas tarifa 0%',
      source: 'Subtotal tarifa 0% de las compras del período.',
    },
    {
      box: '519', section: 'COMPRAS', order: 4, kind: COMPUTED, format: MONEY, boxVerified: false,
      label: 'Adquisiciones no objeto de IVA / exentas',
      source: 'Subtotales "no objeto" y "exento" de las compras del período.',
    },
    {
      box: '521', section: 'COMPRAS', order: 5, kind: FORMULA, format: MONEY, boxVerified: false,
      label: 'Total adquisiciones y pagos',
      formula: '500 + 507 + 517 + 519',
    },
    {
      box: '529', section: 'COMPRAS', order: 6, kind: COMPUTED, format: MONEY, boxVerified: false,
      label: 'IVA total pagado en compras del período',
      source: 'Suma del IVA de todas las compras no anuladas del período (deducibles y no deducibles).',
    },
    {
      box: '530', section: 'COMPRAS', order: 7, kind: COMPUTED, format: MONEY, boxVerified: false,
      label: 'IVA registrado como crédito tributario al comprar',
      source: 'Parte del IVA de compras que se contabilizó en la cuenta IVA en compras (activo). El resto ya fue al gasto.',
      help: 'Este es el IVA "disponible" que esta declaración puede usar o reclasificar al gasto. El IVA de compras no deducibles no está aquí: ya se cargó al gasto al registrar la compra.',
    },

    // ── Crédito tributario
    {
      box: '563', section: 'CREDITO', order: 1, kind: COMPUTED, format: 'PERCENT', boxVerified: false,
      label: 'Factor de proporcionalidad',
      formula: '(401 + 405) / (401 + 403 + 405)',
      source: 'Se calcula con las ventas del período: qué proporción da derecho a crédito.',
      help: 'Si TODAS las ventas dan derecho a crédito el factor es 1 y todo el IVA de compras es utilizable. Si hay ventas 0% sin derecho a crédito (casillero 403), el factor baja y parte del IVA se vuelve gasto. Con ventas en 0 el factor se toma como 1 (no hay proporción que aplicar).',
    },
    {
      box: '564', section: 'CREDITO', order: 2, kind: COMPUTED, format: MONEY, boxVerified: false,
      label: 'IVA utilizable como crédito tributario del período',
      formula: '530 − 565',
      source: 'IVA disponible menos el IVA que se envía al gasto.',
    },
    {
      box: '565', section: 'CREDITO', order: 3, kind: EDITABLE, format: MONEY, boxVerified: false,
      label: 'IVA que se carga al gasto (no deducible)',
      formula: 'Sugerido = 530 × (1 − factor de proporcionalidad)',
      source: 'Sugerencia del sistema; el contador puede ajustarlo.',
      validations: { min: 0, maxBox: '530' },
      help: 'No admite valores negativos ni mayores al IVA disponible (casillero 530). Al finalizar se reclasifica contra IVA en compras: DEBE «IVA al gasto» / HABER «IVA en compras». OJO: el sistema no distingue IVA de atribución directa vs. común, así que la sugerencia somete al factor TODO el IVA acreditable; ajuste este valor si su contador determina otra atribución.',
    },

    // ── Resumen impositivo
    {
      box: '601', section: 'RESUMEN', order: 1, kind: FORMULA, format: MONEY, boxVerified: false,
      label: 'Impuesto causado',
      formula: 'si (499 − 564) > 0 entonces 499 − 564; si no, 0',
    },
    {
      box: '602', section: 'RESUMEN', order: 2, kind: FORMULA, format: MONEY, boxVerified: false,
      label: 'Crédito tributario generado en el período',
      formula: 'si (564 − 499) > 0 entonces 564 − 499; si no, 0',
    },
    {
      box: '605', section: 'RESUMEN', order: 3, kind: EDITABLE, format: MONEY, boxVerified: false,
      label: '(−) Saldo de crédito tributario del mes anterior',
      source: 'Lo captura el contador (arrastre del período anterior).',
      validations: { min: 0 },
      help: 'Al finalizar se acredita la cuenta «Crédito tributario IVA», consumiendo el saldo a favor arrastrado.',
    },
    {
      box: '607', section: 'RESUMEN', order: 4, kind: COMPUTED, format: MONEY, boxVerified: false,
      label: '(−) Retenciones de IVA que le efectuaron',
      source: 'Retenciones de IVA recibidas (liquidaciones de tarjeta contabilizadas del período) → cuenta «Retención IVA por cobrar».',
    },
    {
      box: '609', section: 'RESUMEN', order: 5, kind: FORMULA, format: MONEY, boxVerified: false,
      label: 'Impuesto a pagar por IVA',
      formula: 'si (601 − 605 − 607) > 0 entonces 601 − 605 − 607; si no, 0',
    },
    {
      box: '615', section: 'RESUMEN', order: 6, kind: FORMULA, format: MONEY, boxVerified: false,
      label: 'Saldo de crédito tributario para el próximo mes',
      formula: 'si (601 − 605 − 607) < 0 entonces su valor absoluto; si no, 602 + 605 + 607 − 601',
      help: 'Saldo a favor: no genera deuda con el SRI. Al finalizar se debita la cuenta «Crédito tributario IVA» y se arrastra.',
    },

    // ── Agente de retención
    {
      box: '721', section: 'AGENTE', order: 1, kind: COMPUTED, format: MONEY, boxVerified: false,
      label: 'Retenciones de IVA efectuadas a proveedores (agente de retención)',
      source: 'Retenciones tipo IVA de las compras del período (cabecera, misma fuente que se contabilizó).',
      help: 'PENDIENTE DE CONFIRMAR con el contador: el sistema asume que estas retenciones se declaran y PAGAN junto con el 104. Al finalizar se debita «Retención IVA por pagar» y se suma a la obligación con el SRI.',
    },

    // ── Obligación
    {
      box: '902', section: 'PAGO', order: 1, kind: FORMULA, format: MONEY, boxVerified: false,
      label: 'Total a pagar al SRI',
      formula: '609 + 721',
      help: 'Genera la cuenta por pagar al SRI. NO afecta Banco: el banco se mueve solo cuando se paga la obligación.',
    },
  ],
};

// ──────────────────────── FORMULARIO 103 (Retenciones en la fuente) ────────────────────────
// Los casilleros de retenciones a proveedores son DINÁMICOS: uno por cada código de
// retención de renta usado en el período (el catálogo lo administra el contador en
// RetentionRule). Aquí solo se declaran los casilleros FIJOS.
const FORM_103 = {
  formType: '103',
  definitionVersion: '103-borrador-2026.1',
  title: 'Formulario 103 — Retenciones en la fuente del Impuesto a la Renta',
  verified: false,
  sections: [
    { key: 'DEPENDENCIA', order: 1, label: 'Retenciones en relación de dependencia' },
    { key: 'PROVEEDORES', order: 2, label: 'Retenciones a proveedores por código' },
    { key: 'NO_SUJETO', order: 3, label: 'Pagos y adquisiciones no sujetos a retención' },
    { key: 'PAGO', order: 4, label: 'Obligación con el SRI' },
  ],
  // Casillero laboral: la BASE está pendiente de confirmación (ver notas del módulo).
  dependencyBox: '302',
  cells: [
    {
      box: '302', section: 'DEPENDENCIA', order: 1, kind: COMPUTED, format: MONEY, boxVerified: false,
      label: 'En relación de dependencia que supera o no la base desgravada',
      source: 'Nóminas CERRADAS o PAGADAS del período. Base = ingresos GRAVADOS según el mapeo auditable de conceptos; valor retenido = impuesto a la renta descontado en el rol.',
      help: 'PENDIENTE DE CONFIRMAR con el contador: la base declarada aquí son los ingresos gravados. El sistema también calcula la base imponible neta (gravados − aporte personal IESS) y la muestra en la conciliación, por si el instructivo vigente exige esa otra base. No se aplica ninguna fórmula fija tipo "sueldo − 9,45%".',
    },
    {
      box: '332', section: 'NO_SUJETO', order: 1, kind: COMPUTED, format: MONEY, boxVerified: false,
      label: 'Pagos y adquisiciones no sujetos a retención',
      source: 'Compras no anuladas del período SIN ninguna retención de renta (base total del comprobante).',
      help: 'Se reportan las bases de los comprobantes sobre los que no se retuvo. Un mismo comprobante nunca aparece a la vez aquí y en un código de retención.',
    },
    {
      box: '399', section: 'PAGO', order: 1, kind: FORMULA, format: MONEY, boxVerified: false,
      label: 'Total de retenciones del período',
      formula: 'valor retenido en relación de dependencia + suma de las retenciones a proveedores por código',
      help: 'Genera la cuenta por pagar al SRI. NO afecta Banco.',
    },
  ],
};

const DEFINITIONS = { 104: FORM_104, 103: FORM_103 };

/** Definición vigente de un formulario. */
function getDefinition(formType) {
  const def = DEFINITIONS[String(formType)];
  if (!def) throw Object.assign(new Error(`Formulario no soportado: ${formType}`), { status: 400 });
  return def;
}

/** Casilleros que el contador puede capturar (los únicos que se aceptan al guardar). */
function editableBoxes(formType) {
  return getDefinition(formType).cells.filter((c) => c.kind === EDITABLE).map((c) => c.box);
}

function getCell(formType, box) {
  return getDefinition(formType).cells.find((c) => c.box === String(box)) || null;
}

/**
 * Valida un valor capturado contra las reglas declaradas del casillero.
 * `limits` resuelve los `maxBox` (topes que dependen de otros casilleros/valores
 * calculados, p. ej. el IVA disponible o la base 0% real de las ventas).
 * @returns {string|null} mensaje de error, o null si es válido
 */
function validateCell(formType, box, value, limits = {}) {
  const cell = getCell(formType, box);
  if (!cell) return `Casillero ${box} no existe en el formulario ${formType}.`;
  if (cell.kind !== EDITABLE) return `El casillero ${box} es calculado por el sistema y no se puede editar.`;
  const v = Number(value);
  if (!Number.isFinite(v)) return `El casillero ${box} debe ser un número.`;
  const rules = cell.validations || {};
  if (rules.min != null && v < rules.min) return `El casillero ${box} (${cell.label}) no admite valores menores a ${rules.min}.`;
  if (rules.max != null && v > rules.max) return `El casillero ${box} (${cell.label}) no puede superar ${rules.max}.`;
  if (rules.maxBox != null) {
    const limit = Number(limits[rules.maxBox]);
    if (Number.isFinite(limit) && v > limit + 0.005) {
      return `El casillero ${box} (${cell.label}) no puede superar ${limit.toFixed(2)}.`;
    }
  }
  return null;
}

module.exports = {
  DEFINITIONS,
  FORM_103,
  FORM_104,
  XML_DISCLAIMER,
  getDefinition,
  getCell,
  editableBoxes,
  validateCell,
  KINDS: { COMPUTED, EDITABLE, FORMULA },
};
