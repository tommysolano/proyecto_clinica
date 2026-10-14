/**
 * SESIONES PREPAGADAS (oct-2026). Ver models/PrepaidService.
 *
 * El ciclo es:
 *   1. Se COBRA (createSale): una línea de servicio marcada «para citas
 *      futuras» —o un PROGRAMA— deja un paquete con sus sesiones. Si la venta
 *      es de una cita que lleva ese servicio, esa cita gasta la primera.
 *   2. Se ASIGNA LA ATENCIÓN de otra cita (assignDoctor / markAttended): cada
 *      servicio de la cita que no esté pagado por su propia venta gasta una
 *      sesión de un paquete del paciente en la MISMA EMPRESA.
 *   3. Si la cita se cancela, se marca no asistida o se borra, su uso deja de
 *      contar (se calcula al leer: no hace falta engancharse a cada puerta por
 *      la que una cita cambia de estado).
 *   4. Anular la venta anula el paquete, salvo que ya se hayan usado sesiones
 *      en otras citas (como el saldo a favor: lo gastado no se puede devolver).
 */
const PrepaidService = require('../models/PrepaidService');

const ESTADOS_SIN_USO = new Set(['cancelada', 'no_asistio']);
// Citas que todavía pasan por «Asignar atención» (que es donde se gasta la sesión).
const POR_RECIBIR = new Set(['pendiente', 'confirmada', 'no_asistio']);
const idDe = (v) => (v ? String(v._id || v) : null);
const esServicio = (p) => p && (p.category === 'servicio' || p.unlimited === true);

/** Sucursales de la empresa de esta sucursal (ids). `null` = sin mapa de empresas: todas. */
async function sucursalesDeLaEmpresa(clinicId) {
  const { ensureCompanyCache, sisterClinicsSync } = require('./companies');
  await ensureCompanyCache();
  const hermanas = sisterClinicsSync(idDe(clinicId), { includeInactive: true });
  return hermanas.length ? hermanas : null;
}

/**
 * Productos del inventario de los servicios de cada cita (con repetición: una
 * cita con el mismo servicio dos veces necesita dos sesiones). Acepta citas con
 * el servicio poblado (con `product`) o en crudo; lo que falte se lee de una vez.
 * Devuelve Map(idCita → [idProducto]).
 */
async function productosDeCitas(citas) {
  const faltan = new Set();
  const refs = (apt) => [apt.serviceItem, ...(apt.additionalServices || []).map((x) => x.serviceItem)].filter(Boolean);
  for (const apt of citas) {
    for (const si of refs(apt)) if (!(si && typeof si === 'object' && 'product' in si)) faltan.add(idDe(si));
  }
  const productoDe = new Map();
  if (faltan.size) {
    const AppointmentServiceItem = require('../models/AppointmentServiceItem');
    const filas = await AppointmentServiceItem.find({ _id: { $in: [...faltan] } }).select('product').lean();
    for (const f of filas) productoDe.set(String(f._id), idDe(f.product));
  }
  const out = new Map();
  for (const apt of citas) {
    const lista = [];
    for (const si of refs(apt)) {
      const prod = si && typeof si === 'object' && 'product' in si ? idDe(si.product) : productoDe.get(idDe(si));
      if (prod) lista.push(prod);
    }
    out.set(idDe(apt._id), lista);
  }
  return out;
}

/** Conteo de ids: ['a','a','b'] → Map(a→2, b→1). */
const contar = (ids) => ids.reduce((m, id) => m.set(id, (m.get(id) || 0) + 1), new Map());

/**
 * Usos que CUENTAN de cada paquete: los de citas que existen y no están
 * canceladas ni marcadas como no asistidas, en orden de uso.
 * Devuelve Map(idPaquete → usos[]).
 */
async function usosVigentes(paquetes, session = null) {
  const ids = new Set();
  for (const p of paquetes) for (const u of p.uses || []) ids.add(String(u.appointment));
  const estado = new Map();
  if (ids.size) {
    const Appointment = require('../models/Appointment');
    const q = Appointment.find({ _id: { $in: [...ids] } }).select('status').lean();
    if (session) q.session(session);
    for (const a of await q) estado.set(String(a._id), a.status);
  }
  const out = new Map();
  for (const p of paquetes) {
    const vivos = (p.uses || [])
      .filter((u) => estado.has(String(u.appointment)) && !ESTADOS_SIN_USO.has(estado.get(String(u.appointment))))
      .sort((a, b) => new Date(a.usedAt) - new Date(b.usedAt));
    out.set(String(p._id), vivos);
  }
  return out;
}

