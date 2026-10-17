/**
 * Motor de publicación del planificador de redes sociales.
 *
 * El job (index.js, SOLO en el backend líder) llama a `processDueSocialPosts`
 * cada minuto. Toma las publicaciones vencidas con un RECLAMO ATÓMICO
 * (`lockedUntil`): aunque dos procesos o dos ticks coincidan, cada publicación
 * la trabaja uno solo. Es la lección de los workflows que reenviaban mensajes
 * (ver processDueEnrollments): sin reclamo, dos procesos publicarían dos veces.
 *
 * Cada destino avanza por su cuenta:
 *   pending ──start──▶ processing ──check──▶ published
 *      │                    │
 *      └──── error ─────────┴──▶ failed      (se reintenta solo si el error es
 *                                             momentáneo: caída, límite de llamadas)
 *   modo manual: pending ──▶ manual_due (se avisa al responsable)
 *
 * Las redes procesan los videos a su ritmo: mientras tanto el destino queda en
 * `processing` y la publicación vuelve a mirarse en `nextRunAt`.
 */
const SocialPost = require('../../models/SocialPost');
const SocialAccount = require('../../models/SocialAccount');
const SocialPublishingConfig = require('../../models/SocialPublishingConfig');
const { encryptSecret, decryptSecret, isEncrypted } = require('../secretCrypto');
const { validateTarget, NETWORK_LABELS, FORMAT_LABELS } = require('./rules');
const { SocialApiError } = require('./http');
const meta = require('./meta');
const tiktok = require('./tiktok');
const youtube = require('./youtube');

// Una subida de video grande a YouTube puede tardar; el candado debe cubrirla.
const LOCK_MS = 20 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MIN = [2, 5, 15];
const BATCH = 20;

const MODULES = {
  facebook: { start: meta.startFacebook, check: meta.checkFacebook },
  instagram: { start: meta.startInstagram, check: meta.checkInstagram },
  tiktok: { start: tiktok.start, check: tiktok.check },
  youtube: { start: youtube.start, check: async () => { throw new SocialApiError('YouTube no tiene pasos pendientes'); } },
};

const targetLabel = (t) => `${NETWORK_LABELS[t.network] || t.network} · ${FORMAT_LABELS[t.format] || t.format}`;

/**
 * Token vigente de la cuenta. TikTok (24 h) y YouTube (1 h) caducan: si le
 * quedan menos de 5 minutos se renueva con el refresh token y se guarda.
 */
/**
 * Descifra un secreto o falla SIN culpar a la cuenta. Un servidor sin la
 * SECRETS_KEY de producción (el `npm run dev` local apunta a la base real)
 * recibe el texto cifrado tal cual: mandarlo a la red daba «token inválido» y
 * marcaba la cuenta como rota para todos. Es un problema de ESTE servidor.
 */
function descifrar(valor) {
  const t = decryptSecret(valor);
  if (t && isEncrypted(t)) {
    throw new SocialApiError('Este servidor no puede descifrar los tokens (falta o cambió SECRETS_KEY)', { retryable: true });
  }
  return t;
}

async function getToken(account, cfg) {
  if (account.network === 'facebook' || account.network === 'instagram') {
    const t = descifrar(account.accessToken);
    if (!t) throw new SocialApiError('La cuenta no tiene token: vuelve a conectarla', { tokenInvalid: true });
    return t;
  }
  const expiring = !account.tokenExpiresAt || account.tokenExpiresAt.getTime() - Date.now() < 5 * 60 * 1000;
  if (expiring) {
    const refreshToken = descifrar(account.refreshToken);
    if (!refreshToken) throw new SocialApiError('La conexión caducó: vuelve a conectar la cuenta', { tokenInvalid: true });
    let r;
    if (account.network === 'tiktok') {
      r = await tiktok.refresh({
        clientKey: cfg.tiktok?.clientKey,
        clientSecret: descifrar(cfg.tiktok?.clientSecret),
        refreshToken,
      });
      account.refreshExpiresAt = r.refreshExpiresAt || account.refreshExpiresAt;
    } else {
      r = await youtube.refresh({
        clientId: cfg.google?.clientId,
        clientSecret: descifrar(cfg.google?.clientSecret),
        refreshToken,
      });
    }
    account.accessToken = encryptSecret(r.accessToken);
    if (r.refreshToken) account.refreshToken = encryptSecret(r.refreshToken);
    account.tokenExpiresAt = r.tokenExpiresAt;
    await account.save();
    return r.accessToken;
  }
  return descifrar(account.accessToken);
}

