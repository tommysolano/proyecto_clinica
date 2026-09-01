/**
 * Odontograma gráfico del MSP (secciones 6 a 9 de la hoja).
 *
 * POR QUÉ ESTE ARCHIVO: la primera versión listaba las piezas como botones con el
 * número FDI dentro. El odontólogo lo rechazó: la hoja oficial se DIBUJA, y el
 * dibujo es el dato — cada diente se divide en sus cinco caras y se pinta cara por
 * cara, en AZUL lo ya tratado y en ROJO la patología actual.
 *
 * Cómo se usa: se elige un COLOR y un símbolo de la paleta y se pincha encima del
 * diente. Si el símbolo es de cara (caries, obturado, sellante) pinta el sector
 * pinchado; si es de pieza entera (extracción, ausencia, endodoncia, corona,
 * prótesis) marca el diente completo. Volver a pinchar con la misma marca —mismo
 * símbolo y mismo color— la borra; con otro color, la repinta.
 *
 * El color ya no va clavado en el símbolo: cualquiera se puede anotar en azul o
 * en rojo, porque la misma figura significa una cosa por hacer y otra ya hecha.
 * Cómo se guarda («clave» o «clave:color») está en specialtyCatalogs.js.
 *
 * Vive fuera de PatientDetail.jsx porque es un bloque grande y autocontenido; se
 * consume igual que el resto de secciones de especialidad, con `{ value, onChange }`.
 */
import { useState, useId } from 'react';
import {
  ODONTOGRAMA_FILAS,
  ODONTOGRAMA_CARAS,
  ODONTOGRAMA_ESTADOS,
  ODONTOGRAMA_ESTADOS_VIGENTES,
  ODONTOGRAMA_COLORES,
  ODONTOGRAMA_COLOR_OPCIONES,
  ODONTOGRAMA_GRADOS,
  HIGIENE_ORAL_FILAS,
  HIGIENE_ORAL_INDICES,
  ENFERMEDAD_PERIODONTAL,
  MALOCLUSION,
  FLUOROSIS,
  INDICE_CPO,
  INDICE_CEO,
  colorEstado,
  colorPorDefecto,
  estadoOdonto,
  marcaValor,
  labelOdonto,
} from '../constants/specialtyCatalogs';

// Lado del icono de una pieza, en unidades del SVG.
const L = 34;
// Grosor del borde de cada sector.
const BORDE = '#94a3b8';

/** ¿La pieza es temporal? En la hoja los temporales se dibujan redondos. */
const esTemporal = (num) => ['5', '6', '7', '8'].includes(String(num)[0]);

/** ¿Esta pieza tiene algo anotado? Espejo de la regla del backend. */
export const dienteMarcado = (d) =>
  Boolean(
    d &&
      (d.estado ||
        String(d.nota || '').trim() ||
        d.recesion ||
        d.movilidad ||
        Object.values(d.caras || {}).some(Boolean))
  );

/**
 * Geometría de las cinco caras. El centro es un cuadrado y las cuatro periféricas
 * son los trapecios que lo rodean, que es exactamente el esquema de la hoja.
 *
 * `vestibular` va arriba y `lingual` abajo. Mesial y distal son laterales y su
 * lado DEPENDE del hemiarco: mesial siempre mira hacia la línea media, así que en
 * el lado derecho cae a la derecha del icono y en el izquierdo a la izquierda. Si
 * no se invirtiera, el dibujo estaría rotulado al revés en media boca.
 */
function sectores(hemi) {
  const a = L * 0.28; // margen del cuadrado central
  const b = L - a;
  const centro = `M${a},${a} L${b},${a} L${b},${b} L${a},${b} Z`;
  const arriba = `M0,0 L${L},0 L${b},${a} L${a},${a} Z`;
  const abajo = `M0,${L} L${a},${b} L${b},${b} L${L},${L} Z`;
  const izq = `M0,0 L${a},${a} L${a},${b} L0,${L} Z`;
  const der = `M${L},0 L${L},${L} L${b},${b} L${b},${a} Z`;
  const mesialIzquierda = hemi === 'izquierda';
  return [
    { key: 'vestibular', d: arriba },
    { key: 'lingual', d: abajo },
    { key: 'mesial', d: mesialIzquierda ? izq : der },
    { key: 'distal', d: mesialIzquierda ? der : izq },
    { key: 'oclusal', d: centro },
  ];
}

