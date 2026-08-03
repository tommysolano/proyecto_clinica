import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineTableCells, HiOutlineArrowPath } from 'react-icons/hi2';
import Field from '../../components/Field';
import { fmt } from './_utils';
import NumericInput from '../../components/NumericInput';
import ExcelButton from '../../components/ExcelButton';

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

export default function PeriodBalances() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try { const r = await api.get('/accounting-reports/period-balances', { params: { year, month } }); setRows(r.data.rows || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [year, month]);

  const recompute = async () => {
    try { await api.post('/accounting-reports/recompute-balances'); toast.success('Saldos recalculados'); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const tot = rows.reduce((a, r) => ({ debit: a.debit + r.debit, credit: a.credit + r.credit }), { debit: 0, credit: 0 });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineTableCells className="text-emerald-600" /> Saldos por Período</h1>
        <div className="flex gap-2 items-end">
          <Field label="Mes"><select value={month} onChange={(e) => setMonth(+e.target.value)} className="border border-slate-200 rounded-xl px-3.5 py-2 text-sm">
            {MESES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select></Field>
          <Field label="Año"><NumericInput value={year} onChange={(e) => setYear(+e.target.value)} className="w-24 border border-slate-200 rounded-xl px-3.5 py-2 text-sm" /></Field>
          <button onClick={recompute} className="px-3 py-2 bg-slate-700 text-white rounded-lg text-sm flex items-center gap-1 h-[38px]" title="Reconstruir saldos desde los asientos"><HiOutlineArrowPath /> Recalcular</button>
          <ExcelButton
            url="/accounting-reports/period-balances.xlsx"
            params={{ year, month }}
            filename={`saldos_periodo_${year}_${String(month).padStart(2, '0')}.xlsx`}
            className="h-[38px] py-0"
          />
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-x-auto">
        <table className="tbl">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Código</th><th className="px-3 py-2 text-left">Cuenta</th>
            <th className="px-3 py-2 text-right">Saldo inicial</th><th className="px-3 py-2 text-right">Débitos</th>
            <th className="px-3 py-2 text-right">Créditos</th><th className="px-3 py-2 text-right">Saldo final</th>
          </tr></thead>
          <tbody>
            {loading && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Cargando...</td></tr>}
            {!loading && rows.map((r) => (
              <tr key={r.account._id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-1.5 font-mono text-xs">{r.account.code}</td>
                <td className="px-3 py-1.5">{r.account.name}</td>
                <td className="px-3 py-1.5 text-right font-mono">{fmt(r.opening)}</td>
                <td className="px-3 py-1.5 text-right font-mono">{fmt(r.debit)}</td>
                <td className="px-3 py-1.5 text-right font-mono">{fmt(r.credit)}</td>
                <td className="px-3 py-1.5 text-right font-mono font-semibold">{fmt(r.closing)}</td>
              </tr>
            ))}
            {!loading && !rows.length && <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">Sin movimientos. Si esperabas datos, pulsa "Recalcular".</td></tr>}
          </tbody>
          {rows.length > 0 && <tfoot className="bg-slate-50 font-semibold"><tr><td colSpan={3} className="px-3 py-2 text-right">Totales del período:</td><td className="px-3 py-2 text-right font-mono">{fmt(tot.debit)}</td><td className="px-3 py-2 text-right font-mono">{fmt(tot.credit)}</td><td></td></tr></tfoot>}
        </table>
      </div>
    </div>
  );
}