/**
 * 1. AL COBRAR. `items` son las líneas ya armadas de la venta (con `prepaid`),
 * `productMap` el de createSale (producto completo por id). Va dentro de la
 * transacción de la venta.
 */
async function crearDesdeVenta({ sale, items, productMap, userId, session }) {
  if (!sale.patient) return [];
  const Product = require('../models/Product');
  const entradas = [];
  for (const it of items) {
    const prod = productMap.get(String(it.product));
    if (!prod) continue;
    if (prod.category === 'programa' && (prod.programServices || []).length) {
      for (const ps of prod.programServices) {
        const qty = Math.round(Number(ps.quantity || 1) * Number(it.quantity || 1));
        if (ps.product && qty > 0) entradas.push({ product: idDe(ps.product), qty, program: prod });
      }
    } else if (it.prepaid && esServicio(prod)) {
      entradas.push({ product: String(prod._id), qty: Number(it.quantity) || 0, name: prod.name });
    }
  }
  if (!entradas.length) return [];

  // Lo que la cita de este cobro lleva: esas sesiones se gastan hoy mismo.
  let cita = null;
  let deHoy = new Map();
  if (sale.appointment) {
    const Appointment = require('../models/Appointment');
    cita = await Appointment.findById(sale.appointment)
      .select('clinic serviceItem additionalServices isCanje isCortesia')
      .session(session)
      .lean();
    if (cita && !cita.isCanje && !cita.isCortesia) {
      deHoy = contar((await productosDeCitas([cita])).get(String(cita._id)) || []);
    }
  }

  const sinNombre = entradas.filter((e) => !e.name).map((e) => e.product);
  const nombres = new Map();
  if (sinNombre.length) {
    const prods = await Product.find({ _id: { $in: sinNombre } }).select('name').session(session).lean();
    for (const p of prods) nombres.set(String(p._id), p.name);
  }

  const docs = [];
  for (const e of entradas) {
    const hoy = Math.min(e.qty, deHoy.get(e.product) || 0);
    if (hoy) deHoy.set(e.product, deHoy.get(e.product) - hoy);
    // Todo se gasta hoy: no queda nada para después y no hace falta paquete.
    if (e.qty - hoy <= 0) continue;
    docs.push({
      clinic: sale.clinic,
      patient: sale.patient,
      product: e.product,
      productName: e.name || nombres.get(e.product) || '',
      program: e.program?._id || null,
      programName: e.program?.name || '',
      sale: sale._id,
      saleNumber: sale.saleNumber || '',
      appointment: cita?._id || null,
      quantity: e.qty,
      uses: Array.from({ length: hoy }, () => ({
        appointment: cita._id, clinic: cita.clinic, usedAt: new Date(), usedBy: userId,
      })),
      createdBy: userId,
    });
  }
  if (!docs.length) return [];
  return PrepaidService.insertMany(docs, { session });
}

/**
 * 2. AL RECIBIR AL PACIENTE (la cita pasa a asistida). Gasta una sesión por cada
 * servicio de la cita que no esté ya pagado (por la venta de la propia cita) ni
 * gastado. Idempotente. Devuelve [{productName, n, total}] de lo que gastó ahora.
 */
