const mongoose = require('mongoose');
const CashClosing = require('../models/CashClosing');
const CashMovement = require('../models/CashMovement');
const JournalEntry = require('../models/JournalEntry');
const Sale = require('../models/Sale');
const { createEntry, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const { puntoRequerido, puntoDelUsuario, sucursalUsaPuntos } = require('../services/puntoEmision');
const { clinicsOfCompanySync } = require('../utils/companies');

const oid = (v) => new mongoose.Types.ObjectId(v);

/** Solo el super administrador ve las cajas de todos y de todas las sucursales (nov-2026). */
const veTodo = (req) => !!req.user.isSuperAdmin;

/**
 * Cajero y ADMIN ven solo SUS cajas (las que abrieron o cerraron), igual que cualquiera que
 * factura: un admin que cobra veía las cajas de los demás debajo de la suya. Contabilidad
 * sigue viendo las de su sucursal (las audita).
 */
const soloPropias = (req) => !veTodo(req) && ['cajero', 'admin'].includes(req.role);

/**
 * Sucursales cuyas cajas puede consultar el usuario: el super administrador, todas las de la
 * empresa activa; el resto, solo la sucursal en la que está.
 */
const clinicasVisibles = (req) => {
  const actual = String(req.clinicId);
  if (!veTodo(req)) return [actual];
  const todas = clinicsOfCompanySync(req.companyId).map(String);
  return todas.includes(actual) ? todas : [actual, ...todas];
};

/** Fecha 'YYYY-MM-DD' a la hora local indicada (el servidor corre en America/Guayaquil). */
const localDate = (ymd, time) => new Date(`${String(ymd).slice(0, 10)}T${time}`);

/** Neto de movimientos de caja (ingresos - egresos) de una sesión abierta. */
const cashMovementsNet = async (clinicId, cashSessionId) => {
  const rows = await CashMovement.aggregate([
    { $match: { clinic: oid(clinicId), cashSession: oid(cashSessionId), voided: false } },
    { $group: { _id: '$type', total: { $sum: '$amount' } } },
  ]);
  let net = 0;
  for (const r of rows) net += (r._id === 'INGRESO' ? 1 : -1) * r.total;
  return +net.toFixed(2);
};

/**
 * Movimiento neto (debe - haber) de la cuenta Caja en el mayor durante la sesión.
 * Es la fuente de verdad del efectivo que entró/salió físicamente del cajón:
 * captura ventas de contado, cobros de crédito en efectivo, anticipos, gastos de
 * caja chica, retiros y depósitos, todo de forma uniforme y sin doble conteo.
 *
 * Con `createdBy` (caja por punto de venta) cuenta solo los asientos que registró ese usuario:
 * varias cajas abiertas a la vez comparten la cuenta Caja, y sin el filtro cada una vería el
 * efectivo de las demás.
 */
const cajaLedgerNet = async (clinicId, start, end, session = null, createdBy = null) => {
  const caja = await getAccount(clinicId, 'caja', session ? { session } : {});
  const match = { clinic: oid(clinicId), status: 'CONTABILIZADO', date: { $gte: start, $lte: end } };
  if (createdBy) match.createdBy = oid(createdBy);
  const pipeline = [
    { $match: match },
    { $unwind: '$lines' },
    { $match: { 'lines.account': caja._id } },
    { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ];
  const agg = session
    ? await JournalEntry.aggregate(pipeline).session(session)
    : await JournalEntry.aggregate(pipeline);
  return +(((agg[0]?.debit || 0) - (agg[0]?.credit || 0)).toFixed(2));
};

const dayRange = (dateStr) => {
  const base = dateStr ? new Date(dateStr) : new Date();
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0);
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 23, 59, 59, 999);
  return { start, end };
};

/**
 * Agrega las ventas (por método de pago) en un rango de fechas. Con `puntoEmision` solo
 * cuenta las ventas registradas desde ese punto de venta (caja por punto).
 */
