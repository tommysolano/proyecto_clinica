import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { HiOutlineArchiveBox, HiOutlineArrowPath, HiOutlineMagnifyingGlass } from 'react-icons/hi2';
import api from '../api/axios';

/**
 * MI BODEGA (nov-2026). Para el usuario cuyo punto de emisión tiene bodega: su stock en tiempo
 * real (se refresca solo cada minuto) comparando lo que dice el SISTEMA con lo último contado en
 * la TOMA FÍSICA de esa bodega. Solo cantidades.
 */
const fmt = (n) => Number(n || 0).toLocaleString('es-EC', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
const fechaCorta = (d) => (d ? new Date(d).toLocaleDateString('es-EC', { timeZone: 'America/Guayaquil', day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
const hora = (d) => (d ? new Date(d).toLocaleTimeString('es-EC', { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const REFRESCO_MS = 60000;

const FILTROS = [
  ['todos', 'Todos'],
  ['con_stock', 'Con stock'],
  ['sin_stock', 'Sin stock'],
  ['diferencia', 'Con diferencia'],
  ['sin_contar', 'Sin toma física'],
];

export default function MiBodega() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [todos, setTodos] = useState(false);
  const [filtro, setFiltro] = useState('todos');
  const [q, setQ] = useState('');

  const cargar = useCallback(async (silencioso = false) => {
    if (!silencioso) setLoading(true);
    try {
      const r = await api.get('/transfer-requests/my-warehouse', { params: todos ? { todos: '1' } : {} });
      setData(r.data);
      setError('');
    } catch (e) {
      const msg = e.response?.data?.message || 'No se pudo cargar tu bodega';
      setError(msg);
      if (!silencioso) toast.error(msg);
    } finally {
      if (!silencioso) setLoading(false);
    }
  }, [todos]);

  useEffect(() => { cargar(); }, [cargar]);
  // Tiempo real: se refresca solo mientras la pestaña está visible.
  useEffect(() => {
    const id = setInterval(() => { if (document.visibilityState === 'visible') cargar(true); }, REFRESCO_MS);
    return () => clearInterval(id);
  }, [cargar]);

  const items = useMemo(() => data?.items || [], [data]);
  const visibles = useMemo(() => {
    const nq = norm(q);
    return items.filter((it) => {
      if (nq && !norm(`${it.code} ${it.name} ${it.category}`).includes(nq)) return false;
      if (filtro === 'con_stock') return it.sistema > 0;
      if (filtro === 'sin_stock') return it.sistema <= 0;
      if (filtro === 'diferencia') return it.diferencia != null && it.diferencia !== 0;
      if (filtro === 'sin_contar') return !it.fisico;
      return true;
    });
  }, [items, q, filtro]);

  const totales = useMemo(() => ({
    productos: items.filter((i) => i.sistema > 0).length,
    unidades: items.reduce((s, i) => s + (i.sistema > 0 ? i.sistema : 0), 0),
    conDif: items.filter((i) => i.diferencia != null && i.diferencia !== 0).length,
    sinContar: items.filter((i) => !i.fisico).length,
  }), [items]);

  if (error && !data) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineArchiveBox className="text-emerald-600" /> Mi bodega</h1>
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{error}</div>
      </div>
    );
  }

  const tarjeta = (label, valor, sub, color = 'text-slate-800') => (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{valor}</p>
      {sub && <p className="text-[11px] text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <HiOutlineArchiveBox className="text-emerald-600" /> Mi bodega
            {data?.bodega && (
              <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                {data.bodega.code ? `${data.bodega.code} — ` : ''}{data.bodega.name}
              </span>
            )}
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            {data?.punto && <>Punto {data.punto.serie}{data.punto.nombre ? ` · ${data.punto.nombre}` : ''} · </>}
            Actualizado {hora(data?.actualizado)} · se actualiza solo cada minuto
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/transfer-requests" className="px-4 py-2 bg-sky-50 text-sky-700 border border-sky-200 rounded-xl text-sm no-underline">Pedir traslado</Link>
          <button type="button" onClick={() => cargar()} disabled={loading} className="px-4 py-2 bg-emerald-600 text-white rounded-xl border-none cursor-pointer inline-flex items-center gap-2 disabled:opacity-50">
            <HiOutlineArrowPath className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Actualizar
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {tarjeta('Productos con stock', fmt(totales.productos))}
        {tarjeta('Unidades en el sistema', fmt(totales.unidades))}
        {tarjeta('Con diferencia', fmt(totales.conDif), 'sistema ≠ última toma física', totales.conDif ? 'text-rose-600' : 'text-slate-800')}
        {tarjeta('Sin toma física', fmt(totales.sinContar), 'nunca contados en esta bodega')}
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 p-3 border-b border-slate-100">
          <div className="flex gap-1 bg-slate-100 rounded-lg p-0.5 flex-wrap">
            {FILTROS.map(([k, l]) => (
              <button key={k} type="button" onClick={() => setFiltro(k)}
                className={`px-3 py-1 rounded-md text-xs border-none cursor-pointer ${filtro === k ? 'bg-white text-emerald-700 shadow-sm' : 'bg-transparent text-slate-500'}`}>
                {l}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
            <HiOutlineMagnifyingGlass className="w-4 h-4 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar producto o código…"
              className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
          </div>
          <label className="text-xs text-slate-600 flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={todos} onChange={(e) => setTodos(e.target.checked)} />
            Incluir productos del catálogo en cero
          </label>
        </div>
        <div className="overflow-x-auto max-h-[65vh] overflow-y-auto">
          <table className="tbl tbl-cards text-sm w-full">
            <thead className="bg-emerald-50 text-xs uppercase sticky top-0"><tr>
              <th className="px-3 py-2 text-left">Código</th>
              <th className="px-3 py-2 text-left">Producto</th>
              <th className="px-3 py-2 text-right">Sistema</th>
              <th className="px-3 py-2 text-right">Toma física</th>
              <th className="px-3 py-2 text-right">Diferencia</th>
              <th className="px-3 py-2 text-left">Última toma</th>
            </tr></thead>
            <tbody>
              {loading && !data ? (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Cargando…</td></tr>
              ) : visibles.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No hay productos para mostrar</td></tr>
              ) : visibles.map((it) => (
                <tr key={it.product} className="border-t">
                  <td data-cell="hora" className="px-3 py-1.5 font-mono text-xs text-slate-500">{it.code}</td>
                  <td data-cell="principal" className="px-3 py-1.5">
                    <span className="font-medium text-slate-800">{it.name}</span>
                    {it.category && <span className="block text-[11px] text-slate-400">{it.category}</span>}
                  </td>
                  <td data-cell="estado" className={`px-3 py-1.5 text-right font-mono font-semibold ${it.sistema > 0 ? 'text-slate-800' : 'text-rose-600'}`}>
                    <span className="md:hidden text-[11px] font-sans font-normal text-slate-400">Sistema </span>{fmt(it.sistema)}
                  </td>
                  <td data-cell="detalle" className="px-3 py-1.5 text-right font-mono">
                    <span className="md:hidden text-[11px] font-sans text-slate-400">Toma física </span>{it.fisico ? fmt(it.fisico.qty) : '—'}
                  </td>
                  <td data-cell="detalle" className={`px-3 py-1.5 text-right font-mono ${it.diferencia > 0 ? 'text-emerald-700' : it.diferencia < 0 ? 'text-rose-600' : 'text-slate-500'}`}>
                    <span className="md:hidden text-[11px] font-sans text-slate-400">Diferencia </span>
                    {it.diferencia == null ? '—' : `${it.diferencia > 0 ? '+' : ''}${fmt(it.diferencia)}`}
                  </td>
                  <td data-cell="detalle" className="px-3 py-1.5 text-xs text-slate-500">
                    {it.fisico
                      ? <>{it.fisico.code} · {fechaCorta(it.fisico.date)}{it.fisico.status === 'BORRADOR' ? ' · sin confirmar' : ''}</>
                      : 'Sin contar'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-slate-400 px-3 py-2 border-t border-slate-100">
          Sistema = lo que hay hoy según el kardex. Toma física = lo último contado en esta bodega (la diferencia es contado − sistema; desde esa toma pudo haber ventas o traslados).
        </p>
      </div>
    </div>
  );
}
