/**
 * Fénix → Redes sociales: planificador de publicaciones (Facebook, Instagram,
 * TikTok y YouTube) por las APIs oficiales.
 *
 * Todo opera sobre la clínica ancla del CRM (middleware/callCenterScope): el
 * CRM es el mismo para todas las empresas, y las cuentas, publicaciones y
 * configuración también.
 *
 * Quién hace qué:
 *   - admin y marketing: planifican, programan, conectan cuentas.
 *   - admin: credenciales de las apps y aprobación (si está activa).
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const mongoose = require('mongoose');

const SocialPost = require('../models/SocialPost');
const SocialAccount = require('../models/SocialAccount');
const SocialPublishingConfig = require('../models/SocialPublishingConfig');
const ChatGalleryImage = require('../models/ChatGalleryImage');
const User = require('../models/User');
const mediaStore = require('../utils/mediaStore');
const { mediaUrlForId } = require('../utils/chatMedia');
const { encryptSecret, decryptSecret } = require('../utils/secretCrypto');
const { moveToTrash } = require('../utils/trashBin');
const { validateTarget, FORMATS_BY_NETWORK } = require('../utils/social/rules');
const oauth = require('../utils/social/oauth');
const meta = require('../utils/social/meta');
const tiktok = require('../utils/social/tiktok');
const youtube = require('../utils/social/youtube');
const publisher = require('../utils/social/publisher');

const EDITABLE = ['draft', 'in_review', 'scheduled', 'failed', 'cancelled'];
const NETWORKS = SocialPost.NETWORKS;

const isAdmin = (req) => Boolean(req.user?.isSuperAdmin) || req.role === 'admin';
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));
const who = (req) => ({ user: req.user?._id || null, userName: req.user?.name || '' });

function fail(res, err, fallback = 'Error') {
  const status = err?.httpStatus || (err?.name === 'SocialApiError' ? 400 : 500);
  return res.status(status).json({ message: err?.message || fallback });
}

function httpError(status, message) {
  const e = new Error(message);
  e.httpStatus = status;
  return e;
}

// ───────────────────────────── Publicaciones ─────────────────────────────

/** Copia limpia de un medio de entrada (la URL se recalcula, no se confía en el cliente). */
function cleanMedia(m) {
  if (!m || !isId(m.media)) return null;
  return {
    media: m.media,
    url: mediaUrlForId(m.media),
    mimeType: String(m.mimeType || ''),
    name: String(m.name || '').slice(0, 200),
    size: Number(m.size) || 0,
    width: Number(m.width) || 0,
    height: Number(m.height) || 0,
    duration: Number(m.duration) || 0,
  };
}

/**
 * Valida y normaliza lo que manda el editor. Los destinos vuelven SIEMPRE a
 * `pending`: solo se edita lo que todavía no salió.
 */
async function buildPostFields(req, body) {
  const out = {};
  if (body.title !== undefined) out.title = String(body.title || '').trim().slice(0, 200);
  if (body.caption !== undefined) out.caption = String(body.caption || '');
  if (body.hashtags !== undefined) out.hashtags = (Array.isArray(body.hashtags) ? body.hashtags : []).map((h) => String(h).trim()).filter(Boolean).slice(0, 60);
  if (body.link !== undefined) out.link = String(body.link || '').trim().slice(0, 1000);
  if (body.firstComment !== undefined) out.firstComment = String(body.firstComment || '').slice(0, 2200);
  if (body.campaign !== undefined) out.campaign = String(body.campaign || '').trim().slice(0, 120);
  if (body.assignedTo !== undefined) out.assignedTo = isId(body.assignedTo) ? body.assignedTo : null;
  if (body.scheduledAt !== undefined) {
    const d = body.scheduledAt ? new Date(body.scheduledAt) : null;
    if (d && Number.isNaN(d.getTime())) throw httpError(400, 'Fecha de publicación inválida');
    out.scheduledAt = d;
  }

  const mediaIds = [];
  if (body.media !== undefined) {
    out.media = (Array.isArray(body.media) ? body.media : []).map(cleanMedia).filter(Boolean).slice(0, 35);
    mediaIds.push(...out.media.map((m) => String(m.media)));
  }
  if (body.cover !== undefined) {
    out.cover = cleanMedia(body.cover);
    if (out.cover) mediaIds.push(String(out.cover.media));
  }
  if (mediaIds.length) {
    const found = await ChatGalleryImage.countDocuments({ _id: { $in: mediaIds }, clinic: req.clinicId });
    if (found !== new Set(mediaIds).size) throw httpError(400, 'Algún medio ya no existe: vuelve a subirlo');
  }

  if (body.targets !== undefined) {
    const raw = Array.isArray(body.targets) ? body.targets : [];
    const accountIds = raw.map((t) => t.account).filter(isId);
    const accounts = new Map(
      (await SocialAccount.find({ _id: { $in: accountIds }, clinic: req.clinicId }).lean()).map((a) => [String(a._id), a])
    );
    out.targets = raw.slice(0, 20).map((t) => {
      const network = String(t.network || '');
      if (!NETWORKS.includes(network)) throw httpError(400, 'Red social desconocida');
      const format = String(t.format || '');
      if (!FORMATS_BY_NETWORK[network].includes(format)) throw httpError(400, `Formato «${format}» no disponible en ${network}`);
      const acc = isId(t.account) ? accounts.get(String(t.account)) : null;
      if (t.account && !acc) throw httpError(400, 'Una de las cuentas ya no está conectada');
      return {
        ...(isId(t._id) ? { _id: t._id } : {}),
        network,
        account: acc ? acc._id : null,
        accountName: acc ? acc.name || acc.username : '',
        format,
        mode: t.mode === 'manual' ? 'manual' : 'auto',
        caption: String(t.caption || ''),
        title: String(t.title || '').slice(0, 200),
        options: t.options && typeof t.options === 'object' ? t.options : {},
        status: 'pending',
      };
    });
  }
  return out;
}

