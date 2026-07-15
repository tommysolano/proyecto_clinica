import { useRef, useState } from 'react';
import { HiOutlineFaceSmile, HiOutlineListBullet } from 'react-icons/hi2';

/**
 * Área de texto para mensajes de WhatsApp/email con barra de formato:
 * negrita/cursiva/tachado (marcadores nativos de WhatsApp), viñetas, menú de
 * variables y selector de emojis. Es un textarea controlado normal: recibe
 * `value` + `onChange(nuevoTexto)`.
 *
 * `variables`: catálogo de variables insertables. Por defecto solo {{nombre}}
 * (chats/campañas); el editor de workflows pasa MESSAGE_VARIABLES completo
 * (el backend las resuelve con datos del paciente y de la cita del contexto).
 */
export const MESSAGE_VARIABLES = [
  { key: 'nombre', label: 'Nombre del paciente' },
  { key: 'apellido', label: 'Apellido del paciente' },
  { key: 'nombre_completo', label: 'Nombre completo' },
  { key: 'fecha_cita', label: 'Fecha de la cita', cita: true },
  { key: 'hora_cita', label: 'Hora de la cita', cita: true },
  { key: 'servicio', label: 'Servicio(s) de la cita', cita: true },
  { key: 'doctor', label: 'Doctor de la cita', cita: true },
  { key: 'sede', label: 'Sede / sucursal de la cita', cita: true },
];
const DEFAULT_VARIABLES = [MESSAGE_VARIABLES[0]];

const EMOJIS = {
  'Frecuentes': ['😀', '😁', '😂', '🤣', '😊', '😍', '🥰', '😘', '😎', '🤗', '🙂', '😉', '🙌', '👏', '🙏', '👍', '👌', '✌️', '💪', '🤝'],
  'Salud': ['🩺', '💉', '💊', '🦷', '🧠', '❤️', '🫀', '🩹', '🏥', '👩‍⚕️', '👨‍⚕️', '🧬', '🔬', '🌡️', '😷', '🤒', '🛌', '🧘', '🏃', '🥗'],
  'Celebración': ['🎉', '🎊', '🎂', '🎁', '🥳', '🎈', '✨', '🌟', '⭐', '🏆', '🥇', '💯', '🔥', '❤️‍🔥', '💖', '💝', '🌹', '🌸', '☀️', '🌈'],
  'Tiempo y citas': ['📅', '🗓️', '⏰', '⌚', '⏳', '🕐', '📍', '📌', '📞', '📱', '💬', '✅', '☑️', '✔️', '❌', '⚠️', '❗', '❓', '💵', '💳'],
};

