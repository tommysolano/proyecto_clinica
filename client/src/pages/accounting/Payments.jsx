import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlinePlus, HiOutlineCurrencyDollar, HiOutlineXMark } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';

export default function Payments() {
  const [list, setList] = useState([]);
  const [type, setType] = useState('PAGO');
  const [show, setShow] = useState(false);
  const [suppliers, setSuppliers] = useState([]);
  const [banks, setBanks] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [form, setForm] = useState({ type: 'PAGO', date: today(), partyModel: 'Supplier', party: '', method: 'TRANSFERENCIA', bankAccount: '', applications: [], advanceAmount: 0, notes: '' });

  const load = async () => {
    try { const r = await api.get('/payments', { params: { type } }); setList(r.data?.items || r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    api.get('/suppliers').then((r) => setSuppliers(r.data || []));
    api.get('/banks/accounts').then((r) => setBanks(r.data || []));
    load();
    // eslint-disable-next-line
  }, [type]);

  const openNew = (t) => {
    setForm({ type: t, date: today(), partyModel: t === 'PAGO' ? 'Supplier' : 'Patient', party: '', method: 'TRANSFERENCIA', bankAccount: '', applications: [], advanceAmount: 0, notes: '' });
    setShow(true);
  };

  const loadDocs = async (partyId) => {
    if (form.type === 'PAGO') {
      const r = await api.get('/purchase-invoices', { params: { supplier: partyId, status: 'REGISTRADA' } });
      setPurchases(r.data || []);
    } else {
      const r = await api.get('/invoices', { params: { client: partyId } });
      setInvoices(r.data || []);
    }
  };

  const totalApplied = form.applications.reduce((s, a) => s + (+a.amount || 0), 0) + (+form.advanceAmount || 0);

  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/payments', form);
      toast.success('Registrado');
      setShow(false); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  const voidPay = async (p) => {
    if (!confirm('¿Anular?')) return;
    try { await api.post(`/payments/${p._id}/void`); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><HiOutlineCurrencyDollar className="text-emerald-600" /> {type === 'PAGO' ? 'Pagos' : 'Cobros'}</h1>
        <div className="flex gap-2">
          <div className="flex rounded-lg overflow-hidden border border-emerald-200">
            <button onClick={() => setType('COBRO')} className={`px-3 py-2 text-sm ${type === 'COBRO' ? 'bg-emerald-600 text-white' : 'bg-white'}`}>Cobros</button>
            <button onClick={() => setType('PAGO')} className={`px-3 py-2 text-sm ${type === 'PAGO' ? 'bg-emerald-600 text-white' : 'bg-white'}`}>Pagos</button>
          </div>
          <button onClick={() => openNew(type)} className="px-4 py-2 bg-emerald-600 text-white rounded-lg flex items-center gap-2"><HiOutlinePlus /> Nuevo</button>
        </div>
      </div>
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Número</th><th className="px-3 py-2 text-left">Fecha</th>
            <th className="px-3 py-2 text-left">Método</th><th className="px-3 py-2 text-right">Aplicado</th>
            <th className="px-3 py-2 text-right">Anticipo</th><th className="px-3 py-2 text-center">Estado</th><th></th>
          </tr></thead>
          <tbody>
            {list.map((p) => (
              <tr key={p._id} className={`border-t ${p.status === 'ANULADO' ? 'text-slate-400 line-through' : ''}`}>
                <td className="px-3 py-2 font-mono">{p.number}</td>
                <td className="px-3 py-2">{fmtDate(p.date)}</td>
                <td className="px-3 py-2 text-xs">{p.method}</td>
                <td className="px-3 py-2 text-right font-mono">${fmt(p.appliedAmount)}</td>
                <td className="px-3 py-2 text-right font-mono">${fmt(p.advanceAmount)}</td>
                <td className="px-3 py-2 text-center text-xs">{p.status}</td>
                <td className="px-3 py-2 text-right">{p.status === 'REGISTRADO' && <button onClick={() => voidPay(p)} className="text-rose-600"><HiOutlineXMark className="w-4 h-4" /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={show} onClose={() => setShow(false)} title={`Nuevo ${form.type === 'PAGO' ? 'pago' : 'cobro'}`} size="xl">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <input type="date" required value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <select required value={form.party} onChange={(e) => { setForm({ ...form, party: e.target.value, applications: [] }); loadDocs(e.target.value); }} className="border border-slate-200 rounded-lg px-3 py-2 col-span-2">
              <option value="">{form.type === 'PAGO' ? 'Proveedor...' : 'Paciente (escriba ID)...'}</option>
              {form.type === 'PAGO' && suppliers.map((s) => <option key={s._id} value={s._id}>{s.razonSocial}</option>)}
            </select>
            <select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2">
              <option>EFECTIVO</option><option>TRANSFERENCIA</option><option>CHEQUE</option><option>TARJETA</option><option>DEPOSITO</option>
            </select>
            {form.method !== 'EFECTIVO' &&
              <select value={form.bankAccount} onChange={(e) => setForm({ ...form, bankAccount: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2 col-span-2">
                <option value="">Banco...</option>{banks.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
              </select>}
          </div>
          <div className="border rounded-lg p-3">
            <p className="text-sm font-semibold mb-2">Documentos a aplicar</p>
            {(form.type === 'PAGO' ? purchases : invoices).map((d) => {
              const docId = d._id;
              const app = form.applications.find((a) => a.docRef === docId);
              return (
                <div key={docId} className="flex items-center gap-2 text-sm py-1">
                  <input type="checkbox" checked={!!app} onChange={(e) => {
                    if (e.target.checked) setForm({ ...form, applications: [...form.applications, { docModel: form.type === 'PAGO' ? 'PurchaseInvoice' : 'Invoice', docRef: docId, amount: d.balance || d.total || 0 }] });
                    else setForm({ ...form, applications: form.applications.filter((a) => a.docRef !== docId) });
                  }} />
                  <span className="flex-1">{d.serie || `${d.estab}-${d.ptoEmi}-${d.secuencial}`} - {fmtDate(d.fechaEmision || d.createdAt)} - Total ${fmt(d.total || d.importeTotal)}</span>
                  {app && <input type="number" step="0.01" value={app.amount} onChange={(e) => setForm({ ...form, applications: form.applications.map((a) => a.docRef === docId ? { ...a, amount: +e.target.value } : a) })} className="w-28 border border-slate-200 rounded px-2 py-1 text-right" />}
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-3">
            <label className="text-sm">Anticipo:</label>
            <input type="number" step="0.01" value={form.advanceAmount} onChange={(e) => setForm({ ...form, advanceAmount: +e.target.value })} className="w-32 border border-slate-200 rounded-lg px-3 py-2" />
            <span className="ml-auto font-semibold">Total: ${fmt(totalApplied)}</span>
          </div>
          <input placeholder="Notas / cheque #" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2" />
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-lg">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-lg">Registrar</button></div>
        </form>
      </Modal>
    </div>
  );
}
