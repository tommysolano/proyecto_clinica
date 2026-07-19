import { useEffect, useRef, useState } from 'react';

// Emojis agrupados por categoría (sin dependencias externas: solo Unicode, seguro
// para el CSP del VPS). Set curado y práctico para atención por WhatsApp.
const EMOJI_GROUPS = [
  {
    label: 'Caras',
    emojis: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '😋', '😛', '😜', '🤪', '😝', '🤗', '🤔', '🤨', '😐', '😶', '🙄', '😏', '😴', '😌', '😔', '😪', '😷', '🤒', '🤕', '🥳', '😎', '🤓', '😭', '😢', '😥', '😩', '😫', '😤', '😠', '😡', '🥺', '😳', '😱', '😬'],
  },
  {
    label: 'Gestos',
    emojis: ['👍', '👎', '👌', '🤌', '✌️', '🤞', '🤟', '🤙', '👈', '👉', '👆', '👇', '☝️', '✋', '🤚', '🖐️', '👋', '🙌', '👏', '🙏', '🤝', '💪', '🫶', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💯', '🔥', '✨', '⭐', '🌟', '💫', '🎉', '🎊', '💥'],
  },
  {
    label: 'Salud',
    emojis: ['🦷', '💉', '💊', '🩺', '🩹', '🧴', '🧼', '😁', '👄', '👁️', '✅', '☑️', '❌', '⚠️', '📅', '🗓️', '⏰', '⌚', '📍', '🏥', '🚑', '👩‍⚕️', '👨‍⚕️', '🧖‍♀️', '💆‍♀️', '💇‍♀️', '💅', '🪥', '😍', '🥰'],
  },
  {
    label: 'Objetos',
    emojis: ['📱', '📞', '☎️', '📲', '💬', '📩', '📨', '✉️', '📎', '📌', '📝', '✏️', '📷', '🎥', '🔔', '🔕', '💰', '💵', '💳', '🏷️', '🎁', '🛒', '🔗', '📄', '📋', '🖼️', '🎤', '🎶', '☀️', '🌙'],
  },
];

const FORMATS = [
  { key: 'bold', marker: '*', title: 'Negrita (*texto*)', label: 'B', cls: 'font-bold' },
  { key: 'italic', marker: '_', title: 'Cursiva (_texto_)', label: 'I', cls: 'italic font-serif' },
  { key: 'strike', marker: '~', title: 'Tachado (~texto~)', label: 'S', cls: 'line-through' },
  { key: 'mono', marker: '```', title: 'Monoespaciado (```texto```)', label: '</>', cls: 'font-mono text-[10px]' },
];

// Barra de formato para el compositor de chat. Inserta los marcadores de
// WhatsApp (*negrita*, _cursiva_, ~tachado~, ```mono```), viñetas y emojis
// directamente sobre el textarea referenciado por `composerRef`.
export default function ChatComposerToolbar({ composerRef, value, onChange, disabled }) {
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [group, setGroup] = useState(0);
  const popRef = useRef(null);

  useEffect(() => {
    if (!emojiOpen) return;
    const onDoc = (e) => {
      if (popRef.current && !popRef.current.contains(e.target)) setEmojiOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [emojiOpen]);

  // Aplica una transformación sobre el textarea respetando la selección actual y
  // reposiciona el cursor tras el re-render de React.
  const applyEdit = (fn) => {
    const el = composerRef?.current;
    const val = value ?? '';
    const s = el ? el.selectionStart : val.length;
    const e = el ? el.selectionEnd : val.length;
    const res = fn(val, s, e);
    onChange(res.text);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(res.selStart, res.selEnd);
    });
  };

  const surround = (marker) =>
    applyEdit((val, s, e) => {
      const sel = val.slice(s, e);
      if (sel) {
        return {
          text: val.slice(0, s) + marker + sel + marker + val.slice(e),
          selStart: s + marker.length,
          selEnd: e + marker.length,
        };
      }
      const pos = s + marker.length;
      return { text: val.slice(0, s) + marker + marker + val.slice(e), selStart: pos, selEnd: pos };
    });

  const bulletList = () =>
    applyEdit((val, s, e) => {
      const lineStart = val.lastIndexOf('\n', s - 1) + 1;
      let lineEnd = val.indexOf('\n', e);
      if (lineEnd === -1) lineEnd = val.length;
      const block = val.slice(lineStart, lineEnd) || '';
      const prefixed = block
        .split('\n')
        .map((ln) => (ln.startsWith('- ') ? ln : `- ${ln}`))
        .join('\n');
      return {
        text: val.slice(0, lineStart) + prefixed + val.slice(lineEnd),
        selStart: lineStart,
        selEnd: lineStart + prefixed.length,
      };
    });

  const insertText = (t) =>
    applyEdit((val, s, e) => {
      const pos = s + t.length;
      return { text: val.slice(0, s) + t + val.slice(e), selStart: pos, selEnd: pos };
    });

  const btn = 'w-8 h-8 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:border-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer text-sm leading-none';

  return (
    <div className="relative flex flex-wrap items-center gap-1 mb-1.5">
      {FORMATS.map((f) => (
        <button
          key={f.key}
          type="button"
          title={f.title}
          disabled={disabled}
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={() => surround(f.marker)}
          className={btn}
        >
          <span className={f.cls}>{f.label}</span>
        </button>
      ))}
      <button
        type="button"
        title="Lista con viñetas"
        disabled={disabled}
        onMouseDown={(ev) => ev.preventDefault()}
        onClick={bulletList}
        className={btn}
      >
        <span className="text-[13px] leading-none">☰</span>
      </button>
      <span className="w-px h-5 bg-slate-200 mx-0.5" />
      <button
        type="button"
        title="Emojis"
        disabled={disabled}
        onMouseDown={(ev) => ev.preventDefault()}
        onClick={() => setEmojiOpen((v) => !v)}
        className={`${btn} ${emojiOpen ? 'border-emerald-400 bg-emerald-50' : ''}`}
      >
        <span className="text-base leading-none">😊</span>
      </button>

      {emojiOpen && (
        <div
          ref={popRef}
          className="absolute bottom-full left-0 mb-1 w-[300px] max-w-[88vw] bg-white border border-slate-200 rounded-xl shadow-lg z-40 overflow-hidden"
          onMouseDown={(ev) => ev.preventDefault()}
        >
          <div className="flex border-b border-slate-100">
            {EMOJI_GROUPS.map((g, i) => (
              <button
                key={g.label}
                type="button"
                onClick={() => setGroup(i)}
                className={`flex-1 px-1 py-1.5 text-[11px] font-medium border-none cursor-pointer ${
                  group === i ? 'bg-emerald-50 text-emerald-700' : 'bg-white text-slate-500 hover:bg-slate-50'
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
          <div className="p-2 grid grid-cols-8 gap-0.5 max-h-48 overflow-y-auto">
            {EMOJI_GROUPS[group].emojis.map((em, i) => (
              <button
                key={`${em}-${i}`}
                type="button"
                onClick={() => insertText(em)}
                className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-emerald-50 text-lg border-none bg-transparent cursor-pointer"
                title={em}
              >
                {em}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
