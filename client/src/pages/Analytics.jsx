import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/axios';
import toast from 'react-hot-toast';
import {
  HiOutlinePresentationChartLine,
  HiOutlineCog6Tooth,
  HiOutlinePlus,
  HiOutlineTrash,
  HiOutlinePencilSquare,
  HiOutlineMegaphone,
  HiOutlineChevronDown,
  HiOutlineChevronRight,
  HiOutlineArrowTopRightOnSquare,
} from 'react-icons/hi2';
import DateInput from '../components/DateInput';
import Modal from '../components/Modal';
import ServiceItemPicker from '../components/ServiceItemPicker';
import { fmtDate, todayEc } from '../utils/date';

/**
 * ANALÍTICAS DEL CRM POR PROGRAMA DE PUBLICIDAD (oct-2026).
 *
 * Reemplaza la página anterior del embudo. Dos pestañas, como Comisiones:
 *   · PROGRAMAS: se definen los programas (los escribe el usuario, no salen del
 *     inventario), lo que se gasta en publicidad cada mes, los anuncios que los
 *     promocionan —escogidos en bloque desde las automatizaciones— y los
 *     servicios del inventario que se agendan para ellos.
 *   · RESULTADOS: las citas creadas desde el chat por programa, cómo terminaron
 *     y cuánto dejaron. Las cuentas las hace el servidor (/ad-programs/analytics).
 */

