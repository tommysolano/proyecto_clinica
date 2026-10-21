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
async function anunciosRepetidos(anuncios, excluirId = null) {
  if (!anuncios.length) return null;
  const otros = await AdProgram.find({
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

/**
 * LOS PROGRAMAS SON DE TODO EL CRM, NO DE UNA SUCURSAL (oct-2026).
 *
 * Se guardaban con la sucursal ACTIVA de quien los creaba y se leían filtrando
 * por ella: al pasar de Central a Laboratorio la página salía vacía. El CRM es
 * uno solo (chats, automatizaciones y anuncios son de todas las sedes), así que
 * los programas se leen y se editan SIN mirar su `clinic`; los nuevos se
 * guardan en la clínica ancla del CRM (las rutas van con `callCenterScope`).
 */
const TODOS_LOS_PROGRAMAS = {};

exports.list = async (req, res) => {
  try {
    const programas = await AdProgram.find(TODOS_LOS_PROGRAMAS).sort({ name: 1 }).lean();
    res.json(programas);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener los programas', error: error.message });
  }
};

exports.create = async (req, res) => {
  try {
    const datos = sanear(req.body);
    if (!datos.name) return res.status(400).json({ message: 'Escribe el nombre del programa.' });
    const choque = await anunciosRepetidos(datos.anuncios);
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
    const choque = await anunciosRepetidos(datos.anuncios, req.params.id);
    if (choque) return res.status(400).json({ message: choque });
    const programa = await AdProgram.findOneAndUpdate(
      { _id: req.params.id },
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
    const programa = await AdProgram.findOneAndDelete({ _id: req.params.id });
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

    /**
     * EL TITULAR DE CADA ANUNCIO (oct-2026): un id de 18 cifras no dice nada al
     * escoger; el titular que Meta manda con el primer mensaje del chat, sí.
     */
    const ids = [...new Set(fuentes.flatMap((f) => f.adIds))];
    const titulares = {};
    if (ids.length) {
      const filas = await Conversation.aggregate([
        { $match: { clinic: new mongoose.Types.ObjectId(String(req.clinicId)), 'attribution.adId': { $in: ids } } },
        { $match: { 'attribution.campaign': { $nin: [null, ''] } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$attribution.adId', titular: { $first: '$attribution.campaign' } } },
      ]);
      for (const f of filas) titulares[f._id] = f.titular;
    }
    res.json(fuentes.map((f) => ({ ...f, titulares: Object.fromEntries(f.adIds.filter((id) => titulares[id]).map((id) => [id, titulares[id]])) })));
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
  cortesias: 0,
  sinIngreso: 0,
  sinValor: 0,
  ingresos: 0,
  valorAgendado: 0,
});

/** Anuncio (y cada alias de Meta) → programa, y → el id tal como se configuró. */
async function mapaDeAnuncios(programas) {
  // Alias de Meta: el id del Ads Manager y el de su publicación son el mismo anuncio.
  const idsConfigurados = [...new Set(programas.flatMap((p) => (p.anuncios || []).map((a) => a.adId)))];
  let alias = new Map(idsConfigurados.map((id) => [id, new Set([id])]));
  if (idsConfigurados.length) {
    try {
      alias = await require('../utils/metaAds').resolveAdAliases(idsConfigurados);
    } catch { /* el id exacto sigue valiendo */ }
  }
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
  return { programaDeAnuncio, anuncioConfigurado };
}

/**
 * LOS CHATS QUE LLEGARON POR UN ANUNCIO en el rango —de CUALQUIER anuncio, sea o
 * no de un programa—: el chat que nació de él, o una oportunidad que se abrió en
 * el rango por ese anuncio (un chat viejo que vuelve a escribir desde otro
 * anuncio). Siempre por fecha de llegada.
 *
 * @returns {Promise<Array<{ conv: object, arribos: Array<{ adId, titular, fecha }> }>>}
 */
async function llegadasDeAnuncios(clinicId, desde, hasta, extraSelect = '') {
  const enRango = { $gte: desde, $lte: hasta };
  const conAnuncio = { $nin: [null, ''] };
  const convs = await Conversation.find({
    clinic: clinicId,
    // Quien llegó en el rango escribió en el rango: con esto la consulta usa
    // el índice {clinic, lastMessageAt} en vez de recorrer todos los chats.
    lastMessageAt: { $gte: desde },
    $or: [
      { 'attribution.adId': conAnuncio, createdAt: enRango },
      { opportunities: { $elemMatch: { 'attribution.adId': conAnuncio, createdAt: enRango } } },
    ],
  })
    .select(`createdAt attribution.adId attribution.campaign opportunities.attribution.adId opportunities.attribution.campaign opportunities.createdAt ${extraSelect}`)
    .lean();
  const dentro = (f) => f && new Date(f) >= desde && new Date(f) <= hasta;
  return convs.map((conv) => {
    const porId = new Map();
    const anotar = (adId, titular, fecha) => {
      const id = limpiarId(adId);
      if (!id || !dentro(fecha)) return;
      const previo = porId.get(id);
      if (!previo || new Date(fecha) < new Date(previo.fecha)) {
        porId.set(id, { adId: id, titular: titular || previo?.titular || '', fecha: new Date(fecha) });
      }
    };
    anotar(conv.attribution?.adId, conv.attribution?.campaign, conv.createdAt);
    for (const o of conv.opportunities || []) anotar(o.attribution?.adId, o.attribution?.campaign, o.createdAt);
    return { conv, arribos: [...porId.values()] };
  }).filter((l) => l.arribos.length);
}

/** Fecha → 'YYYY-MM-DD' en la hora local del servidor (Guayaquil). */
const ymdLocal = (d) => {
  const f = new Date(d);
  return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
};

/**
 * LOS CUBOS DE LA SERIE DE LOS GRÁFICOS: por día, o por mes cuando el rango
 * pasa de ~3 meses (cientos de barras no se leen).
 */
function cubosDelRango(desde, hasta) {
  const dias = numeroDeDia(hasta) - numeroDeDia(desde) + 1;
  const porMes = dias > 92;
  const claves = [];
  const d = new Date(desde.getFullYear(), desde.getMonth(), porMes ? 1 : desde.getDate());
  while (d <= hasta) {
    const k = ymdLocal(d);
    claves.push(porMes ? k.slice(0, 7) : k);
    if (porMes) d.setMonth(d.getMonth() + 1);
    else d.setDate(d.getDate() + 1);
  }
  return { porMes, claves, cubo: (fecha) => (porMes ? ymdLocal(fecha).slice(0, 7) : ymdLocal(fecha)) };
}

exports.analytics = async (req, res) => {
  try {
    const desde = diaLocal(req.query.from);
    const hasta = diaLocal(req.query.to, true);
    if (!desde || !hasta || desde > hasta) {
      return res.status(400).json({ message: 'Escoge un rango de fechas válido.' });
    }
    // 'creacion' (por defecto): cuándo se agendó desde el chat. 'cita': el día de la cita.
    const por = req.query.por === 'cita' ? 'cita' : 'creacion';

    const programas = await AdProgram.find(TODOS_LOS_PROGRAMAS).sort({ name: 1 }).lean();

    // Citas creadas desde un chat de ESTE CRM (la cita puede ser de cualquier sucursal).
    const citas = await Appointment.find({
      conversation: { $ne: null },
      [por === 'cita' ? 'date' : 'createdAt']: { $gte: desde, $lte: hasta },
    })
      .select('patient conversation date startTime createdAt status serviceItem serviceName additionalServices agreedValue isCanje isCortesia clinic')
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

    const { programaDeAnuncio, anuncioConfigurado } = await mapaDeAnuncios(programas);
    const nombrePrograma = new Map(programas.map((p) => [String(p._id), p.name]));
    const { porMes, claves: cubos, cubo } = cubosDelRango(desde, hasta);
    const serieVacia = () => new Map(cubos.map((k) => [k, { chats: 0, citas: 0, efectivas: 0 }]));
    const serie = serieVacia();
    const seriePorPrograma = new Map(programas.map((p) => [String(p._id), serieVacia()]));
    const enSerie = (mapa, fecha, campo) => {
      const fila = mapa?.get(cubo(fecha));
      if (fila) fila[campo] += 1;
    };

    /**
     * LOS CHATS QUE TRAJO CADA ANUNCIO en el rango, de TODOS los anuncios
     * (oct-2026): los de los programas cuentan para su programa, y el resto se
     * ve igual en «Chats de anuncios» para saber qué trae cada uno.
     */
    const chatsPorAnuncio = new Map(); // id configurado → Set(conv)
    const chatsPorPrograma = new Map(); // programa → Set(conv)
    const anunciosConChats = new Map(); // id (configurado o tal cual llegó) → resumen
    const llegadas = await llegadasDeAnuncios(req.clinicId, desde, hasta);
    const idsConChat = llegadas.map((l) => l.conv._id);
    const conCita = new Set(
      idsConChat.length
        ? (await Appointment.distinct('conversation', { conversation: { $in: idsConChat } })).map(String)
        : []
    );
    for (const { conv, arribos } of llegadas) {
      const cid = String(conv._id);
      // En la serie general el chat cuenta UNA vez, el día de su primera llegada.
      enSerie(serie, arribos.reduce((min, a) => (a.fecha < min ? a.fecha : min), arribos[0].fecha), 'chats');
      const primeraPorPrograma = new Map();
      for (const a of arribos) {
        const prog = programaDeAnuncio.get(a.adId) || null;
        const clave = anuncioConfigurado.get(a.adId) || a.adId;
        if (!anunciosConChats.has(clave)) {
          anunciosConChats.set(clave, {
            adId: clave,
            titular: '',
            programaId: prog,
            programa: prog ? nombrePrograma.get(prog) || '' : '',
            chats: new Set(),
            conCita: new Set(),
          });
        }
        const ac = anunciosConChats.get(clave);
        ac.chats.add(cid);
        if (conCita.has(cid)) ac.conCita.add(cid);
        if (!ac.titular && a.titular) ac.titular = a.titular;
        if (!prog) continue;
        if (!chatsPorAnuncio.has(clave)) chatsPorAnuncio.set(clave, new Set());
        chatsPorAnuncio.get(clave).add(cid);
        if (!chatsPorPrograma.has(prog)) chatsPorPrograma.set(prog, new Set());
        chatsPorPrograma.get(prog).add(cid);
        const previa = primeraPorPrograma.get(prog);
        if (!previa || a.fecha < previa) primeraPorPrograma.set(prog, a.fecha);
      }
      for (const [prog, fecha] of primeraPorPrograma) enSerie(seriePorPrograma.get(prog), fecha, 'chats');
    }
    const titularDe = new Map([...anunciosConChats.values()].map((a) => [a.adId, a.titular]));

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
    const sumar = (r, { grupo, valor, isCanje, isCortesia, generaIngresos, sinValor }) => {
      r.citas += 1;
      r[grupo] += 1;
      if (isCanje) r.canjes += 1;
      else if (isCortesia) r.cortesias += 1;
      else if (!generaIngresos) r.sinIngreso += 1;
      else if (sinValor) r.sinValor += 1;
      // Lo que se espera cobrar de lo que sigue en pie; ingreso = solo lo atendido.
      const cuenta = !isCanje && !isCortesia && generaIngresos;
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
        isCortesia: !!c.isCortesia,
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

      // Gráficos: la cita cae en el día por el que se está contando.
      const fechaSerie = por === 'cita' ? c.date : c.createdAt;
      for (const mapa of [serie, seriePorPrograma.get(programaId)]) {
        enSerie(mapa, fechaSerie, 'citas');
        if (grupo === 'efectivas') enSerie(mapa, fechaSerie, 'efectivas');
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
        cortesia: !!c.isCortesia,
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
          titular: pa.titular || titularDe.get(a.adId) || '',
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
        // Cuánto del ingreso se fue en publicidad: gasto × 100 / ingresos (fracción).
        pesoPublicidad: r.ingresos ? gasto / r.ingresos : null,
        citasDetalle: detalle.get(String(p._id)).sort((a, b) => new Date(b.creada) - new Date(a.creada)),
        serie: [...seriePorPrograma.get(pid)].map(([fecha, v]) => ({ fecha, ...v })),
      };
    });

    const anunciosChats = [...anunciosConChats.values()]
      .map((a) => ({ ...a, chats: a.chats.size, conCita: a.conCita.size }))
      .sort((a, b) => b.chats - a.chats || b.conCita - a.conCita);

    res.json({
      desde: req.query.from,
      hasta: req.query.to,
      por,
      diasDelGasto,
      programas: filas,
      sinPrograma,
      // Los que más citas trajeron primero: son los que vale la pena asignar.
      anunciosSinPrograma: [...sueltos.values()].sort((a, b) => b.citas - a.citas),
      // Gráficos (oct-2026): chats de anuncios y citas de los programas por día (o mes).
      serie: [...serie].map(([fecha, v]) => ({ fecha, ...v })),
      seriePorMes: porMes,
      // Todos los chats que llegaron por un anuncio, en total y anuncio por anuncio.
      chatsAnuncios: {
        total: llegadas.length,
        conCita: llegadas.filter((l) => conCita.has(String(l.conv._id))).length,
        anuncios: anunciosChats,
      },
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al calcular las analíticas', error: error.message });
  }
};

/**
 * LOS CHATS QUE LLEGARON POR LOS ANUNCIOS, uno por uno (oct-2026), para ir a
 * cada chat desde Analíticas. `adId` (opcional) = solo los de ese anuncio, tal
 * como sale en «Chats de anuncios» (el id configurado en el programa, que
 * reúne sus alias de Meta). Del más reciente al más antiguo.
 */
exports.adChats = async (req, res) => {
  try {
    const desde = diaLocal(req.query.from);
    const hasta = diaLocal(req.query.to, true);
    if (!desde || !hasta || desde > hasta) {
      return res.status(400).json({ message: 'Escoge un rango de fechas válido.' });
    }
    const filtroAnuncio = limpiarId(req.query.adId);
    const programas = await AdProgram.find(TODOS_LOS_PROGRAMAS).select('name anuncios.adId').lean();
    const { programaDeAnuncio, anuncioConfigurado } = await mapaDeAnuncios(programas);
    const nombrePrograma = new Map(programas.map((p) => [String(p._id), p.name]));

    const llegadas = await llegadasDeAnuncios(req.clinicId, desde, hasta, 'phone contactName patient');
    const filas = [];
    for (const { conv, arribos } of llegadas) {
      const suyos = arribos
        .map((a) => ({ ...a, clave: anuncioConfigurado.get(a.adId) || a.adId, programaId: programaDeAnuncio.get(a.adId) || null }))
        .filter((a) => !filtroAnuncio || a.clave === filtroAnuncio)
        .sort((a, b) => a.fecha - b.fecha);
      if (!suyos.length) continue;
      filas.push({
        _id: conv._id,
        contacto: conv.contactName || conv.phone || '',
        phone: conv.phone || '',
        patient: conv.patient || null,
        llegada: suyos[0].fecha,
        anuncios: suyos.map((a) => ({
          adId: a.clave,
          titular: a.titular,
          programa: a.programaId ? nombrePrograma.get(a.programaId) || '' : '',
        })),
      });
    }
    filas.sort((a, b) => b.llegada - a.llegada);
    const LIMITE = 1000;
    const visibles = filas.slice(0, LIMITE);

    // Las citas que salieron de cada chat (cualquier fecha): para ver quién agendó.
    const citas = visibles.length
      ? await Appointment.find({ conversation: { $in: visibles.map((f) => f._id) } })
        .select('conversation status date')
        .sort({ date: -1 })
        .lean()
      : [];
    const citasDe = new Map();
    for (const c of citas) {
      const k = String(c.conversation);
      if (!citasDe.has(k)) citasDe.set(k, []);
      citasDe.get(k).push(c);
    }
    res.json({
      total: filas.length,
      limite: LIMITE,
      chats: visibles.map((f) => {
        const suyas = citasDe.get(String(f._id)) || [];
        return {
          ...f,
          citas: suyas.length,
          ultimaCita: suyas[0] ? { fecha: suyas[0].date, estado: suyas[0].status } : null,
        };
      }),
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al listar los chats de anuncios', error: error.message });
  }
};

// Para los tests: el prorrateo del gasto por día.
exports._gastoDelRango = gastoDelRango;
