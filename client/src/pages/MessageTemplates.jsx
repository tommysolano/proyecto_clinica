import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus,
  HiOutlinePencil,
  HiOutlineTrash,
  HiOutlineArrowPath,
  HiOutlineDocumentText,
  HiOutlinePhoto,
  HiOutlineXMark,
  HiOutlineExclamationTriangle,
  HiOutlinePaperAirplane,
} from 'react-icons/hi2';
import Modal from '../components/Modal';
import WhatsappPreview from '../components/WhatsappPreview';

const BUTTON_TYPES = [
  { value: 'quick_reply', label: 'Respuesta rápida' },
  { value: 'url', label: 'Enlace (URL)' },
  { value: 'phone', label: 'Llamar' },
];

const CATEGORIES = [
  { value: 'MARKETING', label: 'Marketing (promocional)' },
  { value: 'UTILITY', label: 'Utilidad (transaccional)' },
  { value: 'AUTHENTICATION', label: 'Autenticación (códigos)' },
];

const STATUS_BADGE = {
  draft: { label: 'Borrador', cls: 'bg-slate-100 text-slate-600' },
  pending: { label: 'En revisión', cls: 'bg-amber-100 text-amber-700' },
  approved: { label: 'Aprobada', cls: 'bg-emerald-100 text-emerald-700' },
  rejected: { label: 'Rechazada', cls: 'bg-red-100 text-red-700' },
  disabled: { label: 'Deshabilitada', cls: 'bg-slate-200 text-slate-500' },
};

const blank = () => ({
  channel: 'whatsapp',
  name: '',
  language: 'es',
  category: 'MARKETING',
  headerType: 'none',
  headerText: '',
  headerMediaUrl: '',
  body: '',
  footer: '',
  subject: '',
  buttons: [],
});

