require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('./models/User');

const seed = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Conectado a MongoDB');

    const existing = await User.findOne({ email: 'admin@clinica.com' });
    if (existing) {
      console.log('El usuario admin ya existe');
      process.exit(0);
    }

    const salt = await bcrypt.genSalt(10);
    const password = await bcrypt.hash('admin123', salt);

    await User.create({
      name: 'Administrador',
      email: 'admin@clinica.com',
      password,
      role: 'admin',
    });

    console.log('Usuario admin creado: admin@clinica.com / admin123');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
};

seed();
