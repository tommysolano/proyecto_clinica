import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import {
  HiOutlineBanknotes,
  HiOutlineArrowPath,
  HiOutlineExclamationTriangle,
  HiOutlineInformationCircle,
} from 'react-icons/hi2';
import { fmtDateTime, todayEc } from '../utils/date';

/**
 * Gasto de WhatsApp: lo que META NOS HA COBRADO por los mensajes de plantilla,
 * por día. Las cifras vienen del endpoint `pricing_analytics` de la WABA — no hay
 * ningún cálculo ni tarifa estimada de nuestro lado (ver server/utils/whatsappSpend.js).
 */

// Categorías de precio de Meta. El color va por CATEGORÍA (no por posición en el
// ranking): así el azul es siempre marketing aunque un día no haya gasto de otra.
// Paleta validada para daltonismo sobre fondo blanco (peor par adyacente ΔE 9.1);
// las cifras exactas están además en la tabla de abajo.
const CATEGORIES = [
  { key: 'MARKETING', label: 'Marketing', color: '#2a78d6' },
  { key: 'UTILITY', label: 'Utilidad', color: '#eb6834' },
  { key: 'AUTHENTICATION', label: 'Autenticación', color: '#1baf7a' },
  { key: 'SERVICE', label: 'Servicio', color: '#eda100' },
];
const CATEGORY_LABEL = CATEGORIES.reduce((a, c) => ({ ...a, [c.key]: c.label }), {});

const dayMs = 24 * 60 * 60 * 1000;
const shiftDays = (ymd, days) =>
  new Date(Date.parse(`${ymd}T12:00:00Z`) + days * dayMs).toISOString().slice(0, 10);
