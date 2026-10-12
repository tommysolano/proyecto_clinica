/**
 * CAJA E INGRESOS — el cuadre de caja del período (oct-2026).
 *
 * El contador venía de micartaonline y buscaba aquí su pantalla «Caja e ingresos»: un
 * cuadre de tres bloques —INGRESO DE CAJA, EGRESO DE CAJA y SALDO EN CAJA— con los
 * depósitos al banco y las salidas de efectivo debajo. Este servicio arma ese cuadre con
 * los documentos de la clínica (ventas, cobros, depósitos, vales y asientos).
 *
 * ── La lógica es la del cajero, no la contable ─────────────────────────────────
 *   INGRESO = todo lo que se cobró, del medio que sea.
 *   EGRESO  = todo lo que NO se quedó en el cajón.
 *   SALDO   = lo que tiene que haber al contar el efectivo.
 * Por eso lo cobrado con tarjeta, por transferencia o con saldo a favor aparece en LOS DOS
 * bloques (grupo NETEO) y se anula solo: entra como venta del período y sale porque ese
 * dinero nunca estuvo en el cajón. Lo que sí pasó por el cajón es grupo GAVETA.
 *
 * ── De dónde sale cada número ──────────────────────────────────────────────────
 *  · Las VENTAS se leen de la venta (`Sale.payments`), que es la única que sabe el medio
 *    de cobro. Cuentan las ventas cuyo asiento es del período; una anulada dentro del
 *    período no cuenta (su asiento y su reverso se cancelan).
 *  · TODO LO DEMÁS se lee del libro mayor: cualquier asiento que mueva la cuenta Caja (o
 *    sus subcuentas) y no sea el asiento de una venta. Así entran los cobros de cartera,
 *    los depósitos, los vales, los pagos en efectivo, los sobrantes y faltantes, y lo que
 *    se registre a mano o llegue de Contífico.
 *  · Un asiento y su reverso del MISMO período se cancelan y no aparecen. Si el original
 *    es de otro período, el reverso sí cuenta (el mayor de este período lo tiene).
 *
 * ── El contraste contra el mayor ───────────────────────────────────────────────
 * `saldoCaja` (ingresos − egresos de la hoja) se compara con el MOVIMIENTO de la cuenta
 * Caja en el período según el mayor. Salen de fuentes distintas, así que cuando difieren
 * hay algo sin registrar o mal registrado. Se compara movimiento contra movimiento: el
 * saldo acumulado (`saldoMayor`) es otra cosa y se enseña aparte.
 */
const mongoose = require('mongoose');
const JournalEntry = require('../models/JournalEntry');
const Sale = require('../models/Sale');
const ChartOfAccount = require('../models/ChartOfAccount');
const AccountingConfig = require('../models/AccountingConfig');
const CashMovement = require('../models/CashMovement');
const CashDeposit = require('../models/CashDeposit');
const { ACCOUNT_ROLES } = require('../utils/accountMap');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const escapar = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Documentos por línea del cuadre: más que esto se recorta y se avisa. */
const TOPE_DETALLE = 200;
/** Filas del historial de salidas. */
const TOPE_SALIDAS = 300;

const GRUPO = { GAVETA: 'GAVETA', NETEO: 'NETEO' };

/** 'YYYY-MM-DD' → inicio o fin de ese día en hora local (el servidor corre en Guayaquil). */
function diaLocal(valor, fin = false) {
  const m = String(valor || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return fin
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999)
    : new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}

function hoyYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Período pedido; sin fechas, hoy. Sin «hasta», hasta hoy. */
function periodoDe(query = {}) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(query.from || '')) ? String(query.from) : hoyYmd();
  let to = /^\d{4}-\d{2}-\d{2}$/.test(String(query.to || '')) ? String(query.to) : hoyYmd();
  if (to < from) to = from;
  return { from, to, start: diaLocal(from), end: diaLocal(to, true) };
}

/**
 * LAS CUENTAS DE CAJA: la configurada como «Caja general» y sus subcuentas (por código).
 * Solo LEE: abrir una pantalla de consulta no puede sembrar cuentas en el plan.
 */
