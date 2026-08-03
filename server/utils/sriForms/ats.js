/**
 * ATS — ANEXO TRANSACCIONAL SIMPLIFICADO (SRI Ecuador).
 *
 * Es el anexo MENSUAL que acompaña al 103 y al 104: el detalle de todas las transacciones del
 * mes (compras recibidas, ventas emitidas, retenciones practicadas, notas de crédito/débito y
 * comprobantes anulados). El SRI lo valida contra un XSD, así que el ORDEN de los elementos y
 * los nombres importan: un nodo fuera de sitio invalida el archivo entero.
 *
 * Referencias:
 *   · Esquema:      https://descargas.sri.gob.ec/download/anexos/ats/ats.xsd
 *   · Ficha técnica: SRI — «Ficha técnica Anexo Transaccional Simplificado»
 *
 * ── Qué construye este módulo ────────────────────────────────────────────────────────────
 *   buildAts()  → estructura de datos completa (la consumen la pantalla, el Excel y el XML)
 *   atsXml()    → XML en el orden EXACTO del XSD
 *
 * Una sola fuente para los tres: si la pantalla y el archivo se calcularan por separado,
 * cuadrarían distinto y el contador no tendría forma de saber cuál creer.
 *
 * ── Decisiones que conviene conocer ──────────────────────────────────────────────────────
 * · COMPRAS: una fila por comprobante recibido (el ATS las pide al detalle, no agrupadas).
 * · VENTAS: agrupadas por (identificación del cliente, tipo de comprobante, tipo de emisión),
 *   que es como las exige el ATS. Consumidor final se agrupa bajo 9999999999999.
 * · Solo entran ventas con factura electrónica AUTORIZADA: lo demás no existe para el SRI.
 * · ANULADOS: se declaran por rango de secuenciales; aquí va una fila por comprobante anulado
 *   (secuencialInicio = secuencialFin), que es válido y evita agrupar rangos con huecos.
 * · Los importes van SIEMPRE positivos y con 2 decimales, como exige la ficha técnica.
 */

const { purchaseFiscalDate, invoiceFiscalDate, inRange } = require('../reportDateRange');

const r2 = (n) => +(Number(n) || 0).toFixed(2);
const m2 = (n) => r2(Math.abs(Number(n) || 0)).toFixed(2);   // monto: positivo, 2 decimales

