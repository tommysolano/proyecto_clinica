import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineArrowDownTray, HiOutlineCheckCircle, HiOutlineArrowPath } from 'react-icons/hi2';
import { fmt, fmtDate } from './_utils';

/**
 * Importa el estado de cuenta del banco (CSV) y lo concilia automáticamente
 * contra las transacciones del libro. Formato esperado por línea:
 *   fecha,descripcion,referencia,monto   (monto negativo = débito/retiro)
 */
export default function BankImport() {
  const [banks, setBanks] = useState([]);
  const [bankAccount, setBankAccount] = useState('');
  const [raw, setRaw] = useState('');
  const [rows, setRows] = useState(null);
  const [creates, setCreates] = useState({}); // index -> {include, counterAccountCode}
  const [loading, setLoading] = useState(false);

  useEffect(() => { api.get('/banks/accounts').then((r) => { setBanks(r.data || []); if (r.data?.[0]) setBankAccount(r.data[0]._id); }); }, []);

  const parseCsv = (text) => {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const out = [];
    for (const ln of lines) {
      if (/fecha|date|descrip/i.test(ln) && /monto|amount|valor/i.test(ln)) continue; // cabecera
      const cols = ln.split(/[,;\t]/).map((c) => c.trim());
      if (cols.length < 2) continue;
      const [fecha, descripcion = '', referencia = '', montoStr = ''] = cols.length >= 4 ? cols : [cols[0], cols[1], '', cols[cols.length - 1]];
      const amount = parseFloat(String(montoStr).replace(/[^0-9.-]/g, '')) || 0;
      if (!amount) continue;
      out.push({ date: fecha.split('/').reverse().length === 3 ? fecha.split('/').reverse().join('-') : fecha, description: descripcion, reference: referencia, amount });
    }
    return out;
  };

  const match = async () => {
    if (!bankAccount) return toast.error('Selecciona la cuenta bancaria');
    const lines = parseCsv(raw);
    if (!lines.length) return toast.error('No se detectaron líneas válidas');
    setLoading(true);
    try {
      const r = await api.post('/banks/statement/match', { bankAccount, lines });
      setRows(r.data.rows || []);
      setCreates({});
      toast.success(`${r.data.matched} conciliadas, ${r.data.unmatched} sin coincidencia`);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
    finally { setLoading(false); }
  };

  const apply = async () => {
    const matchTransactionIds = rows.filter((r) => r.match).map((r) => r.match._id);
    const toCreate = rows.filter((r) => !r.match && creates[r.index]?.include)
      .map((r) => ({ date: r.line.date, amount: r.line.amount, description: r.line.description, reference: r.line.reference, counterAccountCode: creates[r.index]?.counterAccountCode || undefined }));
    try {
      const res = await api.post('/banks/statement/apply', { bankAccount, matchTransactionIds, creates: toCreate });
      toast.success(`${res.data.matched} conciliadas, ${res.data.created} creadas`);
      setRows(null); setRaw('');
      api.post('/banks/recompute-balances').catch(() => {});
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><HiOutlineArrowDownTray className="text-emerald-600" /> Importar Estado de Cuenta</h1>

      <div className="bg-white rounded-xl shadow-sm p-4 space-y-3">
        <div className="flex flex-wrap gap-3 items-end">
          <label className="text-xs text-slate-500">Cuenta bancaria
            <select value={bankAccount} onChange={(e) => setBankAccount(e.target.value)} className="mt-1 block border border-slate-200 rounded-lg px-3 py-2 text-sm min-w-[220px]">
              {banks.map((b) => <option key={b._id} value={b._id}>{b.name} — {b.bank}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-500">Archivo CSV
            <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; const rd = new FileReader(); rd.onload = (ev) => setRaw(String(ev.target?.result || '')); rd.readAsText(f, 'utf-8'); }} className="mt-1 block text-sm" />
          </label>
        </div>
        <p className="text-xs text-slate-400">Formato por línea: <code>fecha,descripción,referencia,monto</code> · monto negativo = débito/retiro.</p>
        <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={6} placeholder="01/06/2026,Depósito cliente,REF123,1500.00&#10;03/06/2026,Comisión mantenimiento,,-8.50" className="w-full border border-slate-200 rounded-lg px-3 py-2 font-mono text-xs" />
        <button onClick={match} disabled={loading} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm flex items-center gap-2"><HiOutlineArrowPath /> {loading ? 'Conciliando...' : 'Conciliar'}</button>
      </div>

      {rows && (
        <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-emerald-50 text-xs uppercase"><tr>
              <th className="px-3 py-2 text-left">Fecha</th><th className="px-3 py-2 text-left">Descripción (banco)</th>
              <th className="px-3 py-2 text-right">Monto</th><th className="px-3 py-2 text-left">Estado</th><th className="px-3 py-2 text-left">Acción</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.index} className="border-t">
                  <td className="px-3 py-2">{r.line.date}</td>
                  <td className="px-3 py-2 text-xs">{r.line.description} {r.line.reference && <span className="text-slate-400">· {r.line.reference}</span>}</td>
                  <td className={`px-3 py-2 text-right font-mono ${r.line.amount < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>{fmt(r.line.amount)}</td>
                  <td className="px-3 py-2">
                    {r.match ? <span className="text-emerald-700 flex items-center gap-1 text-xs"><HiOutlineCheckCircle className="w-4 h-4" /> Coincide ({fmtDate(r.match.date)})</span>
                      : <span className="text-amber-600 text-xs">Sin coincidencia</span>}
                  </td>
                  <td className="px-3 py-2">
                    {!r.match && (
                      <label className="flex items-center gap-2 text-xs">
                        <input type="checkbox" checked={!!creates[r.index]?.include} onChange={(e) => setCreates({ ...creates, [r.index]: { ...creates[r.index], include: e.target.checked } })} />
                        Crear movimiento
                        {creates[r.index]?.include && (
                          <input placeholder="Cód. contrapartida" value={creates[r.index]?.counterAccountCode || ''} onChange={(e) => setCreates({ ...creates, [r.index]: { ...creates[r.index], counterAccountCode: e.target.value } })} className="border border-slate-200 rounded px-2 py-1 w-32" />
                        )}
                      </label>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="p-3 flex justify-end">
            <button onClick={apply} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm">Aplicar conciliación</button>
          </div>
        </div>
      )}
    </div>
  );
}
