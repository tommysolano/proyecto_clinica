const mongoose = require('mongoose');

/**
 * Regla de bloqueo de acceso al sistema (login). La gestiona SOLO el super-admin.
 * Es GLOBAL (no pertenece a una sucursal): impide que los usuarios entren al
 * sistema durante el horario/día definido. El super-admin y los usuarios en
 * `exceptUsers` nunca se bloquean.
 *
 * Ejemplos:
 *  - "Nadie entra todos los días de 19:00 a 06:00" → mode:'recurring', weekdays:[]
 *    (vacío = todos los días), allDay:false, startTime:'19:00', endTime:'06:00'.
 *  - "Domingos nadie entra" → mode:'recurring', weekdays:[0], allDay:true.
 *  - "Un día específico cerrado" → mode:'date', date:'2026-07-10', allDay:true.
 */
const accessBlockSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: '' },
    active: { type: Boolean, default: true },
    // 'recurring' = por día(s) de la semana; 'date' = una fecha específica.
    mode: { type: String, enum: ['recurring', 'date'], default: 'recurring' },
    // recurring: días de la semana (0=Domingo … 6=Sábado). Vacío = todos los días.
    weekdays: { type: [Number], default: [] },
    // date: fecha específica en formato 'YYYY-MM-DD' (zona horaria de Ecuador).
    date: { type: String, default: '' },
    // Bloqueo de todo el día o solo dentro de una ventana horaria.
    allDay: { type: Boolean, default: false },
    startTime: { type: String, default: '19:00' }, // 'HH:mm'
    endTime: { type: String, default: '06:00' },   // 'HH:mm' (< startTime = cruza medianoche)
    // Usuarios exceptuados: NO se les bloquea el acceso aunque aplique la regla.
    exceptUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AccessBlock', accessBlockSchema);
