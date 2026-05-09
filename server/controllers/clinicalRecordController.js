const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');

/**
 * Obtiene la ficha clínica de un paciente. Si no existe la crea con datos
 * básicos copiados del paciente.
 */
exports.getOrCreateByPatient = async (req, res) => {
  try {
    const { patientId } = req.params;
    const patient = await Patient.findById(patientId);
    if (!patient) return res.status(404).json({ message: 'Paciente no encontrado' });

    let record = await ClinicalRecord.findOne({
      clinic: req.clinicId,
      patient: patientId,
    })
      .populate('followUps.createdBy', 'name')
      .populate('createdBy', 'name')
      .populate('updatedBy', 'name');

    if (!record) {
      // Edad calculada
      let edad;
      if (patient.birthDate) {
        const diff = Date.now() - new Date(patient.birthDate).getTime();
        edad = Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
      }
      record = await ClinicalRecord.create({
        clinic: req.clinicId,
        patient: patient._id,
        fecha: new Date(),
        nombre: `${patient.firstName} ${patient.lastName}`.trim(),
        direccion: patient.address || '',
        edad: edad ?? 0,
        cedula: patient.cedula,
        celular: patient.phone || '',
        tomaMedicamentos: { value: false, detail: '' },
        tieneAlergias: { value: false, detail: '' },
        tieneCirugias: { value: false, detail: '' },
        followUps: [],
        createdBy: req.user._id,
      });
    }

    res.json(record);
  } catch (error) {
    res
      .status(500)
      .json({ message: 'Error al obtener ficha clínica', error: error.message });
  }
};

exports.updateByPatient = async (req, res) => {
  try {
    const { patientId } = req.params;
    const patient = await Patient.findById(patientId);
    if (!patient) return res.status(404).json({ message: 'Paciente no encontrado' });

    const allowed = [
      'fecha',
      'nombre',
      'direccion',
      'edad',
      'cedula',
      'celular',
      'tomaMedicamentos',
      'tieneAlergias',
      'tieneCirugias',
    ];
    const update = { updatedBy: req.user._id };
    for (const k of allowed) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    }

    const record = await ClinicalRecord.findOneAndUpdate(
      { clinic: req.clinicId, patient: patientId },
      { $set: update, $setOnInsert: { createdBy: req.user._id } },
      { new: true, upsert: true, runValidators: true }
    );

    res.json(record);
  } catch (error) {
    res
      .status(500)
      .json({ message: 'Error al actualizar ficha clínica', error: error.message });
  }
};

exports.addFollowUp = async (req, res) => {
  try {
    const { patientId } = req.params;
    const { fecha, descripcion, valor, metodoPago } = req.body;

    if (!descripcion) {
      return res.status(400).json({ message: 'La descripción es requerida' });
    }

    const record = await ClinicalRecord.findOneAndUpdate(
      { clinic: req.clinicId, patient: patientId },
      {
        $push: {
          followUps: {
            fecha: fecha ? new Date(fecha) : new Date(),
            descripcion,
            valor: valor || 0,
            metodoPago: metodoPago || 'efectivo',
            createdBy: req.user._id,
          },
        },
        $setOnInsert: { createdBy: req.user._id },
      },
      { new: true, upsert: false }
    );

    if (!record) {
      return res
        .status(404)
        .json({ message: 'Primero debe crear la ficha clínica del paciente' });
    }

    res.status(201).json(record);
  } catch (error) {
    res.status(500).json({ message: 'Error al agregar seguimiento', error: error.message });
  }
};

exports.deleteFollowUp = async (req, res) => {
  try {
    const { patientId, followUpId } = req.params;

    const record = await ClinicalRecord.findOneAndUpdate(
      { clinic: req.clinicId, patient: patientId },
      { $pull: { followUps: { _id: followUpId } } },
      { new: true }
    );

    if (!record) return res.status(404).json({ message: 'Ficha no encontrada' });
    res.json(record);
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar seguimiento' });
  }
};
