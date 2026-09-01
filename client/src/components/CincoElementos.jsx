/**
 * ANÁLISIS DE LOS CINCO ELEMENTOS (Wu Xing).
 *
 * Sustituye a la «revisión de órganos y sistemas» en la consulta del terapeuta:
 * él no explora por aparatos, mira cómo está el paciente en los cinco elementos
 * y lo anota en cada uno.
 *
 * POR QUÉ NO ES UN SVG A SECAS. El dibujo tiene que llevar un CAMPO DE TEXTO
 * pegado a cada círculo, y un `<input>` dentro de un SVG (`foreignObject`) se
 * comporta distinto en cada navegador. Aquí el esquema son dos capas: un SVG de
 * fondo con las flechas —que es geometría pura— y encima cinco bloques HTML
 * colocados por porcentaje, cada uno con su círculo y su campo. Así el campo es
 * un campo de verdad: se enfoca, se expande y se escribe en él.
 *
 * EL COLOR NO ES ADORNO. Madera y Metal comparten la letra M (así lo pidió la
 * clínica, y así está impreso el esquema de toda la vida): lo que las distingue
 * es el verde y el blanco. Si alguien "mejora" esto pintándolo todo del mismo
 * color, el gráfico deja de poder leerse.
 */
import { useState, useId } from 'react';
import {
  TERAPIA_ELEMENTOS,
  TERAPIA_CICLO_APOYO,
  TERAPIA_CICLO_CONTROL,
} from '../constants/specialtyCatalogs';

/**
 * Dónde se cortan las flechas, en unidades del lienzo (que es 100×100).
 *
 * El círculo mide 40 px fijos y el lienzo es elástico, así que su radio EN
 * UNIDADES cambia con el ancho: ~4,5 en un lienzo de 440 px y ~6,7 en uno de
 * 300. Se corta a 7 para que la punta de la flecha quede fuera del círculo en
 * los dos casos — de sobra en pantalla grande, justo en el móvil, nunca dentro.
 */
const R = 7;

const PORNOMBRE = Object.fromEntries(TERAPIA_ELEMENTOS.map((e) => [e.key, e]));

/**
 * Un tramo de flecha entre dos elementos, ya recortado por los dos extremos.
 * Devuelve null si los centros coinciden (no puede pasar, pero dividir por cero
 * dejaría el trazo en NaN y el SVG entero sin pintar).
 */
function tramo(desdeKey, hastaKey, margen) {
  const a = PORNOMBRE[desdeKey];
  const b = PORNOMBRE[hastaKey];
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const largo = Math.hypot(dx, dy);
  if (!largo) return null;
  const ux = dx / largo;
  const uy = dy / largo;
  return {
    x1: a.x + ux * margen,
    y1: a.y + uy * margen,
    x2: b.x - ux * margen,
    y2: b.y - uy * margen,
  };
}

/**
 * @param {object} value  { elementos: [{key, texto}], … } — el bloque `terapia`
 * @param {function} onChange
 * @param {boolean} [readOnly] modo lectura para el historial
 */
export default function CincoElementos({ value, onChange, readOnly = false }) {
  const o = value || {};
  const porKey = Object.fromEntries((o.elementos || []).map((e) => [e.key, e.texto || '']));
  // Cuál está abierto para escribir. Solo uno: el campo expandido flota por
  // encima del dibujo y dos abiertos a la vez se pisarían.
  const [abierto, setAbierto] = useState('');
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

  return (
    <div className="space-y-2">
      {!readOnly && (
        <p className="text-[11px] text-slate-500">
          Pincha en el recuadro de cada elemento para escribir. Las flechas grises son el
          ciclo de apoyo y las negras el de control.
        </p>
      )}

      {/* El lienzo es CUADRADO: las posiciones del catálogo son porcentajes y en
          un rectángulo el pentágono saldría aplastado. */}
      <div className="relative w-full max-w-[440px] mx-auto aspect-square">
        <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full">
          <defs>
            <marker id={`ce-apoyo-${uid}`} viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M0,1 L9,5 L0,9 z" fill="#94a3b8" />
            </marker>
            <marker id={`ce-control-${uid}`} viewBox="0 0 10 10" refX="9" refY="5"
              markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M0,1 L9,5 L0,9 z" fill="#1f2937" />
            </marker>
          </defs>

          {/* Ciclo de APOYO: la rueda de fuera. Va por el borde del pentágono. */}
          {TERAPIA_CICLO_APOYO.map(([a, b]) => {
            const t = tramo(a, b, R);
            return t && (
              <line key={`ap-${a}-${b}`} {...t}
                stroke="#94a3b8" strokeWidth="1.1" markerEnd={`url(#ce-apoyo-${uid})`} />
            );
          })}

          {/* Ciclo de CONTROL: la estrella de dentro, la que cruza. */}
          {TERAPIA_CICLO_CONTROL.map(([a, b]) => {
            const t = tramo(a, b, R);
            return t && (
              <line key={`co-${a}-${b}`} {...t}
                stroke="#1f2937" strokeWidth="1.1" markerEnd={`url(#ce-control-${uid})`} />
            );
          })}
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
          /**
           * Dónde va el campo:
           *  · a la DERECHA del círculo, como se pidió;
           *  · a la IZQUIERDA en los de la derecha del esquema (Tierra, Metal),
           *    donde no habría sitio y el campo saldría cortado;
           *  · DEBAJO en los dos de abajo (Agua, Metal), que están a la misma
           *    altura y cuyos campos se solapaban entre sí. Un campo encima de
           *    otro es peor que un campo en otro lado.
           */
          const debajo = e.y > 70;
          const aLaIzquierda = !debajo && e.x > 60;
          const ancho = activo ? 190 : 96;
          const posicion = debajo
            ? { top: 26, left: -ancho / 2 }
            : { top: -14, [aLaIzquierda ? 'right' : 'left']: 26 };
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
              {/* El círculo, centrado EN el vértice: es donde acaban las flechas. */}
              <span
                title={e.label}
                className="absolute w-10 h-10 rounded-full border border-slate-400 flex items-center justify-center font-bold text-base select-none shadow-sm"
                style={{ left: -20, top: -20, background: e.color, color: e.texto }}
              >
                {e.letra}
              </span>

              {readOnly ? (
                texto ? (
                  <span
                    className="absolute text-[11px] text-slate-700 bg-white/90 border border-slate-200 rounded px-1.5 py-0.5 break-words shadow-sm"
                    style={{ ...posicion, width: 96 }}
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
                  className="absolute text-[11px] border border-slate-300 rounded px-1.5 py-1 outline-none focus:border-emerald-500 bg-white resize-none shadow-sm"
                  style={{ ...posicion, width: ancho }}
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
