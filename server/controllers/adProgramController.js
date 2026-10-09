const mongoose = require('mongoose');
const AdProgram = require('../models/AdProgram');
const Workflow = require('../models/Workflow');
const Appointment = require('../models/Appointment');
const Conversation = require('../models/Conversation');

/**
 * ANALÍTICAS DEL CRM POR PROGRAMA DE PUBLICIDAD (oct-2026).
 *
 * Dos partes, como las dos pestañas de la página:
 *   1. CONFIGURAR: los programas (nombre escrito por el usuario), su gasto por
 *      mes, sus anuncios (los ids del disparador «Anuncio» de las
 *      automatizaciones) y sus servicios del inventario.
 *   2. VER: las citas creadas desde el chat que salieron de cada programa, cómo
 *      terminaron y cuánto dejaron.
 *
 * CÓMO SE ATRIBUYE UNA CITA A UN PROGRAMA:
 *   · por ANUNCIO: el anuncio del que vino el chat de la cita —el de la
 *     oportunidad que la agendó, o si no el primero del chat— está entre los del
 *     programa (con sus alias de Meta: el id del Administrador de anuncios y el
 *     de su publicación son el mismo anuncio, ver utils/metaAds);
 *   · por SERVICIO, solo si el chat no trae un anuncio de ningún programa: el
 *     servicio de la cita es de UN solo programa.
 */

const MES = /^\d{4}-\d{2}$/;
const limpiarId = (v) => String(v || '').trim();

/** El cuerpo de la pantalla → campos del programa, saneados. */
function sanear(body = {}) {
  const gastos = (Array.isArray(body.gastos) ? body.gastos : [])
    .map((g) => ({
      mes: String(g?.mes || '').trim(),
      monto: Number(g?.monto),
      nota: String(g?.nota || '').trim(),
    }))
    .filter((g) => MES.test(g.mes) && Number.isFinite(g.monto) && g.monto >= 0);

  const vistos = new Set();
  const anuncios = [];
  for (const a of Array.isArray(body.anuncios) ? body.anuncios : []) {
    const adId = limpiarId(a?.adId);
    if (!adId || vistos.has(adId)) continue;
    vistos.add(adId);
    anuncios.push({
      adId,
      workflow: mongoose.isValidObjectId(a?.workflow) ? a.workflow : null,
      workflowName: String(a?.workflowName || '').trim(),
    });
  }

  const serviciosVistos = new Set();
  const servicios = [];
  for (const s of Array.isArray(body.servicios) ? body.servicios : []) {
    const id = String(s?.serviceItem?._id || s?.serviceItem || '');
    if (!mongoose.isValidObjectId(id) || serviciosVistos.has(id)) continue;
    serviciosVistos.add(id);
    servicios.push({
      serviceItem: id,
      name: String(s?.name || s?.serviceItem?.name || '').trim(),
      generaIngresos: s?.generaIngresos !== false,
    });
  }

  return {
    name: String(body.name || '').trim(),
    color: String(body.color || '').trim(),
    gastos,
    anuncios,
    servicios,
  };
}

/**
 * UN ANUNCIO ES DE UN SOLO PROGRAMA: si dos lo reclamaran, la misma cita
 * contaría en los dos y el total del CRM saldría inflado.
 */
async function anunciosRepetidos(clinicId, anuncios, excluirId = null) {
  if (!anuncios.length) return null;
  const otros = await AdProgram.find({
    clinic: clinicId,
    'anuncios.adId': { $in: anuncios.map((a) => a.adId) },
    ...(excluirId ? { _id: { $ne: excluirId } } : {}),
  }).select('name anuncios.adId').lean();
  if (!otros.length) return null;
  const mios = new Set(anuncios.map((a) => a.adId));
  const choques = otros.flatMap((p) =>
    (p.anuncios || []).filter((a) => mios.has(a.adId)).map((a) => `${a.adId} (ya está en «${p.name}»)`)
  );
  return `Estos anuncios ya pertenecen a otro programa: ${choques.join(', ')}.`;
}

