/**
 * Campañas de envío masivo por goteo a contactos.
 *
 * La validación importante está al ARRANCAR (no al crear): se comprueba que el
 * contenido sea enviable por el número elegido, porque las reglas cambian según
 * el método de conexión:
 *   - Cloud API → hace falta una plantilla APROBADA por Meta (los contactos
 *     importados no tienen ventana de 24 h abierta, así que texto libre no sale).
 *   - QR        → no existen las plantillas de Meta: se manda texto libre.
 */
const mongoose = require('mongoose');
const DripCampaign = require('../models/DripCampaign');
const ContactGroup = require('../models/ContactGroup');
const Contact = require('../models/Contact');
const MessageTemplate = require('../models/MessageTemplate');
const gateway = require('../utils/whatsappGateway');
const { buildSendableMatch } = require('../utils/contactAudience');
const { runCampaign } = require('../utils/dripRunner');

// Niveles de Meta: conversaciones que puede INICIAR el negocio cada 24 h.
const TIER_LIMITS = { TIER_50: 50, TIER_250: 250, TIER_1K: 1000, TIER_10K: 10000, TIER_100K: 100000 };

exports.list = async (req, res) => {
  try {
    const list = await DripCampaign.find({ clinic: req.clinicId })
      .populate('group', 'name kind')
      .select('-sentContacts') // con 47k ids no hace falta arrastrarlos al listado
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(list);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.get = async (req, res) => {
  try {
    const c = await DripCampaign.findOne({ _id: req.params.id, clinic: req.clinicId })
      .populate('group', 'name kind')
      .select('-sentContacts');
    if (!c) return res.status(404).json({ message: 'Campaña no encontrada' });
    res.json(c);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.create = async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'La campaña necesita un nombre' });

    let group = null;
    if (req.body.group) {
      group = await ContactGroup.findOne({ _id: req.body.group, clinic: req.clinicId });
      if (!group) return res.status(404).json({ message: 'Grupo no encontrado' });
    }
    let template = null;
    if (req.body.template) {
      template = await MessageTemplate.findOne({ _id: req.body.template, clinic: req.clinicId });
      if (!template) return res.status(404).json({ message: 'Plantilla no encontrada' });
    }
    if (!template && !String(req.body.body || '').trim()) {
      return res.status(400).json({ message: 'Elige una plantilla o escribe el mensaje.' });
    }

    const camp = await DripCampaign.create({
      clinic: req.clinicId,
      name,
      group: group?._id || null,
      template: template?._id || null,
      templateName: template?.name || '',
      templateLanguage: template?.language || 'es',
      body: String(req.body.body || '').trim(),
      mediaUrl: String(req.body.mediaUrl || '').trim(),
      mediaType: String(req.body.mediaType || '').trim(),
      whatsappAccount: mongoose.isValidObjectId(req.body.whatsappAccount) ? req.body.whatsappAccount : null,
      batchSize: Math.min(500, Math.max(1, Number(req.body.batchSize) || 20)),
      intervalMinutes: Math.max(1, Number(req.body.intervalMinutes) || 15),
      hourFrom: req.body.hourFrom || '09:00',
      hourTo: req.body.hourTo || '20:00',
      days: Array.isArray(req.body.days) ? req.body.days.map(Number).filter((d) => d >= 0 && d <= 6) : [],
      status: 'draft',
      createdBy: req.user._id,
      createdByName: req.user.name,
    });
    res.status(201).json(camp);
  } catch (err) {
    res.status(500).json({ message: 'Error al crear la campaña', error: err.message });
  }
};

/**
 * Vista previa antes de lanzar: a cuántos alcanza, cuántos quedan fuera y —lo
 * importante— cuánto va a TARDAR de verdad con este goteo, y si el número
 * aguanta ese volumen. Es la pantalla que evita la sorpresa de "llevo 3 días
 * enviando y voy por el 5%".
 */
