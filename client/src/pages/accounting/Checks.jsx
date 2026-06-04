import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlineDocumentText, HiOutlinePlus, HiOutlineNoSymbol } from 'react-icons/hi2';
import { fmt, fmtDate } from './_utils';

const STATUS_COLOR = { DISPONIBLE: 'bg-emerald-100 text-emerald-700', GIRADO: 'bg-amber-100 text-amber-700', COBRADO: 'bg-blue-100 text-blue-700', ANULADO: 'bg-rose-100 text-rose-700' };

export default function Checks() {
  const [accounts, setAccounts] = useState([]);
  const [account, setAccount] = useState('');
  const [status, setStatus] = useState('');
  const [list, setList] = useState([]);
  const [show, setShow] = useState(false);
  const [range, setRange] = useState({ from: '', to: '' });

  useEffect(() => { api.get('/banks/accounts').then((r) => { setAccounts(r.data || []); if (r.data?.[0]) setAccount(r.data[0]._id); }).catch(() => {}); }, []);
  const load = async () => {
    if (!account) return;
    try { const r = await api.get('/banks/checks', { params: { bankAccount: account, status: status || undefined } }); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [account, status]);

  const generate = async () => {
    try { const r = await api.post('/banks/checks/generate', { bankAccount: account, from: range.from, to: range.to }); toast.success(`${r.data.created} cheques creados`); setShow(false); setRange({ from: '', to: '' }); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  const voidCheck = async (chk) => {
    const reason = prompt('Motivo de anulación:'); if (reason === null) return;
    try { await api.post(`/banks/checks/${chk._id}/void`, { reason }); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineDocumentText className="text-emerald-600" /> Cheques</h1>
        <button onClick={() => setShow(true)} disabled={!account} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2 disabled:opacity-50"><HiOutlinePlus /> Generar chequera</button>
      </div>
      <div className="bg-white rounded-xl p-3 shadow-sm flex gap-2 flex-wrap">
        <select value={account} onChange={(e) => setAccount(e.target.value)} className="px-3 py-2 border border-slate-200 rounded-lg">
          {accounts.map((a) => <option key={a._id} value={a._id}>{a.name} — {a.bank}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="px-3 py-2 border border-slate-200 rounded-lg">
          <option value="">Todos</option><option value="DISPONIBLE">Disponibles</option><option value="GIRADO">Girados</option><option value="COBRADO">Cobrados</option><option value="ANULADO">Anulados</option>
        </select>
      </div>
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-emerald-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Nº Cheque</th><th className="px-3 py-2 text-center">Estado</th><th className="px-3 py-2 text-left">Beneficiario</th><th className="px-3 py-2 text-right">Monto</th><th className="px-3 py-2 text-left">Fecha</th><th></th></tr></thead>
          <tbody>
            {list.map((chk) => (
              <tr key={chk._id} className="border-t">
                <td className="px-3 py-2 font-mono">{chk.number}</td>
                <td className="px-3 py-2 text-center"><span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${STATUS_COLOR[chk.status]}`}>{chk.status}</span></td>
                <td className="px-3 py-2">{chk.beneficiary || '—'}</td>
                <td className="px-3 py-2 text-right font-mono">{chk.amount ? fmt(chk.amount) : '—'}</td>
                <td className="px-3 py-2">{chk.date ? fmtDate(chk.date) : '—'}</td>
                <td className="px-3 py-2 text-right">{chk.status === 'DISPONIBLE' && <button onClick={() => voidCheck(chk)} className="text-rose-600" title="Anular"><HiOutlineNoSymbol className="w-4 h-4" /></button>}</td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">Sin cheques. Genera una chequera.</td></tr>}
          </tbody>
        </table>
      </div>
      <Modal isOpen={show} onClose={() => setShow(false)} title="Generar chequera">
        <div className="space-y-3">
          <p className="text-sm text-slate-500">Crea un rango de cheques disponibles para la cuenta seleccionada.</p>
          <div className="grid grid-cols-2 gap-3">
            <input type="number" placeholder="Desde Nº" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input type="number" placeholder="Hasta Nº" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
          </div>
          <div className="flex justify-end gap-2"><button onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button onClick={generate} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Generar</button></div>
        </div>
      </Modal>
    </div>
  );
}
