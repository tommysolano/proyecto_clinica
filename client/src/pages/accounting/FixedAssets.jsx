import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlinePlus, HiOutlineBuildingLibrary, HiOutlineCalculator } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';

const EMPTY = { code: '', name: '', description: '', category: '', acquisitionDate: today(), acquisitionCost: 0, residualValue: 0, depreciationRate: 10, usefulLifeMonths: 120, startDate: today(), location: '' };

export default function FixedAssets() {
  const [list, setList] = useState([]);
  const [categories, setCategories] = useState([]);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [depForm, setDepForm] = useState({ year: new Date().getFullYear(), month: new Date().getMonth() + 1 });
  const [showDep, setShowDep] = useState(false);

  const load = async () => {
    try { const r = await api.get('/inventory-advanced/assets'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    api.get('/inventory-advanced/categories', { params: { kind: 'ACTIVO_FIJO' } }).then((r) => setCategories(r.data || []));
    load();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    try { await api.post('/inventory-advanced/assets', form); toast.success('Creado'); setShow(false); setForm(EMPTY); load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  const runDep = async () => {
    try { const r = await api.post('/inventory-advanced/assets/run-depreciation', depForm); toast.success(`Depreciado: $${fmt(r.data.totalDepreciation)}`); setShowDep(false); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><HiOutlineBuildingLibrary className="text-emerald-600" /> Activos Fijos</h1>
        <div className="flex gap-2">
          <button onClick={() => setShowDep(true)} className="px-4 py-2 bg-amber-500 text-white rounded-lg flex items-center gap-2"><HiOutlineCalculator /> Correr depreciación</button>
          <button onClick={() => { setForm(EMPTY); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-lg flex items-center gap-2"><HiOutlinePlus /> Nuevo</button>
        </div>
      </div>
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Código</th><th className="px-3 py-2 text-left">Nombre</th>
            <th className="px-3 py-2 text-left">Categoría</th><th className="px-3 py-2 text-right">Costo</th>
            <th className="px-3 py-2 text-right">Dep. Acum.</th><th className="px-3 py-2 text-right">Valor Libros</th>
            <th className="px-3 py-2 text-right">Mensual</th><th className="px-3 py-2 text-center">Estado</th>
          </tr></thead>
          <tbody>
            {list.map((a) => (
              <tr key={a._id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-xs">{a.code}</td>
                <td className="px-3 py-2">{a.name}</td>
                <td className="px-3 py-2 text-xs">{a.category?.name}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(a.acquisitionCost)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(a.accumulatedDepreciation)}</td>
                <td className="px-3 py-2 text-right font-mono font-semibold">{fmt(a.bookValue)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(a.monthlyDepreciation)}</td>
                <td className="px-3 py-2 text-center text-xs">{a.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={show} onClose={() => setShow(false)} title="Nuevo activo fijo" size="lg">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input required placeholder="Código" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input required placeholder="Nombre" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <select value={form.category} onChange={(e) => {
              const c = categories.find((x) => x._id === e.target.value);
              setForm({ ...form, category: e.target.value, depreciationRate: c?.depreciationRate || form.depreciationRate, usefulLifeMonths: (c?.usefulLifeYears || 10) * 12 });
            }} className="border border-slate-200 rounded-lg px-3 py-2 col-span-2">
              <option value="">Categoría...</option>{categories.map((c) => <option key={c._id} value={c._id}>{c.code} - {c.name} ({c.depreciationRate}%)</option>)}
            </select>
            <input type="date" required value={form.acquisitionDate} onChange={(e) => setForm({ ...form, acquisitionDate: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input type="date" required value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input type="number" step="0.01" placeholder="Costo de adquisición" value={form.acquisitionCost} onChange={(e) => setForm({ ...form, acquisitionCost: +e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input type="number" step="0.01" placeholder="Valor residual" value={form.residualValue} onChange={(e) => setForm({ ...form, residualValue: +e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input type="number" step="0.01" placeholder="% depreciación anual" value={form.depreciationRate} onChange={(e) => setForm({ ...form, depreciationRate: +e.target.value, usefulLifeMonths: Math.round(1200 / +e.target.value) })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input type="number" placeholder="Vida útil (meses)" value={form.usefulLifeMonths} onChange={(e) => setForm({ ...form, usefulLifeMonths: +e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input placeholder="Ubicación" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input placeholder="Serial" value={form.serial} onChange={(e) => setForm({ ...form, serial: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-lg">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-lg">Guardar</button></div>
        </form>
      </Modal>

      <Modal isOpen={showDep} onClose={() => setShowDep(false)} title="Correr depreciación mensual">
        <p className="text-sm text-slate-500 mb-3">Genera un asiento contable consolidando la depreciación del mes seleccionado. Es idempotente por período.</p>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <input type="number" placeholder="Año" value={depForm.year} onChange={(e) => setDepForm({ ...depForm, year: +e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
          <input type="number" min="1" max="12" placeholder="Mes" value={depForm.month} onChange={(e) => setDepForm({ ...depForm, month: +e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
        </div>
        <div className="flex justify-end gap-2"><button onClick={() => setShowDep(false)} className="px-4 py-2 bg-slate-200 rounded-lg">Cancelar</button><button onClick={runDep} className="px-4 py-2 bg-emerald-600 text-white rounded-lg">Procesar</button></div>
      </Modal>
    </div>
  );
}
