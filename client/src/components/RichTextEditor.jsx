import { useRef, useEffect } from 'react';
import { HiOutlineBold, HiOutlineItalic, HiOutlineListBullet, HiOutlineNumberedList } from 'react-icons/hi2';
import { sanitizeHtml } from '../utils/sanitizeHtml';

/**
 * Editor de texto enriquecido ligero, sin dependencias externas. Barra con
 * negrita, cursiva, viñetas y lista numerada sobre un `contentEditable`.
 * Emite HTML saneado (solo etiquetas de formato, sin atributos) vía onChange,
 * de modo que lo que se guarda ya es seguro para renderizar en la página pública.
 *
 * Props: value (HTML string), onChange(html), placeholder, className
 */
export default function RichTextEditor({ value = '', onChange, placeholder = '', className = '' }) {
  const ref = useRef(null);

  // Sincroniza el HTML entrante solo si difiere del actual, para no reposicionar
  // el cursor mientras el usuario escribe.
  useEffect(() => {
    const el = ref.current;
    if (el && el.innerHTML !== (value || '')) {
      el.innerHTML = value || '';
    }
  }, [value]);

  const emit = () => onChange?.(sanitizeHtml(ref.current?.innerHTML || ''));

  // onMouseDown + preventDefault: ejecuta el comando sin perder la selección
  // del editor (si el botón tomara el foco, se perdería el texto seleccionado).
  const run = (cmd) => (e) => {
    e.preventDefault();
    ref.current?.focus();
    document.execCommand(cmd, false, null);
    emit();
  };

  const btn = 'p-1.5 rounded hover:bg-slate-200 text-slate-600 border-none bg-transparent cursor-pointer flex items-center justify-center';

  return (
    <div className={`border border-slate-200 rounded-lg overflow-hidden bg-white ${className}`}>
      <div className="flex items-center gap-0.5 px-1.5 py-1 border-b border-slate-100 bg-slate-50">
        <button type="button" title="Negrita" onMouseDown={run('bold')} className={btn}><HiOutlineBold className="w-4 h-4" /></button>
        <button type="button" title="Cursiva" onMouseDown={run('italic')} className={btn}><HiOutlineItalic className="w-4 h-4" /></button>
        <span className="w-px h-4 bg-slate-200 mx-0.5" />
        <button type="button" title="Viñetas" onMouseDown={run('insertUnorderedList')} className={btn}><HiOutlineListBullet className="w-4 h-4" /></button>
        <button type="button" title="Lista numerada" onMouseDown={run('insertOrderedList')} className={btn}><HiOutlineNumberedList className="w-4 h-4" /></button>
      </div>
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        data-placeholder={placeholder}
        className="rich-editor px-3 py-2 text-sm min-h-[64px] outline-none [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:my-0 [&_ol]:my-0"
      />
    </div>
  );
}
