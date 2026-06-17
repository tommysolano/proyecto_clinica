import { useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineGift, HiOutlineArrowDownTray } from 'react-icons/hi2';
import Field from '../../components/Field';
import { fmt, fmtDate, downloadBlob } from './_utils';

export default function Decimos() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [type, setType] = useState('DECIMO_TERCERO');
  const [data, setData] = useState(null);

  const generate = async () => {
    try { const r = await api.get('/payroll/decimos', { params: { year, type } }); setData(r.data); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const exportCsv = () => {
    if (!data?.rows?.length) return;
    const header = 'Cedula,Empleado,Sueldo base,Meses trabajados,Valor decimo\n';
    const body = data.rows.map((r) => `${r.identificacion},"${r.employeeName}",${r.baseSalary},${r.monthsWorked},${r.amount}`).join('\n');
    downloadBlob(header + body, `${type.toLowerCase()}_${year}.csv`, 'text/csv');
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineGift className="text-emerald-600" /> Plantillas de Décimos</h1>
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-3 flex gap-2 items-end flex-wrap">
        <Field label="Tipo de décimo"><select value={type} onChange={(e) => setType(e.target.value)} className="border border-slate-200 rounded-xl px-3.5 py-2">
          <option value="DECIMO_TERCERO">Décimo Tercero (13ro)</option>
          <option value="DECIMO_CUARTO">Décimo Cuarto (14to)</option>
        </select></Field>
        <Field label="Año"><input type="number" value={year} onChange={(e) => setYear(+e.target.value)} className="border border-slate-200 rounded-xl px-3.5 py-2 w-28" /></Field>
        <button onClick={generate} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 h-[38px]">Generar</button>
        {data && <button onClick={exportCsv} className="px-4 py-2 bg-slate-700 text-white rounded-lg flex items-center gap-2"><HiOutlineArrowDownTray /> Excel/CSV</button>}
      </div>
      {data && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
          <div className="p-3 text-sm text-slate-500 border-b">Período: {fmtDate(data.periodStart)} — {fmtDate(data.periodEnd)} · Total: <span className="font-semibold text-slate-800">${fmt(data.total)}</span></div>
          <table className="tbl">
            <thead className="bg-emerald-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Cédula</th><th className="px-3 py-2 text-left">Empleado</th><th className="px-3 py-2 text-right">Sueldo base</th><th className="px-3 py-2 text-right">Meses</th><th className="px-3 py-2 text-right">Valor décimo</th></tr></thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.employee} className="border-t"><td className="px-3 py-2 font-mono text-xs">{r.identificacion}</td><td className="px-3 py-2">{r.employeeName}</td><td className="px-3 py-2 text-right font-mono">{fmt(r.baseSalary)}</td><td className="px-3 py-2 text-right">{r.monthsWorked}</td><td className="px-3 py-2 text-right font-mono font-semibold">{fmt(r.amount)}</td></tr>
              ))}
              {data.rows.length === 0 && <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-400">Sin empleados elegibles</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
