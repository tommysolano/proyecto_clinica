const AccessBlock = require('../models/AccessBlock');
const { invalidate } = require('../utils/accessControl');

// Normaliza y valida el cuerpo de una regla.
const sanitize = (body) => {
  const mode = body.mode === 'date' ? 'date' : 'recurring';
  const allDay = !!body.allDay;
  const weekdays = Array.isArray(body.weekdays)
    ? [...new Set(body.weekdays.map((n) => Number(n)).filter((n) => n >= 0 && n <= 6))]
    : [];
  const exceptUsers = Array.isArray(body.exceptUsers)
    ? body.exceptUsers.filter(Boolean)
    : [];
  const timeRe = /^([01]?\d|2[0-3]):[0-5]\d$/;
  const startTime = timeRe.test(body.startTime) ? body.startTime : '19:00';
  const endTime = timeRe.test(body.endTime) ? body.endTime : '06:00';
  return {
    name: String(body.name || '').trim(),
    active: body.active === undefined ? true : !!body.active,
    mode,
    weekdays: mode === 'recurring' ? weekdays : [],
    date: mode === 'date' ? String(body.date || '').slice(0, 10) : '',
    allDay,
    startTime: allDay ? '00:00' : startTime,
    endTime: allDay ? '23:59' : endTime,
    exceptUsers,
  };
};

exports.getAccessBlocks = async (req, res) => {
  try {
    const list = await AccessBlock.find()
      .populate('exceptUsers', 'name email')
      .sort({ createdAt: -1 });
    res.json(list);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener bloqueos de acceso', error: error.message });
  }
};

exports.createAccessBlock = async (req, res) => {
  try {
    const data = sanitize(req.body);
    if (data.mode === 'date' && !data.date) {
      return res.status(400).json({ message: 'Selecciona una fecha para el bloqueo' });
    }
    const block = await AccessBlock.create({ ...data, createdBy: req.user._id });
    invalidate();
    const populated = await AccessBlock.findById(block._id).populate('exceptUsers', 'name email');
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear bloqueo de acceso', error: error.message });
  }
};

exports.updateAccessBlock = async (req, res) => {
  try {
    const data = sanitize(req.body);
    if (data.mode === 'date' && !data.date) {
      return res.status(400).json({ message: 'Selecciona una fecha para el bloqueo' });
    }
    const block = await AccessBlock.findByIdAndUpdate(req.params.id, data, {
      new: true,
      runValidators: true,
    }).populate('exceptUsers', 'name email');
    if (!block) return res.status(404).json({ message: 'Bloqueo no encontrado' });
    invalidate();
    res.json(block);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar bloqueo de acceso', error: error.message });
  }
};

exports.deleteAccessBlock = async (req, res) => {
  try {
    const block = await AccessBlock.findByIdAndDelete(req.params.id);
    if (!block) return res.status(404).json({ message: 'Bloqueo no encontrado' });
    invalidate();
    res.json({ message: 'Bloqueo eliminado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar bloqueo de acceso', error: error.message });
  }
};
