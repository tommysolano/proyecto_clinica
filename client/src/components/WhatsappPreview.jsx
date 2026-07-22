import { HiOutlinePhoto, HiOutlineDocumentText, HiOutlineArrowTopRightOnSquare, HiOutlinePhone, HiOutlineArrowUturnLeft } from 'react-icons/hi2';

/**
 * Previsualización tipo burbuja de WhatsApp de una plantilla.
 * Props: template = { headerType, headerText, headerMediaUrl, body, footer, buttons }
 * `sampleVars` (opcional): mapa { '1': 'Juan' } o array para sustituir {{n}}/{{nombre}}.
 */
function fillVars(text = '', sampleVars) {
  if (!sampleVars) return text;
  return String(text).replace(/\{\{\s*([\w]+)\s*\}\}/g, (m, key) => {
    if (Array.isArray(sampleVars)) {
      const idx = Number(key) - 1;
      return sampleVars[idx] != null ? sampleVars[idx] : m;
    }
    return sampleVars[key] != null ? sampleVars[key] : m;
  });
}

export default function WhatsappPreview({ template = {}, sampleVars }) {
  const { headerType = 'none', headerText = '', headerMediaUrl = '', body = '', footer = '', buttons = [] } = template;
  const now = new Date();
  const hh = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  return (
    <div
      className="rounded-xl p-3 min-h-[220px]"
      style={{
        background:
          '#e5ddd5 url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'40\' height=\'40\'%3E%3Cg fill=\'%23d9cfc4\' fill-opacity=\'0.4\'%3E%3Ccircle cx=\'10\' cy=\'10\' r=\'1.5\'/%3E%3C/g%3E%3C/svg%3E")',
      }}
    >
      <div className="max-w-[85%] bg-white rounded-lg rounded-tl-none shadow-sm px-2.5 pt-2 pb-1.5 text-[13px] text-slate-800">
        {/* Cabecera */}
        {headerType === 'image' && (
          headerMediaUrl ? (
            <img src={headerMediaUrl} alt="header" className="w-full max-h-44 object-cover rounded-md mb-1.5" />
          ) : (
            <div className="w-full h-28 bg-slate-100 rounded-md mb-1.5 flex items-center justify-center text-slate-400">
              <HiOutlinePhoto className="w-8 h-8" />
            </div>
          )
        )}
        {headerType === 'document' && (
          <div className="w-full bg-slate-100 rounded-md mb-1.5 flex items-center gap-2 px-2 py-3 text-slate-500">
            <HiOutlineDocumentText className="w-6 h-6" /> <span className="text-xs">Documento adjunto</span>
          </div>
        )}
        {headerType === 'text' && headerText && (
          <div className="font-semibold text-slate-900 mb-0.5">{fillVars(headerText, sampleVars)}</div>
        )}

        {/* Cuerpo */}
        <div className="whitespace-pre-wrap break-words leading-snug">
          {fillVars(body, sampleVars) || <span className="text-slate-400">Cuerpo del mensaje…</span>}
        </div>

        {/* Pie */}
        {footer && <div className="text-[11px] text-slate-400 mt-1">{fillVars(footer, sampleVars)}</div>}

        <div className="text-[10px] text-slate-400 text-right mt-0.5">{hh} ✓✓</div>
      </div>

      {/* Botones */}
      {buttons && buttons.length > 0 && (
        <div className="max-w-[85%] mt-1 space-y-0.5">
          {buttons.map((b, i) => (
            <div
              key={i}
              className="bg-white rounded-lg shadow-sm text-[13px] text-sky-600 font-medium py-2 text-center flex items-center justify-center gap-1.5"
            >
              {b.type === 'url' && <HiOutlineArrowTopRightOnSquare className="w-4 h-4" />}
              {b.type === 'phone' && <HiOutlinePhone className="w-4 h-4" />}
              {b.type === 'quick_reply' && <HiOutlineArrowUturnLeft className="w-4 h-4" />}
              {b.text || 'Botón'}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
