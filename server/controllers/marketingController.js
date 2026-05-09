const mongoose = require('mongoose');
const Patient = require('../models/Patient');
const Treatment = require('../models/Treatment');
const Appointment = require('../models/Appointment');
const Sale = require('../models/Sale');
const Product = require('../models/Product');
const Referral = require('../models/Referral');

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

    const treatments = await Treatment.find({
      clinic: clinicObjId,
      status: 'activo',
    })
      .populate('patient', 'firstName lastName phone email whatsapp source')
      .sort({ updatedAt: 1 })
      .limit(200);

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