const money = (v) => `$${Number(v || 0).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(0)}%`);
const MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const nombreMes = (ym) => {
  const [y, m] = String(ym || '').split('-');
  return y && m ? `${MESES[Number(m) - 1] || m} ${y}` : ym;
};
const ESTADO = {
  efectivas: { label: 'Efectiva', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  canceladas: { label: 'Cancelada', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  noAsistio: { label: 'No asistió', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  pendientes: { label: 'Pendiente', cls: 'bg-slate-50 text-slate-600 border-slate-200' },
};

export default function Analytics() {
  const [tab, setTab] = useState('resultados');
  const [programas, setProgramas] = useState([]);
  const [cargandoProgramas, setCargandoProgramas] = useState(true);

  const cargarProgramas = async () => {
    setCargandoProgramas(true);
    try {
      const { data } = await api.get('/ad-programs');
      setProgramas(data || []);
      return data || [];
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudieron cargar los programas');
      return [];
    } finally {
      setCargandoProgramas(false);
    }
  };

  useEffect(() => {
    // Sin programas todavía, se empieza por configurarlos: los resultados
    // saldrían vacíos.
    cargarProgramas().then((lista) => { if (!lista.length) setTab('programas'); });
  }, []);

  const botonTab = (id, Icon, label) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm cursor-pointer border-none ${
        tab === id ? 'bg-white text-emerald-700 font-semibold shadow-sm' : 'text-slate-500 hover:text-slate-700'
      }`}
    >
      <Icon className="w-4 h-4" /> {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <HiOutlinePresentationChartLine className="text-emerald-600 shrink-0" /> Analíticas
          </h1>
          <p className="text-sm text-slate-500">
            Lo que se gasta en publicidad por programa y las citas que salen del chat.
          </p>
        </div>
        <div className="flex gap-1 bg-slate-100 rounded-xl p-1">
          {botonTab('resultados', HiOutlinePresentationChartLine, 'Resultados')}
          {botonTab('programas', HiOutlineCog6Tooth, 'Programas')}
        </div>
      </div>

      {tab === 'programas' ? (
        <PestanaProgramas programas={programas} cargando={cargandoProgramas} onCambio={cargarProgramas} />
      ) : (
        <PestanaResultados hayProgramas={programas.length > 0} irAProgramas={() => setTab('programas')} />
      )}
    </div>
  );
}

// ─── Pestaña PROGRAMAS ──────────────────────────────────────────────────────

function PestanaProgramas({ programas, cargando, onCambio }) {
  const [editando, setEditando] = useState(null); // programa | {} (nuevo) | null
  const mesActual = todayEc().slice(0, 7);

  const eliminar = async (p) => {
    if (!confirm(`¿Eliminar el programa «${p.name}»? Sus citas dejarán de contarse para él.`)) return;
    try {
      await api.delete(`/ad-programs/${p._id}`);
      toast.success('Programa eliminado');
      onCambio();
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo eliminar');
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500 m-0">
          Cada programa reúne su <b>gasto en publicidad</b>, sus <b>anuncios</b> y sus <b>servicios</b>.
        </p>
        <button
          type="button"
          onClick={() => setEditando({})}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white rounded-xl text-sm font-medium border-none cursor-pointer hover:bg-emerald-700"
        >
          <HiOutlinePlus className="w-4 h-4" /> Nuevo programa
        </button>
      </div>

      {cargando && <p className="text-sm text-slate-400">Cargando…</p>}
      {!cargando && !programas.length && (
        <div className="bg-white border border-dashed border-slate-300 rounded-xl p-6 text-center text-sm text-slate-500">
          Todavía no hay programas. Crea el primero: escribe su nombre, cuánto gastas en publicidad,
          escoge sus anuncios desde las automatizaciones y añade sus servicios.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {programas.map((p) => {
          const gastoMes = (p.gastos || []).filter((g) => g.mes === mesActual).reduce((s, g) => s + (g.monto || 0), 0);
          return (
            <div key={p._id} className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <h3 className="m-0 text-base font-semibold text-slate-800 break-words">{p.name}</h3>
                <div className="flex gap-1 shrink-0">
                  <button type="button" title="Editar" onClick={() => setEditando(p)}
                    className="p-1.5 rounded-lg text-slate-500 hover:text-emerald-700 hover:bg-emerald-50 bg-transparent border-none cursor-pointer">
                    <HiOutlinePencilSquare className="w-4 h-4" />
                  </button>
                  <button type="button" title="Eliminar" onClick={() => eliminar(p)}
                    className="p-1.5 rounded-lg text-slate-500 hover:text-rose-600 hover:bg-rose-50 bg-transparent border-none cursor-pointer">
                    <HiOutlineTrash className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="text-sm text-slate-600">
                Gasto de {nombreMes(mesActual).toLowerCase()}: <b className="text-slate-800">{money(gastoMes)}</b>
              </div>
              <div className="flex flex-wrap gap-1.5 text-[11px]">
                <span className="px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-100">
                  {(p.anuncios || []).length} anuncio(s)
                </span>
                <span className="px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-100">
                  {(p.servicios || []).length} servicio(s)
                </span>
                {(p.servicios || []).some((s) => s.generaIngresos === false) && (
                  <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
                    {(p.servicios || []).filter((s) => s.generaIngresos === false).length} sin ingresos
                  </span>
                )}
              </div>
              {(p.servicios || []).length > 0 && (
                <p className="m-0 text-xs text-slate-500 break-words">
                  {(p.servicios || []).map((s) => s.name).join(' · ')}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {editando && (
        <EditorPrograma
          programa={editando}
          otros={programas.filter((p) => String(p._id) !== String(editando._id || ''))}
          onClose={() => setEditando(null)}
          onGuardado={() => { setEditando(null); onCambio(); }}
        />
      )}
    </div>
  );
}

function EditorPrograma({ programa, otros, onClose, onGuardado }) {
  const hoy = todayEc();
  const [name, setName] = useState(programa.name || '');
  const [gastos, setGastos] = useState((programa.gastos || []).map((g) => ({ ...g })));
  const [anuncios, setAnuncios] = useState((programa.anuncios || []).map((a) => ({ ...a })));
  const [servicios, setServicios] = useState((programa.servicios || []).map((s) => ({ ...s })));
  const [fuentes, setFuentes] = useState(null);
  const [idManual, setIdManual] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [nuevoMes, setNuevoMes] = useState(Number(hoy.slice(5, 7)));
  const [nuevoAnio, setNuevoAnio] = useState(Number(hoy.slice(0, 4)));
  const [nuevoMonto, setNuevoMonto] = useState('');

  useEffect(() => {
    api.get('/ad-programs/ad-sources')
      .then(({ data }) => setFuentes(data || []))
      .catch(() => setFuentes([]));
  }, []);

  /** Anuncio → programa que ya lo tiene (no puede estar en dos). */
  const deOtro = useMemo(() => {
    const m = new Map();
    otros.forEach((p) => (p.anuncios || []).forEach((a) => m.set(a.adId, p.name)));
    return m;
  }, [otros]);
  const mios = new Set(anuncios.map((a) => a.adId));

  const anadirIds = (ids, wf = null) => {
    const libres = ids.filter((id) => id && !mios.has(id) && !deOtro.has(id));
    const ocupados = ids.filter((id) => deOtro.has(id));
    if (ocupados.length) {
      toast(`${ocupados.length} anuncio(s) ya son de otro programa y no se añadieron.`, { icon: '⚠️' });
    }
    if (!libres.length) return;
    setAnuncios((prev) => [
      ...prev,
      ...libres.map((adId) => ({ adId, workflow: wf?._id || null, workflowName: wf?.name || '' })),
    ]);
  };

  const anadirGasto = () => {
    const monto = Number(nuevoMonto);
    if (!Number.isFinite(monto) || monto < 0 || nuevoMonto === '') return toast.error('Escribe el monto del gasto.');
    const mes = `${nuevoAnio}-${String(nuevoMes).padStart(2, '0')}`;
    setGastos((prev) => {
      // Un gasto por mes: si ya estaba, se reemplaza.
      const resto = prev.filter((g) => g.mes !== mes);
      return [...resto, { mes, monto, nota: '' }].sort((a, b) => b.mes.localeCompare(a.mes));
    });
    setNuevoMonto('');
  };

  const guardar = async () => {
    if (!name.trim()) return toast.error('Escribe el nombre del programa.');
    setGuardando(true);
    try {
      const body = { name: name.trim(), gastos, anuncios, servicios };
      if (programa._id) await api.put(`/ad-programs/${programa._id}`, body);
      else await api.post('/ad-programs', body);
      toast.success('Programa guardado');
      onGuardado();
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo guardar');
    } finally {
      setGuardando(false);
    }
  };

  const anios = [Number(hoy.slice(0, 4)) - 1, Number(hoy.slice(0, 4)), Number(hoy.slice(0, 4)) + 1];
  const input = 'w-full border border-slate-200 rounded-xl px-3 py-2 text-sm';

  return (
    <Modal isOpen onClose={onClose} title={programa._id ? 'Editar programa' : 'Nuevo programa'} size="lg">
      <div className="space-y-5">
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Nombre del programa</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Detox, Mujer Sana 360…" className={`mt-1 ${input}`} />
        </label>

        {/* GASTO EN PUBLICIDAD, POR MES */}
        <section>
          <h4 className="m-0 mb-1 text-sm font-semibold text-slate-700">Gasto en publicidad</h4>
          <p className="m-0 mb-2 text-[11px] text-slate-500">Lo que se invierte en anuncios para este programa, mes a mes.</p>
          <div className="flex flex-wrap items-end gap-2">
            <select value={nuevoMes} onChange={(e) => setNuevoMes(Number(e.target.value))} className="border border-slate-200 rounded-xl px-2 py-2 text-sm">
              {MESES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
            <select value={nuevoAnio} onChange={(e) => setNuevoAnio(Number(e.target.value))} className="border border-slate-200 rounded-xl px-2 py-2 text-sm">
              {anios.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">$</span>
              <input
                type="number" min="0" step="0.01" value={nuevoMonto}
                onChange={(e) => setNuevoMonto(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); anadirGasto(); } }}
                placeholder="0.00" className="w-32 border border-slate-200 rounded-xl pl-6 pr-2 py-2 text-sm"
              />
            </div>
            <button type="button" onClick={anadirGasto}
              className="px-3 py-2 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-800 text-sm font-medium cursor-pointer">
              Añadir
            </button>
          </div>
          {gastos.length > 0 && (
            <ul className="mt-2 divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
              {gastos.map((g) => (
                <li key={g.mes} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm bg-white">
                  <span className="text-slate-700">{nombreMes(g.mes)}</span>
                  <span className="flex items-center gap-2">
                    <b className="text-slate-800">{money(g.monto)}</b>
                    <button type="button" title="Quitar" onClick={() => setGastos((prev) => prev.filter((x) => x.mes !== g.mes))}
                      className="p-1 text-slate-400 hover:text-rose-600 bg-transparent border-none cursor-pointer">
                      <HiOutlineTrash className="w-4 h-4" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ANUNCIOS, ESCOGIDOS DESDE LAS AUTOMATIZACIONES */}
        <section>
          <h4 className="m-0 mb-1 text-sm font-semibold text-slate-700">Anuncios del programa</h4>
          <p className="m-0 mb-2 text-[11px] text-slate-500">
            Son los ids que pusiste en el disparador «Anuncio» de cada automatización. Añade los de una
            automatización de una vez, o escribe un id suelto.
          </p>
          {fuentes === null ? (
            <p className="text-xs text-slate-400">Cargando automatizaciones…</p>
          ) : !fuentes.length ? (
            <p className="text-xs text-slate-400">Ninguna automatización tiene ids de anuncio.</p>
          ) : (
            <div className="grid gap-1.5 max-h-56 overflow-y-auto pr-1">
              {fuentes.map((f) => {
                const faltan = f.adIds.filter((id) => !mios.has(id) && !deOtro.has(id));
                const deOtroPrograma = f.adIds.filter((id) => deOtro.has(id));
                return (
                  <div key={f._id} className="flex flex-wrap items-center justify-between gap-2 border border-slate-200 rounded-lg px-3 py-2 bg-white">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-800 break-words">
                        {f.name}{!f.active && <span className="ml-1 text-[10px] text-slate-400">(inactiva)</span>}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {f.adIds.length} anuncio(s)
                        {deOtroPrograma.length > 0 && ` · ${deOtroPrograma.length} ya en otro programa`}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={!faltan.length}
                      onClick={() => anadirIds(f.adIds, f)}
                      className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border border-indigo-200 bg-indigo-50 text-indigo-800 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {faltan.length ? `Añadir ${faltan.length}` : 'Ya añadidos'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex gap-2 mt-2">
            <input
              value={idManual}
              onChange={(e) => setIdManual(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); anadirIds(idManual.split(',').map((s) => s.trim())); setIdManual(''); }
              }}
              placeholder="Id de anuncio (o varios separados por coma)"
              className={input}
            />
            <button type="button" onClick={() => { anadirIds(idManual.split(',').map((s) => s.trim())); setIdManual(''); }}
              className="shrink-0 px-3 py-2 rounded-xl border border-slate-200 bg-white text-sm cursor-pointer">
              Añadir
            </button>
          </div>
          {anuncios.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {anuncios.map((a) => (
                <span key={a.adId} title={a.workflowName ? `De «${a.workflowName}»` : 'Escrito a mano'}
                  className="inline-flex items-center gap-1 pl-2.5 pr-1 py-0.5 rounded-full bg-indigo-50 border border-indigo-100 text-indigo-800 text-xs">
                  <HiOutlineMegaphone className="w-3 h-3" /> {a.adId}
                  <button type="button" onClick={() => setAnuncios((prev) => prev.filter((x) => x.adId !== a.adId))}
                    className="p-0.5 leading-none text-indigo-600 hover:text-rose-600 bg-transparent border-none cursor-pointer">×</button>
                </span>
              ))}
            </div>
          )}
        </section>

        {/* SERVICIOS DEL INVENTARIO */}
        <section>
          <h4 className="m-0 mb-1 text-sm font-semibold text-slate-700">Servicios del programa</h4>
          <p className="m-0 mb-2 text-[11px] text-slate-500">
            Los servicios del inventario que se agendan para este programa. Desmarca «Genera ingresos» en los que
            no se cobran (una valoración gratuita, por ejemplo): la cita se cuenta, pero su valor no suma.
          </p>
          <ServiceItemPicker
            value={null}
            onChange={(s) => {
              if (!s) return;
              if (servicios.some((x) => String(x.serviceItem) === String(s._id))) return;
              setServicios((prev) => [...prev, { serviceItem: s._id, name: s.name, generaIngresos: true }]);
            }}
            placeholder="+ Añadir un servicio del inventario…"
          />
          {servicios.length > 0 && (
            <ul className="mt-2 divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
              {servicios.map((s) => (
                <li key={String(s.serviceItem)} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm bg-white">
                  <span className="text-slate-800 break-words min-w-0">{s.name}</span>
                  <span className="flex items-center gap-3">
                    <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={s.generaIngresos !== false}
                        onChange={(e) => setServicios((prev) => prev.map((x) => (
                          String(x.serviceItem) === String(s.serviceItem) ? { ...x, generaIngresos: e.target.checked } : x
                        )))}
                        className="accent-emerald-600"
                      />
                      Genera ingresos
                    </label>
                    <button type="button" title="Quitar" onClick={() => setServicios((prev) => prev.filter((x) => String(x.serviceItem) !== String(s.serviceItem)))}
                      className="p-1 text-slate-400 hover:text-rose-600 bg-transparent border-none cursor-pointer">
                      <HiOutlineTrash className="w-4 h-4" />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm cursor-pointer">Cancelar</button>
          <button type="button" onClick={guardar} disabled={guardando}
            className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium border-none cursor-pointer disabled:opacity-50">
            {guardando ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Pestaña RESULTADOS ─────────────────────────────────────────────────────

function PestanaResultados({ hayProgramas, irAProgramas }) {
  const hoy = todayEc();
  const [desde, setDesde] = useState(`${hoy.slice(0, 7)}-01`);
  const [hasta, setHasta] = useState(hoy);
  const [por, setPor] = useState('creacion');
  // El resultado recuerda de qué consulta es: mientras no llegue el de la
  // consulta actual, se está calculando.
  const [resultado, setResultado] = useState({ clave: '', data: null });
  const [abierto, setAbierto] = useState(null);
  const clave = `${desde}|${hasta}|${por}`;
  const cargando = !!desde && !!hasta && resultado.clave !== clave;
  const data = resultado.data;

  useEffect(() => {
    if (!desde || !hasta) return undefined;
    let vivo = true;
    api.get('/ad-programs/analytics', { params: { from: desde, to: hasta, por } })
      .then(({ data: d }) => { if (vivo) setResultado({ clave: `${desde}|${hasta}|${por}`, data: d }); })
      .catch((err) => {
        if (!vivo) return;
        toast.error(err.response?.data?.message || 'No se pudieron calcular las analíticas');
        setResultado((r) => ({ ...r, clave: `${desde}|${hasta}|${por}` }));
      });
    return () => { vivo = false; };
  }, [desde, hasta, por]);

  const filas = useMemo(() => data?.programas || [], [data]);
  const total = useMemo(() => filas.reduce((t, p) => ({
    gasto: t.gasto + p.gasto,
    citas: t.citas + p.citas,
    efectivas: t.efectivas + p.efectivas,
    ingresos: t.ingresos + p.ingresos,
  }), { gasto: 0, citas: 0, efectivas: 0, ingresos: 0 }), [filas]);
  const roiTotal = total.gasto ? (total.ingresos - total.gasto) / total.gasto : null;

  if (!hayProgramas) {
    return (
      <div className="bg-white border border-dashed border-slate-300 rounded-xl p-6 text-center text-sm text-slate-500">
        Primero define tus programas en la pestaña{' '}
        <button type="button" onClick={irAProgramas} className="text-emerald-700 font-semibold underline bg-transparent border-none cursor-pointer p-0">Programas</button>.
      </div>
    );
  }

  const kpi = (label, valor, sub) => (
    <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-xl font-bold text-slate-800 mt-0.5">{valor}</div>
      {sub && <div className="text-[11px] text-slate-400 mt-0.5">{sub}</div>}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-slate-200 p-3 flex flex-wrap gap-3 items-end">
        <label className="text-sm">Desde<DateInput value={desde} onChange={(e) => setDesde(e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" /></label>
        <label className="text-sm">Hasta<DateInput value={hasta} onChange={(e) => setHasta(e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" /></label>
        <label className="text-sm">Contar por
          <select value={por} onChange={(e) => setPor(e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm">
            <option value="creacion">Fecha en que se agendó</option>
            <option value="cita">Fecha de la cita</option>
          </select>
        </label>
        {cargando && <span className="text-xs text-slate-400 pb-2">Calculando…</span>}
      </div>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        {kpi('Gasto en publicidad', money(total.gasto), 'de los meses del rango')}
        {kpi('Citas desde chat', total.citas, `${total.efectivas} efectivas`)}
        {kpi('Ingresos', money(total.ingresos), 'de citas efectivas')}
        {kpi('Retorno (ROI)', pct(roiTotal), total.gasto ? `costo por efectiva ${total.efectivas ? money(total.gasto / total.efectivas) : '—'}` : 'sin gasto registrado')}
      </div>

      <div className="tbl-wrap">
        <div className="tbl-scroll">
          <table className="tbl">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">Programa</th>
                <th className="text-right px-3 py-2">Gasto</th>
                <th className="text-right px-3 py-2">Citas</th>
                <th className="text-right px-3 py-2">Efectivas</th>
                <th className="text-right px-3 py-2">Canceladas</th>
                <th className="text-right px-3 py-2">No asistió</th>
                <th className="text-right px-3 py-2">Pendientes</th>
                <th className="text-right px-3 py-2">Canjes</th>
                <th className="text-right px-3 py-2">Ingresos</th>
                <th className="text-right px-3 py-2">Por agendar</th>
                <th className="text-right px-3 py-2">Costo / efectiva</th>
                <th className="text-right px-3 py-2">ROI</th>
              </tr>
            </thead>
            <tbody>
              {filas.map((p) => {
                const open = abierto === String(p._id);
                return (
                  <Fragment key={p._id}>
                    <tr
                      className="border-t border-slate-100 cursor-pointer hover:bg-slate-50"
                      onClick={() => setAbierto(open ? null : String(p._id))}
                    >
                      <td className="px-3 py-2 font-medium text-slate-800 whitespace-nowrap">
                        {open ? <HiOutlineChevronDown className="inline w-4 h-4 mr-1" /> : <HiOutlineChevronRight className="inline w-4 h-4 mr-1" />}
                        {p.name}
                      </td>
                      <td className="px-3 py-2 text-right">{money(p.gasto)}</td>
                      <td className="px-3 py-2 text-right font-semibold">{p.citas}</td>
                      <td className="px-3 py-2 text-right text-emerald-700">{p.efectivas}</td>
                      <td className="px-3 py-2 text-right text-rose-700">{p.canceladas}</td>
                      <td className="px-3 py-2 text-right text-amber-700">{p.noAsistio}</td>
                      <td className="px-3 py-2 text-right text-slate-500">{p.pendientes}</td>
                      <td className="px-3 py-2 text-right">{p.canjes}</td>
                      <td className="px-3 py-2 text-right font-semibold">{money(p.ingresos)}</td>
                      <td className="px-3 py-2 text-right text-slate-500" title="Valor de las citas que siguen en pie (pendientes + efectivas)">{money(p.valorAgendado)}</td>
                      <td className="px-3 py-2 text-right">{p.costoPorEfectiva === null ? '—' : money(p.costoPorEfectiva)}</td>
                      <td className={`px-3 py-2 text-right font-semibold ${p.roi === null ? '' : p.roi >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{pct(p.roi)}</td>
                    </tr>
                    {open && (
                      <tr className="bg-slate-50/60">
                        <td colSpan={12} className="px-3 py-3">
                          <DetalleCitas citas={p.citasDetalle || []} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {data?.sinPrograma?.citas > 0 && (
                <tr className="border-t border-slate-200 text-slate-500">
                  <td className="px-3 py-2 italic" title="Citas desde chat cuyo anuncio no está en ningún programa (o que no vinieron de un anuncio)">
                    Sin programa{data.sinPrograma.conAnuncio ? ` (${data.sinPrograma.conAnuncio} con anuncio sin asignar)` : ''}
                  </td>
                  <td className="px-3 py-2 text-right">—</td>
                  <td className="px-3 py-2 text-right">{data.sinPrograma.citas}</td>
                  <td className="px-3 py-2 text-right">{data.sinPrograma.efectivas}</td>
                  <td className="px-3 py-2 text-right">{data.sinPrograma.canceladas}</td>
                  <td className="px-3 py-2 text-right">{data.sinPrograma.noAsistio}</td>
                  <td className="px-3 py-2 text-right">{data.sinPrograma.pendientes}</td>
                  <td className="px-3 py-2 text-right">{data.sinPrograma.canjes}</td>
                  <td className="px-3 py-2 text-right">{money(data.sinPrograma.ingresos)}</td>
                  <td className="px-3 py-2 text-right">{money(data.sinPrograma.valorAgendado)}</td>
                  <td className="px-3 py-2 text-right">—</td>
                  <td className="px-3 py-2 text-right">—</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] text-slate-400 m-0">
        <b>Efectivas</b> = asistidas o completadas. <b>Ingresos</b> = valor asignado a las citas efectivas, sin canjes
        ni servicios marcados «no genera ingresos». Una cita es del programa por el <b>anuncio</b> del que vino su chat;
        si el chat no vino de un anuncio de ningún programa, por su <b>servicio</b> (cuando ese servicio es de un solo programa).
      </p>
    </div>
  );
}

function DetalleCitas({ citas }) {
  if (!citas.length) return <p className="m-0 text-sm text-slate-400">Sin citas en este rango.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-slate-500">
          <tr>
            <th className="text-left px-2 py-1">Paciente</th>
            <th className="text-left px-2 py-1">Agendada</th>
            <th className="text-left px-2 py-1">Cita</th>
            <th className="text-left px-2 py-1">Servicio</th>
            <th className="text-left px-2 py-1">Sucursal</th>
            <th className="text-left px-2 py-1">Estado</th>
            <th className="text-right px-2 py-1">Valor</th>
            <th className="text-left px-2 py-1">Por</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {citas.map((c) => (
            <tr key={c._id} className="border-t border-slate-200/70">
              <td className="px-2 py-1.5 text-slate-800">{c.paciente || c.contacto || '—'}</td>
              <td className="px-2 py-1.5 whitespace-nowrap">{fmtDate(c.creada)}</td>
              <td className="px-2 py-1.5 whitespace-nowrap">{fmtDate(c.fecha)} {c.hora}</td>
              <td className="px-2 py-1.5">
                {c.servicio || '—'}
                {!c.generaIngresos && <span className="ml-1 text-[10px] text-amber-700">(sin ingresos)</span>}
              </td>
              <td className="px-2 py-1.5">{c.sucursal}</td>
              <td className="px-2 py-1.5">
                <span className={`px-1.5 py-0.5 rounded border text-[10px] ${ESTADO[c.grupo]?.cls || ''}`}>
                  {ESTADO[c.grupo]?.label || c.estado}
                </span>
              </td>
              <td className="px-2 py-1.5 text-right whitespace-nowrap">
                {c.canje ? <span className="text-violet-700 font-medium">Canje</span>
                  : c.valor === null || c.valor === undefined ? <span className="text-slate-400">sin valor</span>
                  : money(c.valor)}
              </td>
              <td className="px-2 py-1.5 text-slate-500">{c.atribucion === 'anuncio' ? 'Anuncio' : 'Servicio'}</td>
              <td className="px-2 py-1.5">
                {c.conversation && (
                  <Link to={`/chats?chat=${c.conversation}`} target="_blank" rel="noopener" title="Abrir el chat"
                    className="text-emerald-700 hover:text-emerald-800">
                    <HiOutlineArrowTopRightOnSquare className="w-3.5 h-3.5" />
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