async function usarEnCita(apt, userId) {
  if (!apt || apt.isCanje || apt.isCortesia || !apt.patient) return [];
  const aptId = String(apt._id);
  const productos = (await productosDeCitas([apt])).get(aptId) || [];
  if (!productos.length) return [];
  const necesita = contar(productos);

  // Ya gastadas por esta cita.
  const conUso = await PrepaidService.find({ 'uses.appointment': apt._id, status: 'activo' }).lean();
  for (const p of conUso) {
    const n = (p.uses || []).filter((u) => String(u.appointment) === aptId).length;
    const k = String(p.product);
    if (necesita.has(k)) necesita.set(k, necesita.get(k) - n);
  }
  // Pagadas por la venta de la propia cita, en una línea normal (no de paquete).
  const Sale = require('../models/Sale');
  const ventas = await Sale.find({ appointment: apt._id, status: 'completada' }).select('items.product items.prepaid items.quantity').lean();
  for (const v of ventas) {
    for (const it of v.items || []) {
      if (it.prepaid) continue;
      const k = String(it.product);
      if (necesita.has(k)) necesita.set(k, necesita.get(k) - Number(it.quantity || 0));
    }
  }

  const sucursales = await sucursalesDeLaEmpresa(apt.clinic);
  const gastadas = [];
  for (const [product, falta] of necesita) {
    for (let i = 0; i < falta; i += 1) {
      const r = await gastarUna({ apt, product, sucursales, userId });
      if (!r) break;
      gastadas.push(r);
    }
  }
  return gastadas;
}

/** Gasta UNA sesión del paquete más antiguo con saldo. Reintenta si otro la tocó a la vez. */
async function gastarUna({ apt, product, sucursales, userId }) {
  for (let intento = 0; intento < 4; intento += 1) {
    const paquetes = await PrepaidService.find({
      patient: idDe(apt.patient),
      product,
      status: 'activo',
      ...(sucursales ? { clinic: { $in: sucursales } } : {}),
    }).sort({ createdAt: 1 }).lean();
    if (!paquetes.length) return null;
    const vigentes = await usosVigentes(paquetes);
    const paquete = paquetes.find((p) => p.quantity - vigentes.get(String(p._id)).length > 0);
    if (!paquete) return null;
    const vivos = vigentes.get(String(paquete._id));
    // Se guardan solo los usos vigentes: una cita cancelada suelta su sesión aquí.
    const uso = { appointment: apt._id, clinic: idDe(apt.clinic), usedAt: new Date(), usedBy: userId };
    const hecho = await PrepaidService.findOneAndUpdate(
      { _id: paquete._id, rev: paquete.rev || 0, status: 'activo' },
      { $set: { uses: [...vivos, uso] }, $inc: { rev: 1 } },
      { new: true }
    );
    if (hecho) return { productName: paquete.productName, n: vivos.length + 1, total: paquete.quantity };
  }
  return null;
}

/**
 * 4. AL ANULAR LA VENTA (dentro de su transacción). Si ya se usaron sesiones
 * en citas que no son la del cobro, no se deja: esas atenciones ya se dieron.
 */
async function anularDeVenta({ saleId, session }) {
  const paquetes = await PrepaidService.find({ sale: saleId, status: 'activo' }).session(session).lean();
  if (!paquetes.length) return;
  const vigentes = await usosVigentes(paquetes, session);
  for (const p of paquetes) {
    const otras = vigentes.get(String(p._id)).filter((u) => String(u.appointment) !== String(p.appointment || ''));
    if (otras.length) {
      throw Object.assign(
        new Error(`No se puede anular: ya se usaron ${otras.length} de las ${p.quantity} sesiones prepagadas de «${p.productName}» en otras citas.`),
        { status: 400, code: 'SESIONES_USADAS' }
      );
    }
  }
  await PrepaidService.updateMany(
    { _id: { $in: paquetes.map((p) => p._id) } },
    { $set: { status: 'anulado', voidedAt: new Date() } },
    { session }
  );
}

/**
 * PARA LA AGENDA. A cada cita (objeto plano) le añade:
 *   `sesiones`: [{product, productName, n, total}] — las sesiones prepagadas que
 *               usa («Sesión 2 de 5»). Para todos: no lleva importes.
 *   `prepago` (solo con `disponibles`): lo que el paciente tiene prepagado para
 *             los servicios de esta cita que aún no gastó —
 *             { cubre: [{product, productName, quedan, total}], todo: bool }.
 *             `todo` = no hace falta cobrar nada para asignar la atención.
 */
