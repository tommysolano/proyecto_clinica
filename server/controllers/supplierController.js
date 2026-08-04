const Supplier = require('../models/Supplier');

/** Busca el texto TAL CUAL se escribió: un RUC con guiones o un nombre con paréntesis no puede
 *  cambiar lo que se busca (ni reventar la expresión regular). */
const escaparRegex = (v) => String(v).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

exports.list = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.q) {
    const rx = new RegExp(escaparRegex(req.query.q), 'i');
    filter.$or = [{ ruc: rx }, { razonSocial: rx }, { nombreComercial: rx }];
  }
  if (req.query.active !== undefined) filter.active = req.query.active === 'true';
  if (req.query.role) filter.roles = req.query.role;
  const q = Supplier.find(filter).populate('defaultExpenseAccount defaultPayableAccount', 'code name').sort({ razonSocial: 1 });
  // El buscador de cliente de Nueva Venta escribe letra a letra: sin tope traería el padrón entero.
  const lim = Math.min(parseInt(req.query.limit, 10) || 0, 500);
  if (lim) q.limit(lim);
  const items = await q;
  res.json(items);
};

/**
 * Buscador de CLIENTES para el mostrador (Nueva Venta).
 *
 * Una persona registrada en Personas con el rol CLIENTE no aparecía en ninguna parte al vender:
 * el buscador de la venta solo miraba los PACIENTES, así que quien registraba a un cliente por
 * aquí no lo volvía a encontrar ni por nombre ni por cédula. Es un endpoint aparte —y no el
 * listado completo de Personas— porque el cajero solo necesita a quién facturar: devuelve los
 * datos del comprobante y nada de la ficha contable (cuentas, crédito, régimen).
 */
exports.searchClients = async (req, res) => {
  const filter = { clinic: req.clinicId, roles: 'CLIENTE', active: true };
  const q = String(req.query.q || '').trim();
  if (q) {
    const rx = new RegExp(escaparRegex(q), 'i');
    filter.$or = [{ ruc: rx }, { razonSocial: rx }, { nombreComercial: rx }];
  }
  const items = await Supplier.find(filter)
    .select('ruc tipoIdentificacion razonSocial nombreComercial email phone address')
    .sort({ razonSocial: 1 })
    .limit(Math.min(parseInt(req.query.limit, 10) || 15, 50));
  res.json(items);
};

exports.get = async (req, res) => {
  const s = await Supplier.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!s) return res.status(404).json({ message: 'No encontrado' });
  res.json(s);
};

exports.create = async (req, res) => {
  try {
    const data = { ...req.body, clinic: req.clinicId };
    const s = await Supplier.create(data);
    res.status(201).json(s);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.update = async (req, res) => {
  try {
    const s = await Supplier.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!s) return res.status(404).json({ message: 'No encontrado' });
    Object.assign(s, req.body);
    await s.save();
    res.json(s);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.remove = async (req, res) => {
  const s = await Supplier.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!s) return res.status(404).json({ message: 'No encontrado' });
  await s.deleteOne();
  res.json({ message: 'Eliminado' });
};
