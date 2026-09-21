const TimeBlock = require('../models/TimeBlock');
const { sucursalesVisibles, alcanzaSucursal, validarSucursalDestino } = require('../utils/clinicScope');
const { emitToClinic, emitToCallCenter } = require('../realtime');

/**
 * Aviso en vivo de cambio de bloqueos. La agenda muestra citas de varias sedes
 * (y el call center ve toda la organización), así que el evento va a la sala de
 * la sucursal del bloqueo Y a la bandeja común del call center.
 */
const notificarCambioBloqueo = (block, action) => {
  const payload = { action, id: String(block._id), clinic: String(block.clinic?._id || block.clinic || '') };
  if (block.clinic) emitToClinic(block.clinic, 'timeblock:changed', payload);
  emitToCallCenter('timeblock:changed', payload);
};

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
 *
 * Devuelve `null` cuando el usuario ve TODA la organización (admin, cajero,
 * call center, marketing, super-admin): en ese caso el listado NO debe filtrar
 * por sucursal — antes caía a la sucursal activa del token y los bloqueos de
 * las demás sedes "desaparecían" para quien no tuviera esa sede como activa.
 */
function resuelveClinicas(req) {
  const param = req.query.clinic;
  if (!param || param === req.clinicId) return [req.clinicId];
  if (param === 'all') {
    const visibles = sucursalesVisibles(req);
    return visibles === null ? null : visibles;
  }
  return alcanzaSucursal(req, param) ? [param] : [req.clinicId];
}

/** Convierte el resultado de resuelveClinicas en el filtro Mongo de clinic. */
const filtroClinicas = (clinicas) =>
  clinicas === null ? { $exists: true } : { $in: clinicas.map(String) };

exports.list = async (req, res) => {
  try {
    const { startDate, endDate, doctor } = req.query;
    const query = { clinic: filtroClinicas(resuelveClinicas(req)) };
    if (startDate && endDate) {
      /**
       * EL RANGO SE PARSEA EN HORA LOCAL, NO CON `new Date('YYYY-MM-DD')`.
       *
       * Ese constructor parsea a MEDIANOCHE UTC, y los bloqueos se guardan a
       * medianoche LOCAL (ver startOfLocalDay). Con el servidor en una zona al
       * oeste de UTC (Ecuador), la medianoche local es DESPUÉS que la UTC del
       * mismo día: el `$lte` del primer día del bloqueo fallaba y el rango del
       * día 20 no devolvía el bloqueo del día 20 — por eso no se veía en la
       * vista de lista de la agenda ni en el calendario. Aquí se compara día
       * contra día en la misma zona horaria de la que vienen las dos partes.
       */
      query.$or = [
        {
          startDate: { $lte: endOfLocalDay(endDate) },
          endDate: { $gte: startOfLocalDay(startDate) },
        },
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
    notificarCambioBloqueo(block, 'created');
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
      { _id: req.params.id, clinic: filtroClinicas(resuelveClinicas(req)) },
      update,
      { new: true }
    );
    if (!block) return res.status(404).json({ message: 'Bloqueo no encontrado' });
    notificarCambioBloqueo(block, 'updated');
    res.json(block);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar bloqueo' });
  }
};

exports.remove = async (req, res) => {
  try {
    const block = await TimeBlock.findOneAndDelete({
      _id: req.params.id,
      clinic: filtroClinicas(resuelveClinicas(req)),
    });
    if (!block) return res.status(404).json({ message: 'Bloqueo no encontrado' });
    notificarCambioBloqueo(block, 'deleted');
    res.json({ message: 'Bloqueo eliminado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar bloqueo' });
  }
};
