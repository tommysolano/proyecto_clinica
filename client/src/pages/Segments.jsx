import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import {
  HiOutlinePlus,
  HiOutlinePencil,
  HiOutlineTrash,
  HiOutlineUsers,
  HiOutlineFunnel,
} from 'react-icons/hi2';

const SOURCES = [
  { value: 'anuncio', label: 'Anuncio' },
  { value: 'referido', label: 'Referido' },
  { value: 'recepcion', label: 'Recepción' },
  { value: 'organico', label: 'Orgánico' },
];
const TREATMENT_STATUS = [
  { value: '', label: 'Cualquiera' },
  { value: 'activo', label: 'Activo' },
  { value: 'completado', label: 'Completado' },
  { value: 'abandonado', label: 'Abandonado' },
];

const blankFilters = () => ({
  sources: [],
  tags: [],
  gender: '',
  ageRange: { min: null, max: null },
  hasOptIn: 'whatsapp',
  zone: '',
  treatmentStatus: '',
  service: null,
  program: null,
  daysSinceLastVisit: null,
});

export default function Segments() {
  const [list, setList] = useState([]);
  const [products, setProducts] = useState([]);
  const [zones, setZones] = useState([]);
  const [editing, setEditing] = useState(null); // { _id?, name, description, filters }
  const [preview, setPreview] = useState(null); // { count, patients }
  const [previewing, setPreviewing] = useState(false);

  const load = async () => {
    try {
      const [segs, prods, zs] = await Promise.all([
        api.get('/segments'),
        api.get('/products').catch(() => ({ data: [] })),
        api.get('/marketing/guayaquil-zones').catch(() => ({ data: [] })),
      ]);
      setList(segs.data);
      setProducts(Array.isArray(prods.data) ? prods.data : prods.data?.items || []);
      setZones(zs.data || []);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al cargar segmentos');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openNew = () =>
    setEditing({ name: '', description: '', filters: blankFilters() }) || setPreview(null);
  const openEdit = (seg) => {
    setEditing({ ...seg, filters: { ...blankFilters(), ...(seg.filters || {}) } });
    setPreview(null);
  };

  const runPreview = async () => {
    setPreviewing(true);
    try {
      const { data } = await api.post('/segments/preview', { filters: editing.filters });
      setPreview(data);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al previsualizar');
    } finally {
      setPreviewing(false);
    }
  };

  const save = async () => {
    if (!editing.name.trim()) {
      toast.error('Ponle un nombre al segmento');
      return;
    }
    try {
      if (editing._id) {
        await api.put(`/segments/${editing._id}`, editing);
        toast.success('Segmento actualizado');
      } else {
        await api.post('/segments', editing);
        toast.success('Segmento creado');
      }
      setEditing(null);
      setPreview(null);
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al guardar');
    }
  };

  const remove = async (id) => {
    if (!window.confirm('¿Eliminar este segmento?')) return;
    try {
      await api.delete(`/segments/${id}`);
      toast.success('Eliminado');
      load();
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al eliminar');
    }
  };

  const f = editing?.filters;
  const setF = (patch) => setEditing({ ...editing, filters: { ...editing.filters, ...patch } });
  const services = products.filter((p) => p.category !== 'programa');
  const programs = products.filter((p) => p.category === 'programa');

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <HiOutlineFunnel className="text-emerald-600" /> Segmentos
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Listas inteligentes reutilizables para campañas. Se recalculan al usarlas.
          </p>
        </div>
        <button onClick={openNew} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm flex items-center gap-1 cursor-pointer border-none">
          <HiOutlinePlus /> Nuevo segmento
        </button>
      </div>

      <div className="grid gap-3">
        {list.length === 0 && (
          <div className="text-center py-16 text-slate-400 border border-dashed border-slate-200 rounded-xl">
            Aún no tienes segmentos guardados.
          </div>
        )}
        {list.map((s) => (
          <div key={s._id} className="border border-slate-200 rounded-xl p-4 bg-white flex justify-between gap-4">
            <div>
              <div className="font-semibold">{s.name}</div>
              {s.description && <div className="text-sm text-slate-500">{s.description}</div>}
              <div className="text-xs text-slate-400 mt-1">
                {[
                  s.filters?.sources?.length && `Fuente: ${s.filters.sources.join(', ')}`,
                  s.filters?.tags?.length && `Tags: ${s.filters.tags.join(', ')}`,
                  s.filters?.treatmentStatus && `Tratamiento: ${s.filters.treatmentStatus}`,
                  s.filters?.daysSinceLastVisit != null && `Inactivo ≥ ${s.filters.daysSinceLastVisit}d`,
                  s.filters?.hasOptIn && `Opt-in: ${s.filters.hasOptIn}`,
                ].filter(Boolean).join(' · ') || 'Sin filtros'}
              </div>
            </div>
            <div className="flex items-start gap-1 shrink-0">
              <button onClick={() => openEdit(s)} className="p-2 text-slate-500 hover:text-emerald-600 bg-transparent border-none cursor-pointer"><HiOutlinePencil /></button>
              <button onClick={() => remove(s._id)} className="p-2 text-slate-500 hover:text-red-600 bg-transparent border-none cursor-pointer"><HiOutlineTrash /></button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[92vh] overflow-auto">
            <h2 className="text-lg font-bold mb-4">{editing._id ? 'Editar segmento' : 'Nuevo segmento'}</h2>
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-2">
                <label className="text-sm">
                  <span className="text-slate-600">Nombre del segmento</span>
                  <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="ej. Inactivos 6 meses" className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" />
                </label>
                <label className="text-sm">
                  <span className="text-slate-600">Descripción (opcional)</span>
                  <input value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} placeholder="Para qué sirve este segmento" className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" />
                </label>
              </div>

              <div className="border-t border-slate-100 pt-3">
                <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Filtros</p>

                <div className="text-sm mb-2">
                  <span className="text-slate-600">Fuente</span>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {SOURCES.map((s) => {
                      const on = f.sources.includes(s.value);
                      return (
                        <button key={s.value} type="button"
                          onClick={() => setF({ sources: on ? f.sources.filter((x) => x !== s.value) : [...f.sources, s.value] })}
                          className={`px-3 py-1 rounded-full text-xs border cursor-pointer ${on ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>
                          {s.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <label className="text-sm block mb-2">
                  <span className="text-slate-600">Etiquetas (separadas por coma; deben estar todas)</span>
                  <input
                    value={f.tags.join(', ')}
                    onChange={(e) => setF({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
                    className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                    placeholder="ortodoncia, vip"
                  />
                </label>

                <div className="grid grid-cols-3 gap-2 mb-2">
                  <label className="text-sm">
                    <span className="text-slate-600">Género</span>
                    <select value={f.gender} onChange={(e) => setF({ gender: e.target.value })} className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm">
                      <option value="">Cualquiera</option>
                      <option value="femenino">Femenino</option>
                      <option value="masculino">Masculino</option>
                      <option value="otro">Otro</option>
                    </select>
                  </label>
                  <label className="text-sm">
                    <span className="text-slate-600">Edad mín.</span>
                    <input type="number" value={f.ageRange.min ?? ''} onChange={(e) => setF({ ageRange: { ...f.ageRange, min: e.target.value === '' ? null : Number(e.target.value) } })} className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm" />
                  </label>
                  <label className="text-sm">
                    <span className="text-slate-600">Edad máx.</span>
                    <input type="number" value={f.ageRange.max ?? ''} onChange={(e) => setF({ ageRange: { ...f.ageRange, max: e.target.value === '' ? null : Number(e.target.value) } })} className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm" />
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-2">
                  <label className="text-sm">
                    <span className="text-slate-600">Consentimiento</span>
                    <select value={f.hasOptIn} onChange={(e) => setF({ hasOptIn: e.target.value })} className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm">
                      <option value="">Sin filtrar</option>
                      <option value="whatsapp">Con opt-in WhatsApp</option>
                      <option value="email">Con opt-in Email</option>
                    </select>
                  </label>
                  <label className="text-sm">
                    <span className="text-slate-600">Zona (Guayaquil)</span>
                    <select value={f.zone} onChange={(e) => setF({ zone: e.target.value })} className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm">
                      <option value="">Cualquiera</option>
                      {zones.map((z) => <option key={z.name} value={z.name}>{z.name}</option>)}
                    </select>
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-2">
                  <label className="text-sm">
                    <span className="text-slate-600">Estado de tratamiento</span>
                    <select value={f.treatmentStatus} onChange={(e) => setF({ treatmentStatus: e.target.value })} className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm">
                      {TREATMENT_STATUS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </label>
                  <label className="text-sm">
                    <span className="text-slate-600">Inactivo ≥ N días</span>
                    <input type="number" value={f.daysSinceLastVisit ?? ''} onChange={(e) => setF({ daysSinceLastVisit: e.target.value === '' ? null : Number(e.target.value) })} className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm" placeholder="ej. 30" />
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="text-sm">
                    <span className="text-slate-600">Servicio contratado</span>
                    <select value={f.service || ''} onChange={(e) => setF({ service: e.target.value || null, program: null })} className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm">
                      <option value="">Cualquiera</option>
                      {services.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
                    </select>
                  </label>
                  <label className="text-sm">
                    <span className="text-slate-600">Programa</span>
                    <select value={f.program || ''} onChange={(e) => setF({ program: e.target.value || null, service: null })} className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-2 text-sm">
                      <option value="">Cualquiera</option>
                      {programs.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
                    </select>
                  </label>
                </div>
              </div>

              <div className="border-t border-slate-100 pt-3 flex items-center justify-between">
                <button onClick={runPreview} disabled={previewing} className="px-3 py-2 border border-emerald-200 text-emerald-700 rounded-lg text-sm flex items-center gap-1 bg-emerald-50 cursor-pointer disabled:opacity-50">
                  <HiOutlineUsers /> {previewing ? 'Calculando…' : 'Previsualizar'}
                </button>
                {preview && (
                  <span className="text-sm font-semibold text-emerald-700">{preview.count} paciente(s) coinciden</span>
                )}
              </div>
              {preview?.patients?.length ? (
                <div className="text-xs text-slate-500 max-h-32 overflow-auto border border-slate-100 rounded-lg p-2">
                  {preview.patients.slice(0, 20).map((p) => (
                    <div key={p._id} className="flex justify-between py-0.5">
                      <span>{p.name || '(sin nombre)'}</span>
                      <span className="text-slate-400">{p.whatsapp || p.phone || p.email || '—'}</span>
                    </div>
                  ))}
                  {preview.count > 20 && <div className="text-slate-400 pt-1">… y {preview.count - 20} más</div>}
                </div>
              ) : null}
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => { setEditing(null); setPreview(null); }} className="px-4 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer">Cancelar</button>
              <button onClick={save} className="px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm cursor-pointer border-none">Guardar segmento</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
