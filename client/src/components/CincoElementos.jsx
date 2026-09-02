/**
 * ANÁLISIS DE LOS CINCO ELEMENTOS (Wu Xing).
 *
 * Sustituye a la «revisión de órganos y sistemas» en la consulta del terapeuta:
 * él no explora por aparatos, mira cómo está el paciente en los cinco elementos
 * y lo anota en cada uno.
 *
 * LAS FLECHAS LAS DIBUJA EL TERAPEUTA (sep-2026). Antes salían pintadas las dos
 * ruedas clásicas —apoyo y control— en todas las consultas por igual, y eso era
 * justo lo contrario de lo que hace falta: el esquema impreso ya lo tiene en la
 * cabeza, lo que anota de ESTE paciente es qué relación está fallando. Así que
 * el lienzo nace limpio y se dibuja encima, arrastrando de un elemento a otro.
 *
 * POR QUÉ NO ES UN SVG A SECAS. El dibujo tiene que llevar un CAMPO DE TEXTO
 * pegado a cada círculo, y un `<input>` dentro de un SVG (`foreignObject`) se
 * comporta distinto en cada navegador. Aquí el esquema son dos capas: un SVG
 * con las flechas —que es geometría pura— y encima cinco bloques HTML colocados
 * por porcentaje, cada uno con su círculo y su campo. Así el campo es un campo
 * de verdad: se enfoca, se expande y se escribe en él.
 *
 * EL COLOR NO ES ADORNO. Madera y Metal comparten la letra M (así lo pidió la
 * clínica, y así está impreso el esquema de toda la vida): lo que las distingue
 * es el verde y el blanco. Si alguien "mejora" esto pintándolo todo del mismo
 * color, el gráfico deja de poder leerse.
 */
import { useRef, useState, useId } from 'react';
import { HiOutlinePencil, HiOutlineArrowUturnLeft, HiOutlineTrash, HiOutlineCheck } from 'react-icons/hi2';
import { TERAPIA_ELEMENTOS } from '../constants/specialtyCatalogs';

/**
 * El lienzo NO es cuadrado: mide 141×100 y el pentágono ocupa la parte de en
 * medio. Los ~20 de cada lado son el sitio de los campos de Madera y Tierra,
 * que van por fuera de sus círculos.
 *
 * La relación 141/100 es también la del `viewBox`, así que el SVG escala igual
 * en los dos ejes: una unidad mide lo mismo a lo ancho que a lo alto y las
 * distancias se pueden calcular con Pitágoras sin corregir nada.
 */
const VW = 141;
const VH = 100;

/**
 * Radio del círculo EN UNIDADES del lienzo, para recortar las flechas que
 * nacen o mueren en un elemento.
 *
 * El círculo mide 40 px de radio en pantalla grande y 26 en el móvil, mientras
 * que el lienzo es elástico: en unidades eso son 9,1 y 10,8. Con 10 la punta
 * cae justo fuera del círculo en los dos casos.
 */
const R_CIRCULO = 10;
// Hasta dónde «agarra» un elemento al empezar o soltar el trazo. Un poco más
// que el círculo: apuntar al centro exacto con el dedo es imposible.
const R_IMAN = 13;
// Un toque sin arrastrar no es una flecha: es un clic.
const LARGO_MINIMO = 5;

/** Centro de un elemento, en unidades del lienzo. */
const centro = (e) => ({ x: (e.x * VW) / 100, y: (e.y * VH) / 100 });

/**
 * Dónde va el campo de texto de cada elemento (solo en pantalla ancha).
 *
 * Madera a la IZQUIERDA y Tierra a la DERECHA, los dos por fuera del círculo:
 * antes caían hacia dentro y el texto se metía en medio del dibujo. Agua y
 * Metal van debajo, que están a la misma altura y sus campos se pisaban.
 */
const LADO = {
  fuego: 'derecha',
  tierra: 'derecha',
  madera: 'izquierda',
  agua: 'abajo',
  metal: 'abajo',
};

const TIPOS = [
  { key: 'apoyo', label: 'Apoyo', color: '#94a3b8' },
  { key: 'control', label: 'Control', color: '#1f2937' },
];
const colorDe = (tipo) => (TIPOS.find((t) => t.key === tipo) || TIPOS[1]).color;

/**
 * @param {object} value  { elementos: [{key, texto}], flechas: [...], … } — el bloque `terapia`
 * @param {function} onChange
 * @param {boolean} [readOnly] modo lectura para el historial
 */