/** Errores que impiden programar (vacío = se puede). */
async function scheduleErrors(post) {
  const errs = [];
  if (!post.title) errs.push('Ponle un nombre a la publicación');
  if (!post.scheduledAt) errs.push('Elige la fecha y hora de publicación');
  if (!post.targets.length) errs.push('Elige al menos una cuenta o red donde publicar');
  const accounts = new Map(
    (await SocialAccount.find({ _id: { $in: post.targets.map((t) => t.account).filter(Boolean) } }).lean()).map((a) => [String(a._id), a])
  );
  for (const t of post.targets) {
    const acc = t.account ? accounts.get(String(t.account)) : null;
    errs.push(...validateTarget(post, t, acc));
    if (acc && acc.status === 'error' && t.mode !== 'manual') errs.push(`${acc.name || acc.username}: la conexión falló, vuelve a conectarla`);
  }
  return errs;
}

function resetTargets(post) {
  for (const t of post.targets) {
    Object.assign(t, {
      status: 'pending', externalId: '', permalink: '', error: '', note: '', attempts: 0,
      state: {}, nextCheckAt: null, startedAt: null, publishedAt: null, publishedBy: null,
      commentStatus: '', commentError: '',
    });
  }
  post.publishedAt = null;
  post.nextRunAt = null;
  post.lockedUntil = null;
}

/**
 * Aplica la acción del editor: 'draft' (guardar), 'schedule' (programar) o
 * 'publish_now'. Con aprobación activa, quien no es admin manda a revisión.
 */
async function applyAction(req, post, action, cfg) {
  if (action === 'draft' || !action) {
    if (post.status !== 'draft') {
      publisher.addHistory(post, { ...who(req), action: 'draft', detail: 'Pasó a borrador' });
    }
    post.status = 'draft';
    return;
  }
  if (action === 'publish_now') post.scheduledAt = new Date();
  const errs = await scheduleErrors(post);
  if (post.scheduledAt && action === 'schedule' && post.scheduledAt.getTime() < Date.now() - 60 * 1000) {
    errs.push('La fecha de publicación ya pasó: elige una futura o usa «Publicar ahora»');
  }
  if (errs.length) throw httpError(400, errs.join(' · '));
  resetTargets(post);
  if (cfg.requireApproval && !isAdmin(req)) {
    post.status = 'in_review';
    post.approvedBy = null;
    post.approvedAt = null;
    publisher.addHistory(post, { ...who(req), action: 'in_review', detail: 'Enviada a revisión' });
    try {
      const { notificarRol } = require('../utils/pushNotifications');
      await notificarRol(post.clinic, 'admin', {
        type: 'social_post_review',
        title: `Publicación para revisar: ${post.title}`,
        body: `La propone ${req.user?.name || 'alguien del equipo'}`,
        url: `/social?post=${post._id}`,
        meta: { socialPost: String(post._id) },
      });
    } catch { /* el aviso no debe impedir guardar */ }
    return;
  }
  post.status = 'scheduled';
  if (cfg.requireApproval) {
    post.approvedBy = req.user._id;
    post.approvedAt = new Date();
  }
  publisher.addHistory(post, {
    ...who(req),
    action: action === 'publish_now' ? 'publish_now' : 'scheduled',
    detail: action === 'publish_now' ? 'Publicar ahora' : `Programada para ${post.scheduledAt.toISOString()}`,
  });
}

const LIST_FIELDS = '-history -notes -targets.state';

