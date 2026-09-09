import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  HiOutlineCalendarDays,
  HiOutlineExclamationTriangle,
  HiOutlineCheckCircle,
} from 'react-icons/hi2';
import api from '../../api/axios';
import Modal from '../Modal';
import DateInput from '../DateInput';
import SendTimingBox, { flowSendHourOf } from './SendTimingBox';
import { todayEc, fmtDate } from '../../utils/date';

/**
 * Asistente de RECORDATORIOS DE CITAS: envío masivo a las citas de la agenda.
 *
 * Es el mismo asistente de la importación de contactos con el primer paso
 * cambiado: en lugar de subir un Excel y mapear columnas, se elige un día de la
 * agenda. Todo lo demás —automatización, hora, goteo, número de salida, cancelar
 * lo pendiente— es literalmente el mismo bloque (SendTimingBox), porque las
 * preguntas y las respuestas correctas son las mismas.
 *
 * El paso de confirmación enseña QUIÉN NO va a recibir el mensaje y por qué. Esa
 * es la mitad del valor de la pantalla: un envío que dice "listo" mientras media
 * lista se queda fuera en silencio es lo que hubo que arreglar en la importación.
 */
const STEPS = ['Qué citas', 'Automatización y envío', 'Confirmar'];

const HHMM_RE = /^\d{1,2}:\d{2}$/;

const STATUS_OPTIONS = [
  // «Pendiente» primero y con su nombre de la agenda: era el estado que la gente
  // buscaba y no encontraba porque la etiqueta solo decía «Agendada».
  { value: 'pendiente', label: 'Pendiente (agendada)' },
  { value: 'confirmada', label: 'Confirmada' },
  { value: 'asistida', label: 'Asistida' },
  { value: 'no_asistio', label: 'No asistió' },
  { value: 'completada', label: 'Completada' },
  { value: 'cancelada', label: 'Cancelada' },
];

const REASON_LABEL = {
  sin_paciente: 'La cita no tiene ficha de paciente',
  sin_telefono: 'El paciente no tiene teléfono en su ficha',
  baja: 'El paciente está dado de baja de los mensajes',
  repetido: 'Mismo paciente que otra cita de la tanda',
};