/** Estado de la publicación a partir de sus destinos (una vez arrancada). */
function deriveStatus(post) {
  const ts = post.targets || [];
  if (ts.some((t) => t.status === 'pending' || t.status === 'processing')) return 'publishing';
  if (ts.some((t) => t.status === 'manual_due')) return 'needs_action';
  const ok = ts.filter((t) => t.status === 'published').length;
  const failed = ts.filter((t) => t.status === 'failed').length;
  if (failed && ok) return 'partial';
  if (failed) return 'failed';
  return ok ? 'published' : 'cancelled';
}

function nextRunFor(post) {
  let next = null;
  for (const t of post.targets || []) {
    if (t.status !== 'pending' && t.status !== 'processing') continue;
    const at = t.nextCheckAt || new Date();
    if (!next || at < next) next = at;
  }
  return next;
}

function addHistory(post, { user = null, userName = 'Sistema', action, detail = '' }) {
  post.history.push({ at: new Date(), user, userName, action, detail });
  // El historial no debe crecer sin límite con los reintentos.
  if (post.history.length > 200) post.history = post.history.slice(-200);
}

function failTarget(t, message) {
  t.status = 'failed';
  t.error = String(message || 'Error desconocido').slice(0, 1000);
  t.nextCheckAt = null;
}

/** Avanza UN destino. Devuelve el evento que hubo ('published'|'failed'|'manual'|null). */
async function runTarget(post, t, accounts, cfg) {
  const now = new Date();
  if (t.status !== 'pending' && t.status !== 'processing') return null;
  if (t.nextCheckAt && t.nextCheckAt > now) return null;

  if (t.mode === 'manual') {
    t.status = 'manual_due';
    t.nextCheckAt = null;
    return 'manual';
  }

  const account = t.account ? accounts.get(String(t.account)) : null;
  if (!account) {
    failTarget(t, 'La cuenta fue desconectada o eliminada');
    return 'failed';
  }

  const starting = t.status === 'pending';
  if (starting) {
    const errs = validateTarget(post, t, account);
    if (errs.length) {
      failTarget(t, errs.join(' · '));
      return 'failed';
    }
    t.attempts = (t.attempts || 0) + 1;
    t.startedAt = now;
  }

  try {
    const token = await getToken(account, cfg);
    const mod = MODULES[t.network];
    const r = starting ? await mod.start({ post, target: t, account, token }) : await mod.check({ post, target: t, account, token });
    if (r.status === 'processing') {
      t.status = 'processing';
      t.state = r.state;
      t.markModified('state');
      t.error = '';
      t.nextCheckAt = new Date(Date.now() + (r.checkInMs || 30000));
      return null;
    }
    t.status = 'published';
    t.externalId = r.externalId || '';
    t.permalink = r.permalink || '';
    t.note = r.note || '';
    t.error = '';
    t.state = {};
    t.markModified('state');
    t.nextCheckAt = null;
    t.publishedAt = new Date();
    if (account.status !== 'connected') {
      account.status = 'connected';
      account.lastError = '';
      await account.save().catch(() => {});
    }
    // Primer comentario (Facebook e Instagram, no en historias).
    const comment = String(post.firstComment || '').trim();
    if (comment && t.externalId && ['facebook', 'instagram'].includes(t.network) && t.format !== 'story') {
      try {
        await meta.comment({ target: t, token, message: comment });
        t.commentStatus = 'ok';
      } catch (err) {
        t.commentStatus = 'failed';
        t.commentError = String(err.message || '').slice(0, 500);
      }
    }
    return 'published';
  } catch (err) {
    const message = err?.message || String(err);
    if (err?.tokenInvalid) {
      account.status = 'error';
      account.lastError = message.slice(0, 500);
      await account.save().catch(() => {});
    }
    if (err?.retryable) {
      if (starting && t.attempts < MAX_ATTEMPTS) {
        t.status = 'pending';
        t.error = `Reintentando: ${message}`.slice(0, 1000);
        t.nextCheckAt = new Date(Date.now() + RETRY_DELAYS_MIN[Math.min(t.attempts - 1, RETRY_DELAYS_MIN.length - 1)] * 60 * 1000);
        return null;
      }
      if (!starting) {
        // La red ya tiene el contenido: un fallo momentáneo al consultar no lo
        // tumba; se vuelve a mirar (cada módulo corta a las 2 horas).
        t.error = `Consultando de nuevo: ${message}`.slice(0, 1000);
        t.nextCheckAt = new Date(Date.now() + 2 * 60 * 1000);
        return null;
      }
    }
    failTarget(t, message);
    return 'failed';
  }
}