async function enriquecerCitas(citas, { disponibles = false } = {}) {
  if (!citas.length) return citas;
  const ids = citas.map((c) => idDe(c._id));
  const conUso = await PrepaidService.find({ 'uses.appointment': { $in: ids }, status: 'activo' }).lean();

  let paquetesDelPaciente = [];
  if (disponibles) {
    const pacientes = [...new Set(citas.map((c) => idDe(c.patient)).filter(Boolean))];
    if (pacientes.length) {
      paquetesDelPaciente = await PrepaidService.find({ patient: { $in: pacientes }, status: 'activo' }).lean();
    }
  }
  const todos = new Map();
  for (const p of [...conUso, ...paquetesDelPaciente]) todos.set(String(p._id), p);
  const vigentes = await usosVigentes([...todos.values()]);

  const usosPorCita = new Map();
  for (const p of todos.values()) {
    vigentes.get(String(p._id)).forEach((u, i) => {
      const k = String(u.appointment);
      if (!usosPorCita.has(k)) usosPorCita.set(k, []);
      usosPorCita.get(k).push({ product: String(p.product), productName: p.productName, n: i + 1, total: p.quantity });
    });
  }

  const productos = disponibles ? await productosDeCitas(citas) : new Map();
  const empresaDe = new Map();
  for (const c of citas) {
    const id = idDe(c._id);
    const sesiones = usosPorCita.get(id) || [];
    if (sesiones.length) c.sesiones = sesiones;
    if (!disponibles || !paquetesDelPaciente.length) continue;
    // Solo las que aún se van a recibir: una cita ya atendida no gasta sesiones.
    if (!POR_RECIBIR.has(c.status)) continue;
    const clinicId = idDe(c.clinic);
    if (!empresaDe.has(clinicId)) empresaDe.set(clinicId, await sucursalesDeLaEmpresa(clinicId));
    const sucursales = empresaDe.get(clinicId);
    const falta = contar(productos.get(id) || []);
    for (const s of sesiones) if (falta.has(s.product)) falta.set(s.product, falta.get(s.product) - 1);
    const pendientes = [...falta].filter(([, n]) => n > 0);
    if (!pendientes.length) continue;
    const cubre = [];
    let todo = true;
    for (const [product, n] of pendientes) {
      const suyos = paquetesDelPaciente.filter((p) =>
        String(p.patient) === idDe(c.patient) && String(p.product) === product &&
        (!sucursales || sucursales.includes(String(p.clinic))));
      const quedan = suyos.reduce((s, p) => s + Math.max(0, p.quantity - vigentes.get(String(p._id)).length), 0);
      if (quedan > 0) {
        const total = suyos.reduce((s, p) => s + p.quantity, 0);
        cubre.push({ product, productName: suyos[0].productName, quedan, total });
      }
      if (quedan < n) todo = false;
    }
    if (cubre.length) c.prepago = { cubre, todo };
  }
  return citas;
}

/** Paquetes de un paciente (perfil): con sus usos vigentes y la cita de cada uno. */
async function paquetesDelPaciente(patientId, sucursales) {
  const paquetes = await PrepaidService.find({
    patient: patientId,
    ...(sucursales ? { clinic: { $in: sucursales } } : {}),
  }).sort({ createdAt: -1 }).populate('clinic', 'name').lean();
  const vigentes = await usosVigentes(paquetes);
  const Appointment = require('../models/Appointment');
  const citaIds = [...new Set([...vigentes.values()].flat().map((u) => String(u.appointment)))];
  const citas = citaIds.length
    ? await Appointment.find({ _id: { $in: citaIds } }).select('date startTime clinic').populate('clinic', 'name').lean()
    : [];
  const citaDe = new Map(citas.map((c) => [String(c._id), c]));
  return paquetes.map((p) => {
    const usos = vigentes.get(String(p._id));
    return {
      _id: p._id,
      productName: p.productName,
      programName: p.programName,
      saleNumber: p.saleNumber,
      sale: p.sale,
      clinic: p.clinic?.name || '',
      createdAt: p.createdAt,
      status: p.status,
      quantity: p.quantity,
      usadas: usos.length,
      quedan: p.status === 'activo' ? Math.max(0, p.quantity - usos.length) : 0,
      usos: usos.map((u, i) => {
        const c = citaDe.get(String(u.appointment));
        return { n: i + 1, appointment: u.appointment, date: c?.date || u.usedAt, startTime: c?.startTime || '', clinic: c?.clinic?.name || '' };
      }),
    };
  });
}

module.exports = {
  crearDesdeVenta,
  usarEnCita,
  anularDeVenta,
  enriquecerCitas,
  paquetesDelPaciente,
  sucursalesDeLaEmpresa,
  productosDeCitas,
};
