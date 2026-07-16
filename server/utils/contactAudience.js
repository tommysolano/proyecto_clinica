/**
 * Resuelve A QUIÉN se le manda: traduce un grupo (fijo o por filtro) a una
 * consulta de Mongo sobre Contact.
 *
 * Vive aparte del controller porque lo usan tres sitios: la página de Contactos
 * (para listar y contar), los grupos dinámicos (para recalcularse) y el envío
 * por goteo (para saber la audiencia real en el momento de enviar, no cuando se
 * creó la campaña).
 *
 * `buildContactMatch` es PURO (no toca la BD) para poder probarlo.
 */
const mongoose = require('mongoose');

/**
 * Filtros → match de Mongo. Todos los criterios se combinan con Y.
 *
 * Ojo con `whatsappOptIn: 'yes'`: no basta con que el opt-in esté en true, hay
 * que exigir además que NO se haya dado de baja. Un contacto que pidió no
 * recibir mensajes tiene `optOutAt` con fecha, y mandarle una campaña es
 * justo lo que hunde la calidad del número (y en Ecuador, un problema legal).
 */
function buildContactMatch(clinicId, filters = {}) {
  const match = { clinic: new mongoose.Types.ObjectId(String(clinicId)), active: true };

  const tagCond = {};
  if (Array.isArray(filters.tags) && filters.tags.length) tagCond.$all = filters.tags;
  if (Array.isArray(filters.anyTags) && filters.anyTags.length) tagCond.$in = filters.anyTags;
  if (Object.keys(tagCond).length) match.tags = tagCond;

  if (Array.isArray(filters.sources) && filters.sources.length) {
    match.source = { $in: filters.sources };
  }
  if (Array.isArray(filters.groups) && filters.groups.length) {
    match.groups = { $in: filters.groups.map((g) => new mongoose.Types.ObjectId(String(g))) };
  }
  if (filters.importBatch) {
    match.importBatch = new mongoose.Types.ObjectId(String(filters.importBatch));
  }

  if (filters.whatsappOptIn === 'yes') {
    match['marketing.whatsappOptIn'] = true;
    match['marketing.optOutAt'] = null;
  } else if (filters.whatsappOptIn === 'no') {
    // Sin consentimiento: o nunca lo dio, o se dio de baja.
    match.$or = [{ 'marketing.whatsappOptIn': false }, { 'marketing.optOutAt': { $ne: null } }];
  }

  if (filters.isPatient === 'yes') match.patient = { $ne: null };
  else if (filters.isPatient === 'no') match.patient = null;

  if (filters.createdFrom || filters.createdTo) {
    match.createdAt = {
      ...(filters.createdFrom ? { $gte: new Date(filters.createdFrom) } : {}),
      ...(filters.createdTo ? { $lte: new Date(filters.createdTo) } : {}),
    };
  }

  // Búsqueda libre por nombre o teléfono (la usa el buscador de la lista).
  if (filters.q) {
    const rx = new RegExp(String(filters.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const or = [{ displayName: rx }, { firstName: rx }, { lastName: rx }, { phone: rx }, { email: rx }];
    // Si ya había un $or (de whatsappOptIn), se combinan con $and para no pisarlo.
    if (match.$or) {
      match.$and = [{ $or: match.$or }, { $or: or }];
      delete match.$or;
    } else {
      match.$or = or;
    }
  }

  return match;
}

/**
 * Match de un grupo. Un grupo FIJO se resuelve por pertenencia (`Contact.groups`);
 * uno DINÁMICO, por sus filtros — por eso se recalcula solo.
 */
function buildGroupMatch(clinicId, group) {
  if (!group) return null;
  if (group.kind === 'dynamic') return buildContactMatch(clinicId, group.filters || {});
  return buildContactMatch(clinicId, { groups: [group._id] });
}

/**
 * Audiencia de un envío: el grupo, más la exigencia de que se les PUEDA escribir
 * (con opt-in, sin baja y con teléfono). Se aplica siempre, mande quien mande el
 * grupo: es la última red antes de gastar mensajes en quien no debe recibirlos.
 */
function buildSendableMatch(clinicId, group) {
  const base = group ? buildGroupMatch(clinicId, group) : buildContactMatch(clinicId, {});
  return {
    $and: [
      base,
      { 'marketing.whatsappOptIn': true, 'marketing.optOutAt': null, phone: { $nin: ['', null] } },
    ],
  };
}

module.exports = { buildContactMatch, buildGroupMatch, buildSendableMatch };
