import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlinePlus, HiOutlineCalculator, HiOutlineLockClosed, HiOutlineCheck } from 'react-icons/hi2';
import { fmt } from './_utils';

export default function Payroll() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [list, setList] = useState([]);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState({ year: new Date().getFullYear(), month: new Date().getMonth() + 1 });
  const [selected, setSelected] = useState(null);

  const load = async () => {
    try { const r = await api.get('/payroll', { params: { year } }); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [year]);

  const generate = async (e) => {
    e.preventDefault();
    try { const r = await api.post('/payroll/generate', form); toast.success('Generado'); setShow(false); setSelected(r.data); load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  const open = async (p) => {
    const r = await api.get(`/payroll/${p._id}`); setSelected(r.data);
  };
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
  const markPaid = async () => {
    try { const r = await api.post(`/payroll/${selected._id}/pay`); setSelected(r.data); load(); toast.success('Pagada'); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineCalculator className="text-emerald-600" /> Nómina</h1>
        <div className="flex gap-2 items-end">
          <Field label="Año"><input type="number" value={year} onChange={(e) => setYear(+e.target.value)} className="w-24 border border-slate-200 rounded-xl px-3.5 py-2" /></Field>
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
                {selected.status === 'CERRADO' && <button onClick={markPaid} className="px-3 py-1.5 bg-blue-600 text-white rounded text-sm flex items-center gap-1"><HiOutlineCheck /> Marcar pagado</button>}
              </div>
            </div>
            <table className="tbl text-xs">
              <thead className="bg-slate-100"><tr>
                <th className="px-1 py-1 text-left">Empleado</th>
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
                    <td className="px-1 py-1 text-right font-mono">{fmt(it.baseSalary)}</td>
                    <td className="px-1 py-1 text-right font-mono">{fmt(it.decimoTercero)}</td>
                    <td className="px-1 py-1 text-right font-mono">{fmt(it.decimoCuarto)}</td>
                    <td className="px-1 py-1 text-right font-mono">{fmt(it.fondosReserva)}</td>
                    <td className="px-1 py-1 text-right font-mono text-rose-600">{fmt(it.iessPersonal)}</td>
                    <td className="px-1 py-1 text-right font-mono text-rose-600">{fmt(it.impuestoRenta)}</td>
                    <td className="px-1 py-1 text-right">
                      {selected.status === 'BORRADOR' ?
                        <input type="number" step="0.01" value={it.prestamoEmpresa} onChange={(e) => updateItem(i, { prestamoEmpresa: +e.target.value })} className="w-16 border border-slate-200 rounded px-1 text-right" /> :
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

      <Modal isOpen={show} onClose={() => setShow(false)} title="Generar nómina">
        <form onSubmit={generate} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Año" required><input type="number" required value={form.year} onChange={(e) => setForm({ ...form, year: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
            <Field label="Mes (1-12)" required><input type="number" min="1" max="12" required value={form.month} onChange={(e) => setForm({ ...form, month: +e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Generar</button></div>
        </form>
      </Modal>
    </div>
  );
}
