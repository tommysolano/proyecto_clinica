const TimeBlock = require('../models/TimeBlock');
const { sucursalesVisibles, alcanzaSucursal, validarSucursalDestino } = require('../utils/clinicScope');

// Normaliza una fecha 'YYYY-MM-DD' al inicio del día local (12:00 para evitar TZ).
const startOfLocalDay = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value;
  const str = String(value);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const [, y, mo, d] = m;
    return new Date(Number(y), Number(mo) - 1, Number(d), 0, 0, 0, 0);
  }
  return new Date(str);
};
// Para endDate: fin del día local para que cualquier hora del último día caiga dentro.
const endOfLocalDay = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value;
  const str = String(value);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const [, y, mo, d] = m;
    return new Date(Number(y), Number(mo) - 1, Number(d), 23, 59, 59, 999);
  }
  return new Date(str);
};

/**
 * Qué sucursales consulta el listado.
 *
 * Por defecto la activa; `?clinic=all` = TODAS las visibles (la vista del día
 * de la agenda lo usa, porque ahí se ven citas de varias sedes y el recuadro
 * del bloqueo tiene que salir en todas). Cualquier otra sucursal pedida se
 * respeta solo si el usuario tiene alcance (misma regla que la agenda).
 */
function resuelveClinicas(req) {
  const param = req.query.clinic;
  if (!param || param === req.clinicId) return [req.clinicId];
  if (param === 'all') {
    const visibles = sucursalesVisibles(req);
    return visibles === null ? [req.clinicId] : visibles;
  }
  return alcanzaSucursal(req, param) ? [param] : [req.clinicId];
}

exports.list = async (req, res) => {
  try {
    const { startDate, endDate, doctor } = req.query;
    const query = { clinic: { $in: resuelveClinicas(req).map(String) } };
    if (startDate && endDate) {
      query.$or = [
        { startDate: { $lte: new Date(endDate) }, endDate: { $gte: new Date(startDate) } },
      ];
    }
    if (doctor) query.doctor = doctor;
    const blocks = await TimeBlock.find(query)
      .populate('doctor', 'name')
      .populate('room', 'name')
      .populate('service', 'name color')
      .populate('clinic', 'name nombreComercial')
      .populate('createdBy', 'name')
      .sort({ startDate: 1, startTime: 1 });
    res.json(blocks);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener bloqueos', error: error.message });
  }
};

exports.create = async (req, res) => {
  try {
    const { startDate, endDate, allDay, startTime, endTime } = req.body;
    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'Fechas requeridas' });
    }
    if (!allDay && startTime && endTime && startTime >= endTime) {
      return res.status(400).json({ message: 'La hora de fin debe ser posterior a la de inicio' });
    }
    /**
     * LA SUCURSAL DEL BLOQUEO se escoge en el formulario (sep-2026).
     *
     * Antes siempre era la activa: para bloquear otra sede había que cambiar de
     * sucursal y volver. Ahora el modal la pregunta — con la misma regla que el
     * agendamiento (`validarSucursalDestino`): si la pedida no existe o está
     * inactiva, no se crea a ciegas. Sin `clinic` en el cuerpo queda la activa,
     * como siempre.
     */
    const destino = await validarSucursalDestino(req, req.body.clinic);
    if (!destino.ok) {
      return res.status(destino.status).json({ message: destino.message });
    }
    const block = await TimeBlock.create({
      ...req.body,
      clinic: destino.clinicId,
      doctor: req.body.doctor || null,
      room: req.body.room || null,
      service: req.body.service || null,
      startDate: startOfLocalDay(startDate),
      endDate: endOfLocalDay(endDate),
      allDay: !!allDay,
      startTime: allDay ? null : startTime || null,
      endTime: allDay ? null : endTime || null,
      createdBy: req.user._id,
    });
    res.status(201).json(block);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear bloqueo', error: error.message });
  }
};

exports.update = async (req, res) => {
  try {
    const update = { ...req.body };
    if (update.startDate) update.startDate = startOfLocalDay(update.startDate);
    if (update.endDate) update.endDate = endOfLocalDay(update.endDate);
    if (update.service !== undefined) update.service = update.service || null;
    // El listado puede enseñar bloqueos de OTRAS sucursales dentro del alcance
    // (la misma regla del listado), así que la escritura también respeta el
    // alcance y no solo la sucursal activa.
    const block = await TimeBlock.findOneAndUpdate(
      { _id: req.params.id, clinic: { $in: resuelveClinicas(req).map(String) } },
      update,
      { new: true }
    );
    if (!block) return res.status(404).json({ message: 'Bloqueo no encontrado' });
    res.json(block);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar bloqueo' });
  }
};

exports.remove = async (req, res) => {
  try {
    const block = await TimeBlock.findOneAndDelete({
      _id: req.params.id,
      clinic: { $in: resuelveClinicas(req).map(String) },
    });
    if (!block) return res.status(404).json({ message: 'Bloqueo no encontrado' });
    res.json({ message: 'Bloqueo eliminado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar bloqueo' });
  }
};
