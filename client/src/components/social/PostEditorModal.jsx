import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  HiOutlineArrowLeft,
  HiOutlineArrowRight,
  HiOutlineXMark,
  HiOutlinePhoto,
  HiOutlineCloudArrowUp,
  HiOutlineExclamationTriangle,
  HiOutlineArrowPath,
  HiOutlineCheck,
  HiOutlineLink,
  HiOutlineHandRaised,
  HiOutlineTrash,
  HiOutlineDocumentDuplicate,
} from 'react-icons/hi2';
import api from '../../api/axios';
import Modal from '../Modal';
import DateTimeInput from '../DateTimeInput';
import TagEditor from '../TagEditor';
import NetworkIcon from './NetworkIcon';
import PostPreview from './PostPreview';
import MusicSection from './MusicSection';
import { fmtDateTime, todayEc } from '../../utils/date';
import { uploadSocialMedia } from '../../utils/socialMedia';
import {
  NETWORKS,
  NETWORK_LABELS,
  FORMAT_LABELS,
  FORMATS_BY_NETWORK,
  STATUS_META,
  TARGET_STATUS_META,
  TIKTOK_PRIVACY_LABELS,
  YOUTUBE_CATEGORIES,
  LIMITS,
  composeText,
  defaultFormat,
  isVideo,
  normalizeHashtags,
  targetWarnings,
  toEcInput,
  fromEcInput,
} from '../../utils/socialRules';

const EDITABLE = ['draft', 'in_review', 'scheduled', 'failed', 'cancelled'];
const ACCEPT = 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime';

let keySeq = 0;
const newKey = () => `t${Date.now()}_${keySeq++}`;

function defaultOptions(network) {
  if (network === 'instagram') return { shareToFeed: true };
  // TikTok exige que la privacidad la elija la persona y que las interacciones
  // arranquen desmarcadas: nada de valores por defecto aquí.
  if (network === 'tiktok') return { postMode: 'direct', privacyLevel: '', allowComment: false, allowDuet: false, allowStitch: false, commercial: false, brandContent: false, brandOrganic: false };
  if (network === 'youtube') return { privacyStatus: 'public', categoryId: '22' };
  return {};
}

function blankForm(initialDate) {
  return {
    title: '',
    campaign: '',
    assignedTo: '',
    caption: '',
    hashtags: [],
    link: '',
    firstComment: '',
    media: [],
    cover: null,
    music: { mode: '', name: '' },
    targets: [],
    // `initialDate` puede traer ya la hora (vista Día del calendario).
    scheduledAt: initialDate ? (initialDate.includes('T') ? initialDate : `${initialDate}T10:00:00`) : '',
  };
}

function formFromPost(p) {
  return {
    title: p.title || '',
    campaign: p.campaign || '',
    assignedTo: p.assignedTo?._id || p.assignedTo || '',
    caption: p.caption || '',
    hashtags: p.hashtags || [],
    link: p.link || '',
    firstComment: p.firstComment || '',
    media: p.media || [],
    cover: p.cover || null,
    music: { mode: p.music?.mode || '', name: p.music?.name || '' },
    targets: (p.targets || []).map((t) => ({ ...t, key: t._id, options: t.options || {} })),
    scheduledAt: toEcInput(p.scheduledAt),
  };
}

const lbl = 'lbl';

