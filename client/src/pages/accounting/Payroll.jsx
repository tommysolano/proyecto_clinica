import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlinePlus, HiOutlineCalculator, HiOutlineLockClosed, HiOutlineCheck } from 'react-icons/hi2';
import { fmt } from './_utils';
import NumericInput from '../../components/NumericInput';
import useDocDeepLink from '../../hooks/useDocDeepLink';

export default function Payroll() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [list, setList] = useState([]);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ year: new Date().getFullYear(), month: new Date().getMonth() + 1 });
  const [selected, setSelected] = useState(null);
  const [banks, setBanks] = useState([]);
  const [payModal, setPayModal] = useState(null); // { bankAccountId, date }

  const load = async () => {
    try { const r = await api.get('/payroll', { params: { year } }); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [year]);
  useEffect(() => { api.get('/banks/accounts').then((r) => setBanks(r.data || [])).catch(() => {}); }, []);

  const generate = async (e) => {
    e.preventDefault();
    try { const r = await api.post('/payroll/generate', form); toast.success('Generado'); setShow(false); setSelected(r.data); load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  const open = async (p) => {
    const r = await api.get(`/payroll/${p._id}`); setSelected(r.data);
  };

  // Deep-link desde el Libro Mayor (?doc=<id>): abre la planilla de nómina.
  useDocDeepLink(async (id) => {
    try { await open({ _id: id }); }
    catch (e) { toast.error(e.response?.data?.message || 'No se encontró la planilla'); }
  });
  const updateItem = async (idx, patch) => {
    const items = [...selected.items]; items[idx] = { ...items[idx], ...patch };
    setSelected({ ...selected, items });
    const employeeId = items[idx].employee?._id || items[idx].employee;
    try { const r = await api.put(`/payroll/${selected._id}/item`, { employeeId, patch }); setSelected(r.data); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  const close = async () => {
    if (!confirm('¿Cerrar planilla y generar asiento?')) return;
    try { const r = await api.post(`/payroll/${selected._id}/close`); setSelected(r.data); load(); toast.success('Cerrada'); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  // Pago sin banco (legacy: solo cambia el estado).
  const markPaid = async () => {
    if (!confirm('¿Marcar como pagada sin registrar movimiento bancario?')) return;
    try { const r = await api.post(`/payroll/${selected._id}/pay`); setSelected(r.data); load(); toast.success('Pagada'); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  // Pago desde banco: genera asiento + transacción bancaria.
  const payFromBank = async () => {
    if (!payModal?.bankAccountId) { toast.error('Selecciona un banco'); return; }
    try {
      const r = await api.post(`/payroll/${selected._id}/pay`, { bankAccountId: payModal.bankAccountId, date: payModal.date });
      setSelected(r.data); setPayModal(null); load(); toast.success('Nómina pagada desde banco');
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineCalculator className="text-emerald-600" /> Nómina</h1>
        <div className="flex gap-2 items-end">
          <Field label="Año"><NumericInput value={year} onChange={(e) => setYear(+e.target.value)} className="w-24 border border-slate-200 rounded-xl px-3.5 py-2" /></Field>
          <button onClick={() => setShow(true)} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2 h-[38px]"><HiOutlinePlus /> Generar período</button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
          <table className="tbl">
            <thead className="bg-emerald-50 text-xs uppercase"><tr><th className="px-2 py-2 text-left">Período</th><th className="px-2 py-2 text-right">Neto</th><th className="px-2 py-2 text-center">Estado</th></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p._id} className="border-t cursor-pointer hover:bg-slate-50" onClick={() => open(p)}>
                  <td className="px-2 py-2 font-mono text-xs">{p.period}</td>
                  <td className="px-2 py-2 text-right font-mono">${fmt(p.totalNeto)}</td>
                  <td className="px-2 py-2 text-center text-xs">{p.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selected && (
          <div className="md:col-span-2 bg-white rounded-xl p-4 shadow-sm overflow-auto">
            <div className="flex justify-between items-center mb-3">
              <h2 className="font-semibold">Nómina {selected.period} — {selected.status}</h2>
              <div className="flex gap-2">
                {selected.status === 'BORRADOR' && <button onClick={close} className="px-3 py-1.5 bg-emerald-600 text-white rounded text-sm flex items-center gap-1"><HiOutlineLockClosed /> Cerrar</button>}
                {selected.status === 'CERRADO' && <button onClick={() => setPayModal({ bankAccountId: banks[0]?._id || '', date: new Date().toISOString().slice(0, 10) })} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm flex items-center gap-1"><HiOutlineCheck /> Pagar desde banco</button>}
                {selected.status === 'CERRADO' && <button onClick={markPaid} className="px-3 py-1.5 bg-slate-200 text-slate-700 rounded text-sm">Marcar pagado (sin banco)</button>}
              </div>
            </div>
            <table className="tbl text-xs">
              <thead className="bg-slate-100"><tr>
                <th className="px-1 py-1 text-left">Empleado</th>
                <th className="px-1 py-1 text-right">Faltas</th>
                <th className="px-1 py-1 text-right">Sueldo</th>
                <th className="px-1 py-1 text-right">D3</th>
                <th className="px-1 py-1 text-right">D4</th>
                <th className="px-1 py-1 text-right">FR</th>
                <th className="px-1 py-1 text-right">IESS</th>
                <th className="px-1 py-1 text-right">IR</th>
                <th className="px-1 py-1 text-right">Prest</th>
                <th className="px-1 py-1 text-right">Deducc.</th>
                <th className="px-1 py-1 text-right">Neto</th>
              </tr></thead>
              <tbody>
                {selected.items.map((it, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-1 py-1">{it.employeeName || `${it.employee?.firstName || ''} ${it.employee?.lastName || ''}`.trim()}</td>
                    <td className="px-1 py-1 text-right">
                      {selected.status === 'BORRADOR'
                        ? <NumericInput min="0" max="30" value={it.absenceDays || 0} onChange={(e) => updateItem(i, { absenceDays: +e.target.value })} className="w-12 border border-slate-200 rounded px-1 text-right" />
                        : (it.absenceDays || 0)}
                    </td>
                    <td className="px-1 py-1 text-right font-mono">{fmt(it.baseSalary)}</td>
                    <td className="px-1 py-1 text-right font-mono">{fmt(it.decimoTercero)}</td>
                    <td className="px-1 py-1 text-right font-mono">{fmt(it.decimoCuarto)}</td>
                    <td className="px-1 py-1 text-right font-mono">{fmt(it.fondosReserva)}</td>
                    <td className="px-1 py-1 text-right font-mono text-rose-600">{fmt(it.iessPersonal)}</td>
                    <td className="px-1 py-1 text-right font-mono text-rose-600">{fmt(it.impuestoRenta)}</td>
                    <td className="px-1 py-1 text-right">
                      {selected.status === 'BORRADOR' ?
                        <NumericInput step="0.01" value={it.prestamoEmpresa} onChange={(e) => updateItem(i, { prestamoEmpresa: +e.target.value })} className="w-16 border border-slate-200 rounded px-1 text-right" /> :
                        fmt(it.prestamoEmpresa)}
                    </td>
                    <td className="px-1 py-1 text-right font-mono text-rose-600">{fmt((it.multas || 0) + (it.anticipos || 0) + (it.otherDeductions || 0))}</td>
                    <td className="px-1 py-1 text-right font-mono font-semibold">${fmt(it.netoPagar)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal isOpen={!!payModal} onClose={() => setPayModal(null)} title="Pagar nómina desde banco">
        {payModal && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">Neto a pagar: <b>${fmt(selected?.totalNeto)}</b></p>
            <Field label="Banco" required>
              <select value={payModal.bankAccountId} onChange={(e) => setPayModal({ ...payModal, bankAccountId: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                <option value="">Seleccione…</option>
                {banks.map((b) => <option key={b._id} value={b._id}>{b.name} · {b.bank} {b.accountNumber}</option>)}
              </select>
            </Field>
            <Field label="Fecha de pago"><input type="date" value={payModal.date} onChange={(e) => setPayModal({ ...payModal, date: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <p className="text-xs text-slate-500">Se generará el asiento (Sueldos por pagar → Banco) y una transacción bancaria.</p>
            <div className="flex justify-end gap-2"><button onClick={() => setPayModal(null)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button onClick={payFromBank} className="px-4 py-2 bg-blue-600 text-white rounded-xl">Pagar</button></div>
          </div>
        )}
      </Modal>

      <Modal isOpen={show} onClose={() => setShow(false)} title="Generar nómina">
        <form onSubmit={generate} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Año" required><NumericInput required value={form.year} onChange={(e) => setForm({ ...form, year: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Mes (1-12)" required><NumericInput min="1" max="12" required value={form.month} onChange={(e) => setForm({ ...form, month: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Generar</button></div>
        </form>
      </Modal>
    </div>
  );
}