async function cuentasDeCaja(clinicId) {
  const cfg = await AccountingConfig.findOne({ clinic: clinicId }).lean();
  const mapeada = cfg?.accounts?.caja || (cfg?.accounts instanceof Map ? cfg.accounts.get('caja') : null);
  let principal = mapeada
    ? await ChartOfAccount.findOne({ _id: mapeada, clinic: clinicId }).select('code name').lean()
    : null;
  if (!principal) {
    principal = await ChartOfAccount.findOne({ clinic: clinicId, code: ACCOUNT_ROLES.caja.code })
      .select('code name').lean();
  }
  if (!principal) return { principal: null, ids: [], porId: new Map() };
  const hijas = await ChartOfAccount.find({ clinic: clinicId, code: new RegExp(`^${escapar(principal.code)}\\.`) })
    .select('code name').lean();
  const todas = [principal, ...hijas];
  return {
    principal,
    ids: todas.map((a) => a._id),
    porId: new Map(todas.map((a) => [String(a._id), a])),
  };
}

/** Débito y crédito de un asiento sobre las cuentas de caja. */
function movimientoEnCaja(asiento, porId) {
  let debe = 0;
  let haber = 0;
  let cuenta = null;
  for (const l of asiento.lines || []) {
    if (!porId.has(String(l.account))) continue;
    debe += Number(l.debit) || 0;
    haber += Number(l.credit) || 0;
    if (!cuenta) cuenta = porId.get(String(l.account));
  }
  return { debe: r2(debe), haber: r2(haber), neto: r2(debe - haber), cuenta };
}

/** Las cuentas de contrapartida de un asiento (las que no son caja), con su importe. */
function contrapartidas(asiento, porId, nombres) {
  const out = [];
  for (const l of asiento.lines || []) {
    if (porId.has(String(l.account))) continue;
    const a = nombres.get(String(l.account));
    out.push({
      code: a?.code || '',
      name: a?.name || '',
      amount: r2((Number(l.debit) || 0) + (Number(l.credit) || 0)),
    });
  }
  return out;
}

async function nombresDeCuentas(clinicId, asientos) {
  const ids = new Set();
  asientos.forEach((a) => (a.lines || []).forEach((l) => ids.add(String(l.account))));
  if (!ids.size) return new Map();
  const cuentas = await ChartOfAccount.find({ clinic: clinicId, _id: { $in: [...ids].map(oid) } })
    .select('code name').lean();
  return new Map(cuentas.map((c) => [String(c._id), c]));
}

/** Medios de cobro de una venta: el desglose `payments` o, en las viejas, el método resumen. */
function cobrosDeVenta(sale) {
  const detalle = (sale.payments || []).filter((p) => Number(p.amount) > 0);
  if (detalle.length) return detalle.map((p) => ({ method: p.method, amount: r2(p.amount) }));
  const m = sale.paymentMethod || 'efectivo';
  if (['credito', 'mixto', 'desconocido'].includes(m)) return [];
  return [{ method: m, amount: r2((Number(sale.total) || 0) - (Number(sale.balance) || 0)) }];
}

/** Los rótulos que lee el contador. Las ventas NETEO se repiten en los dos bloques. */
const LINEAS_VENTA = {
  efectivo: { clave: 'ventas_efectivo', etiqueta: 'Ventas cobradas en efectivo', grupo: GRUPO.GAVETA },
  tarjeta: { clave: 'ventas_tarjeta', etiqueta: 'Ventas cobradas con tarjeta', grupo: GRUPO.NETEO },
  transferencia: { clave: 'ventas_transferencia', etiqueta: 'Ventas cobradas por transferencia', grupo: GRUPO.NETEO },
  anticipo: { clave: 'ventas_anticipo', etiqueta: 'Ventas pagadas con saldo a favor', grupo: GRUPO.NETEO },
  otro: { clave: 'ventas_otros', etiqueta: 'Ventas cobradas por otros medios', grupo: GRUPO.NETEO },
};

