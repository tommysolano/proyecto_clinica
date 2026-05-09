const Patient = require('../models/Patient');

// NOTA: los DATOS de los pacientes se comparten entre todas las clínicas
// (cédula única global). El campo `clinic` queda como referencia de la clínica
// donde se registró inicialmente, pero las consultas no filtran por clínica.

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
      patients,
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
    res.json(patient);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener paciente' });
  }
};

exports.createPatient = async (req, res) => {
  try {
    const existing = await Patient.findOne({ cedula: req.body.cedula });
    if (existing) {
      return res.status(400).json({ message: 'Ya existe un paciente con esa cédula' });
    }

    const patient = await Patient.create({ ...req.body, clinic: req.clinicId });
    res.status(201).json(patient);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear paciente', error: error.message });
  }
};

exports.updatePatient = async (req, res) => {
  try {
    const patient = await Patient.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!patient) return res.status(404).json({ message: 'Paciente no encontrado' });
    res.json(patient);
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
