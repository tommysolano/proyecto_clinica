/**
 * Odontograma gráfico del MSP (secciones 6 a 9 de la hoja).
 *
 * POR QUÉ ESTE ARCHIVO: la primera versión listaba las piezas como botones con el
 * número FDI dentro. El odontólogo lo rechazó: la hoja oficial se DIBUJA, y el
 * dibujo es el dato — cada diente se divide en sus cinco caras y se pinta cara por
 * cara, en AZUL lo ya tratado y en ROJO la patología actual.
 *
 * Cómo se usa: se elige un símbolo de la paleta y se pincha encima del diente. Si
 * el símbolo es de cara (caries, obturado, sellante) pinta el sector pinchado; si
 * es de pieza entera (extracción, pérdida, endodoncia, corona, prótesis) marca el
 * diente completo. Volver a pinchar con el mismo símbolo lo borra.
 *
 * Vive fuera de PatientDetail.jsx porque es un bloque grande y autocontenido; se
 * consume igual que el resto de secciones de especialidad, con `{ value, onChange }`.
 */
import { useState } from 'react';
import {
  ODONTOGRAMA_FILAS,
  ODONTOGRAMA_CARAS,
  ODONTOGRAMA_ESTADOS,
  ODONTOGRAMA_ESTADOS_VIGENTES,
  ODONTOGRAMA_GRADOS,
  HIGIENE_ORAL_FILAS,
  HIGIENE_ORAL_INDICES,
  ENFERMEDAD_PERIODONTAL,
  MALOCLUSION,
  FLUOROSIS,
  INDICE_CPO,
  INDICE_CEO,
  colorEstado,
  estadoOdonto,
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
function Diente({ num, hemi, dato, herramienta, onPintar, onSeleccionar, seleccionado }) {
  const caras = dato?.caras || {};
  const info = estadoOdonto(dato?.estado);
  const redondo = esTemporal(num);

  return (
    <div className="flex flex-col items-center gap-0.5 shrink-0">
      <svg
        viewBox={`-1 -1 ${L + 2} ${L + 2}`}
        className={`w-8 h-8 cursor-pointer ${seleccionado ? 'ring-2 ring-emerald-500 rounded' : ''}`}
        onContextMenu={(e) => { e.preventDefault(); onSeleccionar(num); }}
      >
        {redondo && (
          // Los temporales van dentro de un círculo, como en la hoja. El recorte
          // hace que los cinco sectores queden redondeados sin recalcular caminos.
          <defs>
            <clipPath id={`odc-${num}`}>
              <circle cx={L / 2} cy={L / 2} r={L / 2} />
            </clipPath>
          </defs>
        )}
        <g clipPath={redondo ? `url(#odc-${num})` : undefined}>
          {sectores(hemi).map((s) => {
            const estadoCara = caras[s.key] || '';
            return (
              <path
                key={s.key}
                d={s.d}
                fill={estadoCara ? colorEstado(estadoCara) : '#ffffff'}
                fillOpacity={estadoCara ? 0.85 : 1}
                stroke={BORDE}
                strokeWidth="0.8"
                onClick={() => onPintar(num, s.key)}
              >
                <title>{`${num} · ${ODONTOGRAMA_CARAS.find((c) => c.key === s.key).label}`}</title>
              </path>
            );
          })}
        </g>
        {redondo && <circle cx={L / 2} cy={L / 2} r={L / 2} fill="none" stroke={BORDE} strokeWidth="1" />}
        {info && info.ambito === 'pieza' && info.simbolo !== 'ninguno' && (
          <SimboloPieza simbolo={info.simbolo} color={colorEstado(info.key)} />
        )}
      </svg>
      <span className="text-[9px] leading-none text-slate-500 tabular-nums">{num}</span>
    </div>
  );
}

/** Casilla de grado (recesión / movilidad): vacío → 1 → 2 → 3 → vacío. */
function CasillaGrado({ valor, onChange, title }) {
  const siguiente = () => {
    const i = ODONTOGRAMA_GRADOS.indexOf(valor);
    onChange(i === -1 ? ODONTOGRAMA_GRADOS[0] : ODONTOGRAMA_GRADOS[i + 1] || '');
  };
  return (
    <button
      type="button"
      onClick={siguiente}
      title={title}
      // Estilos en línea a propósito: la ficha inyecta un <style> sin capa que
      // pisa las utilidades de Tailwind para el tamaño (ver FichaStyles).
      style={{ width: 22, height: 16 }}
      className={`text-[9px] leading-none border rounded-sm cursor-pointer p-0 ${
        valor ? 'bg-rose-100 border-rose-400 text-rose-700 font-bold' : 'bg-white border-slate-300 text-slate-300'
      }`}
    >
      {valor || '·'}
    </button>
  );
}

export default function Odontograma({ value, onChange }) {
  const o = value || {};
  const dientes = Array.isArray(o.odontograma) ? o.odontograma : [];
  const byDiente = Object.fromEntries(dientes.map((d) => [d.diente, d]));
  const [herramienta, setHerramienta] = useState('caries');
  const [sel, setSel] = useState('');

  const set = (patch) => onChange({ ...o, ...patch });

  /** Escribe una pieza; si queda sin nada, desaparece de la lista. */
  const setDiente = (num, patch) => {
    const cur = byDiente[num] || { diente: num, estado: '', caras: {}, recesion: '', movilidad: '', nota: '' };
    const next = { ...cur, ...patch, caras: { ...(cur.caras || {}), ...(patch.caras || {}) } };
    const resto = dientes.filter((d) => d.diente !== num);
    set({ odontograma: dienteMarcado(next) ? [...resto, next] : resto });
  };

  /** Aplica la herramienta activa. Repetir el mismo símbolo lo borra. */
  const pintar = (num, cara) => {
    const info = estadoOdonto(herramienta);
    if (!info) return;
    const actual = byDiente[num];
    if (info.ambito === 'pieza') {
      setDiente(num, { estado: actual?.estado === herramienta ? '' : herramienta });
    } else {
      const puesto = actual?.caras?.[cara] === herramienta;
      setDiente(num, { caras: { [cara]: puesto ? '' : herramienta } });
    }
    setSel(num);
  };

  const filaSuperior = (f) => f.key.includes('Superiores');

  return (
    <div className="space-y-4">
      {/* ── Paleta ── */}
      <div className="border border-slate-200 rounded-lg p-2">
        <div className="text-[11px] text-slate-500 mb-1.5">
          Elige un símbolo y pincha sobre el diente. <b>Azul</b> = tratamiento realizado ·{' '}
          <b>Rojo</b> = patología actual. Clic derecho en la pieza para anotarla.
        </div>
        <div className="flex flex-wrap gap-1">
          {ODONTOGRAMA_ESTADOS_VIGENTES.map((e) => (
            <button
              key={e.key}
              type="button"
              onClick={() => setHerramienta(e.key)}
              className={`text-[11px] px-2 py-1 rounded border cursor-pointer flex items-center gap-1.5 ${
                herramienta === e.key ? 'border-slate-800 bg-slate-100 font-semibold' : 'border-slate-300 bg-white'
              }`}
            >
              <span
                className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                style={{ background: colorEstado(e.key) }}
              />
              {e.label}
            </button>
          ))}
        </div>
      </div>

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
                        />
                        <CasillaGrado
                          valor={byDiente[num]?.movilidad || ''}
                          onChange={(v) => setDiente(num, { movilidad: v })}
                          title={`Movilidad ${num}`}
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

      {sel && (
        <div className="border border-slate-200 rounded-lg p-2 flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-700 shrink-0">Pieza {sel}</span>
          <input
            value={byDiente[sel]?.nota || ''}
            onChange={(e) => setDiente(sel, { nota: e.target.value })}
            placeholder="Anotación de la pieza…"
            className="flex-1 text-xs border border-slate-300 rounded px-2 py-1 outline-none focus:border-emerald-500"
          />
          <button
            type="button"
            onClick={() => setSel('')}
            className="text-xs text-slate-500 bg-transparent border-none cursor-pointer"
          >
            Cerrar
          </button>
        </div>
      )}

      <SeccionIndicadores value={o} set={set} />
      <SeccionIndices value={o} set={set} />
      <Simbologia />
    </div>
  );
}

// ─────────────── Sección 7 · Indicadores de salud bucal ───────────────

function SeccionIndicadores({ value, set }) {
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
                          onClick={() => setFila(f.key, { pieza: v.pieza === p ? '' : p })}
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
                            onClick={() => setFila(f.key, { [i.key]: v[i.key] === n ? '' : n })}
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
        <Opciones label="Enfermedad periodontal" catalog={ENFERMEDAD_PERIODONTAL} value={value.enfermedadPeriodontal} onPick={(v) => set({ enfermedadPeriodontal: v })} />
        <Opciones label="Maloclusión" catalog={MALOCLUSION} value={value.maloclusion} onPick={(v) => set({ maloclusion: v })} />
        <Opciones label="Fluorosis" catalog={FLUOROSIS} value={value.fluorosis} onPick={(v) => set({ fluorosis: v })} />
      </div>
    </div>
  );
}

/** Selección única: volver a pulsar la opción marcada la desmarca. */
function Opciones({ label, catalog, value, onPick }) {
  return (
    <div>
      <div className="text-[11px] font-semibold text-slate-600 mb-1">{label}</div>
      <div className="flex flex-wrap gap-1">
        {catalog.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => onPick(value === c.key ? '' : c.key)}
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

function SeccionIndices({ value, set }) {
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
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1">
        {ODONTOGRAMA_ESTADOS.filter((e) => !e.legacy && e.key !== 'sano').map((e) => (
          <div key={e.key} className="flex items-center gap-1.5 text-[11px] text-slate-600">
            <svg viewBox={`-1 -1 ${L + 2} ${L + 2}`} className="w-4 h-4 shrink-0">
              <rect x="0" y="0" width={L} height={L} fill="#fff" stroke={BORDE} strokeWidth="1" />
              {e.ambito === 'cara' ? (
                <rect x="0" y="0" width={L} height={L} fill={colorEstado(e.key)} fillOpacity="0.85" />
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
