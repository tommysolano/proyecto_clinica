import { useEffect, useState, useCallback } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { fmt, fmtDate } from './_utils';
import { HiOutlineCheckCircle } from 'react-icons/hi2';
import NumericInput from '../../components/NumericInput';

const STATUS_CLS = {
  ABIERTO: 'bg-slate-100 text-slate-600',
  PARCIAL: 'bg-amber-100 text-amber-700',
  RECONOCIDO: 'bg-emerald-100 text-emerald-700',
  ANULADO: 'bg-rose-100 text-rose-700',
};

export default function DeferredIncome() {
  const [data, setData] = useState({ items: [], totals: {} });
  const [statusFilter, setStatusFilter] = useState('');
  const [recDoc, setRecDoc] = useState(null);
  const [recForm, setRecForm] = useState({ sessions: 1, amount: '' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.get('/deferred-income', { params: { status: statusFilter || undefined } });
      setData(r.data || { items: [], totals: {} });
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  }, [statusFilter]);
  useEffect(() => { load(); }, [load]);

  const openRecognize = (d) => { setRecForm({ sessions: 1, amount: '' }); setRecDoc(d); };

  const submitRecognize = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const body = {};
      if (recForm.amount !== '' && Number(recForm.amount) > 0) body.amount = Number(recForm.amount);
      else if (Number(recForm.sessions) > 0) body.sessions = Number(recForm.sessions);
      const r = await api.post(`/deferred-income/${recDoc._id}/recognize`, body);
      toast.success(`Reconocido $${fmt(r.data.entry?.amount)} (asiento ${r.data.entry?.number || '—'})`);
      setRecDoc(null);
      load();
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
    finally { setSaving(false); }
  };

  const t = data.totals || {};
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Ingresos Diferidos</h1>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border border-slate-200 rounded-xl px-3 py-2 text-sm">
          <option value="">Todos los estados</option>
          <option value="ABIERTO">Abierto</option>
          <option value="PARCIAL">Parcial</option>
          <option value="RECONOCIDO">Reconocido</option>
          <option value="ANULADO">Anulado</option>
        </select>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-2xl p-4 border border-emerald-100 shadow-sm"><p className="text-xs text-slate-500">Diferido total</p><p className="text-xl font-bold text-slate-800">${fmt(t.total)}</p></div>
        <div className="bg-white rounded-2xl p-4 border border-emerald-100 shadow-sm"><p className="text-xs text-slate-500">Reconocido</p><p className="text-xl font-bold text-emerald-700">${fmt(t.recognized)}</p></div>
        <div className="bg-white rounded-2xl p-4 border border-emerald-100 shadow-sm"><p className="text-xs text-slate-500">Por reconocer</p><p className="text-xl font-bold text-amber-700">${fmt(t.balance)}</p></div>
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
        <table className="tbl">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Fecha</th><th className="px-3 py-2 text-left">Paquete</th>
            <th className="px-3 py-2 text-left">Paciente</th><th className="px-3 py-2 text-right">Total</th>
            <th className="px-3 py-2 text-right">Reconocido</th><th className="px-3 py-2 text-right">Saldo</th>
            <th className="px-3 py-2 text-center">Sesiones</th><th className="px-3 py-2 text-left">Estado</th><th></th>
          </tr></thead>
          <tbody>
            {(data.items || []).map((d) => (
              <tr key={d._id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2">{fmtDate(d.issueDate)}</td>
                <td className="px-3 py-2">{d.productName}</td>
                <td className="px-3 py-2">{d.patient ? `${d.patient.firstName || ''} ${d.patient.lastName || ''}`.trim() : d.partyName || '—'}</td>
                <td className="px-3 py-2 text-right">${fmt(d.total)}</td>
                <td className="px-3 py-2 text-right text-emerald-700">${fmt(d.recognized)}</td>
                <td className="px-3 py-2 text-right font-semibold">${fmt(d.balance)}</td>
                <td className="px-3 py-2 text-center text-xs">{d.sessionsTotal ? `${d.sessionsUsed}/${d.sessionsTotal}` : '—'}</td>
                <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_CLS[d.status] || ''}`}>{d.status}</span></td>
                <td className="px-3 py-2 text-right">
                  {['ABIERTO', 'PARCIAL'].includes(d.status) && (
                    <button onClick={() => openRecognize(d)} className="px-2.5 py-1 text-xs bg-emerald-600 text-white rounded-lg flex items-center gap-1 ml-auto border-none cursor-pointer hover:bg-emerald-700"><HiOutlineCheckCircle className="w-4 h-4" /> Reconocer</button>
                  )}
                </td>
              </tr>
            ))}
            {!(data.items || []).length && <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-400">Sin ingresos diferidos</td></tr>}
          </tbody>
        </table>
      </div>

      <Modal isOpen={!!recDoc} onClose={() => setRecDoc(null)} title={`Reconocer ingreso — ${recDoc?.productName || ''}`}>
        {recDoc && (
          <form onSubmit={submitRecognize} className="space-y-3 text-sm">
            <div className="bg-slate-50 rounded-lg p-3 text-xs text-slate-600">
              Saldo por reconocer: <b className="font-mono">${fmt(recDoc.balance)}</b>
              {recDoc.sessionsTotal > 0 && <> · Sesiones {recDoc.sessionsUsed}/{recDoc.sessionsTotal}</>}
            </div>
            {recDoc.sessionsTotal > 0 && (
              <div>
                <label className="block text-slate-600 mb-1">Sesiones a reconocer</label>
                <NumericInput min="1" max={recDoc.sessionsTotal - recDoc.sessionsUsed} value={recForm.sessions}
                  onChange={(e) => setRecForm({ ...recForm, sessions: e.target.value, amount: '' })}
                  className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
              </div>
            )}
            <div>
              <label className="block text-slate-600 mb-1">…o monto exacto ($)</label>
              <NumericInput step="0.01" min="0" value={recForm.amount}
                onChange={(e) => setRecForm({ ...recForm, amount: e.target.value })}
                placeholder="Dejar vacío para usar sesiones / saldo total"
                className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setRecDoc(null)} className="px-4 py-2 rounded-xl border border-slate-200">Cancelar</button>
              <button type="submit" disabled={saving} className="px-4 py-2 rounded-xl bg-emerald-600 text-white disabled:opacity-60">{saving ? 'Guardando…' : 'Reconocer'}</button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
