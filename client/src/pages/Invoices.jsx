import { useEffect, useState } from 'react';
import api from '../api/axios';
import { downloadFile } from '../utils/download';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import PageHeader, { EmptyState } from '../components/PageHeader';
import { useAuth } from '../context/AuthContext';
import useDocDeepLink from '../hooks/useDocDeepLink';
import { fmtDate, fmtDateTime } from '../utils/date';
import {
  HiOutlineDocumentText,
  HiOutlineArrowPath,
  HiOutlineXMark,
  HiOutlineEye,
  HiOutlineDocumentArrowDown,
  HiOutlineArrowDownTray,
  HiOutlineSignal,
  HiOutlineSignalSlash,
} from 'react-icons/hi2';
import DateInput from '../components/DateInput';

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

// ¿El SRI autorizó en un día calendario distinto al de emisión? En ese caso se
// mantiene la fecha de emisión original y se muestra una advertencia.
function autorizadaOtroDia(inv) {
  if (!inv?.fechaAutorizacion || !inv?.fechaEmision) return false;
  const [dd, mm, yyyy] = String(inv.fechaEmision).split('/');
  if (!dd || !mm || !yyyy) return false;
  const aut = new Date(inv.fechaAutorizacion);
  // Fecha de autorización en hora de Ecuador (UTC-5, sin horario de verano).
  const ec = new Date(aut.getTime() - 5 * 60 * 60 * 1000);
  const autKey = `${String(ec.getUTCDate()).padStart(2, '0')}/${String(ec.getUTCMonth() + 1).padStart(2, '0')}/${ec.getUTCFullYear()}`;
  return autKey !== `${dd.padStart(2, '0')}/${mm.padStart(2, '0')}/${yyyy}`;
}

