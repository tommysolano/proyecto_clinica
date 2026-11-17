import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/axios';
import { downloadFile } from '../utils/download';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import PageHeader, { EmptyState } from '../components/PageHeader';
import ProductAutocomplete from '../components/ProductAutocomplete';
import { useAuth } from '../context/AuthContext';
import useDocDeepLink from '../hooks/useDocDeepLink';
import { fmtDate, fmtDateTime } from '../utils/date';
import {
  HiOutlineDocumentText,
  HiOutlineArrowPath,
  HiOutlineXMark,
  HiOutlineDocumentArrowDown,
  HiOutlineArrowDownTray,
  HiOutlineSignal,
  HiOutlineSignalSlash,
} from 'react-icons/hi2';
import DateInput from '../components/DateInput';
import Paginador from '../components/Paginador';

// Facturas por página (el servidor pagina; antes solo llegaban las 50 últimas).
const POR_PAGINA = 50;
const FILTRO_VACIO = { startDate: '', endDate: '', estado: '', puntoEmision: '', product: '', q: '' };

/**
 * Detalle completo de la factura en una PESTAÑA NUEVA (nov-2026): se abre con el número de
 * la factura (antes era un ojo que abría un modal sin lo vendido ni cómo se pagó).
 */
const urlDetalleFactura = (inv) => `/ventas/${inv?.sale?._id || inv?.sale || inv?._id}`;

const ESTADO_STYLES = {
  AUTORIZADO: 'bg-emerald-100 text-emerald-700',
  RECIBIDA: 'bg-blue-100 text-blue-700',
  EN_PROCESO: 'bg-amber-100 text-amber-700',
  EN_COLA: 'bg-slate-100 text-slate-600',
  DEVUELTA: 'bg-red-100 text-red-700',
  NO_AUTORIZADO: 'bg-red-100 text-red-700',
  ERROR: 'bg-red-100 text-red-700',
  ANULADA: 'bg-slate-300 text-slate-700',
};

// Etiquetas legibles para el contador (el enum interno es más técnico).
const ESTADO_LABEL = {
  AUTORIZADO: 'Autorizada',
  RECIBIDA: 'Recibida (pend. autorización)',
  EN_PROCESO: 'En proceso en el SRI',
  EN_COLA: 'Pendiente de envío (SRI)',
  DEVUELTA: 'Devuelta por el SRI',
  NO_AUTORIZADO: 'No autorizada',
  ERROR: 'Error de envío',
  ANULADA: 'Anulada',
};

// Estados no finales: la factura sigue en juego y puede reintentarse.
const PENDING_ESTADOS = ['EN_COLA', 'RECIBIDA', 'EN_PROCESO', 'ERROR', 'DEVUELTA', 'NO_AUTORIZADO'];

