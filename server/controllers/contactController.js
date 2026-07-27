/**
 * Contactos del CRM y sus grupos.
 *
 * Un contacto NO es un paciente (ver models/Contact.js): es la identidad de
 * mensajería. Aquí se listan, se editan, se etiquetan y se agrupan; el envío
 * vive en el goteo (utils/dripRunner.js).
 */
const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const ContactGroup = require('../models/ContactGroup');
const { normalizePhone } = require('../utils/phoneNormalize');
const { buildContactMatch, buildGroupMatch } = require('../utils/contactAudience');

const PAGE_SIZE = 50;

// Los filtros llegan por querystring: arrays como "a,b" y flags como texto.
function filtersFromQuery(q = {}) {
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    q: q.q || '',
    tags: list(q.tags),
    anyTags: list(q.anyTags),
    sources: list(q.sources),
    groups: list(q.groups).filter((g) => mongoose.isValidObjectId(g)),
    whatsappOptIn: ['yes', 'no'].includes(q.optIn) ? q.optIn : '',
    isPatient: ['yes', 'no'].includes(q.isPatient) ? q.isPatient : '',
    importBatch: mongoose.isValidObjectId(q.importBatch) ? q.importBatch : null,
  };
}

exports.list = async (req, res) => {
  try {
    const match = buildContactMatch(req.clinicId, filtersFromQuery(req.query));
    const page = Math.max(1, Number(req.query.page) || 1);
    const [items, total] = await Promise.all([
      Contact.find(match)
        .populate('groups', 'name kind')
        .populate('patient', 'firstName lastName cedula')
        .sort({ createdAt: -1 })
        .skip((page - 1) * PAGE_SIZE)
        .limit(PAGE_SIZE)
        .lean({ virtuals: true }),
      Contact.countDocuments(match),
    ]);
    res.json({ items, total, page, pageSize: PAGE_SIZE, pages: Math.ceil(total / PAGE_SIZE) });
  } catch (err) {
    res.status(500).json({ message: 'Error al listar contactos', error: err.message });
  }
};

