/**
 * CENTRO DE COSTO DE LA BODEGA: propuesta, no imposición.
 *
 * Fuente ÚNICA de la regla. La usan compras, ventas, traslados y tomas físicas. La regla es la
 * misma en los cuatro sitios y por eso vive en uno solo:
 *
 *   1. La bodega tiene un centro de costo PREDETERMINADO (`Warehouse.costCenter`).
 *   2. Si el documento no trae centro, se PROPONE el de la bodega. No se contabiliza nada por
 *      proponerlo: es un valor editable.
 *   3. Si el documento YA trae un centro, no se pisa en silencio. Si además es distinto del de
 *      la bodega, hay que CONFIRMARLO: sin confirmación se rechaza con un error controlado
 *      (409 + `code: 'COST_CENTER_MISMATCH'`) que dice bodega, centro esperado y centro elegido.
 *   4. Manda el DOCUMENTO: se registra el centro que realmente se usó, y la diferencia
 *      confirmada queda en el log de auditoría.
 *
 * ── Por qué el backend y no React ───────────────────────────────────────────────────────────
 * Una advertencia en pantalla se salta con un `curl`. La propuesta, la validación (misma clínica,
 * ambos activos) y el rechazo de la diferencia no confirmada ocurren AQUÍ; la pantalla solo lo
 * explica antes de que el usuario llegue al error.
 *
 * ── Alcance ─────────────────────────────────────────────────────────────────────────────────
 * Un centro de costo SIN bodega es legítimo (un gasto, un servicio) y se valida igual. Lo que
 * nunca se hace es INVENTAR el centro de una bodega que no existe: un servicio sin bodega se
 * queda sin centro de bodega (puede tener el suyo propio, elegido a mano).
 */
const Warehouse = require('../models/Warehouse');
const CostCenter = require('../models/CostCenter');

const withSession = (q, session) => (session ? q.session(session) : q);
const idOf = (v) => String(v && typeof v === 'object' ? (v._id ?? v) : (v ?? ''));

const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });
const etiqueta = (cc) => (cc ? `${cc.code} - ${cc.name}` : '(sin centro)');

/**
 * Resolutor con caché: una compra de 20 líneas no consulta la misma bodega 20 veces.
 * Se crea uno por operación (create/update/authorize/venta) y se descarta.
 */
