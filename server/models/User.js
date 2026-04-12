const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'El nombre es requerido'],
    trim: true,
  },
  email: {
    type: String,
    required: [true, 'El email es requerido'],
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: [true, 'La contraseña es requerida'],
    minlength: 6,
  },
  role: {
    type: String,
    enum: ['admin', 'recepcionista', 'doctor'],
    default: 'recepcionista',
  },
  specialty: {
    type: String,
    trim: true,
  },
  phone: {
    type: String,
    trim: true,
  },
  active: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