exports.listPosts = async (req, res) => {
  try {
    const q = { clinic: req.clinicId };
    const { from, to, status, network, search } = req.query;
    if (from || to) {
      q.scheduledAt = {};
      if (from) q.scheduledAt.$gte = new Date(from);
      if (to) q.scheduledAt.$lte = new Date(to);
    }
    if (status) q.status = { $in: String(status).split(',') };
    if (network) q['targets.network'] = { $in: String(network).split(',') };
    if (search) {
      const rx = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      q.$or = [{ title: rx }, { caption: rx }, { campaign: rx }, { hashtags: rx }];
    }
    // Sin rango se listan también los borradores sin fecha.
    const list = await SocialPost.find(q)
      .select(LIST_FIELDS)
      .populate('assignedTo', 'name')
      .populate('createdBy', 'name')
      .sort({ scheduledAt: 1, createdAt: -1 })
      .limit(Math.min(Number(req.query.limit) || 500, 1000))
      .lean();
    if (from || to) {
      // Los borradores sin fecha no caen en ningún día del calendario, pero el
      // equipo tiene que verlos: van aparte.
      const undated = await SocialPost.find({ clinic: req.clinicId, scheduledAt: null, status: { $in: ['draft', 'in_review'] } })
        .select(LIST_FIELDS)
        .populate('assignedTo', 'name')
        .sort({ updatedAt: -1 })
        .limit(100)
        .lean();
      return res.json({ items: list, undated });
    }
    return res.json({ items: list, undated: [] });
  } catch (err) {
    return fail(res, err, 'Error al listar publicaciones');
  }
};

async function loadFull(req, id) {
  if (!isId(id)) return null;
  return SocialPost.findOne({ _id: id, clinic: req.clinicId })
    .select('-targets.state')
    .populate('assignedTo', 'name')
    .populate('createdBy', 'name')
    .populate('approvedBy', 'name')
    .lean();
}

exports.getPost = async (req, res) => {
  try {
    const post = await loadFull(req, req.params.id);
    if (!post) return res.status(404).json({ message: 'Publicación no encontrada' });
    return res.json(post);
  } catch (err) {
    return fail(res, err);
  }
};

exports.createPost = async (req, res) => {
  try {
    const cfg = await SocialPublishingConfig.forClinic(req.clinicId);
    const fields = await buildPostFields(req, req.body || {});
    if (!fields.title) return res.status(400).json({ message: 'Ponle un nombre a la publicación' });
    const post = new SocialPost({
      ...fields,
      clinic: req.clinicId,
      createdBy: req.user._id,
      updatedBy: req.user._id,
      assignedTo: fields.assignedTo || req.user._id,
    });
    publisher.addHistory(post, { ...who(req), action: 'created', detail: 'Creada' });
    await applyAction(req, post, req.body?.action, cfg);
    await post.save();
    if (post.status === 'scheduled' && post.scheduledAt <= new Date()) publisher.kick();
    return res.status(201).json(await loadFull(req, post._id));
  } catch (err) {
    return fail(res, err, 'Error al crear la publicación');
  }
};

exports.updatePost = async (req, res) => {
  try {
    const post = await SocialPost.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!post) return res.status(404).json({ message: 'Publicación no encontrada' });
    if (!EDITABLE.includes(post.status)) {
      return res.status(409).json({ message: 'Ya se está publicando o salió: solo puedes reintentar o comentar' });
    }
    if (post.lockedUntil && post.lockedUntil > new Date()) {
      return res.status(409).json({ message: 'Se está publicando en este momento; espera un minuto' });
    }
    const cfg = await SocialPublishingConfig.forClinic(req.clinicId);
    const fields = await buildPostFields(req, req.body || {});
    if (fields.title === '') return res.status(400).json({ message: 'Ponle un nombre a la publicación' });
    post.set(fields);
    post.updatedBy = req.user._id;
    await applyAction(req, post, req.body?.action, cfg);
    await post.save();
    if (post.status === 'scheduled' && post.scheduledAt <= new Date()) publisher.kick();
    return res.json(await loadFull(req, post._id));
  } catch (err) {
    return fail(res, err, 'Error al guardar la publicación');
  }
};

exports.approvePost = async (req, res) => {
  try {
    const post = await SocialPost.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!post) return res.status(404).json({ message: 'Publicación no encontrada' });
    if (post.status !== 'in_review') return res.status(409).json({ message: 'La publicación no está en revisión' });
    const errs = await scheduleErrors(post);
    if (errs.length) return res.status(400).json({ message: errs.join(' · ') });
    resetTargets(post);
    post.status = 'scheduled';
    post.approvedBy = req.user._id;
    post.approvedAt = new Date();
    post.reviewNote = '';
    publisher.addHistory(post, { ...who(req), action: 'approved', detail: 'Aprobada' });
    await post.save();
    if (post.scheduledAt <= new Date()) publisher.kick();
    return res.json(await loadFull(req, post._id));
  } catch (err) {
    return fail(res, err);
  }
};

