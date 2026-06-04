const Discount = require('../models/Discount');

exports.list = async (req, res) => {
  try {
    const discounts = await Discount.find({ clinic: req.clinicId })
      .populate('products', 'name code salePrice')
      .sort({ createdAt: -1 });
    res.json(discounts);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener descuentos', error: error.message });
  }
};

exports.create = async (req, res) => {
  try {
    const d = await Discount.create({
      ...req.body,
      clinic: req.clinicId,
      createdBy: req.user._id,
    });
    res.status(201).json(d);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear descuento', error: error.message });
  }
};

exports.update = async (req, res) => {
  try {
    const d = await Discount.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      req.body,
      { new: true }
    );
    if (!d) return res.status(404).json({ message: 'Descuento no encontrado' });
    res.json(d);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar descuento' });
  }
};

exports.remove = async (req, res) => {
  try {
    const d = await Discount.findOneAndDelete({
      _id: req.params.id,
      clinic: req.clinicId,
    });
    if (!d) return res.status(404).json({ message: 'Descuento no encontrado' });
    res.json({ message: 'Descuento eliminado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar descuento' });
  }
};

/**
 * Devuelve los descuentos activos aplicables a una lista de productos.
 * Útil para POS / cotizador.
 */
exports.applicable = async (req, res) => {
  try {
    const { productIds = [], audience, amount, atDate } = req.body || {};
    const now = atDate ? new Date(atDate) : new Date();
    const list = await Discount.find({
      clinic: req.clinicId,
      active: true,
      $and: [
        { $or: [{ startDate: null }, { startDate: { $lte: now } }] },
        { $or: [{ endDate: null }, { endDate: { $gte: now } }] },
      ],
    });
    const dow = now.getDay();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const filtered = list.filter((d) => isDiscountApplicable(d, { productIds, audience, amount, dow, hhmm, clinicId: req.clinicId }));
    res.json(filtered);
  } catch (error) {
    res.status(500).json({ message: 'Error al consultar descuentos' });
  }
};

/** Evalúa si un descuento aplica según sus parametrizaciones. */
function isDiscountApplicable(d, { productIds = [], audience, amount, dow, hhmm, clinicId }) {
  // Productos
  if (d.scope !== 'all') {
    const ok = (d.products || []).some((p) => productIds.map(String).includes(String(p)));
    if (!ok) return false;
  }
  // Sucursales
  if ((d.clinics || []).length && clinicId && !d.clinics.map(String).includes(String(clinicId))) return false;
  // Días de la semana
  if ((d.daysOfWeek || []).length && dow != null && !d.daysOfWeek.includes(dow)) return false;
  // Franja horaria
  if (d.startTime && hhmm && hhmm < d.startTime) return false;
  if (d.endTime && hhmm && hhmm > d.endTime) return false;
  // Público objetivo
  if (d.audience && d.audience !== 'todos' && audience && audience !== d.audience) return false;
  // Compra mínima
  if (d.minAmount && amount != null && amount < d.minAmount) return false;
  // Límite de usos
  if (d.maxUses && d.usedCount >= d.maxUses) return false;
  return true;
}

exports.isDiscountApplicable = isDiscountApplicable;
