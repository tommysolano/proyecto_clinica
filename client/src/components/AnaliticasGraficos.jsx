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

/** Inversión e ingresos de cada programa, lado a lado (misma escala: dólares). */
export function GraficoInversion({ programas }) {
  const datos = (programas || []).map((p) => ({ name: p.name, inversion: p.gasto || 0, ingresos: p.ingresos || 0 }));
  return (
    <Tarjeta titulo="Inversión e ingresos por programa" sub="Ingresos = citas efectivas que generan ingresos">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={datos} margin={{ top: 8, right: 12, left: -4, bottom: 0 }} barGap={2} barCategoryGap="25%">
          <CartesianGrid vertical={false} stroke={REJILLA} />
          <XAxis dataKey="name" {...ejes} interval={0} tickFormatter={(v) => (String(v).length > 14 ? `${String(v).slice(0, 13)}…` : v)} />
          <YAxis {...ejes} axisLine={false} tickFormatter={moneyCorto} width={52} />
          <Tooltip content={<CajaTooltip formato={money} />} cursor={{ fill: '#f8fafc' }} />
          <Legend {...leyenda} />
          <Bar dataKey="inversion" name="Inversión" fill={COLOR.inversion} radius={[4, 4, 0, 0]} maxBarSize={36} />
          <Bar dataKey="ingresos" name="Ingresos" fill={COLOR.ingresos} radius={[4, 4, 0, 0]} maxBarSize={36} />
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
  return (
    <Tarjeta titulo="Citas por estado" sub="Cómo terminaron las citas de cada programa" alto={alto}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={datos} layout="vertical" margin={{ top: 4, right: 12, left: 4, bottom: 0 }} barCategoryGap="28%">
          <CartesianGrid horizontal={false} stroke={REJILLA} />
          <XAxis type="number" allowDecimals={false} {...ejes} />
          <YAxis type="category" dataKey="name" {...ejes} axisLine={false} width={110}
            tickFormatter={(v) => (String(v).length > 16 ? `${String(v).slice(0, 15)}…` : v)} />
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
