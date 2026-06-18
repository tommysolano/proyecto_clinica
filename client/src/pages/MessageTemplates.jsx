import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus,
  HiOutlinePencil,
  HiOutlineTrash,
  HiOutlineArrowPath,
  HiOutlineDocumentText,
} from 'react-icons/hi2';

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
  body: '',
  footer: '',
  subject: '',
});

export default function MessageTemplates() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/message-templates');
      setList(data);
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

  const sync = async () => {
    setSyncing(true);
    try {
      const { data } = await api.post('/message-templates/sync-whatsapp');
      toast.success(`Sincronizado: ${data.imported} importadas, ${data.updated} actualizadas`);
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

      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-auto">
            <h2 className="text-lg font-bold mb-4">{editing._id ? 'Editar plantilla' : 'Nueva plantilla'}</h2>
            <div className="grid gap-3">
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
                  <select value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })} className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm">
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
              {editing.metaTemplateId ? (
                <p className="text-xs text-amber-600">
                  Esta plantilla está ligada a Meta; el estado se gobierna por la sincronización.
                </p>
              ) : editing.channel === 'email' ? (
                <p className="text-xs text-slate-400">
                  Las plantillas de email quedan listas para usar de inmediato (no requieren
                  aprobación de Meta). Las URLs del cuerpo se rastrean (clics) y se mide la apertura.
                </p>
              ) : (
                <p className="text-xs text-slate-400">
                  Tras crearla deberás registrarla/aprobarla en Meta para usarla fuera de la ventana de 24h.
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setEditing(null)} className="px-4 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer">Cancelar</button>
              <button onClick={save} className="px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm cursor-pointer border-none">Guardar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