const LINEAS_LIBRO = {
  // Ingresos (asientos que DEBITAN caja y no son una venta).
  cobros: { etiqueta: 'Cobros de cartera en efectivo', grupo: GRUPO.GAVETA },
  ingresos_caja: { etiqueta: 'Ingresos varios a caja', grupo: GRUPO.GAVETA },
  retiros_banco: { etiqueta: 'Efectivo traído del banco', grupo: GRUPO.GAVETA },
  sobrantes: { etiqueta: 'Sobrantes de caja', grupo: GRUPO.GAVETA },
  reversos_entrada: { etiqueta: 'Salidas de otros días anuladas (vuelven a caja)', grupo: GRUPO.GAVETA },
  otros_ingresos: { etiqueta: 'Otros ingresos de efectivo', grupo: GRUPO.GAVETA },
  // Egresos (asientos que ACREDITAN caja).
  depositos: { etiqueta: 'Depósitos al banco', grupo: GRUPO.GAVETA },
  vales: { etiqueta: 'Vales y gastos de caja', grupo: GRUPO.GAVETA },
  pagos: { etiqueta: 'Pagos en efectivo (proveedores, nómina…)', grupo: GRUPO.GAVETA },
  faltantes: { etiqueta: 'Faltantes de caja', grupo: GRUPO.GAVETA },
  anulaciones_ventas: { etiqueta: 'Ventas de otros días anuladas', grupo: GRUPO.GAVETA },
  reversos_salida: { etiqueta: 'Ingresos de otros días anulados', grupo: GRUPO.GAVETA },
  otras_salidas: { etiqueta: 'Otras salidas de efectivo', grupo: GRUPO.GAVETA },
};

/** A qué línea va un asiento del mayor que movió caja. `original`: el asiento que reversa. */
function claveDeAsiento(asiento, entra, original) {
  if (asiento.reverses) {
    if (entra) return 'reversos_entrada';
    return original?.source === 'VENTA' ? 'anulaciones_ventas' : 'reversos_salida';
  }
  if (entra) {
    if (asiento.source === 'COBRO') return 'cobros';
    if (asiento.sourceModel === 'CashMovement') return 'ingresos_caja';
    if (asiento.source === 'CIERRE') return 'sobrantes';
    if (asiento.source === 'BANCO') return 'retiros_banco';
    return 'otros_ingresos';
  }
  if (asiento.sourceModel === 'CashDeposit') return 'depositos';
  if (asiento.sourceModel === 'CashMovement') return 'vales';
  if (asiento.source === 'CIERRE') return 'faltantes';
  if (['PAGO', 'NOMINA'].includes(asiento.source)) return 'pagos';
  return 'otras_salidas';
}

const esAsientoDeVenta = (a) => a.source === 'VENTA' && a.sourceModel === 'Sale' && a.sourceAction === 'POST';

/** Colector de líneas con su detalle documento a documento (topado). */
function crearLineas() {
  const lineas = new Map();
  const de = (clave, etiqueta, grupo) => {
    if (!lineas.has(clave)) lineas.set(clave, { clave, etiqueta, grupo, monto: 0, items: [], contados: 0 });
    return lineas.get(clave);
  };
  const sumar = (clave, etiqueta, grupo, monto, item) => {
    const l = de(clave, etiqueta, grupo);
    l.monto = r2(l.monto + monto);
    l.contados += 1;
    if (l.items.length < TOPE_DETALLE) l.items.push({ ...item, monto: r2(monto) });
  };
  const fila = (clave, etiqueta, grupo) => {
    const l = de(clave, etiqueta, grupo);
    return {
      clave: l.clave,
      etiqueta: l.etiqueta,
      grupo: l.grupo,
      monto: r2(l.monto),
      detalle: { items: l.items, contados: l.contados, truncado: l.contados > l.items.length },
    };
  };
  return { sumar, fila, tiene: (clave) => lineas.has(clave) && lineas.get(clave).monto > 0.005 };
}

/**
 * El cuadre del período para una sucursal.
 * @returns {Promise<object>} { from, to, ingresos, egresos, totales, saldos, diferencia, sinCuentaCaja }
 */
