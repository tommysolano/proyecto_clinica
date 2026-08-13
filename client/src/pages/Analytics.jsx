import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Cell,
  LabelList,
} from 'recharts';
import { HiOutlinePresentationChartLine, HiOutlineTableCells, HiOutlineChartBar } from 'react-icons/hi2';
import DateInput from '../components/DateInput';

/**
 * ANALÍTICAS DEL EMBUDO.
 *
 * Todo lo que se ve aquí sale de las OPORTUNIDADES y de sus etapas: la página ya
 * no mira la agenda de citas. "Agendado" es la etapa de la oportunidad, no una
 * cita del calendario — que un paciente tenga cita no significa que la
 * oportunidad se haya movido, y mezclar las dos fuentes daba dos cifras
 * distintas del mismo dato.
 *
 * Las cuentas las hace el servidor (GET /chats/opportunities/analytics). Antes se
 * armaban en el navegador con las listas paginadas de chats (tope 300) y de
 * oportunidades (tope 500): los indicadores no eran del rango, eran "lo que cupo
 * en la última página" — por eso "Chats" salía siempre clavado en 300.
 */

// ── Colores ──────────────────────────────────────────────────────────────────
// Las etapas de avance son una escala ORDENADA (una sola tinta, de claro a
// oscuro: cuanto más avanza el embudo, más oscuro). Los dos desenlaces se salen
// de la escala porque no son "más avanzado", son otra cosa: ganado en verde,
// perdido en rojo. Cada entidad conserva SU color en todas las gráficas de la
// página (agendado es el mismo azul en el embudo, en la serie diaria y en la
// tabla por agente).
const STAGE_COLOR = {
  nuevo: '#86b6ef',
  contactado: '#5598e7',
  interesado: '#2a78d6',
  agendado: '#1c5cab',
  ganado: '#1baf7a',
  perdido: '#d03b3b',
};
// "Creadas" / "Total" no es una etapa: color propio, fuera de la escala.
const C_TOTAL = '#eb6834';
const C_CHATS = '#2a78d6';
const INK = { text: '#334155', muted: '#94a3b8', grid: '#e2e8f0' };

const nf = new Intl.NumberFormat('es-EC');
const money = (n) => `$${new Intl.NumberFormat('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0)}`;
const moneyShort = (n) => `$${new Intl.NumberFormat('es-EC', { maximumFractionDigits: 0 }).format(Number(n) || 0)}`;
const pct = (x) => `${((Number(x) || 0) * 100).toFixed(1)}%`;
/** 'YYYY-MM-DD' → 'dd/mm' (sin pasar por Date: `new Date('2026-08-13')` es UTC). */
const ddmm = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');
/** Fecha local en ISO. `toISOString()` da el día de UTC: en Ecuador, a partir de las 19:00 adelanta un día. */
const isoLocal = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
const daysAgo = (n) => isoLocal(new Date(Date.now() - n * 86400000));

