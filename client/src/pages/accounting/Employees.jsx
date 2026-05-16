import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlinePlus, HiOutlineUserGroup, HiOutlinePencilSquare, HiOutlineTrash } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';

const EMPTY = { code: '', identificacion: '', tipoIdentificacion: 'CEDULA', firstName: '', lastName: '', email: '', phone: '', position: '', department: '', contractType: 'INDEFINIDO', paymentFrequency: 'MENSUAL', baseSalary: 460, hireDate: today(), chargesFamily: 0, receivesDecimoTercero: 'MENSUALIZADO', receivesDecimoCuarto: 'MENSUALIZADO', receivesFondosReserva: 'MENSUALIZADO' };

export default function Employees() {
  const [list, setList] = useState([]);
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);

  const load = async () => {
    try { const r = await api.get('/payroll/employees'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => { load(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    try {
      if (editing) await api.put(`/payroll/employees/${editing._id}`, form);
      else await api.post('/payroll/employees', form);
      toast.success('Guardado'); setShow(false); setEditing(null); setForm(EMPTY); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };
  const remove = async (s) => { if (!confirm('¿Eliminar?')) return; try { await api.delete(`/payroll/employees/${s._id}`); load(); } catch (e) { toast.error(e.response?.data?.message || 'Error'); } };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><HiOutlineUserGroup className="text-emerald-600" /> Empleados</h1>
        <button onClick={() => { setEditing(null); setForm(EMPTY); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-lg flex items-center gap-2"><HiOutlinePlus /> Nuevo</button>
      </div>
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Código</th><th className="px-3 py-2 text-left">Cédula</th>
            <th className="px-3 py-2 text-left">Nombre</th><th className="px-3 py-2 text-left">Cargo</th>
            <th className="px-3 py-2 text-left">Ingreso</th><th className="px-3 py-2 text-right">Sueldo</th><th></th>
          </tr></thead>
          <tbody>
            {list.map((e) => (
              <tr key={e._id} className="border-t">
                <td className="px-3 py-2 font-mono text-xs">{e.code}</td>
                <td className="px-3 py-2 font-mono text-xs">{e.identificacion}</td>
                <td className="px-3 py-2">{e.firstName} {e.lastName}</td>
                <td className="px-3 py-2 text-xs">{e.position}</td>
                <td className="px-3 py-2 text-xs">{fmtDate(e.hireDate)}</td>
                <td className="px-3 py-2 text-right font-mono">${fmt(e.baseSalary)}</td>
                <td className="px-3 py-2 flex gap-1 justify-end">
                  <button onClick={() => { setEditing(e); setForm({ ...EMPTY, ...e, hireDate: e.hireDate?.slice(0, 10) }); setShow(true); }} className="text-blue-600"><HiOutlinePencilSquare className="w-4 h-4" /></button>
                  <button onClick={() => remove(e)} className="text-rose-600"><HiOutlineTrash className="w-4 h-4" /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal isOpen={show} onClose={() => setShow(false)} title={editing ? 'Editar empleado' : 'Nuevo empleado'} size="lg">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input required placeholder="Código" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <select value={form.tipoIdentificacion} onChange={(e) => setForm({ ...form, tipoIdentificacion: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2"><option>CEDULA</option><option>RUC</option><option>PASAPORTE</option></select>
            <input required placeholder="Identificación" value={form.identificacion} onChange={(e) => setForm({ ...form, identificacion: e.target.value })} className="col-span-2 border border-slate-200 rounded-lg px-3 py-2" />
            <input required placeholder="Nombres" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input required placeholder="Apellidos" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input placeholder="Teléfono" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input placeholder="Cargo" value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input placeholder="Departamento" value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <select value={form.contractType} onChange={(e) => setForm({ ...form, contractType: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2"><option>INDEFINIDO</option><option>FIJO</option><option>EVENTUAL</option><option>JUVENIL</option></select>
            <select value={form.paymentFrequency} onChange={(e) => setForm({ ...form, paymentFrequency: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2"><option>MENSUAL</option><option>QUINCENAL</option></select>
            <input type="date" required value={form.hireDate} onChange={(e) => setForm({ ...form, hireDate: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input type="number" step="0.01" placeholder="Sueldo base" value={form.baseSalary} onChange={(e) => setForm({ ...form, baseSalary: +e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input type="number" placeholder="Cargas familiares" value={form.chargesFamily} onChange={(e) => setForm({ ...form, chargesFamily: +e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <select value={form.receivesDecimoTercero} onChange={(e) => setForm({ ...form, receivesDecimoTercero: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2"><option>MENSUALIZADO</option><option>ACUMULADO</option></select>
            <select value={form.receivesDecimoCuarto} onChange={(e) => setForm({ ...form, receivesDecimoCuarto: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2"><option>MENSUALIZADO</option><option>ACUMULADO</option></select>
            <select value={form.receivesFondosReserva} onChange={(e) => setForm({ ...form, receivesFondosReserva: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2"><option>MENSUALIZADO</option><option>ACUMULADO</option></select>
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-lg">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-lg">Guardar</button></div>
        </form>
      </Modal>
    </div>
  );
}