async function construirPanel(clinicId, query = {}) {
  const { from, to, start, end } = periodoDe(query);
  const clinic = oid(clinicId);
  const caja = await cuentasDeCaja(clinicId);
  const L = crearLineas();

  // ── 1. Ventas del período (por su asiento) ──────────────────────────────────
  const asientosVenta = await JournalEntry.find({
    clinic, status: 'CONTABILIZADO', source: 'VENTA', sourceModel: 'Sale', sourceAction: 'POST',
    date: { $gte: start, $lte: end },
  }).select('sourceRef date isReversed reversedAt').lean();
  // Anulada dentro del período: su asiento y su reverso se cancelan, no cuenta.
  const vigentes = asientosVenta.filter((a) => !(a.isReversed && a.reversedAt && new Date(a.reversedAt) <= end));
  const fechaDeVenta = new Map(vigentes.map((a) => [String(a.sourceRef), a.date]));
  const ventas = fechaDeVenta.size
    ? await Sale.find({ clinic, _id: { $in: [...fechaDeVenta.keys()].map(oid) } })
      .select('saleNumber clientName patient payments paymentMethod total balance invoice')
      .populate('patient', 'firstName lastName')
      .populate('invoice', 'secuencial estab ptoEmi')
      .lean()
    : [];
  for (const v of ventas) {
    const cliente = v.clientName || [v.patient?.firstName, v.patient?.lastName].filter(Boolean).join(' ');
    const factura = v.invoice
      ? [v.invoice.estab, v.invoice.ptoEmi, v.invoice.secuencial].filter(Boolean).join('-')
      : '';
    for (const c of cobrosDeVenta(v)) {
      if (c.method === 'credito' || c.amount <= 0) continue;
      const def = LINEAS_VENTA[c.method] || LINEAS_VENTA.otro;
      L.sumar(def.clave, def.etiqueta, def.grupo, c.amount, {
        tipo: 'VENTA',
        fecha: fechaDeVenta.get(String(v._id)),
        documento: v.saleNumber || '',
        factura,
        saleId: String(v._id),
        detalle: cliente || '',
        cuenta: c.method,
      });
    }
  }

  // ── 2. El resto del efectivo, del libro mayor ───────────────────────────────
  let asientosCaja = [];
  if (caja.ids.length) {
    asientosCaja = await JournalEntry.find({
      clinic, status: 'CONTABILIZADO', date: { $gte: start, $lte: end }, 'lines.account': { $in: caja.ids },
    }).select('number date description source sourceModel sourceRef sourceAction lines isReversed reversedAt reverses')
      .sort({ date: 1, number: 1 })
      .lean();
  }
  const idsOriginales = asientosCaja.filter((a) => a.reverses).map((a) => a.reverses);
  const originales = idsOriginales.length
    ? await JournalEntry.find({ clinic, _id: { $in: idsOriginales } }).select('date source sourceModel').lean()
    : [];
  const originalPorId = new Map(originales.map((o) => [String(o._id), o]));
  const nombres = await nombresDeCuentas(clinicId, asientosCaja);

  let movimientoMayor = 0;
  for (const a of asientosCaja) {
    const mov = movimientoEnCaja(a, caja.porId);
    movimientoMayor += mov.neto;
    if (Math.abs(mov.neto) < 0.005) continue;
    if (esAsientoDeVenta(a)) continue; // ya contada por la venta
    // Un asiento y su reverso del MISMO período se cancelan.
    if (a.isReversed && a.reversedAt && new Date(a.reversedAt) <= end) continue;
    const original = a.reverses ? originalPorId.get(String(a.reverses)) : null;
    if (original && new Date(original.date) >= start && new Date(original.date) <= end) continue;

    const entra = mov.neto > 0;
    const clave = claveDeAsiento(a, entra, original);
    const def = LINEAS_LIBRO[clave];
    L.sumar(clave, def.etiqueta, def.grupo, Math.abs(mov.neto), {
      tipo: 'ASIENTO',
      fecha: a.date,
      documento: a.number,
      asientoId: String(a._id),
      detalle: a.description || '',
      cuenta: contrapartidas(a, caja.porId, nombres).map((c) => [c.code, c.name].filter(Boolean).join(' ')).join(' · '),
    });
  }

  // ── 3. Los dos bloques ──────────────────────────────────────────────────────
  const siempreIngreso = ['ventas_efectivo', 'ventas_tarjeta', 'ventas_transferencia', 'cobros'];
  const ordenIngreso = [
    'ventas_efectivo', 'ventas_tarjeta', 'ventas_transferencia', 'ventas_anticipo', 'ventas_otros',
    'cobros', 'ingresos_caja', 'retiros_banco', 'sobrantes', 'reversos_entrada', 'otros_ingresos',
  ];
  const netas = ['ventas_tarjeta', 'ventas_transferencia', 'ventas_anticipo', 'ventas_otros'];
  const siempreEgreso = ['ventas_tarjeta', 'ventas_transferencia', 'depositos', 'vales'];
  const ordenEgreso = [
    ...netas, 'depositos', 'vales', 'pagos', 'faltantes', 'anulaciones_ventas', 'reversos_salida', 'otras_salidas',
  ];
  const etiquetaDe = (clave) => (LINEAS_VENTA[Object.keys(LINEAS_VENTA).find((k) => LINEAS_VENTA[k].clave === clave)]
    || LINEAS_LIBRO[clave]);
  const pintar = (clave) => {
    const def = etiquetaDe(clave);
    return L.fila(clave, def.etiqueta, def.grupo);
  };
  const ingresos = ordenIngreso.filter((c) => siempreIngreso.includes(c) || L.tiene(c)).map(pintar);
  const egresos = ordenEgreso.filter((c) => siempreEgreso.includes(c) || L.tiene(c)).map(pintar);
  const totalIngresos = r2(ingresos.reduce((s, f) => s + f.monto, 0));
  const totalEgresos = r2(egresos.reduce((s, f) => s + f.monto, 0));
  const saldoCaja = r2(totalIngresos - totalEgresos);

  // ── 4. El mayor: saldo al inicio, movimiento y saldo al corte ───────────────
  let saldoInicialMayor = 0;
  if (caja.ids.length) {
    const previo = await JournalEntry.aggregate([
      { $match: { clinic, status: 'CONTABILIZADO', date: { $lt: start }, 'lines.account': { $in: caja.ids } } },
      { $unwind: '$lines' },
      { $match: { 'lines.account': { $in: caja.ids } } },
      { $group: { _id: null, debe: { $sum: '$lines.debit' }, haber: { $sum: '$lines.credit' } } },
    ]);
    saldoInicialMayor = r2((previo[0]?.debe || 0) - (previo[0]?.haber || 0));
  }
  movimientoMayor = r2(movimientoMayor);

  return {
    from,
    to,
    cuentaCaja: caja.principal ? { code: caja.principal.code, name: caja.principal.name } : null,
    sinCuentaCaja: !caja.principal,
    ingresos,
    egresos,
    totalIngresos,
    totalEgresos,
    saldoCaja,
    saldoInicialMayor,
    movimientoMayor,
    saldoMayor: r2(saldoInicialMayor + movimientoMayor),
    diferencia: r2(saldoCaja - movimientoMayor),
  };
}

