/**
 * REGISTRO DE LLAMADAS de WhatsApp (Fénix, oct-2026): quién nos llamó o a quién
 * llamamos, por qué número de la clínica, si se contestó, quién la atendió,
 * cuánto timbró y cuánto duró.
 *
 * EL RESULTADO SE DEDUCE, NO SE LEE DE `status`. El estado guardado no es de
 * fiar para «¿se contestó?»:
 *   · Meta avisa el fin de una entrante con «COMPLETED» aunque nadie la haya
 *     contestado (el contacto colgó mientras sonaba), y se guardaba como
 *     `completed`: en producción eran 152 de 244 «completadas».
 *   · Si el contacto colgaba justo mientras el agente contestaba, el «aceptar»
 *     que llegaba tarde volvía a poner `active` sobre la llamada ya cerrada.
 * Lo que de verdad dice si hubo conversación es `connectedAt` (anterior al
 * fin). Ambas causas se corrigieron en callController, y este cálculo deja bien
 * también el historial que ya existía, sin reescribirlo.
 */
const mongoose = require('mongoose');
const Call = require('../models/Call');
const Conversation = require('../models/Conversation');
const WhatsappAccount = require('../models/WhatsappAccount');
const { canAccessConversation } = require('./chatController');
const { nameSearchFilter } = require('../utils/nameSearch');
const { phoneSearchRegex } = require('../utils/phoneNormalize');

const RESULTADOS = ['contestada', 'perdida', 'rechazada', 'no_contesto', 'fallida', 'en_curso'];
// Una llamada «viva» sin cierre más allá de esto es un cierre que nunca llegó
// (servidor reiniciado, webhook perdido), no una llamada en curso.
const MAX_SONANDO_MS = 2 * 60 * 1000;
const MAX_ACTIVA_MS = 3 * 60 * 60 * 1000;
const MAX_POR_PAGINA = 200;

/** 'YYYY-MM-DD' → inicio/fin del día en la hora del servidor (Ecuador). */
function rangoDias(desde, hasta) {
  const dia = (s, fin) => {
    const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return fin
      ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999)
      : new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  };
  const hoy = new Date();
  const fin = dia(hasta, true) || new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate(), 23, 59, 59, 999);
  const inicio = dia(desde, false) || new Date(fin.getFullYear(), fin.getMonth(), fin.getDate() - 29);
  return { inicio, fin };
}

const oid = (v) => (mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(String(v)) : null);
const campo = (f) => ({ $ifNull: [`$${f}`, null] });

/**
 * Los chats que este agente NO puede ver (reservados a otro asesor por un
 * workflow). Mismo candado que la bandeja: sus llamadas tampoco salen aquí.
 */
async function chatsVedados(req) {
  if (req.user?.isSuperAdmin || req.role !== 'call_center') return [];
  const convs = await Conversation.find({ clinic: req.clinicId, workflowRestrictedTo: { $ne: null } })
    .select('_id workflowRestrictedTo workflowRestrictionActive')
    .lean();
  return convs.filter((c) => !canAccessConversation(req, c)).map((c) => c._id);
}

