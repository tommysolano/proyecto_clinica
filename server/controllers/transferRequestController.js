/**
 * SOLICITUDES DE TRASLADO ENTRE BODEGAS (nov-2026). Ver models/TransferRequest.
 *
 *  - Pide: el usuario de un punto de emisión que tiene bodega (PuntoEmision.bodega). Los ítems
 *    van HACIA la bodega de su punto.
 *  - Atiende: administrador o contabilidad. Escoge la bodega de ORIGEN, puede ajustar las
 *    cantidades (0 = esa línea no se traslada) y aprueba: el traslado se ejecuta con el mismo
 *    núcleo que el traslado directo (`moverEntreBodegas`), en la MISMA transacción que marca la
 *    solicitud como aprobada. Si falta stock, no se mueve nada y la solicitud sigue pendiente.
 */
const mongoose = require('mongoose');
const TransferRequest = require('../models/TransferRequest');
const Warehouse = require('../models/Warehouse');
const Product = require('../models/Product');
const Counter = require('../models/Counter');
const Notification = require('../models/Notification');
const kardex = require('../utils/kardex');
const kardexService = require('../services/kardexService');
const { runInTransaction } = require('../utils/accounting');
const { puntoDelUsuario } = require('../services/puntoEmision');
const { moverEntreBodegas } = require('./inventoryAdvancedController');

const httpError = (status, message) => Object.assign(new Error(message), { status });
const fail = (res, e) => res.status(e.status || 500).json({ message: e.message });

/** Roles que atienden solicitudes: los mismos que hacen traslados directos. */
const ROLES_GESTION = ['admin', 'contabilidad', 'asistente_contable'];
const puedeGestionar = (req) => !!req.user?.isSuperAdmin || ROLES_GESTION.includes(req.role);

/** Sucursales de la empresa de la sucursal activa (las bodegas pueden estar en cualquiera). */
async function sucursalesEmpresa(clinicId) {
  const { ensureCompanyCache, sisterClinicsSync } = require('../utils/companies');
  await ensureCompanyCache();
  const ids = sisterClinicsSync(String(clinicId), { includeInactive: true });
  return (ids.length ? ids : [String(clinicId)]).map((id) => new mongoose.Types.ObjectId(String(id)));
}

/** Punto del usuario con su bodega poblada (o null). */
async function puntoConBodega(req) {
  const punto = await puntoDelUsuario(req.clinicId, req.user._id);
  if (!punto) return null;
  await punto.populate('bodega', 'code name active clinic');
  return punto;
}

const POPULATE = [
  { path: 'toWarehouse', select: 'code name' },
  { path: 'fromWarehouse', select: 'code name' },
  { path: 'items.fromWarehouse', select: 'code name' },
  { path: 'requestedBy', select: 'name' },
  { path: 'resolvedBy', select: 'name' },
  { path: 'puntoEmision', select: 'establecimiento codigo nombre' },
];

/** Lo que la pantalla necesita saber del usuario: si puede pedir (y a qué bodega) y si gestiona. */
exports.context = async (req, res) => {
  try {
    const punto = await puntoConBodega(req);
    const bodega = punto?.bodega && punto.bodega.active !== false ? punto.bodega : null;
    res.json({
      userId: String(req.user._id),
      canManage: puedeGestionar(req),
      canRequest: !!bodega,
      punto: punto ? { _id: punto._id, serie: `${punto.establecimiento}-${punto.codigo}`, nombre: punto.nombre } : null,
      bodega: bodega ? { _id: bodega._id, code: bodega.code, name: bodega.name } : null,
    });
  } catch (e) { fail(res, e); }
};

/**
 * MI BODEGA (nov-2026): la bodega del punto de emisión del usuario, en tiempo real. Por producto:
 * lo que dice el SISTEMA (capas vivas del kardex en esa bodega) y lo último contado en una TOMA
 * FÍSICA de esa bodega, con la diferencia. Solo cantidades (sin costos).
 * Lista los productos con stock o con conteo en la bodega; con ?todos=1, también los
 * inventariables del catálogo que están en cero.
 */