/**
 * HISTORIAL DE SALIDAS DE EFECTIVO: todo asiento del período que saca dinero de caja
 * (o de una de sus subcuentas), venga del módulo que venga. Cada fila dice si se puede
 * anular desde aquí: los vales y los depósitos sí; lo demás, desde su módulo.
 */
async function listarSalidas(clinicId, query = {}, { puedeAnularDepositos = false, userId = null, esCajero = false } = {}) {
  const { from, to, start, end } = periodoDe(query);
  const clinic = oid(clinicId);
  const caja = await cuentasDeCaja(clinicId);
  if (!caja.ids.length) return { from, to, items: [], truncado: false, limit: TOPE_SALIDAS };

  const asientos = await JournalEntry.find({
    clinic, status: 'CONTABILIZADO', date: { $gte: start, $lte: end },
    lines: { $elemMatch: { account: { $in: caja.ids }, credit: { $gt: 0 } } },
  }).select('number date description source sourceModel sourceRef sourceAction lines isReversed reverses createdBy')
    .sort({ date: -1, number: -1 })
    .limit(TOPE_SALIDAS * 2)
    .lean();
  const salidas = asientos
    .map((a) => ({ a, mov: movimientoEnCaja(a, caja.porId) }))
    .filter(({ mov }) => mov.neto < -0.005);
  const truncado = salidas.length > TOPE_SALIDAS;
  const visibles = salidas.slice(0, TOPE_SALIDAS);
  const nombres = await nombresDeCuentas(clinicId, visibles.map((s) => s.a));

  const idsMov = visibles.filter((s) => s.a.sourceModel === 'CashMovement' && s.a.sourceRef).map((s) => s.a.sourceRef);
  const idsDep = visibles.filter((s) => s.a.sourceModel === 'CashDeposit' && s.a.sourceRef).map((s) => s.a.sourceRef);
  const [movs, deps] = await Promise.all([
    idsMov.length ? CashMovement.find({ clinic, _id: { $in: idsMov } }).select('type voided createdBy').lean() : [],
    idsDep.length
      ? CashDeposit.find({ clinic, _id: { $in: idsDep } })
        .select('number status voucherNumber bankAccount').populate('bankAccount', 'name bank').lean()
      : [],
  ]);
  const movPorId = new Map(movs.map((m) => [String(m._id), m]));
  const depPorId = new Map(deps.map((d) => [String(d._id), d]));

  const ORIGEN = {
    CashMovement: 'Caja (vale / gasto)', CashDeposit: 'Depósito al banco', Payment: 'Pagos',
    CashClosing: 'Cierre de caja', PurchaseInvoice: 'Compras', Sale: 'Ventas', JournalEntry: 'Reverso',
  };

  const items = visibles.map(({ a, mov }) => {
    const partes = contrapartidas(a, caja.porId, nombres);
    let canVoid = false;
    let voidBlockedMessage = '';
    let depositId = null;
    let tipo = 'OTRO';
    if (a.isReversed) {
      voidBlockedMessage = 'Ya está anulado: su asiento tiene reverso.';
    } else if (a.reverses) {
      voidBlockedMessage = 'Es el reverso de otro asiento: no se anula.';
    } else if (a.sourceModel === 'CashMovement') {
      tipo = 'VALE';
      const m = movPorId.get(String(a.sourceRef));
      if (!m) voidBlockedMessage = 'No se encontró el movimiento de caja.';
      else if (m.voided) voidBlockedMessage = 'Ya está anulado.';
      else if (esCajero && String(m.createdBy) !== String(userId)) {
        voidBlockedMessage = 'Solo quien lo registró, administración o contabilidad pueden anularlo.';
      } else canVoid = true;
    } else if (a.sourceModel === 'CashDeposit') {
      tipo = 'DEPOSITO';
      const d = depPorId.get(String(a.sourceRef));
      depositId = d ? String(d._id) : null;
      if (!d) voidBlockedMessage = 'No se encontró el depósito.';
      else if (d.status === 'ANULADO') voidBlockedMessage = 'Ya está anulado.';
      else if (!puedeAnularDepositos) voidBlockedMessage = 'Un depósito lo anulan administración o contabilidad.';
      else canVoid = true;
    } else {
      voidBlockedMessage = 'Se registró en otro módulo: se anula desde allí.';
    }
    return {
      _id: String(a._id),
      entryId: String(a._id),
      entryNumber: a.number,
      date: a.date,
      cajaCodigo: mov.cuenta?.code || '',
      cajaNombre: mov.cuenta?.name || '',
      accountCode: partes[0]?.code || '',
      accountName: partes[0]?.name || '',
      description: a.description || '',
      amount: r2(-mov.neto),
      reversed: !!a.isReversed,
      esReverso: !!a.reverses,
      tipo,
      origen: ORIGEN[a.sourceModel] || a.source || '',
      sourceRef: a.sourceRef ? { type: a.sourceModel, id: String(a.sourceRef) } : null,
      depositId,
      contrapartidas: partes,
      canVoid,
      voidBlockedMessage,
    };
  });
  return { from, to, items, truncado, limit: TOPE_SALIDAS };
}

module.exports = {
  construirPanel,
  listarSalidas,
  cuentasDeCaja,
  periodoDe,
  diaLocal,
  hoyYmd,
  GRUPO,
};
