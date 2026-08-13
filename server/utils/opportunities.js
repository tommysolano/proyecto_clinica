/**
 * ETAPAS DEL EMBUDO: una sola forma de leerlas y de escribirlas.
 *
 * EL PROBLEMA. Una conversación guarda sus oportunidades DOS veces: el array
 * `opportunities[]` (canónico, admite varias por chat) y `opportunity` (espejo de
 * la principal, que es la ÚLTIMA del array). Media docena de sitios escribían uno
 * u otro por su cuenta, y de ahí salían los tres síntomas que reportó el usuario:
 *
 *  1. «La condición "etapa = agendado" no se cumple nunca». La condición miraba
 *     solo la ÚLTIMA oportunidad del array; si el agente movía otra —o si quien
 *     movió la etapa escribió solo en el espejo legacy— la comparación daba falso
 *     y el flujo moría en el primer nodo de condición.
 *  2. «El conteo de agendados no cuadra». El embudo agrupaba por el espejo
 *     (`opportunity.stage`): como máximo UNA por chat, mientras que la página de
 *     Oportunidades contaba por el array. Dos cifras distintas del mismo dato.
 *  3. Agendar desde el chat ponía 'agendado' SOLO en el espejo, y la siguiente
 *     edición manual lo sobrescribía desde el array: la etapa (y el enlace a la
 *     cita) se perdían solos.
 *
 * LA REGLA DE AHORA. El array es la ÚNICA fuente; el espejo se deriva de él y
 * nunca se escribe a mano. Todo el que toque etapas pasa por aquí.
 */
const STAGES = ['nuevo', 'contactado', 'interesado', 'agendado', 'ganado', 'perdido'];

/** Nombre de la etapa tal y como se lee en el chat (el chip lo pinta así). */
const STAGE_LABELS = {
  nuevo: 'Nuevo',
  contactado: 'Contactado',
  interesado: 'Interesado',
  agendado: 'Agendado',
  ganado: 'Ganado',
  perdido: 'Perdido',
};
const stageLabel = (stage) => STAGE_LABELS[String(stage || '').trim()] || String(stage || '').trim() || '—';

const isValidStage = (stage) => STAGES.includes(String(stage || '').trim());

const plain = (opp) => (opp?.toObject ? opp.toObject() : { ...(opp || {}) });

/**
 * Las oportunidades de un chat, en orden. El array manda; el espejo legacy solo
 * cuenta cuando el chat es antiguo y nunca llegó a tener array (misma regla que
 * el listado global de Oportunidades: si se sumaran los dos, la principal
 * saldría DUPLICADA en el embudo).
 */
function opportunitiesOf(conv) {
  const list = Array.isArray(conv?.opportunities) ? conv.opportunities : [];
  if (list.length) return list;
  return conv?.opportunity?.isOpportunity ? [conv.opportunity] : [];
}

/** La "principal": la más reciente (última del array). */
function primaryOpportunity(conv) {
  const list = opportunitiesOf(conv);
  return list.length ? list[list.length - 1] : null;
}

/**
 * La oportunidad DE LA QUE VA EL FLUJO. Cuando la inscripción nació de un cambio
 * de etapa (`context.stage`), la relevante es la que está en ESA etapa, no la
 * última del array: en un chat con varias, las condiciones sobre etiquetas/valor/
 * nombre miraban una oportunidad que no tenía nada que ver con el evento.
 */
function relevantOpportunity(conv, context = null) {
  const list = opportunitiesOf(conv);
  if (!list.length) return null;
  const wanted = String(context?.stage || '').trim();
  if (wanted) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (String(list[i]?.stage || '') === wanted) return list[i];
    }
  }
  return list[list.length - 1];
}

/**
 * TODAS las etapas presentes en el chat (más la del evento que inscribió el
 * flujo, si lo hubo). Es lo que compara la condición "etapa = X": preguntar por
 * una etapa es preguntar si el chat TIENE una oportunidad ahí, no si la tiene
 * justo la última.
 */
