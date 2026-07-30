import { useEffect, useRef, useState } from 'react';
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
  HiOutlineArrowUpTray,
} from 'react-icons/hi2';
import Modal from '../components/Modal';
import WhatsappPreview from '../components/WhatsappPreview';
import BulkUploadModal from '../components/BulkUploadModal';
import { fmtDateTime } from '../utils/date';

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

// Variables que el sistema sabe rellenar por su NOMBRE al enviar. Las de
// "Paciente" se rellenan siempre; las de "Cita" usan la cita real cuando el
// envío viene de un workflow de citas (recordatorio/confirmación) — en
// campañas sin cita se usa el ejemplo.
const VARIABLE_CATALOG = [
  { key: 'nombre', label: 'Nombre', example: 'María', group: 'Paciente', hint: 'Nombre del paciente. Se rellena automáticamente en todos los envíos.' },
  { key: 'apellido', label: 'Apellido', example: 'Pérez', group: 'Paciente', hint: 'Apellido del paciente.' },
  { key: 'servicio', label: 'Servicio', example: 'Limpieza facial', group: 'Cita', hint: 'Servicio(s) de la cita.' },
  { key: 'fecha', label: 'Fecha de la cita', example: 'lunes 20 de julio', group: 'Cita', hint: 'Fecha de la cita, en palabras.' },
  { key: 'hora', label: 'Hora de la cita', example: '14:30', group: 'Cita', hint: 'Hora de inicio de la cita.' },
  { key: 'doctor', label: 'Doctor', example: 'Dra. Salazar', group: 'Cita', hint: 'Profesional asignado a la cita.' },
  { key: 'sede', label: 'Sede', example: 'Sede Norte', group: 'Cita', hint: 'Sucursal donde es la cita.' },
];

// Datos de ejemplo para la previsualización (así el usuario ve el mensaje "real").
const SAMPLE_VARS = Object.fromEntries(VARIABLE_CATALOG.map((v) => [v.key, v.example]));

// Documenta TODAS las variables de la plantilla (cabecera + cuerpo + pie) con su
// ejemplo del catálogo: Meta exige un ejemplo por variable al registrar (para la
// cabecera y el cuerpo) y con ejemplos realistas aprueba mejor.
const varsFromTemplate = (t = {}) => {
  const text = `${t.headerText || ''} ${t.body || ''} ${t.footer || ''}`;
  const keys = [];
  for (const m of String(text).matchAll(/\{\{\s*([\w]+)\s*\}\}/g)) {
    if (!keys.includes(m[1])) keys.push(m[1]);
  }
  return keys.map((k) => ({ key: k, example: VARIABLE_CATALOG.find((v) => v.key === k)?.example || '' }));
};