exports.rejectPost = async (req, res) => {
  try {
    const post = await SocialPost.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!post) return res.status(404).json({ message: 'Publicación no encontrada' });
    if (post.status !== 'in_review') return res.status(409).json({ message: 'La publicación no está en revisión' });
    const reason = String(req.body?.reason || '').trim().slice(0, 1000);
    post.status = 'draft';
    post.reviewNote = reason;
    publisher.addHistory(post, { ...who(req), action: 'rejected', detail: reason || 'Devuelta a borrador' });
    if (reason) post.notes.push({ ...who(req), text: `Cambios pedidos: ${reason}` });
    await post.save();
    try {
      const { notificarUsuarios } = require('../utils/pushNotifications');
      await notificarUsuarios([post.createdBy, post.assignedTo].filter(Boolean), {
        clinicId: post.clinic,
        type: 'social_post_review',
        title: `Publicación devuelta: ${post.title}`,
        body: reason || 'Revisa los comentarios',
        url: `/social?post=${post._id}`,
        meta: { socialPost: String(post._id) },
      });
    } catch { /* sin aviso, la publicación igual queda en borrador */ }
    return res.json(await loadFull(req, post._id));
  } catch (err) {
    return fail(res, err);
  }
};

exports.unschedulePost = async (req, res) => {
  try {
    const post = await SocialPost.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!post) return res.status(404).json({ message: 'Publicación no encontrada' });
    if (!['scheduled', 'in_review'].includes(post.status)) return res.status(409).json({ message: 'Solo se puede desprogramar lo que aún no salió' });
    if (post.lockedUntil && post.lockedUntil > new Date()) return res.status(409).json({ message: 'Se está publicando en este momento' });
    post.status = 'draft';
    publisher.addHistory(post, { ...who(req), action: 'draft', detail: 'Desprogramada' });
    await post.save();
    return res.json(await loadFull(req, post._id));
  } catch (err) {
    return fail(res, err);
  }
};

exports.retryTarget = async (req, res) => {
  try {
    const post = await SocialPost.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!post) return res.status(404).json({ message: 'Publicación no encontrada' });
    if (post.lockedUntil && post.lockedUntil > new Date()) return res.status(409).json({ message: 'Se está publicando en este momento' });
    const t = post.targets.id(req.params.targetId);
    if (!t) return res.status(404).json({ message: 'Destino no encontrado' });
    if (t.status !== 'failed') return res.status(409).json({ message: 'Solo se reintenta un destino que falló' });
    Object.assign(t, { status: 'pending', error: '', note: '', attempts: 0, state: {}, nextCheckAt: null });
    post.status = 'publishing';
    post.nextRunAt = new Date();
    publisher.addHistory(post, { ...who(req), action: 'retry', detail: `Reintento: ${t.network} · ${t.format}` });
    await post.save();
    publisher.kick();
    return res.json(await loadFull(req, post._id));
  } catch (err) {
    return fail(res, err);
  }
};

/** Marca un destino como publicado a mano (con su enlace) u omitido. */
exports.markTargetManual = async (req, res) => {
  try {
    const post = await SocialPost.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!post) return res.status(404).json({ message: 'Publicación no encontrada' });
    const t = post.targets.id(req.params.targetId);
    if (!t) return res.status(404).json({ message: 'Destino no encontrado' });
    if (!['manual_due', 'failed'].includes(t.status)) return res.status(409).json({ message: 'Este destino no está pendiente' });
    if (req.body?.skip) {
      t.status = 'skipped';
      publisher.addHistory(post, { ...who(req), action: 'skipped', detail: `${t.network} · ${t.format}: omitido` });
    } else {
      t.status = 'published';
      t.permalink = String(req.body?.permalink || '').trim().slice(0, 1000);
      t.error = '';
      t.publishedAt = new Date();
      t.publishedBy = req.user._id;
      publisher.addHistory(post, { ...who(req), action: 'manual_published', detail: `${t.network} · ${t.format}: publicado a mano` });
    }
    post.status = publisher.deriveStatus(post);
    if (post.status !== 'publishing' && !post.publishedAt && post.targets.some((x) => x.status === 'published')) post.publishedAt = new Date();
    await post.save();
    return res.json(await loadFull(req, post._id));
  } catch (err) {
    return fail(res, err);
  }
};

