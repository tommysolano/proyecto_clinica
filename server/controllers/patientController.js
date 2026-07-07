const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const { emitToClinic } = require('../realtime');

// NOTA: los DATOS de los pacientes se comparten entre todas las clínicas
// (cédula única global). El campo `clinic` queda como referencia de la clínica
// donde se registró inicialmente, pero las consultas no filtran por clínica.

// Campos sensibles que el rol "doctor" no debe ver ni editar.
const SENSITIVE_FIELDS_FOR_DOCTOR = ['cedula', 'address', 'phone', 'whatsapp', 'email'];

const sanitizeForRole = (patient, role) => {
  if (!patient || (role !== 'doctor' && role !== 'optica')) return patient;
  const obj = patient.toObject ? patient.toObject() : { ...patient };
  SENSITIVE_FIELDS_FOR_DOCTOR.forEach((f) => {
    obj[f] = undefined;
  });
  return obj;
};

/**
 * Busca posibles "referidores": pacientes y personal (usuarios) registrados.
 * Usado por el selector "¿Quién lo refirió?" al crear un paciente.
 */
exports.searchReferralCandidates = async (req, res) => {
  try {
    const User = require('./../models/User');
    const q = (req.query.q || '').trim();
    const regex = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;

    const patientFilter = { active: true };
    if (regex) {
      patientFilter.$or = [
        { firstName: regex },
        { lastName: regex },
        { cedula: regex },
        { phone: regex },
      ];
    }
    const patients = await Patient.find(patientFilter)
      .select('firstName lastName cedula')
      .limit(15);

    const userFilter = { active: true, 'clinics.clinic': req.clinicId };
    if (regex) userFilter.$or = [{ name: regex }, { cedula: regex }, { email: regex }];
    const users = await User.find(userFilter).select('name cedula').limit(15);

    const results = [
      ...patients.map((p) => ({
        id: p._id,
        type: 'patient',
        name: `${p.firstName} ${p.lastName}`.trim(),
        detail: p.cedula || '',
      })),
      ...users.map((u) => ({
        id: u._id,
        type: 'user',
        name: u.name,
        detail: 'Personal',
      })),
    ];
    res.json(results);
  } catch (error) {
    res.status(500).json({ message: 'Error al buscar referidores', error: error.message });
  }
};


exports.getPatients = async (req, res) => {
  try {
    const { search, page = 1, limit = 20, isNew } = req.query;
    const query = { active: true };

    if (search) {
      query.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
        { cedula: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ];
    }

    if (isNew === 'true' || isNew === '1') {
      // "Nuevo" = paciente que aún NO ha sido atendido (sin cita asistida/completada).
      // Coincide con el concepto de "primera visita" usado en el resto del sistema.
      const attendedIds = await Appointment.distinct('patient', {
        status: { $in: ['asistida', 'completada'] },
      });
      query._id = { $nin: attendedIds.filter(Boolean) };
    }

    const patients = await Patient.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Patient.countDocuments(query);

    res.json({
      patients: patients.map((p) => sanitizeForRole(p, req.role)),
      total,
      pages: Math.ceil(total / limit),
      currentPage: parseInt(page),
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener pacientes' });
  }
};

exports.getPatient = async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ message: 'Paciente no encontrado' });
    res.json(sanitizeForRole(patient, req.role));
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener paciente' });
  }
};

/**
 * Historial de compras y aplicaciones del paciente, para el seguimiento.
 * Devuelve las ventas (qué compró, cuándo, quién lo recomendó) y el avance de
 * tratamientos (comprado vs aplicado vs restante — p.ej. cuántos sueros lleva).
 */
