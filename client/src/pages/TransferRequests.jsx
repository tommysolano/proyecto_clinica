import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { HiOutlineArrowsRightLeft, HiOutlinePlus, HiOutlineTrash, HiOutlineInboxArrowDown } from 'react-icons/hi2';
import api from '../api/axios';
import Modal from '../components/Modal';
import Field from '../components/Field';
import NumericInput from '../components/NumericInput';
import ProductSelect from '../components/ProductSelect';
import DateInput from '../components/DateInput';

/**
 * SOLICITUDES DE TRASLADO (nov-2026).
 *  - Quien tiene un punto de emisión con bodega pide ítems PARA su bodega.
 *  - Administrador / contabilidad las atiende: escoge desde qué bodega salen (viendo el stock del
 *    sistema y lo contado en la toma física de cada una), ajusta cantidades y aprueba, lo que
 *    ejecuta el traslado; o la rechaza con un motivo.
 */
const fmt = (n) => Number(n || 0).toLocaleString('es-EC', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
const fecha = (d) => (d ? new Date(d).toLocaleString('es-EC', { timeZone: 'America/Guayaquil', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const fechaCorta = (d) => (d ? new Date(d).toLocaleDateString('es-EC', { timeZone: 'America/Guayaquil', day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
const nuevaLinea = () => ({ key: `l${Math.random().toString(36).slice(2, 9)}`, product: '', quantity: '' });
const bodegaTxt = (w) => (w ? (w.code ? `${w.code} — ${w.name}` : w.name) : '—');

const ESTADO = {
  PENDIENTE: 'bg-amber-100 text-amber-800',
  APROBADA: 'bg-emerald-100 text-emerald-700',
  RECHAZADA: 'bg-rose-100 text-rose-700',
  CANCELADA: 'bg-slate-200 text-slate-600',
};

/** Ítems físicos que se pueden trasladar (no servicios, ilimitados, compuestos ni inhabilitados). */
const esTrasladable = (p) => !p.unlimited && !p.disabled && !p.isComposite && !['servicio', 'programa'].includes(p.category);

export default function TransferRequests() {
  const [ctx, setCtx] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filtro, setFiltro] = useState('PENDIENTE');
  const [products, setProducts] = useState([]);
  const [nueva, setNueva] = useState(false);
  const [atender, setAtender] = useState(null);

  const cargar = async () => {
    setLoading(true);
    try {
      const r = await api.get('/transfer-requests', { params: filtro ? { status: filtro } : {} });
      setItems(r.data || []);
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudieron cargar las solicitudes');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api.get('/transfer-requests/context').then((r) => setCtx(r.data)).catch(() => setCtx({ canManage: false, canRequest: false }));
    api.get('/products').then((r) => setProducts((r.data || []).filter(esTrasladable))).catch(() => {});
  }, []);
  useEffect(() => { cargar(); }, [filtro]); // eslint-disable-line react-hooks/exhaustive-deps

  const retirar = async (s) => {
    if (!window.confirm(`¿Retirar la solicitud ${s.code}?`)) return;
    try {
      await api.post(`/transfer-requests/${s._id}/cancel`);
      toast.success('Solicitud retirada');
      cargar();
    } catch (e) { toast.error(e.response?.data?.message || 'No se pudo retirar'); }
  };

  const filtroBtn = (id, label) => (
    <button
      type="button"
      onClick={() => setFiltro(id)}
      className={`px-4 py-2 rounded-lg text-sm font-medium cursor-pointer border-none transition-colors ${filtro === id ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500 hover:text-emerald-700 bg-transparent'}`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          <HiOutlineInboxArrowDown className="text-emerald-600" /> Solicitudes de traslado
        </h1>
        {ctx?.canRequest && (
          <button
            type="button"
            onClick={() => setNueva(true)}
            className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2 border-none cursor-pointer"
          >
            <HiOutlinePlus /> Nueva solicitud
          </button>
        )}
      </div>

      {ctx && !ctx.canRequest && !ctx.canManage && (
        <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          {ctx.punto
            ? `Tu punto de emisión (${ctx.punto.serie}) no tiene una bodega asignada. Pide al administrador que se la asigne en Configuración SRI → Puntos de emisión.`
            : 'No tienes un punto de emisión asignado, así que no puedes pedir traslados.'}
        </div>
      )}
      {ctx?.canRequest && (
        <p className="text-sm text-slate-600">
          Tus solicitudes llegan a la bodega <b>{bodegaTxt(ctx.bodega)}</b> de tu punto {ctx.punto?.serie}. Un administrador decide desde qué bodega salen.
        </p>
      )}

      <div className="flex gap-1 bg-emerald-50 rounded-xl p-1 w-fit flex-wrap">
        {filtroBtn('PENDIENTE', 'Pendientes')}
        {filtroBtn('APROBADA', 'Aprobadas')}
        {filtroBtn('RECHAZADA', 'Rechazadas')}
        {filtroBtn('', 'Todas')}
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Cargando…</p>
      ) : items.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 px-4 py-8 text-center text-sm text-slate-500">
          No hay solicitudes {filtro ? `${filtro.toLowerCase()}s` : ''}.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((s) => (
            <div key={s._id} className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-slate-200 p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-semibold text-slate-800">{s.code}</span>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${ESTADO[s.status]}`}>{s.status}</span>
                    <span className="text-xs text-slate-400">{fecha(s.createdAt)}</span>
                  </div>
                  <p className="text-sm text-slate-600 mt-1">
                    {s.requestedBy?.name || '—'}
                    {s.puntoEmision && <span className="text-slate-400"> · punto {s.puntoEmision.establecimiento}-{s.puntoEmision.codigo}</span>}
                    {' · '}para <b>{bodegaTxt(s.toWarehouse)}</b>
                    {s.fromWarehouse && <> · desde <b>{bodegaTxt(s.fromWarehouse)}</b></>}
                  </p>
                  {s.notes && <p className="text-xs text-slate-500 mt-1 italic">«{s.notes}»</p>}
                </div>
                <div className="flex gap-2">
                  {ctx?.canManage && s.status === 'PENDIENTE' && (
                    <button
                      type="button"
                      onClick={() => setAtender(s)}
                      className="px-3 py-1.5 bg-sky-600 text-white rounded-lg text-sm flex items-center gap-1.5 border-none cursor-pointer"
                    >
                      <HiOutlineArrowsRightLeft className="w-4 h-4" /> Atender
                    </button>
                  )}
                  {s.status === 'PENDIENTE' && String(s.requestedBy?._id) === String(ctx?.userId) && (
                    <button
                      type="button"
                      onClick={() => retirar(s)}
                      className="px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg text-sm border-none cursor-pointer"
                    >
                      Retirar
                    </button>
                  )}
                </div>
              </div>
              <ul className="mt-3 divide-y divide-slate-100 text-sm">
                {s.items.map((it) => (
                  <li key={String(it.product)} className="py-1.5 flex justify-between gap-3">
                    <span className="text-slate-700 min-w-0 truncate">{it.productName || '—'}{it.productCode ? <span className="text-slate-400"> · {it.productCode}</span> : null}</span>
                    <span className="whitespace-nowrap text-slate-600">
                      Pedido <b>{fmt(it.quantity)}</b>
                      {it.approvedQty != null && <> · trasladado <b className={it.approvedQty < it.quantity ? 'text-amber-700' : 'text-emerald-700'}>{fmt(it.approvedQty)}</b></>}
                      {it.fromWarehouse && <span className="text-sky-700"> · desde {bodegaTxt(it.fromWarehouse)}</span>}
                    </span>
                  </li>
                ))}
              </ul>
              {s.status !== 'PENDIENTE' && (s.resolvedBy || s.resolutionNote) && (
                <p className="text-xs text-slate-500 mt-2">
                  {s.status === 'CANCELADA' ? 'Retirada' : s.status === 'APROBADA' ? 'Aprobada' : 'Rechazada'}
                  {s.resolvedBy?.name ? ` por ${s.resolvedBy.name}` : ''} {fecha(s.resolvedAt)}
                  {s.resolutionNote && <> — {s.resolutionNote}</>}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <NuevaSolicitudModal
        isOpen={nueva}
        onClose={() => setNueva(false)}
        bodega={ctx?.bodega}
        products={products}
        onDone={() => { setFiltro('PENDIENTE'); cargar(); }}
      />
      <AtenderModal
        solicitud={atender}
        onClose={() => setAtender(null)}
        onDone={() => cargar()}
      />
    </div>
  );
}

/** Pedir ítems para la bodega del punto. */
function NuevaSolicitudModal({ isOpen, onClose, bodega, products, onDone }) {
  const [lines, setLines] = useState([nuevaLinea()]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (isOpen) { setLines([nuevaLinea()]); setNotes(''); } }, [isOpen]);

  const setLinea = (key, campo, valor) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, [campo]: valor } : l)));
  const llenas = lines.filter((l) => l.product && Number(l.quantity) > 0);

  const enviar = async (e) => {
    e.preventDefault();
    if (!llenas.length) return toast.error('Agrega al menos un producto con cantidad');
    const repetido = llenas.map((l) => String(l.product)).find((p, i, arr) => arr.indexOf(p) !== i);
    if (repetido) return toast.error('Hay un producto repetido: júntalo en una sola línea');
    setSaving(true);
    try {
      const r = await api.post('/transfer-requests', {
        items: llenas.map((l) => ({ product: l.product, quantity: Number(l.quantity) })),
        notes,
      });
      toast.success(`Solicitud ${r.data?.code || ''} enviada`);
      onDone?.();
      onClose?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo enviar la solicitud');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Nueva solicitud de traslado" size="lg">
      <form onSubmit={enviar} className="space-y-4">
        <p className="text-sm text-slate-600">Destino: <b>{bodegaTxt(bodega)}</b> (la bodega de tu punto de emisión).</p>
        <div className="border border-slate-200 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-b border-slate-200">
            <span className="text-sm font-semibold text-slate-700">Productos que necesitas</span>
            <button
              type="button"
              onClick={() => setLines((ls) => [...ls, nuevaLinea()])}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg cursor-pointer"
            >
              <HiOutlinePlus className="w-3.5 h-3.5" /> Agregar producto
            </button>
          </div>
          <div className="divide-y divide-slate-100">
            {lines.map((l) => (
              <div key={l.key} className="p-3 grid grid-cols-12 gap-2 items-start">
                <div className="col-span-12 sm:col-span-7">
                  <ProductSelect products={products} value={l.product} onChange={(v) => setLinea(l.key, 'product', v)} placeholder="Buscar producto…" />
                </div>
                <div className="col-span-9 sm:col-span-4">
                  <NumericInput
                    min="0.0001" step="any" placeholder="Cantidad"
                    value={l.quantity}
                    onChange={(e) => setLinea(l.key, 'quantity', e.target.value)}
                    className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-right"
                  />
                </div>
                <div className="col-span-3 sm:col-span-1 flex justify-end pt-1">
                  <button
                    type="button"
                    onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : ls))}
                    disabled={lines.length === 1}
                    title="Quitar esta línea"
                    className="p-2 text-slate-400 hover:text-rose-600 disabled:opacity-30 disabled:cursor-not-allowed bg-transparent border-none cursor-pointer"
                  >
                    <HiOutlineTrash className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
        <Field label="Nota">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} placeholder="Opcional (ej. para las muestras de mañana)" className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
        </Field>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 bg-slate-200 rounded-xl cursor-pointer border-none">Cancelar</button>
          <button disabled={saving || !llenas.length} className="px-4 py-2 bg-emerald-600 text-white rounded-xl disabled:opacity-50 cursor-pointer border-none">
            {saving ? 'Enviando…' : 'Enviar solicitud'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Atender: escoger la bodega de ORIGEN viendo, por cada ítem, cuánto hay en cada bodega (sistema)
 * y lo último contado en la toma física; ajustar cantidades; aprobar (traslada) o rechazar.
 * Además de la bodega principal, cada ítem puede salir de OTRA bodega (nov-2026): un ítem que no
 * está en la principal pero sí en otra. Se hace un traslado por bodega de origen.
 */
function AtenderModal({ solicitud, onClose, onDone }) {
  const [warehouses, setWarehouses] = useState([]);
  const [stock, setStock] = useState([]);
  const [fisico, setFisico] = useState([]);
  const [origen, setOrigen] = useState('');
  // Bodega propia de cada ítem ('' = la principal).
  const [origenItem, setOrigenItem] = useState({});
  const [cant, setCant] = useState({});
  const [date, setDate] = useState(hoy());
  const [note, setNote] = useState('');
  const [rechazando, setRechazando] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!solicitud) return;
    setOrigen('');
    setOrigenItem({});
    setDate(hoy());
    setNote('');
    setRechazando(false);
    setCant(Object.fromEntries(solicitud.items.map((it) => [String(it.product), String(it.quantity)])));
    api.get('/inventory-advanced/warehouses', { params: { active: true } }).then((r) => setWarehouses(r.data || [])).catch(() => setWarehouses([]));
    api.get('/inventory-advanced/warehouse-stock').then((r) => setStock(r.data || [])).catch(() => setStock([]));
    api.get('/inventory-advanced/physical-stock').then((r) => setFisico(r.data || [])).catch(() => setFisico([]));
  }, [solicitud]);

  const destinoId = String(solicitud?.toWarehouse?._id || solicitud?.toWarehouse || '');
  const origenes = useMemo(() => warehouses.filter((w) => String(w._id) !== destinoId), [warehouses, destinoId]);

  const sistema = (productId, whId) => {
    const fila = stock.find((s) => String(s.product?._id) === String(productId));
    return fila?.warehouses.find((w) => String(w.warehouse?._id) === String(whId))?.qty || 0;
  };
  const contado = (productId, whId) => fisico.find((f) => String(f.product) === String(productId) && String(f.warehouse) === String(whId)) || null;
  /** Bodegas (distintas del destino) donde el sistema dice que hay, para orientar la elección. */
  const dondeHay = (productId) => origenes
    .map((w) => ({ w, qty: sistema(productId, w._id) }))
    .filter((x) => x.qty > 0);

  /** Bodega de la que sale el ítem: la suya si se escogió una, si no la principal. */
  const origenDe = (pid) => origenItem[pid] || origen;
  const nombreBodega = (whId) => bodegaTxt(origenes.find((w) => String(w._id) === String(whId)));

  if (!solicitud) return null;

  const aprobar = async () => {
    if (!origen) return toast.error('Escoge la bodega de origen');
    const lineas = solicitud.items.map((it) => {
      const pid = String(it.product);
      const linea = { product: pid, quantity: Number(cant[pid] || 0) };
      if (origenItem[pid] && origenItem[pid] !== origen) linea.fromWarehouse = origenItem[pid];
      return linea;
    });
    if (lineas.some((l) => !Number.isFinite(l.quantity) || l.quantity < 0)) return toast.error('Revisa las cantidades');
    if (!lineas.some((l) => l.quantity > 0)) return toast.error('Todas las cantidades están en cero: si no se va a atender, recházala');
    for (const l of lineas) {
      const desde = l.fromWarehouse || origen;
      const hay = sistema(l.product, desde);
      if (l.quantity > hay) {
        const nombre = solicitud.items.find((i) => String(i.product) === l.product)?.productName || 'un producto';
        return toast.error(`Solo hay ${fmt(hay)} de "${nombre}" en ${nombreBodega(desde)}`);
      }
    }
    setSaving(true);
    try {
      await api.post(`/transfer-requests/${solicitud._id}/approve`, { fromWarehouse: origen, items: lineas, date, note });
      toast.success(`Solicitud ${solicitud.code} aprobada y trasladada`);
      onDone?.();
      onClose?.();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo aprobar');
    } finally {
      setSaving(false);
    }
  };

  const rechazar = async () => {
    if (!note.trim()) return toast.error('Escribe el motivo del rechazo');
    setSaving(true);
    try {
      await api.post(`/transfer-requests/${solicitud._id}/reject`, { note });
      toast.success(`Solicitud ${solicitud.code} rechazada`);
      onDone?.();
      onClose?.();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo rechazar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={!!solicitud} onClose={onClose} title={`Atender solicitud ${solicitud.code}`} size="lg">
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          {solicitud.requestedBy?.name || '—'} pide para <b>{bodegaTxt(solicitud.toWarehouse)}</b>.
          {solicitud.notes && <span className="block text-xs italic text-slate-500 mt-0.5">«{solicitud.notes}»</span>}
        </p>

        <Field label="¿Desde qué bodega sale? (principal)" required>
          <select value={origen} onChange={(e) => setOrigen(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
            <option value="">Seleccione…</option>
            {origenes.map((w) => <option key={w._id} value={w._id}>{bodegaTxt(w)}</option>)}
          </select>
          {origen && <p className="text-[11px] text-slate-500 mt-1">Si un ítem no está en esta bodega, escoge en ese ítem otra bodega de la que salga.</p>}
        </Field>

        <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
          {solicitud.items.map((it) => {
            const pid = String(it.product);
            const desde = origenDe(pid);
            const propia = !!origenItem[pid] && origenItem[pid] !== origen;
            const hay = desde ? sistema(pid, desde) : null;
            const toma = desde ? contado(pid, desde) : null;
            const q = Number(cant[pid] || 0);
            const excede = hay != null && q > hay;
            const otras = dondeHay(pid);
            return (
              <div key={pid} className="p-3 grid grid-cols-12 gap-2 items-start">
                <div className="col-span-12 sm:col-span-8 text-sm">
                  <p className="font-medium text-slate-800">{it.productName}</p>
                  <p className="text-xs text-slate-500">Pedido: <b>{fmt(it.quantity)}</b></p>
                  {origen ? (
                    <div className="text-[11px] mt-0.5 space-y-0.5">
                      <div className="flex items-center gap-1.5 flex-wrap mt-1">
                        <span className="text-slate-500">Sale de:</span>
                        <select
                          value={origenItem[pid] || ''}
                          onChange={(e) => setOrigenItem((o) => ({ ...o, [pid]: e.target.value }))}
                          className={`border rounded-lg px-2 py-1 text-[11px] max-w-full ${propia ? 'border-sky-300 bg-sky-50 text-sky-800' : 'border-slate-200'}`}
                        >
                          <option value="">Bodega principal ({fmt(sistema(pid, origen))})</option>
                          {origenes.filter((w) => String(w._id) !== String(origen)).map((w) => (
                            <option key={w._id} value={w._id}>{bodegaTxt(w)} ({fmt(sistema(pid, w._id))})</option>
                          ))}
                        </select>
                      </div>
                      {/* No alcanza en la bodega escogida: atajo a las bodegas donde sí hay. */}
                      {hay < Number(it.quantity) && otras.some((x) => String(x.w._id) !== String(desde)) && (
                        <p className="text-slate-500">
                          Hay en:{' '}
                          {otras.filter((x) => String(x.w._id) !== String(desde)).map((x) => (
                            <button
                              key={x.w._id}
                              type="button"
                              onClick={() => setOrigenItem((o) => ({ ...o, [pid]: String(x.w._id) === String(origen) ? '' : String(x.w._id) }))}
                              className="mr-1.5 px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 border border-sky-200 cursor-pointer hover:bg-sky-100"
                            >
                              {x.w.code || x.w.name} · {fmt(x.qty)}
                            </button>
                          ))}
                        </p>
                      )}
                      <p className={hay > 0 ? 'text-slate-500' : 'text-rose-600'}>Sistema en {propia ? nombreBodega(desde) : 'origen'}: <b>{fmt(hay)}</b></p>
                      <p className="text-slate-500">
                        Toma física:{' '}
                        {toma
                          ? <><b>{fmt(toma.qty)}</b> <span className="text-slate-400">({toma.code} · {fechaCorta(toma.date)}{toma.status === 'BORRADOR' ? ' · sin confirmar' : ''})</span></>
                          : <span className="text-slate-400">sin contar en esta bodega</span>}
                      </p>
                    </div>
                  ) : (
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      {otras.length
                        ? <>Hay en: {otras.map((x) => `${x.w.name} ${fmt(x.qty)}`).join(' · ')}</>
                        : <span className="text-rose-600">Sin stock en ninguna otra bodega</span>}
                    </p>
                  )}
                </div>
                <div className="col-span-12 sm:col-span-4">
                  <NumericInput
                    min="0" step="any"
                    value={cant[pid] ?? ''}
                    onChange={(e) => setCant((c) => ({ ...c, [pid]: e.target.value }))}
                    className={`w-full border rounded-xl px-3.5 py-2.5 text-right ${excede ? 'border-rose-300 bg-rose-50' : 'border-slate-200'}`}
                  />
                  <p className="text-[11px] text-slate-400 mt-1">A trasladar (0 = no se envía)</p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Fecha del traslado">
            <DateInput value={date} onChange={(e) => setDate(e.target.value)} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
          </Field>
          <Field label={rechazando ? 'Motivo del rechazo' : 'Nota para quien pidió'} required={rechazando}>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={rechazando ? 'Obligatorio' : 'Opcional'} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" />
          </Field>
        </div>

        <div className="flex justify-between gap-2 flex-wrap">
          {rechazando ? (
            <button type="button" disabled={saving} onClick={rechazar} className="px-4 py-2 bg-rose-600 text-white rounded-xl disabled:opacity-50 cursor-pointer border-none">
              Confirmar rechazo
            </button>
          ) : (
            <button type="button" onClick={() => setRechazando(true)} className="px-4 py-2 bg-rose-50 text-rose-700 rounded-xl cursor-pointer border border-rose-200">
              Rechazar
            </button>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="px-4 py-2 bg-slate-200 rounded-xl cursor-pointer border-none">Cancelar</button>
            {!rechazando && (
              <button
                type="button"
                disabled={saving || !origen}
                onClick={aprobar}
                className="px-4 py-2 bg-sky-600 text-white rounded-xl disabled:opacity-50 inline-flex items-center gap-2 cursor-pointer border-none"
              >
                <HiOutlineArrowsRightLeft className="w-4 h-4" /> {saving ? 'Trasladando…' : 'Aprobar y trasladar'}
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