/** Suma días a una fecha ISO 'YYYY-MM-DD' sin salirse del día local. */
function addDays(iso, n) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export default function AppointmentBlastWizard({ initialDate = '', onClose, onDone }) {
  const [step, setStep] = useState(0);
  // Por defecto, MAÑANA: es el recordatorio que se manda de verdad, cada tarde.
  const [filters, setFilters] = useState(() => {
    const day = initialDate || addDays(todayEc(), 1);
    return {
      startDate: day,
      endDate: day,
      // Horario DENTRO de cada día (opcional): para el recordatorio que solo va
      // a las citas de la mañana, por ejemplo. Vacío = todo el día.
      startTimeFrom: '',
      startTimeTo: '',
      clinics: [],
      statuses: ['pendiente', 'confirmada'],
      doctor: '',
      serviceItem: '',
      isFirstVisit: '',
    };
  });
  const [opts, setOpts] = useState({
    workflows: [],
    dripSeconds: 20,
    sendMode: 'now',
    sendAt: '',
    whatsappAccount: '',
    cancelPending: true,
  });

  const [preview, setPreview] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  // Citas que el usuario desmarcó a mano. Se guardan las EXCLUIDAS y no las
  // incluidas para que una cita nueva que entre al cambiar el filtro venga
  // marcada por defecto (lo contrario obligaría a re-marcar toda la lista).
  const [excluded, setExcluded] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const [workflows, setWorkflows] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [clinics, setClinics] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [services, setServices] = useState([]);
  const [pending, setPending] = useState(null);

  useEffect(() => {
    // Automatizaciones utilizables: el backend ya filtra por disparador activo y
    // con pasos conectados, así que aquí no hay que repetir la regla.
    api.get('/appointment-blasts/workflows').then((r) => setWorkflows(r.data || [])).catch(() => {});
    api.get('/contacts/whatsapp-accounts').then((r) => setAccounts(r.data || [])).catch(() => {});
    api.get('/clinics', { params: { scope: 'names' } }).then((r) => setClinics(r.data || [])).catch(() => {});
    api.get('/users/doctors').then((r) => setDoctors(r.data || [])).catch(() => {});
    api.get('/appointment-service-items').then((r) => setServices(r.data || [])).catch(() => {});
  }, []);

  // Vista previa en vivo: cada cambio del filtro vuelve a preguntar cuántas citas
  // hay. Con retardo para no disparar una consulta por cada tecla de la fecha.
  const previewReq = useRef(0);
  useEffect(() => {
    if (!filters.startDate) { setPreview(null); return; }
    const id = ++previewReq.current;
    setLoadingPreview(true);
    const t = setTimeout(() => {
      api
        .post('/appointment-blasts/preview', { filters })
        .then((r) => { if (id === previewReq.current) setPreview(r.data); })
        .catch((err) => {
          if (id !== previewReq.current) return;
          setPreview(null);
          toast.error(err.response?.data?.message || 'No se pudieron leer las citas');
        })
        .finally(() => { if (id === previewReq.current) setLoadingPreview(false); });
    }, 400);
    return () => clearTimeout(t);
  }, [filters]);

  // Lo que quedó a medias del envío anterior de esta automatización: es lo que
  // explica que a un paciente le llegue el recordatorio de la fecha equivocada.
  useEffect(() => {
    const wf = opts.workflows[0];
    if (!wf) { setPending(null); return; }
    let alive = true;
    api
      .get('/appointment-blasts/pending-enrollments', { params: { workflow: wf } })
      .then((r) => { if (alive) setPending(r.data); })
      .catch(() => { if (alive) setPending(null); });
    return () => { alive = false; };
  }, [opts.workflows]);

  const rows = preview?.rows || [];
  const elegibles = useMemo(() => rows.filter((r) => r.eligible), [rows]);
  const descartadas = useMemo(() => rows.filter((r) => !r.eligible), [rows]);
  const seleccionadas = useMemo(
    () => elegibles.filter((r) => !excluded.has(r._id)),
    [elegibles, excluded]
  );

  const toggle = (id) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () =>
    setExcluded((prev) => {
      if (seleccionadas.length === elegibles.length) return new Set(elegibles.map((r) => r._id));
      const next = new Set(prev);
      elegibles.forEach((r) => next.delete(r._id));
      return next;
    });

  const setF = (patch) => setFilters((f) => ({ ...f, ...patch }));

  const confirm = async () => {
    setBusy(true);
    try {
      const r = await api.post('/appointment-blasts', {
        filters,
        appointments: seleccionadas.map((x) => x._id),
        workflows: opts.workflows,
        dripSeconds: opts.dripSeconds,
        sendMode: opts.sendMode,
        sendAt: opts.sendMode === 'at' ? opts.sendAt : '',
        whatsappAccount: opts.whatsappAccount || null,
        cancelPending: opts.cancelPending,
      });
      toast.success(`Envío encolado: ${r.data.total} cita(s). Verás el resultado en la lista.`);
      onDone();
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo crear el envío');
    } finally {
      setBusy(false);
    }
  };

  const puedeSeguir =
    (step === 0 && seleccionadas.length > 0) ||
    (step === 1 && opts.workflows.length > 0 && (opts.sendMode !== 'at' || HHMM_RE.test(opts.sendAt)));

  return (
    <Modal isOpen onClose={onClose} title="Enviar recordatorios a las citas de la agenda" size="2xl">
      <div className="flex items-center gap-1 mb-5">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-1 flex-1">
            <div
              className={`flex items-center gap-1.5 text-xs whitespace-nowrap ${
                i === step ? 'text-emerald-700 font-semibold' : i < step ? 'text-slate-500' : 'text-slate-300'
              }`}
            >
              <span
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${
                  i === step ? 'bg-emerald-600 text-white' : i < step ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-400'
                }`}
              >
                {i < step ? '✓' : i + 1}
              </span>
              {s}
            </div>
            {i < STEPS.length - 1 && <div className={`h-px flex-1 ${i < step ? 'bg-emerald-200' : 'bg-slate-100'}`} />}
          </div>
        ))}
      </div>

      {step === 0 && (
        <StepAudience
          filters={filters}
          setF={setF}
          clinics={clinics}
          doctors={doctors}
          services={services}
          preview={preview}
          loading={loadingPreview}
          rows={rows}
          elegibles={elegibles}
          descartadas={descartadas}
          seleccionadas={seleccionadas}
          excluded={excluded}
          toggle={toggle}
          toggleAll={toggleAll}
        />
      )}

      {step === 1 && (
        <StepAutomation
          opts={opts}
          setOpts={setOpts}
          workflows={workflows}
          accounts={accounts}
          pending={pending}
        />
      )}

      {step === 2 && (
        <StepConfirm
          filters={filters}
          opts={opts}
          workflows={workflows}
          accounts={accounts}
          clinics={clinics}
          seleccionadas={seleccionadas}
          descartadas={descartadas}
        />
      )}

      <div className="flex justify-between gap-2 mt-5 pt-4 border-t border-slate-100">
        <button
          onClick={() => (step === 0 ? onClose() : setStep((s) => s - 1))}
          className="px-4 py-2 text-sm border border-slate-200 rounded-xl bg-white hover:bg-slate-50 cursor-pointer"
        >
          {step === 0 ? 'Cancelar' : '◂ Atrás'}
        </button>
        <div className="flex items-center gap-3">
          {step === 0 && !seleccionadas.length && (
            <span className="text-xs text-rose-600 flex items-center gap-1">
              <HiOutlineExclamationTriangle className="w-4 h-4" />
              No hay ninguna cita marcada
            </span>
          )}
          {step === 1 && !opts.workflows.length && (
            <span className="text-xs text-rose-600 flex items-center gap-1">
              <HiOutlineExclamationTriangle className="w-4 h-4" />
              Elige la automatización
            </span>
          )}
          {step < 2 ? (
            <button
              disabled={!puedeSeguir}
              onClick={() => setStep((s) => s + 1)}
              className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 border-none cursor-pointer disabled:opacity-40 disabled:cursor-default"
            >
              Siguiente ▸
            </button>
          ) : (
            <button
              disabled={busy || !seleccionadas.length}
              onClick={confirm}
              className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 border-none cursor-pointer disabled:opacity-50"
            >
              {busy ? 'Encolando…' : `Enviar a ${seleccionadas.length} cita(s)`}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ───────────────────────── Paso 1: qué citas ─────────────────────────

function StepAudience({
  filters, setF, clinics, doctors, services, preview, loading,
  rows, elegibles, descartadas, seleccionadas, excluded, toggle, toggleAll,
}) {
  const hoy = todayEc();
  const atajo = (desde, hasta = desde) => setF({ startDate: desde, endDate: hasta });

  const toggleStatus = (value) =>
    setF({
      statuses: filters.statuses.includes(value)
        ? filters.statuses.filter((s) => s !== value)
        : [...filters.statuses, value],
    });

  const toggleClinic = (id) =>
    setF({
      clinics: filters.clinics.includes(id)
        ? filters.clinics.filter((c) => c !== id)
        : [...filters.clinics, id],
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Desde</label>
          <DateInput
            value={filters.startDate}
            onChange={(e) => setF({ startDate: e.target.value, endDate: filters.endDate < e.target.value ? e.target.value : filters.endDate })}
            className="w-36 border border-slate-200 rounded-xl px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Hasta</label>
          <DateInput
            value={filters.endDate}
            min={filters.startDate}
            onChange={(e) => setF({ endDate: e.target.value })}
            className="w-36 border border-slate-200 rounded-xl px-3 py-2 text-sm"
          />
        </div>
        <div className="flex items-center gap-1.5 pb-0.5">
          <Chip onClick={() => atajo(addDays(hoy, 1))}>Mañana</Chip>
          <Chip onClick={() => atajo(hoy)}>Hoy</Chip>
          <Chip onClick={() => atajo(hoy, addDays(hoy, 6))}>Próximos 7 días</Chip>
        </div>
      </div>

      {/* HORARIO dentro de cada día (opcional). El rango de fechas dice QUÉ días;
          este dice a cuáles horas de esos días: sin él, "mandar el recordatorio
          solo a las citas de la mañana" obligaba a lanzar el envío y desmarcar a
          mano a las de la tarde. Vacío = todo el día. */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">
            Desde la hora <span className="font-normal text-slate-400">(opcional)</span>
          </label>
          <input
            type="time"
            value={filters.startTimeFrom}
            onChange={(e) => setF({ startTimeFrom: e.target.value })}
            className="w-32 border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white"
          />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">
            Hasta la hora <span className="font-normal text-slate-400">(opcional)</span>
          </label>
          <input
            type="time"
            value={filters.startTimeTo}
            onChange={(e) => setF({ startTimeTo: e.target.value })}
            className="w-32 border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white"
          />
        </div>
        <p className="text-[11px] text-slate-400 pb-1">
          Filtra las citas por la hora a la que empiezan, dentro de los días elegidos.
        </p>
      </div>

      <div>
        <label className="text-xs font-semibold text-slate-600 block mb-1.5">Estado de la cita</label>
        <div className="flex flex-wrap gap-1.5">
          {STATUS_OPTIONS.map((o) => (
            <label
              key={o.value}
              className={`text-xs px-2.5 py-1.5 rounded-lg border cursor-pointer flex items-center gap-1.5 ${
                filters.statuses.includes(o.value)
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                  : 'border-slate-200 text-slate-500 hover:bg-slate-50'
              }`}
            >
              <input
                type="checkbox"
                checked={filters.statuses.includes(o.value)}
                onChange={() => toggleStatus(o.value)}
                className="cursor-pointer"
              />
              {o.label}
            </label>
          ))}
        </div>
        <p className="text-[10px] text-slate-400 mt-1">
          Por defecto solo las citas que siguen en pie: a una cancelada o a una ya atendida no se le
          manda un recordatorio.
        </p>
      </div>

      {clinics.length > 1 && (
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1.5">
            Sucursales <span className="font-normal text-slate-400">(ninguna marcada = todas las que ves)</span>
          </label>
          <div className="flex flex-wrap gap-1.5">
            {clinics.map((c) => (
              <label
                key={c._id}
                className={`text-xs px-2.5 py-1.5 rounded-lg border cursor-pointer flex items-center gap-1.5 ${
                  filters.clinics.includes(c._id)
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                    : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                }`}
              >
                <input
                  type="checkbox"
                  checked={filters.clinics.includes(c._id)}
                  onChange={() => toggleClinic(c._id)}
                  className="cursor-pointer"
                />
                {c.nombreComercial || c.name}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Doctor</label>
          <select
            value={filters.doctor}
            onChange={(e) => setF({ doctor: e.target.value })}
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white"
          >
            <option value="">Todos</option>
            {doctors.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Servicio</label>
          <select
            value={filters.serviceItem}
            onChange={(e) => setF({ serviceItem: e.target.value })}
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white"
          >
            <option value="">Todos</option>
            {services.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-600 block mb-1">Paciente</label>
          <select
            value={filters.isFirstVisit}
            onChange={(e) => setF({ isFirstVisit: e.target.value })}
            className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white"
          >
            <option value="">Todos</option>
            <option value="true">Solo primera visita</option>
            <option value="false">Solo recurrentes</option>
          </select>
        </div>
      </div>

      {(preview?.warnings || []).map((w) => (
        <div key={w} className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2 flex items-start gap-2">
          <HiOutlineExclamationTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <span>{w}</span>
        </div>
      ))}

      <div className="border border-slate-200 rounded-xl overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-50 border-b border-slate-200">
          <div className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
            <HiOutlineCalendarDays className="w-4 h-4 text-emerald-600" />
            {loading ? 'Buscando citas…' : `${seleccionadas.length} de ${elegibles.length} cita(s) marcadas`}
          </div>
          {elegibles.length > 0 && (
            <button
              onClick={toggleAll}
              className="text-xs text-emerald-700 border-none bg-transparent cursor-pointer hover:underline"
            >
              {seleccionadas.length === elegibles.length ? 'Desmarcar todas' : 'Marcar todas'}
            </button>
          )}
        </div>

        <div className="max-h-64 overflow-y-auto">
          {!loading && !rows.length && (
            <p className="text-xs text-slate-400 px-3 py-6 text-center">
              No hay citas con este filtro.
            </p>
          )}
          {elegibles.map((r) => (
            <label
              key={r._id}
              className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-50 text-xs cursor-pointer hover:bg-slate-50"
            >
              <input
                type="checkbox"
                checked={!excluded.has(r._id)}
                onChange={() => toggle(r._id)}
                className="cursor-pointer"
              />
              <span className="w-24 shrink-0 text-slate-500">{fmtDate(r.date)}</span>
              <span className="w-12 shrink-0 text-slate-500">{r.startTime}</span>
              <span className="flex-1 min-w-0 truncate font-medium text-slate-700">{r.patientName || 'Sin nombre'}</span>
              <span className="hidden sm:block w-28 shrink-0 truncate text-slate-400">{r.serviceName}</span>
              <span className="hidden sm:block w-24 shrink-0 truncate text-slate-400">{r.clinicName}</span>
            </label>
          ))}
        </div>

        {descartadas.length > 0 && (
          <div className="border-t border-slate-200 bg-rose-50/40 px-3 py-2">
            <div className="text-xs font-semibold text-rose-800 mb-1">
              {descartadas.length} cita(s) NO recibirán el mensaje
            </div>
            <ul className="text-[11px] text-rose-700 space-y-0.5 max-h-24 overflow-y-auto">
              {descartadas.map((r) => (
                <li key={r._id}>
                  {fmtDate(r.date)} {r.startTime} · {r.patientName || 'Sin nombre'} —{' '}
                  {REASON_LABEL[r.reason] || r.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function Chip({ children, onClick }) {
  return (
    <button
      onClick={onClick}
      className="text-xs px-2.5 py-2 rounded-xl border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 cursor-pointer"
    >
      {children}
    </button>
  );
}

// ─────────────── Paso 2: automatización y envío ───────────────

function StepAutomation({ opts, setOpts, workflows, accounts, pending }) {
  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs font-semibold text-slate-600 block mb-1">
          Automatización que enviará el recordatorio
        </label>
        <select
          value={opts.workflows[0] || ''}
          onChange={(e) => {
            const id = e.target.value;
            // Al elegir flujo: si ya trae su propia hora de envío, se respeta por
            // defecto; si no, sale de inmediato.
            const wf = workflows.find((w) => w._id === id);
            const hasHour = !!flowSendHourOf(wf, 'appointment_bulk');
            setOpts((s) => ({ ...s, workflows: id ? [id] : [], sendMode: id && hasHour ? 'flow' : 'now', sendAt: '' }));
          }}
          className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white"
        >
          <option value="">Ninguna</option>
          {workflows.map((w) => <option key={w._id} value={w._id}>{w.name}</option>)}
        </select>
        {workflows.length === 0 ? (
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2 mt-1">
            No hay automatizaciones con el disparador <b>“Citas de la agenda (envío manual)”</b>.
            Créala en Marketing → Automatizaciones: añade ese disparador, conecta un paso
            <b> Enviar plantilla</b> y actívala; entonces aparecerá aquí.
          </p>
        ) : (
          <p className="text-[10px] text-slate-400 mt-1">
            Cada cita entra a la automatización de forma escalonada (goteo). Como el paciente no habrá
            escrito en las últimas 24 h, por Cloud API el mensaje debe ir en un paso <b>Enviar
            plantilla</b>: el texto libre se omitiría por ventana cerrada.
          </p>
        )}
      </div>

      {/* Lo que quedó a medias del envío anterior. Es la causa de "le llegó el
          recordatorio de ayer": un goteo tarda horas en vaciarse. */}
      {opts.workflows.length > 0 && pending?.pending > 0 && (
        <div className="border border-amber-300 bg-amber-50 rounded-xl p-3">
          <div className="flex items-start gap-2">
            <HiOutlineExclamationTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-amber-900">
                Esta automatización tiene {pending.pending.toLocaleString('es-EC')} recordatorios del
                envío anterior sin salir todavía
              </div>
              <p className="text-[11px] text-amber-800 mt-0.5">
                Son citas de una tanda previa que siguen en cola. Si no los cancelas, esos pacientes
                recibirán el recordatorio <b>de aquellas fechas</b>, mezclado con este envío.
              </p>
              <label className="flex items-start gap-2 mt-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={opts.cancelPending}
                  onChange={(e) => setOpts((s) => ({ ...s, cancelPending: e.target.checked }))}
                  className="mt-0.5 cursor-pointer"
                />
                <span className="text-xs text-amber-900">
                  Cancelar esos {pending.pending.toLocaleString('es-EC')} envíos pendientes y quedarme
                  solo con este. <span className="text-amber-700">Lo ya enviado no se toca.</span>
                </span>
              </label>
            </div>
          </div>
        </div>
      )}

      {opts.workflows.length > 0 && (
        <SendTimingBox
          opts={opts}
          setOpts={setOpts}
          workflows={workflows}
          accounts={accounts}
          triggerType="appointment_bulk"
          noun="cita"
        />
      )}
    </div>
  );
}

// ───────────────────────── Paso 3: confirmar ─────────────────────────

function StepConfirm({ filters, opts, workflows, accounts, clinics, seleccionadas, descartadas }) {
  const selectedWf = workflows.find((w) => w._id === opts.workflows[0]);
  const flowHour = flowSendHourOf(selectedWf, 'appointment_bulk');
  const whenText =
    opts.sendMode === 'at'
      ? `A las ${opts.sendAt || '—'} (hoy si aún no pasa, mañana si ya pasó)`
      : opts.sendMode === 'flow'
        ? `A la hora del flujo${flowHour ? ` (${flowHour})` : ''}`
        : 'De inmediato';

  const rango = filters.endDate && filters.endDate !== filters.startDate
    ? `${fmtDate(filters.startDate)} a ${fmtDate(filters.endDate)}`
    : fmtDate(filters.startDate);
  const sedes = filters.clinics.length
    ? filters.clinics.map((id) => clinics.find((c) => c._id === id)?.name || '—').join(', ')
    : 'Todas las que ves';

  // Cuánto va a tardar la tanda entera con este goteo. Es el dato que evita la
  // sorpresa de "lo lancé a las 6 y a las 9 seguían saliendo mensajes".
  const minutos = Math.round(((seleccionadas.length - 1) * (Number(opts.dripSeconds) || 20)) / 60);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5">
        <HiOutlineCalendarDays className="w-5 h-5 text-emerald-600 shrink-0" />
        <div>
          <div className="font-semibold">{seleccionadas.length} cita(s) recibirán el recordatorio</div>
          <div className="text-xs text-slate-400">
            Citas del {rango}
            {descartadas.length > 0 && ` · ${descartadas.length} descartada(s)`}
          </div>
        </div>
      </div>

      <div className="border border-slate-200 rounded-xl divide-y divide-slate-100 text-sm">
        <Row label="Sucursales">{sedes}</Row>
        <Row label="Horario">
          {filters.startTimeFrom || filters.startTimeTo
            ? `Citas entre ${filters.startTimeFrom || '00:00'} y ${filters.startTimeTo || '23:59'}`
            : 'Todo el día'}
        </Row>
        <Row label="Estados">
          {filters.statuses.length
            ? filters.statuses.map((s) => STATUS_OPTIONS.find((o) => o.value === s)?.label || s).join(', ')
            : 'Agendada y confirmada'}
        </Row>
        <Row label="Automatización">
          {selectedWf ? <span className="text-violet-700">{selectedWf.name}</span> : <span className="text-slate-300">ninguna</span>}
        </Row>
        <Row label="Desde qué número">
          <span className="text-violet-700">
            {opts.whatsappAccount
              ? `Siempre desde ${accounts.find((a) => a._id === opts.whatsappAccount)?.label || 'el número elegido'}`
              : 'Automático — el último número con el que habló cada paciente'}
          </span>
        </Row>
        <Row label="Cuándo enviar"><span className="text-violet-700">{whenText}</span></Row>
        <Row label="Goteo">
          {opts.dripSeconds}s entre cada cita
          {seleccionadas.length > 1 && (
            <span className="text-slate-400"> · la tanda entera tarda ~{minutos || 1} min</span>
          )}
        </Row>
        <Row label="Envíos anteriores">
          {opts.cancelPending ? (
            <span className="text-emerald-700 inline-flex items-center gap-1">
              <HiOutlineCheckCircle className="w-4 h-4" /> Se cancela lo pendiente
            </span>
          ) : (
            <span className="text-amber-700">Se conserva lo pendiente</span>
          )}
        </Row>
      </div>

      <p className="text-xs text-slate-500 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2.5">
        Al pulsar <b>Enviar</b> no tienes que esperar: el envío corre en segundo plano. Cada mensaje
        sabe de qué cita habla, así que si una cita se <b>reagenda</b> el recordatorio se mueve con
        ella y si se <b>cancela</b>, no sale.
      </p>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-3 px-3 py-2">
      <span className="text-xs text-slate-500 shrink-0">{label}</span>
      <span className="text-xs text-slate-700 text-right">{children}</span>
    </div>
  );
}
