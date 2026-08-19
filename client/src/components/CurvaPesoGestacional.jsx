import { useMemo } from 'react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import Modal from './Modal';
import { fmtDate } from '../utils/date';
import {
  bandasIMC,
  clasificarIMC,
  edadGestacional,
  ESTADOS_IMC,
  gananciaRecomendada,
  imcDe,
  IMC_MAX,
  IMC_MIN,
  SEMANA_MAX,
  SEMANA_MIN,
} from '../constants/gestacion';

/**
 * Curva de aumento de peso del embarazo: IMC contra semanas de gestación.
 *
 * El fondo son las cuatro franjas de la tabla (bajo peso · normal · sobrepeso ·
 * obesidad) y encima se dibuja el recorrido real de la paciente, un punto por
 * control con peso y talla registrados.
 *
 * Nota de implementación: recharts apila las áreas desde 0, así que cada franja
 * se manda como GROSOR (no como techo) y el eje se recorta en IMC_MIN, con lo
 * que la parte que sobra por debajo queda fuera de la vista.
 */
export default function CurvaPesoGestacional({
  isOpen,
  onClose,
  fum,
  pesoPreconcepcional,
  talla,
  pesoActual,
  fechaActual,
  followUps = [],
}) {
  const { datos, puntos, actual, pregestacional } = useMemo(() => {
    const bandas = bandasIMC();

    // Un control cuenta si es de ESTE embarazo: se compara su propia FUM con la
    // que se está registrando ahora. Sin FUM propia no se puede ubicar y se deja
    // fuera, antes que colocarlo en una semana inventada.
    const mismaFum = (v) => String(v || '').slice(0, 10) === String(fum || '').slice(0, 10);
    const medidos = [];
    for (const fu of followUps) {
      const g = fu?.ginecologia || {};
      if (!mismaFum(g.fum)) continue;
      const vs = fu?.vitalSigns || {};
      const imc = imcDe(vs.weight, vs.height || talla);
      const eg = edadGestacional(fum, fu.fecha);
      if (imc == null || !eg || eg.problema) continue;
      medidos.push({ semana: eg.semanas, imc, peso: Number(vs.weight), fecha: fu.fecha });
    }

    // El control que se está escribiendo ahora mismo, aún sin guardar.
    const egHoy = edadGestacional(fum, fechaActual);
    const imcHoy = imcDe(pesoActual, talla);
    const actual =
      egHoy && !egHoy.problema && imcHoy != null
        ? { semana: egHoy.semanas, imc: imcHoy, peso: Number(pesoActual), fecha: fechaActual, esActual: true }
        : null;
    if (actual) medidos.push(actual);

    medidos.sort((a, b) => a.semana - b.semana || new Date(a.fecha) - new Date(b.fecha));

    // Si hubo dos controles en la misma semana manda el último.
    const porSemana = new Map();
    medidos.forEach((m) => porSemana.set(m.semana, m));

    const datos = bandas.map((b) => ({ ...b, paciente: porSemana.get(b.semana)?.imc ?? null }));

    const imcPre = imcDe(pesoPreconcepcional, talla);
    return {
      datos,
      puntos: medidos,
      actual,
      pregestacional: imcPre == null ? null : { imc: imcPre, recomendacion: gananciaRecomendada(imcPre) },
    };
  }, [fum, pesoPreconcepcional, talla, pesoActual, fechaActual, followUps]);

  const estadoActual = actual ? clasificarIMC(actual.semana, actual.imc) : null;
  const ganancia =
    actual && Number(pesoPreconcepcional) > 0 ? actual.peso - Number(pesoPreconcepcional) : null;
  const fueraDeCurva = puntos.some((p) => p.semana < SEMANA_MIN || p.semana > SEMANA_MAX);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Curva de aumento de peso en el embarazo" size="2xl">
      <div className="space-y-4">
        {/* Resumen del control de hoy */}
        {estadoActual ? (
          <div className={`rounded-lg border p-3 text-sm ${estadoActual.fondo}`}>
            <p className={`font-semibold ${estadoActual.texto}`}>
              Semana {actual.semana} · IMC {actual.imc.toFixed(1)} · {estadoActual.label}
            </p>
            <p className="text-xs text-slate-600 mt-1">
              En la semana {actual.semana} el rango normal va de {estadoActual.fila.bajo} a {estadoActual.fila.normal} kg/m².
              {ganancia != null && (
                <> Lleva <b>{ganancia >= 0 ? '+' : ''}{ganancia.toFixed(1)} kg</b> sobre su peso preconcepcional.</>
              )}
            </p>
            {!estadoActual.dentroDeCurva && (
              <p className="text-xs text-slate-500 mt-1">
                La semana {actual.semana} queda fuera de la tabla ({SEMANA_MIN}–{SEMANA_MAX}); se usó el extremo más cercano, tómelo como orientativo.
              </p>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            Para ubicar el control de hoy en la curva hacen falta la FUM, el peso y la talla de signos vitales.
          </div>
        )}

        {/* Referencia pregestacional */}
        {pregestacional?.recomendacion && (
          <p className="text-xs text-slate-600">
            IMC pregestacional <b>{pregestacional.imc.toFixed(1)}</b> ({pregestacional.recomendacion.label}):
            la ganancia recomendada para todo el embarazo es de{' '}
            <b>{pregestacional.recomendacion.min} a {pregestacional.recomendacion.max} kg</b>.
          </p>
        )}

        {/* Gráfica */}
        <div className="h-80 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={datos} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis
                dataKey="semana"
                tick={{ fontSize: 11 }}
                label={{ value: 'Semanas de gestación', position: 'insideBottom', offset: -2, fontSize: 11 }}
              />
              <YAxis
                domain={[IMC_MIN, IMC_MAX]}
                ticks={[15, 20, 25, 30, 35, 40]}
                allowDataOverflow
                tick={{ fontSize: 11 }}
                width={38}
              />
              <Tooltip content={<PistaCurva />} />
              {/* Franjas: se apilan de abajo hacia arriba en el orden del arreglo. */}
              <Area dataKey="zBajo" stackId="banda" stroke="none" fill={ESTADOS_IMC[0].color} fillOpacity={0.85} isAnimationActive={false} />
              <Area dataKey="zNormal" stackId="banda" stroke="none" fill={ESTADOS_IMC[1].color} fillOpacity={0.9} isAnimationActive={false} />
              <Area dataKey="zSobrepeso" stackId="banda" stroke="none" fill={ESTADOS_IMC[2].color} fillOpacity={0.85} isAnimationActive={false} />
              <Area dataKey="zObesidad" stackId="banda" stroke="none" fill={ESTADOS_IMC[3].color} fillOpacity={0.95} isAnimationActive={false} />
              {pregestacional && (
                <ReferenceLine
                  y={pregestacional.imc}
                  stroke="#475569"
                  strokeDasharray="4 4"
                  label={{ value: 'IMC pregestacional', position: 'insideTopLeft', fontSize: 10, fill: '#475569' }}
                />
              )}
              <Line
                dataKey="paciente"
                name="Paciente"
                stroke="#1e293b"
                strokeWidth={2}
                dot={{ r: 4, fill: '#1e293b' }}
                connectNulls
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Leyenda */}
        <div className="flex flex-wrap gap-3 text-[11px] text-slate-600">
          {ESTADOS_IMC.map((e, i) => (
            <span key={`${e.key}-${i}`} className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm inline-block" style={{ background: e.color }} />
              {e.label}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 inline-block bg-slate-800" />
            Recorrido de la paciente
          </span>
        </div>

        {/* Controles usados */}
        {puntos.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200">
                  <th className="py-1.5 pr-3 font-medium">Fecha</th>
                  <th className="py-1.5 pr-3 font-medium">Semana</th>
                  <th className="py-1.5 pr-3 font-medium">Peso</th>
                  <th className="py-1.5 pr-3 font-medium">IMC</th>
                  <th className="py-1.5 font-medium">Clasificación</th>
                </tr>
              </thead>
              <tbody>
                {puntos.map((p, i) => {
                  const est = clasificarIMC(p.semana, p.imc);
                  return (
                    <tr key={`${p.fecha}-${i}`} className="border-b border-slate-100 last:border-0">
                      <td className="py-1.5 pr-3 text-slate-700">
                        {fmtDate(p.fecha)}
                        {p.esActual && <span className="ml-1 text-[10px] text-emerald-600">(este control)</span>}
                      </td>
                      <td className="py-1.5 pr-3 text-slate-700">{p.semana}</td>
                      <td className="py-1.5 pr-3 text-slate-700">{Number.isFinite(p.peso) ? `${p.peso} kg` : '—'}</td>
                      <td className="py-1.5 pr-3 text-slate-700">{p.imc.toFixed(1)}</td>
                      <td className={`py-1.5 font-medium ${est?.texto || 'text-slate-500'}`}>{est?.label || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-[11px] text-slate-400 leading-relaxed">
          Curva de IMC / edad gestacional de Atalah, la que usa la guía de control prenatal del MSP.
          Solo se grafican los controles que tienen registrada la misma FUM, con peso y talla.
          {fueraDeCurva && ' Algún control cae fuera de las semanas 10–42 de la tabla.'}
        </p>
      </div>
    </Modal>
  );
}

/** Globo del gráfico: la semana, la franja normal de esa semana y el IMC real. */
function PistaCurva({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  const bajo = d.zBajo;
  const normal = Number((d.zBajo + d.zNormal).toFixed(1));
  const est = d.paciente != null ? clasificarIMC(d.semana, d.paciente) : null;
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-sm px-3 py-2 text-xs">
      <p className="font-semibold text-slate-700">Semana {label}</p>
      <p className="text-slate-500">Normal: {bajo} – {normal} kg/m²</p>
      {d.paciente != null && (
        <p className={`font-medium mt-0.5 ${est?.texto || 'text-slate-700'}`}>
          Paciente: {d.paciente.toFixed(1)} · {est?.label}
        </p>
      )}
    </div>
  );
}