function stageCandidates(conv, context = null) {
  const stages = opportunitiesOf(conv)
    .map((o) => String(o?.stage || '').trim())
    .filter(Boolean);
  const fromEvent = String(context?.stage || '').trim();
  if (fromEvent) stages.push(fromEvent);
  return [...new Set(stages)];
}

/** ¿El chat tiene alguna oportunidad en esta etapa? */
function hasStage(conv, stage) {
  return stageCandidates(conv).includes(String(stage || '').trim());
}

/**
 * Recalcula el espejo legacy `conv.opportunity` desde el array. El panel lateral,
 * la fila de la bandeja y los filtros lo leen; sin esta sincronización las
 * ediciones del array "no se guardaban" en la UI.
 */
function syncPrimaryOpportunity(conv) {
  const list = Array.isArray(conv.opportunities) ? conv.opportunities : [];
  conv.opportunity = list.length
    ? plain(list[list.length - 1])
    : { isOpportunity: false, stage: 'nuevo' };
  conv.markModified?.('opportunity');
}

/**
 * Sube al array un chat antiguo que solo tenía el espejo legacy. Sin esto,
 * cualquier escritura posterior en el array haría que `syncPrimaryOpportunity`
 * pisara —y perdiera— la oportunidad que solo vivía en el espejo.
 */
function ensureArray(conv) {
  const list = Array.isArray(conv.opportunities) ? conv.opportunities : [];
  if (list.length) return list;
  if (conv.opportunity?.isOpportunity) {
    conv.opportunities = [plain(conv.opportunity)];
    conv.markModified?.('opportunities');
    return conv.opportunities;
  }
  conv.opportunities = [];
  return conv.opportunities;
}

/**
 * Mueve UNA oportunidad de etapa. Es el único sitio que escribe `stage`, y por
 * eso también el único que puede sellar CUÁNDO se movió.
 *
 * `stageChangedAt` existe porque la analítica preguntaba «¿cuántas se agendaron
 * el martes?» y no había con qué responder: la oportunidad solo guardaba su fecha
 * de creación, así que un chat de enero que se agendó en agosto salía contado en
 * enero. Se sella SOLO cuando la etapa cambia de verdad (guardar el modal sin
 * tocar la etapa no puede mover la oportunidad de día).
 *
 * Devuelve true si la etapa cambió.
 */
function setStage(opp, stage, { when = null } = {}) {
  const target = String(stage || '').trim();
  if (!opp || !target) return false;
  const prev = String(opp.stage || '');
  opp.isOpportunity = true;
  opp.stage = target;
  if (target === 'ganado' && !opp.convertedAt) opp.convertedAt = when || new Date();
  if (prev === target && opp.stageChangedAt) return false;
  opp.stageChangedAt = when || new Date();
  return prev !== target;
}

/**
 * ESCRITOR ÚNICO de la etapa de un chat. Mueve la oportunidad relevante (o la
 * crea si el chat no tenía ninguna) y deja el espejo al día. NO guarda el
 * documento ni emite eventos: de eso se encarga quien llama, que es quien sabe
 * si además hay que disparar workflows.
 *
 * Devuelve { changed, prevStage, opportunity } — `changed` es false cuando la
 * oportunidad ya estaba en esa etapa (así nadie reinscribe flujos de más).
 */
