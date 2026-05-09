const TimeBlock = require('../models/TimeBlock');

exports.list = async (req, res) => {
  try {
    const { startDate, endDate, doctor } = req.query;
    const query = { clinic: req.clinicId };
    if (startDate && endDate) {
      query.$or = [
        { startDate: { $lte: new Date(endDate) }, endDate: { $gte: new Date(startDate) } },
      ];
    }
    if (doctor) query.doctor = doctor;
    const blocks = await TimeBlock.find(query)
      .populate('doctor', 'name')
      .populate('room', 'name')
      .populate('createdBy', 'name')
      .sort({ startDate: 1 });
    res.json(blocks);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener bloqueos', error: error.message });
  }
};

exports.create = async (req, res) => {
  try {
    const { startDate, endDate, allDay, startTime, endTime } = req.body;
    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'Fechas requeridas' });
    }
    const block = await TimeBlock.create({
      ...req.body,
      clinic: req.clinicId,
      doctor: req.body.doctor || null,
      room: req.body.room || null,
      allDay: !!allDay,
      startTime: allDay ? null : startTime || null,
      endTime: allDay ? null : endTime || null,
      createdBy: req.user._id,
    });
    res.status(201).json(block);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear bloqueo', error: error.message });
  }
};

exports.update = async (req, res) => {
  try {
    const block = await TimeBlock.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      req.body,
      { new: true }
    );
    if (!block) return res.status(404).json({ message: 'Bloqueo no encontrado' });
    res.json(block);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar bloqueo' });
  }
};

exports.remove = async (req, res) => {
  try {
    const block = await TimeBlock.findOneAndDelete({
      _id: req.params.id,
      clinic: req.clinicId,
    });
    if (!block) return res.status(404).json({ message: 'Bloqueo no encontrado' });
    res.json({ message: 'Bloqueo eliminado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar bloqueo' });
  }
};
