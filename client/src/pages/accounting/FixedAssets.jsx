import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlinePlus, HiOutlineBuildingLibrary, HiOutlineCalculator, HiOutlinePencilSquare, HiOutlineEye } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';

const EMPTY = {
  code: '', name: '', description: '', category: '', assetType: '',
  acquisitionDate: today(), acquisitionCost: 0, residualValue: 0, residualPercent: 0,
  depreciationRate: 10, usefulLifeMonths: 120, startDate: today(),
  location: '', locationClinic: '', serial: '', purchaseInvoice: '',
  assetAccount: '', depreciationAccount: '', accumDepreciationAccount: '',
};

const asList = (data) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  return [];
};

export default function FixedAssets() {
  const [list, setList] = useState([]);
  const [categories, setCategories] = useState([]);
  const [clinics, setClinics] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [detail, setDetail] = useState(null);
  const [depForm, setDepForm] = useState({ year: new Date().getFullYear(), month: new Date().getMonth() + 1 });
  const [showDep, setShowDep] = useState(false);

  const load = async () => {
    try { const r = await api.get('/inventory-advanced/assets'); setList(asList(r.data)); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    api.get('/inventory-advanced/categories', { params: { kind: 'ACTIVO_FIJO' } }).then((r) => setCategories(asList(r.data))).catch(() => {});
    api.get('/clinics').then((r) => setClinics(asList(r.data))).catch(() => {});
    api.get('/chart-of-accounts', { params: { active: true } }).then((r) => setAccounts(asList(r.data).filter((a) => a.allowsMovement))).catch(() => {});
    api.get('/purchase-invoices').then((r) => setPurchases(asList(r.data))).catch(() => {});
    load();
  }, []);

  // Categorías raíz (sin parent) y tipos (con parent = categoría seleccionada)
  const rootCategories = categories.filter((c) => !c.parent);
  const typesForCategory = categories.filter((c) => c.parent && String(c.parent) === String(form.category));

  const openNew = () => { setEditing(null); setForm(EMPTY); setShow(true); };
  const openEdit = (a) => {
    setEditing(a);
    setForm({
      ...EMPTY,
      ...a,
      category: a.category?._id || a.category || '',
      assetType: a.assetType?._id || a.assetType || '',
      locationClinic: a.locationClinic?._id || a.locationClinic || '',
      purchaseInvoice: a.purchaseInvoice?._id || a.purchaseInvoice || '',
      assetAccount: a.assetAccount?._id || a.assetAccount || '',
      depreciationAccount: a.depreciationAccount?._id || a.depreciationAccount || '',
      accumDepreciationAccount: a.accumDepreciationAccount?._id || a.accumDepreciationAccount || '',
      acquisitionDate: a.acquisitionDate ? a.acquisitionDate.slice(0, 10) : today(),
      startDate: a.startDate ? a.startDate.slice(0, 10) : today(),
    });
    setShow(true);
  };

  const onSelectCategory = (id) => {
    const c = categories.find((x) => x._id === id);
    setForm((f) => ({
      ...f, category: id, assetType: '',
      depreciationRate: c?.depreciationRate || f.depreciationRate,
      usefulLifeMonths: (c?.usefulLifeYears || 10) * 12,
      residualPercent: c?.residualPercent || f.residualPercent,
      assetAccount: c?.assetAccount?._id || c?.assetAccount || f.assetAccount,
      depreciationAccount: c?.depreciationAccount?._id || c?.depreciationAccount || f.depreciationAccount,
      accumDepreciationAccount: c?.accumDepreciationAccount?._id || c?.accumDepreciationAccount || f.accumDepreciationAccount,
    }));
  };

  const onSelectPurchase = (id) => {
    const p = purchases.find((x) => x._id === id);
    if (!p) { setForm((f) => ({ ...f, purchaseInvoice: '' })); return; }
    setForm((f) => ({
      ...f, purchaseInvoice: id,
      acquisitionCost: f.acquisitionCost || p.total || 0,
      acquisitionDate: p.fechaEmision ? p.fechaEmision.slice(0, 10) : f.acquisitionDate,
    }));
  };

  const submit = async (e) => {
    e.preventDefault();
    const payload = { ...form };
    ['assetType', 'locationClinic', 'purchaseInvoice', 'assetAccount', 'depreciationAccount', 'accumDepreciationAccount'].forEach((k) => { if (!payload[k]) payload[k] = null; });
    try {
      if (editing) await api.put(`/inventory-advanced/assets/${editing._id}`, payload);
      else await api.post('/inventory-advanced/assets', payload);
      toast.success('Guardado'); setShow(false); setForm(EMPTY); setEditing(null); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  const openDetail = async (a) => {
    try { const r = await api.get(`/inventory-advanced/assets/${a._id}`); setDetail(r.data); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const runDep = async () => {
    try { const r = await api.post('/inventory-advanced/assets/run-depreciation', depForm); toast.success(`Depreciado: $${fmt(r.data.totalDepreciation)}`); setShowDep(false); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const inputCls = 'border border-slate-200 rounded-lg px-3 py-2';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineBuildingLibrary className="text-emerald-600" /> Activos Fijos</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowDep(true)} className="px-4 py-2 bg-amber-500 text-white rounded-lg flex items-center gap-2"><HiOutlineCalculator /> Correr depreciación</button>
          <button onClick={openNew} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nuevo</button>
        </div>
      </div>
      <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Código</th><th className="px-3 py-2 text-left">Nombre</th>
            <th className="px-3 py-2 text-left">Categoría</th><th className="px-3 py-2 text-left">Sede</th>
            <th className="px-3 py-2 text-right">Valor inicial</th>
            <th className="px-3 py-2 text-right">Valor depreciado</th><th className="px-3 py-2 text-right">Valor actual</th>
            <th className="px-3 py-2 text-center">Estado</th><th></th>
          </tr></thead>
          <tbody>
            {list.map((a) => (
              <tr key={a._id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-xs">{a.code}</td>
                <td className="px-3 py-2">{a.name}</td>
                <td className="px-3 py-2 text-xs">{a.category?.name}{a.assetType ? ` / ${a.assetType.name}` : ''}</td>
                <td className="px-3 py-2 text-xs">{a.locationClinic?.name || a.location || '—'}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(a.acquisitionCost)}</td>
                <td className="px-3 py-2 text-right font-mono text-rose-600">{fmt(a.accumulatedDepreciation)}</td>
                <td className="px-3 py-2 text-right font-mono font-semibold">{fmt(a.bookValue)}</td>
                <td className="px-3 py-2 text-center text-xs">{a.status}</td>
                <td className="px-3 py-2 flex gap-1 justify-end">
                  <button onClick={() => openDetail(a)} className="text-emerald-600" title="Ver"><HiOutlineEye className="w-4 h-4" /></button>
                  <button onClick={() => openEdit(a)} className="text-blue-600" title="Editar"><HiOutlinePencilSquare className="w-4 h-4" /></button>
                </td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-400">Sin activos registrados</td></tr>}
          </tbody>
        </table>
      </div>

      <Modal isOpen={show} onClose={() => setShow(false)} title={editing ? 'Editar activo fijo' : 'Nuevo activo fijo'} size="lg">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input required placeholder="Código" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className={inputCls} />
            <input required placeholder="Nombre" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
            <select value={form.category} onChange={(e) => onSelectCategory(e.target.value)} className={inputCls}>
              <option value="">Categoría...</option>{rootCategories.map((c) => <option key={c._id} value={c._id}>{c.code} - {c.name} ({c.depreciationRate}%)</option>)}
            </select>
            <select value={form.assetType} onChange={(e) => setForm({ ...form, assetType: e.target.value })} className={inputCls} disabled={!typesForCategory.length}>
              <option value="">{typesForCategory.length ? 'Tipo de activo...' : 'Sin tipos'}</option>
              {typesForCategory.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
            </select>
            <select value={form.locationClinic} onChange={(e) => setForm({ ...form, locationClinic: e.target.value })} className={inputCls}>
              <option value="">Sede / clínica...</option>{clinics.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
            </select>
            <input placeholder="Ubicación específica (área)" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className={inputCls} />
            <select value={form.purchaseInvoice} onChange={(e) => onSelectPurchase(e.target.value)} className={`${inputCls} col-span-2`}>
              <option value="">Factura de compra (opcional)...</option>
              {purchases.map((p) => <option key={p._id} value={p._id}>{p.serie || p.secuencial} — {fmtDate(p.fechaEmision)} — ${fmt(p.total)}</option>)}
            </select>
            <input type="date" required value={form.acquisitionDate} onChange={(e) => setForm({ ...form, acquisitionDate: e.target.value })} className={inputCls} />
            <input type="date" required value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className={inputCls} />
            <input type="number" step="0.01" placeholder="Costo de adquisición" value={form.acquisitionCost} onChange={(e) => setForm({ ...form, acquisitionCost: +e.target.value })} className={inputCls} />
            <input type="number" step="0.01" placeholder="% valor residual" value={form.residualPercent} onChange={(e) => setForm({ ...form, residualPercent: +e.target.value, residualValue: +(form.acquisitionCost * (+e.target.value / 100)).toFixed(2) })} className={inputCls} />
            <input type="number" step="0.01" placeholder="Valor residual ($)" value={form.residualValue} onChange={(e) => setForm({ ...form, residualValue: +e.target.value })} className={inputCls} />
            <input type="number" step="0.01" placeholder="% depreciación anual" value={form.depreciationRate} onChange={(e) => setForm({ ...form, depreciationRate: +e.target.value, usefulLifeMonths: Math.round(1200 / (+e.target.value || 1)) })} className={inputCls} />
            <input type="number" placeholder="Vida útil (meses)" value={form.usefulLifeMonths} onChange={(e) => setForm({ ...form, usefulLifeMonths: +e.target.value })} className={inputCls} />
            <input placeholder="Serial" value={form.serial} onChange={(e) => setForm({ ...form, serial: e.target.value })} className={inputCls} />
          </div>
          <p className="text-xs font-semibold text-slate-500 pt-2">Cuentas contables ligadas (si no se setean, se usan las de la categoría)</p>
          <div className="grid grid-cols-3 gap-3">
            <select value={form.assetAccount} onChange={(e) => setForm({ ...form, assetAccount: e.target.value })} className={inputCls}>
              <option value="">Cuenta de activo...</option>{accounts.map((a) => <option key={a._id} value={a._id}>{a.code} - {a.name}</option>)}
            </select>
            <select value={form.depreciationAccount} onChange={(e) => setForm({ ...form, depreciationAccount: e.target.value })} className={inputCls}>
              <option value="">Gasto depreciación...</option>{accounts.map((a) => <option key={a._id} value={a._id}>{a.code} - {a.name}</option>)}
            </select>
            <select value={form.accumDepreciationAccount} onChange={(e) => setForm({ ...form, accumDepreciationAccount: e.target.value })} className={inputCls}>
              <option value="">Dep. acumulada...</option>{accounts.map((a) => <option key={a._id} value={a._id}>{a.code} - {a.name}</option>)}
            </select>
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Guardar</button></div>
        </form>
      </Modal>

      <Modal isOpen={!!detail} onClose={() => setDetail(null)} title={detail ? `${detail.code} — ${detail.name}` : ''} size="lg">
        {detail && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-slate-50 rounded-lg p-3"><p className="text-xs text-slate-500">Valor inicial</p><p className="text-lg font-bold text-slate-800">${fmt(detail.acquisitionCost)}</p></div>
              <div className="bg-rose-50 rounded-lg p-3"><p className="text-xs text-slate-500">Valor depreciado</p><p className="text-lg font-bold text-rose-600">${fmt(detail.accumulatedDepreciation)}</p></div>
              <div className="bg-emerald-50 rounded-lg p-3"><p className="text-xs text-slate-500">Valor actual</p><p className="text-lg font-bold text-emerald-700">${fmt(detail.bookValue)}</p></div>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
              <div><span className="text-slate-500">Categoría:</span> {detail.category?.name}{detail.assetType ? ` / ${detail.assetType.name}` : ''}</div>
              <div><span className="text-slate-500">Sede:</span> {detail.locationClinic?.name || '—'}</div>
              <div><span className="text-slate-500">Ubicación:</span> {detail.location || '—'}</div>
              <div><span className="text-slate-500">Serial:</span> {detail.serial || '—'}</div>
              <div><span className="text-slate-500">Adquisición:</span> {fmtDate(detail.acquisitionDate)}</div>
              <div><span className="text-slate-500">Inicio dep.:</span> {fmtDate(detail.startDate)}</div>
              <div><span className="text-slate-500">% Dep. anual:</span> {detail.depreciationRate}%</div>
              <div><span className="text-slate-500">Dep. mensual:</span> ${fmt(detail.monthlyDepreciation)}</div>
              <div><span className="text-slate-500">Valor residual:</span> ${fmt(detail.residualValue)}</div>
              <div><span className="text-slate-500">Factura compra:</span> {detail.purchaseInvoice?.serie || '—'}</div>
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-700 mb-1">Historial de depreciación</p>
              <div className="max-h-48 overflow-y-auto border rounded-lg">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50"><tr><th className="px-2 py-1 text-left">Período</th><th className="px-2 py-1 text-right">Depreciación</th><th className="px-2 py-1 text-right">Acumulado</th><th className="px-2 py-1 text-right">Valor libros</th></tr></thead>
                  <tbody>
                    {(detail.history || []).map((h, i) => (
                      <tr key={i} className="border-t"><td className="px-2 py-1">{h.period}</td><td className="px-2 py-1 text-right font-mono">{fmt(h.amount)}</td><td className="px-2 py-1 text-right font-mono">{fmt(h.accumulated)}</td><td className="px-2 py-1 text-right font-mono">{fmt(h.bookValue)}</td></tr>
                    ))}
                    {(!detail.history || !detail.history.length) && <tr><td colSpan={4} className="px-2 py-3 text-center text-slate-400">Sin depreciaciones</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </Modal>

      <Modal isOpen={showDep} onClose={() => setShowDep(false)} title="Correr depreciación mensual">
        <p className="text-sm text-slate-500 mb-3">Genera un asiento contable consolidando la depreciación del mes seleccionado. Es idempotente por período.</p>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <input type="number" placeholder="Año" value={depForm.year} onChange={(e) => setDepForm({ ...depForm, year: +e.target.value })} className={inputCls} />
          <input type="number" min="1" max="12" placeholder="Mes" value={depForm.month} onChange={(e) => setDepForm({ ...depForm, month: +e.target.value })} className={inputCls} />
        </div>
        <div className="flex justify-end gap-2"><button onClick={() => setShowDep(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button onClick={runDep} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Procesar</button></div>
      </Modal>
    </div>
  );
}
