import { useRef, useState } from 'react';
import { HiOutlineFaceSmile, HiOutlineListBullet } from 'react-icons/hi2';

/**
 * Área de texto para mensajes de WhatsApp/email con barra de formato:
 * negrita/cursiva/tachado (marcadores nativos de WhatsApp), viñetas, variable
 * {{nombre}} y selector de emojis. Es un textarea controlado normal: recibe
 * `value` + `onChange(nuevoTexto)`.
 */
const EMOJIS = {
  'Frecuentes': ['😀', '😁', '😂', '🤣', '😊', '😍', '🥰', '😘', '😎', '🤗', '🙂', '😉', '🙌', '👏', '🙏', '👍', '👌', '✌️', '💪', '🤝'],
  'Salud': ['🩺', '💉', '💊', '🦷', '🧠', '❤️', '🫀', '🩹', '🏥', '👩‍⚕️', '👨‍⚕️', '🧬', '🔬', '🌡️', '😷', '🤒', '🛌', '🧘', '🏃', '🥗'],
  'Celebración': ['🎉', '🎊', '🎂', '🎁', '🥳', '🎈', '✨', '🌟', '⭐', '🏆', '🥇', '💯', '🔥', '❤️‍🔥', '💖', '💝', '🌹', '🌸', '☀️', '🌈'],
  'Tiempo y citas': ['📅', '🗓️', '⏰', '⌚', '⏳', '🕐', '📍', '📌', '📞', '📱', '💬', '✅', '☑️', '✔️', '❌', '⚠️', '❗', '❓', '💵', '💳'],
};

export default function WhatsappTextArea({ value = '', onChange, rows = 5, placeholder = 'Mensaje…', showVariables = true }) {
  const ref = useRef(null);
  const [showEmoji, setShowEmoji] = useState(false);

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
        {showVariables && (
          <FmtBtn label="{{nombre}}" title="Insertar el nombre del paciente" onClick={() => insertAt('{{nombre}}')} className="font-mono" />
        )}
        <FmtBtn
          label={<HiOutlineFaceSmile className="w-4 h-4" />}
          title="Emojis"
          onClick={() => setShowEmoji((v) => !v)}
          className={showEmoji ? 'border-emerald-400 text-emerald-700' : ''}
        />
      </div>

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