function applyStage(conv, stage, { appointment = null, notes = '', name = '', create = true } = {}) {
  const target = String(stage || '').trim();
  if (!conv || !target) return { changed: false, created: false, prevStage: null, opportunity: null };
  const list = ensureArray(conv);

  let opp;
  let created = false;
  let prevStage = null;
  if (!list.length) {
    if (!create) return { changed: false, created: false, prevStage: null, opportunity: null };
    created = true;
    const now = new Date();
    conv.opportunities = [
      ...list,
      {
        isOpportunity: true,
        stage: target,
        createdAt: now,
        stageChangedAt: now,
        ...(name ? { name } : {}),
        ...(notes ? { notes } : {}),
      },
    ];
    opp = conv.opportunities[conv.opportunities.length - 1];
    if (target === 'ganado') opp.convertedAt = now;
  } else {
    opp = list[list.length - 1];
    prevStage = String(opp.stage || '') || null;
    setStage(opp, target);
    if (notes && !opp.notes) opp.notes = notes;
  }
  if (appointment) opp.appointment = appointment;
  conv.markModified?.('opportunities');
  syncPrimaryOpportunity(conv);
  // `created` va aparte de `prevStage`: una oportunidad existente SIN etapa también
  // devuelve prevStage null, así que de ahí no se puede deducir si es alta o
  // movimiento — y el aviso del chat dice cosas distintas en cada caso.
  return { changed: prevStage !== target, created, prevStage, opportunity: opp };
}

/**
 * ══ AVISO EN EL CHAT ══
 *
 * Cada vez que una oportunidad NACE o CAMBIA DE ETAPA se deja un chip dentro del
 * hilo (kind:'event'), visible solo para el equipo y que NUNCA sale hacia el
 * contacto. Vive aquí, en el escritor único, porque hasta ago-2026 el aviso lo
 * creaba a mano el controlador del chat y solo existía en UN camino (crear la
 * oportunidad desde el panel lateral): mover la etapa desde el modal, agendar una
 * cita, o que la moviera una automatización pasaba en silencio, y el agente que
 * abría el chat no tenía forma de saber que el embudo se había movido ni quién lo
 * movió.
 *
 * Reglas:
 *  - Se llama SIEMPRE DESPUÉS de `conv.save()`. Si el guardado falla, no puede
 *    quedar un chip mintiendo en el hilo.
 *  - NO toca `lastMessageAt`/`lastMessagePreview`: el chip no reordena la bandeja
 *    ni pisa la vista previa del último mensaje real.
 *  - Nunca lanza: un fallo escribiendo el aviso no puede tumbar el guardado ni la
 *    ejecución de una automatización.
 */
const OPPORTUNITY_EVENTS = { created: 'opportunity_created', stage: 'opportunity_stage_changed' };

/** Texto del chip de alta ("Oportunidad creada: Botox · $120.00 · etapa nuevo"). */
function opportunityEventBody(opp = {}) {
  const productos = (opp.interestedIn || []).map((i) => i.name).filter(Boolean).join(', ');
  const titulo = opp.name || productos;
  const partes = [`Oportunidad creada${titulo ? `: ${titulo}` : ''}`];
  if (opp.expectedValue) partes.push(`$${Number(opp.expectedValue).toFixed(2)}`);
  partes.push(`etapa ${opp.stage}`);
  return partes.join(' · ');
}

/** Texto del chip de cambio de etapa ("Oportunidad «Botox»: Interesado → Agendado"). */
function stageChangeBody(opp = {}, prevStage, stage) {
  const titulo = opp.name || (opp.interestedIn || []).map((i) => i.name).filter(Boolean).join(', ');
  const quien = titulo ? `Oportunidad «${titulo}»` : 'La oportunidad';
  return prevStage
    ? `${quien}: ${stageLabel(prevStage)} → ${stageLabel(stage)}`
    : `${quien} pasó a ${stageLabel(stage)}`;
}

/**
 * Escribe el chip en el hilo y lo emite en vivo. `actor` dice QUIÉN lo hizo:
 *   - persona → { userId, name }
 *   - sistema → { automatic: true, name: 'Automatización "Bienvenida"' }
 * Los `require` van dentro a propósito: este módulo lo usan tests unitarios con
 * conversaciones de mentira (objetos planos), y cargar el modelo y el tiempo real
 * en la cabecera crearía además un ciclo con chatController/workflowEngine.
 */
