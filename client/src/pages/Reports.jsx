import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import { HiOutlineChartBar, HiOutlineUserGroup } from 'react-icons/hi2';

export default function Reports() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [start, setStart] = useState(monthAgo);
  const [end, setEnd] = useState(today);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [adherence, setAdherence] = useState(null);
  const [adherencePatient, setAdherencePatient] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get('/reports/attention', { params: { start, end } });
      setData(res.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar reporte');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const viewAdherence = async (patientId, name) => {
    try {
      const res = await api.get(`/reports/patient-adherence/${patientId}`);
      setAdherence(res.data.treatments || []);
      setAdherencePatient(name);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
        <HiOutlineChartBar className="text-emerald-600" /> Reportes de atención
      </h1>

      <div className="bg-white rounded-xl border border-slate-200 p-3 flex flex-wrap gap-3 items-end">
        <label className="text-sm">Desde<input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="block mt-1 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" /></label>
        <label className="text-sm">Hasta<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="block mt-1 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" /></label>
        <button onClick={load} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm border-none cursor-pointer hover:bg-emerald-700">Calcular</button>
      </div>

      {loading && <div className="text-slate-500">Cargando...</div>}

      {data && (
        <div className="space-y-3">
          <p className="text-sm text-slate-500">Total de atenciones (citas completadas): <b>{data.total}</b></p>
          {data.providers.map((p) => (
            <div key={p.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 bg-slate-50">
                <div className="flex items-center gap-2">
                  <HiOutlineUserGroup className="text-emerald-600 w-5 h-5" />
                  <span className="font-semibold text-slate-800">{p.name}</span>
                  <span className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-600 capitalize">{p.type}</span>
                </div>
                <div className="text-sm text-slate-600">
                  <b>{p.attentions}</b> atenciones · <b>{p.uniquePatients}</b> pacientes únicos
                </div>
              </div>
              <table className="w-full text-sm">
                <thead className="bg-white text-slate-500"><tr>
                  <th className="text-left px-4 py-1.5">Fecha</th>
                  <th className="text-left px-4 py-1.5">Paciente</th>
                  <th className="px-4 py-1.5"></th>
                </tr></thead>
                <tbody>
                  {p.list.map((a, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-4 py-1.5 text-slate-600">{new Date(a.date).toLocaleDateString('es-EC')}</td>
                      <td className="px-4 py-1.5">{a.patient}</td>
                      <td className="px-4 py-1.5 text-right">
                        {a.patientId && (
                          <button onClick={() => viewAdherence(a.patientId, a.patient)} className="text-xs text-emerald-600 hover:underline bg-transparent border-none cursor-pointer">
                            Ver adherencia
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {data.providers.length === 0 && <p className="text-slate-400">Sin atenciones en el período.</p>}
        </div>
      )}

      <Modal isOpen={!!adherence} onClose={() => setAdherence(null)} title={`Adherencia · ${adherencePatient || ''}`}>
        {adherence && adherence.length === 0 && <p className="text-slate-500 text-sm">Este paciente no tiene tratamientos recetados.</p>}
        <div className="space-y-3">
          {(adherence || []).map((t) => (
            <div key={t.id} className="border border-slate-200 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-800">{t.name}</span>
                <span className="text-2xl font-bold text-emerald-600">{Math.min(t.progress, 100)}%</span>
              </div>
              <div className="text-xs text-slate-500">Recetado por {t.prescribedBy} · {t.status}</div>
              <div className="mt-2 space-y-1">
                {t.items.map((it, i) => (
                  <div key={i} className="flex justify-between text-xs">
                    <span>{it.name}</span>
                    <span className={it.completed >= it.quantity ? 'text-emerald-700 font-semibold' : 'text-slate-500'}>
                      {it.completed} / {it.quantity}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