exports.preview = async (req, res) => {
  try {
    const camp = await DripCampaign.findOne({ _id: req.params.id, clinic: req.clinicId }).populate('group');
    if (!camp) return res.status(404).json({ message: 'Campaña no encontrada' });

    const [audience, alreadySent] = await Promise.all([
      Contact.countDocuments(buildSendableMatch(req.clinicId, camp.group)),
      Promise.resolve((camp.sentContacts || []).length),
    ]);
    const remaining = Math.max(0, audience - alreadySent);

    // Cuánto tarda: tandas × intervalo, contando solo las horas permitidas al día.
    const perDay = (() => {
      const [fh, fm] = String(camp.hourFrom || '00:00').split(':').map(Number);
      const [th, tm] = String(camp.hourTo || '23:59').split(':').map(Number);
      const minutes = Math.max(0, (th * 60 + tm) - (fh * 60 + fm));
      const batches = Math.floor(minutes / camp.intervalMinutes) + 1;
      return batches * camp.batchSize;
    })();
    const days = perDay > 0 ? Math.ceil(remaining / perDay) : null;

    // ¿El número aguanta? Solo aplica a Cloud API: el QR no tiene nivel de Meta.
    const account = camp.whatsappAccount
      ? await gateway.getAccountById(camp.whatsappAccount)
      : await gateway.getDefaultAccount();
    const isCloud = gateway.isCloud(account);
    const tierLimit = isCloud ? TIER_LIMITS[account?.messagingLimit] || null : null;

    const warnings = [];
    if (isCloud && tierLimit && perDay > tierLimit) {
      warnings.push(
        `Este goteo intentaría ${perDay} mensajes al día, pero Meta permite ${tierLimit} conversaciones nuevas cada 24 h en este número (${account.messagingLimit}). Los que pasen del límite fallarán: baja la tanda o sube el intervalo.`
      );
    }
    if (isCloud && !camp.templateName) {
      warnings.push(
        'Por Cloud API un contacto sin conversación abierta solo puede recibir una PLANTILLA aprobada por Meta. Sin plantilla, los envíos se omitirán por "ventana de 24h cerrada".'
      );
    }
    if (!isCloud && camp.templateName) {
      warnings.push('El número QR no admite plantillas de Meta: se enviará el texto libre de la campaña.');
    }
    if (!isCloud && perDay > 200) {
      warnings.push(
        `Vas a mandar ~${perDay} mensajes al día desde un número QR (WhatsApp Web). Un volumen así es el motivo más común de bloqueo de la sesión: considera bajar la tanda o espaciar el intervalo.`
      );
    }
    if (!account) warnings.push('No hay ningún número de WhatsApp configurado.');

    res.json({
      audience,
      alreadySent,
      remaining,
      perDay,
      estimatedDays: days,
      account: account ? { label: account.label, connectionType: account.connectionType, messagingLimit: account.messagingLimit } : null,
      warnings,
    });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/** Arranca (o reanuda) el goteo. Aquí se valida que el contenido sea enviable. */
exports.start = async (req, res) => {
  try {
    const camp = await DripCampaign.findOne({ _id: req.params.id, clinic: req.clinicId }).populate('group');
    if (!camp) return res.status(404).json({ message: 'Campaña no encontrada' });
    if (camp.status === 'running') return res.status(409).json({ message: 'La campaña ya está en marcha.' });
    if (camp.status === 'done') return res.status(409).json({ message: 'Esa campaña ya terminó.' });

    const account = camp.whatsappAccount
      ? await gateway.getAccountById(camp.whatsappAccount)
      : await gateway.getDefaultAccount();
    if (!account) return res.status(400).json({ message: 'No hay ningún número de WhatsApp configurado.' });

    // Cloud API fuera de la ventana de 24h exige plantilla aprobada. Sin esto la
    // campaña "correría" omitiendo todos los mensajes en silencio.
    if (gateway.isCloud(account)) {
      if (!camp.template) {
        return res.status(400).json({
          message: 'Este número es de Cloud API: para escribir a contactos nuevos necesitas una plantilla aprobada por Meta.',
        });
      }
      const tpl = await MessageTemplate.findById(camp.template);
      if (!tpl || tpl.status !== 'approved') {
        return res.status(400).json({
          message: `La plantilla "${camp.templateName}" no está aprobada por Meta (estado: ${tpl?.status || 'desconocido'}).`,
        });
      }
    } else if (!camp.body?.trim()) {
      return res.status(400).json({ message: 'El número es QR (no admite plantillas): escribe el texto del mensaje.' });
    }

    if (camp.status === 'draft') {
      camp.startedAt = new Date();
      camp.stats.total = await Contact.countDocuments(buildSendableMatch(req.clinicId, camp.group));
      if (camp.stats.total === 0) {
        return res.status(400).json({ message: 'No hay ningún contacto al que enviar: revisa el grupo y los consentimientos.' });
      }
    }
    camp.status = 'running';
    camp.nextRunAt = new Date(); // la primera tanda sale ya
    await camp.save();
    // Se lanza la primera tanda sin esperar al job, para que se vea moverse.
    runCampaign(camp._id).catch(() => {});
    res.json(camp);
  } catch (err) {
    res.status(500).json({ message: 'Error al arrancar la campaña', error: err.message });
  }
};

exports.pause = async (req, res) => {
  try {
    const camp = await DripCampaign.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId, status: 'running' },
      { $set: { status: 'paused', nextRunAt: null } },
      { new: true }
    ).select('-sentContacts');
    if (!camp) return res.status(404).json({ message: 'No hay una campaña en marcha con ese id.' });
    res.json(camp);
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

exports.remove = async (req, res) => {
  try {
    const camp = await DripCampaign.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!camp) return res.status(404).json({ message: 'Campaña no encontrada' });
    if (camp.status === 'running') {
      return res.status(409).json({ message: 'Pausa la campaña antes de borrarla.' });
    }
    await camp.deleteOne();
    res.json({ message: 'Campaña eliminada' });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};