const ddmm = (ymd) => `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;

/** Presets del rango (en días de Ecuador, que es como cuenta el servidor). */
function rangePresets() {
  const today = todayEc();
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  const lastMonthEnd = shiftDays(firstOfMonth, -1);
  return [
    { key: 'today', label: 'Hoy', from: today, to: today },
    { key: '7d', label: '7 días', from: shiftDays(today, -6), to: today },
    { key: '30d', label: '30 días', from: shiftDays(today, -29), to: today },
    { key: 'month', label: 'Este mes', from: firstOfMonth, to: today },
    { key: 'lastMonth', label: 'Mes pasado', from: `${lastMonthEnd.slice(0, 7)}-01`, to: lastMonthEnd },
  ];
}

export default function WhatsappSpend() {
  const presets = useMemo(rangePresets, []);
  const [range, setRange] = useState(() => {
    const p = rangePresets()[2]; // 30 días
    return { from: p.from, to: p.to };
  });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const money = (n) =>
    `${data?.currency === 'USD' || !data?.currency ? '$' : ''}${Number(n || 0).toLocaleString('es-EC', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}${data?.currency && data.currency !== 'USD' ? ` ${data.currency}` : ''}`;

  const load = async (r = range) => {
    setLoading(true);
    try {
      const { data: d } = await api.get('/whatsapp-spend', { params: { from: r.from, to: r.to } });
      setData(d);
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo consultar el gasto');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, range.to]);

  // Vuelve a pedirle a Meta TODO el rango (los días viejos no se re-piden solos).
  const syncFromMeta = async () => {
    setSyncing(true);
    try {
      const { data: r } = await api.post('/whatsapp-spend/sync', null, {
        params: { from: range.from, to: range.to },
      });
      toast.success(
        r.hasCost
          ? 'Gasto actualizado desde Meta'
          : 'Meta respondió, pero no informó importes en este rango'
      );
      await load(range);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Meta no devolvió el gasto');
    } finally {
      setSyncing(false);
    }
  };

  const activePreset = presets.find((p) => p.from === range.from && p.to === range.to)?.key || '';

  // Solo las categorías con datos entran al gráfico y a la leyenda: una serie
  // siempre en cero solo añade ruido.
  const usedCategories = useMemo(() => {
    if (!data) return [];
    return CATEGORIES.filter((c) => (data.byCategory || []).some((b) => b.category === c.key));
  }, [data]);

  const chartData = useMemo(
    () =>
      (data?.days || []).map((d) => ({
        date: d.date,
        label: ddmm(d.date),
        total: d.cost,
        ...CATEGORIES.reduce(
          (acc, c) => ({ ...acc, [c.key]: Number(d.byCategory?.[c.key]?.cost || 0) }),
          {}
        ),
      })),
    [data]
  );

  const hasSpend = (data?.totals?.cost || 0) > 0 || (data?.totals?.billedMessages || 0) > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <HiOutlineBanknotes className="text-emerald-600" /> Gasto de WhatsApp
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Lo que Meta nos ha cobrado por los mensajes de plantilla. Las cifras las informa Meta
            {data?.lastFetchedAt ? ` · actualizado ${fmtDateTime(data.lastFetchedAt)}` : ''}.
          </p>
        </div>
        <button
          onClick={syncFromMeta}
          disabled={syncing}
          className="px-3 py-2 border border-slate-200 rounded-xl text-sm flex items-center gap-1.5 bg-white cursor-pointer hover:bg-slate-50 disabled:opacity-50"
        >
          <HiOutlineArrowPath className={syncing ? 'animate-spin' : ''} /> Actualizar desde Meta
        </button>
      </div>

      {/* Filtros del rango, en una sola fila sobre los datos */}
      <div className="bg-white rounded-xl border border-slate-200 p-3 flex flex-wrap items-center gap-2">
        {presets.map((p) => (
          <button
            key={p.key}
            onClick={() => setRange({ from: p.from, to: p.to })}
            className={`px-3 py-1.5 rounded-lg text-sm border cursor-pointer ${
              activePreset === p.key
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200 font-semibold'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {p.label}
          </button>
        ))}
        <span className="w-px h-6 bg-slate-200 mx-1" />
        <label className="text-xs text-slate-500 flex items-center gap-1.5">
          Desde
          <input
            type="date"
            value={range.from}
            max={range.to}
            onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))}
            className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm text-slate-700"
          />
        </label>
        <label className="text-xs text-slate-500 flex items-center gap-1.5">
          Hasta
          <input
            type="date"
            value={range.to}
            min={range.from}
            max={todayEc()}
            onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))}
            className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm text-slate-700"
          />
        </label>
      </div>

      {/* Avisos: qué falta configurar, o por qué una cifra puede no estar completa */}
      {data && !data.configured && (
        <Notice tone="warning">{data.notConfigured}</Notice>
      )}
      {data?.syncError && (
        <Notice tone="warning">
          No se pudo actualizar con Meta: {data.syncError}. Se muestra lo último que sí llegó.
        </Notice>
      )}
      {data?.totals?.messagesWithoutCost > 0 && (
        <Notice tone="info">
          Meta contó <b>{data.totals.messagesWithoutCost}</b> mensaje(s) cobrables sin informar el
          importe. Suele pasar cuando la cuenta se factura a través de un socio de Meta: en ese caso
          el importe real lo tiene tu factura del socio, no la API.
        </Notice>
      )}

      {/* Cifras principales */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi
          label="Cobrado por Meta"
          value={loading ? '…' : money(data?.totals?.cost)}
          hint={range.from === range.to ? ddmm(range.from) : `${ddmm(range.from)} – ${ddmm(range.to)}`}
          strong
        />
        <Kpi
          label="Mensajes cobrados"
          value={loading ? '…' : (data?.totals?.billedMessages || 0).toLocaleString('es-EC')}
        />
        <Kpi
          label="Costo por mensaje"
          value={loading ? '…' : money(data?.totals?.avgPerMessage)}
          hint="Promedio del rango"
        />
        <Kpi
          label="Mensajes gratis"
          value={loading ? '…' : (data?.totals?.freeMessages || 0).toLocaleString('es-EC')}
          hint="Ventana de atención / punto de entrada"
        />
      </div>

      {/* Gasto por día */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <p className="text-sm font-semibold text-slate-700 mb-3">Gasto por día</p>
        {loading ? (
          <p className="text-sm text-slate-400 py-12 text-center">Cargando…</p>
        ) : !hasSpend ? (
          <p className="text-sm text-slate-400 py-12 text-center">
            Meta no ha informado gasto en este rango.
          </p>
        ) : (
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#f1f5f9" />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  minTickGap={8}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={64}
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  tickFormatter={(v) => money(v)}
                />
                <Tooltip
                  cursor={{ fill: '#f8fafc' }}
                  content={<SpendTooltip money={money} categories={usedCategories} />}
                />
                {usedCategories.length > 1 && (
                  <Legend
                    verticalAlign="top"
                    align="right"
                    height={28}
                    iconType="circle"
                    iconSize={8}
                    formatter={(key) => (
                      <span className="text-xs text-slate-600">{CATEGORY_LABEL[key] || key}</span>
                    )}
                  />
                )}
                {usedCategories.map((c, i) => (
                  <Bar
                    key={c.key}
                    dataKey={c.key}
                    stackId="spend"
                    fill={c.color}
                    // Hueco de 2px del color del fondo entre segmentos apilados y
                    // entre barras vecinas: sin él las categorías se leen como una
                    // sola masa de color.
                    stroke="#ffffff"
                    strokeWidth={2}
                    maxBarSize={38}
                    radius={i === usedCategories.length - 1 ? [4, 4, 0, 0] : 0}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-4 items-start">
        {/* Por categoría */}
        <Panel title="Por categoría de Meta">
          <table className="tbl">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">Categoría</th>
                <th className="text-right px-3 py-2">Mensajes</th>
                <th className="text-right px-3 py-2">Cobrado</th>
              </tr>
            </thead>
            <tbody>
              {(data?.byCategory || []).length === 0 && (
                <tr><td colSpan={3} className="text-center py-6 text-slate-400">Sin datos.</td></tr>
              )}
              {(data?.byCategory || []).map((c) => (
                <tr key={c.category} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ background: CATEGORIES.find((x) => x.key === c.category)?.color || '#94a3b8' }}
                      />
                      <span className="text-slate-700">{CATEGORY_LABEL[c.category] || c.category}</span>
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right text-slate-600">{c.volume.toLocaleString('es-EC')}</td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-800">{money(c.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        {/* Qué plantillas generaron esos envíos (dato nuestro; Meta no lo desglosa) */}
        <Panel
          title="Mensajes por plantilla"
          hint="Enviados por el sistema en el rango. Meta no desglosa el importe por plantilla, así que aquí van los mensajes, no el dinero."
        >
          <table className="tbl">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">Plantilla</th>
                <th className="text-left px-3 py-2">Categoría cobrada</th>
                <th className="text-right px-3 py-2">Enviados</th>
                <th className="text-right px-3 py-2">Cobrables</th>
              </tr>
            </thead>
            <tbody>
              {(data?.byTemplate || []).length === 0 && (
                <tr><td colSpan={4} className="text-center py-6 text-slate-400">Sin envíos de plantilla.</td></tr>
              )}
              {(data?.byTemplate || []).map((t) => (
                <tr key={`${t.template}-${t.category}`} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-mono text-xs text-slate-700">{t.template}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {t.category ? CATEGORY_LABEL[t.category.toUpperCase()] || t.category : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-600">{t.messages}</td>
                  <td className="px-3 py-2 text-right text-slate-600">{t.billed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      {/* Detalle por día: es también la vista en tabla de las cifras del gráfico */}
      <Panel title="Detalle por día">
        <div className="overflow-x-auto">
          <table className="tbl min-w-[560px]">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">Día</th>
                {usedCategories.map((c) => (
                  <th key={c.key} className="text-right px-3 py-2 whitespace-nowrap">{c.label}</th>
                ))}
                <th className="text-right px-3 py-2">Mensajes</th>
                <th className="text-right px-3 py-2">Gratis</th>
                <th className="text-right px-3 py-2">Total</th>
              </tr>
            </thead>
            <tbody>
              {(data?.days || []).filter((d) => d.cost > 0 || d.volume > 0 || d.freeVolume > 0).length === 0 && (
                <tr>
                  <td colSpan={usedCategories.length + 4} className="text-center py-6 text-slate-400">
                    Sin gasto informado en el rango.
                  </td>
                </tr>
              )}
              {(data?.days || [])
                .filter((d) => d.cost > 0 || d.volume > 0 || d.freeVolume > 0)
                .map((d) => (
                  <tr key={d.date} className="border-t border-slate-100 hover:bg-slate-50/50">
                    <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{d.date}</td>
                    {usedCategories.map((c) => (
                      <td key={c.key} className="px-3 py-2 text-right text-slate-600">
                        {money(d.byCategory?.[c.key]?.cost || 0)}
                      </td>
                    ))}
                    <td className="px-3 py-2 text-right text-slate-600">{d.volume}</td>
                    <td className="px-3 py-2 text-right text-slate-400">{d.freeVolume}</td>
                    <td className="px-3 py-2 text-right font-semibold text-slate-800">{money(d.cost)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function Kpi({ label, value, hint, strong }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 font-bold tracking-tight ${strong ? 'text-3xl text-emerald-700' : 'text-2xl text-slate-800'}`}>
        {value}
      </p>
      {hint && <p className="text-[11px] text-slate-400 mt-0.5">{hint}</p>}
    </div>
  );
}

function Panel({ title, hint, children }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100">
        <p className="text-sm font-semibold text-slate-700">{title}</p>
        {hint && <p className="text-[11px] text-slate-400 mt-0.5">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function Notice({ tone = 'info', children }) {
  const styles = tone === 'warning'
    ? 'bg-amber-50 border-amber-200 text-amber-800'
    : 'bg-sky-50 border-sky-200 text-sky-800';
  const Icon = tone === 'warning' ? HiOutlineExclamationTriangle : HiOutlineInformationCircle;
  return (
    <div className={`rounded-xl border px-3.5 py-2.5 text-sm flex gap-2.5 ${styles}`}>
      <Icon className="w-5 h-5 shrink-0 mt-0.5" />
      <p>{children}</p>
    </div>
  );
}

/** Tooltip del gráfico: importe por categoría + total del día. */
function SpendTooltip({ active, payload, label, money, categories }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-lg px-3 py-2 text-xs">
      <p className="font-semibold text-slate-800 mb-1">{row.date || label}</p>
      {categories.map((c) => (
        <p key={c.key} className="flex items-center gap-2 text-slate-600">
          <span className="w-2 h-2 rounded-full" style={{ background: c.color }} />
          <span className="flex-1">{c.label}</span>
          <b className="text-slate-800">{money(row[c.key] || 0)}</b>
        </p>
      ))}
      <p className="flex items-center gap-2 mt-1 pt-1 border-t border-slate-100 text-slate-600">
        <span className="flex-1">Total</span>
        <b className="text-slate-900">{money(row.total || 0)}</b>
      </p>
    </div>
  );
}
