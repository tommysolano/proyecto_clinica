import { useEffect, useState, useMemo } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import JournalEntryViewModal from '../../components/JournalEntryViewModal';
import {
  HiOutlinePlus, HiOutlineClipboardDocumentCheck, HiOutlineCheck, HiOutlineDocumentText,
  HiOutlineMagnifyingGlass,
} from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';
import NumericInput from '../../components/NumericInput';
import DateInput from '../../components/DateInput';

/**
 * TOMA FÍSICA de UNA bodega.
 *
 * La bodega es obligatoria: una toma sin bodega ajustaba el stock global y creaba capas sin
 * bodega (corrompía las existencias). El "Stock del sistema" que se ve aquí es un SNAPSHOT del
 * momento en que se inició la toma —de esa bodega y al costo real de sus capas—: aunque después
 * cambien el producto, su categoría o su stock, la toma no se mueve.
 *
 * Los costos solo llegan si el rol puede verlos (el backend los omite; no se ocultan en React).
 */

const ESTADO_DIF = (d) => {
  if (!d) return { label: 'SIN DIFERENCIA', cls: 'text-slate-500 bg-slate-100' };
  return d > 0
    ? { label: 'SOBRANTE', cls: 'text-emerald-700 bg-emerald-50' }
    : { label: 'FALTANTE', cls: 'text-rose-700 bg-rose-50' };
};