async function announceOpportunity(conv, { type = 'stage', prevStage = null, opportunity = null, actor = null } = {}) {
  try {
    if (!conv?._id || !conv?.clinic) return null; // conversación de mentira (tests puros)
    const eventType = OPPORTUNITY_EVENTS[type];
    if (!eventType) return null;
    const opp = opportunity || primaryOpportunity(conv) || {};
    const body = type === 'created'
      ? opportunityEventBody(opp)
      : stageChangeBody(opp, prevStage, opp.stage);
    const Message = require('../models/Message');
    const msg = await Message.create({
      clinic: conv.clinic, // la del CHAT: en los flujos, `clinicId` es la clínica ancla del call center
      conversation: conv._id,
      kind: 'event',
      eventType,
      body,
      sentBy: actor?.userId || null,
      sentByName: actor?.name || '',
      isAutoReply: !!actor?.automatic,
    });
    try {
      require('../realtime').emitToCallCenter('chat:message', {
        conversationId: conv._id,
        message: require('./chatMedia').sanitizeMessageForSocket(msg),
      });
    } catch {
      /* tiempo real opcional */
    }
    return msg;
  } catch (err) {
    console.error('[opportunities] no se pudo dejar el aviso en el chat:', err.message);
    return null;
  }
}

/**
 * Azúcar para los que ya llaman a `applyStage`: anuncia SOLO si la etapa cambió
 * de verdad. Es lo que evita el aviso doble cuando la misma acción pasa por varias
 * capas (agendar desde el chat mueve la etapa y además emite el evento de cita,
 * que vuelve a intentar moverla).
 */
async function announceStageResult(conv, result, actor = null) {
  if (!result?.changed) return null;
  return announceOpportunity(conv, {
    type: result.created ? 'created' : 'stage',
    prevStage: result.prevStage,
    opportunity: result.opportunity,
    actor,
  });
}

/** Actor "automático" con el nombre del flujo/regla que provocó el cambio. */
const systemActor = (origen) => ({ automatic: true, name: origen ? `Automático · ${origen}` : 'Automático' });

/**
 * Aplanado de las oportunidades de un chat para agregaciones de MongoDB: el
 * array si lo hay, y si no el espejo legacy. Es la misma regla de
 * `opportunitiesOf`, escrita como expresión de agregación para que el embudo y
 * el listado global cuenten EXACTAMENTE lo mismo.
 */
const AGG_FLATTEN = {
  $cond: [
    { $gt: [{ $size: { $ifNull: ['$opportunities', []] } }, 0] },
    '$opportunities',
    { $cond: [{ $eq: ['$opportunity.isOpportunity', true] }, ['$opportunity'], []] },
  ],
};

/**
 * Filtro de bandeja "chats en la etapa X". Mira el array Y el espejo: un chat con
 * varias oportunidades aparece en TODAS las etapas en las que tenga alguna.
 */
function stageFilter(stage) {
  return { $or: [{ 'opportunities.stage': stage }, { 'opportunity.stage': stage, 'opportunity.isOpportunity': true }] };
}

/** Filtro de bandeja "chats con oportunidad". */
function hasOpportunityFilter() {
  return { $or: [{ 'opportunities.0': { $exists: true } }, { 'opportunity.isOpportunity': true }] };
}

module.exports = {
  AGG_FLATTEN,
  STAGES,
  STAGE_LABELS,
  stageLabel,
  announceOpportunity,
  announceStageResult,
  opportunityEventBody,
  stageChangeBody,
  systemActor,
  applyStage,
  ensureArray,
  hasOpportunityFilter,
  hasStage,
  isValidStage,
  opportunitiesOf,
  primaryOpportunity,
  relevantOpportunity,
  setStage,
  stageCandidates,
  stageFilter,
  syncPrimaryOpportunity,
};
