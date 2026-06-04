import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineShieldCheck } from 'react-icons/hi2';
import { fmtDate } from './_utils';

export default function AuditLogs() {
  const [list, setList] = useState([]);
  const [filters, setFilters] = useState({ entity: '', action: '', startDate: '', endDate: '' });

  const load = async () => {
    try { const r = await api.get('/audit-logs', { params: filters }); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineShieldCheck className="text-emerald-600" /> Auditoría</h1>
      <div className="bg-white p-3 rounded-xl shadow-sm flex gap-2 flex-wrap items-end">
        <input placeholder="Entidad" value={filters.entity} onChange={(e) => setFilters({ ...filters, entity: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
        <select value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2">
          <option value="">Acción...</option>
          <option>CREATE</option><option>UPDATE</option><option>DELETE</option><option>POST</option><option>REVERSE</option><option>CLOSE</option><option>OPEN</option><option>LIQUIDATE</option>
        </select>
        <input type="date" value={filters.startDate} onChange={(e) => setFilters({ ...filters, startDate: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
        <input type="date" value={filters.endDate} onChange={(e) => setFilters({ ...filters, endDate: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
        <button onClick={load} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Filtrar</button>
      </div>
      <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-emerald-50 uppercase"><tr>
            <th className="px-2 py-2 text-left">Fecha</th>
            <th className="px-2 py-2 text-left">Usuario</th>
            <th className="px-2 py-2 text-left">Rol</th>
            <th className="px-2 py-2 text-left">Acción</th>
            <th className="px-2 py-2 text-left">Entidad</th>
            <th className="px-2 py-2 text-left">Path</th>
            <th className="px-2 py-2 text-left">IP</th>
            <th className="px-2 py-2 text-center">OK</th>
          </tr></thead>
          <tbody>
            {list.map((l) => (
              <tr key={l._id} className="border-t">
                <td className="px-2 py-1">{fmtDate(l.createdAt)} {new Date(l.createdAt).toLocaleTimeString()}</td>
                <td className="px-2 py-1">{l.userName}</td>
                <td className="px-2 py-1">{l.role}</td>
                <td className="px-2 py-1 font-semibold">{l.action}</td>
                <td className="px-2 py-1">{l.entity}</td>
                <td className="px-2 py-1 font-mono">{l.method} {l.path}</td>
                <td className="px-2 py-1 font-mono">{l.ip}</td>
                <td className="px-2 py-1 text-center">{l.success ? '✓' : '✗'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
