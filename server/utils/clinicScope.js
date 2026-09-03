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
 */
const veTodaLaOrganizacion = (req) =>
  !!req.user?.isSuperAdmin || ['admin', 'cajero'].includes(req.role);

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

module.exports = { veTodaLaOrganizacion, sucursalPedida };