exports.get = async (req, res) => {
  try {
    const c = await Contact.findOne({ _id: req.params.id, clinic: req.clinicId })
      .populate('groups', 'name kind')
      .populate('patient', 'firstName lastName cedula phone');
    if (!c) return res.status(404).json({ message: 'Contacto no encontrado' });
    res.json(c);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.create = async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone.ok) return res.status(400).json({ message: `Teléfono inválido: ${phone.reason}` });
    const exists = await Contact.findOne({ clinic: req.clinicId, phone: phone.phone });
    if (exists) {
      return res.status(409).json({ message: 'Ya existe un contacto con ese teléfono.', contact: exists });
    }
    const c = await Contact.create({
      clinic: req.clinicId,
      phone: phone.phone,
      firstName: String(req.body.firstName || '').trim(),
      lastName: String(req.body.lastName || '').trim(),
      displayName: String(req.body.displayName || '').trim(),
      email: String(req.body.email || '').trim(),
      tags: Array.isArray(req.body.tags) ? req.body.tags.filter(Boolean) : [],
      groups: Array.isArray(req.body.groups) ? req.body.groups.filter((g) => mongoose.isValidObjectId(g)) : [],
      notes: String(req.body.notes || '').trim(),
      source: 'manual',
      createdBy: req.user._id,
    });
    res.status(201).json(c);
  } catch (err) {
    res.status(500).json({ message: 'Error al crear el contacto', error: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    const c = await Contact.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!c) return res.status(404).json({ message: 'Contacto no encontrado' });
    if (req.body.phone !== undefined) {
      const phone = normalizePhone(req.body.phone);
      if (!phone.ok) return res.status(400).json({ message: `Teléfono inválido: ${phone.reason}` });
      // El teléfono es la identidad: cambiarlo al de otro contacto los fusionaría.
      const clash = await Contact.findOne({ clinic: req.clinicId, phone: phone.phone, _id: { $ne: c._id } });
      if (clash) return res.status(409).json({ message: 'Otro contacto ya usa ese teléfono.' });
      c.phone = phone.phone;
    }
    for (const k of ['firstName', 'lastName', 'displayName', 'email', 'notes']) {
      if (req.body[k] !== undefined) c[k] = String(req.body[k] || '').trim();
    }
    if (Array.isArray(req.body.tags)) c.tags = req.body.tags.filter(Boolean);
    if (Array.isArray(req.body.groups)) {
      c.groups = req.body.groups.filter((g) => mongoose.isValidObjectId(g));
    }
    await c.save();
    res.json(c);
  } catch (err) {
    res.status(500).json({ message: 'Error al actualizar', error: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const c = await Contact.findOneAndDelete({ _id: req.params.id, clinic: req.clinicId });
    if (!c) return res.status(404).json({ message: 'Contacto no encontrado' });
    res.json({ message: 'Contacto eliminado' });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/** Baja de marketing. Es lo que hay que respetar SIEMPRE antes de enviar. */
exports.setOptOut = async (req, res) => {
  try {
    const optOut = req.body.optOut !== false;
    const c = await Contact.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      {
        $set: {
          'marketing.whatsappOptIn': !optOut,
          'marketing.optOutAt': optOut ? new Date() : null,
          'marketing.optOutReason': optOut ? String(req.body.reason || '').trim() : '',
        },
      },
      { new: true }
    );
    if (!c) return res.status(404).json({ message: 'Contacto no encontrado' });
    res.json(c);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/**
 * Acciones en lote sobre TODO lo que casa con el filtro (no solo la página
 * visible): etiquetar, quitar etiqueta, meter/sacar de un grupo o dar de baja.
 * Es lo que hace usable una lista de 47k.
 */
exports.bulk = async (req, res) => {
  try {
    const { action, tags = [], group } = req.body;
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((i) => mongoose.isValidObjectId(i)) : [];
    // O bien una selección explícita, o bien "todo lo que casa con el filtro".
    const match = ids.length
      ? { clinic: req.clinicId, _id: { $in: ids } }
      : buildContactMatch(req.clinicId, filtersFromQuery(req.body.filters || {}));

    let update = null;
    if (action === 'tag') update = { $addToSet: { tags: { $each: tags.filter(Boolean) } } };
    else if (action === 'untag') update = { $pull: { tags: { $in: tags.filter(Boolean) } } };
    else if (action === 'addGroup' && mongoose.isValidObjectId(group)) update = { $addToSet: { groups: group } };
    else if (action === 'removeGroup' && mongoose.isValidObjectId(group)) update = { $pull: { groups: group } };
    else if (action === 'optOut') {
      update = { $set: { 'marketing.whatsappOptIn': false, 'marketing.optOutAt': new Date() } };
    } else if (action === 'delete') {
      const r = await Contact.deleteMany(match);
      return res.json({ deleted: r.deletedCount || 0 });
    } else {
      return res.status(400).json({ message: 'Acción no reconocida' });
    }
    const r = await Contact.updateMany(match, update);
    res.json({ modified: r.modifiedCount || 0 });
  } catch (err) {
    res.status(500).json({ message: 'Error en la acción masiva', error: err.message });
  }
};

/**
 * Números de WhatsApp conectados, solo lo que necesita el selector "¿desde qué
 * número se envía?" (etiqueta y método). Existe aparte del listado de
 * Configuración porque aquel es de admin/marketing, devuelve credenciales y
 * además reconcilia las sesiones QR: para pintar un desplegable sobra.
 */
exports.whatsappAccounts = async (req, res) => {
  try {
    const gateway = require('../utils/whatsappGateway');
    const list = await gateway.listEnabledAccounts();
    res.json(
      list.map((a) => ({
        _id: a._id,
        label: a.label,
        connectionType: a.connectionType,
        isDefault: !!a.isDefault,
      }))
    );
  } catch (err) {
    res.status(500).json({ message: 'Error al listar los números', error: err.message });
  }
};

/** Todas las etiquetas en uso (para los desplegables y filtros). */
exports.tags = async (req, res) => {
  try {
    const list = await Contact.distinct('tags', { clinic: req.clinicId });
    res.json(list.filter(Boolean).sort());
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

// ─────────────────────────────── Grupos ───────────────────────────────

exports.listGroups = async (req, res) => {
  try {
    const groups = await ContactGroup.find({ clinic: req.clinicId }).sort({ name: 1 }).lean();
    // El contador de un grupo por filtro tiene que ser en vivo: si no, miente en
    // cuanto entra un contacto nuevo que cumple las condiciones.
    const out = await Promise.all(
      groups.map(async (g) => ({
        ...g,
        count: await Contact.countDocuments(buildGroupMatch(req.clinicId, g)),
      }))
    );
    res.json(out);
  } catch (err) {
    res.status(500).json({ message: 'Error al listar grupos', error: err.message });
  }
};

exports.createGroup = async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'El grupo necesita un nombre' });
    const kind = req.body.kind === 'dynamic' ? 'dynamic' : 'static';
    const g = await ContactGroup.create({
      clinic: req.clinicId,
      name,
      description: String(req.body.description || '').trim(),
      kind,
      filters: kind === 'dynamic' ? req.body.filters || {} : {},
      createdBy: req.user._id,
    });
    res.status(201).json(g);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Ya existe un grupo con ese nombre.' });
    res.status(500).json({ message: 'Error al crear el grupo', error: err.message });
  }
};

exports.updateGroup = async (req, res) => {
  try {
    const g = await ContactGroup.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!g) return res.status(404).json({ message: 'Grupo no encontrado' });
    if (req.body.name !== undefined) g.name = String(req.body.name).trim();
    if (req.body.description !== undefined) g.description = String(req.body.description).trim();
    // El tipo no se cambia: un grupo fijo tiene miembros guardados y uno dinámico
    // no; convertirlo dejaría el grupo vacío o con miembros que ya no cuadran.
    if (g.kind === 'dynamic' && req.body.filters) g.filters = req.body.filters;
    await g.save();
    res.json(g);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Ya existe un grupo con ese nombre.' });
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.deleteGroup = async (req, res) => {
  try {
    const g = await ContactGroup.findOneAndDelete({ _id: req.params.id, clinic: req.clinicId });
    if (!g) return res.status(404).json({ message: 'Grupo no encontrado' });
    // Borrar el grupo no borra contactos: solo se les quita la pertenencia.
    if (g.kind === 'static') {
      await Contact.updateMany({ clinic: req.clinicId, groups: g._id }, { $pull: { groups: g._id } });
    }
    res.json({ message: 'Grupo eliminado' });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/** Vista previa: a cuántos alcanza el grupo y a cuántos se les puede escribir. */
exports.previewGroup = async (req, res) => {
  try {
    const g = await ContactGroup.findOne({ _id: req.params.id, clinic: req.clinicId }).lean();
    if (!g) return res.status(404).json({ message: 'Grupo no encontrado' });
    const { buildSendableMatch } = require('../utils/contactAudience');
    const [total, sendable, sample] = await Promise.all([
      Contact.countDocuments(buildGroupMatch(req.clinicId, g)),
      Contact.countDocuments(buildSendableMatch(req.clinicId, g)),
      Contact.find(buildGroupMatch(req.clinicId, g)).select('phone displayName firstName lastName').limit(5).lean({ virtuals: true }),
    ]);
    res.json({ total, sendable, excluded: total - sendable, sample });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};