/**
 * Centro de cada cara, para clavar ahí su símbolo. El sector periférico es un
 * trapecio estrecho: su centro útil está a media altura del margen.
 */
function centroCara(cara, hemi) {
  const a = L * 0.28;
  const m = a / 2;
  const mesialIzquierda = hemi === 'izquierda';
  switch (cara) {
    case 'vestibular': return [L / 2, m];
    case 'lingual': return [L / 2, L - m];
    case 'mesial': return mesialIzquierda ? [m, L / 2] : [L - m, L / 2];
    case 'distal': return mesialIzquierda ? [L - m, L / 2] : [m, L / 2];
    default: return [L / 2, L / 2];
  }
}

/**
 * Símbolo de una CARA. Sin esto, el color por sí solo no basta: la hoja usa el
 * mismo rojo para caries y para «sellante necesario», y el mismo azul para
 * obturado y «sellante realizado». Lo que los distingue es la figura — círculo
 * para caries/obturado, ASTERISCO para los sellantes—, así que el relleno va
 * tenue y la figura encima a color pleno.
 *
 * El asterisco se dibuja con tres trazos por el centro y no con el carácter «*»:
 * un glifo de texto se sale de su sector en las caras estrechas y depende de la
 * fuente del navegador. Los trazos escalan con el radio, así que la misma figura
 * vale en la cara (r≈3), en la oclusal (r=4) y en la leyenda (r≈10).
 */
function SimboloCara({ simbolo, color, cx, cy, r = 3.2 }) {
  const props = { stroke: color, strokeWidth: 1.6, fill: 'none' };
  if (simbolo === 'asterisco') {
    // Tres diámetros a 0°, 60° y 120°: la estrella de seis puntas de la hoja.
    const trazos = [0, 60, 120].map((grados) => {
      const rad = (grados * Math.PI) / 180;
      const dx = Math.cos(rad) * r;
      const dy = Math.sin(rad) * r;
      return { x1: cx - dx, y1: cy - dy, x2: cx + dx, y2: cy + dy };
    });
    return (
      <g {...props} strokeLinecap="round">
        {trazos.map((t, i) => <line key={i} {...t} />)}
      </g>
    );
  }
  if (simbolo === 'cuadro') {
    return <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} {...props} />;
  }
  return <circle cx={cx} cy={cy} r={r} {...props} />;
}

/** Símbolo que se dibuja ENCIMA del diente cuando el estado es de pieza entera. */
function SimboloPieza({ simbolo, color }) {
  const props = { stroke: color, strokeWidth: 2.4, fill: 'none', strokeLinecap: 'round' };
  switch (simbolo) {
    case 'equis':
      return (
        <g {...props}>
          <line x1="3" y1="3" x2={L - 3} y2={L - 3} />
          <line x1={L - 3} y1="3" x2="3" y2={L - 3} />
        </g>
      );
    case 'triangulo':
      return <polygon points={`${L / 2},4 ${L - 5},${L - 5} 5,${L - 5}`} {...props} />;
    case 'punto':
      return <circle cx={L / 2} cy={L / 2} r={L * 0.22} fill={color} stroke="none" />;
    case 'barra':
      return <line x1="3" y1={L / 2} x2={L - 3} y2={L / 2} {...props} />;
    case 'doblebarra':
      return (
        <g {...props}>
          <line x1="3" y1={L * 0.4} x2={L - 3} y2={L * 0.4} />
          <line x1="3" y1={L * 0.6} x2={L - 3} y2={L * 0.6} />
        </g>
      );
    case 'guiones':
      return <line x1="3" y1={L / 2} x2={L - 3} y2={L / 2} {...props} strokeDasharray="4 3" />;
    case 'cajaGuiones':
      return <rect x="3" y="3" width={L - 6} height={L - 6} {...props} strokeDasharray="4 3" />;
    default:
      return null;
  }
}

