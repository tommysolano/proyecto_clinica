const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const Treatment = require('../models/Treatment');
const Appointment = require('../models/Appointment');
const Sale = require('../models/Sale');
const Product = require('../models/Product');
const Referral = require('../models/Referral');
const messaging = require('../utils/messaging');

/**
 * Dashboard global para el rol de marketing:
 * - tratamientos activos / completados
 * - servicio más faltante para completar tratamientos
 * - fuentes de pacientes (anuncio/referido/recepción/orgánico)
 * - estadísticas de citas: agendadas / asistidas / no asistieron / canceladas
 * - top derivaciones por doctor
 */
exports.dashboard = async (req, res) => {
  try {
    const clinicObjId = new mongoose.Types.ObjectId(req.clinicId);
    const { startDate, endDate } = req.query;
    const dateMatch = {};
    if (startDate && endDate) {
      dateMatch.$gte = new Date(startDate);
      dateMatch.$lte = new Date(endDate + 'T23:59:59.999');
    }

    // 1) Tratamientos: conteo por estado
    const treatmentsByStatus = await Treatment.aggregate([
      { $match: { clinic: clinicObjId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    // 2) Servicios faltantes agregados (item.quantity - item.completed) por producto
    const missingServices = await Treatment.aggregate([
      { $match: { clinic: clinicObjId, status: 'activo' } },
      { $unwind: '$items' },
      {
        $project: {
          product: '$items.product',
          name: '$items.name',
          missing: {
            $max: [{ $subtract: ['$items.quantity', '$items.completed'] }, 0],
          },
        },
      },
      { $group: { _id: '$product', name: { $first: '$name' }, missing: { $sum: '$missing' } } },
      { $match: { missing: { $gt: 0 } } },
      { $sort: { missing: -1 } },
      { $limit: 10 },
    ]);

    // 3) Fuentes de pacientes (source)
    const patientSources = await Patient.aggregate([
      { $match: { active: true, ...(Object.keys(dateMatch).length ? { createdAt: dateMatch } : {}) } },
      { $group: { _id: { $ifNull: ['$source', 'organico'] }, count: { $sum: 1 } } },
    ]);

    // 4) Estados de citas
    const apptMatch = { clinic: clinicObjId };
    if (Object.keys(dateMatch).length) apptMatch.date = dateMatch;
    const apptStats = await Appointment.aggregate([
      { $match: apptMatch },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    // 5) Pacientes con tratamiento incompleto (para campañas)
    const pendingTreatments = await Treatment.find({
      clinic: clinicObjId,
      status: 'activo',
    })
      .populate('patient', 'firstName lastName phone email source')
      .limit(50)
      .sort({ updatedAt: -1 });
    const pendingList = pendingTreatments
      .map((t) => ({
        treatmentId: t._id,
        name: t.name,
        progress: t.progress,
        patient: t.patient,
      }))
      .filter((t) => t.progress < 100);

    // 6) Derivaciones por doctor (top)
    const refsByDoctor = await Referral.aggregate([
      { $match: { clinic: clinicObjId } },
      { $group: { _id: '$fromDoctor', count: { $sum: 1 } } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'doctor' } },
      { $unwind: '$doctor' },
      { $project: { count: 1, name: '$doctor.name', specialty: '$doctor.specialty' } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]);

    res.json({
      treatmentsByStatus,
      missingServices,
      patientSources,
      apptStats,
      pendingList,
      refsByDoctor,
    });
  } catch (error) {
    res.status(500).json({ message: 'Error en dashboard de marketing', error: error.message });
  }
};

/**
 * Recordatorios: pacientes con tratamiento incompleto que no han venido en X días.
 * GET /api/marketing/reminders?daysSinceLastVisit=14
 */
exports.reminders = async (req, res) => {
  try {
    const clinicObjId = new mongoose.Types.ObjectId(req.clinicId);
    const days = Number(req.query.daysSinceLastVisit || 14);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    // Filtros opcionales por servicio o programa.
    const { service, program } = req.query;
    let serviceIds = null;
    if (program) {
      const prog = await Product.findById(program).select('programServices');
      const ids = (prog?.programServices || []).map((p) => p.product);
      if (ids.length) serviceIds = ids;
    } else if (service) {
      serviceIds = [new mongoose.Types.ObjectId(service)];
    }

    const treatmentMatch = { clinic: clinicObjId, status: 'activo' };
    if (serviceIds && serviceIds.length) {
      treatmentMatch['items.product'] = { $in: serviceIds };
    }

    const treatments = await Treatment.find(treatmentMatch)
      .populate('patient', 'firstName lastName phone email whatsapp source')
      .sort({ updatedAt: 1 })
      .limit(300);

    const reminders = [];
    for (const t of treatments) {
      if (t.progress >= 100) continue;
      // Última visita = última cita asistida/completada del paciente
      const last = await Appointment.findOne({
        clinic: clinicObjId,
        patient: t.patient?._id,
        status: { $in: ['asistida', 'completada'] },
      })
        .sort({ date: -1 })
        .select('date');
      const lastDate = last?.date || t.startDate;
      if (lastDate <= cutoff) {
        reminders.push({
          treatmentId: t._id,
          treatmentName: t.name,
          progress: t.progress,
          lastVisit: lastDate,
          daysSince: Math.floor(
            (Date.now() - new Date(lastDate).getTime()) / 86400000
          ),
          patient: t.patient,
          missingItems: (t.items || [])
            .filter((it) => (it.completed || 0) < it.quantity)
            .map((it) => ({
              name: it.name,
              missing: it.quantity - (it.completed || 0),
            })),
        });
      }
    }
    reminders.sort((a, b) => b.daysSince - a.daysSince);
    res.json({ cutoff, reminders });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener recordatorios', error: error.message });
  }
};

/**
 * Envío masivo de WhatsApp a pacientes ausentes (o cualquier lista).
 * Usa las credenciales de WhatsApp Cloud configuradas para la clínica.
 * Soporta el placeholder {{nombre}} en el mensaje.
 * POST /api/marketing/reminders/whatsapp
 * body: { recipients: [{ name, phone, whatsapp }], message }
 */
exports.sendBulkWhatsapp = async (req, res) => {
  try {
    const { recipients, message } = req.body;
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ message: 'No hay destinatarios seleccionados' });
    }
    const templateName = String(req.body.templateName || req.body.template?.name || '').trim();
    if (!message?.trim() && !templateName) {
      return res.status(400).json({ message: 'El mensaje o plantilla es requerido' });
    }
    const validRecipients = recipients.filter((r) => r && (r.phone || r.whatsapp));
    if (validRecipients.length === 0) {
      return res.status(400).json({ message: 'Ningún destinatario tiene teléfono/WhatsApp' });
    }
    const personalize = (tpl, r) =>
      String(tpl || '')
        .replace(/\{\{\s*nombre\s*\}\}/gi, r.name || '')
        .replace(/\{\{\s*name\s*\}\}/gi, r.name || '');

    const results = [];
    for (const r of validRecipients) {
      // eslint-disable-next-line no-await-in-loop
      const result = await messaging.send({
        clinicId: req.clinicId,
        channel: 'whatsapp',
        to: r.whatsapp || r.phone,
        contactName: r.name || '',
        patient: r.patient || r.patientId || r._id || null,
        body: message ? personalize(message, r) : '',
        template: templateName
          ? {
              name: templateName,
              language: req.body.templateLanguage || req.body.language || 'es',
              vars: req.body.templateVars || req.body.vars || [],
            }
          : null,
      });
      results.push({
        to: r.whatsapp || r.phone,
        ok: !!result.ok,
        skipped: !!result.skipped,
        reason: result.reason || '',
        deliveryStatus: result.deliveryStatus || '',
        errorCode: result.errorCode || '',
        errorMessage: result.errorMessage || '',
      });
    }
    const sent = results.filter((x) => x.ok).length;
    const skipped = results.filter((x) => x.skipped).length;
    const failed = results.length - sent - skipped;
    return res.json({ total: results.length, sent, failed, skipped, results });
  } catch (error) {
    res.status(500).json({ message: 'Error al enviar WhatsApp masivo', error: error.message });
  }
};

/**
 * Predicción simple por estacionalidad y tendencia (heurística estadística).
 * Devuelve por producto la "demanda esperada para el próximo mes", basándose
 * en ventas + citas históricas (últimos 12 meses).
 *
 * Si más adelante se conecta un servicio Python con sklearn, este endpoint
 * puede convertirse en un cliente HTTP de ese servicio.
 */
exports.predictions = async (req, res) => {
  try {
    const clinicObjId = new mongoose.Types.ObjectId(req.clinicId);
    const since = new Date();
    since.setMonth(since.getMonth() - 12);

    // Cantidad por producto y mes (basado en ventas)
    const byMonth = await Sale.aggregate([
      {
        $match: {
          clinic: clinicObjId,
          status: 'completada',
          createdAt: { $gte: since },
        },
      },
      { $unwind: '$items' },
      {
        $group: {
          _id: {
            product: '$items.product',
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
          },
          name: { $first: '$items.productName' },
          qty: { $sum: '$items.quantity' },
        },
      },
    ]);

    // Reagrupar por producto
    const map = new Map();
    byMonth.forEach((row) => {
      const id = String(row._id.product);
      if (!map.has(id))
        map.set(id, { product: id, name: row.name, monthly: [], total: 0 });
      map.get(id).monthly.push({ y: row._id.year, m: row._id.month, qty: row.qty });
      map.get(id).total += row.qty;
    });

    const now = new Date();
    const nextMonth = now.getMonth() + 2 > 12 ? 1 : now.getMonth() + 2;

    const predictions = [];
    for (const item of map.values()) {
      // Promedio últimos 3 meses
      item.monthly.sort((a, b) => (a.y - b.y) * 12 + (a.m - b.m));
      const last3 = item.monthly.slice(-3);
      const avg3 = last3.reduce((s, x) => s + x.qty, 0) / Math.max(last3.length, 1);
      // Promedio mismo mes de años anteriores (estacionalidad)
      const sameMonth = item.monthly.filter((x) => x.m === nextMonth);
      const seasonal =
        sameMonth.length > 0
          ? sameMonth.reduce((s, x) => s + x.qty, 0) / sameMonth.length
          : avg3;
      // Mezcla 70% reciente + 30% estacional
      const forecast = +(avg3 * 0.7 + seasonal * 0.3).toFixed(1);
      predictions.push({
        product: item.product,
        name: item.name,
        last12Total: item.total,
        last3MonthAvg: +avg3.toFixed(1),
        seasonalAvg: +seasonal.toFixed(1),
        forecastNextMonth: forecast,
      });
    }

    predictions.sort((a, b) => b.forecastNextMonth - a.forecastNextMonth);

    res.json({
      generatedAt: new Date(),
      method: 'heurística (3 meses + estacional). Para mayor precisión conecta un servicio Python con sklearn.',
      predictions: predictions.slice(0, 30),
    });
  } catch (error) {
    res
      .status(500)
      .json({ message: 'Error al calcular predicciones', error: error.message });
  }
};

// ============================================================================
// Helpers de rango temporal
// ============================================================================
function resolveRange(query) {
  const { range, startDate, endDate } = query || {};
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  let from, to;
  switch (range) {
    case 'today':
      from = today;
      to = tomorrow;
      break;
    case 'yesterday':
      from = new Date(today);
      from.setDate(from.getDate() - 1);
      to = today;
      break;
    case 'week': {
      from = new Date(today);
      from.setDate(from.getDate() - 6);
      to = tomorrow;
      break;
    }
    case 'month':
      from = new Date(today.getFullYear(), today.getMonth(), 1);
      to = tomorrow;
      break;
    case 'next7days': {
      from = today;
      to = new Date(today);
      to.setDate(to.getDate() + 7);
      break;
    }
    case 'custom':
    default:
      if (startDate) from = new Date(startDate);
      if (endDate) {
        to = new Date(endDate);
        to.setHours(23, 59, 59, 999);
      }
  }
  return { from, to };
}

/**
 * Servicios NO completados: tratamientos completados o abandonados con items
 * que quedaron con (completed < quantity). Para marketing: detectar fugas.
 * GET /api/marketing/incomplete-services
 */
exports.incompleteServices = async (req, res) => {
  try {
    const clinicObjId = new mongoose.Types.ObjectId(req.clinicId);
    const data = await Treatment.aggregate([
      { $match: { clinic: clinicObjId, status: { $in: ['abandonado', 'completado', 'activo'] } } },
      { $unwind: '$items' },
      {
        $project: {
          status: 1,
          patient: 1,
          treatmentName: '$name',
          product: '$items.product',
          name: '$items.name',
          missing: {
            $max: [{ $subtract: ['$items.quantity', '$items.completed'] }, 0],
          },
        },
      },
      { $match: { missing: { $gt: 0 } } },
      { $lookup: { from: 'patients', localField: 'patient', foreignField: '_id', as: 'pat' } },
      { $unwind: { path: '$pat', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: '$product',
          name: { $first: '$name' },
          totalMissing: { $sum: '$missing' },
          treatments: { $sum: 1 },
          abandoned: { $sum: { $cond: [{ $eq: ['$status', 'abandonado'] }, '$missing', 0] } },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completado'] }, '$missing', 0] } },
          activeMissing: { $sum: { $cond: [{ $eq: ['$status', 'activo'] }, '$missing', 0] } },
          patients: {
            $push: {
              _id: '$pat._id',
              name: { $trim: { input: { $concat: [{ $ifNull: ['$pat.firstName', ''] }, ' ', { $ifNull: ['$pat.lastName', ''] }] } } },
              phone: '$pat.phone',
              whatsapp: '$pat.whatsapp',
              cedula: '$pat.cedula',
              missing: '$missing',
              status: '$status',
              treatmentName: '$treatmentName',
            },
          },
        },
      },
      { $sort: { totalMissing: -1 } },
    ]);

    const list = data.map((d) => ({
      product: String(d._id),
      name: d.name,
      totalMissing: d.totalMissing,
      treatments: d.treatments,
      abandoned: d.abandoned,
      completed: d.completed,
      activeMissing: d.activeMissing,
      patients: (d.patients || []).filter((p) => p._id),
    }));
    res.json(list);
  } catch (error) {
    res.status(500).json({ message: 'Error en servicios no completados', error: error.message });
  }
};

/**
 * Evolución temporal de un servicio en particular (cuántas personas lo
 * contrataron por fecha). Toma ventas (facturadas) + citas que lo incluyen.
 * GET /api/marketing/service-evolution?service=<productId>&range=week|month|...
 */
exports.serviceEvolution = async (req, res) => {
  try {
    const clinicObjId = new mongoose.Types.ObjectId(req.clinicId);
    const { service } = req.query;
    if (!service) {
      return res.status(400).json({ message: 'Falta el parámetro service (productId).' });
    }
    const productId = new mongoose.Types.ObjectId(service);
    const { from, to } = resolveRange(req.query);
    const dateMatch = {};
    if (from) dateMatch.$gte = from;
    if (to) dateMatch.$lte = to;

    // Ventas
    const fromSales = await Sale.aggregate([
      {
        $match: {
          clinic: clinicObjId,
          ...(Object.keys(dateMatch).length ? { createdAt: dateMatch } : {}),
        },
      },
      { $unwind: '$items' },
      { $match: { 'items.product': productId } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          qty: { $sum: '$items.quantity' },
          patients: { $addToSet: '$patient' },
        },
      },
      { $project: { date: '$_id', qty: 1, uniquePatients: { $size: '$patients' }, _id: 0 } },
    ]);
    // Citas
    const fromAppts = await Appointment.aggregate([
      {
        $match: {
          clinic: clinicObjId,
          'services.product': productId,
          ...(Object.keys(dateMatch).length ? { date: dateMatch } : {}),
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
          qty: { $sum: 1 },
          patients: { $addToSet: '$patient' },
        },
      },
      { $project: { date: '$_id', qty: 1, uniquePatients: { $size: '$patients' }, _id: 0 } },
    ]);

    const map = new Map();
    const merge = (rows, key) => {
      for (const r of rows) {
        if (!map.has(r.date))
          map.set(r.date, { date: r.date, salesQty: 0, apptsQty: 0, patients: 0 });
        const entry = map.get(r.date);
        entry[key] += r.qty;
        entry.patients = Math.max(entry.patients, r.uniquePatients || 0);
      }
    };
    merge(fromSales, 'salesQty');
    merge(fromAppts, 'apptsQty');
    const series = [...map.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    const total = series.reduce(
      (acc, x) => ({
        sales: acc.sales + x.salesQty,
        appts: acc.appts + x.apptsQty,
      }),
      { sales: 0, appts: 0 }
    );
    const product = await Product.findById(productId).select('name code category');
    res.json({ product, range: { from, to }, series, total });
  } catch (error) {
    res.status(500).json({ message: 'Error en evolución de servicio', error: error.message });
  }
};

/**
 * Heatmap: agrupa pacientes por zona/dirección a partir de las facturas/ventas.
 * GET /api/marketing/heatmap
 */
exports.heatmap = async (req, res) => {
  try {
    const clinicObjId = new mongoose.Types.ObjectId(req.clinicId);
    const { GUAYAQUIL_ZONES, findZone } = require('../utils/guayaquilZones');
    const { from, to } = resolveRange(req.query);
    const { service, program } = req.query;

    const saleMatch = { clinic: clinicObjId };
    if (from || to) {
      saleMatch.createdAt = {};
      if (from) saleMatch.createdAt.$gte = from;
      if (to) saleMatch.createdAt.$lte = to;
    }

    // Filtros por programa/servicio: se aplican a items.product de la venta.
    let serviceIds = null;
    if (program) {
      const prog = await Product.findById(program).select('programServices');
      const ids = (prog?.programServices || []).map((p) => p.product);
      if (ids.length) serviceIds = ids;
    } else if (service) {
      serviceIds = [new mongoose.Types.ObjectId(service)];
    }
    if (serviceIds) {
      saleMatch['items.product'] = { $in: serviceIds };
    }

    // 1) Agrupar ventas por clientZone (zona registrada al facturar).
    const groupedByZone = await Sale.aggregate([
      { $match: { ...saleMatch, clientZone: { $exists: true, $ne: null, $ne: '' } } },
      {
        $group: {
          _id: '$clientZone',
          count: { $sum: 1 },
          patients: { $addToSet: '$patient' },
          total: { $sum: '$total' },
        },
      },
      { $project: { zone: '$_id', count: 1, uniquePatients: { $size: '$patients' }, total: 1, _id: 0 } },
    ]);

    // 2) Ventas sin zona registrada (para listar como "Otras direcciones").
    const groupedOther = await Sale.aggregate([
      {
        $match: {
          ...saleMatch,
          $or: [{ clientZone: { $exists: false } }, { clientZone: null }, { clientZone: '' }],
        },
      },
      {
        $group: {
          _id: { $ifNull: ['$clientAddress', 'Sin especificar'] },
          count: { $sum: 1 },
          patients: { $addToSet: '$patient' },
          total: { $sum: '$total' },
        },
      },
      { $project: { address: '$_id', count: 1, uniquePatients: { $size: '$patients' }, total: 1, _id: 0 } },
      { $sort: { count: -1 } },
    ]);

    const zonesMap = new Map();
    const other = [];
    for (const row of groupedByZone) {
      const z = findZone(row.zone);
      if (z) {
        if (!zonesMap.has(z.name))
          zonesMap.set(z.name, { ...z, count: 0, uniquePatients: 0, total: 0 });
        const entry = zonesMap.get(z.name);
        entry.count += row.count;
        entry.uniquePatients += row.uniquePatients;
        entry.total += row.total || 0;
      } else if (row.zone) {
        // Zona no reconocida -> registrar en "otras"
        other.push({ address: row.zone, count: row.count, uniquePatients: row.uniquePatients, total: row.total });
      }
    }
    for (const row of groupedOther) {
      if (row.address && row.address !== 'Sin especificar') other.push(row);
    }
    res.json({
      zones: GUAYAQUIL_ZONES.map(
        (z) => zonesMap.get(z.name) || { ...z, count: 0, uniquePatients: 0, total: 0 }
      ),
      other,
    });
  } catch (error) {
    res.status(500).json({ message: 'Error en heatmap', error: error.message });
  }
};

/**
 * Listado de zonas válidas de Guayaquil para autocompletar el campo "dirección"
 * cuando se factura.
 */
exports.guayaquilZones = async (_req, res) => {
  const { GUAYAQUIL_ZONES } = require('../utils/guayaquilZones');
  res.json(GUAYAQUIL_ZONES);
};

/**
 * Programas y los servicios a los que están ligados (qué packs contienen qué
 * servicios y cuántas veces se han vendido).
 * GET /api/marketing/programs
 */
exports.programs = async (req, res) => {
  try {
    const clinicObjId = new mongoose.Types.ObjectId(req.clinicId);
    const programs = await Product.find({
      clinic: clinicObjId,
      category: 'programa',
      active: true,
    })
      .populate('programServices.product', 'name code category')
      .lean();

    const programIds = programs.map((p) => p._id);

    // Conteo total de uso (todas las fechas)
    const salesCount = await Sale.aggregate([
      { $match: { clinic: clinicObjId } },
      { $unwind: '$items' },
      { $match: { 'items.product': { $in: programIds } } },
      { $group: { _id: '$items.product', count: { $sum: '$items.quantity' } } },
    ]);
    const salesMap = new Map(salesCount.map((s) => [String(s._id), s.count]));

    // Conteo por mes (últimos 12 meses)
    const oneYearAgo = new Date();
    oneYearAgo.setMonth(oneYearAgo.getMonth() - 11);
    oneYearAgo.setDate(1);
    oneYearAgo.setHours(0, 0, 0, 0);
    const monthly = await Sale.aggregate([
      { $match: { clinic: clinicObjId, createdAt: { $gte: oneYearAgo } } },
      { $unwind: '$items' },
      { $match: { 'items.product': { $in: programIds } } },
      {
        $group: {
          _id: {
            product: '$items.product',
            month: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          },
          count: { $sum: '$items.quantity' },
          revenue: { $sum: '$items.subtotal' },
        },
      },
      { $sort: { '_id.month': 1 } },
    ]);
    const monthlyMap = new Map();
    for (const m of monthly) {
      const key = String(m._id.product);
      if (!monthlyMap.has(key)) monthlyMap.set(key, []);
      monthlyMap.get(key).push({ month: m._id.month, count: m.count, revenue: +m.revenue.toFixed(2) });
    }

    const data = programs.map((p) => ({
      _id: p._id,
      name: p.name,
      code: p.code,
      services: (p.programServices || []).map((ps) => ({
        product: ps.product?._id,
        name: ps.product?.name,
        category: ps.product?.category,
        quantity: ps.quantity,
      })),
      timesSold: salesMap.get(String(p._id)) || 0,
      monthly: monthlyMap.get(String(p._id)) || [],
    }));
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: 'Error en programas', error: error.message });
  }
};

/**
 * Predicción de citas para la próxima semana:
 *   - cantidad por día
 *   - servicios más probables (basado en los servicios agendados ya y promedio histórico)
 * GET /api/marketing/next-week
 */
exports.nextWeek = async (req, res) => {
  try {
    const clinicObjId = new mongoose.Types.ObjectId(req.clinicId);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sevenAhead = new Date(today);
    sevenAhead.setDate(sevenAhead.getDate() + 7);

    // 1) Citas ya agendadas para los próximos 7 días
    const scheduled = await Appointment.aggregate([
      {
        $match: {
          clinic: clinicObjId,
          date: { $gte: today, $lte: sevenAhead },
          status: { $nin: ['cancelada'] },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // 2) Servicios más usados en las citas próximas
    const services = await Appointment.aggregate([
      {
        $match: {
          clinic: clinicObjId,
          date: { $gte: today, $lte: sevenAhead },
          status: { $nin: ['cancelada'] },
        },
      },
      { $unwind: '$services' },
      {
        $group: {
          _id: '$services.product',
          name: { $first: '$services.name' },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]);

    // 3) Promedio histórico: media de citas por día (últimos 4 semanas)
    const fourWeeksAgo = new Date(today);
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
    const historical = await Appointment.aggregate([
      {
        $match: {
          clinic: clinicObjId,
          date: { $gte: fourWeeksAgo, $lte: today },
        },
      },
      { $count: 'count' },
    ]);
    const histTotal = historical[0]?.count || 0;
    const historicalDailyAvg = +(histTotal / 28).toFixed(1);

    res.json({
      from: today,
      to: sevenAhead,
      scheduled,
      totalScheduled: scheduled.reduce((s, x) => s + x.count, 0),
      services,
      historicalDailyAvg,
      forecastNext7: Math.round(historicalDailyAvg * 7),
    });
  } catch (error) {
    res.status(500).json({ message: 'Error en next-week', error: error.message });
  }
};

/**
 * Estadísticas de citas con detalle: agendadas, asistieron, asistieron por call_center,
 * por doctor que atendió. Acepta filtro por rango y por servicio/programa.
 * GET /api/marketing/appointments-breakdown
 */
exports.appointmentsBreakdown = async (req, res) => {
  try {
    const clinicObjId = new mongoose.Types.ObjectId(req.clinicId);
    const { service, program } = req.query;
    const { from, to } = resolveRange(req.query);
    const match = { clinic: clinicObjId };
    if (from || to) {
      match.date = {};
      if (from) match.date.$gte = from;
      if (to) match.date.$lte = to;
    }
    if (service) match['services.product'] = new mongoose.Types.ObjectId(service);
    if (program) {
      // Si filtran por programa, expandir a sus servicios
      const prog = await Product.findById(program).select('programServices');
      const ids = (prog?.programServices || []).map((p) => p.product);
      if (ids.length) match['services.product'] = { $in: ids };
    }

    // Conteo por estado en una sola pasada (evita descuadres por consultas separadas).
    const statusAgg = await Appointment.aggregate([
      { $match: match },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const byStatus = {};
    statusAgg.forEach((s) => { byStatus[s._id || 'pendiente'] = s.count; });

    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const pendientes = (byStatus.pendiente || 0) + (byStatus.confirmada || 0);
    const asistidos = (byStatus.asistida || 0) + (byStatus.completada || 0);
    const noAsistidos = byStatus.no_asistio || 0;
    const canceladas = byStatus.cancelada || 0;

    // Pacientes nuevos (primera visita) dentro del rango/filtros.
    const nuevos = await Appointment.countDocuments({ ...match, isFirstVisit: true });
    const nuevosAsistidos = await Appointment.countDocuments({
      ...match,
      isFirstVisit: true,
      status: { $in: ['asistida', 'completada'] },
    });

    const porCallCenter = await Appointment.countDocuments({
      ...match,
      createdByRole: 'call_center',
    });
    const asistieronCallCenter = await Appointment.countDocuments({
      ...match,
      createdByRole: 'call_center',
      status: { $in: ['asistida', 'completada'] },
    });

    const byDoctor = await Appointment.aggregate([
      { $match: { ...match, status: { $in: ['asistida', 'completada'] } } },
      { $group: { _id: '$doctor', count: { $sum: 1 } } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'doctor' } },
      { $unwind: { path: '$doctor', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          count: 1,
          name: '$doctor.name',
          specialty: '$doctor.specialty',
        },
      },
      { $sort: { count: -1 } },
    ]);

    res.json({
      total,
      pendientes,
      asistidos,
      noAsistidos,
      canceladas,
      nuevos,
      nuevosAsistidos,
      // 'agendadas' = total sin canceladas (compatibilidad hacia atrás)
      agendadas: total - canceladas,
      asistieron: asistidos,
      porCallCenter,
      asistieronCallCenter,
      byStatus,
      byDoctor,
    });
  } catch (error) {
    res.status(500).json({ message: 'Error en breakdown', error: error.message });
  }
};

/**
 * Atribución / ROI por origen: agrupa pacientes captados por fuente + campaña
 * (atribución de anuncios click-to-WhatsApp) y suma los ingresos de ventas que
 * generaron. GET /api/marketing/attribution
 */
exports.attribution = async (req, res) => {
  try {
    const clinicObjId = new mongoose.Types.ObjectId(req.clinicId);
    const { from, to } = resolveRange(req.query);
    const match = { clinic: clinicObjId, active: true };
    if (from || to) {
      match.createdAt = {};
      if (from) match.createdAt.$gte = from;
      if (to) match.createdAt.$lte = to;
    }

    const groups = await Patient.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            source: { $ifNull: ['$source', 'organico'] },
            campaign: { $ifNull: ['$attribution.utmCampaign', ''] },
          },
          patients: { $sum: 1 },
          ids: { $push: '$_id' },
        },
      },
    ]);

    const allIds = groups.flatMap((g) => g.ids);
    const salesByPatient = allIds.length
      ? await Sale.aggregate([
          { $match: { clinic: clinicObjId, patient: { $in: allIds } } },
          { $group: { _id: '$patient', total: { $sum: '$total' } } },
        ])
      : [];
    const revMap = new Map(salesByPatient.map((s) => [String(s._id), s.total]));

    const rows = groups
      .map((g) => ({
        source: g._id.source || 'organico',
        campaign: g._id.campaign || '',
        patients: g.patients,
        revenue: +g.ids.reduce((sum, id) => sum + (revMap.get(String(id)) || 0), 0).toFixed(2),
      }))
      .sort((a, b) => b.revenue - a.revenue);

    const totals = rows.reduce(
      (acc, r) => ({ patients: acc.patients + r.patients, revenue: +(acc.revenue + r.revenue).toFixed(2) }),
      { patients: 0, revenue: 0 }
    );
    res.json({ range: { from, to }, rows, totals });
  } catch (error) {
    res.status(500).json({ message: 'Error en atribución', error: error.message });
  }
};

/**
 * Reportes de "quien refirió a quien": para cada paciente con source='referido',
 * devolver el nombre de quien lo refirió (sourceDetail).
 * GET /api/marketing/referrers
 */
exports.referrers = async (req, res) => {
  try {
    const clinicObjId = new mongoose.Types.ObjectId(req.clinicId);
    const { from, to } = resolveRange(req.query);
    const match = { clinic: clinicObjId, source: 'referido' };
    if (from || to) {
      match.createdAt = {};
      if (from) match.createdAt.$gte = from;
      if (to) match.createdAt.$lte = to;
    }

    const referrers = await Patient.aggregate([
      { $match: match },
      {
        $group: {
          _id: { $ifNull: ['$sourceDetail', 'Sin especificar'] },
          count: { $sum: 1 },
          patients: {
            $push: {
              _id: '$_id',
              name: { $concat: ['$firstName', ' ', '$lastName'] },
              cedula: '$cedula',
              createdAt: '$createdAt',
            },
          },
        },
      },
      { $sort: { count: -1 } },
      { $project: { referrer: '$_id', count: 1, patients: 1, _id: 0 } },
    ]);
    res.json(referrers);
  } catch (error) {
    res.status(500).json({ message: 'Error en referrers', error: error.message });
  }
};
