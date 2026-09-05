import { HiOutlineCheckCircle, HiOutlinePlus, HiOutlineTrash } from 'react-icons/hi2';
import NumericInput from './NumericInput';
import {
  SUERO_CLORURO_NOMBRE,
  SUERO_CLORURO_VOLUMENES,
  SUERO_GRUPO_LABEL,
  buscarComponenteSuero,
} from '../constants/sueroterapia';

/**
 * COMPOSICIÓN DE UN SUERO: el cloruro que hace de base y lo que va dentro.
 *
 * Un suero no es una línea de receta, es una preparación. Hasta ahora la línea
 * decía "suero x7" y lo que llevaba dentro se quedaba en la cabeza del médico o
 * en un papel; enfermería, que es quien lo prepara, tenía que preguntar. Aquí se
 * escribe una vez y se lee tal cual al aplicarlo.
 *
 * El catálogo del laboratorio se elige en `SelectorComponentesSuero`, a pantalla
 * completa: aquí no cabía. Lo que queda en la línea es el RESUMEN de la bolsa,
 * que es lo que el médico necesita mirar —qué lleva, cuánto de cada cosa, y si
 * va a descontarse del inventario o no—.
 *
 * NO ES UNA LISTA CERRADA: se puede escribir algo que no esté en el catálogo y
 * se receta igual. Pero eso se AVISA, porque no es lo mismo: sin código no hay
 * de dónde descontar la ampolla, y antes esa diferencia era invisible.
 */
export default function SueroComposicionEditor({ base, componentes, onChangeBase, onChangeComponentes, onAbrirCatalogo }) {
  const volumen = base?.volumeMl ?? null;
  const filas = Array.isArray(componentes) ? componentes : [];

  const setFila = (idx, patch) =>
    onChangeComponentes(filas.map((f, i) => (i === idx ? { ...f, ...patch } : f)));

  // Escribir a mano re-resuelve contra el catálogo en cada pulsación: si lo
  // tecleado acaba coincidiendo con una ampolla de verdad, recupera su CÓDIGO y
  // vuelve a descontarse del inventario. Sin esto, quien prefiere teclear se
  // quedaba siempre sin código aunque escribiera el nombre exacto.
  const setNombreLibre = (idx, texto) => {
    const cat = buscarComponenteSuero({ name: texto });
    setFila(idx, { name: texto, code: cat?.code || '', grupo: cat?.grupo || 'otro' });
  };

  return (
    <div className="mt-2 rounded-lg border border-sky-200 bg-sky-50/60 p-2.5 space-y-2">
      <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-sky-700">
        Preparación del suero
      </p>

      {/**
        * El cloruro va en todos: lo único que se elige es el tamaño de la bolsa,
        * y ELEGIRLO ES OPCIONAL.
        *
        * Antes el campo se pintaba en ámbar con un «falta el volumen de la
        * bolsa», que se lee como un error por corregir: el médico que no quiere
        * fijar el tamaño —porque lo decide enfermería con lo que haya en la
        * sala— se quedaba con una advertencia permanente en la receta. La
        * preocupación de entonces era que sin volumen el cloruro desapareciera
        * de la receta impresa; eso está resuelto en `describeSuero`, que ahora
        * nombra la base aunque no lleve medida.
        */}
      <label className="flex flex-wrap items-center gap-2 text-xs text-slate-700">
        <span className="font-medium">{base?.name || SUERO_CLORURO_NOMBRE}</span>
        {/* El ancho lo pone el contenedor, no una utilidad encima del campo:
            `.input` ya trae `width:100%`. */}
        <span className="block w-32">
          <select
            value={volumen ?? ''}
            onChange={(e) =>
              onChangeBase({
                name: base?.name || SUERO_CLORURO_NOMBRE,
                volumeMl: e.target.value === '' ? null : Number(e.target.value),
              })
            }
            className="input input-sm cursor-pointer"
          >
            <option value="">Sin especificar</option>
            {SUERO_CLORURO_VOLUMENES.map((v) => (
              <option key={v} value={v}>{v} ml</option>
            ))}
          </select>
        </span>
        <span className="text-slate-400">
          {volumen ? 'va en todos los sueros' : 'volumen opcional: lo decide enfermería'}
        </span>
      </label>

      {filas.length > 0 && (
        <ul className="m-0 p-0 list-none space-y-1">
          {filas.map((f, idx) => {
            const delCatalogo = !!f.code;
            return (
              /**
               * DOS LÍNEAS, no una fila de columnas.
               *
               * El nombre va SOLO, a todo el ancho, y no compite con nada: es lo
               * único que no puede encogerse. Con el nombre y la cantidad en la
               * misma fila, bastaba que el ancho del campo de cantidad no ganara
               * la cascada para que se llevara toda la línea y el nombre se
               * pintara en vertical, una letra por renglón.
               */
              <li
                key={idx}
                className="rounded-md bg-white/80 border border-sky-100 px-2 py-1.5"
              >
                {delCatalogo ? (
                  // Del catálogo: el nombre NO se edita. Cambiarle una letra lo
                  // dejaría con el código de otra ampolla, y el inventario
                  // descontaría la que no es. Para cambiarla, se quita y se
                  // elige otra.
                  <p className="m-0 text-xs text-slate-800 leading-snug">{f.name}</p>
                ) : (
                  <input
                    type="text"
                    value={f.name || ''}
                    onChange={(e) => setNombreLibre(idx, e.target.value)}
                    placeholder="Escribe la ampolla o molécula…"
                    className="input input-sm"
                  />
                )}

                <div className="mt-1 flex items-center gap-2">
                  <span className="flex-1 min-w-0 truncate">
                    {delCatalogo ? (
                      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-700">
                        <HiOutlineCheckCircle className="w-3 h-3 shrink-0" />
                        {SUERO_GRUPO_LABEL[f.grupo] || 'Otro'} · {f.code}
                      </span>
                    ) : (
                      <span className="text-[10px] text-amber-700">
                        escrito a mano · no se descuenta del inventario
                      </span>
                    )}
                  </span>
                  <label className="flex items-center gap-1 shrink-0">
                    <span className="text-[10px] text-slate-500">Cant.</span>
                    {/* El ancho lo pone ESTE contenedor, no una utilidad encima
                        del campo: `.input` ya trae `width:100%` y pelearse con
                        él en la cascada es lo que rompió esta fila. */}
                    <span className="block w-16">
                      <NumericInput
                        min={1}
                        value={f.quantity ?? 1}
                        onChange={(e) =>
                          setFila(idx, { quantity: e.target.value === '' ? '' : Number(e.target.value) })
                        }
                        title="Cantidad"
                        className="input input-sm text-center"
                      />
                    </span>
                  </label>
                  <button
                    type="button"
                    onClick={() => onChangeComponentes(filas.filter((_, i) => i !== idx))}
                    title="Quitar"
                    className="p-1 text-red-500 bg-transparent border-none cursor-pointer shrink-0"
                  >
                    <HiOutlineTrash className="w-3.5 h-3.5" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onAbrirCatalogo}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-white bg-sky-600 border-none cursor-pointer"
        >
          <HiOutlinePlus className="w-3.5 h-3.5" />
          {filas.length ? 'Añadir o quitar del catálogo' : 'Añadir ampollas o moléculas'}
        </button>
        <button
          type="button"
          onClick={() => onChangeComponentes([...filas, { name: '', code: '', grupo: 'otro', quantity: 1 }])}
          className="text-xs font-medium text-sky-700 hover:text-sky-800 bg-transparent border-none cursor-pointer p-0"
        >
          Escribir a mano
        </button>
      </div>
    </div>
  );
}