/** Campos calculados de cada llamada: resultado, duración y cuánto timbró. */
function camposCalculados(ahora) {
  const conectada = {
    $and: [
      { $ne: [campo('connectedAt'), null] },
      { $or: [{ $eq: [campo('endedAt'), null] }, { $gte: [campo('endedAt'), campo('connectedAt')] }] },
    ],
  };
  const viva = {
    $and: [
      { $in: ['$status', ['ringing', 'active']] },
      { $eq: [campo('endedAt'), null] },
      {
        $gt: ['$startedAt', {
          $cond: [
            { $eq: ['$status', 'ringing'] },
            new Date(ahora.getTime() - MAX_SONANDO_MS),
            new Date(ahora.getTime() - MAX_ACTIVA_MS),
          ],
        }],
      },
    ],
  };
  const segundos = (a, b) => ({ $round: [{ $divide: [{ $subtract: [a, b] }, 1000] }, 0] });
  return [
    { $addFields: { _conectada: conectada, _viva: viva } },
    {
      $addFields: {
        resultado: {
          $switch: {
            branches: [
              { case: '$_viva', then: 'en_curso' },
              { case: '$_conectada', then: 'contestada' },
              { case: { $eq: ['$status', 'rejected'] }, then: 'rechazada' },
              { case: { $eq: ['$status', 'failed'] }, then: 'fallida' },
              { case: { $eq: ['$direction', 'in'] }, then: 'perdida' },
            ],
            default: 'no_contesto',
          },
        },
        // Duración de la conversación: la que se guardó al colgar; si falta, la
        // de las marcas de tiempo; sin fin registrado, desconocida (null).
        duracion: {
          $cond: [
            '$_conectada',
            {
              $cond: [
                { $gt: [{ $ifNull: ['$durationSec', 0] }, 0] },
                '$durationSec',
                { $cond: [{ $ne: [campo('endedAt'), null] }, segundos('$endedAt', '$connectedAt'), null] },
              ],
            },
            0,
          ],
        },
        // Cuánto timbró: hasta que se contestó o, si no, hasta que se cortó.
        timbre: {
          $cond: [
            '$_conectada',
            segundos('$connectedAt', '$startedAt'),
            { $cond: [{ $ne: [campo('endedAt'), null] }, segundos('$endedAt', '$startedAt'), null] },
          ],
        },
      },
    },
  ];
}

