const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    code: {
      type: String,
      required: [true, 'El código es requerido'],
      trim: true,
    },
    name: {
      type: String,
      required: [true, 'El nombre es requerido'],
      trim: true,
    },
    description: { type: String, trim: true },
    category: {
      type: String,
      enum: ['medicamento', 'insumo', 'servicio', 'programa', 'otro'],
      default: 'otro',
    },
    // Para 'programa' (pack de servicios): lista de servicios incluidos.
    programServices: [
      {
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
        quantity: { type: Number, default: 1, min: 1 },
        _id: false,
      },
    ],
    // Para 'servicio': insumos/items relacionados que se utilizan al ofrecer el servicio.
    serviceItems: [
      {
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
        quantity: { type: Number, default: 1, min: 0 },
        _id: false,
      },
    ],
    // Producto compuesto (ej. un suero compuesto por ampollas). Tiene precio de
    // venta fijo. `components` lista los productos que PUEDEN componerlo; al
    // recetarlo, el doctor elige cuáles usar. Se descuenta el stock de los
    // componentes elegidos pero se cobra el precio del compuesto (no de las partes).
    isComposite: { type: Boolean, default: false },
    components: [
      {
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
        quantity: { type: Number, default: 1, min: 0 },
        _id: false,
      },
    ],
    // Stock por clínica. El inventario general es la suma de todas las clínicas.
    // [{ clinic, stock }]
    stockByClinic: [
      {
        clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic' },
        stock: { type: Number, default: 0, min: 0 },
        _id: false,
      },
    ],
    // Restricción: si está vacío, el servicio se atiende en cualquier clínica.
    // Si tiene clínicas, solo en esas. Permite forzar selección automática al agendar.
    availableInClinics: [
      { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic' },
    ],
    purchasePrice: { type: Number, default: 0, min: 0 },
    salePrice: {
      type: Number,
      required: [true, 'El precio de venta es requerido'],
      min: 0,
    },
    stock: { type: Number, default: 0, min: 0 },
    minStock: { type: Number, default: 5, min: 0 },
    // Costo unitario promedio ponderado (cache derivado de las capas de kardex vivas).
    averageCost: { type: Number, default: 0, min: 0 },
    // Costeo y trazabilidad por capas (kardex). Para fármacos/insumos con vencimiento.
    costingMethod: { type: String, enum: ['FIFO', 'PROMEDIO'], default: 'FIFO' },
    tracksLot: { type: Boolean, default: false },
    tracksExpiry: { type: Boolean, default: false },
    // Cuentas contables vinculadas. Si no se setean, el sistema usa los códigos
    // por defecto del plan (1.1.04.01 inventario, 6.x gasto, 4.x ingreso, según corresponda).
    inventoryAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null }, // Activo: inventario
    expenseAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },   // Gasto/COGS
    incomeAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },    // Ingreso por venta
    inventoryCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryCategory', default: null },
    // Si es true, el producto se considera de stock infinito (no se descuenta ni valida).
    // Útil para servicios u otros ítems facturables sin inventario físico.
    unlimited: { type: Boolean, default: false },
    unit: { type: String, default: 'unidad', trim: true },
    taxRate: { type: Number, default: 15 },
    taxCodeSri: { type: String, default: '4' },
    taxCategory: {
      type: String,
      enum: ['IVA_15', 'IVA_12', 'IVA_0', 'EXENTO', 'NO_OBJETO', 'ICE'],
      default: 'IVA_15',
    },
    priceIncludesVat: { type: Boolean, default: true },
    // Ingreso diferido (paquetes/programas): si es true, al vender este producto
    // el ingreso NO se reconoce de inmediato sino que se acredita a "Ingresos
    // diferidos" (pasivo) y se reconoce por sesión consumida. Opt-in por producto
    // para no alterar la política contable de productos existentes.
    deferredIncome: { type: Boolean, default: false },
    // N° de sesiones que incluye el paquete (para reconocer el ingreso por sesión).
    sessionsIncluded: { type: Number, default: 0, min: 0 },
    isMedicalService: { type: Boolean, default: false },
    isInventoryItem: { type: Boolean, default: false },
    costAccountCode: { type: String, default: '' },
    inventoryAccountCode: { type: String, default: '' },
    // Límite de citas concurrentes para este servicio en un mismo horario (0 o null = sin límite).
    // Solo aplica a productos de categoría 'servicio' o 'programa'.
    // Cuenta citas con la misma fecha y misma hora de inicio.
    maxAppointmentsPerDay: { type: Number, default: 0, min: 0 },
    // Si true, este servicio NO marca al paciente como "nuevo" cuando se agenda
    // o se vende (útil para servicios recurrentes que no son una primera consulta).
    excludeFromFirstVisit: { type: Boolean, default: false },
    // Si true, este servicio es atendido por enfermería (p.ej. sueroterapia).
    // Cuando una cita con este servicio se marca 'asistida', aparece en la
    // bandeja de TODOS los enfermeros del consultorio para que uno la reclame.
    nursingService: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

productSchema.index({ clinic: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('Product', productSchema);
