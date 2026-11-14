import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import {
  HiOutlineArrowDownTray, HiOutlineArrowUpTray, HiOutlinePlus, HiOutlineMagnifyingGlass,
  HiOutlineArrowTopRightOnSquare,
} from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';
import { downloadFile } from '../../utils/download';

/**
 * TOMA FÍSICA DESDE BODEGAS (nov-2026).
 *
 * Por bodega: se inicia una toma (congela lo que el sistema dice que hay), se descarga en Excel,
 * quien cuenta llena «Stock físico» y la sube. Aquí se ven los DOS inventarios lado a lado:
 * lo del sistema y lo contado, con la diferencia de cada producto.
 *
 * Confirmar la toma (ajustar el stock y generar el asiento) sigue siendo un paso aparte, en
 * Tomas físicas: es una decisión contable, no de quien cuenta.
 */

const FILTROS = [
  ['todos', 'Todos'],
  ['diferencia', 'Con diferencia'],
  ['contados', 'Contados'],
  ['pendientes', 'Sin contar'],
];

const estado = (it) => {
  if (!it.counted) return { label: 'SIN CONTAR', cls: 'text-slate-500 bg-slate-100' };
  if (!it.difference) return { label: 'CUADRA', cls: 'text-sky-700 bg-sky-50' };
  return it.difference > 0
    ? { label: 'SOBRANTE', cls: 'text-emerald-700 bg-emerald-50' }
    : { label: 'FALTANTE', cls: 'text-rose-700 bg-rose-50' };
};

