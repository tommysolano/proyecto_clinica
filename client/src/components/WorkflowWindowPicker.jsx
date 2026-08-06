import { HiOutlineClock } from 'react-icons/hi2';
import { DAY_CHIPS } from '../utils/windowSchedule';

const PRESETS = [
  { label: 'Lun a Vie', days: [1, 2, 3, 4, 5] },
  { label: 'Lun a Sáb', days: [1, 2, 3, 4, 5, 6] },
  { label: 'Todos', days: [0, 1, 2, 3, 4, 5, 6] },
];

/**
 * Selector de VENTANA HORARIA (días + franja) de las automatizaciones, al estilo
 * de la "Time Window" de GoHighLevel / las "ventanas" de Daplox.
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

  return (
    <div className="grid gap-3 text-sm">
      <div>
        <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Días</label>
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
        <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Horario</label>
        <div className="flex items-center gap-2">
          <input
            type="time"
            value={from}
            onChange={(e) => onChange({ from: e.target.value })}
            className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
          />
          <span className="text-slate-400">a</span>
          <input
            type="time"
            value={to}
            onChange={(e) => onChange({ to: e.target.value })}
            className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm"
          />
        </div>
      </div>

      {!days.length && (
        <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
          Sin ningún día marcado la ventana no restringe nada: el flujo trabajaría a cualquier hora.
        </p>
      )}
      {crossesMidnight && (
        <p className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 flex gap-1.5">
          <HiOutlineClock className="w-4 h-4 shrink-0 mt-px" />
          <span>La franja cruza la medianoche: empieza a las {from} del día marcado y termina a las {to} del día siguiente.</span>
        </p>
      )}
    </div>
  );
}
