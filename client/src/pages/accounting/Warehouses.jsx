import { useEffect, useMemo, useState, Fragment } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlinePlus, HiOutlineCube, HiOutlinePencilSquare, HiOutlineTrash, HiOutlineArrowsRightLeft, HiOutlineChevronDown, HiOutlineChevronRight, HiOutlineDocumentText } from 'react-icons/hi2';
import { fmt } from './_utils';
import NumericInput from '../../components/NumericInput';
import ProductSelect from '../../components/ProductSelect';
import AccountSelect from '../../components/AccountSelect';
import JournalEntryViewModal from '../../components/JournalEntryViewModal';

const EMPTY_WH = {
  code: '', name: '', address: '', chartAccount: '', costCenter: '', isMain: false, active: true,
};
const EMPTY_TRANSFER = {
  product: '', fromWarehouse: '', toWarehouse: '', quantity: '', reason: '', date: '', costCenter: '',
};

export default function Warehouses() {
  const [tab, setTab] = useState('list');
  const [list, setList] = useState([]);
  const [stock, setStock] = useState([]);
  const [transfers, setTransfers] = useState([]);
  const [products, setProducts] = useState([]);
  const [loadingStock, setLoadingStock] = useState(false);
  const [expanded, setExpanded] = useState({});

  // CRUD bodega
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_WH);

  // Traslado
  const [showTransfer, setShowTransfer] = useState(false);
  const [tForm, setTForm] = useState(EMPTY_TRANSFER);
  const [savingT, setSavingT] = useState(false);

  // Soporte contable del traslado (asiento o kardex)
  const [accounts, setAccounts] = useState([]);
  const [costCenters, setCostCenters] = useState([]);
  const [viewEntry, setViewEntry] = useState(null); // { model, ref, title }

  const loadWarehouses = async () => {
    try { const r = await api.get('/inventory-advanced/warehouses'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  const loadStock = async () => {
    setLoadingStock(true);
    try { const r = await api.get('/inventory-advanced/warehouse-stock'); setStock(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
    finally { setLoadingStock(false); }
  };
  const loadTransfers = async () => {
    try { const r = await api.get('/inventory-advanced/transfers'); setTransfers(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    loadWarehouses();
    api.get('/products').then((r) => setProducts((r.data || []).filter((p) => !p.unlimited))).catch(() => {});
    api.get('/chart-of-accounts', { params: { active: true } }).then((r) => setAccounts(r.data || [])).catch(() => {});
    api.get('/cost-centers', { params: { active: true } }).then((r) => setCostCenters(r.data || [])).catch(() => {});
  }, []);

  /** Centro de costo predeterminado de una bodega (lo PROPONE, no lo impone). */
  const centroDe = (whId) => {
    const w = list.find((x) => String(x._id) === String(whId));
    const cc = w?.costCenter;
    return cc ? (cc._id || cc) : '';
  };
  const nombreCentro = (id) => costCenters.find((c) => String(c._id) === String(id))?.name || '—';
  useEffect(() => {
    if (tab === 'stock') loadStock();
    if (tab === 'transfers') { loadStock(); loadTransfers(); }
  }, [tab]);

  // --- CRUD bodega ---
  const submit = async (e) => {
    e.preventDefault();
    const payload = {
      ...form,
      chartAccount: form.chartAccount || null,
      costCenter: form.costCenter || null,
    };
    try {
      if (editing) await api.put(`/inventory-advanced/warehouses/${editing._id}`, payload);
      else await api.post('/inventory-advanced/warehouses', payload);
      toast.success('Guardado'); setShow(false); setEditing(null); setForm(EMPTY_WH); loadWarehouses();
    } catch (err) {
      // Mensajes controlados: el backend nunca devuelve un E11000 crudo, pero por si acaso.
      const msg = err.response?.data?.message || 'Error';
      toast.error(/E11000|duplicate key/i.test(msg) ? 'Ya existe una bodega con ese código.' : msg);
    }
  };
  const remove = async (w) => {
    if (!confirm('¿Eliminar la bodega? (las existencias quedarán sin bodega asignada)')) return;
    try { await api.delete(`/inventory-advanced/warehouses/${w._id}`); loadWarehouses(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  // --- Traslado ---
  // Stock disponible del producto seleccionado en la bodega de origen.
  const availableInFrom = useMemo(() => {
    if (!tForm.product || !tForm.fromWarehouse) return null;
    const row = stock.find((s) => String(s.product._id) === String(tForm.product));
    if (!row) return 0;
    const w = row.warehouses.find((x) => String(x.warehouse?._id) === String(tForm.fromWarehouse));
    return w?.qty || 0;
  }, [tForm.product, tForm.fromWarehouse, stock]);

  const submitTransfer = async (e) => {
    e.preventDefault();
    if (tForm.fromWarehouse === tForm.toWarehouse) return toast.error('Las bodegas deben ser distintas');
    const qty = Number(tForm.quantity);
    if (!qty || qty <= 0) return toast.error('Cantidad inválida');
    if (availableInFrom != null && qty > availableInFrom) return toast.error(`Solo hay ${fmt(availableInFrom)} disponibles en la bodega de origen`);
    if (centroDistinto && !window.confirm(
      `El centro de costo de la bodega es "${nombreCentro(centroEsperado)}" y elegiste `
      + `"${nombreCentro(tForm.costCenter)}". El traslado se registrará con el que elegiste. ¿Continuar?`
    )) return;
    setSavingT(true);
    try {
      const r = await api.post('/inventory-advanced/transfer', { ...tForm, quantity: qty });
      toast.success(r.data?.journalEntryCreated
        ? 'Traslado registrado con asiento contable (bodegas con cuentas distintas)'
        : 'Traslado registrado');
      setShowTransfer(false); setTForm(EMPTY_TRANSFER);
      loadStock(); loadTransfers();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
    finally { setSavingT(false); }
  };
  const openTransfer = () => {
    const main = list.find((w) => w.isMain) || list[0];
    setTForm({
      ...EMPTY_TRANSFER,
      fromWarehouse: main?._id || '',
      costCenter: centroDe(main?._id),
      date: new Date().toISOString().slice(0, 10),
    });
    setShowTransfer(true);
  };

  /**
   * Al elegir la bodega origen se PROPONE su centro de costo, pero solo si el usuario no había
   * elegido uno: un centro ya seleccionado no se pisa en silencio.
   */
  const elegirOrigen = (whId) => {
    setTForm((f) => ({
      ...f,
      fromWarehouse: whId,
      costCenter: f.costCenter || centroDe(whId),
    }));
  };

  const centroEsperado = centroDe(tForm.fromWarehouse);
  const centroDistinto = !!centroEsperado && !!tForm.costCenter
    && String(centroEsperado) !== String(tForm.costCenter);

  const tabBtn = (id, label) => (
    <button onClick={() => setTab(id)} className={`px-5 py-2.5 rounded-lg text-sm font-medium cursor-pointer border-none transition-colors ${tab === id ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500 hover:text-emerald-700 bg-transparent'}`}>{label}</button>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineCube className="text-emerald-600" /> Bodegas</h1>
        <div className="flex gap-2">
          {list.length >= 2 && <button onClick={openTransfer} className="px-4 py-2 bg-sky-600 text-white rounded-xl shadow-sm shadow-sky-600/20 flex items-center gap-2"><HiOutlineArrowsRightLeft /> Traslado</button>}
          {tab === 'list' && <button onClick={() => { setEditing(null); setForm(EMPTY_WH); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nueva</button>}
        </div>
      </div>

      <div className="flex gap-1 bg-emerald-50 rounded-xl p-1 w-fit">
        {tabBtn('list', 'Bodegas')}
        {tabBtn('stock', 'Existencias por bodega')}
        {tabBtn('transfers', 'Traslados')}
      </div>

      {/* --- Pestaña Bodegas --- */}
      {tab === 'list' && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
          <table className="tbl">
            <thead className="bg-emerald-50 text-xs uppercase"><tr>
              <th className="px-3 py-2 text-left">Código</th>
              <th className="px-3 py-2 text-left">Nombre</th>
              <th className="px-3 py-2 text-left">Dirección</th>
              <th className="px-3 py-2 text-left">Centro de costo</th>
              <th className="px-3 py-2 text-center">Estado</th>
              <th className="px-3 py-2 text-center">Principal</th>
              <th></th>
            </tr></thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-500">Sin bodegas. Crea una para ubicar tu inventario.</td></tr>}
              {list.map((w) => (
                <tr key={w._id} className={`border-t ${w.active === false ? 'opacity-60' : ''}`}>
                  <td className="px-3 py-2 font-mono">{w.code}</td>
                  <td className="px-3 py-2">{w.name}</td>
                  <td className="px-3 py-2 text-slate-500">{w.address}</td>
                  <td className="px-3 py-2 text-slate-600">{w.costCenter?.name || '—'}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      w.active === false ? 'text-slate-600 bg-slate-100' : 'text-emerald-700 bg-emerald-50'
                    }`}>{w.active === false ? 'INACTIVA' : 'ACTIVA'}</span>
                  </td>
                  <td className="px-3 py-2 text-center">{w.isMain ? '✓' : '—'}</td>
                  <td className="px-3 py-2 flex gap-1 justify-end">
                    <button onClick={() => {
                      setEditing(w);
                      setForm({
                        code: w.code, name: w.name, address: w.address || '',
                        chartAccount: w.chartAccount?._id || w.chartAccount || '',
                        costCenter: w.costCenter?._id || w.costCenter || '',
                        isMain: !!w.isMain, active: w.active !== false,
                      });
                      setShow(true);
                    }} className="text-blue-600"><HiOutlinePencilSquare className="w-4 h-4" /></button>
                    <button onClick={() => remove(w)} className="text-rose-600"><HiOutlineTrash className="w-4 h-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* --- Pestaña Existencias por bodega --- */}
      {tab === 'stock' && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
          <table className="tbl">
            <thead className="bg-emerald-50 text-xs uppercase"><tr>
              <th className="w-8"></th>
              <th className="px-3 py-2 text-left">Código</th>
              <th className="px-3 py-2 text-left">Producto</th>
              <th className="px-3 py-2 text-right">Stock total</th>
              <th className="px-3 py-2 text-right">Valor</th>
              <th className="px-3 py-2 text-left">Bodegas</th>
            </tr></thead>
            <tbody>
              {loadingStock && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">Cargando...</td></tr>}
              {!loadingStock && stock.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">Aún no hay existencias con capas de inventario. Registra entradas (con bodega) en Inventario o compras.</td></tr>}
              {stock.map((s) => {
                const isOpen = !!expanded[s.product._id];
                return (
                  <Fragment key={s.product._id}>
                    <tr className="border-t hover:bg-slate-50">
                      <td className="px-2 py-2 text-center"><button onClick={() => setExpanded({ ...expanded, [s.product._id]: !isOpen })} className="text-slate-500">{isOpen ? <HiOutlineChevronDown /> : <HiOutlineChevronRight />}</button></td>
                      <td className="px-3 py-2 font-mono text-xs">{s.product.code}</td>
                      <td className="px-3 py-2 font-medium">{s.product.name}</td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(s.totalQty)}</td>
                      <td className="px-3 py-2 text-right font-mono text-emerald-700">${fmt(s.totalValue)}</td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {s.warehouses.map((w) => `${w.warehouse?.name || 'Sin bodega'} (${fmt(w.qty)})`).join(', ')}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-slate-50/70"><td></td><td colSpan={5} className="px-3 py-2">
                        <table className="tbl text-xs">
                          <thead className="text-slate-500"><tr><th className="px-2 py-1 text-left">Bodega</th><th className="px-2 py-1 text-right">Stock</th><th className="px-2 py-1 text-right">Valor</th></tr></thead>
                          <tbody>
                            {s.warehouses.map((w, i) => (
                              <tr key={i} className="border-t border-slate-200">
                                <td className="px-2 py-1">{w.warehouse ? `${w.warehouse.code} - ${w.warehouse.name}` : 'Sin bodega'}</td>
                                <td className="px-2 py-1 text-right font-mono">{fmt(w.qty)}</td>
                                <td className="px-2 py-1 text-right font-mono">${fmt(w.value)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* --- Pestaña Traslados --- */}
      {tab === 'transfers' && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
          <table className="tbl">
            <thead className="bg-emerald-50 text-xs uppercase"><tr>
              <th className="px-3 py-2 text-left">Fecha</th>
              <th className="px-3 py-2 text-left">Producto</th>
              <th className="px-3 py-2 text-left">Origen → Destino</th>
              <th className="px-3 py-2 text-right">Cantidad</th>
              <th className="px-3 py-2 text-right">Valor</th>
              <th className="px-3 py-2 text-left">Usuario</th>
              <th className="px-3 py-2 text-center">Soporte</th>
            </tr></thead>
            <tbody>
              {transfers.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-500">Sin traslados registrados.</td></tr>}
              {transfers.map((t) => (
                <tr key={t._id} className="border-t">
                  <td className="px-3 py-2 text-xs">{new Date(t.createdAt).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}</td>
                  <td className="px-3 py-2">{t.product?.name}</td>
                  <td className="px-3 py-2 text-xs">{t.warehouse?.name || '?'} → {t.toWarehouse?.name || '?'}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmt(t.quantity)}</td>
                  <td className="px-3 py-2 text-right font-mono">${fmt(t.totalCost)}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{t.createdBy?.name || '—'}</td>
                  <td className="px-3 py-2 text-center">
                    <button
                      onClick={() => setViewEntry({ model: 'InventoryMovement', ref: t._id, title: `Soporte del traslado — ${t.product?.name || ''}` })}
                      className="inline-flex items-center gap-1 px-2 py-1 text-xs text-emerald-700 bg-emerald-50 rounded-lg"
                      title="Ver asiento contable / soporte del traslado"
                    >
                      <HiOutlineDocumentText className="w-4 h-4" /> Asiento
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal CRUD bodega */}
      <Modal isOpen={show} onClose={() => setShow(false)} title={editing ? 'Editar bodega' : 'Nueva bodega'}>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Código" required><input required placeholder="Ej: BOD-01" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
          <Field label="Nombre" required><input required placeholder="Ej: Bodega principal" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
          <Field label="Dirección"><input placeholder="Dirección física" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
          <Field label="Cuenta contable de inventario (opcional)">
            <AccountSelect accounts={accounts} value={form.chartAccount} onChange={(v) => setForm({ ...form, chartAccount: v })} placeholder="Sin cuenta específica" />
            <p className="text-xs text-slate-400 mt-1">Si dos bodegas tienen cuentas distintas, el traslado entre ellas genera asiento contable de reclasificación. Con la misma cuenta (o sin cuenta), el traslado es solo movimiento de kardex.</p>
          </Field>
          <Field label="Centro de costo predeterminado (opcional)">
            <select value={form.costCenter} onChange={(e) => setForm({ ...form, costCenter: e.target.value })}
              className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
              <option value="">Sin centro de costo</option>
              {costCenters.map((c) => <option key={c._id} value={c._id}>{c.code} — {c.name}</option>)}
            </select>
            <p className="text-xs text-slate-400 mt-1">
              Se <b>propone</b> en los documentos que usen esta bodega (traslados, tomas físicas, ajustes).
              El usuario puede elegir otro: la operación se registra con el que realmente use.
            </p>
          </Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isMain} onChange={(e) => setForm({ ...form, isMain: e.target.checked })} /> Principal (bodega por defecto al registrar movimientos)</label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.active !== false} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            Bodega activa (una bodega inactiva no admite tomas físicas nuevas)
          </label>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Guardar</button></div>
        </form>
      </Modal>

      {/* Modal Traslado */}
      <Modal isOpen={showTransfer} onClose={() => setShowTransfer(false)} title="Traslado entre bodegas">
        <form onSubmit={submitTransfer} className="space-y-3">
          <Field label="Producto" required>
            <ProductSelect products={products} value={tForm.product} onChange={(v) => setTForm({ ...tForm, product: v })} required />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bodega origen" required>
              <select required value={tForm.fromWarehouse} onChange={(e) => elegirOrigen(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                <option value="">Seleccione…</option>
                {list.map((w) => <option key={w._id} value={w._id}>{w.name}</option>)}
              </select>
            </Field>
            <Field label="Bodega destino" required>
              <select required value={tForm.toWarehouse} onChange={(e) => setTForm({ ...tForm, toWarehouse: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                <option value="">Seleccione…</option>
                {list.filter((w) => String(w._id) !== String(tForm.fromWarehouse)).map((w) => <option key={w._id} value={w._id}>{w.name}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Cantidad" required>
            <NumericInput min="0.01" step="0.01" required value={tForm.quantity} onChange={(e) => setTForm({ ...tForm, quantity: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
          </Field>
          {tForm.product && tForm.fromWarehouse && (
            <p className={`text-xs ${availableInFrom > 0 ? 'text-slate-500' : 'text-rose-600'}`}>Disponible en origen: <b>{fmt(availableInFrom || 0)}</b></p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Fecha del traslado">
              <input type="date" value={tForm.date} onChange={(e) => setTForm({ ...tForm, date: e.target.value })}
                className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </Field>
            <Field label="Centro de costo">
              <select value={tForm.costCenter} onChange={(e) => setTForm({ ...tForm, costCenter: e.target.value })}
                className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                <option value="">Sin centro de costo</option>
                {costCenters.map((c) => <option key={c._id} value={c._id}>{c.code} — {c.name}</option>)}
              </select>
            </Field>
          </div>
          {/* El centro de la bodega es una PROPUESTA: si eliges otro, se avisa y se registra el elegido. */}
          {centroDistinto && (
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              <b>Centro de costo distinto al de la bodega.</b><br />
              Esperado (bodega {list.find((w) => String(w._id) === String(tForm.fromWarehouse))?.name}):{' '}
              <b>{nombreCentro(centroEsperado)}</b> · Seleccionado: <b>{nombreCentro(tForm.costCenter)}</b>.<br />
              El traslado quedará registrado con el centro <b>seleccionado</b>. Confirma para continuar.
            </div>
          )}
          <Field label="Motivo"><input placeholder="Opcional" value={tForm.reason} onChange={(e) => setTForm({ ...tForm, reason: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShowTransfer(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button disabled={savingT} className="px-4 py-2 bg-sky-600 text-white rounded-xl shadow-sm shadow-sky-600/20 disabled:opacity-50">{savingT ? 'Trasladando…' : 'Trasladar'}</button></div>
        </form>
      </Modal>

      {/* Asiento / soporte contable del traslado */}
      <JournalEntryViewModal
        isOpen={!!viewEntry}
        onClose={() => setViewEntry(null)}
        source={viewEntry ? { model: viewEntry.model, ref: viewEntry.ref } : null}
        title={viewEntry?.title || 'Soporte del traslado'}
        emptyHint="Este traslado no generó asiento financiero porque las bodegas comparten la misma cuenta contable de inventario (o no tienen cuenta asignada). El soporte es el movimiento de kardex: producto, cantidad, costo, bodega origen/destino, usuario y fecha que se muestran en la tabla."
      />
    </div>
  );
}
