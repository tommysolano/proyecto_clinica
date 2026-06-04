import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { Link } from 'react-router-dom';
import { HiOutlinePlus, HiOutlinePencilSquare, HiOutlineTrash, HiOutlineBanknotes, HiOutlineArrowsRightLeft } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';

const EMPTY = { name: '', bank: '', accountNumber: '', accountType: 'CORRIENTE', currency: 'USD', city: '', chartAccount: '', initialBalance: 0, nextCheckNumber: 1, active: true };

export default function BankAccounts() {
  const [accounts, setAccounts] = useState([]);
  const [balances, setBalances] = useState([]);
  const [chart, setChart] = useState([]);
  const [showAcc, setShowAcc] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [selected, setSelected] = useState(null);
  const [movements, setMovements] = useState([]);
  const [showMov, setShowMov] = useState(false);
  const [movForm, setMovForm] = useState({ bankAccount: '', date: today(), type: 'DEPOSITO', amount: 0, counterpartAccount: '', description: '', reference: '', voucherNumber: '', voucherUrl: '' });

  const load = async () => {
    try {
      const [a, b] = await Promise.all([api.get('/banks/accounts'), api.get('/banks/balances')]);
      setAccounts(a.data || []); setBalances(b.data || []);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    api.get('/chart-of-accounts', { params: { active: true } }).then((r) => setChart((r.data || []).filter((a) => a.allowsMovement)));
    load();
  }, []);

  const loadMovements = async (id) => {
    try { const r = await api.get('/banks/transactions', { params: { bankAccount: id } }); setMovements(r.data?.items || r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const submit = async (e) => {
    e.preventDefault();
    try {
      if (editing) await api.put(`/banks/accounts/${editing._id}`, form);
      else await api.post('/banks/accounts', form);
      toast.success('Guardado');
      setShowAcc(false); setEditing(null); setForm(EMPTY); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  const remove = async (a) => {
    if (!confirm('¿Eliminar cuenta?')) return;
    try { await api.delete(`/banks/accounts/${a._id}`); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const submitMov = async (e) => {
    e.preventDefault();
    try {
      await api.post('/banks/transactions', movForm);
      toast.success('Movimiento registrado');
      setShowMov(false);
      if (selected) loadMovements(selected._id);
      load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  const submitTransfer = async (e) => {
    e.preventDefault();
    try {
      await api.post('/banks/cash-to-transfer', movForm);
      toast.success('Conversión a transferencia aplicada');
      load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  // submitTransfer reservado para compatibilidad — la lógica completa está en /accounting/cash.
  void submitTransfer;

  const balanceOf = (id) => balances.find((b) => String(b.bankAccount) === String(id))?.balance || 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineBanknotes className="text-emerald-600" /> Bancos</h1>
        <div className="flex gap-2">
          <Link to="/accounting/cash" className="px-4 py-2 bg-amber-500 text-white rounded-lg flex items-center gap-2 no-underline"><HiOutlineArrowsRightLeft /> Caja → Banco</Link>
          <button onClick={() => { setEditing(null); setForm(EMPTY); setShowAcc(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nueva cuenta</button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {accounts.map((a) => (
          <div key={a._id} className={`bg-white rounded-xl p-4 shadow-sm border ${selected?._id === a._id ? 'border-emerald-500' : 'border-emerald-100'} cursor-pointer`} onClick={() => { setSelected(a); loadMovements(a._id); }}>
            <div className="flex justify-between">
              <div>
                <p className="font-semibold">{a.name}</p>
                <p className="text-xs text-slate-500">{a.bank} · {a.accountType}</p>
                <p className="font-mono text-xs text-slate-400">{a.accountNumber}</p>
              </div>
              <div className="flex gap-1">
                <button onClick={(e) => { e.stopPropagation(); setEditing(a); setForm({ ...a, chartAccount: a.chartAccount?._id || a.chartAccount }); setShowAcc(true); }} className="text-blue-600"><HiOutlinePencilSquare className="w-4 h-4" /></button>
                <button onClick={(e) => { e.stopPropagation(); remove(a); }} className="text-rose-600"><HiOutlineTrash className="w-4 h-4" /></button>
              </div>
            </div>
            <p className="text-2xl font-bold text-emerald-700 mt-2">${fmt(balanceOf(a._id))}</p>
          </div>
        ))}
      </div>

      {selected && (
        <div className="bg-white rounded-xl p-4 shadow-sm border border-emerald-100">
          <div className="flex justify-between items-center mb-3">
            <h2 className="font-semibold">Movimientos · {selected.name}</h2>
            <button onClick={() => { setMovForm({ bankAccount: selected._id, date: today(), type: 'DEPOSITO', amount: 0, counterpartAccount: '', description: '', reference: '', voucherNumber: '', voucherUrl: '' }); setShowMov(true); }} className="px-3 py-1.5 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 text-sm">+ Movimiento</button>
          </div>
          <table className="tbl">
            <thead className="bg-slate-50 text-xs uppercase"><tr>
              <th className="px-2 py-1 text-left">Fecha</th><th className="px-2 py-1 text-left">Tipo</th>
              <th className="px-2 py-1 text-left">Descripción</th><th className="px-2 py-1 text-left">Ref</th>
              <th className="px-2 py-1 text-right">Monto</th><th className="px-2 py-1 text-center">Concil.</th>
            </tr></thead>
            <tbody>
              {movements.map((m) => (
                <tr key={m._id} className={`border-t ${m.voided ? 'line-through text-slate-400' : ''}`}>
                  <td className="px-2 py-1">{fmtDate(m.date)}</td>
                  <td className="px-2 py-1 text-xs">{m.type}</td>
                  <td className="px-2 py-1">{m.description}</td>
                  <td className="px-2 py-1 text-xs">{m.reference || m.checkNumber}</td>
                  <td className={`px-2 py-1 text-right font-mono ${m.direction > 0 ? 'text-emerald-700' : 'text-rose-600'}`}>{m.direction > 0 ? '+' : '-'}${fmt(m.amount)}</td>
                  <td className="px-2 py-1 text-center">{m.reconciled ? '✓' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal isOpen={showAcc} onClose={() => setShowAcc(false)} title={editing ? 'Editar cuenta bancaria' : 'Nueva cuenta bancaria'} size="lg">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input required placeholder="Nombre" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5" />
            <input required placeholder="Banco" value={form.bank} onChange={(e) => setForm({ ...form, bank: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5" />
            <input required placeholder="Nro de cuenta" value={form.accountNumber} onChange={(e) => setForm({ ...form, accountNumber: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5" />
            <select value={form.accountType} onChange={(e) => setForm({ ...form, accountType: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5">
              <option>CORRIENTE</option><option>AHORROS</option><option>VIRTUAL</option>
            </select>
            <input placeholder="Ciudad" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5" />
            <input type="number" step="0.01" placeholder="Saldo inicial" value={form.initialBalance} onChange={(e) => setForm({ ...form, initialBalance: +e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5" />
            <input type="number" placeholder="Próximo cheque #" value={form.nextCheckNumber} onChange={(e) => setForm({ ...form, nextCheckNumber: +e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5" />
            <select required value={form.chartAccount} onChange={(e) => setForm({ ...form, chartAccount: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5">
              <option value="">Cuenta contable...</option>
              {chart.filter((c) => c.code?.startsWith('1.1.01')).map((c) => <option key={c._id} value={c._id}>{c.code} {c.name}</option>)}
            </select>
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShowAcc(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Guardar</button></div>
        </form>
      </Modal>

      <Modal isOpen={showMov} onClose={() => setShowMov(false)} title="Nuevo movimiento" size="lg">
        <form onSubmit={submitMov} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <select required value={movForm.bankAccount} onChange={(e) => setMovForm({ ...movForm, bankAccount: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5">
              <option value="">Cuenta...</option>{accounts.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}
            </select>
            <select value={movForm.type} onChange={(e) => setMovForm({ ...movForm, type: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5">
              <option>DEPOSITO</option><option>RETIRO</option><option>CHEQUE_EMITIDO</option>
              <option>COMISION</option><option>INTERES</option><option>AJUSTE</option>
              <option>TRANSFERENCIA_OUT</option><option>TRANSFERENCIA_IN</option>
            </select>
            <input type="date" required value={movForm.date} onChange={(e) => setMovForm({ ...movForm, date: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5" />
            <input type="number" step="0.01" required placeholder="Monto" value={movForm.amount} onChange={(e) => setMovForm({ ...movForm, amount: +e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5" />
            <input
              placeholder={['DEPOSITO', 'TRANSFERENCIA_IN', 'TRANSFERENCIA_OUT', 'CHEQUE_EMITIDO'].includes(movForm.type) ? 'N° Comprobante (requerido)' : 'N° Comprobante'}
              required={['DEPOSITO', 'TRANSFERENCIA_IN', 'TRANSFERENCIA_OUT', 'CHEQUE_EMITIDO'].includes(movForm.type)}
              value={movForm.voucherNumber}
              onChange={(e) => setMovForm({ ...movForm, voucherNumber: e.target.value })}
              className="border border-slate-200 rounded-xl px-3.5 py-2.5"
            />
            <input placeholder="URL comprobante (opcional)" value={movForm.voucherUrl} onChange={(e) => setMovForm({ ...movForm, voucherUrl: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5" />
            <input placeholder="Referencia adicional" value={movForm.reference} onChange={(e) => setMovForm({ ...movForm, reference: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5" />
            {(movForm.type === 'TRANSFERENCIA_OUT' || movForm.type === 'TRANSFERENCIA_IN') &&
              <select required value={movForm.counterpartAccount || ''} onChange={(e) => setMovForm({ ...movForm, counterpartAccount: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5">
                <option value="">Banco contraparte...</option>{accounts.filter((a) => a._id !== movForm.bankAccount).map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}
              </select>}
          </div>
          {['DEPOSITO', 'TRANSFERENCIA_IN', 'TRANSFERENCIA_OUT', 'CHEQUE_EMITIDO'].includes(movForm.type) && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              ⚠ Este tipo de movimiento requiere número de comprobante (papeleta de depósito, transferencia o cheque).
            </div>
          )}
          <input placeholder="Descripción" value={movForm.description} onChange={(e) => setMovForm({ ...movForm, description: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShowMov(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Registrar</button></div>
        </form>
      </Modal>
    </div>
  );
}