exports.myWarehouse = async (req, res) => {
  try {
    const punto = await puntoConBodega(req);
    const bodega = punto?.bodega && punto.bodega.active !== false ? punto.bodega : null;
    if (!bodega) throw httpError(404, 'Tu punto de emisión no tiene una bodega asignada.');
    const InventoryLayer = require('../models/InventoryLayer');
    const PhysicalCount = require('../models/PhysicalCount');

    const capas = await InventoryLayer.aggregate([
      { $match: { clinic: bodega.clinic, warehouse: bodega._id, qtyRemaining: { $ne: 0 } } },
      { $group: { _id: '$product', qty: { $sum: '$qtyRemaining' } } },
    ]);
    const sistema = new Map(capas.map((c) => [String(c._id), kardex.round4(c.qty)]));

    // Lo último contado de cada producto en esta bodega (tomas no anuladas, la más reciente manda).
    const tomas = await PhysicalCount.find({ warehouse: bodega._id, status: { $ne: 'ANULADO' } })
      .select('code date status items.product items.countedQty items.counted')
      .sort({ date: -1, createdAt: -1 })
      .limit(100)
      .lean();
    const fisico = new Map();
    for (const t of tomas) {
      for (const it of t.items || []) {
        if (!it.counted || fisico.has(String(it.product))) continue;
        fisico.set(String(it.product), { qty: kardex.round4(Number(it.countedQty) || 0), date: t.date, code: t.code, status: t.status });
      }
    }

    const { filtroCatalogo } = require('../utils/catalogoEmpresa');
    const filtroProd = { clinic: filtroCatalogo(req.clinicId) };
    if (req.query.todos === '1') {
      Object.assign(filtroProd, {
        active: { $ne: false }, disabled: { $ne: true }, unlimited: { $ne: true },
        category: { $nin: ['servicio', 'programa'] }, isComposite: { $ne: true },
      });
    } else {
      filtroProd._id = { $in: [...new Set([...sistema.keys(), ...fisico.keys()])].map((id) => new mongoose.Types.ObjectId(id)) };
    }
    const productos = await Product.find(filtroProd).select('code name category inventoryCategory').populate('inventoryCategory', 'name').lean();

    const items = productos.map((p) => {
      const id = String(p._id);
      const sis = sistema.get(id) || 0;
      const toma = fisico.get(id) || null;
      return {
        product: id, code: p.code || '', name: p.name || '',
        category: p.inventoryCategory?.name || p.category || '',
        sistema: sis,
        fisico: toma,
        diferencia: toma ? kardex.round4(toma.qty - sis) : null,
      };
    }).sort((a, b) => a.name.localeCompare(b.name, 'es'));

    res.json({
      bodega: { _id: bodega._id, code: bodega.code, name: bodega.name },
      punto: { serie: `${punto.establecimiento}-${punto.codigo}`, nombre: punto.nombre },
      actualizado: new Date(),
      items,
    });
  } catch (e) { fail(res, e); }
};

/** Quien gestiona ve todas las de la empresa; el resto, solo las suyas. Query: status?, mine? */
exports.list = async (req, res) => {
  try {
    const filtro = {};
    if (puedeGestionar(req) && req.query.mine !== '1') filtro.clinic = { $in: await sucursalesEmpresa(req.clinicId) };
    else filtro.requestedBy = req.user._id;
    if (['PENDIENTE', 'APROBADA', 'RECHAZADA', 'CANCELADA'].includes(req.query.status)) filtro.status = req.query.status;
    const items = await TransferRequest.find(filtro)
      .populate(POPULATE)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(req.query.limit) || 300, 1000))
      .lean();
    // Pendientes primero; dentro de cada grupo, lo más nuevo arriba (el sort es estable).
    items.sort((a, b) => (a.status === 'PENDIENTE' ? 0 : 1) - (b.status === 'PENDIENTE' ? 0 : 1));
    res.json(items);
  } catch (e) { fail(res, e); }
};

