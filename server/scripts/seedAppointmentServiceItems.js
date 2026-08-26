/**
 * Siembra el catálogo de SERVICIOS DE AGENDA con los que la clínica ya usaba.
 *
 * Son los que aparecían en el selector viejo (el que leía el inventario) y los
 * que el equipo pidió tener a mano desde el primer día. Se ejecuta una sola vez
 * en el despliegue: es idempotente, así que volver a correrlo no duplica nada
 * — busca por `slug`, que ignora tildes y mayúsculas.
 *
 * Uso:  node scripts/seedAppointmentServiceItems.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');

// Los marcados con `enfermeria: true` son los que un cajero puede mandar a la
// bandeja de enfermería (sueros, inyectables, curaciones).
const SERVICIOS = [
  { name: 'Detox Plus', color: '#a21caf' },
  { name: 'Hidroterapia + Suero', color: '#0e7490', enfermeria: true },
  { name: 'Plasma Marino + Hidro', color: '#0e7490', enfermeria: true },
  { name: 'Vital Femenino', color: '#be123c' },
  { name: 'Control Hepático', color: '#15803d' },
  { name: 'Mujer Sana 360', color: '#be123c' },
  { name: 'Eco 360', color: '#4d7c0f' },
  { name: 'Programa Glucosa', color: '#0369a1' },
  { name: 'Sueroterapia', color: '#b45309', enfermeria: true },
  { name: 'Biorresonancia', color: '#9f1239' },
  { name: 'Programa Próstata', color: '#7c3aed' },
  { name: 'Programa Várices', color: '#be123c' },
  { name: 'Medicina General', color: '#b45309' },
  { name: 'Stop Dolor', color: '#b45309' },
  { name: 'Terapia Stop', color: '#b45309' },
  { name: 'Revisión de Exámenes', color: '#7c3aed' },
  { name: 'Seguimiento', color: '#0f766e' },
  { name: 'Revisión de PAP', color: '#be123c' },
  { name: 'EKG + Consulta', color: '#0369a1' },
  { name: 'Ecocardiograma', color: '#9f1239' },
  { name: 'Consulta Cardio', color: '#0f766e' },
  { name: 'Genotipo VPH', color: '#b45309' },
  { name: 'Lentes', color: '#7c3aed' },
  { name: 'Examen de Laboratorio', color: '#15803d' },
  { name: 'Ozonoterapia', color: '#15803d', enfermeria: true },
  { name: 'Perfil Lipídico', color: '#b45309' },
  { name: 'Perfil Lipídico + Adicional', color: '#b45309' },
  { name: 'Perfil Óseo', color: '#b45309' },
  { name: 'Perfil Óseo + Adicional', color: '#b45309' },
  { name: 'Profilaxis Diabética', color: '#9f1239' },
  { name: 'Profilaxis Podal', color: '#b45309' },
  { name: 'Plasma', color: '#15803d', enfermeria: true },
  { name: 'Cruzada Densitometría', color: '#0369a1' },
];

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  let creados = 0;
  let existentes = 0;

  for (const s of SERVICIOS) {
    const slug = AppointmentServiceItem.slugify(s.name);
    const ya = await AppointmentServiceItem.findOne({ slug });
    if (ya) {
      existentes += 1;
      continue;
    }
    await AppointmentServiceItem.create({
      name: s.name,
      slug,
      color: s.color,
      nursingService: !!s.enfermeria,
    });
    creados += 1;
  }

  console.log(`Servicios de agenda — creados: ${creados}, ya estaban: ${existentes}`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error('No se pudo sembrar el catálogo de servicios:', err.message);
  process.exit(1);
});
