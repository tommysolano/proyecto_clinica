import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineBanknotes, HiOutlinePlus, HiOutlineTrash } from 'react-icons/hi2';
import { fmt } from './_utils';

export default function Budgets() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [accounts, setAccounts] = useState([]);
  const [lines, setLines] = useState([]);
  const [budgetId, setBudgetId] = useState(null);
  const [execution, setExecution] = useState(null);
  const [tab, setTab] = useState('edit');

  const loadAccounts = async () => {
    const r = await api.get('/chart-of-accounts');
    setAccounts((r.data || []).filter((a) => a.allowsMovement && ['INGRESO', 'GASTO', 'COSTO'].includes(a.type)));
  };
  const loadBudget = async () => {
    const r = await api.get('/budgets');
    const b = (r.data || []).find((x) => x.year === year && !x.costCenter);
    if (b) {
      const full = await api.get(`/budgets/${b._id}`);
      setBudgetId(b._id);
      setLines((full.data.lines || []).map((l) => ({ account: l.account?._id || l.account, annual: (l.amounts || []).reduce((s, n) => s + (n || 0), 0) })));
    } else { setBudgetId(null); setLines([]); }
  };
  const loadExecution = async () => {
    const r = await api.get('/budgets/execution', { params: { year } });
    setExecution(r.data);
  };

  useEffect(() => { loadAccounts(); }, []);
  useEffect(() => { loadBudget(); if (tab === 'exec') loadExecution(); /* eslint-disable-next-line */ }, [year]);

  const addLine = () => setLines([...lines, { account: '', annual: 0 }]);
  const setLine = (i, patch) => { const a = [...lines]; a[i] = { ...a[i], ...patch }; setLines(a); };
  const delLine = (i) => setLines(lines.filter((_, x) => x !== i));

  const save = async () => {
    try {
      const payload = {
        year, name: `Presupuesto ${year}`,
        lines: lines.filter((l) => l.account).map((l) => ({ account: l.account, amounts: Array(12).fill(+( (+l.annual || 0) / 12 ).toFixed(2)) })),
      };
      await api.post('/budgets', payload);
      toast.success('Presupuesto guardado'); loadBudget();
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const accName = (id) => { const a = accounts.find((x) => x._id === id); return a ? `${a.code} ${a.name}` : ''; };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineBanknotes className="text-emerald-600" /> Presupuesto</h1>
        <div className="flex gap-2 items-center">
          <input type="number" value={year} onChange={(e) => setYear(+e.target.value)} className="w-24 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
          <div className="flex rounded-lg overflow-hidden border border-slate-200">
            <button onClick={() => setTab('edit')} className={`px-3 py-2 text-sm ${tab === 'edit' ? 'bg-emerald-600 text-white' : 'bg-white'}`}>Editar</button>
            <button onClick={() => { setTab('exec'); loadExecution(); }} className={`px-3 py-2 text-sm ${tab === 'exec' ? 'bg-emerald-600 text-white' : 'bg-white'}`}>Ejecución</button>
          </div>
        </div>
      </div>

      {tab === 'edit' && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4 space-y-2">
          <p className="text-xs text-slate-500">Define el monto anual presupuestado por cuenta de ingreso/gasto/costo (se distribuye en 12 meses).</p>
          {lines.map((l, i) => (
            <div key={i} className="flex gap-2 items-center">
              <select value={l.account} onChange={(e) => setLine(i, { account: e.target.value })} className="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                <option value="">Cuenta...</option>
                {accounts.map((a) => <option key={a._id} value={a._id}>{a.code} — {a.name}</option>)}
              </select>
              <input type="number" step="0.01" placeholder="Monto anual" value={l.annual} onChange={(e) => setLine(i, { annual: +e.target.value })} className="w-40 border border-slate-200 rounded-lg px-2 py-1.5 text-sm text-right" />
              <button onClick={() => delLine(i)} className="text-rose-600"><HiOutlineTrash className="w-5 h-5" /></button>
            </div>
          ))}
          <div className="flex justify-between items-center pt-2">
            <button onClick={addLine} className="text-emerald-600 text-sm flex items-center gap-1"><HiOutlinePlus /> Cuenta</button>
            <button onClick={save} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 text-sm">Guardar presupuesto</button>
          </div>
        </div>
      )}

      {tab === 'exec' && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-emerald-50 text-xs uppercase"><tr>
              <th className="px-3 py-2 text-left">Cuenta</th><th className="px-3 py-2 text-right">Presupuesto</th>
              <th className="px-3 py-2 text-right">Real</th><th className="px-3 py-2 text-right">Variación</th><th className="px-3 py-2 text-right">% Cumpl.</th>
            </tr></thead>
            <tbody>
              {(execution?.rows || []).map((r, i) => (
                <tr key={i} className="border-t">
                  <td className="px-3 py-2">{r.account ? `${r.account.code} ${r.account.name}` : '—'}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmt(r.budget)}</td>
                  <td className="px-3 py-2 text-right font-mono">{fmt(r.actual)}</td>
                  <td className={`px-3 py-2 text-right font-mono ${r.variance < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>{fmt(r.variance)}</td>
                  <td className="px-3 py-2 text-right">{r.compliance}%</td>
                </tr>
              ))}
              {!(execution?.rows || []).length && <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-400">Sin presupuesto para {year}</td></tr>}
            </tbody>
            {execution?.totals && (
              <tfoot className="bg-slate-50 font-semibold"><tr>
                <td className="px-3 py-2 text-right">Totales:</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(execution.totals.budget)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(execution.totals.actual)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(execution.totals.variance)}</td><td></td>
              </tr></tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
