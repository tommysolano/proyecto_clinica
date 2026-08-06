import { HiOutlineClock } from 'react-icons/hi2';
import { DAY_CHIPS, isAlwaysQuiet } from '../utils/windowSchedule';

const PRESETS = [
  { label: 'Lun a Vie', days: [1, 2, 3, 4, 5] },
  { label: 'Lun a Sáb', days: [1, 2, 3, 4, 5, 6] },
  { label: 'Todos', days: [0, 1, 2, 3, 4, 5, 6] },
];

/**
 * Selector de VENTANA HORARIA (días + franja) de las automatizaciones.
 *
 * La franja que se elige aquí es la de SILENCIO: las horas en las que la
 * automatización NO debe molestar. Es al revés de como estaba antes, y el cambio
 * vino de producción: todas las ventanas configuradas decían "23:00–06:20"
 * queriendo decir "no molestar de noche", y el sistema las leía como "enviar
 * SOLO de noche". Los textos de abajo son la mitad del arreglo: si vuelven a
 * sugerir lo contrario, el error regresa.
 *
 * Lo comparten:
 *  - la ventana de envío de TODO el workflow (cabecera del editor), y
 *  - el nodo "Ventana horaria" del diagrama.
 *
 * `value` = { days:[0..6], from:'HH:MM', to:'HH:MM' } (0 = domingo). Emite solo
 * el trozo que cambia por `onChange`. La hora es siempre la de Ecuador.
 */
export default function WorkflowWindowPicker({ value = {}, onChange }) {
  const days = Array.isArray(value.days) ? value.days : [];
  const from = value.from || '09:00';
  const to = value.to || '18:00';
  const toggleDay = (d) =>
    onChange({ days: days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort((a, b) => a - b) });
  const crossesMidnight = from > to;
  const alwaysQuiet = isAlwaysQuiet({ days, from, to });

  return (
    <div className="grid gap-3 text-sm">
      <div>
        <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
          Días en los que se calla
        </label>
        <div className="flex flex-wrap gap-1.5">
          {DAY_CHIPS.map((d) => {
            const on = days.includes(d.value);
            return (
              <button
                key={d.value}
                type="button"
                onClick={() => toggleDay(d.value)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer transition-colors ${
                  on
                    ? 'bg-emerald-500 border-emerald-500 text-white'
                    : 'bg-white border-slate-200 text-slate-500 hover:border-emerald-300'
                }`}
              >
                {d.label}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-2 mt-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => onChange({ days: p.days })}
              className="text-[11px] text-emerald-600 hover:text-emerald-700 bg-transparent border-none cursor-pointer underline decoration-dotted"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
          No enviar entre
        </label>
        <div className="flex items-center gap-2">
          <input
            type="time"
            value={from}
            onChange={(e) => onChange({ from: e.target.value })}
            className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
          />
          <span className="text-slate-400">y</span>
          <input
            type="time"
            value={to}
            onChange={(e) => onChange({ to: e.target.value })}
            className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
          />
        </div>
      </div>

      {days.length > 0 && !alwaysQuiet && (
        <p className="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-2 py-1.5">
          Entre las <b>{from}</b> y las <b>{to}</b> de los días marcados la automatización <b>no envía nada</b>.
          Quien entre en esa franja no se pierde: recibe su mensaje a las <b>{to}</b>, al terminar el silencio.
          El resto del tiempo funciona con normalidad.
        </p>
      )}
      {!days.length && (
        <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
          Sin ningún día marcado la ventana no silencia nada: el flujo enviaría a cualquier hora.
        </p>
      )}
      {alwaysQuiet && (
        <p className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded-lg px-2 py-1.5">
          Con la misma hora de inicio y fin los 7 días, el silencio duraría siempre y el flujo no enviaría
          nunca. Así configurada, la ventana se ignora: cambia la hora de fin.
        </p>
      )}
      {crossesMidnight && (
        <p className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 flex gap-1.5">
          <HiOutlineClock className="w-4 h-4 shrink-0 mt-px" />
          <span>El silencio cruza la medianoche: empieza a las {from} del día marcado y termina a las {to} del día siguiente.</span>
        </p>
      )}
    </div>
  );
}