exports.duplicatePost = async (req, res) => {
  try {
    const src = await SocialPost.findOne({ _id: req.params.id, clinic: req.clinicId }).lean();
    if (!src) return res.status(404).json({ message: 'Publicación no encontrada' });
    const post = new SocialPost({
      clinic: req.clinicId,
      title: `${src.title} (copia)`.slice(0, 200),
      caption: src.caption,
      hashtags: src.hashtags,
      link: src.link,
      firstComment: src.firstComment,
      media: src.media,
      cover: src.cover,
      campaign: src.campaign,
      targets: (src.targets || []).map((t) => ({
        network: t.network, account: t.account, accountName: t.accountName, format: t.format,
        mode: t.mode, caption: t.caption, title: t.title, options: t.options,
      })),
      scheduledAt: null,
      status: 'draft',
      createdBy: req.user._id,
      assignedTo: req.user._id,
    });
    publisher.addHistory(post, { ...who(req), action: 'created', detail: `Copia de «${src.title}»` });
    await post.save();
    return res.status(201).json(await loadFull(req, post._id));
  } catch (err) {
    return fail(res, err);
  }
};

exports.addNote = async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim().slice(0, 2000);
    if (!text) return res.status(400).json({ message: 'Escribe el comentario' });
    const post = await SocialPost.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      { $push: { notes: { ...who(req), text, at: new Date() } } },
      { new: true }
    );
    if (!post) return res.status(404).json({ message: 'Publicación no encontrada' });
    return res.json(await loadFull(req, post._id));
  } catch (err) {
    return fail(res, err);
  }
};

exports.removePost = async (req, res) => {
  try {
    const post = await SocialPost.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!post) return res.status(404).json({ message: 'Publicación no encontrada' });
    if (post.status === 'publishing' || (post.lockedUntil && post.lockedUntil > new Date())) {
      return res.status(409).json({ message: 'Se está publicando: espera a que termine para eliminarla' });
    }
    await moveToTrash({ entityType: 'SocialPost', doc: post, clinic: req.clinicId, user: req.user });
    await post.deleteOne();
    return res.json({ message: 'Publicación movida a la papelera de reciclaje' });
  } catch (err) {
    return fail(res, err);
  }
};

// ───────────────────────────── Medios ─────────────────────────────

const ALLOWED_MIME = /^(image\/(jpeg|png|webp)|video\/(mp4|quicktime))$/i;

exports.mediaUploadMiddleware = (req, res, next) => {
  const multer = require('multer');
  const tmpDir = path.join(mediaStore.rootDir(), 'tmp-social');
  fs.mkdirSync(tmpDir, { recursive: true });
  // A DISCO (no a memoria): un video de cientos de MB en memoria por cada
  // subida tumbaría el proceso.
  const upload = multer({
    storage: multer.diskStorage({ destination: tmpDir }),
    limits: { fileSize: 1024 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      const mime = String(file.mimetype || '').split(';')[0].trim();
      if (!ALLOWED_MIME.test(mime)) return cb(new Error('Formato no admitido: sube JPG, PNG, WEBP, MP4 o MOV'));
      return cb(null, true);
    },
  }).single('file');
  upload(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera 1 GB' : err.message || 'No se pudo recibir el archivo';
    return res.status(400).json({ message: msg });
  });
};

exports.uploadMedia = async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ message: 'Falta el archivo' });
  try {
    const mimeType = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
    const _id = new mongoose.Types.ObjectId();
    const storageKey = mediaStore.buildKey(_id, mimeType);
    const abs = mediaStore.absolutePath(storageKey);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.rename(file.path, abs);
    const doc = await ChatGalleryImage.create({
      _id,
      clinic: req.clinicId,
      name: String(file.originalname || `medio_${Date.now()}`).slice(0, 200),
      storageKey,
      mimeType,
      size: file.size,
      kind: 'social',
      createdBy: req.user._id,
    });
    return res.status(201).json({
      media: doc._id,
      url: mediaUrlForId(doc._id),
      mimeType,
      name: doc.name,
      size: doc.size,
    });
  } catch (err) {
    await fsp.unlink(file.path).catch(() => {});
    return fail(res, err, 'No se pudo guardar el archivo');
  }
};

// ───────────────────────────── Cuentas ─────────────────────────────

exports.listAccounts = async (req, res) => {
  try {
    const list = await SocialAccount.find({ clinic: req.clinicId }).sort({ network: 1, name: 1 });
    return res.json(list.map((a) => a.toPublic()));
  } catch (err) {
    return fail(res, err);
  }
};

exports.removeAccount = async (req, res) => {
  try {
    const acc = await SocialAccount.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!acc) return res.status(404).json({ message: 'Cuenta no encontrada' });
    const pending = await SocialPost.countDocuments({
      clinic: req.clinicId,
      status: { $in: ['scheduled', 'in_review', 'publishing'] },
      'targets.account': acc._id,
    });
    await acc.deleteOne();
    return res.json({
      message: pending
        ? `Cuenta quitada. ${pending} publicación(es) programada(s) la usaban: fallarán en ese destino si no las cambias.`
        : 'Cuenta quitada',
    });
  } catch (err) {
    return fail(res, err);
  }
};