export default function Invoices({ onNewSale }) {
  const { hasRole } = useAuth();
  const navigate = useNavigate();
  // Productos/servicios para el filtro, también los inhabilitados: se siguen viendo sus
  // facturas pasadas (catálogo cacheado por api/axios).
  const [products, setProducts] = useState([]);
  useEffect(() => {
    api.get('/products', { params: { includeDisabled: true } }).then((r) => setProducts(Array.isArray(r.data) ? r.data : r.data?.products || [])).catch(() => {});
  }, []);
  const [descargandoZip, setDescargandoZip] = useState(false);
  const canRetry = hasRole('admin', 'cajero', 'contabilidad');
  const canAnular = hasRole('admin', 'contabilidad');

  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState(FILTRO_VACIO);
  // El buscador se escribe aquí y pasa al filtro con un respiro (no una petición por tecla).
  const [busqueda, setBusqueda] = useState('');
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState(null);
  const [sumTotal, setSumTotal] = useState(0);
  // Los filtros que viajan al servidor (lista y Excel).
  const paramsFiltro = () => Object.fromEntries(Object.entries(filter).filter(([, v]) => v));
  const hayFiltros = Object.values(filter).some(Boolean);
  // Puntos de emisión (cajas) para filtrar; solo admin/contabilidad los administran.
  const canVerPuntos = hasRole('admin', 'contabilidad');
  const [puntos, setPuntos] = useState([]);
  useEffect(() => {
    if (canVerPuntos) {
      api.get('/puntos-emision').then((r) => setPuntos(r.data?.puntos || [])).catch(() => {});
    } else {
      api.get('/puntos-emision/mio').then((r) => setPuntos(r.data?.punto ? [r.data.punto] : [])).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [anularTarget, setAnularTarget] = useState(null);
  const [motivo, setMotivo] = useState('');
  const [anularVenta, setAnularVenta] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [sriStatus, setSriStatus] = useState(null);
  const [retryingAll, setRetryingAll] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get('/invoices', { params: { ...paramsFiltro(), page, limit: POR_PAGINA } });
      setInvoices(res.data.invoices || []);
      setPagination(res.data.pagination || null);
      setSumTotal(res.data.sumTotal || 0);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar facturas');
    } finally {
      setLoading(false);
    }
  };

  const loadSriStatus = async () => {
    try {
      const res = await api.get('/invoices/sri-status');
      setSriStatus(res.data);
    } catch {
      setSriStatus({ disponible: false, pendientes: 0 });
    }
  };

  const reintentarPendientes = async () => {
    setRetryingAll(true);
    try {
      const res = await api.post('/invoices/retry-pending');
      toast.success(res.data?.message || 'Reintento procesado');
      load();
      loadSriStatus();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al reintentar pendientes');
    } finally {
      setRetryingAll(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, page]);

  // Cambiar un filtro vuelve a la primera página.
  const cambiarFiltro = (patch) => {
    setPage(1);
    setFilter((f) => ({ ...f, ...patch }));
  };
  useEffect(() => {
    const t = setTimeout(() => {
      if (busqueda.trim() !== filter.q) cambiarFiltro({ q: busqueda.trim() });
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busqueda]);
  const irAPagina = (n) => {
    setPage(n);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  useEffect(() => {
    loadSriStatus();
  }, []);

  const verPdf = async (inv) => {
    try {
      const res = await api.get(`/invoices/${inv._id}/pdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      window.open(url, '_blank');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al generar PDF');
    }
  };

  const reintentar = async (inv) => {
    setBusyId(inv._id);
    try {
      const res = await api.post(`/invoices/${inv._id}/retry`);
      const estado = res.data?.invoice?.estado;
      const msg = res.data?.message || 'Reintento procesado';
      if (estado === 'AUTORIZADO') toast.success(msg);
      else if (['DEVUELTA', 'NO_AUTORIZADO', 'ERROR'].includes(estado)) toast.error(msg);
      else toast(msg, { icon: '⏳', duration: 6000 });
      load();
      loadSriStatus();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al reintentar');
    } finally {
      setBusyId(null);
    }
  };

  const submitAnular = async () => {
    if (!motivo || motivo.trim().length < 10) {
      toast.error('El motivo debe tener al menos 10 caracteres');
      return;
    }
    setBusyId(anularTarget._id);
    try {
      const res = await api.post(`/invoices/${anularTarget._id}/anular`, { motivo, anularVenta });
      toast.success('Factura marcada como anulada');
      if (anularVenta) {
        if (res.data?.saleReversed) toast.success('Venta asociada reversada');
        else if (res.data?.saleWarning) toast(`Venta no reversada: ${res.data.saleWarning}`, { icon: '⚠️', duration: 7000 });
      }
      setAnularTarget(null);
      setMotivo('');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || err.response?.data?.message || 'Error al anular');
    } finally {
      setBusyId(null);
    }
  };

  // Deep-link desde reportes SRI (venta → factura): /invoices?doc=<idFactura> va al detalle
  // (la página resuelve la venta a partir de la factura).
  useDocDeepLink((id) => navigate(`/ventas/${id}`, { replace: true }));

  // ZIP con los RIDE autorizados de lo que se está mirando (estaba en la pestaña Ventas).
  const descargarZip = async () => {
    setDescargandoZip(true);
    try {
      await downloadFile('/invoices/bulk-pdf', { params: { ...paramsFiltro(), estado: undefined }, filename: `facturas_${Date.now()}.zip` });
    } catch (err) {
      toast.error(err.message || 'Error al descargar las facturas');
    } finally {
      setDescargandoZip(false);
    }
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <PageHeader icon={HiOutlineDocumentText} title="Facturación" subtitle="Emisión y seguimiento de comprobantes SRI">
        {onNewSale && <button onClick={onNewSale} className="btn-primary">Nueva venta</button>}
        {canRetry && (
          <button
            onClick={reintentarPendientes}
            disabled={retryingAll}
            className="btn-secondary disabled:opacity-50"
            title="Reenviar/consultar autorización de todas las facturas pendientes"
          >
            <HiOutlineArrowPath className={`w-4 h-4 ${retryingAll ? 'animate-spin' : ''}`} />
            {retryingAll ? 'Reintentando…' : 'Reintentar pendientes'}
          </button>
        )}
        <button
          onClick={async () => {
            try {
              // Lo mismo que se ve: fechas, estado, caja y búsqueda.
              await downloadFile('/reports/invoices.xlsx', { params: paramsFiltro(), filename: `facturas_${Date.now()}.xlsx` });
            } catch (err) {
              toast.error(err.message || 'Error al exportar');
            }
          }}
          className="btn-secondary"
        >
          <HiOutlineArrowDownTray className="w-4 h-4" /> Exportar Excel
        </button>
        <button
          onClick={descargarZip}
          disabled={descargandoZip}
          className="btn-secondary disabled:opacity-50"
          title="Descarga en un ZIP los PDF (RIDE) de las facturas autorizadas del filtro (máx. 300)"
        >
          <HiOutlineDocumentArrowDown className="w-4 h-4" /> {descargandoZip ? 'Generando…' : 'Descargar RIDE (ZIP)'}
        </button>
      </PageHeader>

      {/* Estado del SRI + facturas pendientes */}
      {sriStatus && (
        <div
          className={`rounded-2xl border p-4 flex flex-wrap items-center gap-3 ${
            sriStatus.disponible
              ? 'bg-emerald-50 border-emerald-200'
              : 'bg-red-50 border-red-200'
          }`}
        >
          {sriStatus.disponible ? (
            <HiOutlineSignal className="w-5 h-5 text-emerald-600 shrink-0" />
          ) : (
            <HiOutlineSignalSlash className="w-5 h-5 text-red-600 shrink-0" />
          )}
          <div className="text-sm">
            <span className={sriStatus.disponible ? 'text-emerald-800 font-medium' : 'text-red-800 font-medium'}>
              {sriStatus.disponible ? 'SRI disponible' : 'SRI no disponible'}
            </span>
            <span className="text-slate-500">
              {' '}
              · Ambiente {sriStatus.ambiente === '2' ? 'Producción' : 'Pruebas'}
            </span>
            {!sriStatus.disponible && (
              <span className="block text-xs text-red-700 mt-0.5">
                Las facturas nuevas quedan emitidas y en cola; el sistema las enviará automáticamente cuando el SRI responda. No se pierde ninguna.
              </span>
            )}
          </div>
          {sriStatus.pendientes > 0 && (
            <span className="ml-auto text-xs px-2.5 py-1 rounded-full bg-amber-100 text-amber-800 font-medium">
              {sriStatus.pendientes} pendiente{sriStatus.pendientes === 1 ? '' : 's'} de autorización
            </span>
          )}
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
            Buscar
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder="N° de factura, cliente o cédula/RUC"
              className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50"
            />
          </label>
          <div className="text-xs font-medium text-slate-600 sm:col-span-2">
            Producto / servicio
            <ProductAutocomplete
              products={products}
              value={filter.product}
              onSelect={(p) => cambiarFiltro({ product: p?._id || '' })}
              placeholder="Facturas que lo incluyen…"
              className="mt-1"
            />
          </div>
          <label className="text-xs font-medium text-slate-600">
            Desde
            <DateInput
              value={filter.startDate}
              onChange={(e) => cambiarFiltro({ startDate: e.target.value })}
              className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50"
            />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Hasta
            <DateInput
              value={filter.endDate}
              onChange={(e) => cambiarFiltro({ endDate: e.target.value })}
              className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50"
            />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Estado
            <select
              value={filter.estado}
              onChange={(e) => cambiarFiltro({ estado: e.target.value })}
              className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50"
            >
              <option value="">Todos los estados</option>
              {Object.keys(ESTADO_STYLES).map((k) => (
                <option key={k} value={k}>
                  {ESTADO_LABEL[k] || k}
                </option>
              ))}
            </select>
          </label>
          {puntos.length > 0 && (
            <label className="text-xs font-medium text-slate-600">
              Punto de emisión
              <select
                value={filter.puntoEmision}
                onChange={(e) => cambiarFiltro({ puntoEmision: e.target.value })}
                className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50"
              >
                <option value="">Todas las cajas</option>
                {puntos.map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.establecimiento}-{p.codigo}{p.nombre ? ` · ${p.nombre}` : ''}{p.usuario?.name ? ` (${p.usuario.name})` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="text-slate-500">
            {pagination ? <><b className="text-slate-800">{pagination.total}</b> factura{pagination.total === 1 ? '' : 's'}</> : '—'}
            {pagination && (
              <> · total facturado <b className="text-emerald-700">${Number(sumTotal || 0).toFixed(2)}</b> <span className="text-xs text-slate-400">(sin anuladas)</span></>
            )}
          </span>
          {hayFiltros && (
            <button
              type="button"
              onClick={() => { setBusqueda(''); setPage(1); setFilter(FILTRO_VACIO); }}
              className="text-xs text-emerald-600 hover:underline bg-transparent border-none cursor-pointer"
            >
              Limpiar filtros
            </button>
          )}
        </div>
      </div>

      {pagination && <Paginador pagination={pagination} onPage={irAPagina} unidad="facturas" />}

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
        <table className="tbl">
          <thead className="bg-emerald-50/50 text-emerald-700">
            <tr>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider">N° Factura</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider">Cliente</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider">Fecha</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider">Caja</th>
              <th className="text-right px-5 py-3 text-xs font-semibold uppercase tracking-wider">Total</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider">Estado</th>
              <th className="text-right px-5 py-3 text-xs font-semibold uppercase tracking-wider">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="text-center py-10 text-slate-500">
                  Cargando...
                </td>
              </tr>
            ) : invoices.length === 0 ? (
              <tr>
                <td colSpan={7}>
                  <EmptyState icon={HiOutlineDocumentText} title="No hay facturas" hint="Emite una factura desde una venta." />
                </td>
              </tr>
            ) : (
              invoices.map((inv) => {
                const num = `${inv.estab}-${inv.ptoEmi}-${String(inv.secuencial).padStart(9, '0')}`;
                const isFinal = inv.estado === 'AUTORIZADO' || inv.estado === 'ANULADA';
                return (
                  <tr key={inv._id} className="border-t border-emerald-50 hover:bg-emerald-50/30">
                    <td className="px-5 py-3 font-mono text-xs whitespace-nowrap">
                      <a href={urlDetalleFactura(inv)} target="_blank" rel="noopener" title="Ver el detalle completo (pestaña nueva)" className="text-sky-700 hover:underline">{num}</a>
                    </td>
                    <td className="px-5 py-3 text-slate-800">
                      {inv.razonSocialComprador}
                      <p className="text-xs text-slate-400">{inv.identificacionComprador}</p>
                      {inv.sale?.patient && (
                        <p className="text-[11px] text-emerald-600 mt-0.5">
                          Paciente: {inv.sale.patient.firstName} {inv.sale.patient.lastName}
                          {inv.sale.isFirstVisit && (
                            <span className="ml-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-amber-100 text-amber-700 uppercase">
                              Nuevo
                            </span>
                          )}
                        </p>
                      )}
                    </td>
                    <td className="px-5 py-3 text-slate-600">
                      {fmtDate(inv.createdAt)}
                    </td>
                    <td className="px-5 py-3 text-slate-600 text-xs">
                      {inv.puntoEmision?.nombre || `${inv.estab}-${inv.ptoEmi}`}
                      {inv.puntoEmision?.nombre && <p className="text-[11px] text-slate-400 font-mono">{inv.estab}-{inv.ptoEmi}</p>}
                    </td>
                    <td className="px-5 py-3 text-right font-medium text-slate-800">
                      ${Number(inv.importeTotal || 0).toFixed(2)}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${
                          ESTADO_STYLES[inv.estado] || 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {ESTADO_LABEL[inv.estado] || inv.estado}
                      </span>
                      {inv.proximoReintento && PENDING_ESTADOS.includes(inv.estado) && (
                        <p className="text-[10px] text-slate-400 mt-1">
                          Próx. reintento: {fmtDateTime(inv.proximoReintento)}
                        </p>
                      )}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {inv.estado === 'AUTORIZADO' && (
                        <button
                          onClick={() => verPdf(inv)}
                          className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer ml-1"
                          title="Ver/Descargar RIDE"
                        >
                          <HiOutlineDocumentArrowDown className="w-4 h-4" />
                        </button>
                      )}
                      {canRetry && !isFinal && (
                        <button
                          onClick={() => reintentar(inv)}
                          disabled={busyId === inv._id}
                          className="p-1.5 rounded-lg hover:bg-blue-50 text-slate-400 hover:text-blue-600 bg-transparent border-none cursor-pointer ml-1 disabled:opacity-50"
                          title="Reintentar envío al SRI"
                        >
                          <HiOutlineArrowPath className="w-4 h-4" />
                        </button>
                      )}
                      {canAnular && inv.estado === 'AUTORIZADO' && (
                        <button
                          onClick={() => {
                            setAnularTarget(inv);
                            setMotivo('');
                            setAnularVenta(true);
                          }}
                          className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer ml-1"
                          title="Anular factura"
                        >
                          <HiOutlineXMark className="w-4 h-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {pagination && invoices.length > 0 && <Paginador pagination={pagination} onPage={irAPagina} unidad="facturas" />}

      {/* Anular Modal */}
      <Modal
        isOpen={!!anularTarget}
        onClose={() => {
          setAnularTarget(null);
          setMotivo('');
        }}
        title="Anular factura"
        size="md"
      >
        <div className="space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
            <strong>Importante:</strong> La anulación oficial debe realizarse a través del portal del SRI dentro
            del plazo establecido. Esta acción solo marca la factura como anulada en el sistema.
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Motivo de anulación <span className="text-red-500">*</span>
            </label>
            <textarea
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              rows={3}
              minLength={10}
              className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50"
              placeholder="Mínimo 10 caracteres"
            />
          </div>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={anularVenta} onChange={(e) => setAnularVenta(e.target.checked)} className="mt-0.5" />
            <span>
              Anular también la venta asociada
              <span className="block text-xs text-slate-500">Reversa los asientos contables, devuelve el inventario y cierra la cuenta por cobrar.</span>
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setAnularTarget(null);
                setMotivo('');
              }}
              className="px-4 py-2 border border-slate-200 rounded-lg text-sm text-slate-600 hover:bg-slate-50 cursor-pointer bg-white"
            >
              Cancelar
            </button>
            <button
              onClick={submitAnular}
              disabled={busyId === anularTarget?._id}
              className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium disabled:opacity-50 cursor-pointer border-none"
            >
              Confirmar anulación
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