exports.callLog = async (req, res) => {
  try {
    const { inicio, fin } = rangoDias(req.query.from, req.query.to);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), MAX_POR_PAGINA);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const resultado = RESULTADOS.includes(req.query.result) ? req.query.result : '';

    const base = { clinic: oid(req.clinicId), startedAt: { $gte: inicio, $lte: fin } };
    if (['in', 'out'].includes(req.query.direction)) base.direction = req.query.direction;
    if (oid(req.query.account)) base.whatsappAccount = oid(req.query.account);
    if (oid(req.query.agent)) base.agent = oid(req.query.agent);

    const condiciones = [];
    const vedados = await chatsVedados(req);
    if (vedados.length) condiciones.push({ conversation: { $nin: vedados } });

    // Búsqueda por nombre del contacto (palabras sueltas, sin tildes) o teléfono.
    const q = String(req.query.q || '').trim();
    if (q) {
      const porNombre = nameSearchFilter(q, ['contactName']);
      const telefono = phoneSearchRegex(q);
      const convs = porNombre || telefono
        ? await Conversation.find({
            clinic: req.clinicId,
            $or: [...(porNombre ? [porNombre] : []), ...(telefono ? [{ phone: telefono }] : [])],
          }).select('_id').limit(2000).lean()
        : [];
      condiciones.push({
        $or: [
          { conversation: { $in: convs.map((c) => c._id) } },
          ...(telefono ? [{ phone: telefono }] : []),
        ],
      });
    }
    if (condiciones.length) base.$and = condiciones;

    const ahora = new Date();
    const filtroResultado = resultado ? [{ $match: { resultado } }] : [];
    const [agg] = await Call.aggregate([
      { $match: base },
      { $project: { offerSdp: 0 } },
      ...camposCalculados(ahora),
      {
        $facet: {
          // Los números de arriba NO llevan el filtro de resultado: son las
          // tarjetas con las que se elige ese filtro.
          resumen: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                entrantes: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, 1, 0] } },
                salientes: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, 1, 0] } },
                ...Object.fromEntries(RESULTADOS.map((r) => [r, { $sum: { $cond: [{ $eq: ['$resultado', r] }, 1, 0] } }])),
                entrantesContestadas: {
                  $sum: { $cond: [{ $and: [{ $eq: ['$direction', 'in'] }, { $eq: ['$resultado', 'contestada'] }] }, 1, 0] },
                },
                duracionTotal: { $sum: { $cond: [{ $eq: ['$resultado', 'contestada'] }, { $ifNull: ['$duracion', 0] }, 0] } },
                duracionPromedio: { $avg: { $cond: [{ $eq: ['$resultado', 'contestada'] }, '$duracion', null] } },
                // Cuánto espera quien nos llama hasta que alguien contesta.
                esperaPromedio: {
                  $avg: {
                    $cond: [{ $and: [{ $eq: ['$direction', 'in'] }, { $eq: ['$resultado', 'contestada'] }] }, '$timbre', null],
                  },
                },
              },
            },
          ],
          total: [...filtroResultado, { $count: 'n' }],
          filas: [
            ...filtroResultado,
            { $sort: { startedAt: -1, _id: -1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $lookup: {
                from: 'conversations',
                localField: 'conversation',
                foreignField: '_id',
                pipeline: [{ $project: { contactName: 1, phone: 1, patient: 1 } }],
                as: 'conv',
              },
            },
            {
              $lookup: {
                from: 'patients',
                localField: 'patient',
                foreignField: '_id',
                pipeline: [{ $project: { firstName: 1, lastName: 1 } }],
                as: 'pac',
              },
            },
            {
              $lookup: {
                from: 'whatsappaccounts',
                localField: 'whatsappAccount',
                foreignField: '_id',
                pipeline: [{ $project: { label: 1, displayPhone: 1, connectedPhone: 1 } }],
                as: 'cuenta',
              },
            },
          ],
        },
      },
    ]).allowDiskUse(true);

    const r = agg?.resumen?.[0] || {};
    const total = agg?.total?.[0]?.n || 0;
    const filas = (agg?.filas || []).map((c) => {
      const conv = c.conv?.[0];
      const pac = c.pac?.[0];
      const cuenta = c.cuenta?.[0];
      const nombrePaciente = pac ? `${pac.firstName || ''} ${pac.lastName || ''}`.trim() : '';
      return {
        id: String(c._id),
        direction: c.direction,
        resultado: c.resultado,
        status: c.status,
        startedAt: c.startedAt,
        connectedAt: c.connectedAt || null,
        endedAt: c.endedAt || null,
        duracion: c.duracion,
        timbre: c.timbre,
        contacto: conv?.contactName || nombrePaciente || '',
        phone: c.phone || conv?.phone || '',
        conversationId: c.conversation ? String(c.conversation) : null,
        patientId: c.patient ? String(c.patient) : null,
        paciente: nombrePaciente,
        numero: cuenta
          ? { id: String(cuenta._id), label: cuenta.label || '', phone: cuenta.displayPhone || cuenta.connectedPhone || '' }
          : null,
        agente: c.agentName || '',
        errorMessage: c.errorMessage || '',
      };
    });

    // Opciones de los filtros: los números y agentes que aparecen en llamadas.
    const [idsCuentas, agentes] = await Promise.all([
      Call.distinct('whatsappAccount', { clinic: req.clinicId }),
      Call.aggregate([
        { $match: { clinic: oid(req.clinicId), agent: { $ne: null } } },
        { $group: { _id: '$agent', name: { $last: '$agentName' } } },
        { $sort: { name: 1 } },
      ]),
    ]);
    const cuentas = await WhatsappAccount.find({ _id: { $in: idsCuentas.filter(Boolean) } })
      .select('label displayPhone connectedPhone')
      .lean();

    res.json({
      from: inicio,
      to: fin,
      resumen: {
        total: r.total || 0,
        entrantes: r.entrantes || 0,
        salientes: r.salientes || 0,
        ...Object.fromEntries(RESULTADOS.map((k) => [k, r[k] || 0])),
        entrantesContestadas: r.entrantesContestadas || 0,
        duracionTotal: Math.round(r.duracionTotal || 0),
        duracionPromedio: r.duracionPromedio != null ? Math.round(r.duracionPromedio) : null,
        esperaPromedio: r.esperaPromedio != null ? Math.round(r.esperaPromedio) : null,
      },
      calls: filas,
      pagination: { page, limit, total, pages: Math.max(Math.ceil(total / limit), 1) },
      opciones: {
        numeros: cuentas
          .map((a) => ({ id: String(a._id), label: a.label || '', phone: a.displayPhone || a.connectedPhone || '' }))
          .sort((a, b) => a.label.localeCompare(b.label)),
        agentes: agentes.map((a) => ({ id: String(a._id), name: a.name || '—' })),
      },
    });
  } catch (err) {
    res.status(500).json({ message: 'Error al consultar el registro de llamadas', error: err.message });
  }
};

// Para pruebas.
exports._rangoDias = rangoDias;