exports.checkAccount = async (req, res) => {
  try {
    const acc = await SocialAccount.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!acc) return res.status(404).json({ message: 'Cuenta no encontrada' });
    const cfg = await SocialPublishingConfig.forClinic(req.clinicId);
    try {
      const token = await publisher.getToken(acc, cfg);
      let info;
      if (acc.network === 'tiktok') info = await tiktok.userInfo(token);
      else if (acc.network === 'youtube') info = await youtube.channelInfo(token);
      else info = await meta.checkAccount(acc, token);
      if (info.name) acc.name = info.name;
      if (info.username) acc.username = info.username;
      if (info.avatarUrl) acc.avatarUrl = info.avatarUrl;
      acc.status = 'connected';
      acc.lastError = '';
    } catch (err) {
      acc.status = 'error';
      acc.lastError = String(err.message || err).slice(0, 500);
    }
    acc.lastCheckedAt = new Date();
    await acc.save();
    return res.json(acc.toPublic());
  } catch (err) {
    return fail(res, err);
  }
};

exports.tiktokCreatorInfo = async (req, res) => {
  try {
    const acc = await SocialAccount.findOne({ _id: req.params.id, clinic: req.clinicId, network: 'tiktok' });
    if (!acc) return res.status(404).json({ message: 'Cuenta de TikTok no encontrada' });
    const cfg = await SocialPublishingConfig.forClinic(req.clinicId);
    const token = await publisher.getToken(acc, cfg);
    const info = await tiktok.creatorInfo(token);
    return res.json({
      nickname: info.creator_nickname || acc.name,
      username: info.creator_username || acc.username,
      avatarUrl: info.creator_avatar_url || acc.avatarUrl,
      privacyLevelOptions: info.privacy_level_options || [],
      commentDisabled: Boolean(info.comment_disabled),
      duetDisabled: Boolean(info.duet_disabled),
      stitchDisabled: Boolean(info.stitch_disabled),
      maxVideoPostDurationSec: info.max_video_post_duration_sec || 0,
    });
  } catch (err) {
    return fail(res, err, 'No se pudo consultar TikTok');
  }
};

/** Equipo que puede quedar como responsable (CRM global: admin y marketing de cualquier sede). */
exports.listTeam = async (req, res) => {
  try {
    const users = await User.find({
      active: { $ne: false },
      $or: [{ 'clinics.role': { $in: ['admin', 'marketing'] } }, { isSuperAdmin: true }],
    })
      .select('name')
      .sort({ name: 1 })
      .lean();
    return res.json(users);
  } catch (err) {
    return fail(res, err);
  }
};

// ───────────────────────────── Conexión (OAuth) ─────────────────────────────

