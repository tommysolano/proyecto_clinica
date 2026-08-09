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
  if (!conv || !target) return { changed: false, prevStage: null, opportunity: null };
  const list = ensureArray(conv);

  let opp;
  let prevStage = null;
  if (!list.length) {
    if (!create) return { changed: false, prevStage: null, opportunity: null };
    conv.opportunities = [
      ...list,
      { isOpportunity: true, stage: target, createdAt: new Date(), ...(name ? { name } : {}), ...(notes ? { notes } : {}) },
    ];
    opp = conv.opportunities[conv.opportunities.length - 1];
  } else {
    opp = list[list.length - 1];
    prevStage = String(opp.stage || '') || null;
    opp.isOpportunity = true;
    opp.stage = target;
    if (notes && !opp.notes) opp.notes = notes;
  }
  if (appointment) opp.appointment = appointment;
  if (target === 'ganado' && !opp.convertedAt) opp.convertedAt = new Date();
  conv.markModified?.('opportunities');
  syncPrimaryOpportunity(conv);
  return { changed: prevStage !== target, prevStage, opportunity: opp };
}

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
  applyStage,
  ensureArray,
  hasOpportunityFilter,
  hasStage,
  isValidStage,
  opportunitiesOf,
  primaryOpportunity,
  relevantOpportunity,
  stageCandidates,
  stageFilter,
  syncPrimaryOpportunity,
};
