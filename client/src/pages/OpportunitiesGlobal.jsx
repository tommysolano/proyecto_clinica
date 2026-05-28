import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineFunnel, HiOutlineMegaphone, HiOutlineMagnifyingGlass } from 'react-icons/hi2';
import ProductAutocomplete from '../components/ProductAutocomplete';

const STAGE_COLORS = {
  nuevo: 'bg-slate-100 text-slate-700',
  contactado: 'bg-blue-100 text-blue-700',
  interesado: 'bg-amber-100 text-amber-700',
  agendado: 'bg-indigo-100 text-indigo-700',
  ganado: 'bg-emerald-100 text-emerald-700',
  perdido: 'bg-red-100 text-red-700',
};

const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
};

export default function OpportunitiesGlobal() {
  const [list, setList] = useState([]);
  const [products, setProducts] = useState([]);
  const [filter, setFilter] = useState({ from: '', to: '', patient: '', service: '' });
  const [selected, setSelected] = useState(new Set());
  const [bulkBody, setBulkBody] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = {};
      if (filter.from) params.from = filter.from;
      if (filter.to) params.to = filter.to;
      if (filter.patient) params.patient = filter.patient;
      if (filter.service) params.service = filter.service;
      const r = await api.get('/chats/opportunities/all', { params });
      setList(r.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api.get('/products', { params: { limit: 500 } })
      .then((r) => {
        const arr = Array.isArray(r.data) ? r.data : r.data?.items || [];
        setProducts(arr);
      })
      .catch(() => {});
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(list.map((x) => x.conversationId)));
  const clearSel = () => setSelected(new Set());

  const sendBulk = async () => {
    if (selected.size === 0) return toast.error('Selecciona al menos una conversación');
    if (!bulkBody.trim()) return toast.error('Mensaje vacío');
    if (!window.confirm(`¿Enviar mensaje a ${selected.size} conversación(es)?`)) return;
    try {
      const r = await api.post('/chats/opportunities/bulk-whatsapp', {
        conversationIds: [...selected],
        body: bulkBody,
      });
      toast.success(`Enviado a ${r.data.sent} conversaciones`);
      setBulkBody('');
      setSelected(new Set());
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const totalValue = useMemo(
    () => list.reduce((s, x) => s + Number(x.expectedValue || 0), 0),
    [list]
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <HiOutlineMegaphone className="text-emerald-600" /> Oportunidades globales
        </h1>
        <div className="text-sm text-slate-600">
          Total: <b>{list.length}</b> · Valor: <b>${totalValue.toFixed(2)}</b>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-3 flex flex-wrap gap-3 items-end">
        <HiOutlineFunnel className="w-5 h-5 text-slate-500" />
        <label className="text-sm">Desde
          <input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })}
            className="block mt-1 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
        </label>
        <label className="text-sm">Hasta
          <input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })}
            className="block mt-1 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
        </label>
        <label className="text-sm flex-1 min-w-[180px]">Paciente
          <div className="relative mt-1">
            <HiOutlineMagnifyingGlass className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              value={filter.patient}
              onChange={(e) => setFilter({ ...filter, patient: e.target.value })}
              placeholder="Nombre o teléfono..."
              className="w-full pl-8 pr-2 py-1.5 border border-slate-200 rounded-lg text-sm"
            />
          </div>
        </label>
        <div className="text-sm flex-1 min-w-[200px]">
          <span>Servicio</span>
          <div className="mt-1">
            <ProductAutocomplete
              products={products}
              value={filter.service}
              onSelect={(p) => setFilter({ ...filter, service: p?._id || '' })}
              placeholder="Filtrar por servicio..."
            />
          </div>
        </div>
        <button
          onClick={load}
          className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm border-none cursor-pointer hover:bg-emerald-700"
        >Filtrar</button>
      </div>

      {/* Mensaje masivo */}
      <div className="bg-white rounded-xl border border-slate-200 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-700">
            Mensaje masivo por WhatsApp ({selected.size} seleccionada{selected.size !== 1 ? 's' : ''})
          </p>
          <div className="flex gap-2">
            <button onClick={selectAll} className="text-xs text-emerald-700 underline bg-transparent border-none cursor-pointer">
              Seleccionar todas
            </button>
            <button onClick={clearSel} className="text-xs text-slate-500 underline bg-transparent border-none cursor-pointer">
              Limpiar
            </button>
          </div>
        </div>
        <div className="flex gap-2">
          <textarea
            value={bulkBody}
            onChange={(e) => setBulkBody(e.target.value)}
            placeholder="Mensaje a enviar a las conversaciones seleccionadas..."
            rows={2}
            className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm resize-none"
          />
          <button
            onClick={sendBulk}
            disabled={selected.size === 0 || !bulkBody.trim()}
            className="px-4 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 text-sm cursor-pointer border-none"
          >
            Enviar masivo
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-3 py-2 w-8"></th>
              <th className="text-left px-3 py-2">Fecha</th>
              <th className="text-left px-3 py-2">Contacto / Paciente</th>
              <th className="text-left px-3 py-2">Etapa</th>
              <th className="text-left px-3 py-2">Servicios interés</th>
              <th className="text-right px-3 py-2">Valor</th>
              <th className="text-left px-3 py-2">Notas</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className="text-center py-6 text-slate-400">Cargando...</td></tr>
            )}
            {!loading && list.length === 0 && (
              <tr><td colSpan={7} className="text-center py-6 text-slate-400">Sin oportunidades.</td></tr>
            )}
            {list.map((o, i) => (
              <tr key={`${o.conversationId}-${i}`} className="border-t border-slate-100 hover:bg-slate-50/50">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selected.has(o.conversationId)}
                    onChange={() => toggle(o.conversationId)}
                    className="w-4 h-4 accent-emerald-600"
                  />
                </td>
                <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{fmtDate(o.createdAt)}</td>
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-800">
                    {o.patient ? `${o.patient.firstName} ${o.patient.lastName}` : (o.contactName || '—')}
                  </div>
                  <div className="text-xs text-slate-400">{o.phone}</div>
                </td>
                <td className="px-3 py-2">
                  <span className={`text-[11px] px-2 py-0.5 rounded ${STAGE_COLORS[o.stage] || STAGE_COLORS.nuevo}`}>
                    {o.stage}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-slate-700">
                  {(o.interestedIn || []).map((s) => s.name).filter(Boolean).join(', ') || '—'}
                </td>
                <td className="px-3 py-2 text-right text-emerald-700 font-semibold">
                  ${Number(o.expectedValue || 0).toFixed(2)}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500 italic">{o.notes || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
