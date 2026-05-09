const Room = require('../models/Room');

exports.list = async (req, res) => {
  try {
    const rooms = await Room.find({ clinic: req.clinicId, active: true })
      .populate('manager', 'name email')
      .sort({ name: 1 });
    res.json(rooms);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener consultorios', error: error.message });
  }
};

exports.create = async (req, res) => {
  try {
    const room = await Room.create({ ...req.body, clinic: req.clinicId });
    res.status(201).json(room);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear consultorio', error: error.message });
  }
};

exports.update = async (req, res) => {
  try {
    const room = await Room.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      req.body,
      { new: true, runValidators: true }
    );
    if (!room) return res.status(404).json({ message: 'Consultorio no encontrado' });
    res.json(room);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar consultorio', error: error.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const room = await Room.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      { active: false },
      { new: true }
    );
    if (!room) return res.status(404).json({ message: 'Consultorio no encontrado' });
    res.json({ message: 'Consultorio desactivado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar consultorio' });
  }
};
