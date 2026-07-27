import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import {
  HiOutlineArrowUpTray,
  HiOutlineArrowDownTray,
  HiOutlineArrowUturnLeft,
  HiOutlineDocumentText,
} from 'react-icons/hi2';
import api from '../../api/axios';
import ImportWizard from './ImportWizard';
import { useSocketEvent } from '../../context/SocketContext';
import { fmtDateTime } from '../../utils/date';

const STATUS_META = {
  pending: { label: 'En cola', chip: 'bg-slate-100 text-slate-600' },
  running: { label: 'Importando', chip: 'bg-emerald-100 text-emerald-700' },
  done: { label: 'Terminada', chip: 'bg-sky-100 text-sky-700' },
  failed: { label: 'Falló', chip: 'bg-rose-100 text-rose-700' },
  reverted: { label: 'Deshecha', chip: 'bg-slate-100 text-slate-400' },
};

export default function ImportsTab({ groups, onGroupsChanged }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      const r = await api.get('/contacts/imports');
      setList(r.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar importaciones');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // La importación corre en un job del servidor: el progreso llega por socket.
  useSocketEvent('contactImport:progress', () => { load(); }, []);

  const revert = async (batch) => {
    if (!window.confirm(
      `¿Deshacer "${batch.fileName}"?\n\nSe borrarán los ${batch.created} contactos que creó este lote. ` +
      'Los que ya se convirtieron en pacientes NO se tocan.'
    )) return;
    try {
      const r = await api.post(`/contacts/imports/${batch._id}/revert`);
      toast.success(`Importación deshecha: ${r.data.deleted ?? 0} contactos borrados`);
      load();
      onGroupsChanged?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo deshacer');
    }
  };

  const downloadErrors = async (batch) => {
    try {
      const r = await api.get(`/contacts/imports/${batch._id}/errors.csv`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([r.data], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `errores_${batch.fileName || 'importacion'}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('No se pudo descargar el informe de errores');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <p className="text-xs text-slate-500 max-w-2xl">
          Cada importación queda registrada con su mapeo, sus contadores y sus errores. Si mapeaste mal
          una columna, puedes deshacer el lote entero sin tocar el resto de contactos.
        </p>
        <button
          onClick={() => setWizardOpen(true)}
          className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 hover:bg-emerald-700 flex items-center gap-1 border-none cursor-pointer whitespace-nowrap"
        >
          <HiOutlineArrowUpTray className="w-4 h-4" /> Importar Excel
        </button>
      </div>

      {loading ? (
        <div className="bg-white border border-slate-200 rounded-xl py-12 text-center text-sm text-slate-400">Cargando…</div>
      ) : list.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl py-12 text-center text-sm text-slate-400">
          Todavía no has importado ningún archivo.
        </div>
      ) : (
        <div className="space-y-2">
          {list.map((b) => {
            const meta = STATUS_META[b.status] || STATUS_META.pending;
            const pct = b.totalRows ? Math.min(100, Math.round((b.processedRows / b.totalRows) * 100)) : 0;
            const running = b.status === 'running' || b.status === 'pending';
            return (
              <div key={b._id} className="bg-white border border-slate-200 rounded-xl p-3.5">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex items-start gap-2 min-w-0">
                    <HiOutlineDocumentText className="w-5 h-5 text-slate-400 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-slate-700 truncate">{b.fileName}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${meta.chip}`}>{meta.label}</span>
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {fmtDateTime(b.createdAt)}
                        {b.createdByName && ` · ${b.createdByName}`}
                        {b.tags?.length > 0 && ` · ${b.tags.join(', ')}`}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {b.rowErrors?.length > 0 && (
                      <button
                        onClick={() => downloadErrors(b)}
                        className="px-2.5 py-1 text-xs border border-slate-200 rounded-lg bg-white hover:bg-slate-50 cursor-pointer flex items-center gap-1"
                      >
                        <HiOutlineArrowDownTray className="w-3.5 h-3.5" /> Errores
                      </button>
                    )}
                    {b.status === 'done' && b.created > 0 && (
                      <button
                        onClick={() => revert(b)}
                        className="px-2.5 py-1 text-xs border border-rose-200 text-rose-700 rounded-lg bg-white hover:bg-rose-50 cursor-pointer flex items-center gap-1"
                      >
                        <HiOutlineArrowUturnLeft className="w-3.5 h-3.5" /> Deshacer
                      </button>
                    )}
                  </div>
                </div>

                {running && (
                  <div className="mt-2.5">
                    <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="text-[11px] text-slate-400 mt-1">
                      {b.status === 'pending'
                        ? 'En cola: empieza en menos de un minuto…'
                        : `${b.processedRows.toLocaleString('es-EC')} de ${b.totalRows.toLocaleString('es-EC')} filas`}
                    </div>
                  </div>
                )}

                {(b.status === 'done' || b.status === 'reverted') && (
                  <div className="flex gap-3 flex-wrap mt-2 text-xs">
                    <Counter label="Creados" value={b.created} tone="text-emerald-700" />
                    <Counter label="Actualizados" value={b.updated} tone="text-sky-700" />
                    <Counter label="Omitidos" value={b.skipped} tone="text-slate-500" />
                    <Counter label="Fallidos" value={b.failed} tone={b.failed ? 'text-rose-600' : 'text-slate-400'} />
                    {b.workflows?.length > 0 && (
                      <Counter label="En workflow" value={b.enrolled} tone="text-violet-700" />
                    )}
                  </div>
                )}

                {b.status === 'done' && b.workflows?.length > 0 && b.enrolled > 0 && (
                  <div className="text-[11px] text-violet-700 bg-violet-50 border border-violet-200 rounded-lg px-2 py-1 mt-2">
                    ⏰ {b.enrolled.toLocaleString('es-EC')} mensaje(s) programado(s) — {sendWhenText(b)}. Míralos en
                    Marketing → Automatizaciones (el flujo muestra las inscripciones «En espera»).
                  </div>
                )}
                {b.status === 'done' && b.workflows?.length > 0 && b.enrollSkipped > 0 && (
                  <div className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 mt-1">
                    ℹ️ {b.enrollSkipped.toLocaleString('es-EC')} contacto(s) NO se volvieron a encolar: ya tenían un
                    mensaje pendiente de este flujo (no se duplica).
                  </div>
                )}

                {b.status === 'done' && b.enrollCancelled > 0 && (
                  <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 mt-1">
                    🛑 Se cancelaron {b.enrollCancelled.toLocaleString('es-EC')} envío(s) que seguían pendientes de
                    una importación anterior de este flujo, para que no se mezclara su mensaje con este.
                  </div>
                )}
                {b.enrollWarning && (
                  <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 mt-1">
                    ⚠️ {b.enrollWarning}
                  </div>
                )}

                {b.errorMessage && (
                  <div className="text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2 py-1 mt-2">
                    {b.errorMessage}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {wizardOpen && (
        <ImportWizard
          groups={groups}
          onClose={() => setWizardOpen(false)}
          onDone={() => { setWizardOpen(false); load(); onGroupsChanged?.(); }}
        />
      )}
    </div>
  );
}

/** Texto legible de CUÁNDO sale el 1er mensaje del lote. */
function sendWhenText(b) {
  if (b.sendMode === 'at' && b.sendAt) return `a las ${b.sendAt} (hoy si aún no pasa, mañana si ya pasó)`;
  if (b.sendMode === 'flow') return 'a la hora configurada en el flujo';
  return 'de inmediato (con goteo)';
}

function Counter({ label, value, tone }) {
  return (
    <span className="text-slate-400">
      {label}: <b className={tone}>{(value || 0).toLocaleString('es-EC')}</b>
    </span>
  );
}