/**
 * Un diente. Es una función que devuelve JSX, no un componente propio: montarlo
 * como componente haría que React remontara las 52 piezas en cada tecleo del resto
 * del formulario (misma razón que en la versión anterior).
 */
function Diente({ num, hemi, dato, herramienta, onPintar, onSeleccionar, seleccionado, readOnly, idBase }) {
  const caras = dato?.caras || {};
  const info = estadoOdonto(dato?.estado);
  const redondo = esTemporal(num);
  const nota = String(dato?.nota || '').trim();
  // El id del recorte tiene que ser UNICO en toda la pagina: el historial monta
  // un odontograma por seguimiento y con `odc-11` repetido el navegador resuelve
  // `url(#odc-11)` contra el PRIMERO que encuentre, no contra el de su propio SVG.
  const clipId = `odc-${idBase}-${num}`;

  return (
    <div className="flex flex-col items-center gap-0.5 shrink-0">
      <svg
        viewBox={`-1 -1 ${L + 2} ${L + 2}`}
        className={`w-8 h-8 ${readOnly ? '' : 'cursor-pointer'} ${seleccionado ? 'ring-2 ring-emerald-500 rounded' : ''}`}
        onContextMenu={(e) => {
          if (readOnly) return;
          e.preventDefault();
          onSeleccionar(num);
        }}
      >
        {redondo && (
          // Los temporales van dentro de un círculo, como en la hoja. El recorte
          // hace que los cinco sectores queden redondeados sin recalcular caminos.
          <defs>
            <clipPath id={clipId}>
              <circle cx={L / 2} cy={L / 2} r={L / 2} />
            </clipPath>
          </defs>
        )}
        <g clipPath={redondo ? `url(#${clipId})` : undefined}>
          {sectores(hemi).map((s) => {
            const estadoCara = caras[s.key] || '';
            const ficha = estadoCara ? estadoOdonto(estadoCara) : null;
            const [cx, cy] = centroCara(s.key, hemi);
            const label = ODONTOGRAMA_CARAS.find((c) => c.key === s.key).label;
            return (
              <g key={s.key} onClick={readOnly ? undefined : () => onPintar(num, s.key)}>
                <path
                  d={s.d}
                  // Relleno tenue: el color dice si es patología (rojo) o
                  // tratamiento (azul); la figura de encima dice cuál de los dos.
                  fill={estadoCara ? colorEstado(estadoCara) : '#ffffff'}
                  fillOpacity={estadoCara ? 0.22 : 1}
                  stroke={BORDE}
                  strokeWidth="0.8"
                >
                  {/* La anotación entra en el tooltip: si no, la única forma de
                      leerla era volver a seleccionar la pieza. */}
                  <title>
                    {`${num} · ${label}${ficha ? ` · ${labelOdonto(estadoCara)}` : ''}${nota ? `\n📝 ${nota}` : ''}`}
                  </title>
                </path>
                {ficha && (
                  <SimboloCara
                    simbolo={ficha.simbolo}
                    color={colorEstado(estadoCara)}
                    cx={cx}
                    cy={cy}
                    r={s.key === 'oclusal' ? 4 : 3.2}
                  />
                )}
              </g>
            );
          })}
        </g>
        {redondo && <circle cx={L / 2} cy={L / 2} r={L / 2} fill="none" stroke={BORDE} strokeWidth="1" />}
        {info && info.ambito === 'pieza' && info.simbolo !== 'ninguno' && (
          // El color sale de la marca GUARDADA, no de la clave del catálogo: es
          // lo que eligió el odontólogo para esta pieza en concreto.
          <SimboloPieza simbolo={info.simbolo} color={colorEstado(dato?.estado)} />
        )}
      </svg>
      <span className="text-[9px] leading-none text-slate-500 tabular-nums flex items-center gap-px">
        {num}
        {/* Una pieza anotada tiene que VERSE anotada. Sin la marca, la nota
            quedaba escondida y solo la encontraba quien volviera a pinchar. */}
        {nota && <span className="text-emerald-600" title={nota}>•</span>}
      </span>
    </div>
  );
}

