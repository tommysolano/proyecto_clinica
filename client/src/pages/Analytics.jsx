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
import {
  HiOutlinePresentationChartLine,
  HiOutlineTableCells,
  HiOutlineChartBar,
  HiOutlineArrowTopRightOnSquare,
} from 'react-icons/hi2';
import DateInput from '../components/DateInput';
import Modal from '../components/Modal';
import { formatPhone } from '../utils/phone';

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
const STAGE_KEYS = ['nuevo', 'contactado', 'interesado', 'agendado', 'ganado', 'perdido'];
const STAGE_LABEL = {
  nuevo: 'Nuevo',
  contactado: 'Contactado',
  interesado: 'Interesado',
  agendado: 'Agendado',
  ganado: 'Ganado',
  perdido: 'Perdido',
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

// Cuántos anuncios se dibujan de entrada en "Chats por anuncio" (el resto, a un
// clic). No es un tope del informe: el servidor los manda todos.
const TOPE_ANUNCIOS = 15;

const EMPTY = {
  totals: {
    chats: 0, oportunidades: 0, agendadas: 0, ganadas: 0, perdidas: 0, enCurso: 0, anuncios: 0,
    valorTotal: 0, valorGanado: 0, valorAgendado: 0, tasaAgendamiento: 0, tasaCierre: 0,
  },
  embudo: [], serie: [], porOportunidad: [], porAnuncio: [], porCanal: [], porAgente: [], servicios: [], motivosPerdida: [],
};

/**
 * Etiqueta del eje: los titulares de anuncio son largos y empujarían la gráfica.
 * Si el texto acaba en un desempate (" · …1234", el final del id de un anuncio con
 * titular repetido), se recorta por DELANTE: cortar por el final se llevaba justo
 * lo único que distinguía las dos filas.
 */
const corta = (s, n = 30) => {
  const txt = String(s || '');
  const cola = txt.match(/ · …\S+$/);
  if (cola) {
    const cabeza = txt.slice(0, txt.length - cola[0].length);
    const hueco = Math.max(8, n - cola[0].length);
    return (cabeza.length > hueco ? `${cabeza.slice(0, hueco - 1)}…` : cabeza) + cola[0];
  }
  return txt.length > n ? `${txt.slice(0, n - 1)}…` : txt;
};

/**
 * Etiqueta de eje de UNA sola línea. Recharts parte los textos largos en varias
 * líneas y, para que no se solapen, recorta las etiquetas VECINAS: con un nombre
 * de campaña largo arriba, "Detox 1" o "Prostata 2" salían como "Deto…" y "Pr…".
 * Con un tick propio el corte lo decidimos nosotros y solo afecta al que sobra.
 */
function TickNombre({ x, y, payload, max = 28, onPick }) {
  return (
    <text
      x={x}
      y={y}
      dy={4}
      textAnchor="end"
      fill={INK.text}
      fontSize={12}
      // Pinchar el nombre abre la fila ENTERA (todas sus etapas); pinchar una
      // barra abre solo esa etapa.
      style={onPick ? { cursor: 'pointer' } : undefined}
      onClick={onPick ? () => onPick(payload?.value) : undefined}
    >
      {corta(payload?.value, max)}
    </text>
  );
}

/**
 * La fila de datos que hay debajo de una barra clicada. Recharts entrega en el
 * onClick de <Bar> la forma dibujada, con la fila original dentro de `payload`;
 * en algunas versiones la manda aplanada. Se aceptan las dos.
 */
const filaDe = (e) => e?.payload || e || null;

/**
 * Abre el chat de una persona en una pestaña nueva (ver el enlace en Chats.jsx).
 *
 * Va por ID de conversación, no por teléfono: el chat ya existe (por eso está en
 * el informe) y así funciona igual con Messenger o Instagram, donde el "phone"
 * no es un número al que se pueda escribir.
 */
function abrirChatEnPestaña(item) {
  if (!item?.conversationId) return;
  window.open(`/chats?chat=${encodeURIComponent(item.conversationId)}`, '_blank', 'noopener');
}

export default function Analytics() {
  const [start, setStart] = useState(daysAgo(30));
  const [end, setEnd] = useState(isoLocal(new Date()));
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  // Barra abierta: { by, value, stage, titulo, subtitulo }. Las cifras solas no
  // dejaban llegar a la persona; al pinchar una barra se ve QUIÉNES son y se
  // entra a su chat.
  const [drill, setDrill] = useState(null);
  // "Chats por anuncio" dibuja los primeros y deja el resto a un clic: son
  // decenas de anuncios y de golpe la gráfica mide varias pantallas.
  const [todosAnuncios, setTodosAnuncios] = useState(false);

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
  // Solo se pintan las etapas que TIENEN datos en el rango: con las seis siempre,
  // cada oportunidad arrastraba tres barras vacías y la gráfica no cabía.
  const etapasVisibles = useMemo(
    () => STAGE_KEYS.filter((s) => (data.porOportunidad || []).some((o) => o[s] > 0)),
    [data.porOportunidad]
  );
  const conServicios = (data.servicios || []).length > 0;
  const conMotivos = (data.motivosPerdida || []).some((m) => m.count > 0);

  const anunciosGrafica = todosAnuncios ? (data.porAnuncio || []) : (data.porAnuncio || []).slice(0, TOPE_ANUNCIOS);
  /** Quiénes escribieron desde este anuncio (se agrupa por ID, no por titular). */
  const abrirAnuncio = (fila) => {
    if (!fila?.adId) return;
    setDrill({
      by: 'anuncio',
      value: fila.adId,
      titulo: fila.titular || `Anuncio ${fila.adId}`,
      subtitulo: `Anuncio ${fila.adId}`,
    });
  };
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
            <Preset onClick={() => preset(hoy, hoy)} active={start === hoy && end === hoy}>Hoy</Preset>
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
          {/* El chat y la oportunidad NO son lo mismo: un chat puede tener varias
              (cada anuncio en el que hace clic la persona crea la suya) y una
              oportunidad de hoy puede caer en un chat de hace meses. Por eso la
              tarjeta dice en cuántos chats están: si no, "452 oportunidades con 226
              chats nuevos" parece un error y no lo es. */}
          <Tile
            label="Oportunidades"
            value={nf.format(totalOpp)}
            hint={t.chatsConOportunidad ? `en ${nf.format(t.chatsConOportunidad)} chats` : 'creadas en el rango'}
            color={C_TOTAL}
          />
          <Tile label="Agendadas" value={nf.format(t.agendadas)} hint={`${pct(t.tasaAgendamiento)} llegó a agendarse`} color={STAGE_COLOR.agendado} />
          <Tile label="Ganadas" value={nf.format(t.ganadas)} hint={`${pct(t.tasaCierre)} de cierre · ${moneyShort(t.valorGanado)}`} color={STAGE_COLOR.ganado} />
          {/* El valor "en juego" son las AGENDADAS, no todo el embudo: una
              oportunidad recién nacida de un anuncio no es dinero en camino, y
              sumándolas el importe salía inflado (hoy: $5.854 de "nuevo" contra
              $465 de agendado). Lo que de verdad está en juego es lo que ya tiene
              cita. El desglose completo sigue en "Valor esperado por etapa". */}
          <Tile
            label="Valor esperado"
            value={moneyShort(t.valorAgendado)}
            hint={`de las ${nf.format(t.agendadas)} agendadas`}
            color={STAGE_COLOR.agendado}
          />
          <Tile
            label="Chats nuevos"
            value={nf.format(t.chats)}
            hint={t.chatsDesdeAnuncios ? `${nf.format(t.chatsDesdeAnuncios)} desde anuncios` : 'conversaciones que entraron'}
            color={C_CHATS}
          />
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
          title="Qué oportunidades son"
          subtitle="Cada oportunidad por su nombre, con una barra por etapa. Pincha una barra para ver de quién es y entrar a su chat. Las que nacen solas de un anuncio no llevan nombre: esas se ven en «Chats por anuncio»."
          onRowClick={(r) => setDrill({
            by: 'oportunidad',
            value: r.nombre,
            titulo: r.nombre,
            subtitulo: 'Todas las etapas',
          })}
          columns={[
            { key: 'nombre', label: 'Oportunidad' },
            { key: 'total', label: 'Total', num: true },
            { key: 'nuevo', label: 'Nuevo', num: true },
            { key: 'contactado', label: 'Contactado', num: true },
            { key: 'interesado', label: 'Interesado', num: true },
            { key: 'agendado', label: 'Agendado', num: true },
            { key: 'ganado', label: 'Ganado', num: true },
            { key: 'perdido', label: 'Perdido', num: true },
            { key: 'value', label: 'Valor esperado', num: true, fmt: money },
          ]}
          rows={data.porOportunidad}
          empty={!data.porOportunidad.length}
          legend={etapasVisibles.map((s) => ({ label: STAGE_LABEL[s], color: STAGE_COLOR[s] }))}
        >
          <ResponsiveContainer
            width="100%"
            height={data.porOportunidad.length * Math.max(44, etapasVisibles.length * 14 + 14) + 32}
          >
            <BarChart
              data={data.porOportunidad}
              layout="vertical"
              margin={{ top: 8, right: 64, bottom: 8, left: 8 }}
              barGap={2}
              barCategoryGap="22%"
            >
              <CartesianGrid horizontal={false} stroke={INK.grid} />
              <XAxis type="number" hide domain={[0, 'dataMax']} />
              <YAxis
                type="category"
                dataKey="nombre"
                width={210}
                tickLine={false}
                axisLine={false}
                tick={(
                  <TickNombre
                    max={28}
                    onPick={(nombre) => nombre && setDrill({
                      by: 'oportunidad',
                      value: nombre,
                      titulo: nombre,
                      subtitulo: 'Todas las etapas',
                    })}
                  />
                )}
              />
              <Tooltip cursor={{ fill: '#f8fafc' }} content={<TipOportunidad />} />
              {/* Una BARRA POR ETAPA, no una barra partida: apiladas, un "agendado"
                  de 2 sobre un "nuevo" de 30 era una raya que no se podía comparar
                  con la de al lado. Separadas, cada etapa se lee contra su propia
                  línea de cero. */}
              {etapasVisibles.map((stage) => (
                <Bar
                  key={stage}
                  dataKey={stage}
                  name={STAGE_LABEL[stage]}
                  fill={STAGE_COLOR[stage]}
                  barSize={11}
                  radius={[0, 4, 4, 0]}
                  isAnimationActive={false}
                  cursor="pointer"
                  onClick={(e) => {
                    const fila = filaDe(e);
                    if (!fila?.nombre || !fila[stage]) return;
                    setDrill({
                      by: 'oportunidad',
                      value: fila.nombre,
                      stage,
                      titulo: fila.nombre,
                      subtitulo: `En etapa «${STAGE_LABEL[stage]}»`,
                    });
                  }}
                >
                  <LabelList
                    dataKey={stage}
                    position="right"
                    fill={INK.text}
                    fontSize={11}
                    formatter={(v) => (v > 0 ? nf.format(v) : '')}
                  />
                </Bar>
              ))}
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

        {/* De qué ANUNCIO viene cada chat. El dato no está en la conversación: lo
            trae el mensaje entrante (`referral`), que es lo mismo que ya hace que
            en el chat salga "desde anuncio". La etiqueta es el TITULAR del anuncio
            —lo único legible que manda Meta—, no el nombre de la campaña. */}
        <ChartCard
          title="Chats por anuncio"
          subtitle="Conversaciones distintas que escribieron desde cada anuncio (click-to-WhatsApp). Se cuenta el chat, no cada mensaje. Pincha un anuncio para ver quiénes escribieron y entrar a su chat."
          columns={[
            { key: 'titular', label: 'Titular del anuncio' },
            { key: 'chats', label: 'Chats', num: true },
            { key: 'adId', label: 'ID del anuncio' },
          ]}
          rows={data.porAnuncio}
          empty={!data.porAnuncio.length}
          onRowClick={(r) => abrirAnuncio(r)}
        >
          {/* Se dibujan los primeros y el resto se pide con el botón: el usuario
              decía —con razón— "tengo muchos más anuncios de los que aparecen"
              (41 anuncios el 21-ago-2026 y la página enseñaba 15). Ahora vienen
              todos; lo único que se decide aquí es cuántos caben de un vistazo. */}
          <>
            <ResponsiveContainer width="100%" height={anunciosGrafica.length * 44 + 32}>
              <BarChart data={anunciosGrafica} layout="vertical" margin={{ top: 8, right: 64, bottom: 8, left: 8 }}>
                <CartesianGrid horizontal={false} stroke={INK.grid} />
                <XAxis type="number" hide domain={[0, 'dataMax']} />
                <YAxis
                  type="category"
                  dataKey="titular"
                  width={230}
                  tickLine={false}
                  axisLine={false}
                  tick={<TickNombre max={32} onPick={(titular) => abrirAnuncio(data.porAnuncio.find((a) => a.titular === titular))} />}
                />
                <Tooltip cursor={{ fill: '#f8fafc' }} content={<TipAnuncio />} />
                <Bar
                  dataKey="chats"
                  name="Chats"
                  fill={C_CHATS}
                  barSize={20}
                  radius={[0, 4, 4, 0]}
                  isAnimationActive={false}
                  cursor="pointer"
                  onClick={(e) => abrirAnuncio(filaDe(e))}
                >
                  <LabelList dataKey="chats" position="right" fill={INK.text} fontSize={12} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            {data.porAnuncio.length > TOPE_ANUNCIOS && (
              <button
                onClick={() => setTodosAnuncios((v) => !v)}
                className="mt-1 mx-auto block px-3 py-1.5 rounded-xl border border-slate-200 bg-white text-slate-600 text-xs cursor-pointer hover:bg-slate-50"
              >
                {todosAnuncios
                  ? `Ver solo los ${TOPE_ANUNCIOS} con más chats`
                  : `Ver los ${nf.format(data.porAnuncio.length)} anuncios`}
              </button>
            )}
            {/* Si el rango trae más de los que caben en la respuesta, se DICE.
                Un recorte callado se lee como "estos son todos los anuncios". */}
            {t.anuncios > data.porAnuncio.length && (
              <p className="mt-1 text-center text-[11px] text-slate-400">
                En este rango hay {nf.format(t.anuncios)} anuncios; se listan los {nf.format(data.porAnuncio.length)} con
                más chats. Acota las fechas para verlos todos.
              </p>
            )}
          </>
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
            subtitle="Por qué se perdieron las oportunidades marcadas como perdidas. Pincha una barra para ver quiénes son y entrar a su chat."
            columns={[{ key: 'motivo', label: 'Motivo' }, { key: 'count', label: 'Oportunidades', num: true }]}
            rows={data.motivosPerdida}
            empty={false}
            onRowClick={(r) => setDrill({
              by: 'motivo',
              value: r.motivo,
              titulo: `Perdidas por «${r.motivo}»`,
            })}
          >
            <ResponsiveContainer width="100%" height={data.motivosPerdida.length * 44 + 24}>
              <BarChart data={data.motivosPerdida} layout="vertical" margin={{ top: 8, right: 56, bottom: 8, left: 8 }}>
                <CartesianGrid horizontal={false} stroke={INK.grid} />
                <XAxis type="number" hide domain={[0, 'dataMax']} />
                <YAxis type="category" dataKey="motivo" width={190} tickLine={false} axisLine={false} tick={{ fill: INK.text, fontSize: 12 }} />
                <Tooltip cursor={{ fill: '#f8fafc' }} content={<TipSerie />} />
                <Bar
                  dataKey="count"
                  name="Oportunidades"
                  fill={STAGE_COLOR.perdido}
                  barSize={20}
                  radius={[0, 4, 4, 0]}
                  isAnimationActive={false}
                  cursor="pointer"
                  onClick={(e) => {
                    const fila = filaDe(e);
                    if (!fila?.motivo) return;
                    setDrill({ by: 'motivo', value: fila.motivo, titulo: `Perdidas por «${fila.motivo}»` });
                  }}
                >
                  <LabelList dataKey="count" position="right" fill={INK.text} fontSize={12} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        )}
      </div>

      {/* La `key` fuerza a montarlo de nuevo al cambiar de barra: así el detalle
          arranca siempre limpio en vez de enseñar un instante el de la anterior. */}
      {drill && (
        <DetalleBarra
          key={`${drill.by}|${drill.value}|${drill.stage || ''}`}
          drill={drill}
          from={start}
          to={end}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}

/**
 * QUIÉNES hay detrás de una barra, con su chat a un clic.
 *
 * El rango que se manda es el MISMO que el de la página, no el que se ve en los
 * cuadros de fecha: si alguien cambia las fechas sin darle a Actualizar, la
 * gráfica sigue siendo la del rango cargado y el detalle tiene que cuadrar con
 * ella. Por eso `from`/`to` llegan desde arriba junto con la barra abierta.
 */
function DetalleBarra({ drill, from, to, onClose }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);
  // "Chats por anuncio" cuenta CONVERSACIONES; las otras dos, oportunidades.
  // Llamarlas por su nombre evita que una cifra correcta parezca un error.
  const [unidad, setUnidad] = useState('oportunidades');

  useEffect(() => {
    let vivo = true;
    api
      .get('/chats/opportunities/analytics/detail', {
        params: { from, to, by: drill.by, value: drill.value, stage: drill.stage || undefined },
      })
      .then((r) => {
        if (!vivo) return;
        setItems(r.data?.items || []);
        setTruncated(!!r.data?.truncated);
        setUnidad(r.data?.unidad || 'oportunidades');
      })
      .catch((err) => {
        if (vivo) setError(err.response?.data?.message || 'No se pudo cargar el detalle');
      });
    return () => { vivo = false; };
  }, [drill.by, drill.value, drill.stage, from, to]);

  return (
    <Modal isOpen onClose={onClose} title={drill.titulo} size="2xl">
      <div className="grid gap-3 min-w-0">
        <p className="text-xs text-slate-500">
          {drill.subtitulo ? `${drill.subtitulo} · ` : ''}
          {ddmm(from)} al {ddmm(to)}
          {items
            ? ` · ${nf.format(items.length)} ${unidad === 'chats'
              ? `chat${items.length === 1 ? '' : 's'}`
              : `oportunidad${items.length === 1 ? '' : 'es'}`}`
            : ''}
        </p>
        <p className="text-[11px] text-slate-400 -mt-1">
          Haz clic en una persona para abrir su chat en una pestaña nueva.
        </p>

        {truncated && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Se muestran las 500 más recientes. Acota el rango de fechas para verlas todas.
          </div>
        )}

        {error ? (
          <p className="py-10 text-center text-sm text-rose-600">{error}</p>
        ) : !items ? (
          <p className="py-10 text-center text-sm text-slate-400">Cargando…</p>
        ) : !items.length ? (
          <p className="py-10 text-center text-sm text-slate-400">
            No hay {unidad === 'chats' ? 'chats' : 'oportunidades'} en esta barra.
          </p>
        ) : (
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-left text-xs">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 sticky top-0">
                  <tr>
                    <th className="px-3 py-2.5">Contacto</th>
                    <th className="px-3 py-2.5">Teléfono</th>
                    <th className="px-3 py-2.5 w-28">Etapa</th>
                    <th className="px-3 py-2.5">{drill.by === 'oportunidad' ? 'Motivo' : 'Oportunidad'}</th>
                    <th className="px-3 py-2.5">Asignado a</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((it, i) => {
                    const abrible = !!it.conversationId;
                    return (
                      <tr
                        key={`${it.conversationId}-${i}`}
                        onClick={abrible ? () => abrirChatEnPestaña(it) : undefined}
                        title={abrible ? 'Abrir el chat en una pestaña nueva' : undefined}
                        className={abrible ? 'cursor-pointer hover:bg-emerald-50/60' : ''}
                      >
                        <td className="px-3 py-2.5">
                          <div className={`font-semibold flex items-center gap-1.5 ${abrible ? 'text-emerald-700' : 'text-slate-700'}`}>
                            <span className="break-words">{it.contactName || 'Sin nombre'}</span>
                            {abrible && <HiOutlineArrowTopRightOnSquare className="w-3.5 h-3.5 shrink-0 text-emerald-500" />}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-slate-600">{formatPhone(it.phone) || '—'}</td>
                        <td className="px-3 py-2.5">
                          {/* Un chat que vino de un anuncio puede no tener
                              oportunidad todavía: ahí no hay etapa que pintar. */}
                          {it.stage ? (
                            <span
                              className="inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold text-white"
                              style={{ background: STAGE_COLOR[it.stage] || C_CHATS }}
                            >
                              {STAGE_LABEL[it.stage] || it.stage}
                            </span>
                          ) : (
                            <span className="text-slate-400">Sin oportunidad</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-slate-500 break-words">
                          {(drill.by === 'oportunidad' ? it.motivo : it.nombre) || '—'}
                        </td>
                        <td className="px-3 py-2.5 text-slate-500">{it.assignedToName || 'Sin asignar'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Modal>
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
function ChartCard({ title, subtitle, children, columns, rows, empty, legend, onRowClick }) {
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
        <TablaDatos columns={columns} rows={rows} onRowClick={onRowClick} />
      ) : (
        children
      )}
    </div>
  );
}

function TablaDatos({ columns = [], rows = [], onRowClick }) {
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
            <tr
              key={i}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              title={onRowClick ? 'Ver quiénes son' : undefined}
              className={`border-b border-slate-100 last:border-0 ${onRowClick ? 'cursor-pointer hover:bg-emerald-50/60' : ''}`}
            >
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

function TipOportunidad({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const conValor = STAGE_KEYS.filter((s) => d[s] > 0);
  return (
    <TipBox title={d.nombre}>
      <p className="text-slate-600">Total: <span className="font-semibold text-slate-800">{nf.format(d.total)}</span></p>
      {conValor.map((s) => (
        <TipFila key={s} color={STAGE_COLOR[s]} label={STAGE_LABEL[s]} value={nf.format(d[s])} />
      ))}
      <p className="text-slate-500 mt-0.5">
        {money(d.value)} esperados{d.desdeAnuncio ? ` · ${nf.format(d.desdeAnuncio)} desde anuncios` : ''}
      </p>
    </TipBox>
  );
}

function TipAnuncio({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <TipBox title={d.titular}>
      <TipFila color={C_CHATS} label="Chats" value={nf.format(d.chats)} />
      <p className="text-slate-500 mt-0.5">anuncio {d.adId}</p>
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
