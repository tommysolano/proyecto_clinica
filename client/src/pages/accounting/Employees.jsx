import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlinePlus, HiOutlineUserGroup, HiOutlinePencilSquare, HiOutlineTrash, HiOutlineClock } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';

const EMPTY = { code: '', identificacion: '', tipoIdentificacion: 'CEDULA', firstName: '', lastName: '', email: '', phone: '', position: '', department: '', contractType: 'INDEFINIDO', paymentFrequency: 'MENSUAL', salaryType: 'GROSS', baseSalary: 460, netSalary: 0, salaryChangeReason: '', hireDate: today(), chargesFamily: 0, deductible: true, salaryOriginClinic: '', bankName: '', bankAccount: '', bankAccountType: '', receivesDecimoTercero: true, receivesDecimoCuarto: true, receivesFondosReserva: false, decimoTerceroAcumulado: 'MENSUALIZADO', decimoCuartoAcumulado: 'MENSUALIZADO', fondosReservaAcumulado: 'MENSUALIZADO', user: '' };

// Separa un nombre completo en nombres/apellidos (heurística simple ES).
const splitName = (full = '') => {
  const parts = full.trim().split(/\s+/);
  if (parts.length <= 1) return { firstName: full.trim(), lastName: '' };
  if (parts.length === 2) return { firstName: parts[0], lastName: parts[1] };
  if (parts.length === 3) return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
  return { firstName: parts.slice(0, 2).join(' '), lastName: parts.slice(2).join(' ') };
};

// Estimación cliente del bruto a partir del neto (solo IESS 9.45%).
const IESS_PERSONAL = 0.0945;
const grossUp = (net) => (net > 0 ? +(net / (1 - IESS_PERSONAL)).toFixed(2) : 0);