/** Casilla de grado (recesión / movilidad): vacío → 1 → 2 → 3 → vacío. */
function CasillaGrado({ valor, onChange, title, readOnly }) {
  const siguiente = () => {
    const i = ODONTOGRAMA_GRADOS.indexOf(valor);
    onChange(i === -1 ? ODONTOGRAMA_GRADOS[0] : ODONTOGRAMA_GRADOS[i + 1] || '');
  };
  return (
    <button
      type="button"
      onClick={readOnly ? undefined : siguiente}
      disabled={readOnly}
      title={title}
      // Estilos en línea a propósito: la ficha inyecta un <style> sin capa que
      // pisa las utilidades de Tailwind para el tamaño (ver FichaStyles).
      style={{ width: 22, height: 16 }}
      className={`text-[9px] leading-none border rounded-sm p-0 ${readOnly ? 'cursor-default' : 'cursor-pointer'} ${
        valor ? 'bg-rose-100 border-rose-400 text-rose-700 font-bold' : 'bg-white border-slate-300 text-slate-300'
      }`}
    >
      {valor || '·'}
    </button>
  );
}

/**
 * Herramienta de ANOTAR. No es un estado del odontograma: es el modo en el que
 * pinchar una pieza abre su nota en vez de pintarla.
 *
 * Existe porque la única forma de anotar era el CLIC DERECHO, que en una tablet
 * —donde se llena la ficha— no existe. El odontólogo veía el recuadro de la nota
 * de pura casualidad, o nunca.
 */
const HERRAMIENTA_NOTA = '__nota__';

/**
 * @param {boolean} [readOnly] modo LECTURA: se dibuja exactamente igual (mismo
 *   esquema, mismos indicadores, misma simbología) pero no se puede tocar. Es lo
 *   que se enseña en el historial de seguimientos: antes ahí salía un resumen en
 *   texto («11 Caries (Vestibular: Caries)») que no se parecía en nada a la hoja
 *   que el odontólogo acababa de llenar.
 */
