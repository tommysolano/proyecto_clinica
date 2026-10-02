/**
 * Prepara el catálogo de SERVICIOS DE AGENDA en cada despliegue.
 *
 * Hasta sep-2026 sembraba una lista fija de nombres que el equipo usaba. Desde
 * oct-2026 lo que se ofrece al agendar sale de los productos de tipo SERVICIO
 * del inventario (ver utils/serviciosInventario.js), así que esto deja el
 * catálogo enlazado con el inventario antes de que nadie abra la agenda: la
 * primera vez son cientos de altas y no tienen por qué caerle a la primera
 * recepcionista que pincha el buscador.
 *
 * Es idempotente: casa por nombre (sin tildes ni mayúsculas) y volver a
 * correrlo no duplica nada.
 *
 * Uso:  node scripts/seedAppointmentServiceItems.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { sincronizarServiciosInventario } = require('../utils/serviciosInventario');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const r = await sincronizarServiciosInventario({ force: true });
  console.log(
    `Servicios de agenda — servicios en el inventario: ${r?.productos ?? '?'}, cambios aplicados: ${r?.cambios ?? 0}`
  );
  await mongoose.disconnect();
})().catch((err) => {
  console.error('No se pudo sincronizar el catálogo de servicios con el inventario:', err.message);
  process.exit(1);
});
