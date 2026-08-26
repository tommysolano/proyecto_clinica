const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const { emitToClinic } = require('../realtime');

/**
 * Catálogo de servicios de agenda. Ver el modelo para el porqué de que sea de
 * toda la organización y no por sucursal.
 */

// Paleta de la que salen los colores de los servicios nuevos, para que la lista
// no acabe siendo toda del mismo verde.
const COLORES = [
  '#0f766e', '#0369a1', '#7c3aed', '#be123c', '#b45309',
  '#15803d', '#a21caf', '#0e7490', '#4d7c0f', '#9f1239',
];

const colorPorNombre = (nombre) => {
  let h = 0;
  for (const c of String(nombre)) h = (h * 31 + c.charCodeAt(0)) % 100000;
  return COLORES[h % COLORES.length];
};

// GET /appointment-service-items?all=1
// Sin `all`, solo los activos (lo que se ofrece al agendar).
exports.list = async (req, res) => {
  try {
    const filtro = req.query.all ? {} : { active: true };
    const items = await AppointmentServiceItem.find(filtro)
      // Lo más usado primero: quien agenda encuentra en dos letras lo de siempre.
      .sort({ usageCount: -1, name: 1 })
      .lean();
    res.json(items);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar servicios', error: error.message });
  }
};

/**
 * POST /appointment-service-items — crear al vuelo desde el formulario de cita.
 *
 * Es BUSCAR-O-CREAR: si ya existe uno con el mismo nombre (ignorando tildes y
 * mayúsculas) se devuelve ese en vez de un error de duplicado. Dos recepcionistas
 * escribiendo «Ecocardiograma» a la vez tienen que acabar con UN servicio, no
 * con un 500 en la cara de la segunda.
 */
exports.create = async (req, res) => {
  try {
    const name = String(req.body.name || '').replace(/\s+/g, ' ').trim();
    if (!name) return res.status(400).json({ message: 'El nombre del servicio es requerido' });
    if (name.length > 80) return res.status(400).json({ message: 'El nombre es demasiado largo' });

    const slug = AppointmentServiceItem.slugify(name);
    const existente = await AppointmentServiceItem.findOne({ slug });
    if (existente) {
      // Si estaba desactivado, volver a usarlo lo reactiva: es lo que quería
      // quien lo está escribiendo.
      if (!existente.active) {
        existente.active = true;
        await existente.save();
      }
      return res.json(existente);
    }

    const item = await AppointmentServiceItem.create({
      clinic: req.clinicId,
      name,
      slug,
      color: req.body.color || colorPorNombre(name),
      nursingService: !!req.body.nursingService,
      createdBy: req.user?._id,
    });
    // El resto de pantallas abiertas lo ven aparecer sin recargar.
    emitToClinic(req.clinicId, 'appointmentServiceItem:created', item);
    res.status(201).json(item);
  } catch (error) {
    // Carrera entre dos peticiones simultáneas: gana la primera y la segunda
    // devuelve el que quedó, no un error.
    if (error.code === 11000) {
      const item = await AppointmentServiceItem.findOne({
        slug: AppointmentServiceItem.slugify(req.body.name),
      });
      if (item) return res.json(item);
    }
    res.status(500).json({ message: 'Error al crear el servicio', error: error.message });
  }
};

// PUT /appointment-service-items/:id — solo admin (renombrar, color, enfermería).
exports.update = async (req, res) => {
  try {
    const item = await AppointmentServiceItem.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Servicio no encontrado' });

    if (req.body.name !== undefined) {
      const name = String(req.body.name).replace(/\s+/g, ' ').trim();
      if (!name) return res.status(400).json({ message: 'El nombre del servicio es requerido' });
      const slug = AppointmentServiceItem.slugify(name);
      const choque = await AppointmentServiceItem.findOne({ slug, _id: { $ne: item._id } });
      if (choque) return res.status(409).json({ message: `Ya existe el servicio «${choque.name}»` });
      item.name = name;
      item.slug = slug;
    }
    if (req.body.color !== undefined) item.color = req.body.color;
    if (req.body.nursingService !== undefined) item.nursingService = !!req.body.nursingService;
    if (req.body.active !== undefined) item.active = !!req.body.active;

    await item.save();
    emitToClinic(req.clinicId, 'appointmentServiceItem:updated', item);
    res.json(item);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar el servicio', error: error.message });
  }
};

/**
 * DELETE /appointment-service-items/:id — baja LÓGICA.
 * No se borra de verdad: las citas ya agendadas lo referencian y perderían el
 * nombre del servicio por el que vino el paciente.
 */
exports.remove = async (req, res) => {
  try {
    const item = await AppointmentServiceItem.findByIdAndUpdate(
      req.params.id,
      { active: false },
      { new: true }
    );
    if (!item) return res.status(404).json({ message: 'Servicio no encontrado' });
    emitToClinic(req.clinicId, 'appointmentServiceItem:updated', item);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar el servicio', error: error.message });
  }
};