const salesByMethod = async (clinicId, start, end, puntoEmision = null) => {
  const match = { clinic: oid(clinicId), status: 'completada', createdAt: { $gte: start, $lte: end } };
  if (puntoEmision) match.puntoEmision = oid(puntoEmision);
  // El desglose por método sale de `payments` (pago dividido: una venta puede
  // sumar a varios métodos). Ventas antiguas sin `payments` se interpretan como un
  // solo pago = { method: paymentMethod, amount: total }. El conteo de ventas y el
  // total sí son por venta (no por renglón de pago).
  const rows = await Sale.aggregate([
    { $match: match },
    {
      $project: {
        total: 1,
        pays: {
          $cond: [
            { $gt: [{ $size: { $ifNull: ['$payments', []] } }, 0] },
            '$payments',
            [{ method: '$paymentMethod', amount: '$total' }],
          ],
        },
      },
    },
    { $unwind: '$pays' },
    { $group: { _id: '$pays.method', amount: { $sum: '$pays.amount' } } },
  ]);
  const totals = await Sale.aggregate([
    { $match: match },
    { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$total' } } },
  ]);
  const byMethod = { efectivo: 0, tarjeta: 0, transferencia: 0 };
  rows.forEach((r) => { if (r._id in byMethod) byMethod[r._id] = +Number(r.amount || 0).toFixed(2); });
  return { byMethod, salesCount: totals[0]?.count || 0, totalSales: +Number(totals[0]?.total || 0).toFixed(2) };
};

/**
 * Cuadre de una sesión de caja hasta `end`. Si la sesión es de un punto de venta, cuenta solo
 * las ventas de ese punto y los asientos de Caja de quien la abrió; si no (caja única de la
 * sucursal, modo anterior), todo lo de la sucursal.
 */
const resumenSesion = async (clinicId, closing, end, session = null) => {
  const punto = closing.puntoEmision?._id || closing.puntoEmision || null;
  const duenio = punto ? (closing.openedBy?._id || closing.openedBy) : null;
  const { byMethod, salesCount, totalSales } = await salesByMethod(clinicId, closing.openedAt, end, punto);
  // Efectivo esperado = fondo inicial + neto de la cuenta Caja en el mayor
  // (incluye ventas de contado, cobros de crédito en efectivo, gastos de caja
  //  chica, retiros y depósitos), sin doble conteo.
  const cashNet = await cajaLedgerNet(clinicId, closing.openedAt, end, session, duenio);
  const expectedCash = +((closing.openingBalance || 0) + cashNet).toFixed(2);
  return { byMethod, salesCount, totalSales, cashNet, expectedCash };
};

const PUNTO_FIELDS = 'establecimiento codigo nombre';

/** Caja abierta del cajero actual (si existe), con su resumen en vivo. */
exports.current = async (req, res) => {
  try {
    const usaPuntos = await sucursalUsaPuntos(req.clinicId);
    const miPunto = usaPuntos ? await puntoDelUsuario(req.clinicId, req.user._id) : null;
    const open = await CashClosing.findOne({ clinic: req.clinicId, status: 'ABIERTA', openedBy: req.user._id })
      .populate('openedBy', 'name')
      .populate('puntoEmision', PUNTO_FIELDS)
      .sort({ openedAt: -1 });
    if (!open) return res.json({ open: null, usaPuntos, miPunto });
    const now = new Date();
    const live = await resumenSesion(req.clinicId, open, now);
    const movementsNet = await cashMovementsNet(req.clinicId, open._id);
    res.json({ open, live: { ...live, movementsNet }, usaPuntos, miPunto });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/**
 * Abre la caja del usuario actual con un fondo inicial. Una caja abierta por usuario y, si la
 * sucursal usa puntos de venta, por punto: sin punto asignado no se puede abrir caja.
 */
exports.open = async (req, res) => {
  try {
    const existing = await CashClosing.findOne({ clinic: req.clinicId, status: 'ABIERTA', openedBy: req.user._id });
    if (existing) return res.status(400).json({ message: 'Ya tienes una caja abierta. Ciérrala antes de abrir otra.' });
    const punto = await puntoRequerido(req.clinicId, req.user._id);
    if (punto) {
      // El punto pudo cambiar de dueño con una caja aún abierta por el anterior.
      const delPunto = await CashClosing.findOne({ clinic: req.clinicId, status: 'ABIERTA', puntoEmision: punto._id })
        .populate('openedBy', 'name');
      if (delPunto) {
        return res.status(400).json({
          message: `El punto ${punto.establecimiento}-${punto.codigo} tiene una caja abierta por ${delPunto.openedBy?.name || 'otro usuario'}. Debe cerrarse antes de abrir una nueva.`,
        });
      }
    }
    const openingBalance = Number(req.body.openingBalance) || 0;
    const now = new Date();
    const closing = await CashClosing.create({
      clinic: req.clinicId,
      date: now,
      openedAt: now,
      openedBy: req.user._id,
      puntoEmision: punto?._id || null,
      openingBalance,
      status: 'ABIERTA',
      notes: req.body.notes || '',
    });
    res.status(201).json(closing);
  } catch (e) { res.status(e.status || 400).json({ message: e.message, code: e.code }); }
};

/** Resumen del día (compatibilidad): ventas por método de pago (del punto del usuario, si tiene). */
exports.summary = async (req, res) => {
  try {
    const { start, end } = dayRange(req.query.date);
    const punto = await puntoDelUsuario(req.clinicId, req.user._id);
    const { byMethod, salesCount, totalSales } = await salesByMethod(req.clinicId, start, end, punto?._id || null);
    const lastFilter = { clinic: req.clinicId, status: 'CERRADO' };
    if (punto) lastFilter.puntoEmision = punto._id;
    const last = await CashClosing.findOne(lastFilter).sort({ date: -1 });
    res.json({ byMethod, salesCount, totalSales, suggestedOpening: last ? last.countedCash : 0, lastClosing: last });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/** Sucursales que el usuario puede elegir en el filtro del historial de cajas. */
exports.branches = async (req, res) => {
  try {
    const Clinic = require('../models/Clinic');
    const ids = clinicasVisibles(req);
    const clinics = await Clinic.find({ _id: { $in: ids } }).select('name').sort({ name: 1 }).lean();
    res.json({ clinics, current: String(req.clinicId), canSeeAll: veTodo(req) });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.list = async (req, res) => {
  try {
    // ?clinic=all → todas las sucursales visibles; ?clinic=<id> → esa (si es visible).
    const visibles = clinicasVisibles(req);
    let clinics = [String(req.clinicId)];
    if (req.query.clinic === 'all') clinics = visibles;
    else if (req.query.clinic && visibles.includes(String(req.query.clinic))) clinics = [String(req.query.clinic)];
    const filter = { clinic: { $in: clinics } };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.puntoEmision) filter.puntoEmision = req.query.puntoEmision;
    // Cajero y admin manejan SU caja: solo ven sus propias sesiones (ver soloPropias).
    if (soloPropias(req)) {
      filter.$or = [{ openedBy: req.user._id }, { closedBy: req.user._id }];
    }
    if (req.query.startDate || req.query.endDate) {
      filter.date = {};
      if (req.query.startDate) filter.date.$gte = localDate(req.query.startDate, '00:00:00');
      if (req.query.endDate) filter.date.$lte = localDate(req.query.endDate, '23:59:59.999');
    }
    const items = await CashClosing.find(filter)
      .populate('closedBy', 'name')
      .populate('openedBy', 'name')
      .populate('puntoEmision', PUNTO_FIELDS)
      .populate('clinic', 'name')
      .sort({ date: -1 })
      .limit(500);
    res.json(items);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

const r2 = (n) => +Number(n || 0).toFixed(2);
const horaEc = (d) => Number(new Date(d).toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'America/Guayaquil' })) % 24;
const TIPO_ITEM = { servicio: 'servicio', programa: 'programa' };

/** Ventana de una caja: de la apertura al cierre (o a ahora si sigue abierta). Los cierres
 *  antiguos de un solo paso no tienen apertura: cuadraban el día completo. */
const ventanaDeCaja = (closing) => {
  if (closing.openedAt) {
    return { start: new Date(closing.openedAt), end: closing.closedAt ? new Date(closing.closedAt) : new Date() };
  }
  return dayRange(closing.date);
};

/**
 * Detalle completo de una o VARIAS sesiones de caja: cada venta registrada en ellas (con su
 * factura), lo vendido por servicio/producto, los cobros por método, por hora, por quién vendió,
 * por doctor, por sucursal y por caja, y los movimientos de caja. Cada caja toma la misma
 * ventana y el mismo punto que su cuadre.
 *
 * `?add=id1,id2` suma otras cajas a la de la URL (solo super administrador): así se ve cuánto
 * se hizo en un día por sucursal. Una venta que caiga en dos cajas a la vez (p. ej. un cierre
 * antiguo de día completo y una caja por punto) se cuenta una sola vez.
 */
exports.detail = async (req, res) => {
  try {
    const extra = req.user.isSuperAdmin && req.query.add
      ? String(req.query.add).split(',').map((s) => s.trim()).filter((s) => mongoose.isValidObjectId(s))
      : [];
    const ids = [...new Set([String(req.params.id), ...extra])];
    const found = await CashClosing.find({ _id: { $in: ids }, clinic: { $in: clinicasVisibles(req) } })
      .populate('closedBy', 'name')
      .populate('openedBy', 'name')
      .populate('puntoEmision', PUNTO_FIELDS)
      .populate('clinic', 'name')
      .lean();
    const closing = found.find((c) => String(c._id) === String(req.params.id));
    if (!closing) return res.status(404).json({ message: 'Caja no encontrada' });
    const mine = [closing.openedBy?._id, closing.closedBy?._id].some((u) => u && String(u) === String(req.user._id));
    if (soloPropias(req) && !mine) {
      return res.status(403).json({ message: 'Solo puedes ver tus propias cajas' });
    }
    // La de la URL primero; las sumadas, por fecha.
    const closings = [closing, ...found.filter((c) => c !== closing).sort((a, b) => new Date(a.date) - new Date(b.date))];

    const vistas = new Set();
    const sales = [];
    let start = null; let end = null;
    for (const c of closings) {
      const w = ventanaDeCaja(c);
      if (!start || w.start < start) start = w.start;
      if (!end || w.end > end) end = w.end;
      const match = { clinic: c.clinic?._id || c.clinic, createdAt: { $gte: w.start, $lte: w.end } };
      if (c.puntoEmision?._id) match.puntoEmision = c.puntoEmision._id;
      const rows = await Sale.find(match)
        .select('saleNumber clientName clientCedula patient items subtotal discountTotal taxAmount total paymentMethod payments status invoice createdAt createdBy cashier doctor recommendedBy discountReason')
        .populate('invoice', 'estab ptoEmi secuencial estado')
        .populate('createdBy', 'name')
        .populate('doctor', 'name')
        .populate('recommendedBy', 'name')
        .lean();
      for (const s of rows) {
        if (vistas.has(String(s._id))) continue;
        vistas.add(String(s._id));
        sales.push({ ...s, _closing: c });
      }
    }
    sales.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    const ok = sales.filter((s) => s.status !== 'anulada');
    const anuladas = sales.filter((s) => s.status === 'anulada');

    const totals = { count: ok.length, subtotal: 0, discount: 0, tax: 0, total: 0, invoiced: 0, invoicedTotal: 0, voidedCount: anuladas.length, voidedTotal: 0 };
    const byMethod = {};
    const items = new Map();
    const byType = { servicio: { qty: 0, total: 0 }, programa: { qty: 0, total: 0 }, producto: { qty: 0, total: 0 } };
    const byHour = new Map();
    const bySeller = new Map();
    const byDoctor = new Map();
    const sumar = (map, key, label, total) => {
      const row = map.get(key) || { name: label, count: 0, total: 0 };
      row.count += 1; row.total += total;
      map.set(key, row);
    };
    const pagosDe = (s) => (s.payments?.length ? s.payments : [{ method: s.paymentMethod, amount: s.total }]);

    // Por sucursal y por caja: lo vendido y cómo se cobró.
    const fila = (name) => ({ name, count: 0, total: 0, efectivo: 0, tarjeta: 0, transferencia: 0, otros: 0 });
    const byClinic = new Map();
    const porCaja = new Map(closings.map((c) => [String(c._id), fila('')]));
    const sumarCobro = (row, s) => {
      row.count += 1; row.total += s.total || 0;
      for (const p of pagosDe(s)) {
        const k = ['efectivo', 'tarjeta', 'transferencia'].includes(p.method) ? p.method : 'otros';
        row[k] += p.amount || 0;
      }
    };

    for (const s of ok) {
      totals.subtotal += s.subtotal || 0;
      totals.discount += s.discountTotal || 0;
      totals.tax += s.taxAmount || 0;
      totals.total += s.total || 0;
      if (s.invoice?.estado === 'AUTORIZADO') { totals.invoiced += 1; totals.invoicedTotal += s.total || 0; }

      for (const p of pagosDe(s)) byMethod[p.method || 'otro'] = (byMethod[p.method || 'otro'] || 0) + (p.amount || 0);

      for (const it of s.items || []) {
        const tipo = TIPO_ITEM[it.category] || 'producto';
        const lineTotal = it.lineTotal || ((it.unitPrice || 0) * (it.quantity || 0) - (it.discount || 0));
        const key = String(it.product || it.productName);
        const row = items.get(key) || { product: it.product, code: it.productCode || '', name: it.productName || '—', type: tipo, qty: 0, total: 0, discount: 0, sales: 0 };
        row.qty += it.quantity || 0;
        row.total += lineTotal;
        row.discount += it.discount || 0;
        row.sales += 1;
        items.set(key, row);
        byType[tipo].qty += it.quantity || 0;
        byType[tipo].total += lineTotal;
      }

      const h = horaEc(s.createdAt);
      const hr = byHour.get(h) || { hour: h, count: 0, total: 0 };
      hr.count += 1; hr.total += s.total || 0;
      byHour.set(h, hr);
      sumar(bySeller, String(s.createdBy?._id || 'x'), s.createdBy?.name || 'Sin registrar', s.total || 0);
      if (s.doctor) sumar(byDoctor, String(s.doctor._id), s.doctor.name, s.total || 0);

      const clinicKey = String(s._closing.clinic?._id || s._closing.clinic);
      if (!byClinic.has(clinicKey)) byClinic.set(clinicKey, fila(s._closing.clinic?.name || 'Sucursal'));
      sumarCobro(byClinic.get(clinicKey), s);
      sumarCobro(porCaja.get(String(s._closing._id)), s);
    }
    for (const s of anuladas) totals.voidedTotal += s.total || 0;

    const redondear = (rows) => rows.map((r) => {
      const out = { ...r };
      for (const k of ['total', 'discount', 'efectivo', 'tarjeta', 'transferencia', 'otros']) if (out[k] != null) out[k] = r2(out[k]);
      return out;
    });
    const movements = await CashMovement.find({ cashSession: { $in: closings.map((c) => c._id) } })
      .sort({ date: 1 })
      .populate('counterpartAccount', 'code name')
      .populate('createdBy', 'name')
      .lean();

    res.json({
      closing,
      closings: closings.map((c) => ({
        _id: c._id,
        date: c.date,
        status: c.status,
        clinic: c.clinic?.name || '',
        punto: c.puntoEmision ? `${c.puntoEmision.establecimiento}-${c.puntoEmision.codigo}` : '',
        openedBy: c.openedBy?.name || '',
        closedBy: c.closedBy?.name || '',
        openedAt: c.openedAt || null,
        closedAt: c.closedAt || null,
        openingBalance: c.openingBalance || 0,
        expectedCash: c.expectedCash || 0,
        countedCash: c.countedCash || 0,
        difference: c.difference || 0,
        sales: redondear([porCaja.get(String(c._id))])[0],
      })),
      range: { start, end },
      totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, k.endsWith('Count') || k === 'count' || k === 'invoiced' ? v : r2(v)])),
      averageTicket: ok.length ? r2(totals.total / ok.length) : 0,
      byMethod: Object.entries(byMethod).map(([method, total]) => ({ method, total: r2(total) })).sort((a, b) => b.total - a.total),
      byType: Object.entries(byType).map(([type, v]) => ({ type, qty: v.qty, total: r2(v.total) })),
      items: redondear([...items.values()]).sort((a, b) => b.total - a.total),
      byHour: redondear([...byHour.values()]).sort((a, b) => a.hour - b.hour),
      bySeller: redondear([...bySeller.values()]).sort((a, b) => b.total - a.total),
      byDoctor: redondear([...byDoctor.values()]).sort((a, b) => b.total - a.total),
      byClinic: redondear([...byClinic.values()]).sort((a, b) => b.total - a.total),
      sales: sales.map((s) => ({
        _id: s._id,
        saleNumber: s.saleNumber,
        createdAt: s.createdAt,
        clinic: s._closing.clinic?.name || '',
        clientName: s.clientName,
        clientCedula: s.clientCedula,
        status: s.status,
        subtotal: s.subtotal,
        discount: s.discountTotal || 0,
        tax: s.taxAmount,
        total: s.total,
        payments: s.payments?.length ? s.payments.map((p) => ({ method: p.method, amount: p.amount, reference: p.method === 'transferencia' ? p.reference || '' : '' })) : [{ method: s.paymentMethod, amount: s.total }],
        invoice: s.invoice ? { _id: s.invoice._id, number: `${s.invoice.estab}-${s.invoice.ptoEmi}-${s.invoice.secuencial}`, estado: s.invoice.estado } : null,
        seller: s.createdBy?.name || '',
        doctor: s.doctor?.name || '',
        recommendedBy: s.recommendedBy?.name || '',
        discountReason: s.discountReason || '',
        items: (s.items || []).map((it) => ({ name: it.productName, type: TIPO_ITEM[it.category] || 'producto', qty: it.quantity, unitPrice: it.unitPrice, discount: it.discount || 0, total: it.lineTotal })),
      })),
      movements,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/**
 * Genera el asiento de ajuste por diferencia al cerrar caja.
 * Devuelve { entry, error }: si hay diferencia pero no se pudo generar el
 * asiento (p. ej. falta una cuenta o el período está cerrado), `error` trae el
 * motivo para avisar al usuario en vez de fallar en silencio. El cierre físico
 * de caja NO se bloquea por esto.
 */
const postDifferenceEntry = async (clinicId, closing, userId, session) => {
  const diff = closing.difference;
  if (!diff || Math.abs(diff) < 0.01) return { entry: null, error: null };
  await assertPeriodOpen(clinicId, closing.closedAt || new Date(), { session });
  const caja = await getAccount(clinicId, 'caja', { session });
    let lines;
    if (diff < 0) {
      // Faltante: pérdida (gasto) contra caja
      const faltante = await getAccount(clinicId, 'faltanteCaja', { session });
      const amount = +Math.abs(diff).toFixed(2);
      lines = [
        { account: faltante._id, debit: amount, credit: 0, description: 'Faltante de caja' },
        { account: caja._id, debit: 0, credit: amount, description: 'Faltante de caja' },
      ];
    } else {
      // Sobrante: ingreso contra caja
      const sobrante = await getAccount(clinicId, 'sobranteCaja', { session });
      const amount = +diff.toFixed(2);
      lines = [
        { account: caja._id, debit: amount, credit: 0, description: 'Sobrante de caja' },
        { account: sobrante._id, debit: 0, credit: amount, description: 'Sobrante de caja' },
      ];
    }
    const entry = await createEntry({
      clinicId, date: closing.closedAt || new Date(),
      description: `Ajuste cierre de caja ${closing.date.toISOString().slice(0, 10)}`,
      source: 'CIERRE', sourceRef: closing._id, sourceModel: 'CashClosing', sourceAction: 'DIFFERENCE',
      lines, userId, session,
    });
  return { entry, error: null };
};

/** Cierra la caja abierta indicada: cuenta efectivo y registra la diferencia. */
exports.close = async (req, res) => {
  try {
    {
      const closingId = await runInTransaction(async (session) => {
        const closing = await CashClosing.findOne({ _id: req.params.id, clinic: req.clinicId, status: 'ABIERTA' }).session(session);
        if (!closing) throw Object.assign(new Error('Caja abierta no encontrada'), { status: 404 });
        // El cajero solo cierra SU caja; admin/contabilidad pueden cerrar la de otro.
        if (req.role === 'cajero' && !req.user.isSuperAdmin && String(closing.openedBy) !== String(req.user._id)) {
          throw Object.assign(new Error('Solo puedes cerrar tu propia caja'), { status: 403 });
        }

        const closedAt = new Date();
        const countedCash = Number(req.body.countedCash) || 0;
        const { byMethod, salesCount, totalSales, expectedCash } = await resumenSesion(req.clinicId, closing, closedAt, session);
        const difference = +(countedCash - expectedCash).toFixed(2);

        closing.closedAt = closedAt;
        closing.closedBy = req.user._id;
        closing.expectedCash = expectedCash;
        closing.countedCash = countedCash;
        closing.difference = difference;
        closing.byMethod = byMethod;
        closing.salesCount = salesCount;
        closing.totalSales = totalSales;
        closing.denominations = req.body.denominations || [];
        if (req.body.notes) closing.notes = req.body.notes;
        closing.status = 'CERRADO';

        // El ajuste es del cajón de quien abrió la caja: con puntos se le atribuye a él (si lo
        // firmara el admin que cierra, aparecería en la caja abierta del admin).
        const ajusteUser = closing.puntoEmision ? closing.openedBy : req.user._id;
        const { entry } = await postDifferenceEntry(req.clinicId, closing, ajusteUser, session);
        if (entry) closing.journalEntry = entry._id;
        await closing.save({ session });
        return closing._id;
      });
      const closing = await CashClosing.findById(closingId);
      return res.json({ ...closing.toObject(), accountingWarning: null });
    }
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

/** Cierre directo (legacy de un solo paso, por día). Mantiene compatibilidad. */
exports.create = async (req, res) => {
  try {
    // Este cierre de un paso cuadra TODA la sucursal: con cajas por punto de venta no aplica.
    if (await sucursalUsaPuntos(req.clinicId)) {
      return res.status(400).json({ message: 'Esta sucursal trabaja con cajas por punto de venta: abre y cierra tu caja desde Cierre de caja.' });
    }
    {
      const closingId = await runInTransaction(async (session) => {
        const { date, openingBalance = 0, countedCash = 0, denominations = [], notes = '' } = req.body;
        const { start, end } = dayRange(date);
        const { byMethod, salesCount, totalSales } = await salesByMethod(req.clinicId, start, end);
        const expectedCash = +((Number(openingBalance) || 0) + byMethod.efectivo).toFixed(2);
        const difference = +((Number(countedCash) || 0) - expectedCash).toFixed(2);
        const [closing] = await CashClosing.create([{
          clinic: req.clinicId,
          date: start,
          closedAt: new Date(),
          openingBalance: Number(openingBalance) || 0,
          expectedCash,
          countedCash: Number(countedCash) || 0,
          difference,
          byMethod,
          salesCount,
          totalSales,
          denominations,
          notes,
          status: 'CERRADO',
          closedBy: req.user._id,
        }], { session });
        const { entry } = await postDifferenceEntry(req.clinicId, closing, req.user._id, session);
        if (entry) {
          closing.journalEntry = entry._id;
          await closing.save({ session });
        }
        return closing._id;
      });
      const closing = await CashClosing.findById(closingId);
      return res.status(201).json({ ...closing.toObject(), accountingWarning: null });
    }
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.cancel = async (req, res) => {
  try {
    const c = await CashClosing.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!c) return res.status(404).json({ message: 'No encontrado' });
    c.status = 'ANULADO';
    await c.save();
    res.json(c);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/**
 * Registra un movimiento de caja (ingreso vario, gasto/egreso de caja chica,
 * retiro) en la sesión abierta, con su asiento contra Caja.
 */
exports.addMovement = async (req, res) => {
  try {
    const ChartOfAccount = require('../models/ChartOfAccount');
    const movementId = await runInTransaction(async (session) => {
      const open = await CashClosing.findOne({ clinic: req.clinicId, status: 'ABIERTA', openedBy: req.user._id }).session(session);
      if (!open) throw Object.assign(new Error('No tienes una caja abierta'), { status: 400 });

      const { type, description } = req.body;
      if (!['INGRESO', 'EGRESO', 'GASTO', 'RETIRO', 'DEPOSITO'].includes(type)) {
        throw Object.assign(new Error('Tipo de movimiento inválido'), { status: 400 });
      }
      if (type === 'DEPOSITO') {
        throw Object.assign(new Error('Registra el traspaso desde Caja > Depósitos para vincularlo a una sola fuente de efectivo'), { status: 409, code: 'CASH_DEPOSIT_REQUIRED' });
      }
      const amount = +(Number(req.body.amount) || 0).toFixed(2);
      if (amount <= 0) throw Object.assign(new Error('Monto inválido'), { status: 400 });
      const date = req.body.date ? new Date(req.body.date) : new Date();
      await assertPeriodOpen(req.clinicId, date, { session });

      const caja = await getAccount(req.clinicId, 'caja', { session });
      const lines = [];
      let counterpartAccount = null;

      // Resolver cuenta contraparte (si la envían por id) o por defecto según el tipo.
      async function resolveCounterpart(defaultRole) {
        if (req.body.counterpartAccount) {
          const acc = await ChartOfAccount.findOne({ _id: req.body.counterpartAccount, clinic: req.clinicId }).session(session);
          if (acc) return acc;
        }
        return getAccount(req.clinicId, defaultRole, { session });
      }

      if (type === 'INGRESO') {
        counterpartAccount = await resolveCounterpart('otrosIngresos');
        lines.push({ account: caja._id, debit: amount, credit: 0, description: description || 'Ingreso a caja' });
        lines.push({ account: counterpartAccount._id, debit: 0, credit: amount, description: description || 'Ingreso a caja' });
      } else {
        // EGRESO / GASTO / RETIRO
        counterpartAccount = await resolveCounterpart('otrosGastos');
        lines.push({ account: counterpartAccount._id, debit: amount, credit: 0, description: description || type });
        lines.push({ account: caja._id, debit: 0, credit: amount, description: description || type });
      }

      const entry = await createEntry({
        clinicId: req.clinicId, date,
        description: description || `Movimiento de caja ${type}`,
        source: 'CAJA', sourceModel: 'CashMovement',
        lines, userId: req.user._id, session,
      });

      const [movement] = await CashMovement.create([{
        clinic: req.clinicId,
        cashSession: open._id,
        date,
        type,
        amount,
        description: description || '',
        counterpartAccount: counterpartAccount?._id || null,
        journalEntry: entry._id,
        createdBy: req.user._id,
      }], { session });

      // Vincular el asiento al movimiento de caja.
      entry.sourceRef = movement._id;
      await entry.save({ session });

      return movement._id;
    });
    const movement = await CashMovement.findById(movementId);
    res.status(201).json(movement);
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

/** Lista los movimientos de la sesión de caja abierta (o de una indicada por ?session=). */
exports.listMovements = async (req, res) => {
  try {
    let sessionId = req.query.session;
    if (!sessionId) {
      const open = await CashClosing.findOne({ clinic: req.clinicId, status: 'ABIERTA', openedBy: req.user._id }).select('_id');
      sessionId = open?._id;
    }
    if (!sessionId) return res.json([]);
    const items = await CashMovement.find({ clinic: req.clinicId, cashSession: sessionId })
      .sort({ date: -1 })
      .populate('counterpartAccount', 'code name')
      .populate('bankAccount', 'name');
    res.json(items);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

/** Anula un movimiento de caja: reversa su asiento y su movimiento bancario. */
exports.voidMovement = async (req, res) => {
  try {
    const { reverseEntry } = require('../utils/accounting');
    const BankTransaction = require('../models/BankTransaction');
    const result = await runInTransaction(async (session) => {
      const mov = await CashMovement.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!mov) throw Object.assign(new Error('Movimiento no encontrado'), { status: 404 });
      if (mov.voided) throw Object.assign(new Error('Ya anulado'), { status: 400 });
      const date = req.body.date ? new Date(req.body.date) : new Date();
      if (mov.journalEntry) {
        await reverseEntry({ clinicId: req.clinicId, entryId: mov.journalEntry, userId: req.user._id, reason: 'Anulación movimiento de caja', date, session });
      }
      if (mov.bankTransaction) {
        const tx = await BankTransaction.findById(mov.bankTransaction).session(session);
        if (tx && !tx.voided) {
          if (tx.reconciled) throw Object.assign(new Error('El depósito está conciliado: reabre la conciliación antes de anularlo'), { status: 409, code: 'BANK_RECONCILED' });
          tx.voided = true; tx.voidedAt = date; tx.voidedBy = req.user._id;
          await tx.save({ session });
          const BankAccount = require('../models/BankAccount');
          await BankAccount.updateOne(
            { _id: tx.bankAccount, clinic: req.clinicId },
            { $inc: { bookBalance: -(Number(tx.amount || 0) * Number(tx.direction || 0)) } },
            { session }
          );
        }
      }
      mov.voided = true;
      await mov.save({ session });
      return { message: 'Movimiento anulado' };
    });
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};
