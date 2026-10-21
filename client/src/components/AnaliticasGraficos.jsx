import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';

/**
 * GRÁFICOS DE ANALÍTICAS DEL CRM (oct-2026).
 *
 * Colores validados (paleta de referencia, superficie clara): chats / citas /
 * efectivas = azul, naranja, aguamarina; por estado = efectivas, pendientes,
 * no asistió, canceladas en aguamarina, azul, amarillo, rojo. El color sigue
 * a la serie, nunca al orden: filtrar no repinta. Cada gráfico lleva leyenda y
 * tooltip, y las cifras exactas están en la tabla de debajo.
 */
const COLOR = {
  chats: '#2a78d6',
  citas: '#eb6834',
  efectivas: '#1baf7a',
  pendientes: '#2a78d6',
  noAsistio: '#eda100',
  canceladas: '#e34948',
  inversion: '#2a78d6',
  ingresos: '#eb6834',
};

const TINTA = '#64748b';
const REJILLA = '#eef2f6';
const SUPERFICIE = '#ffffff';
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const money = (v) => `$${Number(v || 0).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const moneyCorto = (v) => (Math.abs(v) >= 1000 ? `$${(v / 1000).toLocaleString('es-EC', { maximumFractionDigits: 1 })}k` : `$${Math.round(v)}`);

/** 'YYYY-MM-DD' → '12/10'; 'YYYY-MM' → 'oct 26'. */
const etiquetaFecha = (f) => {
  const [y, m, d] = String(f || '').split('-');
  if (d) return `${d}/${m}`;
  return `${MESES[Number(m) - 1] || m} ${String(y).slice(2)}`;
};

const ejes = {
  tick: { fill: TINTA, fontSize: 11 },
  axisLine: { stroke: REJILLA },
  tickLine: false,
};

function Tarjeta({ titulo, sub, children, alto = 240 }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3 min-w-0">
      <div className="mb-2">
        <h3 className="m-0 text-sm font-semibold text-slate-700">{titulo}</h3>
        {sub && <p className="m-0 text-[11px] text-slate-400">{sub}</p>}
      </div>
      <div style={{ height: alto }}>{children}</div>
    </div>
  );
}

function CajaTooltip({ active, payload, label, formato = (v) => v, etiqueta = (l) => l }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-md px-3 py-2 text-xs">
      <div className="font-semibold text-slate-700 mb-1">{etiqueta(label)}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2 text-slate-600">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: p.color }} />
          <span>{p.name}</span>
          <b className="ml-auto pl-3 text-slate-800">{formato(p.value)}</b>
        </div>
      ))}
    </div>
  );
}

// Sin ordenar: la leyenda sigue el orden de las series (recharts 3 la ordena por nombre).
const leyenda = { wrapperStyle: { fontSize: 11, color: TINTA }, iconType: 'square', iconSize: 9, itemSorter: null };

/** Chats de anuncios, citas y efectivas por día (o por mes en rangos largos). */
export function GraficoSerie({ serie, porMes, titulo = 'Chats y citas en el tiempo', sub }) {
  const datos = serie || [];
  const fechaLarga = (f) => {
    const [y, m, d] = String(f || '').split('-');
    return d ? `${d}/${m}/${y}` : etiquetaFecha(f);
  };
  return (
    <Tarjeta titulo={titulo} sub={sub || (porMes ? 'Por mes' : 'Por día')}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={datos} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={REJILLA} />
          <XAxis dataKey="fecha" tickFormatter={etiquetaFecha} {...ejes} minTickGap={16} />
          <YAxis allowDecimals={false} {...ejes} axisLine={false} width={40} />
          <Tooltip content={<CajaTooltip etiqueta={fechaLarga} />} cursor={{ stroke: '#cbd5e1', strokeWidth: 1 }} />
          <Legend {...leyenda} />
          <Line type="linear" dataKey="chats" name="Chats de anuncios" stroke={COLOR.chats} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: SUPERFICIE, strokeWidth: 2 }} />
          <Line type="linear" dataKey="citas" name="Citas del programa" stroke={COLOR.citas} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: SUPERFICIE, strokeWidth: 2 }} />
          <Line type="linear" dataKey="efectivas" name="Efectivas" stroke={COLOR.efectivas} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: SUPERFICIE, strokeWidth: 2 }} />
        </LineChart>
      </ResponsiveContainer>
    </Tarjeta>
  );
}

/** El tooltip de inversión/ingresos: los dos montos, lo que quedó y el ROI. */
function TooltipInversion({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const resultado = d.ingresos - d.inversion;
  const roi = d.inversion ? resultado / d.inversion : null;
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-md px-3 py-2 text-xs min-w-[180px]">
      <div className="font-semibold text-slate-700 mb-1">{d.name}</div>
      {[['Inversión', d.inversion, COLOR.inversion], ['Ingresos', d.ingresos, COLOR.ingresos]].map(([label, v, color]) => (
        <div key={label} className="flex items-center gap-2 text-slate-600">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: color }} />
          <span>{label}</span>
          <b className="ml-auto pl-3 text-slate-800">{money(v)}</b>
        </div>
      ))}
      <div className="flex items-center gap-2 text-slate-600 border-t border-slate-100 mt-1 pt-1">
        <span>{resultado >= 0 ? 'Ganancia' : 'Pérdida'}</span>
        <b className="ml-auto pl-3 text-slate-800">{money(Math.abs(resultado))}</b>
      </div>
      <div className="flex items-center gap-2 text-slate-600">
        <span>ROI</span>
        <b className="ml-auto pl-3 text-slate-800">{roi === null ? '—' : `${Math.round(roi * 100)}%`}</b>
      </div>
      <div className="flex items-center gap-2 text-slate-600">
        <span>Publicidad / ingresos</span>
        <b className="ml-auto pl-3 text-slate-800">{d.ingresos ? `${((d.inversion * 100) / d.ingresos).toFixed(1)}%` : '—'}</b>
      </div>
    </div>
  );
}

/**
 * INVERSIÓN E INGRESOS DE CADA PROGRAMA (rehecho oct-2026). Con muchos
 * programas, las columnas verticales no dejaban sitio a los nombres y se
 * pisaban. Ahora son barras HORIZONTALES —el nombre entero a la izquierda, una
 * fila por programa—, ordenadas por lo que más ingresó, y el alto crece con
 * la cantidad de programas. El tooltip suma la ganancia y el ROI.
 */
export function GraficoInversion({ programas }) {
  const datos = (programas || [])
    .map((p) => ({ name: p.name, inversion: p.gasto || 0, ingresos: p.ingresos || 0 }))
    .sort((a, b) => b.ingresos - a.ingresos || b.inversion - a.inversion);
  const alto = Math.max(200, datos.length * 46 + 70);
  const largoNombre = Math.max(...datos.map((d) => String(d.name).length), 8);
  const anchoNombres = Math.min(200, Math.max(90, largoNombre * 7));
  return (
    <Tarjeta
      titulo="Inversión e ingresos por programa"
      sub="Ordenado por ingresos · ingresos = citas efectivas que generan ingresos · pasa el cursor para ver la ganancia y el ROI"
      alto={alto}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={datos} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 0 }} barGap={2} barCategoryGap="22%">
          <CartesianGrid horizontal={false} stroke={REJILLA} />
          <XAxis type="number" {...ejes} tickFormatter={moneyCorto} />
          <YAxis
            type="category"
            dataKey="name"
            {...ejes}
            axisLine={false}
            interval={0}
            width={anchoNombres}
            tickFormatter={(v) => (String(v).length > 28 ? `${String(v).slice(0, 27)}…` : v)}
          />
          <Tooltip content={<TooltipInversion />} cursor={{ fill: '#f8fafc' }} />
          <Legend {...leyenda} />
          <Bar dataKey="inversion" name="Inversión" fill={COLOR.inversion} radius={[0, 4, 4, 0]} maxBarSize={16} />
          <Bar dataKey="ingresos" name="Ingresos" fill={COLOR.ingresos} radius={[0, 4, 4, 0]} maxBarSize={16} />
        </BarChart>
      </ResponsiveContainer>
    </Tarjeta>
  );
}

const ESTADOS = [
  ['efectivas', 'Efectivas'],
  ['pendientes', 'Pendientes'],
  ['noAsistio', 'No asistió'],
  ['canceladas', 'Canceladas'],
];

/** Cómo terminaron las citas de cada programa (barras apiladas horizontales). */
export function GraficoEstados({ programas }) {
  const datos = (programas || []).map((p) => ({
    name: p.name,
    efectivas: p.efectivas || 0,
    pendientes: p.pendientes || 0,
    noAsistio: p.noAsistio || 0,
    canceladas: p.canceladas || 0,
  }));
  const alto = Math.max(160, datos.length * 38 + 60);
  const largoNombre = Math.max(...datos.map((d) => String(d.name).length), 8);
  const anchoNombres = Math.min(200, Math.max(90, largoNombre * 7));
  return (
    <Tarjeta titulo="Citas por estado" sub="Cómo terminaron las citas de cada programa" alto={alto}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={datos} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 0 }} barCategoryGap="28%">
          <CartesianGrid horizontal={false} stroke={REJILLA} />
          <XAxis type="number" allowDecimals={false} {...ejes} />
          <YAxis type="category" dataKey="name" {...ejes} axisLine={false} interval={0} width={anchoNombres}
            tickFormatter={(v) => (String(v).length > 28 ? `${String(v).slice(0, 27)}…` : v)} />
          <Tooltip content={<CajaTooltip />} cursor={{ fill: '#f8fafc' }} />
          <Legend {...leyenda} />
          {ESTADOS.map(([k, label], i) => (
            <Bar key={k} dataKey={k} name={label} stackId="e" fill={COLOR[k]} stroke={SUPERFICIE} strokeWidth={2}
              radius={i === ESTADOS.length - 1 ? [0, 4, 4, 0] : 0} maxBarSize={26} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </Tarjeta>
  );
}

/** Chats y citas de cada anuncio (los que más trajeron primero). */
export function GraficoAnuncios({ anuncios, titulo = 'Chats y citas por anuncio', nombreCitas = 'Citas', max = 10 }) {
  const datos = [...(anuncios || [])]
    .filter((a) => !a.porServicio && (a.chats || a.citas))
    .sort((a, b) => (b.chats || 0) - (a.chats || 0) || (b.citas || 0) - (a.citas || 0))
    .slice(0, max)
    .map((a) => ({
      name: a.titular || a.adId,
      completo: a.titular ? `${a.titular} (${a.adId})` : a.adId,
      chats: a.chats || 0,
      citas: a.citas || 0,
    }));
  if (!datos.length) return null;
  const alto = Math.max(160, datos.length * 40 + 60);
  return (
    <Tarjeta titulo={titulo} sub={`Los ${datos.length} que más chats trajeron`} alto={alto}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={datos} layout="vertical" margin={{ top: 4, right: 12, left: 4, bottom: 0 }} barGap={2} barCategoryGap="22%">
          <CartesianGrid horizontal={false} stroke={REJILLA} />
          <XAxis type="number" allowDecimals={false} {...ejes} />
          <YAxis type="category" dataKey="name" {...ejes} axisLine={false} width={130}
            tickFormatter={(v) => (String(v).length > 20 ? `${String(v).slice(0, 19)}…` : v)} />
          <Tooltip
            content={<CajaTooltip etiqueta={(l) => datos.find((d) => d.name === l)?.completo || l} />}
            cursor={{ fill: '#f8fafc' }}
          />
          <Legend {...leyenda} />
          <Bar dataKey="chats" name="Chats" fill={COLOR.chats} radius={[0, 4, 4, 0]} maxBarSize={16} />
          <Bar dataKey="citas" name={nombreCitas} fill={COLOR.citas} radius={[0, 4, 4, 0]} maxBarSize={16} />
        </BarChart>
      </ResponsiveContainer>
    </Tarjeta>
  );
}
