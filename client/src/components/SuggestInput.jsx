import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HiOutlineChevronDown, HiOutlinePlus } from 'react-icons/hi2';

/**
 * BUSCADOR DE LO QUE YA EXISTE, con permiso para escribir algo nuevo.
 *
 * El campo de texto en blanco obliga a escribirlo TODO de memoria, y de ahí sale
 * el destrozo silencioso de las métricas: "Prostata 1", "prostata 1" y
 * "Próstata 1" son tres filas distintas en el embudo aunque sean la misma cosa.
 * Al pinchar, este campo enseña lo que ya se ha usado (lo más usado primero, que
 * es el nombre bueno); escribiendo se filtra; y si de verdad es algo nuevo, con
 * Enter se queda lo escrito. Nada de listas cerradas: no se puede bloquear a
 * quien atiende porque falte una opción.
 *
 * La lista va en un portal con posición FIJA: dentro de un modal con scroll, un
 * desplegable normal se corta por el borde del modal.
 *
 * Props:
 *  - value        : texto del campo (controlado)
 *  - onChange     : (texto) => void — mientras se escribe
 *  - onSelect     : (texto) => void — al elegir una opción o pulsar Enter
 *  - options      : ['Botox'] o [{ name: 'Botox', count: 12 }] — lo que ya existe
 *  - allowCreate  : si false, Enter con texto libre no hace nada (por defecto true)
 *  - emptyHint    : qué decir cuando todavía no hay nada creado
 */
const plano = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export default function SuggestInput({
  value = '',
  onChange,
  onSelect,
  options = [],
  placeholder = '',
  className = '',
  allowCreate = true,
  emptyHint = 'Todavía no hay ninguna creada. Escribe la primera.',
  autoFocus = false,
  onKeyDownExtra,
  onBlur,
}) {
  const [abierto, setAbierto] = useState(false);
  const [marcado, setMarcado] = useState(-1);
  const [caja, setCaja] = useState(null);
  const refInput = useRef(null);
  const refLista = useRef(null);

  const items = useMemo(
    () => (options || [])
      .map((o) => (typeof o === 'string' ? { name: o, count: 0 } : { name: o?.name || '', count: o?.count || 0 }))
      .filter((o) => o.name),
    [options]
  );

  const texto = String(value || '');
  const filtradas = useMemo(() => {
    const q = plano(texto.trim());
    if (!q) return items;
    // Las que EMPIEZAN por lo escrito van primero: escribiendo "pro" interesa
    // más "Prostata 1" que "Control de próstata".
    const empiezan = items.filter((o) => plano(o.name).startsWith(q));
    const contienen = items.filter((o) => !plano(o.name).startsWith(q) && plano(o.name).includes(q));
    return [...empiezan, ...contienen];
  }, [items, texto]);

  // Enter crea solo si lo escrito no es EXACTAMENTE una de las que ya existen
  // (si lo es, se elige esa y no se duplica por una mayúscula).
  const yaExiste = filtradas.some((o) => plano(o.name) === plano(texto.trim()));
  const puedeCrear = allowCreate && !!texto.trim() && !yaExiste;

  const medir = () => {
    const r = refInput.current?.getBoundingClientRect();
    if (r) setCaja({ top: r.bottom + 4, left: r.left, width: r.width, espacioAbajo: window.innerHeight - r.bottom });
  };

  // Se mide ANTES de abrir, en el propio manejador del clic: medirlo dentro de
  // un efecto encadena un render de más cada vez que se abre la lista.
  const abrir = () => { medir(); setAbierto(true); };

  useEffect(() => {
    if (!abierto) return;
    // La lista es fija: si la página (o el modal) se mueve, hay que reubicarla.
    // `true` = fase de captura, para enterarse también del scroll de los
    // contenedores internos, que no burbujea.
    const recolocar = () => medir();
    window.addEventListener('scroll', recolocar, true);
    window.addEventListener('resize', recolocar);
    const fuera = (e) => {
      if (refInput.current?.contains(e.target) || refLista.current?.contains(e.target)) return;
      setAbierto(false);
    };
    document.addEventListener('mousedown', fuera);
    return () => {
      window.removeEventListener('scroll', recolocar, true);
      window.removeEventListener('resize', recolocar);
      document.removeEventListener('mousedown', fuera);
    };
  }, [abierto]);

  const elegir = (nombre) => {
    const t = String(nombre || '').trim();
    if (!t) return;
    onSelect?.(t);
    setAbierto(false);
    setMarcado(-1);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!abierto) { abrir(); setMarcado(0); return; }
      setMarcado((m) => Math.min(filtradas.length - 1, m + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setMarcado((m) => Math.max(-1, m - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (abierto && marcado >= 0 && filtradas[marcado]) elegir(filtradas[marcado].name);
      else if (yaExiste) elegir(filtradas.find((o) => plano(o.name) === plano(texto.trim())).name);
      else if (puedeCrear) elegir(texto);
    } else if (e.key === 'Escape') {
      if (abierto) {
        // Sin esto, Escape cerraría el MODAL entero y se perdería lo escrito:
        // el modal escucha la tecla en `document`.
        e.preventDefault();
        e.stopPropagation();
        setAbierto(false);
      }
    }
    onKeyDownExtra?.(e);
  };

  return (
    <span className="relative inline-flex w-full">
      <input
        ref={refInput}
        value={texto}
        autoFocus={autoFocus}
        onChange={(e) => { onChange?.(e.target.value); abrir(); setMarcado(-1); }}
        onFocus={abrir}
        onClick={abrir}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className={className}
        autoComplete="off"
      />
      <HiOutlineChevronDown
        className={`pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 transition-transform ${abierto ? 'rotate-180' : ''}`}
      />

      {abierto && caja && createPortal(
        <div
          ref={refLista}
          className="fixed z-[10000] bg-white border border-slate-200 rounded-xl shadow-xl overflow-y-auto py-1"
          style={{
            top: caja.top,
            left: caja.left,
            width: caja.width,
            maxHeight: Math.max(140, Math.min(288, caja.espacioAbajo - 16)),
          }}
        >
          {filtradas.length === 0 && (
            <p className="px-3 py-2 text-[11px] text-slate-400">
              {items.length ? 'Nada coincide. Pulsa Enter para usar lo que escribiste.' : emptyHint}
            </p>
          )}
          {filtradas.map((o, i) => (
            <button
              key={o.name}
              type="button"
              // `onMouseDown` y no `onClick`: el clic quitaría el foco del campo
              // y la lista se cerraría antes de llegar a elegir nada.
              onMouseDown={(e) => { e.preventDefault(); elegir(o.name); }}
              onMouseEnter={() => setMarcado(i)}
              className={`w-full text-left px-3 py-2 text-sm bg-transparent border-none cursor-pointer flex items-center gap-2 ${
                i === marcado ? 'bg-emerald-50 text-emerald-800' : 'text-slate-700'
              }`}
            >
              <span className="truncate flex-1">{o.name}</span>
              {o.count > 0 && (
                <span className="text-[10px] text-slate-400 shrink-0 tabular-nums">{o.count}</span>
              )}
            </button>
          ))}
          {puedeCrear && (
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); elegir(texto); }}
              className="w-full text-left px-3 py-2 text-sm bg-transparent border-none cursor-pointer flex items-center gap-2 text-emerald-700 border-t border-slate-100"
            >
              <HiOutlinePlus className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">Crear «{texto.trim()}»</span>
            </button>
          )}
        </div>,
        document.body
      )}
    </span>
  );
}
