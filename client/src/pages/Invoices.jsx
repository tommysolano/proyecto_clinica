import { useEffect, useState } from 'react';
import api from '../api/axios';
import { downloadFile } from '../utils/download';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import {
  HiOutlineDocumentText,
  HiOutlineArrowPath,
  HiOutlineXMark,
  HiOutlineEye,
  HiOutlineDocumentArrowDown,
} from 'react-icons/hi2';

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
  const [busyId, setBusyId] = useState(null);

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

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

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
      await api.post(`/invoices/${inv._id}/retry`);
      toast.success('Reintento enviado');
      load();
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
      await api.post(`/invoices/${anularTarget._id}/anular`, { motivo });
      toast.success('Factura marcada como anulada');
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

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          <HiOutlineDocumentText className="w-7 h-7 text-emerald-600" />
          Facturación electrónica SRI
        </h1>
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
          className="px-4 py-2.5 rounded-xl text-sm font-medium cursor-pointer border bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50"
        >
          Exportar Excel
        </button>
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input
            type="date"
            value={filter.startDate}
            onChange={(e) => setFilter({ ...filter, startDate: e.target.value })}
            className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none bg-slate-50/50"
          />
          <input
            type="date"
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
                {k}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
        <table className="w-full text-sm">
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
                <td colSpan={6} className="text-center py-10 text-slate-500">
                  No hay facturas.
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
                      {new Date(inv.createdAt).toLocaleDateString('es-EC')}
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
                        {inv.estado}
                      </span>
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
            <div className="grid grid-cols-2 gap-3">
              <Item label="N° Factura" value={`${detail.estab}-${detail.ptoEmi}-${detail.secuencial}`} />
              <Item label="Estado" value={detail.estado} />
              <Item label="Clave de acceso" value={detail.claveAcceso} mono />
              <Item label="Ambiente" value={detail.ambiente === '2' ? 'Producción' : 'Pruebas'} />
              <Item label="Fecha emisión" value={detail.fechaEmision} />
              <Item
                label="Fecha autorización"
                value={
                  detail.fechaAutorizacion
                    ? new Date(detail.fechaAutorizacion).toLocaleString('es-EC')
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
                    {new Date(detail.anuladaAt).toLocaleString('es-EC')}
                  </p>
                )}
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