exports.getPatientPurchases = async (req, res) => {
  try {
    const Sale = require('../models/Sale');
    const Treatment = require('../models/Treatment');
    const patientId = req.params.id;

    const [sales, treatments] = await Promise.all([
      Sale.find({ clinic: req.clinicId, patient: patientId, status: { $ne: 'anulada' } })
        .populate('recommendedBy', 'name')
        .sort({ createdAt: -1 })
        .limit(200),
      Treatment.find({ clinic: req.clinicId, patient: patientId })
        .sort({ createdAt: -1 }),
    ]);

    const purchases = sales.map((s) => ({
      _id: s._id,
      saleNumber: s.saleNumber,
      date: s.createdAt,
      total: s.total,
      paymentMethod: s.paymentMethod,
      recommendedBy: s.recommendedBy ? s.recommendedBy.name : null,
      items: (s.items || []).map((i) => ({
        name: i.productName,
        quantity: i.quantity,
        category: i.category,
        subtotal: i.subtotal,
      })),
    }));

    const treatmentProgress = treatments.map((t) => ({
      _id: t._id,
      name: t.name,
      status: t.status,
      items: (t.items || []).map((it) => ({
        name: it.name || '',
        prescribed: it.quantity,
        applied: it.completed || 0,
        remaining: Math.max(0, (it.quantity || 0) - (it.completed || 0)),
      })),
    }));

    res.json({ purchases, treatments: treatmentProgress });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener compras del paciente', error: error.message });
  }
};

exports.createPatient = async (req, res) => {
  try {
    const cedula = (req.body.cedula || '').trim();
    if (cedula) {
      const existing = await Patient.findOne({ cedula });
      if (existing) {
        return res.status(400).json({ message: 'Ya existe un paciente con esa cédula' });
      }
    }

    const patient = await Patient.create({
      ...req.body,
      cedula,
      clinic: req.clinicId,
    });
    emitToClinic(req.clinicId, 'patient:created', { id: patient._id });
    res.status(201).json(patient);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear paciente', error: error.message });
  }
};

exports.updatePatient = async (req, res) => {
  try {
    const update = { ...req.body };
    // El doctor NO puede editar cédula, dirección, teléfono, whatsapp ni email.
    if (req.role === 'doctor' || req.role === 'optica') {
      SENSITIVE_FIELDS_FOR_DOCTOR.forEach((f) => delete update[f]);
    }
    const patient = await Patient.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    });
    if (!patient) return res.status(404).json({ message: 'Paciente no encontrado' });
    emitToClinic(req.clinicId, 'patient:updated', { id: patient._id });
    res.json(sanitizeForRole(patient, req.role));
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar paciente' });
  }
};

exports.deletePatient = async (req, res) => {
  try {
    const patient = await Patient.findByIdAndUpdate(
      req.params.id,
      { active: false },
      { new: true }
    );
    if (!patient) return res.status(404).json({ message: 'Paciente no encontrado' });
    res.json({ message: 'Paciente eliminado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar paciente' });
  }
};

/**
 * Etiquetado masivo de pacientes (para segmentación).
 * POST /api/patients/bulk-tag  body: { patientIds:[], add:[], remove:[] }
 */
exports.bulkTag = async (req, res) => {
  try {
    const { patientIds, add = [], remove = [] } = req.body;
    if (!Array.isArray(patientIds) || patientIds.length === 0) {
      return res.status(400).json({ message: 'Selecciona al menos un paciente' });
    }
    const toAdd = (add || []).map((t) => String(t).trim()).filter(Boolean);
    const toRemove = (remove || []).map((t) => String(t).trim()).filter(Boolean);
    if (!toAdd.length && !toRemove.length) {
      return res.status(400).json({ message: 'Indica etiquetas a agregar o quitar' });
    }
    const baseFilter = { _id: { $in: patientIds }, clinic: req.clinicId };
    let modified = 0;
    if (toAdd.length) {
      const r = await Patient.updateMany(baseFilter, { $addToSet: { tags: { $each: toAdd } } });
      modified = Math.max(modified, r.modifiedCount || 0);
      // Evento de dominio para el motor de workflows (trigger tag_added).
      const { emitDomainEvent, DOMAIN_EVENTS } = require('../utils/events');
      for (const pid of patientIds) {
        for (const tag of toAdd) {
          emitDomainEvent(DOMAIN_EVENTS.TAG_ADDED, {
            clinicId: String(req.clinicId),
            patientId: String(pid),
            tag,
          });
        }
      }
    }
    if (toRemove.length) {
      const r = await Patient.updateMany(baseFilter, { $pull: { tags: { $in: toRemove } } });
      modified = Math.max(modified, r.modifiedCount || 0);
    }
    res.json({ matched: patientIds.length, modified, add: toAdd, remove: toRemove });
  } catch (error) {
    res.status(500).json({ message: 'Error al etiquetar pacientes', error: error.message });
  }
};
