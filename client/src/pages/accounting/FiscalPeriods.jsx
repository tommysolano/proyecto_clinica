import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlinePlus, HiOutlineLockClosed, HiOutlineLockOpen } from 'react-icons/hi2';

const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

export default function FiscalPeriods() {
  const [list, setList] = useState([]);
  const [year, setYear] = useState(new Date().getFullYear());

  const load = async () => {
    try { const r = await api.get('/fiscal-periods'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => { load(); }, []);

  const createPeriod = async (month) => {
    try { await api.post('/fiscal-periods', { year, month }); toast.success('Creado'); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  const close = async (p) => { if (!confirm('¿Cerrar período?')) return; try { await api.post(`/fiscal-periods/${p._id}/close`); load(); } catch (e) { toast.error(e.response?.data?.message || 'Error'); } };
  const reopen = async (p) => { if (!confirm('¿Reabrir?')) return; try { await api.post(`/fiscal-periods/${p._id}/reopen`); load(); } catch (e) { toast.error(e.response?.data?.message || 'Error'); } };
  const lock = async (p) => { if (!confirm('¿Bloquear definitivamente?')) return; try { await api.post(`/fiscal-periods/${p._id}/lock`); load(); } catch (e) { toast.error(e.response?.data?.message || 'Error'); } };
  const closeYear = async () => { if (!confirm(`¿Realizar cierre del año ${year}? Generará asiento de utilidad/pérdida.`)) return; try { const r = await api.post('/fiscal-periods/close-year', { year }); toast.success(`Cierre OK. Asiento ${r.data.asiento?.number || '—'}`); load(); } catch (e) { toast.error(e.response?.data?.message || 'Error'); } };
  const openYear = async () => { if (!confirm(`¿Generar asiento de apertura del año ${year} con los saldos al cierre de ${year - 1}?`)) return; try { const r = await api.post('/fiscal-periods/open-year', { year }); toast.success(`Apertura OK. Asiento ${r.data.asiento?.number || '—'}`); load(); } catch (e) { toast.error(e.response?.data?.message || 'Error'); } };

  const byMonth = (m) => list.find((p) => p.year === year && p.month === m);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800">Períodos Fiscales</h1>
        <div className="flex gap-2">
          <input type="number" value={year} onChange={(e) => setYear(+e.target.value)} className="w-28 px-3 py-2 border border-slate-200 rounded-lg" />
          <button onClick={openYear} className="px-4 py-2 bg-emerald-600 text-white rounded-lg">Apertura de año</button>
          <button onClick={closeYear} className="px-4 py-2 bg-rose-600 text-white rounded-lg">Cierre anual</button>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {MESES.map((nombre, idx) => {
          const m = idx + 1; const p = byMonth(m);
          return (
            <div key={m} className="bg-white rounded-xl p-4 shadow-sm border border-emerald-100">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <p className="text-xs text-slate-500">{year}</p>
                  <p className="font-semibold">{nombre}</p>
                </div>
                {p && (
                  <span className={`text-xs px-2 py-1 rounded-full ${p.status === 'ABIERTO' ? 'bg-emerald-100 text-emerald-700' : p.status === 'CERRADO' ? 'bg-amber-100 text-amber-700' : 'bg-slate-300 text-slate-700'}`}>{p.status}</span>
                )}
              </div>
              {!p && <button onClick={() => createPeriod(m)} className="text-xs text-emerald-600 flex items-center gap-1"><HiOutlinePlus /> Abrir</button>}
              {p?.status === 'ABIERTO' && <button onClick={() => close(p)} className="text-xs text-amber-600 flex items-center gap-1"><HiOutlineLockClosed /> Cerrar</button>}
              {p?.status === 'CERRADO' && (<>
                <button onClick={() => reopen(p)} className="text-xs text-emerald-600 flex items-center gap-1 mb-1"><HiOutlineLockOpen /> Reabrir</button>
                <button onClick={() => lock(p)} className="text-xs text-rose-600 flex items-center gap-1"><HiOutlineLockClosed /> Bloquear</button>
              </>)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
