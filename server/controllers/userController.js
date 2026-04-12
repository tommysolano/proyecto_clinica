const bcrypt = require('bcryptjs');
const User = require('../models/User');

exports.getUsers = async (req, res) => {
  try {
    const users = await User.find().select('-password').sort({ createdAt: -1 });
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener usuarios' });
  }
};

exports.getUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener usuario' });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { name, email, role, specialty, phone, active } = req.body;
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { name, email, role, specialty, phone, active },
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar usuario' });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { active: false },
      { new: true }
    );
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json({ message: 'Usuario desactivado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar usuario' });
  }
};

exports.getDoctors = async (req, res) => {
  try {
    const doctors = await User.find({ role: 'doctor', active: true })
      .select('-password')
      .sort({ name: 1 });
    res.json(doctors);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener doctores' });
  }
};
