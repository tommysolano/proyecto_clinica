const Treatment = require('../models/Treatment');
const Product = require('../models/Product');
const { emitToClinic } = require('../realtime');
const { applyAbandonment } = require('../utils/treatmentAbandonment');

const POPULATE = [
  { path: 'patient', select: 'firstName lastName cedula phone email' },
  { path: 'prescribedBy', select: 'name specialty' },
  { path: 'items.product', select: 'name code salePrice category' },
  { path: 'createdBy', select: 'name email' },
];

exports.list = async (req, res) => {
  try {
    const { patient, status } = req.query;
    const query = { clinic: req.clinicId };
    if (patient) query.patient = patient;
    if (status) query.status = status;

    let treatments = await Treatment.find(query)
      .populate(POPULATE)
      .sort({ createdAt: -1 });

    // Auto-completar tratamientos con 100% de avance
    for (const t of treatments) {
      if (t.status === 'activo' && t.progress >= 100) {
        t.status = 'completado';
        await t.save();
      }
    }
    // Aplicar abandono automático según inactividad
    await applyAbandonment(treatments);
    res.json(treatments);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener tratamientos', error: error.message });
  }
};

exports.get = async (req, res) => {
  try {
    const t = await Treatment.findOne({ _id: req.params.id, clinic: req.clinicId }).populate(
      POPULATE
    );
    if (!t) return res.status(404).json({ message: 'Tratamiento no encontrado' });
    res.json(t);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener tratamiento' });
  }
};

exports.create = async (req, res) => {
  try {
    const { items = [] } = req.body;
    const productIds = items.map((it) => it.product).filter(Boolean);
    // Catálogo compartido entre sucursales: se resuelve por _id, no por sucursal dueña.
    const products = productIds.length
      ? await Product.find({ _id: { $in: productIds } })
      : [];
    const prodById = new Map(products.map((p) => [String(p._id), p]));

    // Si el primer "item" es un programa (categoría 'programa'), expandir sus servicios.
    const expanded = [];
    for (const it of items) {
      const p = prodById.get(String(it.product));
      if (p && p.category === 'programa' && Array.isArray(p.programServices)) {
        for (const ps of p.programServices) {
          expanded.push({
            product: ps.product,
            quantity: (Number(it.quantity) || 1) * (Number(ps.quantity) || 1),
          });
        }
      } else if (p) {
        expanded.push({ product: p._id, quantity: Number(it.quantity) || 1 });
      }
    }

    // Snapshot de nombres
    const allIds = expanded.map((e) => e.product);
    const allProducts = await Product.find({ _id: { $in: allIds } }).select('name');
    const nameById = new Map(allProducts.map((p) => [String(p._id), p.name]));

    const treatment = await Treatment.create({
      ...req.body,
      clinic: req.clinicId,
      items: expanded.map((it) => ({
        product: it.product,
        name: nameById.get(String(it.product)),
        quantity: it.quantity,
        completed: 0,
      })),
      createdBy: req.user._id,
      prescribedBy: req.body.prescribedBy || (req.role === 'doctor' || req.role === 'optica' ? req.user._id : undefined),
    });
    const populated = await Treatment.findById(treatment._id).populate(POPULATE);
    emitToClinic(req.clinicId, 'treatment:created', { id: treatment._id });
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear tratamiento', error: error.message });
  }
};

exports.update = async (req, res) => {
  try {
    const t = await Treatment.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      req.body,
      { new: true }
    ).populate(POPULATE);
    if (!t) return res.status(404).json({ message: 'Tratamiento no encontrado' });
    emitToClinic(req.clinicId, 'treatment:updated', { id: t._id });
    res.json(t);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar tratamiento' });
  }
};

exports.remove = async (req, res) => {
  try {
    const t = await Treatment.findOneAndDelete({
      _id: req.params.id,
      clinic: req.clinicId,
    });
    if (!t) return res.status(404).json({ message: 'Tratamiento no encontrado' });
    emitToClinic(req.clinicId, 'treatment:deleted', { id: req.params.id });
    res.json({ message: 'Tratamiento eliminado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar tratamiento' });
  }
};

/**
 * Registra el cumplimiento de un servicio dentro del tratamiento.
 */
exports.completeItem = async (req, res) => {
  try {
    const { itemIndex, refType, refId } = req.body;
    const t = await Treatment.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!t) return res.status(404).json({ message: 'Tratamiento no encontrado' });
    if (!t.items[itemIndex]) {
      return res.status(400).json({ message: 'Item de tratamiento inválido' });
    }
    t.items[itemIndex].completed = Math.min(
      (t.items[itemIndex].completed || 0) + 1,
      t.items[itemIndex].quantity
    );
    if (refType && refId) {
      t.items[itemIndex].completionRefs.push({ type: refType, ref: refId, date: new Date() });
    }
    t.lastActivityAt = new Date();
    // Si estaba marcado como abandonado y vuelve a avanzar, reactivarlo
    if (t.status === 'abandonado') {
      t.status = 'activo';
      t.abandonedAt = undefined;
    }
    if (t.progress >= 100) t.status = 'completado';
    await t.save();
    emitToClinic(req.clinicId, 'treatment:updated', { id: t._id });
    res.json(t);
  } catch (error) {
    res.status(500).json({ message: 'Error al registrar cumplimiento' });
  }
};