exports.list = async (req, res) => {
  try {
    const programas = await AdProgram.find({ clinic: req.clinicId }).sort({ name: 1 }).lean();
    res.json(programas);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener los programas', error: error.message });
  }
};

exports.create = async (req, res) => {
  try {
    const datos = sanear(req.body);
    if (!datos.name) return res.status(400).json({ message: 'Escribe el nombre del programa.' });
    const choque = await anunciosRepetidos(req.clinicId, datos.anuncios);
    if (choque) return res.status(400).json({ message: choque });
    const programa = await AdProgram.create({ ...datos, clinic: req.clinicId, createdBy: req.user._id });
    res.status(201).json(programa);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear el programa', error: error.message });
  }
};

exports.update = async (req, res) => {
  try {
    const datos = sanear(req.body);
    if (!datos.name) return res.status(400).json({ message: 'Escribe el nombre del programa.' });
    const choque = await anunciosRepetidos(req.clinicId, datos.anuncios, req.params.id);
    if (choque) return res.status(400).json({ message: choque });
    const programa = await AdProgram.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      datos,
      { new: true, runValidators: true }
    );
    if (!programa) return res.status(404).json({ message: 'Programa no encontrado' });
    res.json(programa);
  } catch (error) {
    res.status(500).json({ message: 'Error al guardar el programa', error: error.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const programa = await AdProgram.findOneAndDelete({ _id: req.params.id, clinic: req.clinicId });
    if (!programa) return res.status(404).json({ message: 'Programa no encontrado' });
    res.json({ message: 'Programa eliminado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar el programa', error: error.message });
  }
};

/**
 * LOS ANUNCIOS DE CADA AUTOMATIZACIÓN, para escogerlos en bloque.
 *
 * Son los ids que se escribieron en el disparador «Anuncio» (`ctwa_ad`,
 * `adFilter`, separados por coma), en el nodo disparador o en los disparadores
 * sueltos de las automatizaciones viejas. Escoger la automatización trae todos
 * sus ids de una vez, sin teclearlos uno por uno.
 */
exports.adSources = async (req, res) => {
  try {
    const { getAllChatTriggers } = require('../utils/workflowEngine');
    const workflows = await Workflow.find({
      clinic: req.clinicId,
      $or: [
        { 'trigger.type': 'ctwa_ad' },
        { 'triggers.type': 'ctwa_ad' },
        { 'nodes.type': 'trigger' },
      ],
    }).select('name active trigger triggers nodes').lean();

    const fuentes = workflows
      .map((wf) => {
        const adIds = [...new Set(
          getAllChatTriggers(wf)
            .filter((tr) => tr?.type === 'ctwa_ad')
            .flatMap((tr) => String(tr.adFilter || '').split(','))
            .map(limpiarId)
            .filter(Boolean)
        )];
        return { _id: wf._id, name: wf.name || 'Sin nombre', active: !!wf.active, adIds };
      })
      .filter((f) => f.adIds.length)
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    res.json(fuentes);
  } catch (error) {
    res.status(500).json({ message: 'Error al leer los anuncios de las automatizaciones', error: error.message });
  }
};

// ─── Analítica ──────────────────────────────────────────────────────────────

const ESTADO_GRUPO = {
  asistida: 'efectivas',
  completada: 'efectivas',
  cancelada: 'canceladas',
  no_asistio: 'noAsistio',
  pendiente: 'pendientes',
  confirmada: 'pendientes',
};

const normaNombre = (v) => String(v || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

/** 'YYYY-MM-DD' → Date local al inicio (o al fin) del día. */
function diaLocal(value, fin = false) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return fin
    ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999)
    : new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
}

/** Meses 'YYYY-MM' que toca el rango (para sumar el gasto). */
function mesesDelRango(desde, hasta) {
  const meses = new Set();
  const d = new Date(desde.getFullYear(), desde.getMonth(), 1);
  while (d <= hasta) {
    meses.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() + 1);
  }
  return meses;
}