export default function WarehouseCountPanel({ warehouses, initialWarehouse = '' }) {
  const activas = warehouses.filter((w) => w.active !== false);
  const [bodega, setBodega] = useState(initialWarehouse || '');
  const [counts, setCounts] = useState([]);
  const [tomaId, setTomaId] = useState('');
  const [filtro, setFiltro] = useState('todos');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [resumenCarga, setResumenCarga] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => { if (initialWarehouse) setBodega(initialWarehouse); }, [initialWarehouse]);
  useEffect(() => {
    if (!bodega && activas.length) setBodega((activas.find((w) => w.isMain) || activas[0])._id);
  }, [activas.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadCounts = async () => {
    try { const r = await api.get('/inventory-advanced/counts'); setCounts(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'No se pudieron cargar las tomas'); }
  };
  useEffect(() => { loadCounts(); }, []);

  const deLaBodega = useMemo(
    () => counts.filter((c) => String(c.warehouse?._id || c.warehouse) === String(bodega)),
    [counts, bodega],
  );
  // Al cambiar de bodega se abre su toma en curso (o la más reciente).
  useEffect(() => {
    const abierta = deLaBodega.find((c) => c.status === 'BORRADOR');
    setTomaId((abierta || deLaBodega[0])?._id || '');
    setResumenCarga(null);
  }, [bodega, counts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const toma = deLaBodega.find((c) => c._id === tomaId) || null;
  const enCurso = deLaBodega.find((c) => c.status === 'BORRADOR');
  const esBorrador = toma?.status === 'BORRADOR';
  const nombreBodega = activas.find((w) => w._id === bodega)?.name || warehouses.find((w) => w._id === bodega)?.name || '';

  const reemplazar = (doc) => setCounts((prev) => prev.map((c) => (c._id === doc._id ? doc : c)));

  const iniciar = async () => {
    if (!bodega || busy) return;
    setBusy(true);
    try {
      const r = await api.post('/inventory-advanced/counts', {
        warehouse: bodega, date: today(), description: `Toma física ${nombreBodega}`,
      });
      setCounts((prev) => [r.data, ...prev]);
      setTomaId(r.data._id);
      toast.success(`Toma ${r.data.code} iniciada: el stock del sistema quedó congelado.`);
    } catch (e) { toast.error(e.response?.data?.message || 'No se pudo iniciar la toma'); }
    finally { setBusy(false); }
  };

  const descargar = async () => {
    if (!toma) return;
    try {
      await downloadFile(`/inventory-advanced/counts/${toma._id}/sheet.xlsx`, {
        filename: `toma_${toma.code}_${(toma.warehouse?.code || 'bodega')}.xlsx`,
      });
    } catch (e) { toast.error(e.message); }
  };

  const subir = async (file) => {
    if (!file || !toma) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post(`/inventory-advanced/counts/${toma._id}/sheet`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      reemplazar(r.data.count);
      setResumenCarga(r.data.resumen);
      toast.success(`Conteo cargado: ${r.data.resumen.actualizados} producto(s) actualizados.`);
    } catch (e) { toast.error(e.response?.data?.message || 'No se pudo leer el Excel'); }
    finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const items = useMemo(() => toma?.items || [], [toma]);
  const totales = useMemo(() => {
    const contados = items.filter((it) => it.counted);
    const conDif = contados.filter((it) => Math.abs(it.difference || 0) > 0.00001);
    const suma = (rows, k) => +rows.reduce((s, it) => s + (Number(it[k]) || 0), 0).toFixed(4);
    return {
      productos: items.length,
      contados: contados.length,
      conDif: conDif.length,
      sistema: suma(items, 'systemQty'),
      fisico: suma(contados, 'countedQty'),
      sistemaContados: suma(contados, 'systemQty'),
      sobrantes: suma(conDif.filter((it) => it.difference > 0), 'difference'),
      faltantes: Math.abs(suma(conDif.filter((it) => it.difference < 0), 'difference')),
    };
  }, [items]);

  const visibles = useMemo(() => {
    const t = q.trim().toLowerCase();
    return items
      .filter((it) => {
        if (filtro === 'diferencia') return it.counted && Math.abs(it.difference || 0) > 0.00001;
        if (filtro === 'contados') return it.counted;
        if (filtro === 'pendientes') return !it.counted;
        return true;
      })
      .filter((it) => !t || `${it.productName} ${it.productCode} ${it.barcode || ''}`.toLowerCase().includes(t))
      .sort((a, b) => String(a.productName || '').localeCompare(String(b.productName || '')));
  }, [items, filtro, q]);

  return (
    <div className="space-y-3">
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-xs text-slate-500 mb-1">Bodega</span>
            <select value={bodega} onChange={(e) => setBodega(e.target.value)}
              className="border border-slate-200 rounded-xl px-3 py-2 min-w-[220px]">
              {activas.map((w) => <option key={w._id} value={w._id}>{w.code} — {w.name}</option>)}
            </select>
          </label>
          {deLaBodega.length > 0 && (
            <label className="text-sm">
              <span className="block text-xs text-slate-500 mb-1">Toma</span>
              <select value={tomaId} onChange={(e) => { setTomaId(e.target.value); setResumenCarga(null); }}
                className="border border-slate-200 rounded-xl px-3 py-2">
                {deLaBodega.map((c) => (
                  <option key={c._id} value={c._id}>{c.code} · {fmtDate(c.date)} · {c.status}</option>
                ))}
              </select>
            </label>
          )}
          <div className="flex flex-wrap gap-2 ml-auto">
            {!enCurso && (
              <button onClick={iniciar} disabled={busy || !bodega}
                className="px-4 py-2 bg-emerald-600 text-white rounded-xl flex items-center gap-2 disabled:opacity-50">
                <HiOutlinePlus /> Iniciar toma física
              </button>
            )}
            {toma && (
              <button onClick={descargar}
                className="px-4 py-2 bg-white border border-emerald-300 text-emerald-700 rounded-xl flex items-center gap-2">
                <HiOutlineArrowDownTray /> Descargar Excel
              </button>
            )}
            {esBorrador && (
              <>
                <input ref={fileRef} type="file" accept=".xlsx" className="hidden"
                  onChange={(e) => subir(e.target.files?.[0])} />
                <button onClick={() => fileRef.current?.click()} disabled={busy}
                  className="px-4 py-2 bg-sky-600 text-white rounded-xl flex items-center gap-2 disabled:opacity-50">
                  <HiOutlineArrowUpTray /> {busy ? 'Cargando…' : 'Subir Excel contado'}
                </button>
                <Link to={`/accounting/counts?id=${toma._id}`}
                  className="px-4 py-2 bg-slate-100 text-slate-700 rounded-xl flex items-center gap-2 no-underline">
                  <HiOutlineArrowTopRightOnSquare /> Revisar y confirmar
                </Link>
              </>
            )}
          </div>
        </div>
        <p className="text-xs text-slate-500">
          1) <b>Inicia la toma</b>: el sistema congela cuánto dice que hay en la bodega.
          2) <b>Descarga el Excel</b> y llena la columna amarilla «Stock físico» con lo que cuentas.
          3) <b>Súbelo</b>: aquí verás lo del sistema junto a lo contado.
          El stock no cambia hasta que contabilidad <b>confirme</b> la toma.
        </p>
      </div>

      {!toma && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-8 text-center text-slate-500 text-sm">
          {bodega ? 'Esta bodega no tiene tomas físicas. Inicia una para descargar el Excel.' : 'Elige una bodega.'}
        </div>
      )}

      {toma && (
        <>
          {resumenCarga && (
            <div className="bg-sky-50 border border-sky-200 rounded-xl p-3 text-xs text-sky-900 space-y-1">
              <p className="m-0"><b>{resumenCarga.actualizados}</b> producto(s) actualizados · <b>{resumenCarga.sinContar}</b> sin cantidad (no se tocaron).</p>
              {resumenCarga.noEncontrados.length > 0 && (
                <p className="m-0 text-amber-800">No están en esta toma: {resumenCarga.noEncontrados.slice(0, 15).join(', ')}{resumenCarga.noEncontrados.length > 15 ? '…' : ''}</p>
              )}
              {resumenCarga.invalidos.length > 0 && (
                <p className="m-0 text-rose-700">Cantidad no válida: {resumenCarga.invalidos.slice(0, 15).join(', ')}</p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tarjeta titulo="Inventario del sistema" valor={fmt(totales.sistema)} sub={`${totales.productos} productos`} />
            <Tarjeta titulo="Inventario físico" valor={fmt(totales.fisico)}
              sub={`${totales.contados} de ${totales.productos} contados (sistema: ${fmt(totales.sistemaContados)})`} />
            <Tarjeta titulo="Sobrantes" valor={fmt(totales.sobrantes)} cls="text-emerald-700" sub="unidades de más" />
            <Tarjeta titulo="Faltantes" valor={fmt(totales.faltantes)} cls="text-rose-700"
              sub={`${totales.conDif} producto(s) con diferencia`} />
          </div>

          <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 p-3 border-b border-slate-100">
              <div className="flex gap-1 bg-slate-100 rounded-lg p-0.5">
                {FILTROS.map(([k, l]) => (
                  <button key={k} onClick={() => setFiltro(k)}
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
              <span className="text-xs text-slate-500">{toma.code} · {fmtDate(toma.date)} · {toma.status}</span>
            </div>
            <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
              <table className="tbl tbl-cards text-sm">
                <thead className="bg-emerald-50 text-xs uppercase sticky top-0"><tr>
                  <th className="px-3 py-2 text-left">Código</th>
                  <th className="px-3 py-2 text-left">Producto</th>
                  <th className="px-3 py-2 text-right">Sistema</th>
                  <th className="px-3 py-2 text-right">Físico</th>
                  <th className="px-3 py-2 text-right">Diferencia</th>
                  <th className="px-3 py-2 text-left">Estado</th>
                  <th className="px-3 py-2 text-left">Observación</th>
                </tr></thead>
                <tbody>
                  {visibles.map((it) => {
                    const est = estado(it);
                    return (
                      <tr key={String(it.product)} className="border-t">
                        <td data-cell="Código" className="px-3 py-1.5 font-mono text-xs">{it.productCode}</td>
                        <td data-cell="Producto" className="px-3 py-1.5">{it.productName}</td>
                        <td data-cell="Sistema" className="px-3 py-1.5 text-right font-mono">{fmt(it.systemQty)}</td>
                        <td data-cell="Físico" className="px-3 py-1.5 text-right font-mono">{it.counted ? fmt(it.countedQty) : '—'}</td>
                        <td data-cell="Diferencia" className={`px-3 py-1.5 text-right font-mono ${it.difference > 0 ? 'text-emerald-700' : it.difference < 0 ? 'text-rose-600' : ''}`}>
                          {it.counted ? fmt(it.difference) : '—'}
                        </td>
                        <td data-cell="Estado" className="px-3 py-1.5">
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${est.cls}`}>{est.label}</span>
                        </td>
                        <td data-cell="Observación" className="px-3 py-1.5 text-xs text-slate-500">{it.notes || ''}</td>
                      </tr>
                    );
                  })}
                  {!visibles.length && (
                    <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">Sin productos en este filtro.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Tarjeta({ titulo, valor, sub, cls = 'text-slate-800' }) {
  return (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-3">
      <p className="text-[11px] uppercase text-slate-500 m-0">{titulo}</p>
      <p className={`text-xl font-bold font-mono m-0 ${cls}`}>{valor}</p>
      {sub && <p className="text-[11px] text-slate-500 m-0">{sub}</p>}
    </div>
  );
}
