const Patient = require('../models/Patient');

// NOTA: los DATOS de los pacientes se comparten entre todas las clínicas
// (cédula única global). El campo `clinic` queda como referencia de la clínica
// donde se registró inicialmente, pero las consultas no filtran por clínica.

// Campos sensibles que el rol "doctor" no debe ver ni editar.
const SENSITIVE_FIELDS_FOR_DOCTOR = ['cedula', 'address', 'phone', 'whatsapp', 'email'];

const sanitizeForRole = (patient, role) => {
  if (!patient || role !== 'doctor') return patient;
  const obj = patient.toObject ? patient.toObject() : { ...patient };
  SENSITIVE_FIELDS_FOR_DOCTOR.forEach((f) => {
    obj[f] = undefined;
  });
  return obj;
};

exports.getPatients = async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    const query = { active: true };

    if (search) {
      query.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
        { cedula: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ];
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
    res.status(201).json(patient);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear paciente', error: error.message });
  }
};

exports.updatePatient = async (req, res) => {
  try {
    const update = { ...req.body };
    // El doctor NO puede editar cédula, dirección, teléfono, whatsapp ni email.
    if (req.role === 'doctor') {
      SENSITIVE_FIELDS_FOR_DOCTOR.forEach((f) => delete update[f]);
    }
    const patient = await Patient.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    });
    if (!patient) return res.status(404).json({ message: 'Paciente no encontrado' });
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
