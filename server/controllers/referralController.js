const Referral = require('../models/Referral');

const POPULATE = [
  { path: 'patient', select: 'firstName lastName cedula' },
  { path: 'fromDoctor', select: 'name specialty' },
  { path: 'toDoctor', select: 'name specialty' },
  { path: 'appointment' },
];

exports.list = async (req, res) => {
  try {
    const { patient, fromDoctor, toDoctor, specialty, status, startDate, endDate, q } = req.query;
    const query = { clinic: req.clinicId };
    if (patient) query.patient = patient;
    if (fromDoctor) query.fromDoctor = fromDoctor;
    if (toDoctor) query.toDoctor = toDoctor;
    if (specialty) query.specialty = new RegExp(String(specialty).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (status) query.status = status;
    if (startDate && endDate) {
      query.date = { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999') };
    }

    // Si el rol es doctor, solo ve las que él emitió o recibió
    if (req.role === 'doctor') {
      query.$or = [{ fromDoctor: req.user._id }, { toDoctor: req.user._id }];
    }

    let referrals = await Referral.find(query).populate(POPULATE).sort({ date: -1 });

    // Filtro por texto en paciente (nombre/cédula)
    if (q && String(q).trim()) {
      const term = String(q).trim().toLowerCase();
      referrals = referrals.filter((r) => {
        const p = r.patient || {};
        return (
          (p.firstName || '').toLowerCase().includes(term) ||
          (p.lastName || '').toLowerCase().includes(term) ||
          (p.cedula || '').toLowerCase().includes(term)
        );
      });
    }

    res.json(referrals);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener derivaciones', error: error.message });
  }
};

exports.create = async (req, res) => {
  try {
    const referral = await Referral.create({
      ...req.body,
      clinic: req.clinicId,
      fromDoctor: req.body.fromDoctor || (req.role === 'doctor' ? req.user._id : undefined),
    });
    const populated = await Referral.findById(referral._id).populate(POPULATE);
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear derivación', error: error.message });
  }
};

exports.update = async (req, res) => {
  try {
    const update = { ...req.body };
    // Solo cajero/admin pueden cambiar el estado manualmente.
    // El doctor puede actualizar otros campos pero no el status.
    if (update.status !== undefined) {
      const isAdmin = req.user.isSuperAdmin || req.role === 'admin';
      const isCajero = req.role === 'cajero';
      if (!isAdmin && !isCajero) {
        delete update.status;
      }
    }
    const r = await Referral.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      update,
      { new: true }
    ).populate(POPULATE);
    if (!r) return res.status(404).json({ message: 'Derivación no encontrada' });
    res.json(r);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar derivación' });
  }
};

exports.remove = async (req, res) => {
  try {
    const r = await Referral.findOneAndDelete({
      _id: req.params.id,
      clinic: req.clinicId,
    });
    if (!r) return res.status(404).json({ message: 'Derivación no encontrada' });
    res.json({ message: 'Derivación eliminada' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar derivación' });
  }
};

/**
 * Estadísticas: derivaciones por doctor por día.
 */
exports.stats = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const clinicObjId = new mongoose.Types.ObjectId(req.clinicId);
    const { startDate, endDate } = req.query;
    const match = { clinic: clinicObjId };
    if (startDate && endDate) {
      match.date = { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999') };
    }
    const byDoctor = await Referral.aggregate([
      { $match: match },
      { $group: { _id: '$fromDoctor', count: { $sum: 1 } } },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'doctor' } },
      { $unwind: '$doctor' },
      { $project: { _id: 1, count: 1, name: '$doctor.name', specialty: '$doctor.specialty' } },
      { $sort: { count: -1 } },
    ]);
    const byDay = await Referral.aggregate([
      { $match: match },
      {
        $group: {
          _id: {
            doctor: '$fromDoctor',
            day: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { '_id.day': 1 } },
    ]);
    res.json({ byDoctor, byDay });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener estadísticas', error: error.message });
  }
};
