const mongoose = require('mongoose');

/**
 * Publicación planificada para redes sociales (Fénix → Redes sociales).
 *
 * UNA publicación, VARIOS destinos: el mismo contenido (medios, texto,
 * hashtags, enlace) sale hacia varias cuentas, cada una con su formato (post,
 * reel, historia, short…) y, si hace falta, su propio texto. Cada destino lleva
 * su estado: puede salir en Instagram y fallar en TikTok, y eso se ve y se
 * reintenta por separado.
 *
 * Estado de la publicación (lo deriva utils/social/publisher a partir de los
 * destinos una vez que arranca):
 *   draft        borrador, no sale sola
 *   in_review    esperando aprobación de un admin
 *   scheduled    programada: el job la toma al llegar `scheduledAt`
 *   publishing   en curso (algún destino subiendo o procesándose en la red)
 *   needs_action falta publicar A MANO algún destino (modo recordatorio)
 *   published    todos los destinos salieron
 *   partial      salieron algunos y otros fallaron
 *   failed       no salió ninguno
 *   cancelled    cancelada
 *
 * Es del CRM: vive bajo la clínica ancla y la ven todas las empresas.
 */
const STATUSES = [
  'draft', 'in_review', 'scheduled', 'publishing', 'needs_action',
  'published', 'partial', 'failed', 'cancelled',
];
const TARGET_STATUSES = ['pending', 'processing', 'published', 'failed', 'manual_due', 'skipped'];
const NETWORKS = ['facebook', 'instagram', 'tiktok', 'youtube'];
const FORMATS = ['post', 'carousel', 'reel', 'story', 'video', 'short', 'photo'];

const mediaSchema = new mongoose.Schema(
  {
    media: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatGalleryImage', required: true },
    url: { type: String, default: '' },
    mimeType: { type: String, default: '' },
    name: { type: String, default: '' },
    size: { type: Number, default: 0 },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    // Segundos (solo video).
    duration: { type: Number, default: 0 },
    // Si el video se armó con música (utils/social/musicMix): el medio original
    // y el audio, para poder quitarla y volver al original.
    original: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatGalleryImage', default: null },
    originalUrl: { type: String, default: '' },
    originalMimeType: { type: String, default: '' },
    music: { type: mongoose.Schema.Types.ObjectId, ref: 'ChatGalleryImage', default: null },
    musicName: { type: String, default: '' },
  },
  { _id: false }
);

/**
 * MÚSICA de la publicación:
 *   ''     sin música
 *   'file' audio propio ya montado en el video (ver mediaSchema.music)
 *   'app'  canción de la biblioteca de la red: las APIs no la permiten, así que
 *          solo vale para destinos A MANO (o borrador de TikTok); `name` es la
 *          canción que la persona elegirá en la app.
 */
const musicSchema = new mongoose.Schema(
  {
    mode: { type: String, enum: ['', 'file', 'app'], default: '' },
    name: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const targetSchema = new mongoose.Schema(
  {
    network: { type: String, enum: NETWORKS, required: true },
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialAccount', default: null },
    // Copia del nombre: si la cuenta se desconecta, el historial sigue diciendo dónde salió.
    accountName: { type: String, default: '' },
    format: { type: String, enum: FORMATS, required: true },
    // 'auto' publica por la API; 'manual' avisa al responsable para que lo
    // suba a mano (historias con sticker de enlace, música, etc.).
    mode: { type: String, enum: ['auto', 'manual'], default: 'auto' },
    // Texto propio de este destino ('' = usa el general).
    caption: { type: String, default: '' },
    // YouTube (obligatorio) y fotos de TikTok.
    title: { type: String, default: '' },
    /**
     * Opciones propias de cada red:
     *   instagram: { shareToFeed }
     *   tiktok:    { postMode: 'direct'|'inbox', privacyLevel, allowComment,
     *                allowDuet, allowStitch, brandContent, brandOrganic, isAigc }
     *   youtube:   { privacyStatus, madeForKids, categoryId }
     */
    options: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: TARGET_STATUSES, default: 'pending' },
    externalId: { type: String, default: '' },
    permalink: { type: String, default: '' },
    error: { type: String, default: '' },
    // Aviso que no es error («salió privado», «no se pudo poner la miniatura»).
    note: { type: String, default: '' },
    attempts: { type: Number, default: 0 },
    // Estado intermedio de la red (ids de contenedor, publish_id…) mientras procesa.
    state: { type: mongoose.Schema.Types.Mixed, default: {} },
    nextCheckAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    commentStatus: { type: String, enum: ['', 'ok', 'failed'], default: '' },
    commentError: { type: String, default: '' },
  },
  { _id: true }
);

const noteSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    userName: { type: String, default: '' },
    text: { type: String, required: true, trim: true },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    userName: { type: String, default: '' },
    action: { type: String, required: true },
    detail: { type: String, default: '' },
  },
  { _id: false }
);

const socialPostSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    // Nombre interno para el calendario («Promo sueros octubre»). No se publica.
    title: { type: String, required: true, trim: true },
    caption: { type: String, default: '' },
    hashtags: { type: [String], default: [] },
    link: { type: String, trim: true, default: '' },
    firstComment: { type: String, default: '' },
    media: { type: [mediaSchema], default: [] },
    // Portada opcional (reel de Instagram, miniatura de YouTube).
    cover: { type: mediaSchema, default: null },
    music: { type: musicSchema, default: () => ({}) },
    targets: { type: [targetSchema], default: [] },
    scheduledAt: { type: Date, default: null },
    status: { type: String, enum: STATUSES, default: 'draft', index: true },
    campaign: { type: String, trim: true, default: '' },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    reviewNote: { type: String, default: '' },
    notes: { type: [noteSchema], default: [] },
    history: { type: [historySchema], default: [] },
    publishedAt: { type: Date, default: null },
    // Próxima vez que el job debe mirar la publicación (destinos procesándose).
    nextRunAt: { type: Date, default: null },
    // Candado del job: mientras esté en el futuro, otro tick no la toma.
    lockedUntil: { type: Date, default: null },
  },
  { timestamps: true }
);

socialPostSchema.index({ clinic: 1, scheduledAt: 1 });
socialPostSchema.index({ status: 1, scheduledAt: 1 });
socialPostSchema.index({ status: 1, nextRunAt: 1 });

socialPostSchema.statics.STATUSES = STATUSES;
socialPostSchema.statics.TARGET_STATUSES = TARGET_STATUSES;
socialPostSchema.statics.NETWORKS = NETWORKS;
socialPostSchema.statics.FORMATS = FORMATS;

module.exports = mongoose.model('SocialPost', socialPostSchema);