// Nº de variables DISTINTAS en un texto (para el tope de 1 en la cabecera de Meta).
const countVars = (text = '') =>
  new Set([...String(text).matchAll(/\{\{\s*([\w]+)\s*\}\}/g)].map((m) => m[1])).size;

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
  const [bulkOpen, setBulkOpen] = useState(false);
  const bodyRef = useRef(null);
  const headerRef = useRef(null);
  const footerRef = useRef(null);
  // Campo donde caerá la próxima variable: el último que el usuario tocó.
  const focusRef = useRef('body');
  const [focusField, setFocusField] = useState('body');

  // Config de cada campo insertable: su ref (para el cursor) y cómo leer/escribir
  // su texto dentro de `editing`. Así una sola función inserta en cabecera/cuerpo/pie.
  const FIELD_META = {
    header: { label: 'Cabecera', el: () => headerRef.current, get: (p) => p.headerText || '', set: (p, v) => ({ ...p, headerText: v }) },
    body: { label: 'Cuerpo', el: () => bodyRef.current, get: (p) => p.body || '', set: (p, v) => ({ ...p, body: v }) },
    footer: { label: 'Pie', el: () => footerRef.current, get: (p) => p.footer || '', set: (p, v) => ({ ...p, footer: v }) },
  };

  const focusOn = (field) => { focusRef.current = field; setFocusField(field); };

  // Inserta {{variable}} en el campo enfocado (cabecera/cuerpo/pie), donde esté el cursor.
  const insertVariable = (key) => {
    const field = FIELD_META[focusRef.current] ? focusRef.current : 'body';
    const meta = FIELD_META[field];
    const token = `{{${key}}}`;
    const el = meta.el();
    setEditing((prev) => {
      const text = meta.get(prev);
      // Meta admite SOLO 1 variable en la cabecera: no dejar meter una segunda distinta.
      if (field === 'header') {
        const already = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`).test(text);
        if (countVars(text) >= 1 && !already) {
          toast.error('Meta permite solo 1 variable en la cabecera');
          return prev;
        }
      }
      const start = el?.selectionStart ?? text.length;
      const end = el?.selectionEnd ?? start;
      if (el) {
        requestAnimationFrame(() => {
          el.focus();
          const pos = start + token.length;
          el.setSelectionRange(pos, pos);
        });
      }
      return meta.set(prev, text.slice(0, start) + token + text.slice(end));
    });
  };

  const uploadHeaderImage = async (file) => {
    if (!file) return;
    if (!/^image\/(png|jpe?g)$/.test(file.type)) {
      toast.error('Usa JPG o PNG: Meta no acepta otros formatos en plantillas');
      return;
    }
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
  // Marca de la última verificación contra Meta (sondeo horario / chequeo diario /
  // botón Sincronizar). Se muestra bajo el título.
  const [checkStatus, setCheckStatus] = useState(null);

  const loadAlerts = async () => {
    try {
      const { data } = await api.get('/message-templates/alerts', { params: { unread: true } });
      setAlerts(data || []);
    } catch {
      /* noop */
    }
    try {
      const { data } = await api.get('/message-templates/check-status');
      setCheckStatus(data || null);
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
      // Documentar TODAS las variables (cabecera + cuerpo) con ejemplos (Meta los exige).
      const payload = { ...editing, variables: varsFromTemplate(editing) };
      if (editing._id) {
        await api.put(`/message-templates/${editing._id}`, payload);
        toast.success('Plantilla actualizada');
      } else {
        await api.post('/message-templates', payload);
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
          {/* Prueba de que el sistema sigue vigilando: el estado se revisa cada hora
              y, a hora fija, una vez al día. Si dejara de verificar, se ve aquí. */}
          {checkStatus?.at && (
            <p className={`text-xs mt-1 ${checkStatus.ok ? 'text-slate-400' : 'text-amber-600'}`}>
              {checkStatus.ok
                ? `Estado verificado con Meta el ${fmtDateTime(checkStatus.at)}`
                : `Última verificación (${fmtDateTime(checkStatus.at)}) falló: ${checkStatus.error}`}
            </p>
          )}
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
            onClick={() => setBulkOpen(true)}
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm flex items-center gap-1 bg-white cursor-pointer"
          >
            <HiOutlineArrowUpTray /> Carga masiva
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

      <BulkUploadModal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title="Carga masiva de plantillas"
        description="Sube muchas plantillas de una vez. Se crean como BORRADOR; luego las revisas y las envías a Meta una por una."
        steps={['Cada plantilla creada queda en borrador hasta que pulses “Enviar a Meta”.']}
        templateUrl="/message-templates/bulk/template"
        templateFilename="plantilla_plantillas_whatsapp.xlsx"
        uploadUrl="/message-templates/bulk"
        onImported={load}
      />

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
                    <>
                      <input
                        ref={headerRef}
                        value={editing.headerText || ''}
                        onChange={(e) => setEditing({ ...editing, headerText: e.target.value })}
                        onFocus={() => focusOn('header')}
                        placeholder="Título de la cabecera (p. ej. Hola {{nombre}})"
                        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
                      />
                      <p className="text-[10px] text-slate-400 mt-1">
                        Puedes usar <b>1 variable</b> aquí (es el máximo que permite Meta en la cabecera).
                        Selecciona este campo y pulsa una variable abajo.
                      </p>
                    </>
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
                          <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => uploadHeaderImage(e.target.files?.[0])} />
                        </label>
                        <p className="text-[10px] text-slate-400 mt-1">JPG o PNG, máx. ~1.8 MB (Meta no acepta WEBP).</p>
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
                <span className="text-slate-600">Cuerpo</span>
                <textarea
                  ref={bodyRef}
                  value={editing.body}
                  onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                  onFocus={() => focusOn('body')}
                  rows={5}
                  className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                  placeholder="Hola {{nombre}}, te recordamos tu cita de {{servicio}} el {{fecha}} a las {{hora}}."
                />
              </label>

              {/* Insertador de variables: un clic en vez de escribir {{...}} a mano.
                  Cae en el campo que tengas seleccionado (cabecera / cuerpo / pie). */}
              {editing.channel === 'whatsapp' && (
                <div className="border border-emerald-100 rounded-lg p-3 bg-emerald-50/40 -mt-1">
                  <p className="text-[11px] font-semibold text-slate-500 uppercase mb-1.5">
                    Insertar variable en: <span className="text-emerald-700">{FIELD_META[focusField]?.label || 'Cuerpo'}</span>
                    <span className="text-slate-400 normal-case font-normal"> (haz clic en cabecera, cuerpo o pie para cambiar dónde)</span>
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {VARIABLE_CATALOG.map((v) => (
                      <button
                        key={v.key}
                        type="button"
                        onClick={() => insertVariable(v.key)}
                        title={`${v.hint} Ejemplo: "${v.example}".`}
                        className={`text-[11px] px-2 py-1 rounded-full border cursor-pointer ${
                          v.group === 'Cita'
                            ? 'bg-sky-50 border-sky-200 text-sky-700 hover:bg-sky-100'
                            : 'bg-white border-emerald-200 text-emerald-700 hover:bg-emerald-50'
                        }`}
                      >
                        + {v.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1.5">
                    <b>Nombre/Apellido</b> se rellenan siempre con los datos del paciente. Las{' '}
                    <b className="text-sky-600">de cita</b> (servicio, fecha, hora, doctor, sede) se
                    rellenan con la cita real cuando la plantilla se envía desde un workflow de citas
                    (p. ej. recordatorio); en campañas sin cita se usa el ejemplo. Al registrarla en
                    Meta se convierten a {'{{1}}, {{2}}…'} automáticamente.
                  </p>
                  <p className="text-[11px] text-slate-400 mt-1">
                    Meta admite variables en la <b>cabecera</b> (1) y el <b>cuerpo</b> (varias), pero{' '}
                    <b>no en el pie</b>.
                  </p>
                </div>
              )}
              <label className="text-sm">
                <span className="text-slate-600">Pie (opcional)</span>
                <input
                  ref={footerRef}
                  value={editing.footer || ''}
                  onChange={(e) => setEditing({ ...editing, footer: e.target.value })}
                  onFocus={() => focusOn('footer')}
                  className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                />
                {editing.channel === 'whatsapp' && countVars(editing.footer) > 0 && (
                  <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mt-1 flex items-start gap-1">
                    <HiOutlineExclamationTriangle className="w-4 h-4 shrink-0 mt-px" />
                    <span>
                      Meta <b>no permite variables en el pie</b>: una plantilla con variable aquí será
                      rechazada. Para personalizar, usa la <b>cabecera</b> (1 variable) o el <b>cuerpo</b>.
                    </span>
                  </p>
                )}
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
                <WhatsappPreview template={editing} sampleVars={SAMPLE_VARS} />
                <p className="text-[11px] text-slate-400 mt-2">
                  Así se verá aproximadamente en WhatsApp, con datos de ejemplo en las variables
                  (al enviar se usan los datos reales del paciente/cita).
                </p>
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
