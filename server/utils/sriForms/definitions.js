/**
 * DEFINICIÓN DECLARATIVA Y VERSIONADA DE LOS CASILLEROS (Formularios SRI 103 y 104).
 *
 * La estructura del formulario NO vive en el JSX: vive aquí. La pantalla se dibuja
 * recorriendo `sections` + `cells`, y el backend valida y calcula contra la misma
 * definición. Cambiar el formulario = publicar una nueva versión en este archivo.
 *
 * ─────────────────────────── ESTADO DE VERIFICACIÓN ───────────────────────────
 * Formulario 104 (v `104-borrador-2026.3`): la numeración y las etiquetas de la sección de
 * ADQUISICIONES y de la de VENTAS se corrigieron contra el formulario 104 OFICIAL que mostró
 * la contadora (formato de 3 columnas: Valor Bruto / Valor Neto = Bruto − N/C / Impuesto
 * Generado). Esos casilleros van con `boxVerified: true`. Lo que sigue SIN confirmar contra el
 * formulario oficial es la sección de crédito/resumen/pago (factor, IVA utilizable, impuesto a
 * pagar, retenciones de agente): esos casilleros quedan `boxVerified: false`. Por eso el
 * formulario como conjunto se mantiene `verified: false` hasta contrastar TODO contra el
 * PDF/XML real (cuando la contadora los entregue en docs/).
 *
 *   - La salida XML es un BORRADOR TÉCNICO. NO es el XML oficial, NO es un archivo DIMM y
 *     NO está listo para subir al SRI. Ver `XML_DISCLAIMER`.
 *   - Los IMPORTES son auditables: salen de las ventas/compras/nóminas del período y de las
 *     conciliaciones. Cada compra se clasifica por tipo de comprobante × tarifa × derecho a
 *     crédito × activo fijo, y las notas de crédito se restan de la base de su misma tarifa.
 *
 * Validación externa pendiente (para el contador):
 *   1. Confirmar la sección de crédito tributario / resumen / pago del 104 (casilleros
 *      530/563/564/565/601/602/605/607/609/615/721/902) contra el instructivo vigente.
 *   2. Confirmar la base del casillero laboral del 103 (ingresos gravados vs. base imponible
 *      neta de aporte personal IESS).
 *   3. Confirmar si la retención de IVA efectuada como agente se declara y paga con el 104.
 *   4. Obtener el XSD del XML de importación para reemplazar el borrador técnico.
 *   5. ATRIBUCIÓN DEL IVA DE COMPRAS (limitación conocida). La compra solo distingue
 *      «deducible» de «no deducible»; NO registra si el IVA es de atribución DIRECTA a ventas
 *      con derecho, directa a ventas sin derecho, o COMÚN (el único que debería someterse al
 *      factor). El sistema trata todo el IVA acreditable como COMÚN, lo advierte y deja el
 *      casillero de IVA al gasto editable para que el contador ajuste.
 *   6. IMPORTACIONES (casilleros 503-506/513-516/523-525) y TARIFA 5% (540/550/560): el
 *      registro de compras aún no marca importaciones ni tarifa 5% a nivel de cabecera, así
 *      que hoy se alimentan desde las líneas (5%) o quedan en 0 (importaciones), pero se
 *      muestran para que el formulario sea la réplica completa.
 *
 * Estructura de un casillero:
 *   box          número de casillero (string)
 *   section      clave de la sección
 *   order        orden dentro de la sección
 *   rowKey/col   agrupación del formato oficial de 3 columnas (BRUTO | NETO | IVA) para dibujar
 *                bruto/neto/impuesto de un mismo concepto en la misma fila (solo secciones GRID3)
 *   label        etiqueta visible del concepto
 *   source       origen del dato (texto auditable)
 *   formula      fórmula legible (los cálculos reales viven en compute103/compute104)
 *   kind         COMPUTED | EDITABLE | FORMULA
 *   validations  { min, max, maxBox, integer }
 *   format       MONEY | PERCENT | NUMBER
 *   help         instrucción/tooltip
 *   boxVerified  ¿el número de casillero está confirmado contra el formulario oficial vigente?
 */