/** Nueva solicitud. body: { items: [{ product, quantity }], notes } */
exports.create = async (req, res) => {
  try {
    const punto = await puntoConBodega(req);
    if (!punto) throw httpError(400, 'No tienes un punto de emisión asignado: no puedes pedir traslados.');
    if (!punto.bodega || punto.bodega.active === false) {
      throw httpError(400, 'Tu punto de emisión no tiene una bodega asignada. Pide al administrador que se la asigne en Configuración SRI → Puntos de emisión.');
    }

    const crudas = Array.isArray(req.body.items) ? req.body.items : [];
    const lineas = [];
    const vistos = new Set();
    for (const it of crudas) {
      if (!it?.product || !mongoose.isValidObjectId(it.product)) throw httpError(400, 'Cada línea necesita un producto');
      const qty = kardex.round4(it.quantity);
      if (!(qty > 0)) throw httpError(400, 'La cantidad de cada producto debe ser mayor que cero');
      const key = String(it.product);
      if (vistos.has(key)) throw httpError(400, 'Hay un producto repetido: júntalo en una sola línea');
      vistos.add(key);
      lineas.push({ product: key, quantity: qty });
    }
    if (!lineas.length) throw httpError(400, 'Agrega al menos un producto con cantidad');

    const prods = await Product.find({
      _id: { $in: lineas.map((l) => l.product) },
      clinic: require('../utils/catalogoEmpresa').filtroCatalogo(req.clinicId),
    }).select('code name').lean();
    const porId = new Map(prods.map((p) => [String(p._id), p]));
    for (const l of lineas) if (!porId.has(l.product)) throw httpError(404, 'Hay un producto que no existe en el inventario de la empresa');

    const clinic = punto.bodega.clinic;
    const contador = await Counter.findOneAndUpdate(
      { clinic, key: 'transfer-request' },
      { $inc: { seq: 1 } },
      { upsert: true, new: true }
    );
    const code = `SOL-${String(contador.seq).padStart(6, '0')}`;

    const doc = await TransferRequest.create({
      clinic,
      requesterClinic: req.clinicId,
      code,
      puntoEmision: punto._id,
      toWarehouse: punto.bodega._id,
      items: lineas.map((l) => ({
        product: l.product, quantity: l.quantity,
        productCode: porId.get(l.product).code || '', productName: porId.get(l.product).name || '',
      })),
      notes: String(req.body.notes || '').trim().slice(0, 500),
      requestedBy: req.user._id,
    });

    // Aviso en la campana de quien atiende (admin/contabilidad de la sucursal de la bodega).
    await Notification.create({
      clinic,
      type: 'transfer_request_new',
      severity: 'info',
      title: `Solicitud de traslado ${code}`,
      body: `${req.user.name || 'Un usuario'} pide ${lineas.length === 1 ? '1 producto' : `${lineas.length} productos`} para ${punto.bodega.name}.`,
      meta: { requestId: String(doc._id) },
    }).catch(() => {});

    res.status(201).json(await TransferRequest.findById(doc._id).populate(POPULATE).lean());
  } catch (e) { fail(res, e); }
};

/** Aviso a quien pidió cuando se aprueba o se rechaza. */
async function avisarSolicitante(sol, aprobada, nombreQuien) {
  await Notification.create({
    clinic: sol.requesterClinic || sol.clinic,
    user: sol.requestedBy,
    type: 'transfer_request_resolved',
    severity: aprobada ? 'info' : 'warning',
    title: `Solicitud ${sol.code} ${aprobada ? 'aprobada' : 'rechazada'}`,
    body: aprobada
      ? `${nombreQuien} trasladó lo que pediste.`
      : `${nombreQuien} la rechazó${sol.resolutionNote ? `: ${sol.resolutionNote}` : '.'}`,
    meta: { requestId: String(sol._id) },
  }).catch(() => {});
}

/**
 * Aprobar = ejecutar el traslado.
 * body: { fromWarehouse, items: [{ product, quantity, fromWarehouse? }], date?, note? }
 * `items` es opcional: sin él se traslada exactamente lo pedido. Una cantidad 0 deja fuera esa línea.
 * `fromWarehouse` es la bodega PRINCIPAL; cada ítem puede salir de otra (nov-2026: un ítem que no
 * está en la principal pero sí en otra bodega). Se hace un traslado por bodega de origen, todos en
 * la misma transacción: o se trasladan todos o ninguno.
 */
