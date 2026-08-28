import { useEffect, useMemo, useRef, useState } from 'react';
import { HiOutlineCheck, HiOutlineMagnifyingGlass, HiOutlinePencil } from 'react-icons/hi2';
import Modal from './Modal';
import { SUERO_OPCIONES, SUERO_GRUPO_LABEL, claveSuero } from '../constants/sueroterapia';

/**
 * QUÉ LLEVA DENTRO EL SUERO: el catálogo entero, a pantalla completa.
 *
 * Antes esto era un desplegable metido en una fila de la tabla de la receta, y
 * ahí no cabía: el campo medía 26 px de alto, la lista copiaba su ancho y
 * recortaba los nombres justo por donde se diferencian —«AZUL DE METILENO 3ML»,
 * «AZUL METILENO 10ML»—, y al abrirse hacia abajo al final de un formulario
 * largo se salía de la ventana. El médico no veía lo que elegía.
 *
 * El problema era ESTRUCTURAL, no de estilo: una fila de tabla no tiene sitio
 * para 104 opciones con su nombre completo, su código y el aviso de las que
 * están dadas de baja. Por eso el catálogo se sale a un modal, que en el móvil
 * es la pantalla entera —el único sitio donde hay espacio de verdad—.
 *
 * SE ELIGEN VARIAS DE UNA VEZ. Un suero lleva de tres a cinco ampollas; con el
 * desplegable de antes eran cuatro interacciones por cada una, a ciegas.
 *
 * EL CATÁLOGO NO ES UNA JAULA: si lo que hace falta no está, «Usar lo que
 * escribí» lo receta igual. Lo que sí se ve es la diferencia entre las dos
 * cosas, porque no es cosmética: sin `code` no hay de dónde descontar el
 * inventario, y el médico tiene derecho a saberlo antes de guardar.
 */

/**
 * Texto → clave de comparación. Se apoya en `claveSuero` a propósito: es la
 * misma regla con la que el servidor busca la ampolla en el inventario, y tener
 * dos normalizaciones distintas es como acaba un buscador enseñando algo que
 * luego no se encuentra al guardar.
 */
const plano = (s) => claveSuero(s).toLowerCase();

const PORCODIGO = new Map(SUERO_OPCIONES.map((o) => [o.code, o]));