const CANALES = { whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram', tiktok: 'TikTok', sms: 'SMS', web: 'Web' };

const EMPTY = {
  totals: {
    chats: 0, oportunidades: 0, agendadas: 0, ganadas: 0, perdidas: 0, enCurso: 0,
    valorTotal: 0, valorGanado: 0, valorAgendado: 0, tasaAgendamiento: 0, tasaCierre: 0,
  },
  embudo: [], serie: [], porCanal: [], porAgente: [], servicios: [], motivosPerdida: [],
};

export default function Analytics() {
  const [start, setStart] = useState(daysAgo(30));
  const [end, setEnd] = useState(isoLocal(new Date()));
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);

  const load = async (from = start, to = end) => {
    setLoading(true);
    try {
      const r = await api.get('/chats/opportunities/analytics', { params: { from, to } });
      setData({ ...EMPTY, ...r.data });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar analíticas');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Los atajos aplican el rango Y recargan: pulsar "30 días" y tener que darle
  // además a Actualizar era un paso de más.
  const preset = (from, to) => {
    setStart(from);
    setEnd(to);
    load(from, to);
  };
  const hoy = isoLocal(new Date());
  const inicioMes = hoy.slice(0, 8) + '01';

  const t = data.totals;
  const embudo = data.embudo || [];
  const totalOpp = t.oportunidades || 0;

  // El embudo se pinta con la etiqueta ya formada ("124 · 38%"): una sola
  // etiqueta por barra en vez de dos superpuestas.
  const embudoRows = useMemo(
    () => embudo.map((e) => ({
      ...e,
      share: totalOpp ? e.count / totalOpp : 0,
      etiqueta: totalOpp ? `${nf.format(e.count)} · ${Math.round((e.count / totalOpp) * 100)}%` : nf.format(e.count),
    })),
    [embudo, totalOpp]
  );

  const canales = useMemo(
    () => (data.porCanal || []).map((c) => ({ ...c, label: CANALES[c.canal] || c.canal })),
    [data.porCanal]
  );
  const conServicios = (data.servicios || []).length > 0;
  const conMotivos = (data.motivosPerdida || []).some((m) => m.count > 0);
  const conAgentes = (data.porAgente || []).length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <HiOutlinePresentationChartLine className="text-emerald-600" /> Analíticas
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">Embudo de oportunidades del call center</p>
        </div>
        {/* Una sola fila de filtros arriba: manda sobre TODAS las gráficas. */}
        <div className="flex items-end gap-2 flex-wrap">
          <div className="flex gap-1 mr-1">
            <Preset onClick={() => preset(daysAgo(6), hoy)} active={start === daysAgo(6) && end === hoy}>7 días</Preset>
            <Preset onClick={() => preset(daysAgo(29), hoy)} active={start === daysAgo(29) && end === hoy}>30 días</Preset>
            <Preset onClick={() => preset(daysAgo(89), hoy)} active={start === daysAgo(89) && end === hoy}>90 días</Preset>
            <Preset onClick={() => preset(inicioMes, hoy)} active={start === inicioMes && end === hoy}>Este mes</Preset>
          </div>
          <label className="text-sm text-slate-600">Desde
            <DateInput value={start} onChange={(e) => setStart(e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" />
          </label>
          <label className="text-sm text-slate-600">Hasta
            <DateInput value={end} onChange={(e) => setEnd(e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" />
          </label>
          <button
            onClick={() => load()}
            className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 text-sm border-none cursor-pointer hover:bg-emerald-700"
          >
            {loading ? 'Cargando...' : 'Actualizar'}
          </button>
        </div>
      </div>

      {/* Al recargar se atenúa lo ya pintado en vez de vaciarlo: sin parpadeo ni salto de la página. */}
      <div className={`space-y-4 transition-opacity ${loading ? 'opacity-60' : 'opacity-100'}`}>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <Tile label="Oportunidades" value={nf.format(totalOpp)} hint="creadas en el rango" color={C_TOTAL} />
          <Tile label="Agendadas" value={nf.format(t.agendadas)} hint={`${pct(t.tasaAgendamiento)} llegó a agendarse`} color={STAGE_COLOR.agendado} />
          <Tile label="Ganadas" value={nf.format(t.ganadas)} hint={`${pct(t.tasaCierre)} de cierre`} color={STAGE_COLOR.ganado} />
          <Tile label="Valor ganado" value={moneyShort(t.valorGanado)} hint={`de ${moneyShort(t.valorTotal)} en juego`} color={STAGE_COLOR.ganado} />
          <Tile label="Chats nuevos" value={nf.format(t.chats)} hint="conversaciones que entraron" color={C_CHATS} />
        </div>

        <ChartCard
          title="Embudo por etapa"
          subtitle="Oportunidades según la etapa en la que están HOY. La suma es el total del rango."
          columns={[
            { key: 'label', label: 'Etapa' },
            { key: 'count', label: 'Oportunidades', num: true },
            { key: 'share', label: '% del total', num: true, fmt: pct },
            { key: 'value', label: 'Valor esperado', num: true, fmt: money },
          ]}
          rows={embudoRows}
          empty={!totalOpp}
        >
          <ResponsiveContainer width="100%" height={embudoRows.length * 52 + 24}>
            <BarChart data={embudoRows} layout="vertical" margin={{ top: 8, right: 96, bottom: 8, left: 8 }}>
              <CartesianGrid horizontal={false} stroke={INK.grid} />
              <XAxis type="number" hide domain={[0, 'dataMax']} />
              <YAxis
                type="category"
                dataKey="label"
                width={92}
                tickLine={false}
                axisLine={false}
                tick={{ fill: INK.text, fontSize: 13 }}
              />
              <Tooltip cursor={{ fill: '#f8fafc' }} content={<TipEtapa />} />
              <Bar dataKey="count" barSize={24} radius={[0, 4, 4, 0]} isAnimationActive={false}>
                {embudoRows.map((e) => <Cell key={e.stage} fill={STAGE_COLOR[e.stage] || C_CHATS} />)}
                <LabelList dataKey="etiqueta" position="right" fill={INK.text} fontSize={12} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Movimiento del embudo por día"
          subtitle="Creadas por su fecha de alta; agendadas y ganadas por el día en que entraron en esa etapa."
          columns={[
            { key: 'date', label: 'Día', fmt: ddmm },
            { key: 'creadas', label: 'Creadas', num: true },
            { key: 'agendadas', label: 'Agendadas', num: true },
            { key: 'ganadas', label: 'Ganadas', num: true },
          ]}
          rows={data.serie}
          empty={!data.serie.length}
          legend={[
            { label: 'Creadas', color: C_TOTAL },
            { label: 'Agendadas', color: STAGE_COLOR.agendado },
            { label: 'Ganadas', color: STAGE_COLOR.ganado },
          ]}
        >
          <ResponsiveContainer width="100%" height={340}>
            <LineChart data={data.serie} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid vertical={false} stroke={INK.grid} />
              <XAxis
                dataKey="date"
                tickFormatter={ddmm}
                tickLine={false}
                axisLine={{ stroke: INK.grid }}
                tick={{ fill: INK.muted, fontSize: 12 }}
                minTickGap={28}
              />
              <YAxis allowDecimals={false} width={40} tickLine={false} axisLine={false} tick={{ fill: INK.muted, fontSize: 12 }} />
              <Tooltip cursor={{ stroke: '#cbd5e1', strokeWidth: 1 }} content={<TipSerie />} />
              <Line type="monotone" dataKey="creadas" name="Creadas" stroke={C_TOTAL} strokeWidth={2} dot={dotFor(data.serie, C_TOTAL)} activeDot={{ r: 5, strokeWidth: 2, stroke: '#fff' }} isAnimationActive={false} />
              <Line type="monotone" dataKey="agendadas" name="Agendadas" stroke={STAGE_COLOR.agendado} strokeWidth={2} dot={dotFor(data.serie, STAGE_COLOR.agendado)} activeDot={{ r: 5, strokeWidth: 2, stroke: '#fff' }} isAnimationActive={false} />
              <Line type="monotone" dataKey="ganadas" name="Ganadas" stroke={STAGE_COLOR.ganado} strokeWidth={2} dot={dotFor(data.serie, STAGE_COLOR.ganado)} activeDot={{ r: 5, strokeWidth: 2, stroke: '#fff' }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Valor esperado por etapa"
          subtitle="Cuánto dinero hay parado en cada etapa del embudo."
          columns={[
            { key: 'label', label: 'Etapa' },
            { key: 'value', label: 'Valor esperado', num: true, fmt: money },
            { key: 'count', label: 'Oportunidades', num: true },
          ]}
          rows={embudoRows}
          empty={!embudoRows.some((e) => e.value > 0)}
        >
          <ResponsiveContainer width="100%" height={embudoRows.length * 52 + 24}>
            <BarChart data={embudoRows} layout="vertical" margin={{ top: 8, right: 110, bottom: 8, left: 8 }}>
              <CartesianGrid horizontal={false} stroke={INK.grid} />
              <XAxis type="number" hide domain={[0, 'dataMax']} />
              <YAxis type="category" dataKey="label" width={92} tickLine={false} axisLine={false} tick={{ fill: INK.text, fontSize: 13 }} />
              <Tooltip cursor={{ fill: '#f8fafc' }} content={<TipValor />} />
              <Bar dataKey="value" barSize={24} radius={[0, 4, 4, 0]} isAnimationActive={false}>
                {embudoRows.map((e) => <Cell key={e.stage} fill={STAGE_COLOR[e.stage] || C_CHATS} />)}
                <LabelList dataKey="value" position="right" formatter={money} fill={INK.text} fontSize={12} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title="Chats nuevos por día"
          subtitle="Conversaciones que entraron al call center en el rango."
          columns={[{ key: 'date', label: 'Día', fmt: ddmm }, { key: 'chats', label: 'Chats', num: true }]}
          rows={data.serie}
          empty={!t.chats}
        >
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data.serie} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid vertical={false} stroke={INK.grid} />
              <XAxis dataKey="date" tickFormatter={ddmm} tickLine={false} axisLine={{ stroke: INK.grid }} tick={{ fill: INK.muted, fontSize: 12 }} minTickGap={28} />
              <YAxis allowDecimals={false} width={40} tickLine={false} axisLine={false} tick={{ fill: INK.muted, fontSize: 12 }} />
              <Tooltip cursor={{ fill: '#f8fafc' }} content={<TipSerie />} />
              <Bar dataKey="chats" name="Chats" fill={C_CHATS} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {conAgentes && (
          <ChartCard
            title="Oportunidades por agente"
            subtitle="Quién tiene el embudo y cuánto de él llega a agendarse o a ganarse."
            columns={[
              { key: 'agente', label: 'Agente' },
              { key: 'total', label: 'Oportunidades', num: true },
              { key: 'agendadas', label: 'Agendadas', num: true },
              { key: 'ganadas', label: 'Ganadas', num: true },
              { key: 'valorGanado', label: 'Valor ganado', num: true, fmt: money },
            ]}
            rows={data.porAgente}
            empty={false}
            legend={[
              { label: 'Oportunidades', color: C_TOTAL },
              { label: 'Agendadas', color: STAGE_COLOR.agendado },
              { label: 'Ganadas', color: STAGE_COLOR.ganado },
            ]}
          >
            <ResponsiveContainer width="100%" height={data.porAgente.length * 72 + 40}>
              <BarChart data={data.porAgente} layout="vertical" margin={{ top: 8, right: 56, bottom: 8, left: 8 }}>
                <CartesianGrid horizontal={false} stroke={INK.grid} />
                <XAxis type="number" hide domain={[0, 'dataMax']} />
                <YAxis type="category" dataKey="agente" width={150} tickLine={false} axisLine={false} tick={{ fill: INK.text, fontSize: 13 }} />
                <Tooltip cursor={{ fill: '#f8fafc' }} content={<TipSerie />} />
                <Bar dataKey="total" name="Oportunidades" fill={C_TOTAL} barSize={14} radius={[0, 4, 4, 0]} isAnimationActive={false}>
                  <LabelList dataKey="total" position="right" fill={INK.text} fontSize={11} />
                </Bar>
                <Bar dataKey="agendadas" name="Agendadas" fill={STAGE_COLOR.agendado} barSize={14} radius={[0, 4, 4, 0]} isAnimationActive={false}>
                  <LabelList dataKey="agendadas" position="right" fill={INK.text} fontSize={11} />
                </Bar>
                <Bar dataKey="ganadas" name="Ganadas" fill={STAGE_COLOR.ganado} barSize={14} radius={[0, 4, 4, 0]} isAnimationActive={false}>
                  <LabelList dataKey="ganadas" position="right" fill={INK.text} fontSize={11} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {conServicios && (
          <ChartCard
            title="Servicios más pedidos"
            subtitle="Servicios de interés apuntados en las oportunidades del rango."
            columns={[{ key: 'servicio', label: 'Servicio' }, { key: 'count', label: 'Oportunidades', num: true }]}
            rows={data.servicios}
            empty={false}
          >
            <ResponsiveContainer width="100%" height={data.servicios.length * 44 + 24}>
              <BarChart data={data.servicios} layout="vertical" margin={{ top: 8, right: 56, bottom: 8, left: 8 }}>
                <CartesianGrid horizontal={false} stroke={INK.grid} />
                <XAxis type="number" hide domain={[0, 'dataMax']} />
                <YAxis type="category" dataKey="servicio" width={190} tickLine={false} axisLine={false} tick={{ fill: INK.text, fontSize: 12 }} />
                <Tooltip cursor={{ fill: '#f8fafc' }} content={<TipSerie />} />
                <Bar dataKey="count" name="Oportunidades" fill={C_CHATS} barSize={20} radius={[0, 4, 4, 0]} isAnimationActive={false}>
                  <LabelList dataKey="count" position="right" fill={INK.text} fontSize={12} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        <ChartCard
          title="Oportunidades por canal"
          subtitle="Por dónde entró la conversación de la que nació la oportunidad."
          columns={[{ key: 'label', label: 'Canal' }, { key: 'count', label: 'Oportunidades', num: true }]}
          rows={canales}
          empty={!canales.length}
        >
          <ResponsiveContainer width="100%" height={Math.max(canales.length, 1) * 44 + 24}>
            <BarChart data={canales} layout="vertical" margin={{ top: 8, right: 56, bottom: 8, left: 8 }}>
              <CartesianGrid horizontal={false} stroke={INK.grid} />
              <XAxis type="number" hide domain={[0, 'dataMax']} />
              <YAxis type="category" dataKey="label" width={110} tickLine={false} axisLine={false} tick={{ fill: INK.text, fontSize: 13 }} />
              <Tooltip cursor={{ fill: '#f8fafc' }} content={<TipSerie />} />
              <Bar dataKey="count" name="Oportunidades" fill={C_CHATS} barSize={20} radius={[0, 4, 4, 0]} isAnimationActive={false}>
                <LabelList dataKey="count" position="right" fill={INK.text} fontSize={12} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {conMotivos && (
          <ChartCard
            title="Motivos de pérdida"
            subtitle="Por qué se perdieron las oportunidades marcadas como perdidas."
            columns={[{ key: 'motivo', label: 'Motivo' }, { key: 'count', label: 'Oportunidades', num: true }]}
            rows={data.motivosPerdida}
            empty={false}
          >
            <ResponsiveContainer width="100%" height={data.motivosPerdida.length * 44 + 24}>
              <BarChart data={data.motivosPerdida} layout="vertical" margin={{ top: 8, right: 56, bottom: 8, left: 8 }}>
                <CartesianGrid horizontal={false} stroke={INK.grid} />
                <XAxis type="number" hide domain={[0, 'dataMax']} />
                <YAxis type="category" dataKey="motivo" width={190} tickLine={false} axisLine={false} tick={{ fill: INK.text, fontSize: 12 }} />
                <Tooltip cursor={{ fill: '#f8fafc' }} content={<TipSerie />} />
                <Bar dataKey="count" name="Oportunidades" fill={STAGE_COLOR.perdido} barSize={20} radius={[0, 4, 4, 0]} isAnimationActive={false}>
                  <LabelList dataKey="count" position="right" fill={INK.text} fontSize={12} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}
      </div>
    </div>
  );
}

/**
 * Los puntos de la línea se ocultan cuando el rango es largo: con 90 días encima
 * de la línea son ruido, y el valor exacto sigue estando en el tooltip y en la
 * tabla.
 */
const dotFor = (serie, color) =>
  (serie || []).length <= 45 ? { r: 4, fill: color, strokeWidth: 0 } : false;

function Preset({ children, onClick, active }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-xl text-xs border cursor-pointer transition-colors ${
        active
          ? 'bg-slate-800 text-white border-slate-800'
          : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
      }`}
    >
      {children}
    </button>
  );
}

function Tile({ label, value, hint, color }) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4">
      <div className="flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
        <p className="text-[11px] text-slate-500 uppercase font-semibold tracking-wide">{label}</p>
      </div>
      <p className="text-3xl font-bold text-slate-800 mt-1 leading-tight">{value}</p>
      <p className="text-xs text-slate-400 mt-0.5">{hint}</p>
    </div>
  );
}

/**
 * Tarjeta de una gráfica. Cada una ocupa TODA la fila (antes iban de dos en dos y
 * las barras salían apretadas) y trae su equivalente en tabla: el valor exacto
 * nunca depende de acertar con el ratón encima de una barra.
 */
function ChartCard({ title, subtitle, children, columns, rows, empty, legend }) {
  const [tabla, setTabla] = useState(false);
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="text-base font-semibold text-slate-800">{title}</p>
          {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
        </div>
        {/* La leyenda se pinta aquí, y no con <Legend> de recharts, para que las
            series salgan en el orden del embudo (creadas → agendadas → ganadas)
            y no reordenadas por la librería. */}
        {legend?.length > 0 && !tabla && (
          <div className="flex items-center gap-4 flex-wrap ml-auto mr-1">
            {legend.map((l) => (
              <span key={l.label} className="flex items-center gap-1.5 text-xs text-slate-600">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: l.color }} />
                {l.label}
              </span>
            ))}
          </div>
        )}
        <button
          onClick={() => setTabla((v) => !v)}
          title={tabla ? 'Ver gráfica' : 'Ver tabla'}
          className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-600 text-xs cursor-pointer hover:bg-slate-50"
        >
          {tabla ? <HiOutlineChartBar /> : <HiOutlineTableCells />}
          {tabla ? 'Gráfica' : 'Tabla'}
        </button>
      </div>
      {empty ? (
        <p className="text-sm text-slate-400 py-10 text-center">Sin datos en este rango</p>
      ) : tabla ? (
        <TablaDatos columns={columns} rows={rows} />
      ) : (
        children
      )}
    </div>
  );
}

function TablaDatos({ columns = [], rows = [] }) {
  return (
    <div className="overflow-x-auto max-h-96 overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-white">
          <tr className="text-left text-slate-500 border-b border-slate-200">
            {columns.map((c) => (
              <th key={c.key} className={`py-2 px-2 font-medium ${c.num ? 'text-right' : ''}`}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-slate-100 last:border-0">
              {columns.map((c) => (
                <td key={c.key} className={`py-1.5 px-2 text-slate-700 ${c.num ? 'text-right tabular-nums' : ''}`}>
                  {c.fmt ? c.fmt(r[c.key]) : (r[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Tooltips ─────────────────────────────────────────────────────────────────

function TipBox({ title, children }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-lg px-3 py-2 text-xs">
      <p className="font-semibold text-slate-700 mb-1">{title}</p>
      {children}
    </div>
  );
}

function TipFila({ color, label, value }) {
  return (
    <p className="flex items-center gap-1.5 text-slate-600">
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
      {label}: <span className="font-semibold text-slate-800">{value}</span>
    </p>
  );
}

function TipEtapa({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <TipBox title={d.label}>
      <TipFila color={STAGE_COLOR[d.stage]} label="Oportunidades" value={nf.format(d.count)} />
      <p className="text-slate-500 mt-0.5">{pct(d.share)} del total · {money(d.value)} esperados</p>
    </TipBox>
  );
}

function TipValor({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <TipBox title={d.label}>
      <TipFila color={STAGE_COLOR[d.stage]} label="Valor esperado" value={money(d.value)} />
      <p className="text-slate-500 mt-0.5">{nf.format(d.count)} oportunidades</p>
    </TipBox>
  );
}

function TipSerie({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const titulo = typeof label === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(label) ? ddmm(label) : label;
  return (
    <TipBox title={titulo}>
      {payload.map((p) => (
        <TipFila key={p.dataKey} color={p.color || p.fill} label={p.name} value={nf.format(p.value)} />
      ))}
    </TipBox>
  );
}
