import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineBookOpen } from 'react-icons/hi2';
import { fmt, fmtDate, startOfMonth, today } from './_utils';

export default function Ledger() {
  const [accounts, setAccounts] = useState([]);
  const [account, setAccount] = useState('');
  const [startDate, setStart] = useState(startOfMonth());
  const [endDate, setEnd] = useState(today());
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get('/chart-of-accounts', { params: { active: true } }).then((r) => setAccounts((r.data || []).filter((a) => a.allowsMovement)));
  }, []);

  const load = async () => {
    if (!account) return toast.error('Seleccione cuenta');
    try { const r = await api.get('/journal-entries/ledger', { params: { account, startDate, endDate } }); setData(r.data); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><HiOutlineBookOpen className="text-emerald-600" /> Libro Mayor</h1>
      <div className="bg-white p-3 rounded-xl shadow-sm flex gap-2 flex-wrap items-end">
        <div className="flex-1 min-w-64">
          <label className="text-xs text-slate-500">Cuenta</label>
          <select value={account} onChange={(e) => setAccount(e.target.value)} className="w-full border border-slate-200 rounded-lg px-3 py-2">
            <option value="">--</option>
            {accounts.map((a) => <option key={a._id} value={a._id}>{a.code} - {a.name}</option>)}
          </select>
        </div>
        <div><label className="text-xs text-slate-500">Desde</label><input type="date" value={startDate} onChange={(e) => setStart(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-2" /></div>
        <div><label className="text-xs text-slate-500">Hasta</label><input type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-2" /></div>
        <button onClick={load} className="px-4 py-2 bg-emerald-600 text-white rounded-lg">Consultar</button>
      </div>
      {data && (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden">
          <div className="p-3 bg-slate-50 text-sm flex gap-4">
            <span>Saldo inicial: <b>${fmt(data.openingBalance)}</b></span>
            <span>Total débito: <b className="text-emerald-700">${fmt(data.totalDebit)}</b></span>
            <span>Total crédito: <b className="text-rose-600">${fmt(data.totalCredit)}</b></span>
            <span className="ml-auto">Saldo final: <b className="text-lg">${fmt(data.endingBalance)}</b></span>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs uppercase"><tr>
              <th className="px-2 py-1 text-left">Fecha</th><th className="px-2 py-1 text-left">Asiento</th>
              <th className="px-2 py-1 text-left">Descripción</th><th className="px-2 py-1 text-right">Débito</th>
              <th className="px-2 py-1 text-right">Crédito</th><th className="px-2 py-1 text-right">Saldo</th>
            </tr></thead>
            <tbody>
              {data.movements.map((m, i) => (
                <tr key={i} className="border-t">
                  <td className="px-2 py-1">{fmtDate(m.date)}</td>
                  <td className="px-2 py-1 font-mono text-xs">{m.entryNumber}</td>
                  <td className="px-2 py-1 text-xs">{m.description}</td>
                  <td className="px-2 py-1 text-right font-mono">{m.debit ? fmt(m.debit) : ''}</td>
                  <td className="px-2 py-1 text-right font-mono">{m.credit ? fmt(m.credit) : ''}</td>
                  <td className="px-2 py-1 text-right font-mono font-semibold">{fmt(m.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
