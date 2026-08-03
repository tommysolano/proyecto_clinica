import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import {
  HiOutlineTrash,
  HiOutlineArrowUturnLeft,
  HiOutlineArchiveBoxXMark,
  HiOutlineClock,
} from 'react-icons/hi2';
import { fmtDateTime } from '../utils/date';

const TABS = [
  { value: '', label: 'Todo' },
  { value: 'Workflow', label: 'Automatizaciones' },
  { value: 'MessageTemplate', label: 'Plantillas' },
  { value: 'SavedReply', label: 'Mensajes guardados' },
  { value: 'Segment', label: 'Segmentos' },
  { value: 'Contact', label: 'Contactos' },
];

function daysLeft(purgeAt) {
  const ms = new Date(purgeAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

export default function RecycleBin() {
  const [items, setItems] = useState([]);
  const [retentionDays, setRetentionDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/trash', { params: tab ? { entityType: tab } : {} });
      setItems(data.items || []);
      setRetentionDays(data.retentionDays || 30);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al cargar la papelera');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const counts = useMemo(() => {
    const m = {};
    items.forEach((it) => { m[it.entityType] = (m[it.entityType] || 0) + 1; });
    return m;
  }, [items]);

  const restore = async (item) => {
    setBusyId(item._id);
    try {
      await api.post(`/trash/${item._id}/restore`);
      toast.success(`"${item.label || item.entityLabel}" restaurado`);
      setItems((prev) => prev.filter((it) => it._id !== item._id));
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo restaurar');
    } finally {
      setBusyId(null);
    }
  };

  const purge = async (item) => {
    if (!window.confirm(`¿Eliminar definitivamente "${item.label || item.entityLabel}"?\n\nEsta acción NO se puede deshacer.`)) return;
    setBusyId(item._id);
    try {
      await api.delete(`/trash/${item._id}`);
      toast.success('Eliminado definitivamente');
      setItems((prev) => prev.filter((it) => it._id !== item._id));
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo eliminar');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <HiOutlineArchiveBoxXMark className="text-emerald-600" /> Papelera de reciclaje
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Todo lo que borres en Marketing/CRM (automatizaciones, plantillas, mensajes guardados,
          segmentos y contactos) queda aquí. Puedes restaurarlo o, pasados {retentionDays} días sin
          hacerlo, se elimina en firme de forma automática.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={`px-3 py-1.5 rounded-lg text-sm border cursor-pointer ${
              tab === t.value
                ? 'bg-emerald-600 border-emerald-600 text-white'
                : 'bg-white border-slate-200 text-slate-600 hover:border-emerald-300'
            }`}
          >
            {t.label}{t.value && counts[t.value] ? ` (${counts[t.value]})` : ''}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-slate-400">Cargando…</p>
      ) : items.length === 0 ? (
        <div className="text-center py-16 text-slate-400 border border-dashed border-slate-200 rounded-xl">
          La papelera está vacía.
        </div>
      ) : (
        <div className="grid gap-2">
          {items.map((it) => {
            const left = daysLeft(it.purgeAt);
            return (
              <div key={it._id} className="border border-slate-200 rounded-xl p-4 bg-white flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold truncate">{it.label || '(sin nombre)'}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">{it.entityLabel}</span>
                  </div>
                  <p className="text-xs text-slate-400 mt-1">
                    Eliminado el {fmtDateTime(it.createdAt)}{it.deletedByName ? ` por ${it.deletedByName}` : ''}
                  </p>
                  <p className={`text-xs mt-0.5 flex items-center gap-1 ${left <= 3 ? 'text-amber-600' : 'text-slate-400'}`}>
                    <HiOutlineClock className="w-3.5 h-3.5" />
                    {left > 0 ? `Se elimina en firme en ${left} día${left === 1 ? '' : 's'}` : 'Se elimina en firme muy pronto'}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => restore(it)}
                    disabled={busyId === it._id}
                    title="Restaurar"
                    className="px-3 py-1.5 text-xs bg-emerald-600 text-white rounded-lg cursor-pointer border-none disabled:opacity-50 flex items-center gap-1 whitespace-nowrap"
                  >
                    <HiOutlineArrowUturnLeft className="w-3.5 h-3.5" /> Restaurar
                  </button>
                  <button
                    onClick={() => purge(it)}
                    disabled={busyId === it._id}
                    title="Eliminar definitivamente"
                    className="p-2 text-slate-500 hover:text-red-600 bg-transparent border-none cursor-pointer disabled:opacity-50"
                  >
                    <HiOutlineTrash />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
