import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineFunnel, HiOutlineMegaphone, HiOutlineMagnifyingGlass } from 'react-icons/hi2';
import ProductAutocomplete from '../components/ProductAutocomplete';
import { phoneMatches } from '../utils/phone';

const STAGE_COLORS = {
  nuevo: 'bg-slate-100 text-slate-700',
  contactado: 'bg-blue-100 text-blue-700',
  interesado: 'bg-amber-100 text-amber-700',
  agendado: 'bg-indigo-100 text-indigo-700',
  ganado: 'bg-emerald-100 text-emerald-700',
  perdido: 'bg-red-100 text-red-700',
};

const STAGES = ['nuevo', 'contactado', 'interesado', 'agendado', 'ganado', 'perdido'];

const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
};

export default function OpportunitiesGlobal() {
  const [list, setList] = useState([]);
  const [products, setProducts] = useState([]);
  const [filter, setFilter] = useState({ from: '', to: '', patient: '', service: '' });
  // Buscador INSTANTÁNEO sobre lo ya cargado (no vuelve al servidor): encuentra la
  // oportunidad por contacto, teléfono en cualquier formato, servicio o nota.
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState('');
  // Paginación de la tabla: 50 por página, o TODAS de un tirón (pageSize 0).
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(new Set());
  const [bulkBody, setBulkBody] = useState('');
  const [bulkResult, setBulkResult] = useState(null);
  const [loading, setLoading] = useState(false);

  // Cualquier cosa que cambie QUÉ filas se ven devuelve la tabla a la página 1:
  // si no, se quedaría en una página que ya no existe.
  const changeSearch = (v) => { setSearch(v); setPage(1); };
  const changeStage = (v) => { setStage(v); setPage(1); };
  const changePageSize = (v) => { setPageSize(v); setPage(1); };

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
      setPage(1);
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

  // Texto de una fila en el que busca el buscador. El teléfono va aparte porque
  // se compara por dígitos (0988535561 encuentra al 593988535561).
  const rowText = (o) => [
    o.patient ? `${o.patient.firstName || ''} ${o.patient.lastName || ''}` : '',
    o.contactName || '',
    o.stage || '',
    o.notes || '',
    o.adCampaign || '',
    (o.interestedIn || []).map((s) => s.name).join(' '),
  ].join(' ').toLowerCase();

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return list.filter((o) => {
      if (stage && o.stage !== stage) return false;
      if (!q) return true;
      return rowText(o).includes(q) || phoneMatches(q, [o.phone, o.patient?.phone, o.patient?.whatsapp]);
    });
  }, [list, search, stage]);

  // Página en pantalla. El recorte es DERIVADO (no hay estado que corregir): si
  // el filtro deja menos páginas que la página actual, se muestra la última.
  const totalPages = pageSize ? Math.max(1, Math.ceil(visible.length / pageSize)) : 1;
  const safePage = Math.min(page, totalPages);
  const pageStart = pageSize ? (safePage - 1) * pageSize : 0;
  const pageRows = pageSize ? visible.slice(pageStart, pageStart + pageSize) : visible;

  // Conversaciones (no filas): varias oportunidades pueden ser del mismo chat y el
  // envío masivo es por chat.
  const visibleIds = useMemo(
    () => [...new Set(visible.map((x) => x.conversationId))],
    [visible]
  );
  const pageIds = [...new Set(pageRows.map((x) => x.conversationId))];

  // Al filtrar, la selección se queda en lo que se VE: si no, se enviaría a
  // contactos que ya no están en pantalla.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const keep = new Set(visibleIds.filter((id) => prev.has(id)));
      return keep.size === prev.size ? prev : keep;
    });
  }, [visibleIds]);

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // La casilla de la cabecera manda sobre ESTA página (lo que se ve); para marcar
  // todas las páginas de una vez está el enlace del envío masivo.
  const pageAllSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const pageSomeSelected = !pageAllSelected && pageIds.some((id) => selected.has(id));

  const selectAll = () => setSelected(new Set(visibleIds));
  const clearSel = () => setSelected(new Set());
  const togglePage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      pageIds.forEach((id) => (pageAllSelected ? next.delete(id) : next.add(id)));
      return next;
    });
  };

  const sendBulk = async () => {
    if (selected.size === 0) return toast.error('Selecciona al menos una conversación');
    if (!bulkBody.trim()) return toast.error('Mensaje vacío');
    if (!window.confirm(`¿Enviar mensaje a ${selected.size} conversación(es)?`)) return;
    try {
      const r = await api.post('/chats/opportunities/bulk-whatsapp', {
        conversationIds: [...selected],
        body: bulkBody,
      });
      setBulkResult(r.data);
      toast.success(
        `Enviados: ${r.data.sent || 0} · Fallidos: ${r.data.failed || 0} · Omitidos: ${r.data.skipped || 0}`
      );
      setBulkBody('');
      setSelected(new Set());
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const totalValue = useMemo(
    () => visible.reduce((s, x) => s + Number(x.expectedValue || 0), 0),
    [visible]
  );
  const isFiltered = visible.length !== list.length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          <HiOutlineMegaphone className="text-emerald-600" /> Oportunidades globales
        </h1>
        <div className="text-sm text-slate-600">
          Total: <b>{visible.length}</b>{isFiltered && <span className="text-slate-400"> de {list.length}</span>}
          {' '}· Valor: <b>${totalValue.toFixed(2)}</b>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
        {/* Buscador de la propia lista: filtra al instante lo que ya está cargado. */}
        <div className="p-3 flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[240px]">
            <HiOutlineMagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              value={search}
              onChange={(e) => changeSearch(e.target.value)}
              placeholder="Buscar oportunidad: contacto, teléfono, servicio, etapa o nota..."
              className="w-full pl-9 pr-8 py-2 border border-slate-200 rounded-xl text-sm"
            />
            {search && (
              <button
                onClick={() => changeSearch('')}
                title="Limpiar búsqueda"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 bg-transparent border-none cursor-pointer text-lg leading-none"
              >×</button>
            )}
          </div>
          <select
            value={stage}
            onChange={(e) => changeStage(e.target.value)}
            className="border border-slate-200 rounded-xl px-2 py-2 text-sm"
            aria-label="Filtrar por etapa"
          >
            <option value="">Todas las etapas</option>
            {STAGES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          {(search || stage) && (
            <button
              onClick={() => { changeSearch(''); changeStage(''); }}
              className="text-xs text-slate-500 underline bg-transparent border-none cursor-pointer"
            >Quitar filtros</button>
          )}
        </div>

        {/* Filtros que se le piden al servidor (traen otras oportunidades). */}
        <div className="p-3 flex flex-wrap gap-3 items-end">
          <HiOutlineFunnel className="w-5 h-5 text-slate-500" />
          <label className="text-sm">Desde
            <input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })}
              className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" />
          </label>
          <label className="text-sm">Hasta
            <input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })}
              className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" />
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
            className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 text-sm border-none cursor-pointer hover:bg-emerald-700"
          >Filtrar</button>
        </div>
      </div>

      {/* Mensaje masivo */}
      <div className="bg-white rounded-xl border border-slate-200 p-3 space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-slate-700">
            Mensaje masivo por WhatsApp ({selected.size} seleccionada{selected.size !== 1 ? 's' : ''})
          </p>
          <div className="flex gap-2">
            <button
              onClick={selectAll}
              title="Marca todas las conversaciones del listado, de todas las páginas"
              className="text-xs text-emerald-700 underline bg-transparent border-none cursor-pointer"
            >
              Seleccionar todas{isFiltered ? ' las filtradas' : ''} ({visibleIds.length})
            </button>
            <button onClick={clearSel} className="text-xs text-slate-500 underline bg-transparent border-none cursor-pointer">
              Limpiar
            </button>
          </div>
        </div>
        <label className="sr-only" htmlFor="bulk-body">Mensaje masivo a enviar</label>
        <div className="flex gap-2">
          <textarea
            id="bulk-body"
            value={bulkBody}
            onChange={(e) => setBulkBody(e.target.value)}
            placeholder="Mensaje a enviar a las conversaciones seleccionadas..."
            rows={2}
            className="flex-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm resize-none"
          />
          <button
            onClick={sendBulk}
            disabled={selected.size === 0 || !bulkBody.trim()}
            className="px-4 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 hover:bg-emerald-700 disabled:opacity-50 text-sm cursor-pointer border-none"
          >
            Enviar masivo
          </button>
        </div>
        {bulkResult && (
          <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
            Resultado: <b>{bulkResult.sent || 0}</b> enviados, <b>{bulkResult.failed || 0}</b> fallidos,{' '}
            <b>{bulkResult.skipped || 0}</b> omitidos.
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="tbl">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              {/* Marca de un tirón las de ESTA página (el enlace de arriba marca todas). */}
              <th className="px-3 py-2 w-8">
                <input
                  type="checkbox"
                  checked={pageAllSelected}
                  ref={(el) => { if (el) el.indeterminate = pageSomeSelected; }}
                  onChange={togglePage}
                  disabled={pageIds.length === 0}
                  title={pageAllSelected
                    ? 'Quitar la selección de esta página'
                    : `Seleccionar las ${pageIds.length} de esta página`}
                  aria-label="Seleccionar las oportunidades de esta página"
                  className="w-4 h-4 accent-emerald-600"
                />
              </th>
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
            {!loading && visible.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center py-6 text-slate-400">
                  {list.length === 0 ? 'Sin oportunidades.' : 'Ninguna oportunidad coincide con la búsqueda.'}
                </td>
              </tr>
            )}
            {pageRows.map((o, i) => (
              <tr
                key={`${o.conversationId}-${i}`}
                className={`border-t border-slate-100 ${selected.has(o.conversationId) ? 'bg-emerald-50/60' : 'hover:bg-slate-50/50'}`}
              >
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
                  {(o.adCampaign || o.adId) && (
                    <div className="text-[10px] text-violet-700 mt-0.5">📣 {o.adCampaign || `Anuncio ${o.adId}`}</div>
                  )}
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

        {/* Paginación: 50 por página (o todas), con el rango que se está viendo. */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-t border-slate-100 text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <span>
              {visible.length === 0
                ? 'Sin resultados'
                : pageSize
                  ? `Mostrando ${pageStart + 1}–${pageStart + pageRows.length} de ${visible.length}`
                  : `Mostrando todas (${visible.length})`}
            </span>
            <select
              value={pageSize}
              onChange={(e) => changePageSize(Number(e.target.value))}
              className="border border-slate-200 rounded-lg px-2 py-1 text-xs bg-white"
              aria-label="Oportunidades por página"
            >
              <option value={50}>50 por página</option>
              <option value={100}>100 por página</option>
              <option value={200}>200 por página</option>
              <option value={0}>Mostrar todas</option>
            </select>
          </div>
          {pageSize > 0 && totalPages > 1 && (
            <div className="flex items-center gap-2">
              <span>Página {safePage} de {totalPages}</span>
              <div className="flex gap-1">
                <button
                  disabled={safePage <= 1}
                  onClick={() => setPage(safePage - 1)}
                  className="px-2.5 py-1 border border-slate-200 rounded-lg bg-white hover:bg-slate-50 cursor-pointer disabled:opacity-40 disabled:cursor-default"
                >
                  ◂ Anterior
                </button>
                <button
                  disabled={safePage >= totalPages}
                  onClick={() => setPage(safePage + 1)}
                  className="px-2.5 py-1 border border-slate-200 rounded-lg bg-white hover:bg-slate-50 cursor-pointer disabled:opacity-40 disabled:cursor-default"
                >
                  Siguiente ▸
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
