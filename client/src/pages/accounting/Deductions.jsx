import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlineReceiptPercent, HiOutlinePlus, HiOutlineTrash, HiOutlineArchiveBoxArrowDown } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';
import NumericInput from '../../components/NumericInput';
import AccountSelect from '../../components/AccountSelect';
import ProductSelect from '../../components/ProductSelect';

const DED_TYPES = [
  ['CONSUMO', 'Consumo de productos/servicios'],
  ['MULTA', 'Multa / sanción'],
  ['UNIFORME', 'Uniformes / EPP'],
  ['ANTICIPO', 'Anticipo de sueldo'],
  ['OTRO', 'Otro'],
];
const TYPE_LABEL = Object.fromEntries(DED_TYPES);
const STATUS_STYLE = { PENDIENTE: 'bg-amber-100 text-amber-700', APLICADO: 'bg-emerald-100 text-emerald-700', ANULADO: 'bg-slate-200 text-slate-500' };

export default function Deductions() {
  const [tab, setTab] = useState('deductions');
  const [employees, setEmployees] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [products, setProducts] = useState([]);

  // Deducciones
  const [list, setList] = useState([]);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ employee: '', type: 'CONSUMO', amount: 0, description: '', date: today(), counterpartAccount: '' });

  // Consumo interno
  const [ciForm, setCiForm] = useState({ date: today(), account: '', notes: '' });
  const [ciItems, setCiItems] = useState([]);
  const [ciSel, setCiSel] = useState({ product: '', quantity: 1 });
  const [ciBusy, setCiBusy] = useState(false);

  const loadMeta = async () => {
    const [e, a, p] = await Promise.all([
      api.get('/payroll/employees').catch(() => ({ data: [] })),
      api.get('/chart-of-accounts').catch(() => ({ data: [] })),
      api.get('/products').catch(() => ({ data: [] })),
    ]);
    setEmployees(e.data || []);
    setAccounts(a.data || []);
    setProducts((p.data.products || p.data || []).filter((x) => x.category !== 'servicio' && !x.unlimited));
  };
  const loadList = async () => {
    try { const r = await api.get('/payroll/deductions'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => { loadMeta(); loadList(); }, []);

  const submitDed = async (e) => {
    e.preventDefault();
    if (!form.employee) return toast.error('Selecciona un empleado');
    if (!(form.amount > 0)) return toast.error('Monto inválido');
    try {
      await api.post('/payroll/deductions', form);
      toast.success('Deducción registrada');
      setShow(false);
      setForm({ employee: '', type: 'CONSUMO', amount: 0, description: '', date: today(), counterpartAccount: '' });
      loadList();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };
  const voidDed = async (d) => {
    if (!confirm('¿Anular esta deducción?')) return;
    try { await api.post(`/payroll/deductions/${d._id}/void`); loadList(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  // Consumo interno
  const addCiItem = () => {
    if (!ciSel.product) return toast.error('Selecciona un producto');
    if (ciItems.find((i) => i.product === ciSel.product)) return toast.error('Ya está en la lista');
    const prod = products.find((p) => p._id === ciSel.product);
    setCiItems([...ciItems, { product: ciSel.product, name: prod?.name || '', quantity: Number(ciSel.quantity) || 1 }]);
    setCiSel({ product: '', quantity: 1 });
  };
  const submitCi = async (e) => {
    e.preventDefault();
    if (!ciItems.length) return toast.error('Agrega al menos un producto');
    setCiBusy(true);
    try {
      const r = await api.post('/payroll/internal-consumption', {
        date: ciForm.date, account: ciForm.account || null, notes: ciForm.notes,
        items: ciItems.map((i) => ({ product: i.product, quantity: i.quantity })),
      });
      toast.success(`Consumo registrado: ${r.data?.count || 0} ítem(s), costo $${fmt(r.data?.total)}`);
      setCiItems([]); setCiForm({ date: today(), account: '', notes: '' });
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
    finally { setCiBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineReceiptPercent className="text-emerald-600" /> Deducciones y consumo interno</h1>
        {tab === 'deductions' && (
          <button onClick={() => setShow(true)} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nueva deducción</button>
        )}
      </div>

      <div className="flex gap-2 border-b border-slate-200">
        <button onClick={() => setTab('deductions')} className={`px-4 py-2 text-sm font-medium border-b-2 ${tab === 'deductions' ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-slate-500'}`}>Deducciones al personal</button>
        <button onClick={() => setTab('consumption')} className={`px-4 py-2 text-sm font-medium border-b-2 ${tab === 'consumption' ? 'border-emerald-600 text-emerald-700' : 'border-transparent text-slate-500'}`}>Consumo interno</button>
      </div>

      {tab === 'deductions' && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-x-auto">
          <table className="tbl">
            <thead className="bg-emerald-50 text-xs uppercase"><tr>
              <th className="px-3 py-2 text-left">Fecha</th>
              <th className="px-3 py-2 text-left">Empleado</th>
              <th className="px-3 py-2 text-left">Tipo</th>
              <th className="px-3 py-2 text-left">Descripción</th>
              <th className="px-3 py-2 text-right">Monto</th>
              <th className="px-3 py-2 text-center">Estado</th>
              <th></th>
            </tr></thead>
            <tbody>
              {list.map((d) => (
                <tr key={d._id} className="border-t">
                  <td className="px-3 py-2 text-xs">{fmtDate(d.date)}</td>
                  <td className="px-3 py-2">{d.employee ? `${d.employee.firstName} ${d.employee.lastName}` : '—'}</td>
                  <td className="px-3 py-2 text-xs">{TYPE_LABEL[d.type] || d.type}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{d.description || '—'}{d.appliedIn ? ` · rol ${d.appliedIn}` : ''}</td>
                  <td className="px-3 py-2 text-right font-mono">${fmt(d.amount)}</td>
                  <td className="px-3 py-2 text-center"><span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${STATUS_STYLE[d.status] || ''}`}>{d.status}</span></td>
                  <td className="px-3 py-2 text-right">
                    {d.status === 'PENDIENTE' && <button onClick={() => voidDed(d)} className="text-rose-600" title="Anular"><HiOutlineTrash className="w-4 h-4" /></button>}
                  </td>
                </tr>
              ))}
              {!list.length && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">Sin deducciones registradas. Se descuentan automáticamente al cerrar el rol del período.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'consumption' && (
        <form onSubmit={submitCi} className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4 space-y-3">
          <p className="text-sm text-slate-500">Salida de inventario para uso interno de la clínica (no es venta). Carga el costo a la cuenta de gasto seleccionada.</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Field label="Fecha" required><input type="date" required value={ciForm.date} onChange={(e) => setCiForm({ ...ciForm, date: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Cuenta de gasto">
              <AccountSelect accounts={accounts} value={ciForm.account} onChange={(v) => setCiForm({ ...ciForm, account: v })} filter={(a) => a.code?.startsWith('6.') || a.code?.startsWith('5.')} emptyOption="Consumo interno (por defecto)" />
            </Field>
            <Field label="Notas"><input value={ciForm.notes} onChange={(e) => setCiForm({ ...ciForm, notes: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
          </div>

          <div className="bg-emerald-50/50 rounded-xl p-3 flex gap-2 items-end">
            <div className="flex-1">
              <label className="text-xs text-slate-500">Producto</label>
              <ProductSelect products={products} value={ciSel.product} onChange={(v) => setCiSel({ ...ciSel, product: v })} placeholder="Seleccionar producto…" />
            </div>
            <div className="w-24">
              <label className="text-xs text-slate-500">Cantidad</label>
              <NumericInput min="1" value={ciSel.quantity} onChange={(e) => setCiSel({ ...ciSel, quantity: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </div>
            <button type="button" onClick={addCiItem} className="px-4 py-2.5 bg-cyan-600 text-white rounded-xl text-sm">Agregar</button>
          </div>

          {ciItems.length > 0 && (
            <table className="tbl text-sm">
              <thead className="bg-slate-100 text-xs uppercase"><tr><th className="px-2 py-1 text-left">Producto</th><th className="px-2 py-1 text-right">Cantidad</th><th></th></tr></thead>
              <tbody>
                {ciItems.map((it, i) => (
                  <tr key={it.product} className="border-t">
                    <td className="px-2 py-1">{it.name}</td>
                    <td className="px-2 py-1 text-right">{it.quantity}</td>
                    <td className="px-2 py-1 text-right"><button type="button" onClick={() => setCiItems(ciItems.filter((_, x) => x !== i))} className="text-rose-600"><HiOutlineTrash className="w-4 h-4" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="flex justify-end">
            <button disabled={ciBusy || !ciItems.length} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2 disabled:opacity-50"><HiOutlineArchiveBoxArrowDown /> {ciBusy ? 'Registrando...' : 'Registrar consumo interno'}</button>
          </div>
        </form>
      )}

      <Modal isOpen={show} onClose={() => setShow(false)} title="Nueva deducción al personal" size="md">
        <form onSubmit={submitDed} className="space-y-3">
          <Field label="Empleado" required>
            <select required value={form.employee} onChange={(e) => setForm({ ...form, employee: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
              <option value="">Seleccione…</option>
              {employees.map((e) => <option key={e._id} value={e._id}>{e.firstName} {e.lastName} ({e.code})</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Tipo">
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                {DED_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <Field label="Monto ($)" required><NumericInput step="0.01" min="0" required value={form.amount} onChange={(e) => setForm({ ...form, amount: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-right" /></Field>
          </div>
          <Field label="Fecha" required><input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
          <Field label="Cuenta contraparte (opcional)">
            <AccountSelect accounts={accounts} value={form.counterpartAccount} onChange={(v) => setForm({ ...form, counterpartAccount: v })} emptyOption="Automática según el tipo" />
          </Field>
          <Field label="Descripción"><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" placeholder="Concepto del descuento" /></Field>
          <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-lg px-3 py-2">El monto se descontará automáticamente del neto al cerrar el rol del período correspondiente.</div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Guardar</button></div>
        </form>
      </Modal>
    </div>
  );
}
