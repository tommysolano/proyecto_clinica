/**
 * create-superadmin.js
 *
 * Crea (o actualiza) el usuario super administrador en la base de datos.
 * Ejecutar UNA SOLA VEZ después de hacer el deploy del backend:
 *
 *   node create-superadmin.js
 *
 * Requiere que MONGODB_URI esté en .env o como variable de entorno del sistema.
 *
 * Ejemplo en la shell de Render:
 *   MONGODB_URI="mongodb+srv://..." ADMIN_EMAIL="admin@tuclinica.com" ADMIN_PASSWORD="SuperSegura123!" node create-superadmin.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_NAME = process.env.ADMIN_NAME || 'Super Admin';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@clinica.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!MONGODB_URI) {
  console.error('❌  Falta MONGODB_URI en las variables de entorno.');
  process.exit(1);
}
if (!ADMIN_PASSWORD) {
  console.error('❌  Falta ADMIN_PASSWORD. Pásala como variable de entorno.');
  process.exit(1);
}
if (ADMIN_PASSWORD.length < 8) {
  console.error('❌  ADMIN_PASSWORD debe tener al menos 8 caracteres.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('✅  Conectado a MongoDB');

  // Carga el modelo directamente para no depender del orden de módulos
  const userSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true, lowercase: true },
    password: String,
    isSuperAdmin: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    clinics: { type: Array, default: [] },
  });
  const User = mongoose.models.User || mongoose.model('User', userSchema);

  const hashed = await bcrypt.hash(ADMIN_PASSWORD, 12);

  const existing = await User.findOne({ email: ADMIN_EMAIL.toLowerCase() });
  if (existing) {
    existing.name = ADMIN_NAME;
    existing.password = hashed;
    existing.isSuperAdmin = true;
    existing.active = true;
    await existing.save();
    console.log(`✅  Super admin actualizado: ${ADMIN_EMAIL}`);
  } else {
    await User.create({
      name: ADMIN_NAME,
      email: ADMIN_EMAIL.toLowerCase(),
      password: hashed,
      isSuperAdmin: true,
      active: true,
      clinics: [],
    });
    console.log(`✅  Super admin creado: ${ADMIN_EMAIL}`);
  }

  await mongoose.disconnect();
  console.log('✅  Listo. Ya puedes iniciar sesión con ese email y contraseña.');
}

main().catch((err) => {
  console.error('❌  Error:', err.message);
  process.exit(1);
});
