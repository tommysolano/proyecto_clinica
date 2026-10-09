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

/** Número de día absoluto de una fecha local (para contar días sin líos de hora). */
const numeroDeDia = (d) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);

/**
 * EL GASTO DEL RANGO, PROPORCIONAL POR DÍA (oct-2026).
 *
 * El gasto se registra por mes, pero se reparte a partes iguales entre los días
 * del mes y solo cuentan los días YA TRANSCURRIDOS: al 9 de octubre, un gasto
 * de $775 en octubre pesa 775 ÷ 31 × 9. Antes se sumaba el mes entero en cuanto
 * el rango lo tocaba, y el costo por cita de un mes a medias salía inflado.
 *
 * @returns {{ gasto: number, dias: number }} el gasto y los días que se contaron
 */
function gastoDelRango(gastos, desde, hasta, hoy = new Date()) {
  const finHoy = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate(), 23, 59, 59, 999);
  const fin = hasta < finHoy ? hasta : finHoy;
  if (fin < desde) return { gasto: 0, dias: 0 };
  let gasto = 0;
  const diasContados = new Set();
  for (const g of gastos || []) {
    const [y, m] = String(g.mes || '').split('-').map(Number);
    if (!y || !m) continue;
    const inicioMes = new Date(y, m - 1, 1);
    const finMes = new Date(y, m, 0);
    const diasDelMes = finMes.getDate();
    const a = Math.max(numeroDeDia(inicioMes), numeroDeDia(desde));
    const b = Math.min(numeroDeDia(finMes), numeroDeDia(fin));
    if (b < a) continue;
    gasto += ((Number(g.monto) || 0) / diasDelMes) * (b - a + 1);
    for (let d = a; d <= b; d += 1) diasContados.add(d);
  }
  return { gasto: Math.round(gasto * 100) / 100, dias: diasContados.size };
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
    // Cualquier alias → el programa, y → el id tal como se configuró.
    const programaDeAnuncio = new Map();
    const anuncioConfigurado = new Map();
    for (const p of programas) {
      for (const a of p.anuncios || []) {
        for (const id of alias.get(a.adId) || [a.adId]) {
          programaDeAnuncio.set(String(id), String(p._id));
          anuncioConfigurado.set(String(id), a.adId);
        }
      }
    }

    /**
     * LOS CHATS QUE TRAJO CADA ANUNCIO en el rango: el chat que nació de él, o
     * una oportunidad que se abrió en el rango por ese anuncio (un chat viejo
     * que vuelve a escribir desde otro anuncio). Siempre por fecha de llegada.
     */
    const chatsPorAnuncio = new Map(); // id configurado → Set(conv)
    const chatsPorPrograma = new Map(); // programa → Set(conv)
    const todosLosAlias = [...programaDeAnuncio.keys()];
    if (todosLosAlias.length) {
      const enRango = { $gte: desde, $lte: hasta };
      const llegadas = await Conversation.find({
        clinic: req.clinicId,
        $or: [
          { 'attribution.adId': { $in: todosLosAlias }, createdAt: enRango },
          { opportunities: { $elemMatch: { 'attribution.adId': { $in: todosLosAlias }, createdAt: enRango } } },
        ],
      }).select('createdAt attribution.adId opportunities.attribution.adId opportunities.createdAt').lean();
      const dentro = (f) => f && new Date(f) >= desde && new Date(f) <= hasta;
      for (const conv of llegadas) {
        const ids = new Set();
        if (dentro(conv.createdAt) && conv.attribution?.adId) ids.add(limpiarId(conv.attribution.adId));
        for (const o of conv.opportunities || []) {
          if (dentro(o.createdAt) && o.attribution?.adId) ids.add(limpiarId(o.attribution.adId));
        }
        for (const id of ids) {
          const prog = programaDeAnuncio.get(id);
          if (!prog) continue;
          const conf = anuncioConfigurado.get(id);
          if (!chatsPorAnuncio.has(conf)) chatsPorAnuncio.set(conf, new Set());
          chatsPorAnuncio.get(conf).add(String(conv._id));
          if (!chatsPorPrograma.has(prog)) chatsPorPrograma.set(prog, new Set());
          chatsPorPrograma.get(prog).add(String(conv._id));
        }
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
    // Por anuncio dentro de cada programa: `${programa}|${idConfigurado}` (o '|servicio').
    const porAnuncio = new Map();
    // Los anuncios que trajeron citas y no son de ningún programa, para asignarlos.
    const sueltos = new Map();
    /** Suma una cita a un acumulado (resumen, anuncio o suelto). */
    const sumar = (r, { grupo, valor, isCanje, generaIngresos, sinValor }) => {
      r.citas += 1;
      r[grupo] += 1;
      if (isCanje) r.canjes += 1;
      else if (!generaIngresos) r.sinIngreso += 1;
      else if (sinValor) r.sinValor += 1;
      // Lo que se espera cobrar de lo que sigue en pie; ingreso = solo lo atendido.
      const cuenta = !isCanje && generaIngresos;
      if (cuenta && grupo !== 'canceladas' && grupo !== 'noAsistio') r.valorAgendado += valor;
      if (cuenta && grupo === 'efectivas') r.ingresos += valor;
    };

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

      const datosCita = {
        grupo,
        valor,
        isCanje: !!c.isCanje,
        generaIngresos,
        sinValor: c.agreedValue === null || c.agreedValue === undefined,
      };
      sumar(programaId ? resumen.get(programaId) : sinPrograma, datosCita);
      if (!programaId) {
        if (adId) {
          sinPrograma.conAnuncio += 1;
          if (!sueltos.has(adId)) sueltos.set(adId, { adId, titular: '', ...vacio() });
          const s = sueltos.get(adId);
          sumar(s, datosCita);
          if (!s.titular && conv.attribution?.campaign) s.titular = conv.attribution.campaign;
        }
        continue;
      }
      const idConfigurado = atribucion === 'anuncio' ? anuncioConfigurado.get(adId) || adId : '';
      const claveAnuncio = `${programaId}|${idConfigurado}`;
      if (!porAnuncio.has(claveAnuncio)) porAnuncio.set(claveAnuncio, { titular: '', ...vacio() });
      const pa = porAnuncio.get(claveAnuncio);
      sumar(pa, datosCita);
      if (!pa.titular && atribucion === 'anuncio' && conv.attribution?.campaign) pa.titular = conv.attribution.campaign;

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
        adId: idConfigurado || adId,
      });
    }

    let diasDelGasto = 0;
    const filas = programas.map((p) => {
      const pid = String(p._id);
      const r = resumen.get(pid);
      const { gasto, dias } = gastoDelRango(p.gastos, desde, hasta);
      diasDelGasto = Math.max(diasDelGasto, dias);

      // Una fila por anuncio del programa —también los que no trajeron nada,
      // que es justo lo que hay que ver—, y al final las caídas por servicio.
      const anuncios = (p.anuncios || []).map((a) => {
        const pa = porAnuncio.get(`${pid}|${a.adId}`) || { titular: '', ...vacio() };
        return {
          adId: a.adId,
          workflowName: a.workflowName || '',
          ...pa,
          chats: chatsPorAnuncio.get(a.adId)?.size || 0,
        };
      });
      const porServicio = porAnuncio.get(`${pid}|`);
      if (porServicio) anuncios.push({ adId: '', workflowName: '', ...porServicio, chats: 0, porServicio: true });

      return {
        _id: p._id,
        name: p.name,
        color: p.color,
        gasto,
        chats: chatsPorPrograma.get(pid)?.size || 0,
        anuncios,
        ...r,
        // Lo que costó cada cita y cada cita efectiva; ROI = (ingresos - gasto) / gasto.
        costoPorCita: r.citas ? gasto / r.citas : null,
        costoPorEfectiva: r.efectivas ? gasto / r.efectivas : null,
        roi: gasto ? (r.ingresos - gasto) / gasto : null,
        citasDetalle: detalle.get(String(p._id)).sort((a, b) => new Date(b.creada) - new Date(a.creada)),
      };
    });

    res.json({
      desde: req.query.from,
      hasta: req.query.to,
      por,
      diasDelGasto,
      programas: filas,
      sinPrograma,
      // Los que más citas trajeron primero: son los que vale la pena asignar.
      anunciosSinPrograma: [...sueltos.values()].sort((a, b) => b.citas - a.citas),
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al calcular las analíticas', error: error.message });
  }
};

// Para los tests: el prorrateo del gasto por día.
exports._gastoDelRango = gastoDelRango;