export default function Employees() {
  const [list, setList] = useState([]);
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [history, setHistory] = useState(null);
  const [clinics, setClinics] = useState([]);
  const [users, setUsers] = useState([]);

  const load = async () => {
    try { const r = await api.get('/payroll/employees'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
    try { const u = await api.get('/payroll/linkable-users'); setUsers(u.data || []); }
    catch { /* sin permiso: ignorar */ }
  };
  useEffect(() => { load(); api.get('/clinics').then((r) => setClinics(r.data || [])).catch(() => {}); }, []);

  // Abre el modal de alta precargado con los datos de un usuario del sistema.
  const openFromUser = (u) => {
    const { firstName, lastName } = splitName(u.name);
    setEditing(null);
    setForm({
      ...EMPTY,
      firstName, lastName,
      email: u.email || '',
      phone: u.phone || '',
      identificacion: u.cedula || '',
      code: u.cedula || '',
      user: u._id,
    });
    setShow(true);
  };

  const pendingUsers = users.filter((u) => !u.hasEmployee);

  const submit = async (e) => {
    e.preventDefault();
    try {
      const payload = { ...form };
      if (!payload.salaryOriginClinic) payload.salaryOriginClinic = null;
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
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineUserGroup className="text-emerald-600" /> Empleados</h1>
        <button onClick={() => { setEditing(null); setForm(EMPTY); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nuevo</button>
      </div>

      {/* Usuarios del sistema sin ficha de empleado */}
      {pendingUsers.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
          <p className="text-sm font-semibold text-amber-800 mb-1">Usuarios del sistema sin ficha de empleado ({pendingUsers.length})</p>
          <p className="text-xs text-amber-700 mb-3">Personas con cuenta/acceso al sistema que aún no están registradas como empleados. Completa sus datos para incluirlas en la nómina.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {pendingUsers.map((u) => (
              <div key={u._id} className="bg-white border border-amber-100 rounded-xl px-3 py-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate">{u.name}</p>
                  <p className="text-xs text-slate-500 truncate">{u.email}{u.role ? ` · ${u.role}` : ''}</p>
                </div>
                <button onClick={() => openFromUser(u)} className="shrink-0 px-2.5 py-1.5 bg-emerald-600 text-white rounded-lg text-xs flex items-center gap-1"><HiOutlinePlus className="w-3.5 h-3.5" /> Registrar</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
        <table className="tbl">
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
          {form.user && (
            <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-lg px-3 py-2">
              Vinculado a un usuario del sistema. Completa los datos laborales para registrarlo como empleado.
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Código" required><input required placeholder="Ej: EMP-01" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Tipo de identificación"><select value={form.tipoIdentificacion} onChange={(e) => setForm({ ...form, tipoIdentificacion: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5"><option>CEDULA</option><option>RUC</option><option>PASAPORTE</option></select></Field>
            <Field label="Identificación" required className="col-span-2"><input required placeholder="Nº de cédula / RUC" value={form.identificacion} onChange={(e) => setForm({ ...form, identificacion: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Nombres" required><input required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Apellidos" required><input required value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Email"><input placeholder="correo@dominio.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Teléfono"><input placeholder="09xxxxxxxx" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Cargo"><input value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Departamento"><input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Tipo de contrato"><select value={form.contractType} onChange={(e) => setForm({ ...form, contractType: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5"><option>INDEFINIDO</option><option>FIJO</option><option>EVENTUAL</option><option>JUVENIL</option></select></Field>
            <Field label="Frecuencia de pago"><select value={form.paymentFrequency} onChange={(e) => setForm({ ...form, paymentFrequency: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5"><option>MENSUAL</option><option>QUINCENAL</option></select></Field>
            <Field label="Fecha de ingreso" required><input type="date" required value={form.hireDate} onChange={(e) => setForm({ ...form, hireDate: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Cargas familiares"><input type="number" value={form.chargesFamily} onChange={(e) => setForm({ ...form, chargesFamily: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
          </div>
          {/* Sección de sueldo (NET/GROSS) */}
          <div className="bg-emerald-50/60 border border-emerald-100 rounded-xl p-3 space-y-3">
            <div className="text-sm font-semibold text-emerald-800">Sueldo</div>
            <div className="grid grid-cols-3 gap-3 items-end">
              <label className="text-xs flex flex-col gap-1">
                <span className="text-slate-600">Tipo de sueldo</span>
                <select value={form.salaryType} onChange={(e) => setForm({ ...form, salaryType: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5">
                  <option value="GROSS">Bruto (estándar)</option>
                  <option value="NET">Neto pactado (gross-up)</option>
                </select>
              </label>
              {form.salaryType === 'GROSS' ? (
                <label className="text-xs flex flex-col gap-1">
                  <span className="text-slate-600">Sueldo bruto mensual</span>
                  <input type="number" step="0.01" required value={form.baseSalary} onChange={(e) => setForm({ ...form, baseSalary: +e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5" />
                </label>
              ) : (
                <label className="text-xs flex flex-col gap-1">
                  <span className="text-slate-600">Neto a recibir</span>
                  <input type="number" step="0.01" required value={form.netSalary} onChange={(e) => setForm({ ...form, netSalary: +e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5" />
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
              <input placeholder="Razón del cambio (auditoría)" value={form.salaryChangeReason} onChange={(e) => setForm({ ...form, salaryChangeReason: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
            )}
          </div>
          <div className="bg-slate-50 border border-slate-100 rounded-xl p-3 space-y-3">
            <div className="text-sm font-semibold text-slate-700">Beneficios sociales</div>
            <div className="flex gap-4 flex-wrap">
              <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={form.receivesDecimoTercero} onChange={(e) => setForm({ ...form, receivesDecimoTercero: e.target.checked })} /> Décimo tercero</label>
              <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={form.receivesDecimoCuarto} onChange={(e) => setForm({ ...form, receivesDecimoCuarto: e.target.checked })} /> Décimo cuarto</label>
              <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={form.receivesFondosReserva} onChange={(e) => setForm({ ...form, receivesFondosReserva: e.target.checked })} /> Fondos de reserva</label>
              <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={form.deductible} onChange={(e) => setForm({ ...form, deductible: e.target.checked })} /> Gasto deducible</label>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Décimo 13ro</span><select value={form.decimoTerceroAcumulado} onChange={(e) => setForm({ ...form, decimoTerceroAcumulado: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5"><option>MENSUALIZADO</option><option>ACUMULADO</option></select></label>
              <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Décimo 14to</span><select value={form.decimoCuartoAcumulado} onChange={(e) => setForm({ ...form, decimoCuartoAcumulado: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5"><option>MENSUALIZADO</option><option>ACUMULADO</option></select></label>
              <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Fondos reserva</span><select value={form.fondosReservaAcumulado} onChange={(e) => setForm({ ...form, fondosReservaAcumulado: e.target.value })} className="border border-slate-200 rounded-xl px-3.5 py-2.5"><option>MENSUALIZADO</option><option>ACUMULADO</option></select></label>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Origen del sueldo (sede)">
              <select value={form.salaryOriginClinic} onChange={(e) => setForm({ ...form, salaryOriginClinic: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                <option value="">Seleccione…</option>{clinics.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Banco"><input value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Nº cuenta bancaria"><input value={form.bankAccount} onChange={(e) => setForm({ ...form, bankAccount: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Tipo de cuenta"><select value={form.bankAccountType} onChange={(e) => setForm({ ...form, bankAccountType: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5"><option value="">Seleccione…</option><option value="AHORROS">Ahorros</option><option value="CORRIENTE">Corriente</option></select></Field>
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Guardar</button></div>
        </form>
      </Modal>
      <Modal isOpen={!!history} onClose={() => setHistory(null)} title={`Historial de sueldo - ${history?.firstName || ''} ${history?.lastName || ''}`} size="lg">
        {history && (
          <div className="space-y-2">
            {(history.salaryHistory || []).length === 0 && <div className="text-sm text-slate-500">Sin cambios registrados.</div>}
            <table className="tbl text-xs">
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