async function upsertAccount(clinicId, network, externalId, fields) {
  return SocialAccount.findOneAndUpdate(
    { clinic: clinicId, network, externalId: String(externalId) },
    { $set: { ...fields, status: 'connected', lastError: '', lastCheckedAt: new Date() } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
}

/** GET /oauth/:network/url → URL de la pantalla de permisos de la red. */
exports.oauthUrl = async (req, res) => {
  try {
    const network = req.params.network;
    const cfg = await SocialPublishingConfig.forClinic(req.clinicId);
    const state = oauth.signState({ userId: req.user._id, clinicId: req.clinicId, network });
    const redirectUri = oauth.redirectUri(network);
    if (network === 'meta') {
      if (!cfg.meta.appId || !cfg.meta.appSecret) return res.status(400).json({ message: 'Falta configurar el App ID y el App Secret de Meta' });
      return res.json({ url: meta.oauthUrl({ appId: cfg.meta.appId, redirectUri, state }) });
    }
    if (network === 'tiktok') {
      if (!cfg.tiktok.clientKey || !cfg.tiktok.clientSecret) return res.status(400).json({ message: 'Falta configurar el Client Key y el Client Secret de TikTok' });
      return res.json({ url: tiktok.oauthUrl({ clientKey: cfg.tiktok.clientKey, redirectUri, state }) });
    }
    if (network === 'youtube') {
      if (!cfg.google.clientId || !cfg.google.clientSecret) return res.status(400).json({ message: 'Falta configurar el Client ID y el Client Secret de Google' });
      return res.json({ url: youtube.oauthUrl({ clientId: cfg.google.clientId, redirectUri, state }) });
    }
    return res.status(404).json({ message: 'Red desconocida' });
  } catch (err) {
    return fail(res, err);
  }
};

/** GET /oauth/:network/callback — PÚBLICA: la red redirige aquí el navegador. */
exports.oauthCallback = async (req, res) => {
  const network = req.params.network;
  const send = (ok, message) => res.status(200).type('html').send(oauth.callbackHtml({ ok, network, message }));
  try {
    if (req.query.error) return send(false, String(req.query.error_description || req.query.error_message || req.query.error));
    const st = oauth.verifyState(req.query.state, network);
    if (!st) return send(false, 'El enlace caducó o no es válido. Vuelve a intentarlo desde el CRM.');
    const code = String(req.query.code || '');
    if (!code) return send(false, 'La red no devolvió el código de autorización');
    const clinicId = st.c;
    const cfg = await SocialPublishingConfig.forClinic(clinicId);
    const redirectUri = oauth.redirectUri(network);

    if (network === 'meta') {
      const userToken = await meta.exchangeCode({
        appId: cfg.meta.appId,
        appSecret: decryptSecret(cfg.meta.appSecret),
        code,
        redirectUri,
      });
      cfg.metaPending = { userToken: encryptSecret(userToken), at: new Date(), via: 'oauth' };
      await cfg.save();
      return send(true, 'Autorizado. Vuelve al CRM para elegir las páginas y cuentas de Instagram.');
    }

    if (network === 'tiktok') {
      const t = await tiktok.exchangeCode({
        clientKey: cfg.tiktok.clientKey,
        clientSecret: decryptSecret(cfg.tiktok.clientSecret),
        code,
        redirectUri,
      });
      const info = await tiktok.userInfo(t.accessToken);
      await upsertAccount(clinicId, 'tiktok', info.openId || t.openId, {
        name: info.name,
        username: info.username,
        avatarUrl: info.avatarUrl,
        accessToken: encryptSecret(t.accessToken),
        refreshToken: encryptSecret(t.refreshToken),
        tokenExpiresAt: t.tokenExpiresAt,
        refreshExpiresAt: t.refreshExpiresAt,
        scopes: t.scopes,
        connectedVia: 'oauth',
        connectedBy: st.u,
      });
      return send(true, `TikTok conectado: ${info.name || info.username}`);
    }

    if (network === 'youtube') {
      const t = await youtube.exchangeCode({
        clientId: cfg.google.clientId,
        clientSecret: decryptSecret(cfg.google.clientSecret),
        code,
        redirectUri,
      });
      if (!t.refreshToken) return send(false, 'Google no entregó acceso permanente. Quita el acceso de la app en tu cuenta de Google y vuelve a conectar.');
      const ch = await youtube.channelInfo(t.accessToken);
      await upsertAccount(clinicId, 'youtube', ch.channelId, {
        name: ch.name,
        username: ch.username,
        avatarUrl: ch.avatarUrl,
        accessToken: encryptSecret(t.accessToken),
        refreshToken: encryptSecret(t.refreshToken),
        tokenExpiresAt: t.tokenExpiresAt,
        scopes: t.scopes,
        connectedVia: 'oauth',
        connectedBy: st.u,
      });
      return send(true, `YouTube conectado: ${ch.name}`);
    }
    return send(false, 'Red desconocida');
  } catch (err) {
    console.error('[social] callback %s: %s', network, err.message);
    return send(false, err.message || 'No se pudo completar la conexión');
  }
};

/** Token de sistema de Meta pegado a mano (Business Manager → Usuarios del sistema). */
exports.metaManualToken = async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ message: 'Pega el token' });
    const pages = await meta.listPages(token);
    if (!pages.length) return res.status(400).json({ message: 'El token no administra ninguna página. Asígnale las páginas al usuario del sistema.' });
    const cfg = await SocialPublishingConfig.forClinic(req.clinicId);
    cfg.metaPending = { userToken: encryptSecret(token), at: new Date(), via: 'token' };
    await cfg.save();
    return res.json({ ok: true, count: pages.length });
  } catch (err) {
    return fail(res, err, 'El token no es válido');
  }
};

/** Páginas e Instagram disponibles con el token pendiente (sin tokens). */
exports.metaPages = async (req, res) => {
  try {
    const cfg = await SocialPublishingConfig.forClinic(req.clinicId);
    const userToken = decryptSecret(cfg.metaPending?.userToken);
    if (!userToken) return res.status(400).json({ message: 'Primero conecta con Facebook o pega un token' });
    const pages = await meta.listPages(userToken);
    const existing = await SocialAccount.find({ clinic: req.clinicId, network: { $in: ['facebook', 'instagram'] } }).select('network externalId').lean();
    const has = new Set(existing.map((a) => `${a.network}:${a.externalId}`));
    return res.json(
      pages.map((p) => ({
        id: p.id,
        name: p.name,
        picture: p.picture,
        connected: has.has(`facebook:${p.id}`),
        instagram: p.instagram ? { ...p.instagram, connected: has.has(`instagram:${p.instagram.id}`) } : null,
      }))
    );
  } catch (err) {
    return fail(res, err, 'No se pudieron leer las páginas');
  }
};

