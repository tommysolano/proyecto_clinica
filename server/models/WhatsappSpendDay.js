const mongoose = require('mongoose');

/**
 * Gasto REAL de WhatsApp por día, tal como lo informa Meta.
 *
 * Cada documento es un punto del endpoint `pricing_analytics` de la WABA: lo que
 * Meta cobró (`cost`) y cuántos mensajes cobró (`volume`) en un día, para una
 * categoría de precio, un tipo de precio y un país. NO se calcula nada aquí: si
 * Meta no informa el costo, se guarda `cost: null` y la pantalla lo dice — nunca
 * se rellena con una estimación.
 *
 * Se persiste (en vez de consultar Meta en cada carga) para tener HISTORIA propia
 * y que la página abra rápido; el job diario refresca los últimos días, porque el
 * dato del día en curso todavía está incompleto en Meta.
 */
const whatsappSpendDaySchema = new mongoose.Schema(
  {
    // WABA a la que pertenece el gasto (la cuenta de WhatsApp Business de Meta).
    wabaId: { type: String, required: true, trim: true, index: true },
    // Día en hora de Ecuador, 'YYYY-MM-DD' (así el reporte cuadra con el resto
    // del sistema, que vive en America/Guayaquil).
    date: { type: String, required: true, trim: true, index: true },
    // Dimensiones que devuelve Meta.
    country: { type: String, trim: true, default: '' },
    pricingCategory: { type: String, trim: true, default: '' }, // MARKETING | UTILITY | AUTHENTICATION | SERVICE…
    pricingType: { type: String, trim: true, default: '' }, // REGULAR | FREE_CUSTOMER_SERVICE | FREE_ENTRY_POINT
    tier: { type: String, trim: true, default: '' },
    // Métricas de Meta. `cost` es null cuando Meta no lo informa (p. ej. si se
    // factura a través de un socio): eso NO es cero.
    volume: { type: Number, default: 0 },
    cost: { type: Number, default: null },
    currency: { type: String, trim: true, default: 'USD' },
    // Cuándo se trajo de Meta (el día en curso se vuelve a pedir).
    fetchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Un único documento por combinación de día + dimensiones: el sync es idempotente
// (se puede re-sincronizar un rango sin duplicar ni sumar dos veces).
whatsappSpendDaySchema.index(
  { wabaId: 1, date: 1, country: 1, pricingCategory: 1, pricingType: 1, tier: 1 },
  { unique: true }
);

module.exports = mongoose.model('WhatsappSpendDay', whatsappSpendDaySchema);