export default function MessageTemplates() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [submittingId, setSubmittingId] = useState(null);

  const uploadHeaderImage = async (file) => {
    if (!file) return;
    if (file.size > 1_800_000) {
      toast.error('Imagen demasiado grande (máx ~1.8MB)');
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const { data } = await api.post('/message-templates/upload-image', { dataUrl, name: file.name });
      setEditing((prev) => ({ ...prev, headerType: 'image', headerMediaUrl: data.url }));
      toast.success('Imagen subida');
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo subir la imagen');
    } finally {
      setUploading(false);
    }
  };

  const [alerts, setAlerts] = useState([]);

  const loadAlerts = async () => {
    try {
      const { data } = await api.get('/message-templates/alerts', { params: { unread: true } });
      setAlerts(data || []);
    } catch {
      /* noop */
    }
  };

  const dismissAlert = async (id) => {
    setAlerts((prev) => prev.filter((a) => a._id !== id));
    try {
      await api.post(`/message-templates/alerts/${id}/read`);
    } catch {
      /* noop */
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/message-templates');
      setList(data);
      loadAlerts();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al cargar plantillas');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    if (!editing.name.trim() || !editing.body.trim()) {
      toast.error('Nombre y cuerpo son obligatorios');
      return;
    }
    try {
      if (editing._id) {
        await api.put(`/message-templates/${editing._id}`, editing);
        toast.success('Plantilla actualizada');
      } else {
        await api.post('/message-templates', editing);
        toast.success('Plantilla creada');
      }
      setEditing(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al guardar');
    }
  };

  const remove = async (id) => {
    if (!window.confirm('¿Eliminar esta plantilla?')) return;
    try {
      await api.delete(`/message-templates/${id}`);
      toast.success('Eliminada');
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al eliminar');
    }
  };

  const submitToMeta = async (t) => {
    if (
      !window.confirm(
        `¿Enviar "${t.name}" a Meta para aprobación?\n\nUna vez enviada no podrás cambiar su nombre. Meta puede tardar de minutos a 24h en aprobarla.`
      )
    )
      return;
    setSubmittingId(t._id);
    try {
      const { data } = await api.post(`/message-templates/${t._id}/submit`);
      toast.success(`Enviada a Meta — estado: ${STATUS_BADGE[data.status]?.label || data.status}`);
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo enviar a Meta');
    } finally {
      setSubmittingId(null);
    }
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const { data } = await api.post('/message-templates/sync-whatsapp');
      toast.success(`Sincronizado: ${data.imported} importadas, ${data.updated} actualizadas${data.alerts ? `, ${data.alerts} alerta(s)` : ''}`);
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al sincronizar con Meta');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <HiOutlineDocumentText className="text-emerald-600" /> Plantillas de mensaje
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Plantillas aprobadas por Meta para iniciar conversaciones fuera de la ventana de 24h.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={sync}
            disabled={syncing}
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm flex items-center gap-1 bg-white cursor-pointer disabled:opacity-50"
          >
            <HiOutlineArrowPath className={syncing ? 'animate-spin' : ''} /> Sincronizar con Meta
          </button>
          <button
            onClick={() => setEditing(blank())}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm flex items-center gap-1 cursor-pointer border-none"
          >
            <HiOutlinePlus /> Nueva plantilla
          </button>
        </div>
      </div>

      {alerts.length > 0 && (
        <div className="mb-4 space-y-2">
          {alerts.map((a) => (
            <div
              key={a._id}
              className={`flex items-start justify-between gap-3 rounded-xl border px-3 py-2 ${a.severity === 'error' ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'}`}
            >
              <div className="flex items-start gap-2">
                <HiOutlineExclamationTriangle className={`w-5 h-5 mt-0.5 shrink-0 ${a.severity === 'error' ? 'text-red-500' : 'text-amber-500'}`} />
                <div>
                  <div className="text-sm font-semibold text-slate-800">{a.title}</div>
                  {a.body && <div className="text-xs text-slate-600">{a.body}</div>}
                </div>
              </div>
              <button
                onClick={() => dismissAlert(a._id)}
                className="text-xs text-slate-500 hover:text-slate-800 bg-transparent border-none cursor-pointer shrink-0"
              >
                Descartar
              </button>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <p className="text-slate-400">Cargando…</p>
      ) : list.length === 0 ? (
        <div className="text-center py-16 text-slate-400 border border-dashed border-slate-200 rounded-xl">
          Aún no tienes plantillas. Crea una o sincroniza las aprobadas en Meta.
        </div>
      ) : (
        <div className="grid gap-3">
          {list.map((t) => {
            const badge = STATUS_BADGE[t.status] || STATUS_BADGE.draft;
            return (
              <div key={t._id} className="border border-slate-200 rounded-xl p-4 bg-white flex justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold">{t.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${badge.cls}`}>{badge.label}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">
                      {t.channel} · {t.language} · {t.category}
                    </span>
                  </div>
                  <p className="text-sm text-slate-600 mt-2 whitespace-pre-wrap break-words">{t.body}</p>
                  {t.rejectionReason ? (
                    <p className="text-xs text-red-500 mt-1">Motivo de rechazo: {t.rejectionReason}</p>
                  ) : null}
                  {t.variables?.length ? (
                    <p className="text-xs text-slate-400 mt-1">
                      Variables: {t.variables.map((v) => `{{${v.key}}}`).join(' ')}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-start gap-1 shrink-0">
                  {t.channel === 'whatsapp' && (t.status === 'draft' || t.status === 'rejected') && (
                    <button
                      onClick={() => submitToMeta(t)}
                      disabled={submittingId === t._id}
                      title="Enviar a Meta para aprobación"
                      className="px-2.5 py-1.5 text-xs bg-emerald-600 text-white rounded-lg cursor-pointer border-none disabled:opacity-50 flex items-center gap-1 whitespace-nowrap"
                    >
                      <HiOutlinePaperAirplane className="w-3.5 h-3.5" />
                      {submittingId === t._id ? 'Enviando…' : 'Enviar a Meta'}
                    </button>
                  )}
                  <button onClick={() => setEditing(t)} className="p-2 text-slate-500 hover:text-emerald-600 bg-transparent border-none cursor-pointer">
                    <HiOutlinePencil />
                  </button>
                  <button onClick={() => remove(t._id)} className="p-2 text-slate-500 hover:text-red-600 bg-transparent border-none cursor-pointer">
                    <HiOutlineTrash />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Modal isOpen={!!editing} onClose={() => setEditing(null)} title={editing?._id ? 'Editar plantilla' : 'Nueva plantilla'} size="xl">
        {editing && (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-5">
              {/* Columna formulario */}
              <div className="grid gap-3 content-start">
              <label className="text-sm">
                <span className="text-slate-600">Nombre (sin espacios, minúsculas)</span>
                <input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  disabled={!!editing.metaTemplateId}
                  className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm disabled:bg-slate-50"
                  placeholder="recordatorio_cita"
                />
              </label>
              <div className="grid grid-cols-3 gap-2">
                <label className="text-sm">
                  <span className="text-slate-600">Canal</span>
                  <select value={editing.channel} onChange={(e) => setEditing({ ...editing, channel: e.target.value })} className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm">
                    <option value="whatsapp">WhatsApp</option>
                    <option value="email">Email</option>
                  </select>
                </label>
                <label className="text-sm">
                  <span className="text-slate-600">Idioma</span>
                  <input value={editing.language} onChange={(e) => setEditing({ ...editing, language: e.target.value })} className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm" />
                </label>
                <label className="text-sm">
                  <span className="text-slate-600">Categoría</span>
                  <select
                    value={editing.category}
                    onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                    disabled={!!editing.metaTemplateId}
                    className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm disabled:bg-slate-50"
                  >
                    {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.value}</option>)}
                  </select>
                </label>
              </div>
              {editing.channel === 'email' && (
                <label className="text-sm">
                  <span className="text-slate-600">Asunto</span>
                  <input value={editing.subject || ''} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" />
                </label>
              )}

              {/* Cabecera (solo WhatsApp) */}
              {editing.channel === 'whatsapp' && (
                <div className="border border-slate-100 rounded-lg p-3 bg-slate-50/60">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-semibold text-slate-500 uppercase">Cabecera</span>
                    <select
                      value={editing.headerType || 'none'}
                      onChange={(e) => setEditing({ ...editing, headerType: e.target.value })}
                      className="border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white"
                    >
                      <option value="none">Ninguna</option>
                      <option value="text">Texto</option>
                      <option value="image">Imagen</option>
                      <option value="document">Documento</option>
                    </select>
                  </div>
                  {editing.headerType === 'text' && (
                    <input
                      value={editing.headerText || ''}
                      onChange={(e) => setEditing({ ...editing, headerText: e.target.value })}
                      placeholder="Título de la cabecera"
                      className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                    />
                  )}
                  {(editing.headerType === 'image' || editing.headerType === 'document') && (
                    <div className="flex items-center gap-3">
                      {editing.headerMediaUrl ? (
                        <div className="relative">
                          <img src={editing.headerMediaUrl} alt="header" className="w-20 h-20 object-cover rounded-lg border border-slate-200" />
                          <button
                            type="button"
                            onClick={() => setEditing({ ...editing, headerMediaUrl: '' })}
                            className="absolute -top-1.5 -right-1.5 bg-white border border-slate-200 rounded-full p-0.5 cursor-pointer"
                            title="Quitar"
                          >
                            <HiOutlineXMark className="w-3.5 h-3.5 text-rose-500" />
                          </button>
                        </div>
                      ) : (
                        <div className="w-20 h-20 rounded-lg border border-dashed border-slate-300 flex items-center justify-center text-slate-300">
                          <HiOutlinePhoto className="w-7 h-7" />
                        </div>
                      )}
                      <div className="flex-1">
                        <label className="inline-flex items-center gap-1 px-3 py-1.5 border border-slate-200 rounded-lg text-xs bg-white cursor-pointer hover:border-emerald-400">
                          <HiOutlinePhoto className="w-4 h-4" /> {uploading ? 'Subiendo…' : 'Subir imagen'}
                          <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => uploadHeaderImage(e.target.files?.[0])} />
                        </label>
                        <input
                          value={editing.headerMediaUrl || ''}
                          onChange={(e) => setEditing({ ...editing, headerMediaUrl: e.target.value })}
                          placeholder="…o pega una URL pública"
                          className="w-full mt-1.5 border border-slate-200 rounded-lg px-2 py-1 text-xs"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              <label className="text-sm">
                <span className="text-slate-600">Cuerpo (usa variables como {'{{firstName}}'} o {'{{1}}'})</span>
                <textarea
                  value={editing.body}
                  onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                  rows={5}
                  className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                  placeholder="Hola {{firstName}}, te recordamos tu cita el {{1}}."
                />
              </label>
              <label className="text-sm">
                <span className="text-slate-600">Pie (opcional)</span>
                <input value={editing.footer || ''} onChange={(e) => setEditing({ ...editing, footer: e.target.value })} className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" />
              </label>

              {/* Botones (solo WhatsApp) */}
              {editing.channel === 'whatsapp' && (
                <div className="border border-slate-100 rounded-lg p-3 bg-slate-50/60">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-slate-500 uppercase">Botones (máx 3)</span>
                    {(editing.buttons || []).length < 3 && (
                      <button
                        type="button"
                        onClick={() => setEditing({ ...editing, buttons: [...(editing.buttons || []), { type: 'quick_reply', text: '', url: '' }] })}
                        className="text-xs text-emerald-700 bg-white border border-emerald-200 rounded-lg px-2 py-1 cursor-pointer flex items-center gap-1"
                      >
                        <HiOutlinePlus className="w-3.5 h-3.5" /> Añadir
                      </button>
                    )}
                  </div>
                  {(editing.buttons || []).length === 0 && <p className="text-xs text-slate-400">Sin botones.</p>}
                  <div className="grid gap-2">
                    {(editing.buttons || []).map((b, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <select
                          value={b.type}
                          onChange={(e) => setEditing({ ...editing, buttons: editing.buttons.map((x, j) => j === i ? { ...x, type: e.target.value } : x) })}
                          className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs bg-white"
                        >
                          {BUTTON_TYPES.map((bt) => <option key={bt.value} value={bt.value}>{bt.label}</option>)}
                        </select>
                        <input
                          value={b.text}
                          onChange={(e) => setEditing({ ...editing, buttons: editing.buttons.map((x, j) => j === i ? { ...x, text: e.target.value } : x) })}
                          placeholder="Texto del botón"
                          className="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-xs"
                        />
                        {(b.type === 'url' || b.type === 'phone') && (
                          <input
                            value={b.url}
                            onChange={(e) => setEditing({ ...editing, buttons: editing.buttons.map((x, j) => j === i ? { ...x, url: e.target.value } : x) })}
                            placeholder={b.type === 'url' ? 'https://…' : '+593…'}
                            className="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-xs"
                          />
                        )}
                        <button
                          type="button"
                          onClick={() => setEditing({ ...editing, buttons: editing.buttons.filter((_, j) => j !== i) })}
                          className="p-1 text-slate-400 hover:text-rose-500 bg-transparent border-none cursor-pointer"
                        >
                          <HiOutlineTrash className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {editing.metaTemplateId ? (
                <p className="text-xs text-amber-600">
                  Esta plantilla está ligada a Meta; el estado y la categoría los gobierna Meta y
                  se actualizan al sincronizar (no se pueden editar aquí).
                </p>
              ) : editing.channel === 'email' ? (
                <p className="text-xs text-slate-400">
                  Las plantillas de email quedan listas para usar de inmediato (no requieren
                  aprobación de Meta). Las URLs del cuerpo se rastrean (clics) y se mide la apertura.
                </p>
              ) : (
                <p className="text-xs text-slate-400">
                  Tras guardarla, pulsa <b>“Enviar a Meta”</b> en la lista para registrarla y que la
                  apruebe. Solo las aprobadas sirven fuera de la ventana de 24h.
                </p>
              )}
              </div>

              {/* Columna preview */}
              <div className="lg:sticky lg:top-0 h-max">
                <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Previsualización</p>
                <WhatsappPreview template={editing} />
                <p className="text-[11px] text-slate-400 mt-2">Así se verá aproximadamente en WhatsApp. Las variables {'{{...}}'} se rellenan al enviar.</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setEditing(null)} className="px-4 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer">Cancelar</button>
              <button onClick={save} className="px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm cursor-pointer border-none">Guardar</button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
