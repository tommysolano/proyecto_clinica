import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineArrowDownTray, HiOutlineMagnifyingGlass } from 'react-icons/hi2';
import DateInput from '../../components/DateInput';
import { downloadFile } from '../../utils/download';
import { fmt } from './_utils';

/**
 * MOVIMIENTO POR FECHAS (nov-2026). La hoja que el equipo llevaba a mano: un producto por fila
 * y una columna por fecha (día, semana o mes), ahora con LOS DOS inventarios en cada fecha:
 *   · Sistema — saldo del kardex al cierre de ese corte;
 *   · Físico  — lo contado en una toma física de ese período (vacío si no hubo toma).
 * Al final, entradas, salidas y número de movimientos del rango: ordenando por ellos se ve qué
 * rota mucho (hay que comprar más) y qué está quieto (hay que venderlo).
 */

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hace = (dias) => { const d = new Date(); d.setDate(d.getDate() - dias); return ymd(d); };

const ORDENES = [
  ['movimiento_desc', 'Más movimientos primero'],
  ['movimiento_asc', 'Menos movimientos primero'],
  ['salidas_desc', 'Más salidas (lo que más se vende/usa)'],
  ['salidas_asc', 'Menos salidas (lo que está quieto)'],
  ['nombre', 'Nombre'],
];