/** El anuncio del que salió la cita: el de la oportunidad que la agendó, o el del chat. */
function anuncioDeLaCita(apt, conv) {
  const id = String(apt._id);
  const opps = [...(conv?.opportunities || []), conv?.opportunity].filter(Boolean);
  const suya = opps.find((o) => String(o?.appointment || '') === id && o?.attribution?.adId);
  return limpiarId(suya?.attribution?.adId || conv?.attribution?.adId);
}

const vacio = () => ({
  citas: 0,
  efectivas: 0,
  canceladas: 0,
  noAsistio: 0,
  pendientes: 0,
  canjes: 0,
  sinIngreso: 0,
  sinValor: 0,
  ingresos: 0,
  valorAgendado: 0,
});

exports.analytics = async (req, res) => {
  try {
    const desde = diaLocal(req.query.from);
    const hasta = diaLocal(req.query.to, true);
    if (!desde || !hasta || desde > hasta) {
      return res.status(400).json({ message: 'Escoge un rango de fechas válido.' });
    }
    // 'creacion' (por defecto): cuándo se agendó desde el chat. 'cita': el día de la cita.
    const por = req.query.por === 'cita' ? 'cita' : 'creacion';

    const programas = await AdProgram.find({ clinic: req.clinicId }).sort({ name: 1 }).lean();

    // Citas creadas desde un chat de ESTE CRM (la cita puede ser de cualquier sucursal).
    const citas = await Appointment.find({
      conversation: { $ne: null },
      [por === 'cita' ? 'date' : 'createdAt']: { $gte: desde, $lte: hasta },
    })
      .select('patient conversation date startTime createdAt status serviceItem serviceName additionalServices agreedValue isCanje clinic')
      .populate('patient', 'firstName lastName')
      .populate('clinic', 'name nombreComercial')
      .lean();

    const convIds = [...new Set(citas.map((c) => String(c.conversation)))];
    const convs = convIds.length
      ? await Conversation.find({ _id: { $in: convIds }, clinic: req.clinicId })
        .select('phone contactName attribution opportunity.appointment opportunity.attribution opportunities.appointment opportunities.attribution')
        .lean()
      : [];
    const convPorId = new Map(convs.map((c) => [String(c._id), c]));

    // Anuncio → programa, con los alias de Meta (id del Ads Manager ↔ id de la publicación).
    const idsConfigurados = [...new Set(programas.flatMap((p) => (p.anuncios || []).map((a) => a.adId)))];
    let alias = new Map(idsConfigurados.map((id) => [id, new Set([id])]));
    if (idsConfigurados.length) {
      try {
        alias = await require('../utils/metaAds').resolveAdAliases(idsConfigurados);
      } catch { /* el id exacto sigue valiendo */ }
    }
    const programaDeAnuncio = new Map();
    for (const p of programas) {
      for (const a of p.anuncios || []) {
        for (const id of alias.get(a.adId) || [a.adId]) programaDeAnuncio.set(String(id), String(p._id));
      }
    }

    // Servicio → programas que lo tienen (por id y por nombre, por las copias de otra empresa).
    const programasDeServicio = new Map();
    const servicioDelPrograma = new Map(); // `${programa}|${clave}` → servicio del programa
    const anotar = (clave, p, s) => {
      if (!clave) return;
      if (!programasDeServicio.has(clave)) programasDeServicio.set(clave, new Set());
      programasDeServicio.get(clave).add(String(p._id));
      servicioDelPrograma.set(`${p._id}|${clave}`, s);
    };
    for (const p of programas) {
      for (const s of p.servicios || []) {
        anotar(`id:${s.serviceItem}`, p, s);
        anotar(`n:${normaNombre(s.name)}`, p, s);
      }
    }
    const clavesDeLaCita = (c) => [
      c.serviceItem ? `id:${c.serviceItem}` : '',
      c.serviceName ? `n:${normaNombre(c.serviceName)}` : '',
    ].filter(Boolean);

    const resumen = new Map(programas.map((p) => [String(p._id), vacio()]));
    const detalle = new Map(programas.map((p) => [String(p._id), []]));
    const sinPrograma = { ...vacio(), conAnuncio: 0 };

    for (const c of citas) {
      const conv = convPorId.get(String(c.conversation));
      if (!conv) continue; // chat de otro CRM

      const adId = anuncioDeLaCita(c, conv);
      let programaId = adId ? programaDeAnuncio.get(adId) : null;
      let atribucion = programaId ? 'anuncio' : null;
      if (!programaId) {
        const candidatos = new Set(clavesDeLaCita(c).flatMap((k) => [...(programasDeServicio.get(k) || [])]));
        if (candidatos.size === 1) {
          programaId = [...candidatos][0];
          atribucion = 'servicio';
        }
      }

      const grupo = ESTADO_GRUPO[c.status] || 'pendientes';
      const valor = Number(c.agreedValue) || 0;
      const servicioProg = programaId
        ? clavesDeLaCita(c).map((k) => servicioDelPrograma.get(`${programaId}|${k}`)).find(Boolean)
        : null;
      const generaIngresos = servicioProg ? servicioProg.generaIngresos !== false : true;

      const r = programaId ? resumen.get(programaId) : sinPrograma;
      r.citas += 1;
      r[grupo] += 1;
      if (c.isCanje) r.canjes += 1;
      else if (!generaIngresos) r.sinIngreso += 1;
      else if (c.agreedValue === null || c.agreedValue === undefined) r.sinValor += 1;
      // Lo que se espera cobrar de lo que sigue en pie; ingreso = solo lo atendido.
      const cuenta = !c.isCanje && generaIngresos;
      if (cuenta && grupo !== 'canceladas' && grupo !== 'noAsistio') r.valorAgendado += valor;
      if (cuenta && grupo === 'efectivas') r.ingresos += valor;
      if (!programaId) {
        if (adId) sinPrograma.conAnuncio += 1;
        continue;
      }

      detalle.get(programaId).push({
        _id: c._id,
        paciente: c.patient ? `${c.patient.firstName || ''} ${c.patient.lastName || ''}`.trim() : '',
        patientId: c.patient?._id || null,
        contacto: conv.contactName || conv.phone || '',
        conversation: conv._id,
        fecha: c.date,
        hora: c.startTime,
        creada: c.createdAt,
        sucursal: c.clinic?.nombreComercial || c.clinic?.name || '',
        servicio: c.serviceName || '',
        estado: c.status,
        grupo,
        valor: c.agreedValue,
        canje: !!c.isCanje,
        generaIngresos,
        atribucion,
        adId,
      });
    }

    const meses = mesesDelRango(desde, hasta);
    const filas = programas.map((p) => {
      const r = resumen.get(String(p._id));
      const gasto = (p.gastos || []).filter((g) => meses.has(g.mes)).reduce((s, g) => s + (Number(g.monto) || 0), 0);
      return {
        _id: p._id,
        name: p.name,
        color: p.color,
        gasto,
        ...r,
        // Lo que costó cada cita y cada cita efectiva; ROI = (ingresos - gasto) / gasto.
        costoPorCita: r.citas ? gasto / r.citas : null,
        costoPorEfectiva: r.efectivas ? gasto / r.efectivas : null,
        roi: gasto ? (r.ingresos - gasto) / gasto : null,
        citasDetalle: detalle.get(String(p._id)).sort((a, b) => new Date(b.creada) - new Date(a.creada)),
      };
    });

    res.json({ desde: req.query.from, hasta: req.query.to, por, programas: filas, sinPrograma });
  } catch (error) {
    res.status(500).json({ message: 'Error al calcular las analíticas', error: error.message });
  }
};
