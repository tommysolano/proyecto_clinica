const mongoose = require('mongoose');

/**
 * Catálogo de SERVICIOS DE AGENDA. Es lo que se elige al agendar una cita.
 *
 * POR QUÉ NO SE USA EL INVENTARIO. Hasta ahora el servicio de una cita era un
 * producto del inventario (`Appointment.services[].product`). Eso ataba el
 * agendamiento a la contabilidad: para poder agendar había que tener el servicio
 * dado de alta con su precio, su categoría contable y su cuenta. Al separar la
 * parte operativa de la contable, la agenda pasa a tener su propia lista, que
 * cualquiera que agende puede ampliar sobre la marcha.
 *
 * ES DE TODA LA ORGANIZACIÓN, NO POR SUCURSAL. `clinic` guarda dónde se creó
 * (para saber de dónde salió), pero el listado NO filtra por sucursal: el
 * requisito es que un servicio nuevo «le aparezca a los demás», y si cada sede
 * tuviera su lista acabarían tres «Ecocardiograma» distintos. Mismo criterio que
 * el catálogo de productos (ver inventario compartido entre sucursales).
 *
 * `nursingService` es lo que hace que una cita con ese servicio pueda mandarse a
 * enfermería; antes esa marca vivía en el producto del inventario.
 */
const appointmentServiceItemSchema = new mongoose.Schema(
  {
    // Sucursal donde se creó. Trazabilidad, NO filtro de visibilidad.
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', index: true },
    name: { type: String, required: true, trim: true },
    // Clave de búsqueda: minúsculas y sin tildes. Es lo que impide que acaben
    // conviviendo «Botox», «botox» y «BOTOX» como tres servicios distintos.
    slug: { type: String, required: true, trim: true },
    color: { type: String, trim: true, default: '#0f766e' },
    active: { type: Boolean, default: true, index: true },
    // Marca el servicio como propio de enfermería (sueroterapia, inyectables…).
    nursingService: { type: Boolean, default: false },
    /**
     * Cuánto OCUPA este servicio, en minutos. `0` = lo que dure la cita normal.
     *
     * No todos duran lo mismo: un control son diez minutos y un tratamiento
     * puede llevar una hora. Sin esto, la disponibilidad se miraba minuto a
     * minuto y una cita de 40 minutos empezada a las 14:00 desaparecía del panel
     * en cuanto se consultaba las 14:20 — el hueco parecía libre y se agendaba
     * encima. Es lo que hace que «Disponibilidad en este horario» diga la verdad
     * cuando la agenda va en espacios más cortos que el servicio.
     */
    durationMinutes: { type: Number, default: 0, min: 0, max: 480 },
    /**
     * SUERO DE SERIE DEL SERVICIO.
     *
     * Hay servicios que SON un suero concreto y siempre el mismo: «Detox Plus»
     * es una bolsa con la ampolla de detox dentro, y ninguna cita de Detox Plus
     * lleva otra cosa. Hasta ahora eso se escribía a mano en la ficha del
     * paciente, una por una, para que enfermería tuviera qué dar por aplicado —
     * un trámite de copiar y pegar que se olvida justo los días de trabajo, y
     * entonces la aplicación no queda registrada ni descuenta la ampolla.
     *
     * Con esto, agendar el servicio deja el suero escrito en los seguimientos.
     * Es una PLANTILLA, no un candado: el médico puede cambiarlo o quitarlo en
     * la ficha como cualquier otra línea de receta.
     *
     * Va en el catálogo y no en el código a propósito. Mañana hay un «Detox
     * Simple» o cambia la ampolla, y eso lo tiene que poder hacer el
     * administrador desde Configuración → Servicios, no un despliegue.
     *
     * La estructura es la MISMA que la de una línea de receta
     * (`ClinicalRecord.recetaItems[].serumBase` / `serumComponents`), con los
     * nombres cortos porque aquí no hay línea de receta de la que colgar: es la
     * preparación a secas. `utils/suero.js` traduce entre las dos.
     */
    autoSerum: {
      enabled: { type: Boolean, default: false },
      base: {
        name: { type: String, trim: true, default: '' },
        // null = lo decide enfermería con la bolsa que haya en la sala.
        volumeMl: { type: Number, default: null },
      },
      components: {
        type: [
          new mongoose.Schema(
            {
              // Código del catálogo de sueroterapia, que es el mismo con el que
              // la ampolla está en el inventario: por ahí se la descuenta.
              code: { type: String, trim: true, default: '' },
              name: { type: String, trim: true, required: true },
              grupo: { type: String, enum: ['ampolla', 'molecula', 'otro'], default: 'otro' },
              quantity: { type: Number, default: 1, min: 0 },
            },
            { _id: false }
          ),
        ],
        default: [],
      },
    },
    // Cuántas citas se agendaron con él: ordena el buscador por lo más usado.
    usageCount: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Un solo servicio por nombre en toda la organización.
appointmentServiceItemSchema.index({ slug: 1 }, { unique: true });

/** Nombre → clave de búsqueda: sin tildes, sin dobles espacios, en minúsculas. */
appointmentServiceItemSchema.statics.slugify = function slugify(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
};

module.exports = mongoose.model('AppointmentServiceItem', appointmentServiceItemSchema);
