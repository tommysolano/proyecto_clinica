import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { HiOutlineCalendarDays, HiOutlinePaperAirplane } from 'react-icons/hi2';
import api from '../../api/axios';
import AppointmentBlastWizard from './AppointmentBlastWizard';
import { useSocketEvent } from '../../context/SocketContext';
import { fmtDateTime } from '../../utils/date';

/**
 * Recordatorios de citas: historial de los envíos hechos desde la agenda.
 *
 * Cada fila cuenta lo mismo que el historial de importaciones —cuántos entraron,
 * cuántos quedaron fuera y por qué— porque la pregunta del día siguiente es
 * siempre la misma: "¿a quién le llegó el recordatorio y a quién no?".
 */
const STATUS_META = {
  pending: { label: 'En cola', chip: 'bg-slate-100 text-slate-600' },
  running: { label: 'Enviando', chip: 'bg-emerald-100 text-emerald-700' },
  done: { label: 'Encolado', chip: 'bg-sky-100 text-sky-700' },
  failed: { label: 'Falló', chip: 'bg-rose-100 text-rose-700' },
};

export default function AppointmentBlastsTab({ initialDate = '', autoOpen = false }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(autoOpen);

  const load = async () => {
    try {
      setLoading(true);
      const r = await api.get('/appointment-blasts');
      setList(r.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar los envíos');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // El envío corre en un job del servidor: el avance llega por socket.
  useSocketEvent('appointmentBlast:progress', () => { load(); }, []);

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <p className="text-xs text-slate-500 max-w-2xl">
          Manda el recordatorio a las citas que ya están en la agenda, sin pasar por el Excel. Cada
          mensaje sabe de qué cita habla: la fecha, la hora, el servicio y el doctor salen de la cita
          real, y si se reagenda o se cancela, el recordatorio se mueve o no sale.
        </p>
        <button
          onClick={() => setWizardOpen(true)}
          className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 hover:bg-emerald-700 flex items-center gap-1 border-none cursor-pointer whitespace-nowrap"
        >
          <HiOutlinePaperAirplane className="w-4 h-4" /> Enviar recordatorios
        </button>
      </div>

      {loading && !list.length ? (
        <p className="text-sm text-slate-400 py-8 text-center">Cargando…</p>
      ) : !list.length ? (
        <div className="border border-dashed border-slate-200 rounded-2xl py-10 text-center">
          <HiOutlineCalendarDays className="w-8 h-8 text-slate-300 mx-auto mb-2" />
          <p className="text-sm text-slate-500">Todavía no has enviado ningún recordatorio desde la agenda.</p>
          <p className="text-xs text-slate-400 mt-1">
            Necesitas una automatización con el disparador “Citas de la agenda (envío manual)”.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {list.map((b) => {
            const meta = STATUS_META[b.status] || STATUS_META.pending;
            const fuera =
              (b.skippedDuplicate || 0) + (b.skippedNoPhone || 0) + (b.skippedOptOut || 0) + (b.skippedNoPatient || 0);
            return (
              <div key={b._id} className="border border-slate-200 rounded-xl px-3 py-2.5 bg-white">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-700 flex items-center gap-2 flex-wrap">
                      {b.name || 'Envío de recordatorios'}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${meta.chip}`}>{meta.label}</span>
                    </div>
                    <div className="text-[11px] text-slate-400">
                      {fmtDateTime(b.createdAt)}
                      {b.createdByName && ` · ${b.createdByName}`}
                      {(b.workflows || []).length > 0 && ` · ${b.workflows.map((w) => w.name).join(', ')}`}
                    </div>
                  </div>
                  <div className="text-right text-xs shrink-0">
                    <div className="text-emerald-700 font-semibold">{b.enrolled || 0} enviándose</div>
                    <div className="text-slate-400">de {b.total || 0} cita(s)</div>
                  </div>
                </div>

                {(fuera > 0 || b.cancelledPending > 0 || b.warning || b.errorMessage) && (
                  <div className="mt-2 pt-2 border-t border-slate-100 space-y-1">
                    {fuera > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {b.skippedNoPhone > 0 && <Tag>{b.skippedNoPhone} sin teléfono</Tag>}
                        {b.skippedOptOut > 0 && <Tag>{b.skippedOptOut} dados de baja</Tag>}
                        {b.skippedDuplicate > 0 && <Tag>{b.skippedDuplicate} repetidos / ya encolados</Tag>}
                        {b.skippedNoPatient > 0 && <Tag>{b.skippedNoPatient} sin ficha de paciente</Tag>}
                      </div>
                    )}
                    {b.cancelledPending > 0 && (
                      <p className="text-[11px] text-slate-500">
                        Se cancelaron {b.cancelledPending} envíos pendientes de la tanda anterior.
                      </p>
                    )}
                    {b.warning && <p className="text-[11px] text-amber-700">{b.warning}</p>}
                    {b.errorMessage && <p className="text-[11px] text-rose-700">{b.errorMessage}</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {wizardOpen && (
        <AppointmentBlastWizard
          initialDate={initialDate}
          onClose={() => setWizardOpen(false)}
          onDone={() => { setWizardOpen(false); load(); }}
        />
      )}
    </div>
  );
}

function Tag({ children }) {
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-600">{children}</span>
  );
}