export default function PhysicalCounts() {
  const [list, setList] = useState([]);
  const [show, setShow] = useState(false);
  const [warehouses, setWarehouses] = useState([]);
  const [categories, setCategories] = useState([]);
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({
    warehouse: '', category: '', date: today(), responsible: '', description: '', notes: '',
  });
  const [busqueda, setBusqueda] = useState('');
  const [viewEntry, setViewEntry] = useState(null);
  const [confirmar, setConfirmar] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try { const r = await api.get('/inventory-advanced/counts'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    api.get('/inventory-advanced/warehouses').then((r) => setWarehouses(r.data || [])).catch(() => {});
    api.get('/inventory-advanced/categories', { params: { kind: 'INVENTARIO' } })
      .then((r) => setCategories(r.data || [])).catch(() => {});
    api.get('/users').then((r) => setUsers(r.data?.items || r.data || [])).catch(() => {});
    load();
  }, []);

  const conCostos = selected ? !selected.costsHidden : true;
  const bodega = warehouses.find((w) => w._id === form.warehouse);

  const start = async (e) => {
    e.preventDefault();
    if (!form.warehouse) { toast.error('La bodega es obligatoria: una toma física es de UNA bodega.'); return; }
    setBusy(true);
    try {
      const r = await api.post('/inventory-advanced/counts', form);
      toast.success('Toma iniciada. El stock del sistema quedó congelado (snapshot).');
      setShow(false);
      setSelected(r.data);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    } finally { setBusy(false); }
  };

  const setCounted = (productId, qty) => {
    const items = selected.items.map((it) => {
      if (String(it.product) !== String(productId)) return it;
      const contado = qty === '' ? 0 : Number(qty);
      const difference = +(contado - (it.systemQty || 0)).toFixed(4);
      return {
        ...it,
        countedQty: contado,
        counted: true,
        difference,
        adjustmentValue: it.unitCost != null ? +(difference * it.unitCost).toFixed(2) : null,
      };
    });
    setSelected({ ...selected, items });
  };

  const guardar = async () => {
    try {
      const r = await api.put(`/inventory-advanced/counts/${selected._id}`, {
        items: selected.items.map((it) => ({
          product: it.product, countedQty: it.countedQty, counted: it.counted, notes: it.notes,
        })),
      });
      setSelected(r.data);
      toast.success('Conteo guardado');
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  /** Resumen que se muestra ANTES de confirmar: nadie ajusta el inventario a ciegas. */
  const resumen = useMemo(() => {
    if (!selected) return null;
    const conDif = (selected.items || []).filter((it) => Math.abs(it.difference || 0) > 0.00001);
    const sobrantes = conDif.filter((it) => it.difference > 0);
    const faltantes = conDif.filter((it) => it.difference < 0);
    const valor = (rows) => rows.reduce((s, it) => s + Math.abs(Number(it.adjustmentValue) || 0), 0);
    return {
      conDif: conDif.length,
      unidadesSobrantes: +sobrantes.reduce((s, it) => s + it.difference, 0).toFixed(4),
      unidadesFaltantes: +Math.abs(faltantes.reduce((s, it) => s + it.difference, 0)).toFixed(4),
      valorSobrantes: conCostos ? valor(sobrantes) : null,
      valorFaltantes: conCostos ? valor(faltantes) : null,
    };
  }, [selected, conCostos]);

  const ejecutarConfirmacion = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await guardar();
      const r = await api.post(`/inventory-advanced/counts/${selected._id}/confirm`, { date: selected.date });
      setSelected(r.data);
      setConfirmar(false);
      toast.success('Toma confirmada: el stock de la bodega quedó ajustado.');
      load();
    } catch (e) {
      toast.error(e.response?.status === 403
        ? 'Tu rol puede contar, pero no confirmar el ajuste contable.'
        : (e.response?.data?.message || 'Error'));
    } finally { setBusy(false); }
  };

  const visibles = useMemo(() => {
    if (!selected) return [];
    const q = busqueda.trim().toLowerCase();
    if (!q) return selected.items;
    return selected.items.filter((it) => `${it.productName} ${it.productCode} ${it.barcode || ''}`
      .toLowerCase().includes(q));
  }, [selected, busqueda]);

  const esBorrador = selected?.status === 'BORRADOR';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          <HiOutlineClipboardDocumentCheck className="text-emerald-600" /> Tomas físicas
        </h1>
        <button onClick={() => setShow(true)}
          className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2">
          <HiOutlinePlus /> Nueva toma
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Historial */}
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
          <table className="min-w-full text-xs">
            <thead className="bg-emerald-50 text-[10px] uppercase text-slate-600">
              <tr>
                <th className="px-2 py-2 text-left">Código</th>
                <th className="px-2 py-2 text-left">Bodega</th>
                <th className="px-2 py-2 text-left">Fecha</th>
                <th className="px-2 py-2 text-center">Estado</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c._id} className="border-t cursor-pointer hover:bg-slate-50" onClick={() => setSelected(c)}>
                  <td className="px-2 py-2 font-mono">{c.code}</td>
                  <td className="px-2 py-2">{c.warehouse?.code || '—'}</td>
                  <td className="px-2 py-2">{fmtDate(c.date)}</td>
                  <td className="px-2 py-2 text-center">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      c.status === 'CONFIRMADO' ? 'text-emerald-700 bg-emerald-50' : 'text-sky-700 bg-sky-50'
                    }`}>{c.status}</span>
                  </td>
                </tr>
              ))}
              {!list.length && <tr><td colSpan={4} className="px-2 py-6 text-center text-slate-400">Sin tomas</td></tr>}
            </tbody>
          </table>
        </div>

        {/* Conteo */}
        {selected && (
          <div className="md:col-span-2 bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4 space-y-3">
            <div className="flex justify-between items-start flex-wrap gap-2">
              <div>
                <h2 className="font-semibold text-slate-800">
                  {selected.code} · {selected.warehouse?.name || 'Bodega'}
                  {selected.category?.name && <span className="text-slate-500"> · {selected.category.name}</span>}
                </h2>
                <p className="text-[11px] text-slate-500">
                  {fmtDate(selected.date)} · {selected.status}
                  {selected.snapshotAt && ' · «Stock del sistema» = lo que decía el sistema al INICIAR la toma'}
                </p>
              </div>
              <div className="flex gap-2">
                {selected.status !== 'BORRADOR' && (
                  <button onClick={() => setViewEntry(selected)}
                    className="px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-lg text-sm flex items-center gap-1">
                    <HiOutlineDocumentText className="w-4 h-4" /> Asiento
                  </button>
                )}
                {esBorrador && (
                  <>
                    <button onClick={guardar} className="px-3 py-1.5 bg-slate-600 text-white rounded-lg text-sm">Guardar</button>
                    <button onClick={() => setConfirmar(true)}
                      className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-sm flex items-center gap-1">
                      <HiOutlineCheck /> Confirmar
                    </button>
                  </>
                )}
              </div>
            </div>

            {!conCostos && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">
                Tu rol no ve costos: cuenta unidades, el valor del ajuste lo calcula contabilidad.
              </p>
            )}

            <div className="flex items-center gap-2">
              <HiOutlineMagnifyingGlass className="w-4 h-4 text-slate-400" />
              <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)}
                placeholder="Buscar por nombre, código o código de barras…"
                className="flex-1 border border-slate-200 rounded-lg px-3 py-1.5 text-sm" />
            </div>

            <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-100 text-[10px] uppercase sticky top-0">
                  <tr>
                    <th className="px-2 py-1 text-left">Código</th>
                    <th className="px-2 py-1 text-left">Producto</th>
                    <th className="px-2 py-1 text-right">Sistema</th>
                    <th className="px-2 py-1 text-right">Contado</th>
                    <th className="px-2 py-1 text-right">Diferencia</th>
                    <th className="px-2 py-1 text-left">Estado</th>
                    {conCostos && <th className="px-2 py-1 text-right">Costo unit.</th>}
                    {conCostos && <th className="px-2 py-1 text-right">Valor dif.</th>}
                    <th className="px-2 py-1 text-left">Observación</th>
                  </tr>
                </thead>
                <tbody>
                  {visibles.map((it) => {
                    const est = ESTADO_DIF(it.difference);
                    return (
                      <tr key={String(it.product)} className="border-t">
                        <td className="px-2 py-1 font-mono">{it.productCode}</td>
                        <td className="px-2 py-1">{it.productName}</td>
                        <td className="px-2 py-1 text-right font-mono">{it.systemQty}</td>
                        <td className="px-2 py-1 text-right">
                          <NumericInput disabled={!esBorrador} value={it.countedQty}
                            onChange={(e) => setCounted(it.product, e.target.value)}
                            className="w-20 border border-slate-200 rounded px-1 py-0.5 text-right" />
                        </td>
                        <td className={`px-2 py-1 text-right font-mono ${it.difference > 0 ? 'text-emerald-700' : it.difference < 0 ? 'text-rose-600' : ''}`}>
                          {it.difference || 0}
                        </td>
                        {/* Estado en TEXTO, no solo por color. */}
                        <td className="px-2 py-1">
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${est.cls}`}>{est.label}</span>
                        </td>
                        {conCostos && <td className="px-2 py-1 text-right font-mono">{fmt(it.unitCost)}</td>}
                        {conCostos && <td className="px-2 py-1 text-right font-mono">{fmt(it.adjustmentValue)}</td>}
                        <td className="px-2 py-1">
                          <input disabled={!esBorrador} value={it.notes || ''}
                            onChange={(e) => setSelected({
                              ...selected,
                              items: selected.items.map((x) => (String(x.product) === String(it.product)
                                ? { ...x, notes: e.target.value } : x)),
                            })}
                            className="w-full border border-slate-200 rounded px-1 py-0.5" />
                        </td>
                      </tr>
                    );
                  })}
                  {!visibles.length && (
                    <tr><td colSpan={9} className="px-2 py-6 text-center text-slate-400">Sin productos</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Nueva toma */}
      <Modal isOpen={show} onClose={() => setShow(false)} title="Nueva toma física" size="lg">
        <form onSubmit={start} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bodega" required>
              <select value={form.warehouse} onChange={(e) => setForm({ ...form, warehouse: e.target.value })}
                className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                <option value="">— elegir —</option>
                {warehouses.filter((w) => w.active !== false).map((w) => (
                  <option key={w._id} value={w._id}>{w.code} — {w.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Categoría de inventario">
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}
                className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                <option value="">Todas las inventariables</option>
                {categories.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Fecha">
              <DateInput value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })}
                className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </Field>
            <Field label="Responsable">
              <select value={form.responsible} onChange={(e) => setForm({ ...form, responsible: e.target.value })}
                className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                <option value="">— sin responsable —</option>
                {users.map((u) => <option key={u._id} value={u._id}>{u.name}</option>)}
              </select>
            </Field>
            <Field label="Descripción" className="col-span-2">
              <input placeholder="Ej: conteo mensual de insumos" value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </Field>
            <Field label="Notas" className="col-span-2">
              <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
                className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </Field>
          </div>

          {/* El centro de costo se PROPONE desde la bodega (no se pide otra vez). */}
          {bodega?.costCenter && (
            <p className="text-[11px] text-slate-600 bg-slate-50 rounded-lg p-2">
              El ajuste se registrará con el centro de costo de la bodega:{' '}
              <b>{bodega.costCenter.name || bodega.costCenter.code}</b>.
            </p>
          )}
          <p className="text-[11px] text-slate-500 bg-slate-50 rounded-lg p-2">
            Se cargarán solo los productos <b>inventariables</b> de esa bodega (nunca servicios), con el
            stock y el costo que el sistema tiene <b>en este momento</b>. Ese snapshot no cambia después.
          </p>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>
            <button disabled={busy} className="px-4 py-2 bg-emerald-600 text-white rounded-xl disabled:opacity-50">
              {busy ? 'Iniciando…' : 'Iniciar toma'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Confirmación explícita: se ve el efecto ANTES de tocar el inventario */}
      {confirmar && selected && (
        <Modal isOpen onClose={() => setConfirmar(false)} size="md" title="Confirmar la toma física">
          <div className="space-y-3 text-sm">
            <div className="bg-slate-50 rounded-xl p-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              <p><span className="text-slate-500">Bodega:</span> <b>{selected.warehouse?.name}</b></p>
              <p><span className="text-slate-500">Categoría:</span> <b>{selected.category?.name || 'Todas'}</b></p>
              <p><span className="text-slate-500">Fecha contable:</span> <b>{fmtDate(selected.date)}</b></p>
              <p><span className="text-slate-500">Productos con diferencia:</span> <b>{resumen.conDif}</b></p>
              <p><span className="text-slate-500">Unidades sobrantes:</span> <b className="text-emerald-700">{resumen.unidadesSobrantes}</b></p>
              <p><span className="text-slate-500">Unidades faltantes:</span> <b className="text-rose-600">{resumen.unidadesFaltantes}</b></p>
              {conCostos && (
                <>
                  <p><span className="text-slate-500">Valor sobrantes:</span> <b className="font-mono text-emerald-700">{fmt(resumen.valorSobrantes)}</b></p>
                  <p><span className="text-slate-500">Valor faltantes:</span> <b className="font-mono text-rose-600">{fmt(resumen.valorFaltantes)}</b></p>
                </>
              )}
            </div>
            <p className="text-xs text-slate-600">
              Se ajustará el stock <b>de esa bodega</b> y se generará el asiento contable de la diferencia.
              {resumen.conDif === 0 && ' No hay diferencias: la toma se cerrará sin asiento.'}
              {' '}Una toma confirmada <b>no se puede editar</b>.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmar(false)} className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600">
                Cancelar
              </button>
              <button onClick={ejecutarConfirmacion} disabled={busy}
                className="px-4 py-2 rounded-xl bg-emerald-600 text-white disabled:opacity-50">
                {busy ? 'Ajustando…' : 'Confirmar y ajustar'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      <JournalEntryViewModal
        isOpen={!!viewEntry}
        onClose={() => setViewEntry(null)}
        source={viewEntry ? { model: 'PhysicalCount', ref: viewEntry._id } : null}
        title={`Asiento del ajuste — ${viewEntry?.code || ''}`}
        emptyHint="Esta toma física no generó asiento (sin diferencias de inventario que ajustar)."
      />
    </div>
  );
}
