import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlinePlus, HiOutlineBanknotes } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';

const EMPTY = { employee: '', type: 'EMPRESA', principal: 0, installmentsCount: 12, startDate: today(), description: '' };

export default function EmployeeLoans() {
  const [list, setList] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState(EMPTY);

  const load = async () => {
    try { const r = await api.get('/payroll/loans'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    api.get('/payroll/employees').then((r) => setEmployees(r.data || []));
    load();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    try { await api.post('/payroll/loans', form); toast.success('Creado'); setShow(false); setForm(EMPTY); load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineBanknotes className="text-emerald-600" /> Préstamos a Empleados</h1>
        <button onClick={() => { setForm(EMPTY); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nuevo</button>
      </div>
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
        <table className="tbl">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Empleado</th><th className="px-3 py-2 text-left">Tipo</th>
            <th className="px-3 py-2 text-left">Inicio</th><th className="px-3 py-2 text-right">Capital</th>
            <th className="px-3 py-2 text-right">Cuota</th><th className="px-3 py-2 text-right">Saldo</th>
            <th className="px-3 py-2 text-center">Estado</th>
          </tr></thead>
          <tbody>
            {list.map((l) => (
              <tr key={l._id} className="border-t">
                <td className="px-3 py-2">{l.employee?.firstName} {l.employee?.lastName}</td>
                <td className="px-3 py-2 text-xs">{l.type}</td>
                <td className="px-3 py-2">{fmtDate(l.startDate)}</td>
                <td className="px-3 py-2 text-right font-mono">${fmt(l.principal)}</td>
                <td className="px-3 py-2 text-right font-mono">${fmt(l.installmentAmount)}</td>
                <td className="px-3 py-2 text-right font-mono font-semibold">${fmt(l.balance)}</td>
                <td className="px-3 py-2 text-center text-xs">{l.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal isOpen={show} onClose={() => setShow(false)} title="Nuevo préstamo">
        <form onSubmit={submit} className="space-y-3">
          <select required value={form.employee} onChange={(e) => setForm({ ...form, employee: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
            <option value="">Empleado...</option>
            {employees.map((e) => <option key={e._id} value={e._id}>{e.firstName} {e.lastName}</option>)}
          </select>
          <div className="grid grid-cols-2 gap-3">
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5"><option>EMPRESA</option><option>QUIROGRAFARIO</option><option>HIPOTECARIO</option></select>
            <input type="date" required value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5" />
            <input type="number" step="0.01" required placeholder="Capital" value={form.principal} onChange={(e) => setForm({ ...form, principal: +e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5" />
            <input type="number" required placeholder="Cuotas" value={form.installmentsCount} onChange={(e) => setForm({ ...form, installmentsCount: +e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5" />
          </div>
          <input placeholder="Descripción" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Guardar</button></div>
        </form>
      </Modal>
    </div>
  );
}