const XML_DISCLAIMER =
  'BORRADOR TÉCNICO generado por el sistema. NO es el XML oficial del SRI, NO es un ' +
  'archivo DIMM y NO está listo para cargar. Falta validar la estructura contra la ' +
  'definición (XSD) vigente del SRI. Úselo solo para revisión y respaldo interno.';

const MONEY = 'MONEY';
const COMPUTED = 'COMPUTED';
const EDITABLE = 'EDITABLE';
const FORMULA = 'FORMULA';

/**
 * Construye los casilleros de una fila del formato oficial de 3 columnas (Valor Bruto /
 * Valor Neto / Impuesto Generado). Cada fila comparte `rowKey` y etiqueta; cada columna es
 * un casillero propio (`col`). Columnas ausentes (null) no se generan.
 */
function gridRows(section, rows) {
  const out = [];
  rows.forEach((r, i) => {
    const order = i + 1;
    const common = { section, order, rowKey: r.key, rowLabel: r.label, boxVerified: r.boxVerified !== false };
    const totalKind = r.total ? FORMULA : COMPUTED;
    if (r.bruto != null) {
      out.push({
        ...common, box: String(r.bruto), col: 'BRUTO', format: MONEY,
        kind: r.editable ? EDITABLE : totalKind,
        label: r.label,
        ...(r.source ? { source: r.source } : {}),
        ...(r.help ? { help: r.help } : {}),
        ...(r.formula ? { formula: r.formula } : {}),
        ...(r.editable && r.brutoValidations ? { validations: r.brutoValidations } : {}),
      });
    }
    if (r.neto != null) {
      out.push({ ...common, box: String(r.neto), col: 'NETO', kind: totalKind, format: MONEY, label: r.label });
    }
    if (r.iva != null) {
      out.push({ ...common, box: String(r.iva), col: 'IVA', kind: totalKind, format: MONEY, label: r.label });
    }
  });
  return out;
}

