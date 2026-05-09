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
    const { productIds = [] } = req.body || {};
    const now = new Date();
    const list = await Discount.find({
      clinic: req.clinicId,
      active: true,
      $and: [
        { $or: [{ startDate: null }, { startDate: { $lte: now } }] },
        { $or: [{ endDate: null }, { endDate: { $gte: now } }] },
      ],
    });
    const filtered = list.filter((d) => {
      if (d.scope === 'all') return true;
      return (d.products || []).some((p) =>
        productIds.map(String).includes(String(p))
      );
    });
    res.json(filtered);
  } catch (error) {
    res.status(500).json({ message: 'Error al consultar descuentos' });
  }
};