export default function Odontograma({ value, onChange, readOnly = false }) {
  const o = value || {};
  // Prefijo único de ESTE odontograma, para los ids de recorte del SVG (ver
  // `Diente`). El historial monta uno por seguimiento en la misma página.
  const idBase = useId().replace(/:/g, '');
  const dientes = Array.isArray(o.odontograma) ? o.odontograma : [];
  const byDiente = Object.fromEntries(dientes.map((d) => [d.diente, d]));
  const [herramienta, setHerramienta] = useState('caries');
  /**
   * Con qué tinta se pinta. Antes iba clavada en cada símbolo (caries siempre
   * rojo, obturado siempre azul); ahora se elige, porque la misma figura
   * significa una cosa por hacer y otra ya hecha.
   *
   * Al cambiar de símbolo se vuelve a su color de convenio, así que quien no
   * toque el selector sigue rellenando la hoja como toda la vida.
   */
  const [color, setColor] = useState(() => colorPorDefecto('caries'));
  const elegirHerramienta = (key) => {
    setHerramienta(key);
    setColor(colorPorDefecto(key));
  };
  const [sel, setSel] = useState('');

  const set = (patch) => { if (!readOnly) onChange({ ...o, ...patch }); };

  /** Escribe una pieza; si queda sin nada, desaparece de la lista. */
  const setDiente = (num, patch) => {
    const cur = byDiente[num] || { diente: num, estado: '', caras: {}, recesion: '', movilidad: '', nota: '' };
    const next = { ...cur, ...patch, caras: { ...(cur.caras || {}), ...(patch.caras || {}) } };
    const resto = dientes.filter((d) => d.diente !== num);
    set({ odontograma: dienteMarcado(next) ? [...resto, next] : resto });
  };

  /**
   * Aplica la herramienta activa con el color elegido.
   *
   * Repetir EXACTAMENTE la misma marca (mismo símbolo y mismo color) la borra,
   * como antes. Si coincide el símbolo pero no el color, se repinta en vez de
   * borrarse: cambiar una caries de rojo a azul —de pendiente a tratada— es
   * justamente lo que el odontólogo hace en la consulta siguiente, y obligarle a
   * borrar y volver a marcar sería un paso de más.
   */
  const pintar = (num, cara) => {
    // Con la herramienta de anotar, pinchar la pieza abre su nota. Es el
    // sustituto táctil del clic derecho.
    if (herramienta === HERRAMIENTA_NOTA) { setSel(num); return; }
    const info = estadoOdonto(herramienta);
    if (!info) return;
    const marca = marcaValor(herramienta, color);
    const actual = byDiente[num];
    if (info.ambito === 'pieza') {
      setDiente(num, { estado: actual?.estado === marca ? '' : marca });
    } else {
      setDiente(num, { caras: { [cara]: actual?.caras?.[cara] === marca ? '' : marca } });
    }
    setSel(num);
  };

  const filaSuperior = (f) => f.key.includes('Superiores');

  return (
    <div className="space-y-4">
      {/* ── Paleta ── (en lectura no hay nada que elegir) */}
      {!readOnly && (
      <div className="border border-slate-200 rounded-lg p-2">
        <div className="text-[11px] text-slate-500 mb-1.5">
          Elige el color y el símbolo, y pincha sobre el diente. Para escribir una nota en una
          pieza, usa <b>Anotar</b> (o clic derecho sobre ella).
        </div>

        {/* Color de la marca: cualquier símbolo se puede pintar en las dos tintas. */}
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          <span className="text-[11px] text-slate-500">Color:</span>
          {ODONTOGRAMA_COLOR_OPCIONES.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setColor(c.key)}
              title={`${c.label} = ${c.significado}`}
              className={`text-[11px] px-2 py-1 rounded border cursor-pointer flex items-center gap-1.5 ${
                color === c.key ? 'border-slate-800 bg-slate-100 font-semibold' : 'border-slate-300 bg-white'
              }`}
            >
              <span
                className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                style={{ background: ODONTOGRAMA_COLORES[c.key] }}
              />
              {c.label}
              <span className="text-slate-400 font-normal">· {c.significado}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-1">
          {ODONTOGRAMA_ESTADOS_VIGENTES.map((e) => (
            <button
              key={e.key}
              type="button"
              onClick={() => elegirHerramienta(e.key)}
              className={`text-[11px] px-2 py-1 rounded border cursor-pointer flex items-center gap-1.5 ${
                herramienta === e.key ? 'border-slate-800 bg-slate-100 font-semibold' : 'border-slate-300 bg-white'
              }`}
            >
              {/* El punto lleva el color con el que se va a pintar AHORA, no el
                  del convenio: si no, el selector de color diría una cosa y la
                  paleta otra. */}
              <span
                className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                style={{ background: ODONTOGRAMA_COLORES[herramienta === e.key ? color : colorPorDefecto(e.key)] }}
              />
              {e.label}
            </button>
          ))}
          {/* Anotar es una herramienta más de la paleta, no un gesto escondido. */}
          <button
            type="button"
            onClick={() => setHerramienta(HERRAMIENTA_NOTA)}
            title="Escribir una nota en una pieza"
            className={`text-[11px] px-2 py-1 rounded border cursor-pointer flex items-center gap-1.5 ${
              herramienta === HERRAMIENTA_NOTA
                ? 'border-slate-800 bg-slate-100 font-semibold'
                : 'border-slate-300 bg-white'
            }`}
          >
            📝 Anotar
          </button>
        </div>
      </div>
      )}

      {/* ── Sección 6 · el esquema ── */}
      <div className="overflow-x-auto">
        <div className="min-w-[620px] space-y-2">
          {ODONTOGRAMA_FILAS.map((fila) => {
            const permanentes = fila.key.startsWith('permanentes');
            const arriba = filaSuperior(fila);
            const grados = permanentes && (
              <div className="flex justify-center gap-3">
                {[
                  { lado: 'derecha', piezas: fila.derecha },
                  { lado: 'izquierda', piezas: fila.izquierda },
                ].map((g) => (
                  <div key={g.lado} className="flex gap-0.5">
                    {g.piezas.map((num) => (
                      <div key={num} className="flex flex-col items-center gap-0.5 w-8">
                        <CasillaGrado
                          valor={byDiente[num]?.recesion || ''}
                          onChange={(v) => setDiente(num, { recesion: v })}
                          title={`Recesión ${num}`}
                          readOnly={readOnly}
                        />
                        <CasillaGrado
                          valor={byDiente[num]?.movilidad || ''}
                          onChange={(v) => setDiente(num, { movilidad: v })}
                          title={`Movilidad ${num}`}
                          readOnly={readOnly}
                        />
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            );

            return (
              <div key={fila.key} className="space-y-0.5">
                {arriba && grados}
                <div className="flex justify-center items-start gap-3">
                  {[
                    { hemi: 'derecha', piezas: fila.derecha },
                    { hemi: 'izquierda', piezas: fila.izquierda },
                  ].map((g) => (
                    <div key={g.hemi} className="flex gap-0.5">
                      {g.piezas.map((num) => (
                        <Diente
                          key={num}
                          num={num}
                          hemi={g.hemi}
                          dato={byDiente[num]}
                          herramienta={herramienta}
                          onPintar={pintar}
                          onSeleccionar={setSel}
                          seleccionado={sel === num}
                          readOnly={readOnly}
                          idBase={idBase}
                        />
                      ))}
                    </div>
                  ))}
                </div>
                {!arriba && grados}
              </div>
            );
          })}
        </div>
      </div>

      {/**
        * NOTA DE LA PIEZA.
        *
        * El texto se guarda mientras se escribe —va al mismo estado que el resto
        * del odontograma y viaja con el seguimiento—, pero eso no se veía: el
        * único botón decía «Cerrar», que se lee como «descartar». El odontólogo
        * escribía la nota, no encontraba dónde guardarla y daba por hecho que se
        * perdía.
        *
        * Ahora lo dice: un botón «Guardar nota» y una línea que explica que se
        * guarda con el seguimiento. Es un textarea y no un input para que quepan
        * dos líneas y porque los textarea están exentos del «Enter no envía el
        * formulario» de la ficha.
        */}
      {sel && !readOnly && (
        <div className="border border-emerald-200 bg-emerald-50/40 rounded-lg p-2 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-slate-700">Nota de la pieza {sel}</span>
            <span className="text-[10px] text-slate-500">
              Se guarda junto con el seguimiento
            </span>
          </div>
          <textarea
            rows={2}
            autoFocus
            value={byDiente[sel]?.nota || ''}
            onChange={(e) => setDiente(sel, { nota: e.target.value })}
            placeholder="Ej.: fractura del ángulo mesial, sensibilidad al frío…"
            className="w-full text-xs border border-slate-300 rounded px-2 py-1 outline-none focus:border-emerald-500 resize-none"
          />
          <div className="flex items-center justify-end gap-2">
            {String(byDiente[sel]?.nota || '').trim() && (
              <button
                type="button"
                onClick={() => setDiente(sel, { nota: '' })}
                className="text-xs text-slate-500 bg-transparent border-none cursor-pointer"
              >
                Borrar nota
              </button>
            )}
            <button
              type="button"
              onClick={() => setSel('')}
              className="text-xs font-semibold px-3 py-1 rounded-lg bg-emerald-600 text-white border-none cursor-pointer"
            >
              Guardar nota
            </button>
          </div>
        </div>
      )}

      <SeccionIndicadores value={o} set={set} readOnly={readOnly} />
      <SeccionIndices value={o} set={set} readOnly={readOnly} />
      <Simbologia />
    </div>
  );
}

// ─────────────── Sección 7 · Indicadores de salud bucal ───────────────

function SeccionIndicadores({ value, set, readOnly }) {
  const filas = Array.isArray(value.higieneOral) ? value.higieneOral : [];
  const byFila = Object.fromEntries(filas.map((f) => [f.fila, f]));

  const setFila = (key, patch) => {
    const cur = byFila[key] || { fila: key, pieza: '', placa: '', calculo: '', gingivitis: '' };
    const next = { ...cur, ...patch };
    const vacia = !next.pieza && !next.placa && !next.calculo && !next.gingivitis;
    const resto = filas.filter((f) => f.fila !== key);
    set({ higieneOral: vacia ? resto : [...resto, next] });
  };

  // Los totales son la suma de lo capturado: no se digitan.
  const total = (campo) => filas.reduce((s, f) => s + (Number.parseInt(f[campo], 10) || 0), 0);

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-slate-700">7 · Indicadores de salud bucal</div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse min-w-[440px]">
          <thead>
            <tr className="bg-slate-50">
              <th className="border border-slate-200 px-2 py-1 text-left font-semibold">Pieza evaluada</th>
              {HIGIENE_ORAL_INDICES.map((i) => (
                <th key={i.key} className="border border-slate-200 px-2 py-1 font-semibold">
                  {i.label} <span className="font-normal text-slate-400">({i.valores.join('-')})</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {HIGIENE_ORAL_FILAS.map((f) => {
              const v = byFila[f.key] || {};
              return (
                <tr key={f.key}>
                  <td className="border border-slate-200 px-2 py-1">
                    <div className="flex gap-1" title={f.label}>
                      {f.piezas.map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={readOnly ? undefined : () => setFila(f.key, { pieza: v.pieza === p ? '' : p })}
                          disabled={readOnly}
                          className={`text-[11px] px-1.5 py-0.5 rounded border cursor-pointer tabular-nums ${
                            v.pieza === p
                              ? 'bg-emerald-100 border-emerald-400 text-emerald-800 font-semibold'
                              : 'bg-white border-slate-300 text-slate-500'
                          }`}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </td>
                  {HIGIENE_ORAL_INDICES.map((i) => (
                    <td key={i.key} className="border border-slate-200 px-2 py-1">
                      <div className="flex gap-1 justify-center">
                        {i.valores.map((n) => (
                          <button
                            key={n}
                            type="button"
                            onClick={readOnly ? undefined : () => setFila(f.key, { [i.key]: v[i.key] === n ? '' : n })}
                            disabled={readOnly}
                            className={`text-[11px] w-5 rounded border cursor-pointer p-0 ${
                              v[i.key] === n
                                ? 'bg-slate-800 border-slate-800 text-white font-semibold'
                                : 'bg-white border-slate-300 text-slate-400'
                            }`}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                    </td>
                  ))}
                </tr>
              );
            })}
            <tr className="bg-amber-50 font-semibold">
              <td className="border border-slate-200 px-2 py-1">Totales</td>
              {HIGIENE_ORAL_INDICES.map((i) => (
                <td key={i.key} className="border border-slate-200 px-2 py-1 text-center tabular-nums">
                  {total(i.key)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Opciones label="Enfermedad periodontal" catalog={ENFERMEDAD_PERIODONTAL} value={value.enfermedadPeriodontal} onPick={(v) => set({ enfermedadPeriodontal: v })} readOnly={readOnly} />
        <Opciones label="Maloclusión" catalog={MALOCLUSION} value={value.maloclusion} onPick={(v) => set({ maloclusion: v })} readOnly={readOnly} />
        <Opciones label="Fluorosis" catalog={FLUOROSIS} value={value.fluorosis} onPick={(v) => set({ fluorosis: v })} readOnly={readOnly} />
      </div>
    </div>
  );
}

/** Selección única: volver a pulsar la opción marcada la desmarca. */
function Opciones({ label, catalog, value, onPick, readOnly }) {
  return (
    <div>
      <div className="text-[11px] font-semibold text-slate-600 mb-1">{label}</div>
      <div className="flex flex-wrap gap-1">
        {catalog.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={readOnly ? undefined : () => onPick(value === c.key ? '' : c.key)}
            disabled={readOnly}
            className={`text-[11px] px-2 py-1 rounded border cursor-pointer ${
              value === c.key
                ? 'bg-emerald-100 border-emerald-400 text-emerald-800 font-semibold'
                : 'bg-white border-slate-300 text-slate-600'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─────────────────── Sección 8 · Índices CPO-ceo ───────────────────

function SeccionIndices({ value, set, readOnly }) {
  const filas = [
    { key: 'cpo', titulo: 'D', ayuda: 'Permanentes', cols: INDICE_CPO },
    { key: 'ceo', titulo: 'd', ayuda: 'Temporales', cols: INDICE_CEO },
  ];

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-slate-700">8 · Índices CPO-ceo</div>
      <div className="overflow-x-auto">
        <table className="text-xs border-collapse">
          <tbody>
            {filas.map((f) => {
              const v = value[f.key] || {};
              const total = f.cols.reduce((s, c) => s + (Number.parseInt(v[c.key], 10) || 0), 0);
              return (
                <tr key={f.key}>
                  <td className="border border-slate-200 px-2 py-1 bg-slate-50 font-bold" title={f.ayuda}>
                    {f.titulo}
                  </td>
                  {f.cols.map((c) => (
                    <td key={c.key} className="border border-slate-200 px-1 py-1">
                      <label className="flex items-center gap-1">
                        <span className="text-[10px] text-slate-400 font-semibold">{c.label}</span>
                        <input
                          inputMode="numeric"
                          value={v[c.key] || ''}
                          onChange={(e) => set({ [f.key]: { ...v, [c.key]: e.target.value.replace(/\D/g, '') } })}
                          readOnly={readOnly}
                          style={{ width: 40 }}
                          className="text-xs text-center border border-slate-300 rounded px-1 py-0.5 outline-none focus:border-emerald-500"
                        />
                      </label>
                    </td>
                  ))}
                  <td className="border border-slate-200 px-2 py-1 bg-amber-50 font-semibold tabular-nums text-center">
                    <span className="text-[10px] text-slate-500 font-normal mr-1">TOTAL</span>
                    {total}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────────────────── Sección 9 · Simbología ───────────────────

function Simbologia() {
  return (
    <div>
      <div className="text-xs font-semibold text-slate-700 mb-1">9 · Simbología</div>
      {/* Cada símbolo se dibuja con su color de convenio, pero cualquiera de
          ellos puede anotarse en las dos tintas: el color lo elige quien marca. */}
      <div className="text-[11px] text-slate-500 mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
        {ODONTOGRAMA_COLOR_OPCIONES.map((c) => (
          <span key={c.key} className="flex items-center gap-1.5">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
              style={{ background: ODONTOGRAMA_COLORES[c.key] }}
            />
            {c.label} = {c.significado}
          </span>
        ))}
        <span className="text-slate-400">· cualquier símbolo admite los dos colores</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1">
        {ODONTOGRAMA_ESTADOS.filter((e) => !e.legacy && e.key !== 'sano').map((e) => (
          <div key={e.key} className="flex items-center gap-1.5 text-[11px] text-slate-600">
            <svg viewBox={`-1 -1 ${L + 2} ${L + 2}`} className="w-4 h-4 shrink-0">
              <rect x="0" y="0" width={L} height={L} fill="#fff" stroke={BORDE} strokeWidth="1" />
              {e.ambito === 'cara' ? (
                // Igual que en el esquema: fondo tenue + la figura que la distingue.
                <>
                  <rect x="0" y="0" width={L} height={L} fill={colorEstado(e.key)} fillOpacity="0.22" />
                  <SimboloCara simbolo={e.simbolo} color={colorEstado(e.key)} cx={L / 2} cy={L / 2} r={L * 0.3} />
                </>
              ) : (
                <SimboloPieza simbolo={e.simbolo} color={colorEstado(e.key)} />
              )}
            </svg>
            {e.label}
          </div>
        ))}
      </div>
    </div>
  );
}