export default function Invoices() {
  const { hasRole } = useAuth();
  const canRetry = hasRole('admin', 'cajero', 'contabilidad');
  const canAnular = hasRole('admin');

  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ startDate: '', endDate: '', estado: '' });
  const [detail, setDetail] = useState(null);
  const [anularTarget, setAnularTarget] = useState(null);
  const [motivo, setMotivo] = useState('');
  const [anularVenta, setAnularVenta] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [sriStatus, setSriStatus] = useState(null);
  const [retryingAll, setRetryingAll] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = { limit: 50 };
      if (filter.startDate) params.startDate = filter.startDate;
      if (filter.endDate) params.endDate = filter.endDate;
      if (filter.estado) params.estado = filter.estado;
      const res = await api.get('/invoices', { params });
      setInvoices(res.data.invoices || []);
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
  }, [filter]);

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
      toast.error(err.response?.data?.message || 'Error al anular');
    } finally {
      setBusyId(null);
    }
  };

  const verDetalle = async (inv) => {
    try {
      const res = await api.get(`/invoices/${inv._id}`);
      setDetail(res.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar detalle');
    }
  };

  // Deep-link desde reportes SRI (venta → factura): /invoices?doc=<idFactura> abre el detalle.
  useDocDeepLink((id) => verDetalle({ _id: id }));

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <PageHeader icon={HiOutlineDocumentText} title="Facturación electrónica" subtitle="Emisión y seguimiento de comprobantes SRI">
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
              const params = {};
              if (filter.startDate) params.startDate = filter.startDate;
              if (filter.endDate) params.endDate = filter.endDate;
              if (filter.estado) params.estado = filter.estado;
              await downloadFile('/reports/invoices.xlsx', { params, filename: `facturas_${Date.now()}.xlsx` });
            } catch (err) {
              toast.error(err.message || 'Error al exportar');
            }
          }}
          className="btn-secondary"
        >
          <HiOutlineArrowDownTray className="w-4 h-4" /> Exportar Excel
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

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <DateInput
            value={filter.startDate}
            onChange={(e) => setFilter({ ...filter, startDate: e.target.value })}
            className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50"
          />
          <DateInput
            value={filter.endDate}
            onChange={(e) => setFilter({ ...filter, endDate: e.target.value })}
            className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50"
          />
          <select
            value={filter.estado}
            onChange={(e) => setFilter({ ...filter, estado: e.target.value })}
            className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50"
          >
            <option value="">Todos los estados</option>
            {Object.keys(ESTADO_STYLES).map((k) => (
              <option key={k} value={k}>
                {ESTADO_LABEL[k] || k}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
        <table className="tbl">
          <thead className="bg-emerald-50/50 text-emerald-700">
            <tr>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider">N° Factura</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider">Cliente</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider">Fecha</th>
              <th className="text-right px-5 py-3 text-xs font-semibold uppercase tracking-wider">Total</th>
              <th className="text-left px-5 py-3 text-xs font-semibold uppercase tracking-wider">Estado</th>
              <th className="text-right px-5 py-3 text-xs font-semibold uppercase tracking-wider">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="text-center py-10 text-slate-500">
                  Cargando...
                </td>
              </tr>
            ) : invoices.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState icon={HiOutlineDocumentText} title="No hay facturas" hint="Emite una factura desde una venta." />
                </td>
              </tr>
            ) : (
              invoices.map((inv) => {
                const num = `${inv.estab}-${inv.ptoEmi}-${String(inv.secuencial).padStart(9, '0')}`;
                const isFinal = inv.estado === 'AUTORIZADO' || inv.estado === 'ANULADA';
                return (
                  <tr key={inv._id} className="border-t border-emerald-50 hover:bg-emerald-50/30">
                    <td className="px-5 py-3 font-mono text-xs text-slate-700">{num}</td>
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
                      <button
                        onClick={() => verDetalle(inv)}
                        className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer"
                        title="Ver detalle"
                      >
                        <HiOutlineEye className="w-4 h-4" />
                      </button>
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

      {/* Detail Modal */}
      <Modal
        isOpen={!!detail}
        onClose={() => setDetail(null)}
        title="Detalle de factura"
        size="lg"
      >
        {detail && (
          <div className="space-y-4 text-sm">
            {autorizadaOtroDia(detail) && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
                <strong>Advertencia administrativa:</strong> esta factura se emitió el{' '}
                {detail.fechaEmision} y el SRI la autorizó otro día ({fmtDateTime(detail.fechaAutorizacion)}).
                Se conserva la fecha de emisión original. Verifique que la autorización esté dentro del
                plazo permitido por el SRI.
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Item label="N° Factura" value={`${detail.estab}-${detail.ptoEmi}-${detail.secuencial}`} />
              <Item label="Estado" value={ESTADO_LABEL[detail.estado] || detail.estado} />
              {detail.proximoReintento && PENDING_ESTADOS.includes(detail.estado) && (
                <Item label="Próximo reintento" value={fmtDateTime(detail.proximoReintento)} />
              )}
              {detail.reintentos > 0 && (
                <Item label="Reintentos" value={String(detail.reintentos)} />
              )}
              <Item label="Clave de acceso" value={detail.claveAcceso} mono />
              <Item label="Ambiente" value={detail.ambiente === '2' ? 'Producción' : 'Pruebas'} />
              <Item label="Fecha emisión" value={detail.fechaEmision} />
              <Item
                label="Fecha autorización"
                value={
                  detail.fechaAutorizacion
                    ? fmtDateTime(detail.fechaAutorizacion)
                    : '—'
                }
              />
              <Item label="Cliente" value={detail.razonSocialComprador} />
              <Item label="Identificación" value={detail.identificacionComprador} />
              <Item label="Email" value={detail.emailComprador || '—'} />
              <Item label="Teléfono" value={detail.telefonoComprador || '—'} />
              {detail.sale?.patient && (
                <Item
                  label="Paciente registrado"
                  value={`${detail.sale.patient.firstName} ${detail.sale.patient.lastName} — ${detail.sale.patient.cedula}${detail.sale.isFirstVisit ? ' (Nuevo)' : ''}`}
                />
              )}
            </div>
            <div className="grid grid-cols-3 gap-3 pt-2 border-t border-slate-100">
              <Item
                label="Subtotal sin imp."
                value={`$${Number(detail.totalSinImpuestos || 0).toFixed(2)}`}
              />
              <Item label="IVA" value={`$${Number(detail.totalImpuesto || 0).toFixed(2)}`} />
              <Item
                label="Total"
                value={`$${Number(detail.importeTotal || 0).toFixed(2)}`}
                strong
              />
            </div>
            {detail.errorUltimo && (
              <div className="bg-red-50 text-red-700 rounded-xl p-3 text-xs">
                <strong>Último error:</strong> {detail.errorUltimo}
              </div>
            )}
            {detail.mensajesSri?.length > 0 && (
              <div className="bg-amber-50 rounded-xl p-3 text-xs space-y-1">
                <p className="font-semibold text-amber-800">Mensajes SRI</p>
                {detail.mensajesSri.map((m, i) => (
                  <div key={i} className="text-amber-700">
                    <strong>{m.identificador}</strong> ({m.tipo}): {m.mensaje}
                    {m.informacionAdicional && <> — {m.informacionAdicional}</>}
                  </div>
                ))}
              </div>
            )}
            {detail.motivoAnulacion && (
              <div className="bg-slate-100 rounded-xl p-3 text-xs">
                <strong>Anulación:</strong> {detail.motivoAnulacion}
                {detail.anuladaAt && (
                  <p className="text-slate-500 mt-1">
                    {fmtDateTime(detail.anuladaAt)}
                  </p>
                )}
              </div>
            )}
            {detail.intentos?.length > 0 && (
              <div className="bg-slate-50 rounded-xl p-3 text-xs space-y-1 border border-slate-100">
                <p className="font-semibold text-slate-600">Bitácora de envíos al SRI</p>
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {[...detail.intentos].reverse().map((it, i) => (
                    <div key={i} className="flex items-start gap-2 text-slate-600">
                      <span className="text-slate-400 shrink-0">{fmtDateTime(it.at)}</span>
                      <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 shrink-0">
                        {it.tipo}
                      </span>
                      <span className="font-medium">{it.estado}</span>
                      {it.mensaje && <span className="text-slate-400">— {it.mensaje}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

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

function Item({ label, value, mono, strong }) {
  return (
    <div>
      <p className="text-xs uppercase font-semibold text-slate-500">{label}</p>
      <p
        className={`mt-0.5 ${mono ? 'font-mono text-xs break-all' : 'text-slate-800'} ${
          strong ? 'font-bold text-emerald-700 text-lg' : ''
        }`}
      >
        {value || '—'}
      </p>
    </div>
  );
}
