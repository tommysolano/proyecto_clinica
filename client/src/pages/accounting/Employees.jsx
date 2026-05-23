import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlinePlus, HiOutlineUserGroup, HiOutlinePencilSquare, HiOutlineTrash, HiOutlineClock } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';

const EMPTY = { code: '', identificacion: '', tipoIdentificacion: 'CEDULA', firstName: '', lastName: '', email: '', phone: '', position: '', department: '', contractType: 'INDEFINIDO', paymentFrequency: 'MENSUAL', salaryType: 'GROSS', baseSalary: 460, netSalary: 0, salaryChangeReason: '', hireDate: today(), chargesFamily: 0, receivesDecimoTercero: 'MENSUALIZADO', receivesDecimoCuarto: 'MENSUALIZADO', receivesFondosReserva: 'MENSUALIZADO' };

// Estimación cliente del bruto a partir del neto (solo IESS 9.45%).
const IESS_PERSONAL = 0.0945;
const grossUp = (net) => (net > 0 ? +(net / (1 - IESS_PERSONAL)).toFixed(2) : 0);

export default function Employees() {
  const [list, setList] = useState([]);
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [history, setHistory] = useState(null);

  const load = async () => {
    try { const r = await api.get('/payroll/employees'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => { load(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    try {
      const payload = { ...form };
      if (payload.salaryType === 'NET') {
        payload.baseSalary = grossUp(Number(payload.netSalary || 0));
      } else {
        payload.netSalary = 0;
      }
      if (editing) await api.put(`/payroll/employees/${editing._id}`, payload);
      else await api.post('/payroll/employees', payload);
      toast.success('Guardado'); setShow(false); setEditing(null); setForm(EMPTY); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };
  const remove = async (s) => { if (!confirm('¿Eliminar?')) return; try { await api.delete(`/payroll/employees/${s._id}`); load(); } catch (e) { toast.error(e.response?.data?.message || 'Error'); } };

  // Estimación del neto en pantalla (solo IESS personal; sin IR) — para feedback rápido
  const previewNeto = (() => {
    const bruto = form.salaryType === 'NET' ? grossUp(Number(form.netSalary || 0)) : Number(form.baseSalary || 0);
    if (!bruto) return 0;
    return +(bruto * (1 - IESS_PERSONAL)).toFixed(2);
  })();

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
            <th className="px-3 py-2 text-left">Ingreso</th>
            <th className="px-3 py-2 text-center">Tipo</th>
            <th className="px-3 py-2 text-right">Bruto</th>
            <th className="px-3 py-2 text-right">Neto</th>
            <th></th>
          </tr></thead>
          <tbody>
            {list.map((e) => (
              <tr key={e._id} className="border-t">
                <td className="px-3 py-2 font-mono text-xs">{e.code}</td>
                <td className="px-3 py-2 font-mono text-xs">{e.identificacion}</td>
                <td className="px-3 py-2">{e.firstName} {e.lastName}</td>
                <td className="px-3 py-2 text-xs">{e.position}</td>
                <td className="px-3 py-2 text-xs">{fmtDate(e.hireDate)}</td>
                <td className="px-3 py-2 text-xs text-center">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${e.salaryType === 'NET' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-700'}`}>
                    {e.salaryType || 'GROSS'}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono">${fmt(e.baseSalary)}</td>
                <td className="px-3 py-2 text-right font-mono">{e.salaryType === 'NET' ? `$${fmt(e.netSalary)}` : '—'}</td>
                <td className="px-3 py-2 flex gap-1 justify-end">
                  <button title="Historial de sueldo" onClick={() => setHistory(e)} className="text-slate-600"><HiOutlineClock className="w-4 h-4" /></button>
                  <button onClick={() => { setEditing(e); setForm({ ...EMPTY, ...e, salaryType: e.salaryType || 'GROSS', salaryChangeReason: '', hireDate: e.hireDate?.slice(0, 10) }); setShow(true); }} className="text-blue-600"><HiOutlinePencilSquare className="w-4 h-4" /></button>
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
            <input type="number" placeholder="Cargas familiares" value={form.chargesFamily} onChange={(e) => setForm({ ...form, chargesFamily: +e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
          </div>
          {/* Sección de sueldo (NET/GROSS) */}
          <div className="bg-emerald-50/60 border border-emerald-100 rounded-xl p-3 space-y-3">
            <div className="text-sm font-semibold text-emerald-800">Sueldo</div>
            <div className="grid grid-cols-3 gap-3 items-end">
              <label className="text-xs flex flex-col gap-1">
                <span className="text-slate-600">Tipo de sueldo</span>
                <select value={form.salaryType} onChange={(e) => setForm({ ...form, salaryType: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2">
                  <option value="GROSS">Bruto (estándar)</option>
                  <option value="NET">Neto pactado (gross-up)</option>
                </select>
              </label>
              {form.salaryType === 'GROSS' ? (
                <label className="text-xs flex flex-col gap-1">
                  <span className="text-slate-600">Sueldo bruto mensual</span>
                  <input type="number" step="0.01" required value={form.baseSalary} onChange={(e) => setForm({ ...form, baseSalary: +e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
                </label>
              ) : (
                <label className="text-xs flex flex-col gap-1">
                  <span className="text-slate-600">Neto a recibir</span>
                  <input type="number" step="0.01" required value={form.netSalary} onChange={(e) => setForm({ ...form, netSalary: +e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
                </label>
              )}
              <div className="text-xs text-slate-600">
                {form.salaryType === 'NET' ? (
                  <>
                    <div>Bruto calculado: <span className="font-mono font-semibold">${fmt(grossUp(Number(form.netSalary || 0)))}</span></div>
                    <div className="text-[10px] text-slate-500">Gross-up sobre IESS 9.45%</div>
                  </>
                ) : (
                  <>
                    <div>Neto estimado: <span className="font-mono font-semibold">${fmt(previewNeto)}</span></div>
                    <div className="text-[10px] text-slate-500">Solo descuento IESS personal (IR se calcula en rol)</div>
                  </>
                )}
              </div>
            </div>
            {editing && (
              <input placeholder="Razón del cambio (auditoría)" value={form.salaryChangeReason} onChange={(e) => setForm({ ...form, salaryChangeReason: e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <select value={form.receivesDecimoTercero} onChange={(e) => setForm({ ...form, receivesDecimoTercero: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2"><option>MENSUALIZADO</option><option>ACUMULADO</option></select>
            <select value={form.receivesDecimoCuarto} onChange={(e) => setForm({ ...form, receivesDecimoCuarto: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2"><option>MENSUALIZADO</option><option>ACUMULADO</option></select>
            <select value={form.receivesFondosReserva} onChange={(e) => setForm({ ...form, receivesFondosReserva: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2"><option>MENSUALIZADO</option><option>ACUMULADO</option></select>
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-lg">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-lg">Guardar</button></div>
        </form>
      </Modal>
      <Modal isOpen={!!history} onClose={() => setHistory(null)} title={`Historial de sueldo - ${history?.firstName || ''} ${history?.lastName || ''}`} size="lg">
        {history && (
          <div className="space-y-2">
            {(history.salaryHistory || []).length === 0 && <div className="text-sm text-slate-500">Sin cambios registrados.</div>}
            <table className="w-full text-xs">
              <thead className="bg-slate-100"><tr>
                <th className="px-2 py-1 text-left">Fecha</th>
                <th className="px-2 py-1 text-center">De</th>
                <th className="px-2 py-1 text-center">A</th>
                <th className="px-2 py-1 text-left">Motivo</th>
              </tr></thead>
              <tbody>
                {(history.salaryHistory || []).slice().reverse().map((h, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-2 py-1">{fmtDate(h.date)}</td>
                    <td className="px-2 py-1 text-center font-mono">
                      {h.previousSalary ? `${h.previousType || 'GROSS'} $${fmt(h.previousSalary)}${h.previousNet ? ` (neto $${fmt(h.previousNet)})` : ''}` : '—'}
                    </td>
                    <td className="px-2 py-1 text-center font-mono">
                      {h.newType || 'GROSS'} ${fmt(h.newSalary)}{h.newNet ? ` (neto $${fmt(h.newNet)})` : ''}
                    </td>
                    <td className="px-2 py-1">{h.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </div>
  );
}
