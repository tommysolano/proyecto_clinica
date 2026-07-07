import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { fmt } from './_utils';
import { HiOutlineArrowPath, HiOutlineCheckCircle, HiOutlineExclamationTriangle, HiOutlineXCircle } from 'react-icons/hi2';

export default function AccountingHealth() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    try { const r = await api.get('/accounting-health'); setData(r.data); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
    finally { setLoading(false); }
  };
  useEffect(() => { run(); }, []);

  const levelStyle = (lvl) => lvl === 'error'
    ? { icon: HiOutlineXCircle, cls: 'text-rose-600 bg-rose-50 border-rose-200' }
    : { icon: HiOutlineExclamationTriangle, cls: 'text-amber-600 bg-amber-50 border-amber-200' };

  const s = data?.summary || {};
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Salud Contable</h1>
        <button onClick={run} disabled={loading} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2 disabled:opacity-60">
          <HiOutlineArrowPath className={loading ? 'animate-spin' : ''} /> Verificar
        </button>
      </div>

      {data && (
        <div className={`rounded-2xl border p-4 flex items-center gap-3 ${data.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-rose-50 border-rose-200 text-rose-700'}`}>
          {data.ok ? <HiOutlineCheckCircle className="w-7 h-7" /> : <HiOutlineXCircle className="w-7 h-7" />}
          <div>
            <div className="font-semibold">{data.ok ? 'Contabilidad consistente' : 'Se detectaron inconsistencias'}</div>
            <div className="text-xs opacity-80">Verificado: {new Date(data.checkedAt).toLocaleString('es-EC', { timeZone: 'America/Guayaquil' })}</div>
          </div>
        </div>
      )}

      {data && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {[
            ['Débitos (mayor)', s.globalDebit], ['Créditos (mayor)', s.globalCredit],
            ['CxC mayor', s.cxcLedger], ['CxC subledger', s.cxcSubledger],
            ['CxP mayor', s.cxpLedger], ['CxP subledger', s.cxpSubledger],
          ].map(([label, val]) => (
            <div key={label} className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4">
              <div className="text-xs text-slate-500 uppercase">{label}</div>
              <div className="text-lg font-semibold text-slate-800 mt-1">${fmt(val)}</div>
            </div>
          ))}
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4">
        <h2 className="font-semibold text-slate-700 mb-3">Hallazgos</h2>
        {!data?.findings?.length && <div className="text-sm text-emerald-600">Sin hallazgos. Todo cuadra.</div>}
        <div className="space-y-2">
          {(data?.findings || []).map((f, i) => {
            const st = levelStyle(f.level);
            const Icon = st.icon;
            return (
              <div key={i} className={`flex items-start gap-2 rounded-xl border p-3 ${st.cls}`}>
                <Icon className="w-5 h-5 shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-medium">{f.message}</div>
                  <div className="text-xs opacity-70 font-mono">{f.code}{f.sample ? ` · ${f.sample.join(', ')}` : ''}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