/** Fecha en el formato del ATS: DD/MM/AAAA. */
function atsDate(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/**
 * TABLA 2 del SRI — tipo de identificación del PROVEEDOR:
 *   01 RUC · 02 Cédula · 03 Pasaporte
 * Se deduce de la longitud cuando el proveedor no lo tiene declarado: 13 dígitos ⇒ RUC,
 * 10 dígitos ⇒ cédula, cualquier otra cosa ⇒ pasaporte. Adivinar mal aquí es el error #1
 * que hace rebotar el anexo.
 */
function tpIdProv(supplier) {
  const id = String(supplier?.ruc || '').trim();
  const declarado = String(supplier?.tipoIdentificacion || '').toUpperCase();
  if (declarado === 'RUC') return '01';
  if (declarado === 'CEDULA') return '02';
  if (declarado === 'PASAPORTE') return '03';
  if (/^\d{13}$/.test(id)) return '01';
  if (/^\d{10}$/.test(id)) return '02';
  return '03';
}

/**
 * TABLA 2 del SRI — tipo de identificación del CLIENTE en VENTAS:
 *   04 RUC · 05 Cédula · 06 Pasaporte · 07 Consumidor final · 08 Identificación del exterior
 * Ojo: los códigos de ventas NO son los de compras (01/02/03). Confundirlos invalida el anexo.
 */
const CONSUMIDOR_FINAL = '9999999999999';
function tpIdCliente(identificacion, tipoDeclarado) {
  const id = String(identificacion || '').trim();
  if (!id || id === CONSUMIDOR_FINAL) return '07';
  // La factura electrónica usa la tabla de comprobantes (04 RUC, 05 cédula, 06 pasaporte…),
  // que aquí coincide: si viene declarada y es válida, manda.
  if (['04', '05', '06', '07', '08'].includes(String(tipoDeclarado))) return String(tipoDeclarado);
  if (/^\d{13}$/.test(id)) return '04';
  if (/^\d{10}$/.test(id)) return '05';
  return '06';
}

/** TABLA 4 del SRI — tipo de comprobante. */
const TIPO_COMPROBANTE = {
  FACTURA: '01',
  NOTA_VENTA: '02',
  LIQUIDACION: '03',
  NOTA_CREDITO_REC: '04',
  NOTA_DEBITO_REC: '05',
  GUIA_REMISION: '06',
  COMPROBANTE_RETENCION: '07',
  BOLETO_ESPECTACULO: '15',
  FACTURA_ELECTRONICA_VENTA: '18',   // ventas: factura (esquema offline)
  NOTA_CREDITO_EMITIDA: '04',
  NOTA_DEBITO_EMITIDA: '05',
};

/**
 * TABLA 5 del SRI — código de SUSTENTO del comprobante de compra.
 * El más frecuente en una clínica es el 01 (crédito tributario de IVA). Cuando la compra no
 * da derecho a crédito se declara 02 (costo o gasto). Se deduce de lo que YA decidió la
 * contabilidad al registrar la compra (`deductible`, IVA con/sin crédito): no se pregunta de
 * nuevo ni se inventa, porque tiene que cuadrar con el 104.
 */
function codSustento(p) {
  if (p.docType === 'NOTA_CREDITO_REC' || p.docType === 'NOTA_DEBITO_REC') {
    // Las notas heredan el sustento del documento que modifican; 01 es el caso general.
    return '01';
  }
  const conCredito = Number(p.vatCreditAmount || 0) > 0;
  const gravada = Number(p.subtotal5 || 0) + Number(p.subtotal12 || 0) + Number(p.subtotal15 || 0);
  if (gravada > 0 && conCredito) return '01';   // crédito tributario de IVA
  return '02';                                   // costo o gasto
}

/**
 * TABLA 24 del SRI — forma de pago. Se declara obligatoriamente cuando el comprobante supera
 * el umbral de bancarización; el sistema la declara siempre que la conozca.
 *   01 sin utilización del sistema financiero · 15 compensación de deudas · 16 tarjeta de débito
 *   17 dinero electrónico · 18 tarjeta prepago · 19 tarjeta de crédito · 20 otros con sistema financiero
 *   21 endoso de títulos
 */
const FORMA_PAGO = {
  EFECTIVO: '01',
  efectivo: '01',
  TRANSFERENCIA: '20',
  transferencia: '20',
  DEPOSITO: '20',
  CHEQUE: '20',
  TARJETA: '19',
  tarjeta: '19',
  TARJETA_DEBITO: '16',
  TARJETA_CREDITO: '19',
  credito: '01',
  OTRO: '01',
};
const formaPagoOf = (v, fallback = '01') => FORMA_PAGO[v] || (/^\d{2}$/.test(String(v || '')) ? String(v) : fallback);

/**
 * Establecimiento / punto de emisión / secuencial de un comprobante.
 *
 * No todos los documentos los tienen desglosados: los importados y algunos editados guardan
 * solo la `serie` ("001-001-000000123"). El ATS exige los TRES campos por separado, así que
 * se derivan de la serie cuando faltan. Sin esto, esas compras salían con secuencial vacío y
 * el SRI rechazaba el anexo entero sin decir cuál era.
 */
function splitSerie(doc) {
  const partes = String(doc.serie || '').split('-').map((s) => s.trim());
  const estab = String(doc.estab || partes[0] || '001').replace(/\D/g, '') || '001';
  const ptoEmi = String(doc.ptoEmi || partes[1] || '001').replace(/\D/g, '') || '001';
  const secuencial = String(doc.secuencial || partes[2] || '').replace(/\D/g, '');
  return {
    estab: estab.padStart(3, '0').slice(-3),
    ptoEmi: ptoEmi.padStart(3, '0').slice(-3),
    secuencial: secuencial ? secuencial.padStart(9, '0').slice(-9) : '',
  };
}

/** Escapado XML. */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * Construye el ATS del período.
 *
 * @param {object} args
 * @param {*}      args.clinicId
 * @param {object} args.range   { start, end, year, month, label }
 * @param {object} args.models  { Invoice, PurchaseInvoice, Clinic, RetentionVoucher, CreditDebitNote, InvoicingConfig }
 * @returns {Promise<object>} estructura completa del ATS
 */
async function buildAts({ clinicId, range, models }) {
  const { Invoice, PurchaseInvoice, Clinic, RetentionVoucher, InvoicingConfig } = models;

  const [clinic, config] = await Promise.all([
    Clinic.findById(clinicId).lean(),
    InvoicingConfig ? InvoicingConfig.findOne({ clinic: clinicId }).lean() : null,
  ]);

  // ── Informante ────────────────────────────────────────────────────────────
  const ruc = String(config?.ruc || clinic?.ruc || '').trim();
  const informante = {
    tipoId: 'R',                                   // R = RUC (único valor para el informante)
    ruc,
    razonSocial: config?.razonSocial || clinic?.razonSocial || clinic?.name || '',
    anio: String(range.year),
    mes: String(range.month).padStart(2, '0'),
    numEstabRuc: String(config?.establecimiento || '001').padStart(3, '0'),
    codigoOperativo: 'IVA',
    // Régimen: el ATS pide marcar microempresa cuando aplica. Se declara solo si está
    // configurado; NO se deduce de los ingresos (es una calificación del SRI, no un cálculo).
    regimenMicroempresa: config?.regimenMicroempresa === true ? 'SI' : null,
  };

  // ── COMPRAS ───────────────────────────────────────────────────────────────
  // Una fila por comprobante recibido, con su detalle de retenciones y el comprobante de
  // retención emitido (el SRI cruza ese número contra el 103).
  const comprasDocs = await PurchaseInvoice.find({
    clinic: clinicId,
    status: { $nin: ['ANULADA', 'POR_AUTORIZAR'] },
  }).populate('supplier', 'ruc razonSocial tipoIdentificacion').lean();

  const comprasPeriodo = comprasDocs.filter((p) => inRange(purchaseFiscalDate(p), range.start, range.end));

  // Comprobantes de retención emitidos, indexados por compra: aportan estab/pto/secuencial/
  // autorización/fecha, que son campos del nodo de compras del ATS.
  const vouchers = RetentionVoucher
    ? await RetentionVoucher.find({
      clinic: clinicId,
      purchaseInvoice: { $in: comprasPeriodo.map((p) => p._id) },
      estado: { $nin: ['ANULADA'] },
    }).lean()
    : [];
  const voucherByPurchase = new Map(vouchers.map((v) => [String(v.purchaseInvoice), v]));

  const compras = comprasPeriodo.map((p) => {
    const sup = p.supplier || {};
    const rets = p.retentions || [];
    const retIva = r2(rets.filter((x) => x.type === 'IVA').reduce((s, x) => s + (x.amount || 0), 0));
    const airs = rets
      .filter((x) => x.type === 'RENTA' && Number(x.amount || 0) > 0)
      .map((x) => ({
        codRetAir: String(x.code || ''),
        baseImpAir: r2(x.baseAmount),
        porcentajeAir: r2(x.percentage),
        valRetAir: r2(x.amount),
      }));
    const retRenta = r2(airs.reduce((s, x) => s + x.valRetAir, 0));
    const v = voucherByPurchase.get(String(p._id));
    const fecha = purchaseFiscalDate(p);
    const num = splitSerie(p);

    return {
      _id: String(p._id),
      codSustento: codSustento(p),
      tpIdProv: tpIdProv(sup),
      idProv: String(sup.ruc || '').trim(),
      denoProv: sup.razonSocial || '',
      tipoComprobante: TIPO_COMPROBANTE[p.docType] || TIPO_COMPROBANTE.FACTURA,
      parteRel: 'NO',
      fechaRegistro: atsDate(p.fechaRegistro || fecha),
      establecimiento: num.estab,
      puntoEmision: num.ptoEmi,
      secuencial: num.secuencial,
      fechaEmision: atsDate(fecha),
      autorizacion: String(p.autorizacion || p.claveAcceso || '').trim(),
      // Bases: el ATS separa "no grava IVA", "tarifa 0", "gravada" y "exenta".
      baseNoGraIva: r2(p.subtotalNoObjeto),
      baseImponible: r2(p.subtotal0),                                     // tarifa 0 %
      baseImpGrav: r2(Number(p.subtotal5 || 0) + Number(p.subtotal12 || 0) + Number(p.subtotal15 || 0)),
      baseImpExe: r2(p.subtotalExento),
      montoIce: r2(p.ice),
      montoIva: r2(p.iva),
      // Retención de IVA: el ATS la desglosa por porcentaje. Se ubica en el tramo que
      // corresponde al porcentaje efectivamente retenido sobre el IVA.
      ...splitRetIva(rets),
      valorRetBienes: 0,
      valorRetServicios: 0,
      valRetServ100: retIva,
      totbasesImpReemb: 0,
      pagoLocExt: '01',                 // 01 = pago a residente (local)
      formasDePago: [formaPagoOf(p.paymentMethodSri)],
      air: airs,
      // Comprobante de retención emitido por esta compra (lo cruza el SRI con el 103).
      estabRetencion1: v ? String(v.estab || '').padStart(3, '0') : '',
      ptoEmiRetencion1: v ? String(v.ptoEmi || '').padStart(3, '0') : '',
      secRetencion1: v ? String(v.secuencial || '').padStart(9, '0') : '',
      autRetencion1: v ? String(v.numeroAutorizacion || v.claveAcceso || '') : '',
      fechaEmiRet1: v ? atsDate(v.fechaEmision) : '',
      // Campos de apoyo para la pantalla y el Excel (NO van al XML).
      _serie: p.serie || [p.estab, p.ptoEmi, p.secuencial].filter(Boolean).join('-'),
      _proveedor: sup.razonSocial || '',
      _total: r2(p.total),
      _retIva: retIva,
      _retRenta: retRenta,
      _retencionNumero: v ? `${v.estab}-${v.ptoEmi}-${v.secuencial}` : '',
    };
  });

  // ── VENTAS ────────────────────────────────────────────────────────────────
  // Agrupadas por cliente + tipo de comprobante + tipo de emisión, que es la unidad del ATS.
  const facturas = (await Invoice.find({ clinic: clinicId, estado: 'AUTORIZADO' }).lean())
    .filter((inv) => inRange(invoiceFiscalDate(inv), range.start, range.end));

  const ventasMap = new Map();
  for (const inv of facturas) {
    const id = String(inv.identificacionComprador || '').trim() || CONSUMIDOR_FINAL;
    const tipoId = tpIdCliente(id, inv.tipoIdentificacionComprador);
    const key = `${tipoId}|${id}|${TIPO_COMPROBANTE.FACTURA_ELECTRONICA_VENTA}|E`;
    if (!ventasMap.has(key)) {
      ventasMap.set(key, {
        tpIdCliente: tipoId,
        idCliente: id,
        parteRelVtas: 'NO',
        denoCli: inv.razonSocialComprador || 'CONSUMIDOR FINAL',
        tipoComprobante: TIPO_COMPROBANTE.FACTURA_ELECTRONICA_VENTA,
        tipoEmision: 'E',                       // E = electrónica
        numeroComprobantes: 0,
        baseNoGraIva: 0,
        baseImponible: 0,      // tarifa 0 %
        baseImpGrav: 0,        // gravada
        montoIva: 0,
        montoIce: 0,
        valorRetIva: 0,
        valorRetRenta: 0,
        formasDePago: new Set(),
        _total: 0,
      });
    }
    const g = ventasMap.get(key);
    const tb = breakdownOf(inv);
    g.numeroComprobantes += 1;
    g.baseNoGraIva += tb.baseNoObjeto;
    g.baseImponible += tb.base0 + tb.baseExento;
    g.baseImpGrav += tb.baseGravada;
    g.montoIva += tb.iva;
    g._total += Number(inv.importeTotal || 0);
    g.formasDePago.add(formaPagoOf(inv.formaPago));
  }

  const ventas = [...ventasMap.values()].map((g) => ({
    ...g,
    baseNoGraIva: r2(g.baseNoGraIva),
    baseImponible: r2(g.baseImponible),
    baseImpGrav: r2(g.baseImpGrav),
    montoIva: r2(g.montoIva),
    _total: r2(g._total),
    formasDePago: [...g.formasDePago],
  })).sort((a, b) => a.idCliente.localeCompare(b.idCliente));

  // ── VENTAS POR ESTABLECIMIENTO ────────────────────────────────────────────
  // El ATS pide el total facturado por cada establecimiento del RUC.
  const porEstab = new Map();
  for (const inv of facturas) {
    const cod = String(inv.estab || informante.numEstabRuc).padStart(3, '0');
    porEstab.set(cod, r2((porEstab.get(cod) || 0) + Number(inv.importeTotal || 0)));
  }
  if (!porEstab.size) porEstab.set(informante.numEstabRuc, 0);
  const ventasEstablecimiento = [...porEstab.entries()].map(([codEstab, ventasEstab]) => ({
    codEstab, ventasEstab: r2(ventasEstab), ivaComp: 0,
  }));

  // ── ANULADOS ──────────────────────────────────────────────────────────────
  // Una fila por comprobante anulado (secuencialInicio = secuencialFin). Declararlos por
  // rango solo es correcto si el rango es CONTINUO; con huecos, el SRI rechaza el anexo.
  const anuladas = (await Invoice.find({ clinic: clinicId, estado: 'ANULADA' }).lean())
    .filter((inv) => inRange(invoiceFiscalDate(inv), range.start, range.end));
  const anulados = anuladas.map((inv) => {
    const num = splitSerie(inv);
    return {
      tipoComprobante: TIPO_COMPROBANTE.FACTURA_ELECTRONICA_VENTA,
      establecimiento: num.estab,
      puntoEmision: num.ptoEmi,
      secuencialInicio: num.secuencial,
      secuencialFin: num.secuencial,
      autorizacion: String(inv.numeroAutorizacion || inv.claveAcceso || ''),
      _fecha: atsDate(invoiceFiscalDate(inv)),
    };
  });

  // ── TOTALES ───────────────────────────────────────────────────────────────
  const totalVentas = r2(ventas.reduce((s, v) => s + v.baseNoGraIva + v.baseImponible + v.baseImpGrav, 0));
  const totals = {
    comprasCount: compras.length,
    comprasBase: r2(compras.reduce((s, c) => s + c.baseNoGraIva + c.baseImponible + c.baseImpGrav + c.baseImpExe, 0)),
    comprasBaseGrav: r2(compras.reduce((s, c) => s + c.baseImpGrav, 0)),
    comprasBase0: r2(compras.reduce((s, c) => s + c.baseImponible, 0)),
    comprasIva: r2(compras.reduce((s, c) => s + c.montoIva, 0)),
    comprasRetIva: r2(compras.reduce((s, c) => s + c._retIva, 0)),
    comprasRetRenta: r2(compras.reduce((s, c) => s + c._retRenta, 0)),
    comprasTotal: r2(compras.reduce((s, c) => s + c._total, 0)),
    ventasCount: ventas.reduce((s, v) => s + v.numeroComprobantes, 0),
    ventasBase: totalVentas,
    ventasBase0: r2(ventas.reduce((s, v) => s + v.baseImponible, 0)),
    ventasBaseGrav: r2(ventas.reduce((s, v) => s + v.baseImpGrav, 0)),
    ventasIva: r2(ventas.reduce((s, v) => s + v.montoIva, 0)),
    ventasTotal: r2(ventas.reduce((s, v) => s + v._total, 0)),
    anuladosCount: anulados.length,
  };
  informante.totalVentas = totalVentas;

  // ── VALIDACIONES ──────────────────────────────────────────────────────────
  // El SRI rechaza el anexo por datos faltantes, no por importes. Se avisan ANTES de que el
  // contador suba el archivo y le rebote, con el documento concreto que hay que corregir.
  const errores = [];
  if (!/^\d{13}$/.test(informante.ruc)) errores.push('El RUC del informante no es válido (debe tener 13 dígitos). Configúrelo en Facturación.');
  if (!informante.razonSocial) errores.push('Falta la razón social del informante.');
  for (const c of compras) {
    if (!/^\d{10}$|^\d{13}$/.test(c.idProv) && c.tpIdProv !== '03') {
      errores.push(`Compra ${c._serie}: la identificación del proveedor (${c.idProv || 'vacía'}) no es válida.`);
    }
    if (!c.autorizacion) errores.push(`Compra ${c._serie}: falta el número de autorización / clave de acceso.`);
    if (!c.secuencial || /^0+$/.test(c.secuencial)) errores.push(`Compra ${c._serie}: falta el secuencial del comprobante.`);
    if (c._retRenta > 0 && !c.autRetencion1) {
      errores.push(`Compra ${c._serie}: tiene retención en la fuente pero no se emitió el comprobante de retención.`);
    }
  }

  return {
    period: { label: range.label, year: range.year, month: range.month, start: range.start, end: range.end },
    informante,
    compras,
    ventas,
    ventasEstablecimiento,
    anulados,
    totals,
    errores,
  };
}

/**
 * Desglose por tarifa de una factura de venta. Usa el desglose ya guardado (`taxBreakdown`,
 * que rellena el backfill) y cae a los totales de cabecera cuando no está.
 */
function breakdownOf(inv) {
  const tb = inv.taxBreakdown || {};
  const base0 = Number(tb.base0) || 0;
  const baseGravada = Number(tb.baseGravada) || 0;
  const baseExento = Number(tb.baseExento) || 0;
  const baseNoObjeto = Number(tb.baseNoObjeto) || 0;
  const iva = tb.iva != null ? Number(tb.iva) : Number(inv.totalImpuesto) || 0;
  if (base0 || baseGravada || baseExento || baseNoObjeto) {
    return { base0, baseGravada, baseExento, baseNoObjeto, iva };
  }
  // Sin desglose: si hay IVA, toda la base es gravada; si no, va a tarifa 0.
  const base = Number(inv.totalSinImpuestos) || 0;
  return iva > 0.005
    ? { base0: 0, baseGravada: base, baseExento: 0, baseNoObjeto: 0, iva }
    : { base0: base, baseGravada: 0, baseExento: 0, baseNoObjeto: 0, iva: 0 };
}

/**
 * Reparte la retención de IVA en los tramos por porcentaje que pide el ATS.
 * En Ecuador los porcentajes vigentes de retención de IVA son 10 %, 20 %, 30 %, 50 %, 70 % y
 * 100 %; el XSD conserva nodos históricos (`valRetBien10`, `valRetServ20`, `valRetServ50`,
 * `valRetServ100`). Se ubica cada retención en su tramo por el porcentaje declarado.
 */
function splitRetIva(retentions = []) {
  const out = { valRetBien10: 0, valRetServ20: 0, valRetServ50: 0 };
  for (const r of retentions) {
    if (r.type !== 'IVA') continue;
    const pct = Number(r.percentage) || 0;
    const amount = r2(r.amount);
    if (pct <= 10) out.valRetBien10 += amount;
    else if (pct <= 20) out.valRetServ20 += amount;
    else if (pct <= 50) out.valRetServ50 += amount;
    // > 50 % (70 % y 100 %) se informa en valRetServ100, que se calcula aparte con el total.
  }
  return { valRetBien10: r2(out.valRetBien10), valRetServ20: r2(out.valRetServ20), valRetServ50: r2(out.valRetServ50) };
}

/**
 * XML del ATS en el ORDEN EXACTO del XSD (`ats.xsd`). Cada bloque respeta la secuencia
 * declarada en el esquema; mover un elemento invalida el archivo aunque el dato sea correcto.
 */
function atsXml(data) {
  const i = data.informante;
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<iva>');
  L.push(`  <TipoIDInformante>${esc(i.tipoId)}</TipoIDInformante>`);
  L.push(`  <IdInformante>${esc(i.ruc)}</IdInformante>`);
  L.push(`  <razonSocial>${esc(i.razonSocial)}</razonSocial>`);
  L.push(`  <Anio>${esc(i.anio)}</Anio>`);
  L.push(`  <Mes>${esc(i.mes)}</Mes>`);
  if (i.regimenMicroempresa) L.push(`  <regimenMicroempresa>${esc(i.regimenMicroempresa)}</regimenMicroempresa>`);
  L.push(`  <numEstabRuc>${esc(i.numEstabRuc)}</numEstabRuc>`);
  L.push(`  <totalVentas>${m2(i.totalVentas)}</totalVentas>`);
  L.push(`  <codigoOperativo>${esc(i.codigoOperativo)}</codigoOperativo>`);

  // ── compras ──
  if (data.compras.length) {
    L.push('  <compras>');
    for (const c of data.compras) {
      L.push('    <detalleCompras>');
      L.push(`      <codSustento>${esc(c.codSustento)}</codSustento>`);
      L.push(`      <tpIdProv>${esc(c.tpIdProv)}</tpIdProv>`);
      L.push(`      <idProv>${esc(c.idProv)}</idProv>`);
      L.push(`      <tipoComprobante>${esc(c.tipoComprobante)}</tipoComprobante>`);
      L.push(`      <parteRel>${esc(c.parteRel)}</parteRel>`);
      L.push(`      <fechaRegistro>${esc(c.fechaRegistro)}</fechaRegistro>`);
      L.push(`      <establecimiento>${esc(c.establecimiento)}</establecimiento>`);
      L.push(`      <puntoEmision>${esc(c.puntoEmision)}</puntoEmision>`);
      L.push(`      <secuencial>${esc(c.secuencial)}</secuencial>`);
      L.push(`      <fechaEmision>${esc(c.fechaEmision)}</fechaEmision>`);
      L.push(`      <autorizacion>${esc(c.autorizacion)}</autorizacion>`);
      L.push(`      <baseNoGraIva>${m2(c.baseNoGraIva)}</baseNoGraIva>`);
      L.push(`      <baseImponible>${m2(c.baseImponible)}</baseImponible>`);
      L.push(`      <baseImpGrav>${m2(c.baseImpGrav)}</baseImpGrav>`);
      L.push(`      <baseImpExe>${m2(c.baseImpExe)}</baseImpExe>`);
      L.push(`      <montoIce>${m2(c.montoIce)}</montoIce>`);
      L.push(`      <montoIva>${m2(c.montoIva)}</montoIva>`);
      L.push(`      <valRetBien10>${m2(c.valRetBien10)}</valRetBien10>`);
      L.push(`      <valRetServ20>${m2(c.valRetServ20)}</valRetServ20>`);
      L.push(`      <valorRetBienes>${m2(c.valorRetBienes)}</valorRetBienes>`);
      L.push(`      <valRetServ50>${m2(c.valRetServ50)}</valRetServ50>`);
      L.push(`      <valorRetServicios>${m2(c.valorRetServicios)}</valorRetServicios>`);
      L.push(`      <valRetServ100>${m2(c.valRetServ100)}</valRetServ100>`);
      L.push(`      <totbasesImpReemb>${m2(c.totbasesImpReemb)}</totbasesImpReemb>`);
      // pagoExterior: obligatorio dentro del nodo cuando se declara; local ⇒ 01/NO/NO.
      L.push('      <pagoExterior>');
      L.push(`        <pagoLocExt>${esc(c.pagoLocExt)}</pagoLocExt>`);
      L.push('        <aplicConvDobTrib></aplicConvDobTrib>');
      L.push('        <pagExtSujRetNorLeg></pagExtSujRetNorLeg>');
      L.push('      </pagoExterior>');
      if (c.formasDePago?.length) {
        L.push('      <formasDePago>');
        for (const fp of c.formasDePago) L.push(`        <formaPago>${esc(fp)}</formaPago>`);
        L.push('      </formasDePago>');
      }
      if (c.air?.length) {
        L.push('      <air>');
        for (const a of c.air) {
          L.push('        <detalleAir>');
          L.push(`          <codRetAir>${esc(a.codRetAir)}</codRetAir>`);
          L.push(`          <baseImpAir>${m2(a.baseImpAir)}</baseImpAir>`);
          L.push(`          <porcentajeAir>${m2(a.porcentajeAir)}</porcentajeAir>`);
          L.push(`          <valRetAir>${m2(a.valRetAir)}</valRetAir>`);
          L.push('        </detalleAir>');
        }
        L.push('      </air>');
      }
      if (c.autRetencion1) {
        L.push(`      <estabRetencion1>${esc(c.estabRetencion1)}</estabRetencion1>`);
        L.push(`      <ptoEmiRetencion1>${esc(c.ptoEmiRetencion1)}</ptoEmiRetencion1>`);
        L.push(`      <secRetencion1>${esc(c.secRetencion1)}</secRetencion1>`);
        L.push(`      <autRetencion1>${esc(c.autRetencion1)}</autRetencion1>`);
        L.push(`      <fechaEmiRet1>${esc(c.fechaEmiRet1)}</fechaEmiRet1>`);
      }
      L.push('    </detalleCompras>');
    }
    L.push('  </compras>');
  }

  // ── ventas ──
  if (data.ventas.length) {
    L.push('  <ventas>');
    for (const v of data.ventas) {
      L.push('    <detalleVentas>');
      L.push(`      <tpIdCliente>${esc(v.tpIdCliente)}</tpIdCliente>`);
      L.push(`      <idCliente>${esc(v.idCliente)}</idCliente>`);
      L.push(`      <parteRelVtas>${esc(v.parteRelVtas)}</parteRelVtas>`);
      L.push(`      <tipoComprobante>${esc(v.tipoComprobante)}</tipoComprobante>`);
      L.push(`      <tipoEmision>${esc(v.tipoEmision)}</tipoEmision>`);
      L.push(`      <numeroComprobantes>${v.numeroComprobantes}</numeroComprobantes>`);
      L.push(`      <baseNoGraIva>${m2(v.baseNoGraIva)}</baseNoGraIva>`);
      L.push(`      <baseImponible>${m2(v.baseImponible)}</baseImponible>`);
      L.push(`      <baseImpGrav>${m2(v.baseImpGrav)}</baseImpGrav>`);
      L.push(`      <montoIva>${m2(v.montoIva)}</montoIva>`);
      L.push(`      <montoIce>${m2(v.montoIce)}</montoIce>`);
      L.push(`      <valorRetIva>${m2(v.valorRetIva)}</valorRetIva>`);
      L.push(`      <valorRetRenta>${m2(v.valorRetRenta)}</valorRetRenta>`);
      if (v.formasDePago?.length) {
        L.push('      <formasDePago>');
        for (const fp of v.formasDePago) L.push(`        <formaPago>${esc(fp)}</formaPago>`);
        L.push('      </formasDePago>');
      }
      L.push('    </detalleVentas>');
    }
    L.push('  </ventas>');
  }

  // ── ventasEstablecimiento ──
  if (data.ventasEstablecimiento.length) {
    L.push('  <ventasEstablecimiento>');
    for (const e of data.ventasEstablecimiento) {
      L.push('    <ventaEst>');
      L.push(`      <codEstab>${esc(e.codEstab)}</codEstab>`);
      L.push(`      <ventasEstab>${m2(e.ventasEstab)}</ventasEstab>`);
      L.push(`      <ivaComp>${m2(e.ivaComp)}</ivaComp>`);
      L.push('    </ventaEst>');
    }
    L.push('  </ventasEstablecimiento>');
  }

  // ── anulados ──
  if (data.anulados.length) {
    L.push('  <anulados>');
    for (const a of data.anulados) {
      L.push('    <detalleAnulados>');
      L.push(`      <tipoComprobante>${esc(a.tipoComprobante)}</tipoComprobante>`);
      L.push(`      <establecimiento>${esc(a.establecimiento)}</establecimiento>`);
      L.push(`      <puntoEmision>${esc(a.puntoEmision)}</puntoEmision>`);
      L.push(`      <secuencialInicio>${esc(a.secuencialInicio)}</secuencialInicio>`);
      L.push(`      <secuencialFin>${esc(a.secuencialFin)}</secuencialFin>`);
      L.push(`      <autorizacion>${esc(a.autorizacion)}</autorizacion>`);
      L.push('    </detalleAnulados>');
    }
    L.push('  </anulados>');
  }

  L.push('</iva>');
  return L.join('\n');
}

/** Nombre oficial del archivo del ATS: ATmmaaaa.xml */
function atsFileName(year, month) {
  return `AT${String(month).padStart(2, '0')}${year}.xml`;
}

module.exports = {
  buildAts,
  atsXml,
  atsFileName,
  atsDate,
  tpIdProv,
  tpIdCliente,
  codSustento,
  formaPagoOf,
  TIPO_COMPROBANTE,
  CONSUMIDOR_FINAL,
};