export default function PostEditorModal({ isOpen, postId, initialDate, accounts, config, team, isAdmin, onClose, onChanged }) {
  const [post, setPost] = useState(null);
  const [form, setForm] = useState(() => blankForm(initialDate));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploads, setUploads] = useState([]);
  const [tiktokInfo, setTiktokInfo] = useState({});
  const [noteText, setNoteText] = useState('');
  const fileRef = useRef(null);
  const coverRef = useRef(null);

  const accountsById = useMemo(() => Object.fromEntries((accounts || []).map((a) => [String(a._id), a])), [accounts]);
  const editable = !post || EDITABLE.includes(post.status);

  // Consulta a TikTok qué permite el creador (lo exige su guía de publicación directa).
  const loadTiktokInfo = async (accountId) => {
    if (!accountId) return;
    setTiktokInfo((s) => ({ ...s, [accountId]: { loading: true } }));
    try {
      const { data } = await api.get(`/social/accounts/${accountId}/tiktok-creator`);
      setTiktokInfo((s) => ({ ...s, [accountId]: data }));
    } catch (e) {
      setTiktokInfo((s) => ({ ...s, [accountId]: { error: e.response?.data?.message || 'No se pudo consultar TikTok' } }));
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    setUploads([]);
    setNoteText('');
    setTiktokInfo({});
    if (!postId) {
      setPost(null);
      setForm(blankForm(initialDate));
      return;
    }
    setLoading(true);
    api
      .get(`/social/posts/${postId}`)
      .then(({ data }) => {
        setPost(data);
        setForm(formFromPost(data));
        if (EDITABLE.includes(data.status)) {
          for (const t of data.targets || []) if (t.network === 'tiktok' && t.account && t.mode !== 'manual') loadTiktokInfo(t.account);
        }
      })
      .catch((e) => {
        toast.error(e.response?.data?.message || 'No se pudo abrir la publicación');
        onClose();
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, postId]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setTarget = (key, patch) =>
    setForm((f) => ({ ...f, targets: f.targets.map((t) => (t.key === key ? { ...t, ...patch } : t)) }));
  const setTargetOpt = (key, patch) =>
    setForm((f) => ({ ...f, targets: f.targets.map((t) => (t.key === key ? { ...t, options: { ...t.options, ...patch } } : t)) }));

  const toggleAccount = (acc) => {
    const exists = form.targets.find((t) => String(t.account) === String(acc._id));
    if (exists) {
      set({ targets: form.targets.filter((t) => t.key !== exists.key) });
      return;
    }
    set({
      targets: [
        ...form.targets,
        { key: newKey(), network: acc.network, account: acc._id, format: defaultFormat(acc.network, form.media), mode: 'auto', caption: '', title: '', options: defaultOptions(acc.network) },
      ],
    });
    if (acc.network === 'tiktok' && !tiktokInfo[acc._id]) loadTiktokInfo(acc._id);
  };

  const addManual = (network) =>
    set({
      targets: [
        ...form.targets,
        { key: newKey(), network, account: null, format: defaultFormat(network, form.media), mode: 'manual', caption: '', title: '', options: defaultOptions(network) },
      ],
    });

  // ── Medios ──
  const uploadFiles = async (files, { asCover = false } = {}) => {
    for (const file of files) {
      const key = newKey();
      setUploads((u) => [...u, { key, name: file.name, progress: 0 }]);
      try {
        const m = await uploadSocialMedia(file, (p) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: p } : x))));
        if (asCover) setForm((f) => ({ ...f, cover: m }));
        else setForm((f) => ({ ...f, media: [...f.media, m] }));
      } catch (e) {
        toast.error(e.response?.data?.message || e.message || `No se pudo subir ${file.name}`);
      } finally {
        setUploads((u) => u.filter((x) => x.key !== key));
      }
    }
  };
  const moveMedia = (i, dir) => {
    const arr = [...form.media];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    set({ media: arr });
  };

  // ── Guardar ──
  const payload = () => ({
    title: form.title,
    campaign: form.campaign,
    assignedTo: form.assignedTo || null,
    caption: form.caption,
    hashtags: form.hashtags,
    link: form.link,
    firstComment: form.firstComment,
    media: form.media,
    cover: form.cover,
    music: form.music,
    // `key` es solo del editor (identifica destinos aún sin _id): no viaja.
    targets: form.targets.map((t) => {
      const out = { ...t, _id: post && t._id ? t._id : undefined };
      delete out.key;
      return out;
    }),
    scheduledAt: fromEcInput(form.scheduledAt),
  });

  const save = async (action) => {
    if (!form.title.trim()) {
      toast.error('Ponle un nombre a la publicación');
      return;
    }
    if (action === 'publish_now' && !window.confirm('¿Publicar ahora en todas las cuentas elegidas?')) return;
    setSaving(true);
    try {
      const body = { ...payload(), action };
      const { data } = post ? await api.put(`/social/posts/${post._id}`, body) : await api.post('/social/posts', body);
      const msg =
        data.status === 'in_review' ? 'Enviada a revisión' :
        action === 'publish_now' ? 'Publicando…' :
        action === 'schedule' ? 'Publicación programada' : 'Borrador guardado';
      toast.success(msg);
      onChanged?.();
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo guardar', { duration: 8000 });
    } finally {
      setSaving(false);
    }
  };

  const act = async (fn, okMsg, { close = false } = {}) => {
    setSaving(true);
    try {
      const { data } = await fn();
      if (okMsg) toast.success(okMsg);
      onChanged?.();
      if (close) onClose();
      else if (data && data._id) {
        setPost(data);
        setForm(formFromPost(data));
      }
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo completar', { duration: 8000 });
    } finally {
      setSaving(false);
    }
  };

  const approve = () => act(() => api.post(`/social/posts/${post._id}/approve`), 'Aprobada y programada', { close: true });
  const reject = () => {
    const reason = window.prompt('¿Qué hay que cambiar? (le llega a quien la propuso)');
    if (reason === null) return;
    act(() => api.post(`/social/posts/${post._id}/reject`, { reason }), 'Devuelta a borrador', { close: true });
  };
  const unschedule = () => act(() => api.post(`/social/posts/${post._id}/unschedule`), 'Pasó a borrador');
  const duplicate = () => act(() => api.post(`/social/posts/${post._id}/duplicate`), 'Copia creada como borrador');
  const remove = () => {
    if (!window.confirm('¿Eliminar esta publicación? Podrás restaurarla desde la papelera de reciclaje.')) return;
    act(() => api.delete(`/social/posts/${post._id}`), 'Movida a la papelera', { close: true });
  };
  const retry = (t) => act(() => api.post(`/social/posts/${post._id}/targets/${t._id}/retry`), 'Reintentando');
  const markManual = (t) => {
    const permalink = window.prompt('Pega el enlace de la publicación (opcional)', '');
    if (permalink === null) return;
    act(() => api.post(`/social/posts/${post._id}/targets/${t._id}/manual`, { permalink }), 'Marcado como publicado');
  };
  const skipTarget = (t) => {
    if (!window.confirm('¿Omitir este destino? No se publicará ahí.')) return;
    act(() => api.post(`/social/posts/${post._id}/targets/${t._id}/manual`, { skip: true }), 'Destino omitido');
  };
  const addNote = async () => {
    if (!noteText.trim()) return;
    await act(() => api.post(`/social/posts/${post._id}/notes`, { text: noteText }), null);
    setNoteText('');
  };

  // ── Derivados ──
  const allWarnings = form.targets.flatMap((t) =>
    targetWarnings(form, t, t.account ? accountsById[String(t.account)] : null, tiktokInfo[String(t.account)]).map((w) => ({
      t,
      w,
    }))
  );
  const tagSuggestions = useMemo(() => {
    const s = new Set();
    for (const g of config?.hashtagGroups || []) for (const t of g.tags || []) s.add(normalizeHashtags([t])[0]);
    return [...s].filter(Boolean);
  }, [config]);
  const igText = composeText(form, {});
  const tiktokDirect = form.targets.some((t) => t.network === 'tiktok' && t.mode !== 'manual' && (t.options?.postMode || 'direct') === 'direct');
  const tiktokBrand = form.targets.some((t) => t.network === 'tiktok' && t.options?.brandContent);
  const needsReview = config?.requireApproval && !isAdmin;
  const status = post?.status;

  const title = post ? `Publicación · ${post.title}` : 'Nueva publicación';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="full">
      {loading ? (
        <p className="text-center text-slate-400 py-16">Cargando…</p>
      ) : (
        <div className="grid lg:grid-cols-[minmax(0,1fr)_340px] gap-6">
          {/* ───────────── Columna izquierda: el formulario ───────────── */}
          <div className="space-y-5 min-w-0">
            {post && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`badge ${STATUS_META[status]?.badge}`}>{STATUS_META[status]?.label}</span>
                {post.createdBy?.name && <span className="text-slate-400">Creada por {post.createdBy.name}</span>}
                {post.approvedBy?.name && <span className="text-slate-400">· Aprobada por {post.approvedBy.name}</span>}
                {post.reviewNote && status === 'draft' && (
                  <span className="text-amber-700 bg-amber-50 px-2 py-0.5 rounded">Cambios pedidos: {post.reviewNote}</span>
                )}
              </div>
            )}

            <fieldset disabled={!editable || saving} className="space-y-5 border-0 p-0 m-0 min-w-0">
              <div className="grid sm:grid-cols-3 gap-3">
                <label className="sm:col-span-1">
                  <span className={lbl}>Nombre interno *</span>
                  <input className="input" value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="Promo sueros octubre" />
                </label>
                <label>
                  <span className={lbl}>Campaña (opcional)</span>
                  <input className="input" value={form.campaign} onChange={(e) => set({ campaign: e.target.value })} placeholder="Octubre rosa" />
                </label>
                <label>
                  <span className={lbl}>Responsable</span>
                  <select className="input" value={form.assignedTo} onChange={(e) => set({ assignedTo: e.target.value })}>
                    <option value="">Quien la crea</option>
                    {(team || []).map((u) => <option key={u._id} value={u._id}>{u.name}</option>)}
                  </select>
                </label>
              </div>

              {/* ── Dónde se publica ── */}
              <section>
                <p className={lbl}>¿Dónde se publica?</p>
                {(accounts || []).length === 0 && (
                  <p className="text-xs text-slate-500 mb-2">
                    No hay cuentas conectadas. Conéctalas en la pestaña <b>Cuentas</b>, o agrega un recordatorio para publicar a mano.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {(accounts || []).map((a) => {
                    const on = form.targets.some((t) => String(t.account) === String(a._id));
                    return (
                      <button
                        key={a._id}
                        type="button"
                        onClick={() => toggleAccount(a)}
                        className={`inline-flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full border text-xs cursor-pointer transition-colors ${on ? 'bg-emerald-50 border-emerald-500 text-emerald-800' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'}`}
                      >
                        {a.avatarUrl ? <img src={a.avatarUrl} alt="" className="w-6 h-6 rounded-full object-cover" /> : <span className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center"><NetworkIcon network={a.network} className="w-3.5 h-3.5" /></span>}
                        <NetworkIcon network={a.network} className="w-3.5 h-3.5" />
                        <span className="font-medium">{a.username ? `@${a.username}` : a.name}</span>
                        {a.status === 'error' && <HiOutlineExclamationTriangle className="w-4 h-4 text-rose-500" title={a.lastError} />}
                        {on && <HiOutlineCheck className="w-4 h-4" />}
                      </button>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-center gap-1 mt-2 text-[11px] text-slate-500">
                  <HiOutlineHandRaised className="w-3.5 h-3.5" /> Recordatorio para publicar a mano en:
                  {NETWORKS.map((n) => (
                    <button key={n} type="button" onClick={() => addManual(n)} className="btn-ghost !px-2 !py-1 !text-[11px]">
                      <NetworkIcon network={n} className="w-3 h-3" /> {NETWORK_LABELS[n]}
                    </button>
                  ))}
                </div>
              </section>

              {/* ── Medios ── */}
              <section>
                <div className="flex items-center justify-between">
                  <p className={lbl}>Imágenes y videos</p>
                  <span className="text-[11px] text-slate-400">El orden es el del carrusel</span>
                </div>
                <div
                  className="border-2 border-dashed border-slate-200 rounded-xl p-3 bg-slate-50/50"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (editable) uploadFiles([...e.dataTransfer.files]);
                  }}
                >
                  <div className="flex flex-wrap gap-2">
                    {form.media.map((m, i) => (
                      <div key={String(m.media)} className="relative w-24 h-24 rounded-lg overflow-hidden bg-slate-200 group">
                        {isVideo(m) ? (
                          <video src={m.url} muted preload="metadata" className="w-full h-full object-cover" />
                        ) : (
                          <img src={m.url} alt="" className="w-full h-full object-cover" />
                        )}
                        <span className="absolute top-1 left-1 bg-black/60 text-white text-[10px] px-1.5 rounded">
                          {i + 1}{isVideo(m) && m.duration ? ` · ${m.duration}s` : ''}{m.original ? ' · ♪' : ''}
                        </span>
                        {editable && (
                          <div className="absolute inset-x-0 bottom-0 flex justify-between bg-black/50 p-0.5">
                            <button type="button" onClick={() => moveMedia(i, -1)} className="p-1 text-white bg-transparent border-none cursor-pointer" aria-label="Mover a la izquierda"><HiOutlineArrowLeft className="w-3.5 h-3.5" /></button>
                            <button type="button" onClick={() => set({ media: form.media.filter((_, k) => k !== i) })} className="p-1 text-white bg-transparent border-none cursor-pointer" aria-label="Quitar"><HiOutlineXMark className="w-3.5 h-3.5" /></button>
                            <button type="button" onClick={() => moveMedia(i, 1)} className="p-1 text-white bg-transparent border-none cursor-pointer" aria-label="Mover a la derecha"><HiOutlineArrowRight className="w-3.5 h-3.5" /></button>
                          </div>
                        )}
                      </div>
                    ))}
                    {uploads.map((u) => (
                      <div key={u.key} className="w-24 h-24 rounded-lg bg-white border border-slate-200 flex flex-col items-center justify-center text-[10px] text-slate-500 p-1 text-center">
                        <HiOutlineCloudArrowUp className="w-5 h-5 text-emerald-600" />
                        <span className="truncate w-full">{u.name}</span>
                        <span>{u.progress}%</span>
                      </div>
                    ))}
                    {editable && (
                      <button type="button" onClick={() => fileRef.current?.click()} className="w-24 h-24 rounded-lg border border-slate-300 bg-white flex flex-col items-center justify-center gap-1 text-[11px] text-slate-500 cursor-pointer hover:border-emerald-500 hover:text-emerald-700">
                        <HiOutlinePhoto className="w-6 h-6" /> Agregar
                      </button>
                    )}
                  </div>
                  <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { uploadFiles([...e.target.files]); e.target.value = ''; }} />
                  <p className="text-[11px] text-slate-400 mt-2">
                    JPG, PNG, WEBP, MP4 o MOV, hasta 100 MB por archivo. Las imágenes se convierten a JPG (Instagram no acepta otro formato).
                  </p>
                </div>
                <div className="flex items-center gap-2 mt-2 text-xs">
                  <span className="text-slate-500">Portada (reel de Instagram, miniatura de YouTube):</span>
                  {form.cover ? (
                    <span className="inline-flex items-center gap-1">
                      <img src={form.cover.url} alt="" className="w-8 h-8 rounded object-cover" />
                      {editable && <button type="button" onClick={() => set({ cover: null })} className="btn-ghost !p-1"><HiOutlineXMark className="w-4 h-4" /></button>}
                    </span>
                  ) : (
                    editable && <button type="button" onClick={() => coverRef.current?.click()} className="btn-ghost !px-2 !py-1 !text-xs">Subir imagen</button>
                  )}
                  <input ref={coverRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { uploadFiles([...e.target.files].slice(0, 1), { asCover: true }); e.target.value = ''; }} />
                </div>
              </section>

              <MusicSection form={form} set={set} editable={editable} />

              {/* ── Texto ── */}
              <section className="space-y-3">
                <label className="block">
                  <span className={lbl}>Texto / descripción</span>
                  <textarea className="input min-h-[120px]" value={form.caption} onChange={(e) => set({ caption: e.target.value })} placeholder="Escribe el texto de la publicación…" />
                  <span className={`text-[11px] ${igText.length > LIMITS.instagramCaption ? 'text-rose-600' : 'text-slate-400'}`}>
                    {igText.length} / {LIMITS.instagramCaption} con enlace y hashtags (límite de Instagram y TikTok)
                  </span>
                </label>
                <div>
                  <div className="flex items-center justify-between">
                    <span className={lbl}>Hashtags</span>
                    <span className={`text-[11px] ${normalizeHashtags(form.hashtags).length > LIMITS.instagramHashtags ? 'text-rose-600' : 'text-slate-400'}`}>
                      {normalizeHashtags(form.hashtags).length} / {LIMITS.instagramHashtags}
                    </span>
                  </div>
                  <TagEditor value={form.hashtags} onChange={(v) => set({ hashtags: v })} suggestions={tagSuggestions} placeholder="Escribe un hashtag y pulsa Enter…" readOnly={!editable} />
                  {(config?.hashtagGroups || []).length > 0 && editable && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {config.hashtagGroups.map((g) => (
                        <button key={g._id || g.name} type="button" onClick={() => set({ hashtags: normalizeHashtags([...form.hashtags, ...g.tags]) })} className="px-2 py-0.5 rounded-full text-[11px] border border-slate-200 bg-white text-slate-600 cursor-pointer hover:border-emerald-500">
                          + {g.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  <label>
                    <span className={lbl}>Enlace (opcional)</span>
                    <input className="input" value={form.link} onChange={(e) => set({ link: e.target.value })} placeholder="https://…" />
                    <span className="text-[11px] text-slate-400">En Facebook sale como tarjeta; en Instagram y TikTok no es clicable.</span>
                  </label>
                  <label>
                    <span className={lbl}>Primer comentario (Facebook e Instagram)</span>
                    <textarea className="input min-h-[42px]" rows={2} value={form.firstComment} onChange={(e) => set({ firstComment: e.target.value })} placeholder="Ej.: Agenda tu cita por WhatsApp…" />
                  </label>
                </div>
              </section>

              {/* ── Ajustes por destino ── */}
              {form.targets.length > 0 && (
                <section className="space-y-2">
                  <p className={lbl}>Ajustes por red</p>
                  {form.targets.map((t) => (
                    <TargetCard
                      key={t.key}
                      t={t}
                      account={t.account ? accountsById[String(t.account)] : null}
                      tiktok={tiktokInfo[String(t.account)]}
                      onChange={(patch) => setTarget(t.key, patch)}
                      onOpt={(patch) => setTargetOpt(t.key, patch)}
                      onRemove={() => set({ targets: form.targets.filter((x) => x.key !== t.key) })}
                      onReloadTiktok={() => loadTiktokInfo(t.account)}
                    />
                  ))}
                </section>
              )}

              {/* ── Cuándo ── */}
              <section>
                <span className={lbl}>Fecha y hora de publicación (hora de Ecuador: hora, minuto y segundo)</span>
                <div className="max-w-sm">
                  <DateTimeInput value={form.scheduledAt} min={todayEc()} step={1} onChange={(e) => set({ scheduledAt: e.target.value })} className="input" />
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  Sale en los segundos siguientes a esa hora. Un video puede tardar unos minutos más en verse, mientras la red lo procesa.
                </p>
              </section>
            </fieldset>

            {/* ── Resultados por destino (ya arrancó) ── */}
            {post && !['draft', 'in_review', 'scheduled'].includes(status) && (
              <section>
                <p className={lbl}>Resultado por red</p>
                <div className="space-y-2">
                  {(post.targets || []).map((t) => {
                    const acc = t.account ? accountsById[String(t.account)] : null;
                    return (
                      <div key={t._id} className="border border-slate-200 rounded-xl p-3 bg-white">
                        <div className="flex flex-wrap items-center gap-2">
                          <NetworkIcon network={t.network} />
                          <span className="text-sm font-medium text-slate-700">{acc?.username ? `@${acc.username}` : acc?.name || t.accountName || NETWORK_LABELS[t.network]}</span>
                          <span className="text-xs text-slate-400">{FORMAT_LABELS[t.format]}{t.mode === 'manual' ? ' · a mano' : ''}</span>
                          <span className={`badge ${TARGET_STATUS_META[t.status]?.badge} ml-auto`}>{TARGET_STATUS_META[t.status]?.label}</span>
                        </div>
                        {t.permalink && (
                          <a href={t.permalink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-emerald-700 mt-1 break-all">
                            <HiOutlineLink className="w-3.5 h-3.5 shrink-0" /> {t.permalink}
                          </a>
                        )}
                        {t.error && <p className="text-xs text-rose-600 mt-1 break-words">{t.error}</p>}
                        {t.note && <p className="text-xs text-amber-700 mt-1">{t.note}</p>}
                        {t.commentStatus === 'failed' && <p className="text-xs text-amber-700 mt-1">El primer comentario no se pudo publicar: {t.commentError}</p>}
                        {t.publishedAt && <p className="text-[11px] text-slate-400 mt-1">{fmtDateTime(t.publishedAt)}</p>}
                        {(t.status === 'failed' || t.status === 'manual_due') && (
                          <div className="flex flex-wrap gap-2 mt-2">
                            {t.status === 'failed' && t.mode !== 'manual' && (
                              <button type="button" disabled={saving} onClick={() => retry(t)} className="btn-secondary !py-1.5 !text-xs"><HiOutlineArrowPath className="w-4 h-4" /> Reintentar</button>
                            )}
                            <button type="button" disabled={saving} onClick={() => markManual(t)} className="btn-secondary !py-1.5 !text-xs"><HiOutlineCheck className="w-4 h-4" /> Ya lo publiqué a mano</button>
                            <button type="button" disabled={saving} onClick={() => skipTarget(t)} className="btn-ghost !py-1.5 !text-xs">Omitir</button>
                          </div>
                        )}
                        {t.status === 'manual_due' && (
                          <ManualHelp post={post} t={t} />
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </div>

          {/* ───────────── Columna derecha: vista previa, avisos, comentarios ───────────── */}
          <aside className="space-y-4 min-w-0">
            <div className="card p-4">
              <p className={lbl}>Vista previa</p>
              <PostPreview post={form} accountsById={accountsById} />
            </div>

            {editable && allWarnings.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                <p className="text-xs font-semibold text-amber-800 mb-1 flex items-center gap-1"><HiOutlineExclamationTriangle className="w-4 h-4" /> Antes de programar</p>
                <ul className="text-xs text-amber-800 space-y-1 list-none p-0 m-0">
                  {allWarnings.map(({ t, w }, i) => (
                    <li key={`${t.key}-${i}`} className="flex gap-1.5"><NetworkIcon network={t.network} className="w-3 h-3 mt-0.5 shrink-0" /> <span>{FORMAT_LABELS[t.format]}: {w}</span></li>
                  ))}
                </ul>
              </div>
            )}

            {post && (
              <div className="card p-4">
                <p className={lbl}>Comentarios del equipo</p>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {(post.notes || []).length === 0 && <p className="text-xs text-slate-400">Sin comentarios.</p>}
                  {(post.notes || []).map((n) => (
                    <div key={n._id} className="text-xs">
                      <span className="font-semibold text-slate-700">{n.userName || 'Alguien'}</span>{' '}
                      <span className="text-slate-400">{fmtDateTime(n.at)}</span>
                      <p className="text-slate-600 whitespace-pre-wrap">{n.text}</p>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2 mt-2">
                  <input className="input input-sm" value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Escribe un comentario…" onKeyDown={(e) => { if (e.key === 'Enter') addNote(); }} />
                  <button type="button" onClick={addNote} disabled={saving || !noteText.trim()} className="btn-secondary !py-1.5 !text-xs">Enviar</button>
                </div>
              </div>
            )}

            {post && (post.history || []).length > 0 && (
              <details className="card p-4">
                <summary className="text-xs font-semibold text-slate-500 cursor-pointer">Historial</summary>
                <ul className="mt-2 space-y-1 list-none p-0 m-0 max-h-48 overflow-y-auto">
                  {[...post.history].reverse().map((h, i) => (
                    <li key={i} className="text-[11px] text-slate-500">
                      <span className="text-slate-400">{fmtDateTime(h.at)}</span> · {h.userName || 'Sistema'}: {h.detail || h.action}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </aside>

          {/* ───────────── Pie: acciones ───────────── */}
          <div className="lg:col-span-2 border-t border-slate-100 pt-4 space-y-3">
            {editable && tiktokDirect && (
              <p className="text-[11px] text-slate-500">
                Al publicar en TikTok, aceptas la{' '}
                <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">Confirmación de uso de música</a>
                {tiktokBrand && (
                  <> y la <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noreferrer">Política de contenido de marca</a></>
                )}{' '}de TikTok. TikTok puede tardar unos minutos en procesar el video.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {post && (
                <>
                  <button type="button" onClick={remove} disabled={saving || status === 'publishing'} className="btn-ghost !text-rose-600"><HiOutlineTrash className="w-4 h-4" /> Eliminar</button>
                  <button type="button" onClick={duplicate} disabled={saving} className="btn-ghost"><HiOutlineDocumentDuplicate className="w-4 h-4" /> Duplicar</button>
                </>
              )}
              <div className="flex flex-wrap gap-2 ml-auto">
                {post && ['scheduled', 'in_review'].includes(status) && (
                  <button type="button" onClick={unschedule} disabled={saving} className="btn-secondary">Desprogramar</button>
                )}
                {post && status === 'in_review' && isAdmin && (
                  <>
                    <button type="button" onClick={reject} disabled={saving} className="btn-secondary">Pedir cambios</button>
                    <button type="button" onClick={approve} disabled={saving} className="btn-primary">Aprobar</button>
                  </>
                )}
                {editable && (
                  <>
                    <button type="button" onClick={() => save('draft')} disabled={saving || uploads.length > 0} className="btn-secondary">Guardar borrador</button>
                    {!needsReview && (
                      <button type="button" onClick={() => save('publish_now')} disabled={saving || uploads.length > 0} className="btn-secondary">Publicar ahora</button>
                    )}
                    <button type="button" onClick={() => save('schedule')} disabled={saving || uploads.length > 0} className="btn-primary">
                      {needsReview ? 'Enviar a revisión' : status === 'scheduled' ? 'Guardar y mantener programada' : 'Programar'}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Ayuda para publicar a mano: el texto listo para copiar y los medios para bajar. */
function ManualHelp({ post, t }) {
  const text = composeText(post, t);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Texto copiado');
    } catch {
      toast.error('No se pudo copiar');
    }
  };
  return (
    <div className="mt-2 rounded-lg bg-slate-50 p-2 text-xs">
      {post.music?.mode === 'app' && post.music?.name && (
        <p className="mb-1 text-amber-800">♪ Música para elegir en la app: <b>{post.music.name}</b></p>
      )}
      {text && (
        <>
          <p className="whitespace-pre-wrap text-slate-600 max-h-32 overflow-y-auto">{text}</p>
          <button type="button" onClick={copy} className="btn-ghost !px-2 !py-1 !text-xs mt-1">Copiar texto</button>
        </>
      )}
      {(post.media || []).length > 0 && (
        <div className="flex flex-wrap gap-2 mt-1">
          {post.media.map((m, i) => (
            <a key={String(m.media)} href={`${m.url}?download=1`} className="text-emerald-700">Descargar medio {i + 1}</a>
          ))}
        </div>
      )}
    </div>
  );
}

function TargetCard({ t, account, tiktok, onChange, onOpt, onRemove, onReloadTiktok }) {
  const [ownText, setOwnText] = useState(Boolean(t.caption));
  const o = t.options || {};
  const name = account ? (account.username ? `@${account.username}` : account.name) : 'Publicar a mano';
  return (
    <div className="border border-slate-200 rounded-xl p-3 bg-white space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <NetworkIcon network={t.network} />
        <span className="text-sm font-medium text-slate-700">{name}</span>
        <select className="input input-sm !w-auto" value={t.format} onChange={(e) => onChange({ format: e.target.value })}>
          {FORMATS_BY_NETWORK[t.network].map((f) => <option key={f} value={f}>{FORMAT_LABELS[f]}</option>)}
        </select>
        {account && (
          <select className="input input-sm !w-auto" value={t.mode} onChange={(e) => onChange({ mode: e.target.value })}>
            <option value="auto">Automático</option>
            <option value="manual">Avisarme para publicar a mano</option>
          </select>
        )}
        <button type="button" onClick={onRemove} className="btn-ghost !p-1 ml-auto" aria-label="Quitar destino"><HiOutlineXMark className="w-4 h-4" /></button>
      </div>

      {t.mode === 'manual' && (
        <p className="text-[11px] text-slate-500">
          A la hora programada se avisa al responsable (campana y móvil) con el texto listo para copiar. Útil para historias con
          sticker de enlace, música o encuestas, que las APIs no permiten.
        </p>
      )}

      <label className="flex items-center gap-2 text-xs text-slate-600">
        <input type="checkbox" checked={ownText} onChange={(e) => { setOwnText(e.target.checked); if (!e.target.checked) onChange({ caption: '' }); }} />
        Texto propio para esta red
      </label>
      {ownText && (
        <textarea className="input min-h-[70px]" value={t.caption} onChange={(e) => onChange({ caption: e.target.value })} placeholder="Si lo dejas vacío se usa el texto general" />
      )}

      {t.network === 'instagram' && t.format === 'reel' && t.mode !== 'manual' && (
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" checked={o.shareToFeed !== false} onChange={(e) => onOpt({ shareToFeed: e.target.checked })} />
          Mostrar también en el feed del perfil
        </label>
      )}

      {t.network === 'youtube' && (
        <div className="grid sm:grid-cols-2 gap-2">
          <label className="sm:col-span-2">
            <span className="lbl">Título del video * <span className="font-normal text-slate-400">({String(t.title || '').length}/{LIMITS.youtubeTitle})</span></span>
            <input className="input input-sm" value={t.title} maxLength={LIMITS.youtubeTitle} onChange={(e) => onChange({ title: e.target.value })} placeholder="Si lo dejas vacío se usa el nombre interno" />
          </label>
          {t.mode !== 'manual' && (
            <>
              <label>
                <span className="lbl">Visibilidad</span>
                <select className="input input-sm" value={o.privacyStatus || 'public'} onChange={(e) => onOpt({ privacyStatus: e.target.value })}>
                  <option value="public">Público</option>
                  <option value="unlisted">No listado</option>
                  <option value="private">Privado</option>
                </select>
              </label>
              <label>
                <span className="lbl">Categoría</span>
                <select className="input input-sm" value={o.categoryId || '22'} onChange={(e) => onOpt({ categoryId: e.target.value })}>
                  {YOUTUBE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </label>
              <div className="sm:col-span-2 text-xs text-slate-600">
                <span className="lbl">¿Es contenido creado para niños? *</span>
                <label className="mr-4"><input type="radio" checked={o.madeForKids === false} onChange={() => onOpt({ madeForKids: false })} /> No</label>
                <label><input type="radio" checked={o.madeForKids === true} onChange={() => onOpt({ madeForKids: true })} /> Sí</label>
              </div>
            </>
          )}
        </div>
      )}

      {t.network === 'tiktok' && t.format === 'photo' && (
        <label className="block">
          <span className="lbl">Título de las fotos <span className="font-normal text-slate-400">({String(t.title || '').length}/{LIMITS.tiktokPhotoTitle})</span></span>
          <input className="input input-sm" value={t.title} maxLength={LIMITS.tiktokPhotoTitle} onChange={(e) => onChange({ title: e.target.value })} />
        </label>
      )}

      {t.network === 'tiktok' && t.mode !== 'manual' && account && (
        <TiktokOptions t={t} o={o} tiktok={tiktok} onOpt={onOpt} onReload={onReloadTiktok} />
      )}
    </div>
  );
}

/**
 * Opciones de TikTok tal como las exige su guía para publicación directa:
 * nombre de la cuenta visible, privacidad elegida por la persona (sin valor por
 * defecto), interacciones desmarcadas y grises si el creador las desactivó, y
 * divulgación de contenido comercial.
 */
function TiktokOptions({ t, o, tiktok, onOpt, onReload }) {
  const direct = (o.postMode || 'direct') === 'direct';
  const privacyOptions = tiktok?.privacyLevelOptions || [];
  return (
    <div className="rounded-lg bg-slate-50 p-2.5 space-y-2 text-xs text-slate-600">
      {tiktok?.loading && <p className="text-slate-400">Consultando la cuenta en TikTok…</p>}
      {tiktok?.error && (
        <p className="text-rose-600">
          {tiktok.error} <button type="button" onClick={onReload} className="btn-ghost !px-1 !py-0 !text-xs">Reintentar</button>
        </p>
      )}
      {tiktok?.nickname && <p>Se publicará en la cuenta de TikTok <b>{tiktok.nickname}</b>{tiktok.username ? ` (@${tiktok.username})` : ''}.</p>}

      {t.format === 'video' && (
        <div className="flex flex-wrap gap-4">
          <label><input type="radio" checked={direct} onChange={() => onOpt({ postMode: 'direct' })} /> Publicar directo</label>
          <label><input type="radio" checked={!direct} onChange={() => onOpt({ postMode: 'inbox' })} /> Enviar como borrador a la app de TikTok</label>
        </div>
      )}
      {!direct && <p className="text-slate-500">El video llega como notificación a la app de TikTok y se termina de publicar desde el teléfono (música, efectos, privacidad).</p>}

      {direct && (
        <>
          <label className="block">
            <span className="lbl">¿Quién puede ver esta publicación? *</span>
            <select className="input input-sm" value={o.privacyLevel || ''} onChange={(e) => onOpt({ privacyLevel: e.target.value })}>
              <option value="" disabled>Elige…</option>
              {privacyOptions.map((p) => (
                <option key={p} value={p} disabled={o.brandContent && p === 'SELF_ONLY'}>
                  {TIKTOK_PRIVACY_LABELS[p] || p}{o.brandContent && p === 'SELF_ONLY' ? ' (no disponible con contenido de marca)' : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-4">
            <label className={tiktok?.commentDisabled ? 'opacity-50' : ''}>
              <input type="checkbox" disabled={tiktok?.commentDisabled} checked={Boolean(o.allowComment)} onChange={(e) => onOpt({ allowComment: e.target.checked })} /> Permitir comentarios
            </label>
            {t.format === 'video' && (
              <>
                <label className={tiktok?.duetDisabled ? 'opacity-50' : ''}>
                  <input type="checkbox" disabled={tiktok?.duetDisabled} checked={Boolean(o.allowDuet)} onChange={(e) => onOpt({ allowDuet: e.target.checked })} /> Permitir dúo
                </label>
                <label className={tiktok?.stitchDisabled ? 'opacity-50' : ''}>
                  <input type="checkbox" disabled={tiktok?.stitchDisabled} checked={Boolean(o.allowStitch)} onChange={(e) => onOpt({ allowStitch: e.target.checked })} /> Permitir pegar (stitch)
                </label>
              </>
            )}
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={Boolean(o.commercial)}
              onChange={(e) => onOpt({ commercial: e.target.checked, ...(e.target.checked ? {} : { brandContent: false, brandOrganic: false }) })}
            />
            Divulgar contenido comercial (promociona una marca, producto o servicio)
          </label>
          {o.commercial && (
            <div className="pl-5 space-y-1">
              <label className="block"><input type="checkbox" checked={Boolean(o.brandOrganic)} onChange={(e) => onOpt({ brandOrganic: e.target.checked })} /> Tu marca — se etiquetará como «Contenido promocional»</label>
              <label className="block">
                <input
                  type="checkbox"
                  checked={Boolean(o.brandContent)}
                  onChange={(e) => onOpt({ brandContent: e.target.checked, ...(e.target.checked && o.privacyLevel === 'SELF_ONLY' ? { privacyLevel: '' } : {}) })}
                />{' '}
                Contenido de marca (pagado por un tercero) — se etiquetará como «Colaboración pagada»
              </label>
            </div>
          )}
          {t.format === 'video' && (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={Boolean(o.isAigc)} onChange={(e) => onOpt({ isAigc: e.target.checked })} /> Contenido generado con IA
            </label>
          )}
          {tiktok?.maxVideoPostDurationSec > 0 && <p className="text-slate-400">Duración máxima en esta cuenta: {tiktok.maxVideoPostDurationSec} s.</p>}
        </>
      )}
    </div>
  );
}