exports.metaAddAccounts = async (req, res) => {
  try {
    const cfg = await SocialPublishingConfig.forClinic(req.clinicId);
    const userToken = decryptSecret(cfg.metaPending?.userToken);
    if (!userToken) return res.status(400).json({ message: 'La autorización caducó: vuelve a conectar con Facebook' });
    const wantFb = new Set((req.body?.facebook || []).map(String));
    const wantIg = new Set((req.body?.instagram || []).map(String));
    if (!wantFb.size && !wantIg.size) return res.status(400).json({ message: 'Elige al menos una página o cuenta' });
    const pages = await meta.listPages(userToken);
    const via = cfg.metaPending?.via || 'oauth';
    let added = 0;
    for (const p of pages) {
      if (wantFb.has(p.id)) {
        await upsertAccount(req.clinicId, 'facebook', p.id, {
          name: p.name,
          avatarUrl: p.picture,
          accessToken: encryptSecret(p.accessToken),
          pageId: p.id,
          scopes: meta.OAUTH_SCOPES,
          connectedVia: via,
          connectedBy: req.user._id,
        });
        added += 1;
      }
      if (p.instagram && wantIg.has(p.instagram.id)) {
        await upsertAccount(req.clinicId, 'instagram', p.instagram.id, {
          name: p.instagram.name || p.instagram.username,
          username: p.instagram.username,
          avatarUrl: p.instagram.picture,
          accessToken: encryptSecret(p.accessToken),
          pageId: p.id,
          scopes: meta.OAUTH_SCOPES,
          connectedVia: via,
          connectedBy: req.user._id,
        });
        added += 1;
      }
    }
    cfg.metaPending = { userToken: '', at: null, via: 'oauth' };
    await cfg.save();
    const list = await SocialAccount.find({ clinic: req.clinicId }).sort({ network: 1, name: 1 });
    return res.json({ added, accounts: list.map((a) => a.toPublic()) });
  } catch (err) {
    return fail(res, err, 'No se pudieron agregar las cuentas');
  }
};

// ───────────────────────────── Configuración ─────────────────────────────

function publicConfig(cfg) {
  return {
    meta: { appId: cfg.meta?.appId || '', hasSecret: Boolean(cfg.meta?.appSecret) },
    tiktok: { clientKey: cfg.tiktok?.clientKey || '', hasSecret: Boolean(cfg.tiktok?.clientSecret) },
    google: { clientId: cfg.google?.clientId || '', hasSecret: Boolean(cfg.google?.clientSecret) },
    requireApproval: Boolean(cfg.requireApproval),
    hashtagGroups: cfg.hashtagGroups || [],
    metaPending: Boolean(cfg.metaPending?.userToken),
    redirectUris: oauth.redirectUris(),
    publicApiUrl: String(process.env.PUBLIC_API_URL || ''),
  };
}

exports.getConfig = async (req, res) => {
  try {
    const cfg = await SocialPublishingConfig.forClinic(req.clinicId);
    return res.json({ ...publicConfig(cfg), canEdit: isAdmin(req) });
  } catch (err) {
    return fail(res, err);
  }
};

exports.updateConfig = async (req, res) => {
  try {
    const cfg = await SocialPublishingConfig.forClinic(req.clinicId);
    const b = req.body || {};
    const setPair = (section, idField, secretField) => {
      const src = b[section];
      if (!src || typeof src !== 'object') return;
      if (src[idField] !== undefined) cfg[section][idField] = String(src[idField] || '').trim();
      // El secreto solo se cambia si llega uno nuevo; vacío = se mantiene.
      if (src.secret) cfg[section][secretField] = encryptSecret(String(src.secret).trim());
      if (src.clearSecret) cfg[section][secretField] = '';
    };
    setPair('meta', 'appId', 'appSecret');
    setPair('tiktok', 'clientKey', 'clientSecret');
    setPair('google', 'clientId', 'clientSecret');
    if (b.requireApproval !== undefined) cfg.requireApproval = Boolean(b.requireApproval);
    cfg.updatedBy = req.user._id;
    await cfg.save();
    return res.json({ ...publicConfig(cfg), canEdit: true });
  } catch (err) {
    return fail(res, err);
  }
};

exports.updateHashtagGroups = async (req, res) => {
  try {
    const cfg = await SocialPublishingConfig.forClinic(req.clinicId);
    const groups = (Array.isArray(req.body?.groups) ? req.body.groups : [])
      .map((g) => ({
        name: String(g?.name || '').trim().slice(0, 80),
        tags: (Array.isArray(g?.tags) ? g.tags : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 60),
      }))
      .filter((g) => g.name)
      .slice(0, 100);
    cfg.hashtagGroups = groups;
    await cfg.save();
    return res.json({ ...publicConfig(cfg), canEdit: isAdmin(req) });
  } catch (err) {
    return fail(res, err);
  }
};
