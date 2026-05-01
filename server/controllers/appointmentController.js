const Appointment = require('../models/Appointment');

exports.getAppointments = async (req, res) => {
  try {
    const { startDate, endDate, doctor, status } = req.query;
    const query = { clinic: req.clinicId };

    if (startDate && endDate) {
      query.date = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }
    if (doctor) query.doctor = doctor;
    if (status) query.status = status;

    if (req.role === 'doctor') {
      query.doctor = req.user._id;
    }

    const appointments = await Appointment.find(query)
      .populate('patient', 'firstName lastName cedula phone whatsapp')
      .populate('doctor', 'name specialty')
      .sort({ date: 1, startTime: 1 });

    res.json(appointments);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener citas' });
  }
};

exports.getAppointment = async (req, res) => {
  try {
    const appointment = await Appointment.findOne({ _id: req.params.id, clinic: req.clinicId })
      .populate('patient', 'firstName lastName cedula phone whatsapp email birthDate gender')
      .populate('doctor', 'name specialty');

    if (!appointment) return res.status(404).json({ message: 'Cita no encontrada' });
    res.json(appointment);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener cita' });
  }
};

exports.createAppointment = async (req, res) => {
  try {
    const { doctor, date, startTime, endTime } = req.body;

    const conflict = await Appointment.findOne({
      clinic: req.clinicId,
      doctor,
      date: new Date(date),
      status: { $nin: ['cancelada', 'no_asistio'] },
      $or: [{ startTime: { $lt: endTime }, endTime: { $gt: startTime } }],
    });

    if (conflict) {
      return res.status(400).json({ message: 'El doctor ya tiene una cita en ese horario' });
    }

    const appointment = await Appointment.create({
      ...req.body,
      clinic: req.clinicId,
      createdBy: req.user._id,
    });

    const populated = await appointment
      .populate('patient', 'firstName lastName cedula phone')
      .then((doc) => doc.populate('doctor', 'name specialty'));

    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear cita', error: error.message });
  }
};

exports.updateAppointment = async (req, res) => {
  try {
    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      req.body,
      { new: true, runValidators: true }
    )
      .populate('patient', 'firstName lastName cedula phone')
      .populate('doctor', 'name specialty');

    if (!appointment) return res.status(404).json({ message: 'Cita no encontrada' });
    res.json(appointment);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar cita' });
  }
};

exports.deleteAppointment = async (req, res) => {
  try {
    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      { status: 'cancelada' },
      { new: true }
    );
    if (!appointment) return res.status(404).json({ message: 'Cita no encontrada' });
    res.json({ message: 'Cita cancelada' });
  } catch (error) {
    res.status(500).json({ message: 'Error al cancelar cita' });
  }
};

exports.getTodayAppointments = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const query = {
      clinic: req.clinicId,
      date: { $gte: today, $lt: tomorrow },
    };

    if (req.role === 'doctor') {
      query.doctor = req.user._id;
    }

    const appointments = await Appointment.find(query)
      .populate('patient', 'firstName lastName cedula phone')
      .populate('doctor', 'name specialty')
      .sort({ startTime: 1 });

    res.json(appointments);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener citas del día' });
  }
};