exports.approve = async (req, res) => {
  try {
    if (!puedeGestionar(req)) throw httpError(403, 'Solo un administrador puede atender solicitudes de traslado');
    const sol = await TransferRequest.findOne({ _id: req.params.id, clinic: { $in: await sucursalesEmpresa(req.clinicId) } });
    if (!sol) throw httpError(404, 'Solicitud no encontrada');
    if (sol.status !== 'PENDIENTE') throw httpError(409, `La solicitud ya está ${sol.status.toLowerCase()}`);

    const { fromWarehouse } = req.body;
    if (!fromWarehouse || !mongoose.isValidObjectId(fromWarehouse)) throw httpError(400, 'Escoge la bodega desde la que sale el traslado');

    // Cantidades (y bodega de cada ítem) que diga quien aprueba, solo de productos pedidos.
    const ajustes = new Map((Array.isArray(req.body.items) ? req.body.items : [])
      .filter((i) => i?.product)
      .map((i) => [String(i.product), i]));
    const porOrigen = new Map(); // bodega de origen → líneas
    for (const it of sol.items) {
      const aj = ajustes.get(String(it.product));
      const qty = aj && aj.quantity !== undefined ? kardex.round4(aj.quantity) : kardex.round4(it.quantity);
      if (!Number.isFinite(qty) || qty < 0) throw httpError(400, `La cantidad de "${it.productName}" no es válida`);
      const propia = aj?.fromWarehouse && String(aj.fromWarehouse) !== String(fromWarehouse) ? String(aj.fromWarehouse) : null;
      if (propia && !mongoose.isValidObjectId(propia)) throw httpError(400, `La bodega de "${it.productName}" no es válida`);
      it.approvedQty = qty;
      it.fromWarehouse = qty > 0 ? propia : null;
      if (qty > 0) {
        const o = propia || String(fromWarehouse);
        if (!porOrigen.has(o)) porOrigen.set(o, []);
        porOrigen.get(o).push({ product: String(it.product), quantity: qty });
      }
    }
    if (!porOrigen.size) throw httpError(400, 'No hay nada que trasladar: todas las cantidades están en cero. Si no se va a atender, recházala.');

    // Cada bodega de origen (la principal y las de ítems sueltos) se valida igual.
    for (const o of new Set([String(fromWarehouse), ...porOrigen.keys()])) {
      if (o === String(sol.toWarehouse)) throw httpError(400, 'La bodega de origen no puede ser la misma que la de destino');
      const origen = await Warehouse.findOne({ _id: o, clinic: sol.clinic }).select('active name').lean();
      if (!origen) throw httpError(400, 'La bodega de origen no es de la misma sucursal que la bodega destino');
      if (origen.active === false) throw httpError(400, `La bodega ${origen.name} está inactiva`);
    }

    const fecha = kardexService.parseLocalDate(req.body.date) || new Date();
    const resolutionNote = String(req.body.note || '').trim().slice(0, 500);

    await runInTransaction(async (session) => {
      // Reclamo atómico: dos administradores aprobando a la vez no trasladan dos veces.
      const reclamada = await TransferRequest.findOneAndUpdate(
        { _id: sol._id, status: 'PENDIENTE' },
        { $set: { status: 'APROBADA', fromWarehouse, resolvedBy: req.user._id, resolvedAt: new Date(), resolutionNote } },
        { session, new: true }
      );
      if (!reclamada) throw httpError(409, 'Otra persona ya atendió esta solicitud');
      // Un traslado por bodega de origen; si a una le falta stock, no se mueve nada.
      const grupos = [];
      for (const [origenId, lineas] of porOrigen) {
        const r = await moverEntreBodegas({
          clinicId: sol.clinic, userId: req.user._id, fromWarehouse: origenId, toWarehouse: sol.toWarehouse,
          lineas, fecha, reason: `Solicitud ${sol.code}${sol.notes ? ` — ${sol.notes}` : ''}`,
        }, session);
        grupos.push(r.transferGroup);
      }
      await TransferRequest.updateOne(
        { _id: sol._id },
        { $set: { transferGroup: grupos[0], transferGroups: grupos, items: sol.items.map((i) => i.toObject()) } },
        { session }
      );
    });

    const hecha = await TransferRequest.findById(sol._id).populate(POPULATE).lean();
    await avisarSolicitante(hecha, true, req.user.name || 'Un administrador');
    res.json(hecha);
  } catch (e) { fail(res, e); }
};

/** Rechazar. body: { note } (motivo, obligatorio). */
exports.reject = async (req, res) => {
  try {
    if (!puedeGestionar(req)) throw httpError(403, 'Solo un administrador puede atender solicitudes de traslado');
    const note = String(req.body.note || '').trim().slice(0, 500);
    if (!note) throw httpError(400, 'Escribe el motivo del rechazo');
    const sol = await TransferRequest.findOneAndUpdate(
      { _id: req.params.id, clinic: { $in: await sucursalesEmpresa(req.clinicId) }, status: 'PENDIENTE' },
      { $set: { status: 'RECHAZADA', resolvedBy: req.user._id, resolvedAt: new Date(), resolutionNote: note } },
      { new: true }
    );
    if (!sol) throw httpError(409, 'La solicitud no existe o ya fue atendida');
    await avisarSolicitante(sol, false, req.user.name || 'Un administrador');
    res.json(await TransferRequest.findById(sol._id).populate(POPULATE).lean());
  } catch (e) { fail(res, e); }
};

/** Quien pidió retira su solicitud mientras siga pendiente. */
exports.cancel = async (req, res) => {
  try {
    const sol = await TransferRequest.findOneAndUpdate(
      { _id: req.params.id, requestedBy: req.user._id, status: 'PENDIENTE' },
      { $set: { status: 'CANCELADA', resolvedBy: req.user._id, resolvedAt: new Date() } },
      { new: true }
    );
    if (!sol) throw httpError(409, 'Solo puedes retirar tus solicitudes pendientes');
    res.json(await TransferRequest.findById(sol._id).populate(POPULATE).lean());
  } catch (e) { fail(res, e); }
};