export default function StockHistoryPanel({ warehouses }) {
  const [filtros, setFiltros] = useState({
    warehouse: '', from: hace(56), to: ymd(new Date()), step: 'semana', orden: 'movimiento_desc', category: '',
  });
  const [q, setQ] = useState('');
  const [categorias, setCategorias] = useState([]);
  const [datos, setDatos] = useState(null);
  // Para qué filtros es la última respuesta: mientras no coincida con los actuales, está cargando.
  const [listoPara, setListoPara] = useState('');
  const [soloDiferencias, setSoloDiferencias] = useState(false);

  useEffect(() => {
    api.get('/inventory-advanced/categories', { params: { kind: 'INVENTARIO', catalog: 'company' } })
      .then((r) => setCategorias((r.data || []).filter((c) => c.active !== false))).catch(() => {});
  }, []);

  const params = useMemo(() => ({
    ...Object.fromEntries(Object.entries(filtros).filter(([, v]) => v)),
  }), [filtros]);

  const clave = JSON.stringify(params);
  const cargando = listoPara !== clave;
  useEffect(() => {
    let vivo = true;
    api.get('/inventory-advanced/stock-history', { params })
      .then((r) => { if (vivo) setDatos(r.data); })
      .catch((e) => { if (vivo) { setDatos(null); toast.error(e.response?.data?.message || 'No se pudo calcular el movimiento'); } })
      .finally(() => { if (vivo) setListoPara(JSON.stringify(params)); });
    return () => { vivo = false; };
  }, [params]);

  const set = (k, v) => setFiltros((f) => ({ ...f, [k]: v }));

  const filas = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (datos?.filas || [])
      .filter((f) => !t || `${f.product.name} ${f.product.code}`.toLowerCase().includes(t))
      .filter((f) => !soloDiferencias || f.fisico.some((x, i) => x !== null && Math.abs(x - f.sistema[i]) > 0.0001));
  }, [datos, q, soloDiferencias]);

  const descargar = async () => {
    try {
      await downloadFile('/inventory-advanced/stock-history', {
        params: { ...params, format: 'xlsx' },
        filename: `movimiento_por_fechas_${filtros.from}_${filtros.to}.xlsx`,
      });
    } catch (e) { toast.error(e.message); }
  };

  const cortes = datos?.cortes || [];

  return (
    <div className="space-y-3">
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4 space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-sm">
          <label>
            <span className="block text-xs text-slate-500 mb-1">Bodega</span>
            <select value={filtros.warehouse} onChange={(e) => set('warehouse', e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2">
              <option value="">Todas (consolidado)</option>
              {warehouses.filter((w) => w.active !== false).map((w) => <option key={w._id} value={w._id}>{w.code} — {w.name}</option>)}
            </select>
          </label>
          <label>
            <span className="block text-xs text-slate-500 mb-1">Desde</span>
            <DateInput value={filtros.from} onChange={(e) => set('from', e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2" />
          </label>
          <label>
            <span className="block text-xs text-slate-500 mb-1">Hasta</span>
            <DateInput value={filtros.to} onChange={(e) => set('to', e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2" />
          </label>
          <label>
            <span className="block text-xs text-slate-500 mb-1">Ver por</span>
            <select value={filtros.step} onChange={(e) => set('step', e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2">
              <option value="dia">Día</option>
              <option value="semana">Semana</option>
              <option value="mes">Mes</option>
            </select>
          </label>
          <label>
            <span className="block text-xs text-slate-500 mb-1">Categoría</span>
            <select value={filtros.category} onChange={(e) => set('category', e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2">
              <option value="">Todas</option>
              {categorias.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
            </select>
          </label>
          <label>
            <span className="block text-xs text-slate-500 mb-1">Ordenar por</span>
            <select value={filtros.orden} onChange={(e) => set('orden', e.target.value)} className="w-full border border-slate-200 rounded-xl px-3 py-2">
              {ORDENES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[220px] flex items-center gap-2 border border-slate-200 rounded-lg px-3 py-1.5">
            <HiOutlineMagnifyingGlass className="w-4 h-4 text-slate-400" />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar ítem por nombre o código…"
              className="flex-1 min-w-0 border-none outline-none text-sm bg-transparent" />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
            <input type="checkbox" checked={soloDiferencias} onChange={(e) => setSoloDiferencias(e.target.checked)} />
            Solo con diferencia entre sistema y físico
          </label>
          <span className="text-xs text-slate-500">{filas.length} ítem(s)</span>
          <button type="button" onClick={descargar}
            className="px-4 py-2 bg-white border border-emerald-300 text-emerald-700 rounded-xl flex items-center gap-2 cursor-pointer">
            <HiOutlineArrowDownTray /> Excel
          </button>
        </div>
        <p className="text-[11px] text-slate-500 m-0">
          En cada fecha: <b>S</b> = lo que dice el sistema al cierre de ese día/semana/mes · <b>F</b> = lo contado en una toma física de ese período
          (en rojo si no coincide). «Movs.» cuenta las entradas y salidas del rango: ordénalo para ver qué rota más y qué está quieto.
        </p>
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
        <div className="overflow-auto max-h-[65vh]">
          <table className="text-xs border-collapse min-w-full">
            <thead className="bg-emerald-50 sticky top-0 z-10">
              <tr>
                <th rowSpan={2} className="px-2 py-2 text-left sticky left-0 bg-emerald-50 min-w-[90px]">Código</th>
                <th rowSpan={2} className="px-2 py-2 text-left sticky left-[90px] bg-emerald-50 min-w-[220px]">Producto</th>
                {cortes.map((c) => (
                  <th key={c.label} colSpan={2} className="px-2 py-1 text-center border-l border-emerald-100 whitespace-nowrap">{c.label}</th>
                ))}
                <th rowSpan={2} className="px-2 py-2 text-right border-l border-emerald-100">Entradas</th>
                <th rowSpan={2} className="px-2 py-2 text-right">Salidas</th>
                <th rowSpan={2} className="px-2 py-2 text-right">Movs.</th>
              </tr>
              <tr>
                {cortes.map((c) => [
                  <th key={`${c.label}s`} className="px-2 py-1 text-right font-medium text-slate-500 border-l border-emerald-100">S</th>,
                  <th key={`${c.label}f`} className="px-2 py-1 text-right font-medium text-slate-500">F</th>,
                ])}
              </tr>
            </thead>
            <tbody>
              {cargando && <tr><td colSpan={cortes.length * 2 + 5} className="px-3 py-6 text-center text-slate-500">Calculando…</td></tr>}
              {!cargando && filas.length === 0 && (
                <tr><td colSpan={cortes.length * 2 + 5} className="px-3 py-6 text-center text-slate-500">Sin ítems para estos filtros.</td></tr>
              )}
              {!cargando && filas.map((f) => (
                <tr key={f.product._id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-2 py-1.5 font-mono sticky left-0 bg-white">{f.product.code}</td>
                  <td className="px-2 py-1.5 sticky left-[90px] bg-white">{f.product.name}</td>
                  {f.sistema.map((s, i) => {
                    const fis = f.fisico[i];
                    const dif = fis !== null && Math.abs(fis - s) > 0.0001;
                    return [
                      <td key={`s${i}`} className={`px-2 py-1.5 text-right font-mono border-l border-slate-100 ${s < 0 ? 'text-rose-700' : ''}`}>{fmt(s)}</td>,
                      <td key={`f${i}`} className={`px-2 py-1.5 text-right font-mono ${dif ? 'text-rose-700 font-semibold bg-rose-50' : 'text-slate-500'}`}>
                        {fis === null ? '' : fmt(fis)}
                      </td>,
                    ];
                  })}
                  <td className="px-2 py-1.5 text-right font-mono border-l border-slate-100 text-emerald-700">{fmt(f.entradas)}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-rose-700">{fmt(f.salidas)}</td>
                  <td className="px-2 py-1.5 text-right font-mono font-semibold">{f.movimientos}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
