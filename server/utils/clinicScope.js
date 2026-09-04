/**
 * ALCANCE DE SUCURSALES de una petición.
 *
 * El usuario trabaja con UNA sucursal activa (`req.clinicId`, la del token),
 * pero no todo lo que puede tocar es de esa sede: mostrador y administración
 * agendan, ven y operan la agenda de TODA la organización, y quien tiene varias
 * sucursales asignadas se mueve entre ellas.
 *
 * Vivía repetido en cada controlador —cada uno con su matiz— y de ahí salió el
 * «Cita no encontrada» al asignar el doctor: la agenda le enseñaba al cajero una
 * cita de otra sede y la escritura la buscaba solo en la activa. Fuente única.
 */

/**
 * ¿VE (Y OPERA) TODA LA ORGANIZACIÓN?
 *
 * Mostrador y administración sí. El cajero está asignado a UNA sede, pero
 * atiende el teléfono y el mostrador: necesita ver dónde está agendado un
 * paciente sin preguntar por otra sucursal, y agenda para cualquier sede
 * eligiendo la sucursal destino.
 *
 * EL CALL CENTER TAMBIÉN (sep-2026). No trabaja EN una sucursal: trabaja para la
 * clínica entera y agenda en la sede que le pida el paciente por teléfono o por
 * WhatsApp. Estaba fuera, y como además suele tener UNA sola sucursal asignada,
 * el selector de sucursal ni le aparecía al agendar desde el chat: sus citas
 * caían siempre en su sede, que es justo el problema que se vino arreglando.
 * Va con el paquete completo —ver, agendar y encontrar después lo agendado—
 * porque media capacidad es peor que ninguna: agendar en Extensión y no volver a
 * ver esa cita en su propia agenda no hay forma de explicárselo a nadie.
 */
const veTodaLaOrganizacion = (req) =>
  !!req.user?.isSuperAdmin || ['admin', 'cajero', 'call_center'].includes(req.role);

/**
 * SUCURSAL PEDIDA por `?clinic=<id>`, si tiene permiso; si no, la activa.
 *
 * Lo usan los selectores que trabajan sobre otra sede (p.ej. el personal que
 * puede atender una cita de otra sucursal). Nunca devuelve una sucursal a la que
 * el usuario no llegue: cae a la activa en silencio.
 */
const sucursalPedida = (req) => {
  const pedida = req.query?.clinic;
  if (!pedida || String(pedida) === String(req.clinicId)) return req.clinicId;
  const asignada = (req.user?.clinics || []).some((c) => String(c.clinic) === String(pedida));
  return veTodaLaOrganizacion(req) || asignada ? pedida : req.clinicId;
};

/**
 * LA SUCURSAL DESTINO AL AGENDAR: quien puede agendar, elige dónde.
 *
 * No lleva filtro de rol A PROPÓSITO. Quién agenda ya lo decide la ruta
 * (`requireRole` en /appointments y en /chats/:id/appointment); una vez dentro,
 * la sede es un dato de la cita, no un permiso: el paciente pide la sucursal que
 * le queda cerca y quien le atiende el teléfono la escoge.
 *
 * Antes esto se resolvía con `veTodaLaOrganizacion`, que es de VER, y dejaba
 * fuera a gente que sí agenda —el call center y marketing desde el chat—: el
 * selector no les aparecía y sus citas caían siempre en su propia sede. Ese es
 * el error que se estaba pagando a diario.
 *
 * Lo que sí se comprueba es que la sucursal EXISTA y esté ACTIVA: un id
 * manipulado o una sede dada de baja dejaría la cita en un limbo del que nadie
 * la ve.
 *
 * @returns {Promise<{ ok: true, clinicId } | { ok: false, status, message }>}
 */
async function validarSucursalDestino(req, pedida) {
  if (!pedida || String(pedida) === String(req.clinicId)) {
    return { ok: true, clinicId: req.clinicId };
  }
  const Clinic = require('../models/Clinic');
  const destino = await Clinic.findOne({ _id: pedida, active: { $ne: false } })
    .select('_id')
    .lean()
    .catch(() => null);
  if (!destino) {
    return { ok: false, status: 400, message: 'La sucursal destino no existe o está inactiva.' };
  }
  return { ok: true, clinicId: pedida };
}

module.exports = { veTodaLaOrganizacion, sucursalPedida, validarSucursalDestino };
