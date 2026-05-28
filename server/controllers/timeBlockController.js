const TimeBlock = require('../models/TimeBlock');

// Normaliza una fecha 'YYYY-MM-DD' al inicio del día local (12:00 para evitar TZ).
const startOfLocalDay = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value;
  const str = String(value);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const [, y, mo, d] = m;
    return new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0);
  }
  return new Date(str);
};
// Para endDate: fin del día local para que cualquier hora del último día caiga dentro.
const endOfLocalDay = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value;
  const str = String(value);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const [, y, mo, d] = m;
    return new Date(Number(y), Number(mo) - 1, Number(d), 23, 59, 59, 999);
  }
  return new Date(str);
};

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
      startDate: startOfLocalDay(startDate),
      endDate: endOfLocalDay(endDate),
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
    const update = { ...req.body };
    if (update.startDate) update.startDate = startOfLocalDay(update.startDate);
    if (update.endDate) update.endDate = endOfLocalDay(update.endDate);
    const block = await TimeBlock.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      update,
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