function createResolver({ clinicId, session = null } = {}) {
  const bodegas = new Map();
  const centros = new Map();

  async function getWarehouse(id) {
    const key = idOf(id);
    if (!key) return null;
    if (bodegas.has(key)) return bodegas.get(key);
    const wh = await withSession(Warehouse.findOne({ _id: key, clinic: clinicId }), session);
    if (!wh) throw badRequest('La bodega seleccionada no existe en esta clínica.');
    if (wh.active === false) {
      throw badRequest(`La bodega "${wh.name}" está inactiva: no se puede registrar movimientos en ella.`);
    }
    bodegas.set(key, wh);
    return wh;
  }

  async function getCostCenter(id, { exigirActivo = true } = {}) {
    const key = idOf(id);
    if (!key) return null;
    if (centros.has(key)) {
      const cc = centros.get(key);
      if (exigirActivo && cc && cc.active === false) {
        throw badRequest(`El centro de costo "${etiqueta(cc)}" está inactivo.`);
      }
      return cc;
    }
    const cc = await withSession(CostCenter.findOne({ _id: key, clinic: clinicId }), session);
    // Un centro de OTRA clínica no existe para esta: no se filtra en silencio, se rechaza.
    if (!cc) throw badRequest('El centro de costo seleccionado no existe en esta clínica.');
    centros.set(key, cc);
    if (exigirActivo && cc.active === false) {
      throw badRequest(`El centro de costo "${etiqueta(cc)}" está inactivo: elige uno activo.`);
    }
    return cc;
  }

  /**
   * Resuelve el centro de costo EFECTIVO de un movimiento contra su bodega.
   *
   * @param {object}  p
   * @param {*}       p.warehouse   bodega elegida (o nada)
   * @param {*}       p.costCenter  centro elegido (o nada → se propone el de la bodega)
   * @param {boolean} p.confirmed   el usuario ya confirmó una diferencia
   * @param {string}  p.contexto    texto para el mensaje ("la compra", "la venta"…)
   * @returns {Promise<{warehouse, costCenter, propuesto, elegido, origen, diferente, aviso}>}
   *          `origen`: PROPUESTO (lo puso la bodega) | ELEGIDO (lo puso el usuario) | NINGUNO
   */
  async function resolve({ warehouse, costCenter, confirmed = false, contexto = 'el documento' } = {}) {
    const wh = await getWarehouse(warehouse);
    const elegido = await getCostCenter(costCenter);

    // El centro predeterminado de la bodega solo se PROPONE si sigue activo: proponer uno
    // inactivo sería empujar al usuario a un error.
    let propuesto = null;
    if (wh && wh.costCenter) {
      const cand = await getCostCenter(wh.costCenter, { exigirActivo: false });
      if (cand && cand.active !== false) propuesto = cand;
    }

    const vacio = {
      warehouse: wh ? wh._id : null,
      propuesto: propuesto ? propuesto._id : null,
      diferente: false,
      aviso: null,
    };

    if (!elegido) {
      // Propuesta: si no hay bodega (o no tiene centro), no se inventa ninguno.
      return { ...vacio, costCenter: propuesto ? propuesto._id : null, elegido: null, origen: propuesto ? 'PROPUESTO' : 'NINGUNO' };
    }

    const diferente = !!(propuesto && idOf(propuesto._id) !== idOf(elegido._id));
    if (diferente && !confirmed) {
      throw Object.assign(
        new Error(
          `La bodega "${wh.name}" tiene el centro de costo "${etiqueta(propuesto)}", pero ${contexto} se está `
          + `registrando con "${etiqueta(elegido)}". Quedará registrado con "${etiqueta(elegido)}". `
          + 'Confirma la diferencia para continuar.'
        ),
        {
          status: 409,
          payload: {
            code: 'COST_CENTER_MISMATCH',
            warehouse: { _id: String(wh._id), name: wh.name },
            esperado: { _id: String(propuesto._id), code: propuesto.code, name: propuesto.name },
            elegido: { _id: String(elegido._id), code: elegido.code, name: elegido.name },
          },
        }
      );
    }

    return {
      ...vacio,
      costCenter: elegido._id,
      elegido: elegido._id,
      origen: 'ELEGIDO',
      diferente,
      aviso: diferente
        ? `Bodega "${wh.name}": centro esperado ${etiqueta(propuesto)}, registrado con ${etiqueta(elegido)}.`
        : null,
    };
  }

  return { resolve, getWarehouse, getCostCenter };
}

/**
 * Deja registro de las diferencias CONFIRMADAS. Una diferencia aceptada no puede desaparecer:
 * el mayor mostrará el centro elegido y alguien tendrá que poder explicar por qué.
 */
async function auditarDiferencias(avisos, { clinicId, req, entity, entityId, session = null } = {}) {
  const textos = (avisos || []).filter(Boolean);
  if (!textos.length) return;
  const AuditLog = require('../models/AuditLog');
  await AuditLog.create([{
    clinic: clinicId,
    user: req.user?._id,
    userName: req.user?.name || req.user?.email,
    role: req.role || req.user?.role,
    action: 'POST',
    entity,
    entityId: String(entityId || ''),
    description: `Registró con un centro de costo distinto al predeterminado de la bodega. ${textos.join(' ')}`,
    method: req.method || 'POST',
    path: req.originalUrl || '',
    after: { costCenterOverrides: textos },
    success: true,
  }], session ? { session } : {});
}

module.exports = { createResolver, auditarDiferencias };
