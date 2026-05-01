require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('./models/User');
const Clinic = require('./models/Clinic');

const SUPER_EMAIL = 'admin@shiluv.com';
const SUPER_PASSWORD = 'Shiluv2026!';
const CLINIC_NAME = 'Shiluv';

const seed = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Conectado a MongoDB');

    // 1) Super-admin (idempotente)
    let user = await User.findOne({ email: SUPER_EMAIL });
    if (!user) {
      const salt = await bcrypt.genSalt(10);
      const password = await bcrypt.hash(SUPER_PASSWORD, salt);
      user = await User.create({
        name: 'Super Administrador Shiluv',
        email: SUPER_EMAIL,
        password,
        isSuperAdmin: true,
        clinics: [],
      });
      console.log(`Super-admin creado: ${SUPER_EMAIL} / ${SUPER_PASSWORD}`);
    } else {
      if (!user.isSuperAdmin) {
        user.isSuperAdmin = true;
        await user.save();
      }
      console.log(`Super-admin ya existe: ${SUPER_EMAIL}`);
    }

    // 2) Clínica Shiluv (renombrar la existente si ya hay una "Clínica Principal")
    let clinic =
      (await Clinic.findOne({ name: CLINIC_NAME })) ||
      (await Clinic.findOne({ ruc: '9999999999999' })) ||
      (await Clinic.findOne({ name: 'Clínica Principal' }));

    if (!clinic) {
      clinic = await Clinic.create({
        name: CLINIC_NAME,
        ruc: '9999999999999',
        razonSocial: 'SHILUV CIA. LTDA.',
        nombreComercial: 'Shiluv',
        address: 'Dirección por configurar',
        phone: '0000000000',
        email: 'contacto@shiluv.com',
        owner: user._id,
        active: true,
      });
      console.log('Clínica creada: Shiluv');
    } else {
      const updates = {};
      if (clinic.name !== CLINIC_NAME) updates.name = CLINIC_NAME;
      if (clinic.nombreComercial !== 'Shiluv') updates.nombreComercial = 'Shiluv';
      if (!clinic.razonSocial) updates.razonSocial = 'SHILUV CIA. LTDA.';
      if (Object.keys(updates).length) {
        Object.assign(clinic, updates);
        await clinic.save();
        console.log('Clínica actualizada a marca Shiluv');
      } else {
        console.log('Clínica Shiluv ya configurada');
      }
    }

    // 3) Asegurar acceso del super-admin a la clínica
    const hasClinic = (user.clinics || []).some(
      (c) => String(c.clinic) === String(clinic._id)
    );
    if (!hasClinic) {
      user.clinics.push({ clinic: clinic._id, role: 'admin' });
      await user.save();
      console.log('Super-admin asignado como admin de Shiluv');
    }

    console.log('\n───────────────────────────────────────────');
    console.log(' Acceso Super Admin');
    console.log(`    Email:    ${SUPER_EMAIL}`);
    console.log(`    Password: ${SUPER_PASSWORD}`);
    console.log('───────────────────────────────────────────');

    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
};

seed();