function Chip({ tono, children, title }) {
  const tonos = {
    verde: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    gris: 'bg-slate-100 text-slate-600 ring-slate-200',
    ambar: 'bg-amber-50 text-amber-700 ring-amber-200',
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset whitespace-nowrap ${tonos[tono]}`}
    >
      {children}
    </span>
  );
}

export default function SelectorComponentesSuero({ isOpen, seleccionados = [], onClose, onConfirm }) {
  const [busqueda, setBusqueda] = useState('');
  const [grupo, setGrupo] = useState('todo');
  const [marcados, setMarcados] = useState(() => new Set());
  const [cursor, setCursor] = useState(0);
  const refLista = useRef(null);
  const refBusqueda = useRef(null);

  // Al abrir se parte de lo que la preparación YA lleva: el selector sirve tanto
  // para añadir como para quitar, y reabrirlo tiene que enseñar el estado real.
  useEffect(() => {
    if (!isOpen) return;
    setMarcados(new Set((seleccionados || []).map((c) => c.code).filter(Boolean)));
    setBusqueda('');
    setGrupo('todo');
    setCursor(0);
    // `seleccionados` fuera de las dependencias a propósito: es un arreglo nuevo
    // en cada render del padre y reiniciaría las marcas mientras se elige.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const cuentas = useMemo(
    () => ({
      todo: SUERO_OPCIONES.length,
      ampolla: SUERO_OPCIONES.filter((o) => o.grupo === 'ampolla').length,
      molecula: SUERO_OPCIONES.filter((o) => o.grupo === 'molecula').length,
    }),
    []
  );

  const filtradas = useMemo(() => {
    const base = grupo === 'todo' ? SUERO_OPCIONES : SUERO_OPCIONES.filter((o) => o.grupo === grupo);
    // Se busca por PALABRAS SUELTAS, no por subcadena. Con una sola subcadena,
    // «azul metileno» no encontraba «AZUL DE METILENO 3ML MOL» (le sobra el
    // «DE») y «triptofano gaba» no encontraba «TRIPTOFANO + GABA TAB». El
    // buscador se quedaba en blanco e invitaba a escribir el nombre a mano —y
    // eso deja el componente sin código, o sea sin descontar del inventario—.
    const terminos = plano(busqueda).split(/\s+/).filter(Boolean);
    if (!terminos.length) return base;
    const coinciden = base.filter((o) => {
      const n = plano(`${o.name} ${o.code}`);
      return terminos.every((t) => n.includes(t));
    });
    // Las que EMPIEZAN por lo escrito, primero.
    const q = terminos[0];
    return [
      ...coinciden.filter((o) => plano(o.name).startsWith(q)),
      ...coinciden.filter((o) => !plano(o.name).startsWith(q)),
    ];
  }, [busqueda, grupo]);

  useEffect(() => setCursor(0), [busqueda, grupo]);

  // El resaltado del teclado tiene que seguir viéndose al bajar por la lista.
  useEffect(() => {
    refLista.current?.children?.[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor, filtradas]);

  const alternar = (code) =>
    setMarcados((prev) => {
      const s = new Set(prev);
      if (s.has(code)) s.delete(code);
      else s.add(code);
      return s;
    });

  const escrito = busqueda.trim();
  // Solo se ofrece escribir a mano si de verdad no está en el catálogo: si está,
  // lo que hay que hacer es marcarlo, para que se lleve su código.
  const hayExacto = SUERO_OPCIONES.some((o) => claveSuero(o.name) === claveSuero(escrito));
  const puedeEscribir = !!escrito && !hayExacto;

  const confirmar = (extraLibre = null) => {
    const previos = seleccionados || [];
    const yaEstaba = new Set(previos.map((c) => c.code).filter(Boolean));
    // Se conserva el ORDEN y las CANTIDADES de lo que ya estaba: volver a abrir
    // el selector para añadir una ampolla no puede reordenar la preparación ni
    // devolver a 1 una dosis que el médico ya había ajustado. Lo escrito a mano
    // (sin código) se conserva siempre: el catálogo no lo conoce y desmarcarlo
    // no es algo que se pueda hacer aquí.
    const conservados = previos.filter((c) => !c.code || marcados.has(c.code));
    const nuevos = [...marcados]
      .filter((code) => !yaEstaba.has(code))
      .map((code) => PORCODIGO.get(code))
      .filter(Boolean)
      .map((o) => ({ name: o.name, code: o.code, grupo: o.grupo, quantity: 1 }));

    const libre = extraLibre ? [{ name: extraLibre, code: '', grupo: 'otro', quantity: 1 }] : [];
    onConfirm([...conservados, ...nuevos, ...libre]);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(filtradas.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Enter marca y DEJA EL MODAL ABIERTO: casi nunca se añade una sola
      // ampolla. Se cierra con Ctrl/⌘+Enter, cuando ya está toda la bolsa.
      if (e.ctrlKey || e.metaKey) confirmar();
      else if (filtradas[cursor]) alternar(filtradas[cursor].code);
      else if (puedeEscribir) confirmar(escrito);
    }
  };

  const total = marcados.size;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Ampollas y moléculas del suero" size="xl">
      <div className="flex flex-col gap-3" onKeyDown={onKeyDown}>
        <div className="relative">
          <HiOutlineMagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            ref={refBusqueda}
            autoFocus
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar por nombre o código…  (p. ej. «azul metileno», «vit c»)"
            className="input pl-10"
            autoComplete="off"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {[
            ['todo', 'Todo'],
            ['ampolla', 'Ampollas'],
            ['molecula', 'Moléculas'],
          ].map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setGrupo(k)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium border cursor-pointer transition-colors ${
                grupo === k
                  ? 'bg-sky-600 text-white border-sky-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
              }`}
            >
              {label} <span className="opacity-70 tabular-nums">{cuentas[k]}</span>
            </button>
          ))}
          {total > 0 && (
            <span className="ml-auto text-xs font-medium text-sky-700">
              {total} {total === 1 ? 'seleccionada' : 'seleccionadas'}
            </span>
          )}
        </div>

        <div
          ref={refLista}
          className="min-h-[12rem] max-h-[min(55vh,26rem)] overflow-y-auto rounded-xl border border-slate-200 divide-y divide-slate-100"
        >
          {filtradas.map((o, i) => {
            const activa = marcados.has(o.code);
            return (
              <button
                key={o.code}
                type="button"
                onClick={() => alternar(o.code)}
                onMouseEnter={() => setCursor(i)}
                className={`w-full flex items-start gap-3 text-left px-3 py-2.5 bg-transparent border-none cursor-pointer ${
                  i === cursor ? 'bg-slate-50' : ''
                }`}
              >
                <span
                  className={`mt-0.5 shrink-0 w-5 h-5 rounded-md border flex items-center justify-center ${
                    activa ? 'bg-emerald-600 border-emerald-600' : 'bg-white border-slate-300'
                  }`}
                >
                  {activa && <HiOutlineCheck className="w-3.5 h-3.5 text-white" />}
                </span>
                <span className="flex-1 min-w-0">
                  {/* Sin `truncate`: los nombres se diferencian POR EL FINAL
                      (3ML / 4ML / 5ML / 10ML). Recortarlos no era un problema
                      estético, era elegir la ampolla equivocada. */}
                  <span className="block text-sm text-slate-800 leading-snug break-words">{o.name}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-1">
                    <Chip tono="gris">{SUERO_GRUPO_LABEL[o.grupo] || 'Otro'}</Chip>
                    <Chip tono="verde" title="Con este código se descuenta del inventario">{o.code}</Chip>
                    {!o.activo && (
                      <Chip tono="ambar" title="El laboratorio la dio de baja. Se puede recetar igual.">
                        dada de baja
                      </Chip>
                    )}
                  </span>
                </span>
              </button>
            );
          })}

          {filtradas.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-slate-400">
              Nada coincide con «{escrito}».
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          {puedeEscribir && (
            <button
              type="button"
              onClick={() => confirmar(escrito)}
              title="Se receta igual, pero sin código no se descuenta del inventario"
              className="mr-auto inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 cursor-pointer"
            >
              <HiOutlinePencil className="w-4 h-4 shrink-0" />
              Usar «{escrito}» tal cual
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 bg-white border border-slate-200 cursor-pointer"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => confirmar()}
            className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-emerald-600 border-none cursor-pointer"
          >
            {total > 0 ? `Añadir ${total}` : 'Listo'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