// ─────────────────────────────── FORMULARIO 104 (IVA) ───────────────────────────────
//
// Numeración CONFIRMADA contra el formulario oficial que mostró la contadora (formato de 3
// columnas Bruto / Neto = Bruto − N/C / Impuesto). Adquisiciones:
//   500/510/520  gravadas ≠0% con derecho (excluye activos fijos)
//   501/511/521  activos fijos gravados ≠0% con derecho
//   540/550/560  gravadas 5% con derecho
//   502/512/522  otras gravadas ≠0% SIN derecho
//   503/513/523  importaciones de servicios/derechos ≠0%
//   504/514/524  importaciones de bienes (excluye AF) ≠0%
//   505/515/525  importaciones de activos fijos ≠0%
//   526/527      IVA por diferencia adquisiciones vs. NC de distinta tarifa (ajuste ±)
//   506/516      importaciones de bienes (incluye AF) 0%
//   507/517      adquisiciones (incluye AF) 0%
//   508/518      RISE / negocios populares
//   509/519/529  TOTAL adquisiciones y pagos (bruto/neto/IVA)
//   531/541      no objeto de IVA · 532/542 exentas
//   543          NC 0% por compensar próximo mes · 544/554 NC ≠0% por compensar
// Ventas: 401/411/421 gravadas ≠0%, 403/413 0% sin derecho, 405/415 0% con derecho,
//   431/441 no objeto, 434/444 exentas, 409/419/429 TOTAL.
//
const FORM_104 = {
  formType: '104',
  definitionVersion: '104-borrador-2026.3',
  title: 'Formulario 104 — Declaración del Impuesto al Valor Agregado',
  verified: false,
  sections: [
    { key: 'VENTAS', order: 1, label: 'Ventas y otras operaciones del período', layout: 'GRID3' },
    { key: 'COMPRAS', order: 2, label: 'Adquisiciones y pagos del período', layout: 'GRID3' },
    { key: 'CREDITO', order: 3, label: 'Factor de proporcionalidad y crédito tributario' },
    { key: 'RESUMEN', order: 4, label: 'Resumen impositivo' },
    { key: 'AGENTE', order: 5, label: 'Retenciones de IVA efectuadas como agente' },
    { key: 'PAGO', order: 6, label: 'Obligación con el SRI' },
  ],
  cells: [
    // ── Ventas (formato oficial de 3 columnas: Bruto / Neto = Bruto − N/C / Impuesto)
    ...gridRows('VENTAS', [
      {
        key: 'v_gravada', bruto: 401, neto: 411, iva: 421,
        label: 'Ventas locales (excluye activos fijos) gravadas tarifa diferente de 0%',
        source: 'Facturas de venta AUTORIZADAS del período. Bruto = base gravada; Neto = bruto − notas de crédito de ventas gravadas; IVA sobre el neto.',
        help: 'Solo entran facturas electrónicas autorizadas. Las ventas sin autorizar no se declaran.',
      },
      {
        key: 'v_0sin', bruto: 403, neto: 413, editable: true,
        label: 'Ventas locales gravadas tarifa 0% que NO dan derecho a crédito tributario',
        source: 'Reparto de la base tarifa 0% de las ventas (bruto); lo define el contador. Neto = bruto − notas de crédito 0%.',
        formula: '403 + 405 = base total tarifa 0% de las ventas (bruto)',
        brutoValidations: { min: 0, maxBox: '_base0Bruto' },
        help: 'Por defecto TODA la base 0% se clasifica aquí. Mueva a 405 la parte que sí da derecho a crédito. La suma 403+405 no puede exceder la base 0% real.',
      },
      {
        key: 'v_0con', bruto: 405, neto: 415, editable: true,
        label: 'Ventas locales gravadas tarifa 0% que SÍ dan derecho a crédito tributario',
        source: 'Reparto de la base tarifa 0% de las ventas (bruto); lo define el contador. Neto = bruto − notas de crédito 0%.',
        brutoValidations: { min: 0, maxBox: '_base0Bruto' },
        help: 'Aumenta el factor de proporcionalidad: estas ventas 0% permiten usar el IVA de compras como crédito.',
      },
      {
        key: 'v_noobj', bruto: 431, neto: 441, boxVerified: false,
        label: 'Transferencias no objeto de IVA',
        source: 'Base "no objeto" del desglose tributario de las facturas del período.',
      },
      {
        key: 'v_exento', bruto: 434, neto: 444, boxVerified: false,
        label: 'Transferencias exentas de IVA',
        source: 'Base "exenta" del desglose tributario de las facturas del período.',
      },
      {
        key: 'v_total', bruto: 409, neto: 419, iva: 429, total: true,
        label: 'TOTAL VENTAS Y OTRAS OPERACIONES',
        formula: 'Bruto 409 = 401+403+405+431+434 · Neto 419 = 411+413+415+441+444 · IVA 429 = 421',
      },
    ]),

    // ── Adquisiciones y pagos (formato oficial de 3 columnas)
    ...gridRows('COMPRAS', [
      {
        key: 'c_gravCon', bruto: 500, neto: 510, iva: 520,
        label: 'Adquisiciones y pagos (excluye activos fijos) gravados tarifa diferente de 0% (con derecho a crédito tributario)',
        source: 'Facturas de compra deducibles del período, líneas NO de activo fijo, gravadas ≠0%. Neto = bruto − notas de crédito de compras gravadas.',
      },
      {
        key: 'c_afCon', bruto: 501, neto: 511, iva: 521,
        label: 'Adquisiciones locales de activos fijos gravados tarifa diferente de 0% (con derecho a crédito tributario)',
        source: 'Líneas de la compra marcadas como ACTIVO_FIJO (lineType), gravadas ≠0%, deducibles.',
      },
      {
        key: 'c_grav5', bruto: 540, neto: 550, iva: 560,
        label: 'Adquisiciones y pagos (excluye activos fijos) gravados tarifa 5% (con derecho a crédito tributario)',
        source: 'Líneas de compra con tarifa 5% (ivaRate = 5), deducibles. Hoy suele ser 0: el registro no discrimina 5% en cabecera.',
      },
      {
        key: 'c_gravSin', bruto: 502, neto: 512, iva: 522,
        label: 'Otras adquisiciones y pagos gravados tarifa diferente de 0% (sin derecho a crédito tributario)',
        source: 'Compras marcadas como NO deducibles, gravadas ≠0%. Su IVA ya se cargó al gasto al registrarlas: no es crédito.',
        help: 'Aquí también cae la "compra en feriado tarifa distinta de 0 sin derecho a crédito".',
      },
      {
        key: 'c_impServ', bruto: 503, neto: 513, iva: 523,
        label: 'Importaciones de servicios y/o derechos gravados tarifa diferente de 0%',
        source: 'Placeholder: el registro de compras aún no marca importaciones. Hoy queda en 0.',
      },
      {
        key: 'c_impBien', bruto: 504, neto: 514, iva: 524,
        label: 'Importaciones de bienes (excluye activos fijos) gravados tarifa diferente de 0%',
        source: 'Placeholder: el registro de compras aún no marca importaciones. Hoy queda en 0.',
      },
      {
        key: 'c_impAf', bruto: 505, neto: 515, iva: 525,
        label: 'Importaciones de activos fijos gravados tarifa diferente de 0%',
        source: 'Placeholder: el registro de compras aún no marca importaciones. Hoy queda en 0.',
      },
      {
        key: 'c_ajustePos', iva: 526,
        label: 'IVA generado en la diferencia entre adquisiciones y notas de crédito con distinta tarifa (ajuste positivo al crédito tributario)',
        source: 'Ajuste manual cuando una nota de crédito tiene distinta tarifa que la adquisición que modifica. Hoy 0: las NC se restan de la base de su misma tarifa.',
      },
      {
        key: 'c_ajusteNeg', iva: 527,
        label: 'IVA generado en la diferencia entre adquisiciones y notas de crédito con distinta tarifa (ajuste negativo al crédito tributario)',
        source: 'Ajuste manual (contraparte del 526). Hoy 0.',
      },
      {
        key: 'c_imp0', bruto: 506, neto: 516,
        label: 'Importaciones de bienes (incluye activos fijos) gravados tarifa 0%',
        source: 'Placeholder: el registro de compras aún no marca importaciones. Hoy queda en 0.',
      },
      {
        key: 'c_local0', bruto: 507, neto: 517,
        label: 'Adquisiciones y pagos (incluye activos fijos) gravados tarifa 0%',
        source: 'Compras locales del período con tarifa 0% (subtotal0), deducibles o no. Neto = bruto − notas de crédito 0% de compras.',
      },
      {
        key: 'c_rise', bruto: 508, neto: 518,
        label: 'Adquisiciones a contribuyentes RISE / negocios populares',
        source: 'Compras cuyo comprobante es NOTA DE VENTA (docType NOTA_VENTA). Toda su base va aquí.',
      },
      {
        key: 'c_total', bruto: 509, neto: 519, iva: 529, total: true,
        label: 'TOTAL ADQUISICIONES Y PAGOS',
        formula: 'Suma de 500–508 y 540 (no incluye no objeto/exentas). Neto 519 = Σ netos · IVA 529 = Σ IVA',
      },
      {
        key: 'c_noobj', bruto: 531, neto: 541,
        label: 'Adquisiciones no objeto de IVA',
        source: 'Subtotal "no objeto" de las compras del período.',
      },
      {
        key: 'c_exento', bruto: 532, neto: 542,
        label: 'Adquisiciones exentas del pago de IVA',
        source: 'Subtotal "exento" de las compras del período.',
      },
      {
        key: 'c_nc0comp', neto: 543,
        label: 'Notas de crédito tarifa 0% por compensar el próximo mes',
        source: 'Exceso de notas de crédito 0% de compras que supera las adquisiciones 0% del período (se compensa el mes siguiente).',
      },
      {
        key: 'c_ncGravComp', neto: 544, iva: 554,
        label: 'Notas de crédito tarifa diferente de 0% por compensar el próximo mes',
        source: 'Exceso de notas de crédito gravadas de compras que supera las adquisiciones gravadas con derecho del período (base 544 e IVA 554).',
      },
    ]),

    // ── Crédito tributario (sección PENDIENTE de confirmar contra el formulario oficial)
    {
      box: '530', section: 'CREDITO', order: 1, kind: COMPUTED, format: MONEY, boxVerified: false,
      label: 'IVA en compras con derecho a crédito tributario (disponible)',
      formula: '530 = 520 + 521 + 560 + 523 + 524 + 525 (IVA de las filas con derecho, neto de NC)',
      source: 'IVA de las adquisiciones con derecho a crédito, neto de notas de crédito. Es el IVA disponible que esta declaración puede usar o reclasificar al gasto.',
      help: 'El IVA de compras no deducibles NO está aquí: ya se cargó al gasto al registrar la compra.',
    },
    {
      box: '563', section: 'CREDITO', order: 2, kind: COMPUTED, format: 'PERCENT', boxVerified: false,
      label: 'Factor de proporcionalidad',
      formula: '(411 + 415) / (411 + 413 + 415)',
      source: 'Se calcula con las ventas del período (netas de NC): qué proporción da derecho a crédito.',
      help: 'Si TODAS las ventas dan derecho a crédito el factor es 1. Si hay ventas 0% sin derecho (413), el factor baja y parte del IVA se vuelve gasto. Con ventas en 0 el factor se toma como 1.',
    },
    {
      box: '564', section: 'CREDITO', order: 3, kind: COMPUTED, format: MONEY, boxVerified: false,
      label: 'IVA utilizable como crédito tributario del período',
      formula: '530 − 565',
      source: 'IVA disponible menos el IVA que se envía al gasto.',
    },
    {
      box: '565', section: 'CREDITO', order: 4, kind: EDITABLE, format: MONEY, boxVerified: false,
      label: 'IVA que se carga al gasto (no deducible por proporcionalidad)',
      formula: 'Sugerido = 530 × (1 − factor de proporcionalidad)',
      source: 'Sugerencia del sistema; el contador puede ajustarlo.',
      validations: { min: 0, maxBox: '530' },
      help: 'No admite valores negativos ni mayores al IVA disponible (casillero 530). Al finalizar se reclasifica contra IVA en compras: DEBE «IVA al gasto» / HABER «IVA en compras».',
    },

    // ── Resumen impositivo (PENDIENTE de confirmar contra el formulario oficial)
    {
      box: '601', section: 'RESUMEN', order: 1, kind: FORMULA, format: MONEY, boxVerified: false,
      label: 'Impuesto causado',
      formula: 'si (429 − 564) > 0 entonces 429 − 564; si no, 0',
    },
    {
      box: '602', section: 'RESUMEN', order: 2, kind: FORMULA, format: MONEY, boxVerified: false,
      label: 'Crédito tributario generado en el período',
      formula: 'si (564 − 429) > 0 entonces 564 − 429; si no, 0',
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

    // ── Agente de retención (PENDIENTE de confirmar)
    {
      box: '721', section: 'AGENTE', order: 1, kind: COMPUTED, format: MONEY, boxVerified: false,
      label: 'Retenciones de IVA efectuadas a proveedores (agente de retención)',
      source: 'Retenciones tipo IVA de las compras del período (cabecera, misma fuente que se contabilizó).',
      help: 'PENDIENTE DE CONFIRMAR: el sistema asume que estas retenciones se declaran y PAGAN junto con el 104. Al finalizar se debita «Retención IVA por pagar» y se suma a la obligación con el SRI.',
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