export default function WhatsappTextArea({ value = '', onChange, rows = 5, placeholder = 'Mensaje…', showVariables = true, variables = DEFAULT_VARIABLES }) {
  const ref = useRef(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showVars, setShowVars] = useState(false);

  // Inserta texto en la posición del cursor (o reemplaza la selección).
  const insertAt = (text, { wrap = null } = {}) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    let next;
    let caret;
    if (wrap) {
      const selected = value.slice(start, end) || text;
      next = value.slice(0, start) + wrap + selected + wrap + value.slice(end);
      caret = start + wrap.length + selected.length + wrap.length;
    } else {
      next = value.slice(0, start) + text + value.slice(end);
      caret = start + text.length;
    }
    onChange(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  // Convierte las líneas seleccionadas (o la línea actual) en viñetas.
  const bulletize = () => {
    const el = ref.current;
    const start = el?.selectionStart ?? 0;
    const end = el?.selectionEnd ?? value.length;
    const lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    const lineEndIdx = value.indexOf('\n', end);
    const lineEnd = lineEndIdx === -1 ? value.length : lineEndIdx;
    const block = value.slice(lineStart, lineEnd);
    const bulleted = block
      .split('\n')
      .map((l) => (l.trim().startsWith('•') ? l : `• ${l}`))
      .join('\n');
    const next = value.slice(0, lineStart) + bulleted + value.slice(lineEnd);
    onChange(next);
    requestAnimationFrame(() => el?.focus());
  };

  const FmtBtn = ({ label, title, onClick, className = '' }) => (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault() /* no perder la selección del textarea */}
      onClick={onClick}
      className={`px-2 py-1 rounded-md text-xs bg-white border border-slate-200 text-slate-600 hover:border-emerald-400 hover:text-emerald-700 cursor-pointer ${className}`}
    >
      {label}
    </button>
  );

  return (
    <div className="relative">
      <div className="flex items-center gap-1 flex-wrap mb-1.5">
        <FmtBtn label={<b>N</b>} title="Negrita (*texto*)" onClick={() => insertAt('texto', { wrap: '*' })} />
        <FmtBtn label={<i>C</i>} title="Cursiva (_texto_)" onClick={() => insertAt('texto', { wrap: '_' })} />
        <FmtBtn label={<s>T</s>} title="Tachado (~texto~)" onClick={() => insertAt('texto', { wrap: '~' })} />
        <FmtBtn label={<HiOutlineListBullet className="w-4 h-4" />} title="Viñetas" onClick={bulletize} />
        {showVariables && variables.length === 1 && (
          <FmtBtn label={`{{${variables[0].key}}}`} title={`Insertar: ${variables[0].label}`} onClick={() => insertAt(`{{${variables[0].key}}}`)} className="font-mono" />
        )}
        {showVariables && variables.length > 1 && (
          <FmtBtn
            label="{{ }} Variables"
            title="Insertar una variable"
            onClick={() => { setShowVars((v) => !v); setShowEmoji(false); }}
            className={`font-mono ${showVars ? 'border-emerald-400 text-emerald-700' : ''}`}
          />
        )}
        <FmtBtn
          label={<HiOutlineFaceSmile className="w-4 h-4" />}
          title="Emojis"
          onClick={() => { setShowEmoji((v) => !v); setShowVars(false); }}
          className={showEmoji ? 'border-emerald-400 text-emerald-700' : ''}
        />
      </div>

      {showVars && (
        <div className="absolute z-30 top-9 left-0 w-72 max-h-64 overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-xl p-1.5">
          {variables.map((v) => (
            <button
              key={v.key}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { insertAt(`{{${v.key}}}`); setShowVars(false); }}
              className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-emerald-50 bg-transparent border-none cursor-pointer flex items-center justify-between gap-2"
            >
              <span className="text-xs text-slate-700">{v.label}</span>
              <code className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-100 rounded px-1 py-0.5">{`{{${v.key}}}`}</code>
            </button>
          ))}
          {variables.some((v) => v.cita) && (
            <p className="text-[10px] text-slate-400 px-2 pt-1 border-t border-slate-100 mt-1">
              Las variables de cita (fecha, hora, servicio, doctor, sede) se llenan solo cuando el
              flujo se disparó por una CITA (agendada, no asistió, etc.); en otros disparadores
              quedan vacías.
            </p>
          )}
        </div>
      )}

      {showEmoji && (
        <div className="absolute z-30 top-9 right-0 w-72 max-h-56 overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-xl p-2">
          {Object.entries(EMOJIS).map(([group, list]) => (
            <div key={group} className="mb-1.5">
              <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide px-1 mb-0.5">{group}</div>
              <div className="grid grid-cols-10 gap-0.5">
                {list.map((em) => (
                  <button
                    key={em}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { insertAt(em); setShowEmoji(false); }}
                    className="text-lg leading-none p-1 rounded hover:bg-slate-100 bg-transparent border-none cursor-pointer"
                  >
                    {em}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full border border-slate-200 rounded-lg px-2.5 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500/40"
      />
      <p className="text-[10px] text-slate-400 mt-0.5">
        WhatsApp muestra *negrita*, _cursiva_ y ~tachado~ con esos símbolos. Los emojis y viñetas se envían tal cual.
      </p>
    </div>
  );
}