export default function CincoElementos({ value, onChange, readOnly = false }) {
  const o = value || {};
  const porKey = Object.fromEntries((o.elementos || []).map((e) => [e.key, e.texto || '']));
  const flechas = Array.isArray(o.flechas) ? o.flechas : [];
  // Cuál está abierto para escribir. Solo uno: el campo expandido flota por
  // encima del dibujo y dos abiertos a la vez se pisarían.
  const [abierto, setAbierto] = useState('');
  // Modo dibujo: mientras está encendido el lienzo se lleva los clics (para
  // trazar y para borrar) y los campos no estorban. Apagado, se escribe.
  const [dibujando, setDibujando] = useState(false);
  const [tipo, setTipo] = useState('control');
  const [trazo, setTrazo] = useState(null);
  const svgRef = useRef(null);
  /**
   * Los <marker> del SVG se referencian por id y el id es GLOBAL del documento.
   * El historial monta un gráfico por cada consulta del terapeuta, así que con
   * un id fijo todos apuntarían al primero que hubiera en la página.
   */
  const uid = useId().replace(/:/g, '');

  const setTexto = (key, texto) => {
    if (readOnly) return;
    const resto = (o.elementos || []).filter((e) => e.key !== key);
    // Un elemento sin texto no es un hallazgo, es un hueco: no se guarda.
    const next = texto.trim() ? [...resto, { key, texto }] : resto;
    // Se reordena como el catálogo para que el dato no dependa de en qué orden
    // fue escribiendo el terapeuta.
    onChange({
      ...o,
      elementos: TERAPIA_ELEMENTOS.filter((e) => next.some((n) => n.key === e.key)).map(
        (e) => next.find((n) => n.key === e.key)
      ),
    });
  };

  const setFlechas = (lista) => onChange({ ...o, flechas: lista });

  // ── Dibujo ──────────────────────────────────────────────────────────────
  const punto = (ev) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r?.width || !r?.height) return null;
    return {
      x: ((ev.clientX - r.left) / r.width) * VW,
      y: ((ev.clientY - r.top) / r.height) * VH,
    };
  };

  /** El elemento bajo el dedo, si lo hay (para que la flecha nazca en su borde). */
  const elementoEn = (p) =>
    TERAPIA_ELEMENTOS.find((e) => {
      const c = centro(e);
      return Math.hypot(p.x - c.x, p.y - c.y) <= R_IMAN;
    });

  const empezar = (ev) => {
    if (readOnly || !dibujando) return;
    const p = punto(ev);
    if (!p) return;
    ev.currentTarget.setPointerCapture?.(ev.pointerId);
    setTrazo({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
  };

  const mover = (ev) => {
    if (!trazo) return;
    const p = punto(ev);
    if (!p) return;
    setTrazo((t) => ({ ...t, x2: p.x, y2: p.y }));
  };

  /**
   * Al soltar: si el trazo empieza o acaba DENTRO de un círculo, se ancla a su
   * centro y se recorta por el borde. Así las flechas salen limpias aunque se
   * dibujen a pulso —que es como se dibujan, con el paciente delante— y el
   * historial las vuelve a pintar sin tener que recalcular nada.
   */
  const soltar = () => {
    if (!trazo) return;
    const t = trazo;
    setTrazo(null);
    const desde = elementoEn({ x: t.x1, y: t.y1 });
    const hasta = elementoEn({ x: t.x2, y: t.y2 });
    let { x1, y1, x2, y2 } = t;
    if (desde) ({ x: x1, y: y1 } = centro(desde));
    if (hasta) ({ x: x2, y: y2 } = centro(hasta));
    const largo = Math.hypot(x2 - x1, y2 - y1);
    // Dos anclas en el mismo elemento, o un toque suelto: no hay flecha.
    if (largo < LARGO_MINIMO) return;
    const ux = (x2 - x1) / largo;
    const uy = (y2 - y1) / largo;
    if (desde) { x1 += ux * R_CIRCULO; y1 += uy * R_CIRCULO; }
    if (hasta) { x2 -= ux * R_CIRCULO; y2 -= uy * R_CIRCULO; }
    if (Math.hypot(x2 - x1, y2 - y1) < 1) return;
    const r2 = (n) => Math.round(n * 10) / 10;
    setFlechas([...flechas, { x1: r2(x1), y1: r2(y1), x2: r2(x2), y2: r2(y2), tipo }]);
  };

  const borrarFlecha = (idx) => setFlechas(flechas.filter((_, i) => i !== idx));

  const botonTool =
    'flex items-center gap-1 text-[11px] px-2 py-1 rounded border cursor-pointer transition-colors';

  return (
    <div className="space-y-2">
      {!readOnly && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => { setDibujando((v) => !v); setTrazo(null); }}
              className={`${botonTool} ${
                dibujando
                  ? 'bg-emerald-600 border-emerald-600 text-white'
                  : 'bg-white border-slate-300 text-slate-600 hover:border-emerald-400'
              }`}
            >
              {dibujando ? <HiOutlineCheck className="w-3.5 h-3.5" /> : <HiOutlinePencil className="w-3.5 h-3.5" />}
              {dibujando ? 'Terminar de dibujar' : 'Dibujar flechas'}
            </button>
            {dibujando && (
              <>
                {TIPOS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setTipo(t.key)}
                    className={`${botonTool} bg-white ${
                      tipo === t.key ? 'border-emerald-500 text-slate-800 font-semibold' : 'border-slate-200 text-slate-500'
                    }`}
                  >
                    <span className="inline-block w-4 h-0.5 rounded" style={{ background: t.color }} />
                    {t.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setFlechas(flechas.slice(0, -1))}
                  disabled={!flechas.length}
                  className={`${botonTool} bg-white border-slate-200 text-slate-500 disabled:opacity-40`}
                >
                  <HiOutlineArrowUturnLeft className="w-3.5 h-3.5" /> Deshacer
                </button>
                <button
                  type="button"
                  onClick={() => setFlechas([])}
                  disabled={!flechas.length}
                  className={`${botonTool} bg-white border-rose-200 text-rose-600 disabled:opacity-40`}
                >
                  <HiOutlineTrash className="w-3.5 h-3.5" /> Borrar todas
                </button>
              </>
            )}
          </div>
          <p className="text-[11px] text-slate-500">
            {dibujando
              ? 'Arrastra de un elemento a otro para trazar la flecha. Pincha una flecha ya dibujada para borrarla.'
              : 'Escribe en el recuadro de cada elemento. Para trazar las relaciones, pulsa «Dibujar flechas».'}
          </p>
        </>
      )}

      {/* El lienzo mide 141×100 (ver arriba): el pentágono va en medio y los
          costados son el hueco de los campos de Madera y Tierra. El radio del
          círculo viaja en una variable CSS porque lo usan el círculo y la
          separación de su campo, y cambia con el tamaño de la pantalla. */}
      <div
        className="relative w-full max-w-[620px] mx-auto aspect-[141/100] [--ce-r:26px] sm:[--ce-r:40px]"
      >
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VW} ${VH}`}
          className="absolute inset-0 w-full h-full"
          style={{
            // Fuera del modo dibujo el lienzo no se lleva ningún clic: los
            // campos y los círculos quedan libres.
            pointerEvents: dibujando ? 'auto' : 'none',
            cursor: dibujando ? 'crosshair' : 'default',
            zIndex: dibujando ? 30 : 0,
            touchAction: dibujando ? 'none' : 'auto',
          }}
          onPointerDown={empezar}
          onPointerMove={mover}
          onPointerUp={soltar}
          onPointerCancel={() => setTrazo(null)}
        >
          <defs>
            {TIPOS.map((t) => (
              <marker
                key={t.key}
                id={`ce-${t.key}-${uid}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M0,1 L9,5 L0,9 z" fill={t.color} />
              </marker>
            ))}
          </defs>

          {flechas.map((f, i) => (
            <g key={i}>
              <line
                x1={f.x1}
                y1={f.y1}
                x2={f.x2}
                y2={f.y2}
                stroke={colorDe(f.tipo)}
                strokeWidth="1.1"
                markerEnd={`url(#ce-${f.tipo === 'apoyo' ? 'apoyo' : 'control'}-${uid})`}
              />
              {/* Zona de agarre para borrarla: la línea de 1 unidad es
                  imposible de acertar con el dedo. */}
              {dibujando && (
                <line
                  x1={f.x1}
                  y1={f.y1}
                  x2={f.x2}
                  y2={f.y2}
                  stroke="transparent"
                  strokeWidth="3.5"
                  style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                  onPointerDown={(ev) => { ev.stopPropagation(); borrarFlecha(i); }}
                >
                  <title>Pincha para borrar esta flecha</title>
                </line>
              )}
            </g>
          ))}

          {trazo && (
            <line
              x1={trazo.x1}
              y1={trazo.y1}
              x2={trazo.x2}
              y2={trazo.y2}
              stroke={colorDe(tipo)}
              strokeWidth="1.1"
              strokeDasharray="2 2"
            />
          )}
        </svg>

        {/**
          * CADA BLOQUE ES UN PUNTO SIN TAMAÑO sobre su vértice, y de él cuelgan
          * el círculo y el campo, los dos en posición absoluta.
          *
          * Es la parte delicada del componente. La versión obvia —un flex con
          * el círculo y el campo dentro, centrado con translate(-50%,-50%)—
          * centra la CAJA ENTERA, no el círculo: con el campo al lado, el
          * círculo acababa a medio centenar de píxeles de su vértice, las
          * flechas apuntaban al vacío y los de los extremos se salían del
          * lienzo. Peor aún, al enfocar un campo la caja crecía y el círculo
          * SALTABA de sitio mientras se escribía.
          */}
        {TERAPIA_ELEMENTOS.map((e) => {
          const texto = porKey[e.key] || '';
          const activo = abierto === e.key;
          const lado = LADO[e.key] || 'derecha';
          const separacion = 'calc(var(--ce-r) + 8px)';
          /**
           * Anchos medidos contra el lienzo grande (620 px): el campo de Madera
           * cabe justo en el margen izquierdo y el de Tierra en el derecho. Al
           * escribir, el campo crece a lo alto Y a lo ancho y se sale un poco
           * por el costado — flota por encima y es mientras se escribe, que es
           * como estaba pensado desde el principio.
           */
          const ancho = lado === 'abajo' ? 130 : activo ? 170 : 100;
          const posicion =
            lado === 'abajo'
              ? { top: separacion, left: -(ancho / 2) }
              : { top: -16, [lado === 'izquierda' ? 'right' : 'left']: separacion };
          return (
            <div
              key={e.key}
              className="absolute"
              style={{
                left: `${e.x}%`,
                top: `${e.y}%`,
                width: 0,
                height: 0,
                // El que se está escribiendo pasa por encima del resto.
                zIndex: activo ? 20 : 10,
              }}
            >
              {/* El círculo, centrado EN el vértice: es donde acaban las
                  flechas. Se centra con translate para que el tamaño (que
                  cambia entre móvil y escritorio) no obligue a tocar nada. */}
              <span
                title={e.label}
                className="absolute rounded-full border border-slate-400 flex items-center justify-center font-bold text-lg sm:text-2xl select-none shadow-sm"
                style={{
                  width: 'calc(var(--ce-r) * 2)',
                  height: 'calc(var(--ce-r) * 2)',
                  transform: 'translate(-50%, -50%)',
                  background: e.color,
                  color: e.texto,
                }}
              >
                {e.letra}
              </span>

              {/* En el móvil los campos no caben junto a los círculos: van en
                  lista debajo del dibujo (más abajo en este mismo archivo). */}
              {readOnly ? (
                texto ? (
                  <span
                    className="hidden sm:block absolute text-[11px] text-slate-700 bg-white/90 border border-slate-200 rounded px-1.5 py-0.5 break-words shadow-sm"
                    style={{ ...posicion, width: ancho }}
                  >
                    {texto}
                  </span>
                ) : null
              ) : (
                <textarea
                  value={texto}
                  onChange={(ev) => setTexto(e.key, ev.target.value)}
                  onFocus={() => setAbierto(e.key)}
                  onBlur={() => setAbierto('')}
                  rows={activo ? 4 : 1}
                  placeholder={e.label}
                  className="hidden sm:block absolute text-[11px] border border-slate-300 rounded px-1.5 py-1 outline-none focus:border-emerald-500 bg-white resize-none shadow-sm"
                  style={{ ...posicion, width: ancho }}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Los mismos cinco campos, en lista, para el móvil. Con el círculo de 80
          px no hay hueco al lado para escribir: o van debajo o no se llenan. */}
      <div className="sm:hidden space-y-1.5">
        {TERAPIA_ELEMENTOS.map((e) => {
          const texto = porKey[e.key] || '';
          if (readOnly && !texto) return null;
          return (
            <div key={e.key} className="flex items-center gap-2">
              <span
                className="w-6 h-6 shrink-0 rounded-full border border-slate-400 flex items-center justify-center text-[11px] font-bold"
                style={{ background: e.color, color: e.texto }}
              >
                {e.letra}
              </span>
              {readOnly ? (
                <span className="text-[11px] text-slate-700">{texto}</span>
              ) : (
                <input
                  type="text"
                  value={texto}
                  onChange={(ev) => setTexto(e.key, ev.target.value)}
                  placeholder={e.label}
                  className="flex-1 text-xs border border-slate-300 rounded px-2 py-1 outline-none focus:border-emerald-500"
                />
              )}
            </div>
          );
        })}
      </div>

      {/* La leyenda es parte del esquema: sin ella los dos círculos con M no se
          pueden nombrar, solo reconocer. */}
      <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
        {TERAPIA_ELEMENTOS.map((e) => (
          <span key={e.key} className="flex items-center gap-1">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full border border-slate-400"
              style={{ background: e.color }}
            />
            {e.letra} · {e.label}
          </span>
        ))}
      </div>
    </div>
  );
}