async function notify(post, type, title, body) {
  try {
    const { notificarUsuarios } = require('../pushNotifications');
    const to = [post.assignedTo, post.createdBy].filter(Boolean);
    await notificarUsuarios(to, {
      clinicId: post.clinic,
      type,
      title,
      body,
      url: `/social?post=${post._id}`,
      meta: { socialPost: String(post._id) },
    });
  } catch (err) {
    console.warn('[social] no se pudo avisar:', err.message);
  }
}

/** Trabaja UNA publicación ya reclamada (candado puesto). */
async function runPost(post) {
  const cfg = await SocialPublishingConfig.forClinic(post.clinic);
  const ids = [...new Set((post.targets || []).map((t) => t.account).filter(Boolean).map(String))];
  const accounts = new Map((await SocialAccount.find({ _id: { $in: ids } })).map((a) => [String(a._id), a]));

  if (post.status === 'scheduled') {
    post.status = 'publishing';
    addHistory(post, { action: 'publishing', detail: 'Comenzó la publicación' });
  }

  const events = [];
  for (const t of post.targets) {
    const ev = await runTarget(post, t, accounts, cfg);
    if (ev) events.push({ ev, t });
  }

  for (const { ev, t } of events) {
    if (ev === 'published') addHistory(post, { action: 'target_published', detail: `${targetLabel(t)}${t.permalink ? ` · ${t.permalink}` : ''}` });
    if (ev === 'failed') addHistory(post, { action: 'target_failed', detail: `${targetLabel(t)}: ${t.error}` });
    if (ev === 'manual') addHistory(post, { action: 'manual_due', detail: `${targetLabel(t)}: toca publicarlo a mano` });
  }

  post.status = deriveStatus(post);
  post.nextRunAt = post.status === 'publishing' ? nextRunFor(post) : null;
  if (post.status !== 'publishing' && !post.publishedAt && post.targets.some((t) => t.status === 'published')) {
    post.publishedAt = new Date();
  }
  post.lockedUntil = null;
  await post.save();

  const manual = events.filter((e) => e.ev === 'manual');
  if (manual.length) {
    await notify(
      post,
      'social_post_manual',
      `Toca publicar a mano: ${post.title}`,
      manual.map((e) => targetLabel(e.t)).join(', ')
    );
  }
  const failed = events.filter((e) => e.ev === 'failed');
  if (failed.length) {
    await notify(
      post,
      'social_post_failed',
      `No se pudo publicar: ${post.title}`,
      failed.map((e) => `${targetLabel(e.t)}: ${e.t.error}`).join(' · ').slice(0, 300)
    );
  }
  return post;
}

/** Job: toma y trabaja las publicaciones vencidas (programadas o procesándose). */
async function processDueSocialPosts() {
  let processed = 0;
  for (let i = 0; i < BATCH; i += 1) {
    const now = new Date();
    const post = await SocialPost.findOneAndUpdate(
      {
        $and: [
          { $or: [{ status: 'scheduled', scheduledAt: { $lte: now } }, { status: 'publishing', nextRunAt: { $lte: now } }] },
          { $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }] },
        ],
      },
      { $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) } },
      { new: true, sort: { scheduledAt: 1 } }
    );
    if (!post) break;
    try {
      await runPost(post);
    } catch (err) {
      console.error('[social] error publicando %s: %s', post._id, err.message);
      // Suelta el candado en unos minutos para que se reintente, sin martillar.
      await SocialPost.updateOne({ _id: post._id }, { $set: { lockedUntil: new Date(Date.now() + 5 * 60 * 1000) } }).catch(() => {});
    }
    processed += 1;
  }
  return processed;
}

/**
 * «Publicar ahora» y reintentos no esperan al tick del job: se lanza en segundo
 * plano en el mismo proceso. El reclamo atómico evita que choque con el job.
 */
function kick() {
  // Un servidor con los jobs apagados (dev local contra la base real) no
  // publica: lo hará el líder en su próximo tick.
  if (process.env.JOBS_DISABLED === '1') return;
  setImmediate(() => {
    processDueSocialPosts().catch((err) => console.error('[social] kick:', err.message));
  });
}

module.exports = {
  MAX_ATTEMPTS,
  addHistory,
  deriveStatus,
  getToken,
  kick,
  processDueSocialPosts,
  runPost,
  runTarget,
};
