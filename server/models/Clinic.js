const mongoose = require('mongoose');
// Registra la empresa: las sucursales se cargan con `populate('company')`.
require('./Company');

const clinicSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // Centro operativo de la sucursal. El archivo importado conserva sus centros
    // originales; accountingImportCostCenters indica cuáles puede leer aquí.
    accountingCostCenter: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
    accountingImportCostCenters: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter' }], default: [] },
    // Almacén de los documentos históricos importados de Contífico. Es una
    // referencia técnica al origen; el centro y la bodega pertenecen a la
    // sucursal y los documentos nuevos se guardan allí.
    accountingDataClinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', default: null },
    // Empresa a la que pertenece (models/Company). Mover la sucursal a otra empresa
    // es cambiar este campo: citas, ventas y personal la siguen (ver utils/companies).
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', default: null, index: true },
    // Al mover una sucursal a otra empresa nace una nueva (POST /clinics/:id/move): la
    // de origen queda inactiva con su historial y ambas se apuntan entre sí.
    movedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', default: null },
    movedFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', default: null },
    ruc: {
      type: String,
      trim: true,
      validate: {
        validator: (v) => !v || /^\d{13}$/.test(v),
        message: 'RUC debe tener 13 dígitos',
      },
    },
    razonSocial: { type: String, trim: true },
    nombreComercial: { type: String, trim: true },
    address: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    logoUrl: { type: String, trim: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Datos fiscales (cada sucursal puede ser su propia empresa / RUC).
    obligadoContabilidad: { type: Boolean, default: true },
    contribuyenteEspecial: { type: String, trim: true, default: '' }, // nº resolución, vacío si no aplica
    agenteRetencion: { type: String, trim: true, default: '' },

    /**
     * ESPACIOS DE LA AGENDA, en minutos.
     *
     * Con 20, una cita solo puede empezar a las 14:00, 14:20, 14:40… El campo de
     * hora deja de ser libre y pasa a ser una lista. Antes se podía agendar a las
     * 18:37, y una agenda a horas sueltas no se puede leer de un vistazo ni
     * repartir entre profesionales: cada cita empieza donde acabó la anterior.
     *
     * `0` = sin espacios, cualquier hora. Es el valor por defecto A PROPÓSITO:
     * activar la rejilla cambia cómo agenda todo el mundo, así que lo enciende el
     * administrador cuando quiere (Configuración → Agenda), no una migración.
     *
     * Es POR SUCURSAL: cada sede tiene su ritmo y su aforo.
     */
    appointmentSlotMinutes: { type: Number, default: 0, min: 0, max: 240 },

    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Clinic', clinicSchema);
