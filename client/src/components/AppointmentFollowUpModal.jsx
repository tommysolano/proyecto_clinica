import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from './Modal';
import Spinner from './Spinner';
import { fmtDate } from '../utils/date';
import { Seguimiento } from './SeguimientoLectura';
import AppointmentPurchaseFields from './AppointmentPurchaseFields';
import useAppointmentPurchase from '../hooks/useAppointmentPurchase';
import { useAuth } from '../context/AuthContext';
import {
  HiOutlineClipboardDocumentList,
  HiOutlineExclamationTriangle,
} from 'react-icons/hi2';

/**
 * LO QUE SE ESCRIBIÓ EN ESTA CITA, desde la agenda y sin salir de ella.
 *
 * Antes había que abrir la ficha del paciente y buscar el seguimiento por fecha
 * entre todos los suyos. Con dos consultas el mismo día —o con la enfermera y el
 * doctor escribiendo cada uno lo suyo— eso es adivinar, y una receta no se
 * adivina.
 *
 * Es de SOLO LECTURA a propósito: corregir una consulta se hace desde la ficha,
 * por su autor, con su propio botón (ver `puedoCorregir` en Appointments). Esto
 * es para mirar — mostrador para cobrar o dispensar, enfermería para saber qué
 * poner, el médico para repasar.
 *
 * EXCEPCIÓN — EL COBRO DE LA RECETA (sep-2026): para administración y caja,
 * los MEDICAMENTOS que el doctor recetó se ven como CHECKS —igual que las
 * ampollas del suero— y aquí mismo se marca lo que el paciente se lleva, lo que
 * paga por ellos y con qué método. Informativo: no genera venta ni asiento
 * contable; queda en la cita, junto al valor de la visita, y dice quién cobró.
 *
 * Props: appointment (la cita), onClose
 */
export default function AppointmentFollowUpModal({ appointment, onClose, onPurchaseSaved, onCobrarReceta = null }) {
  const { hasRole, user } = useAuth();
  const puedeRegistrarCobro = user?.isSuperAdmin || hasRole('admin', 'cajero');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let vivo = true;
    api
      .get(`/clinical-records/by-appointment/${appointment._id}`)
      .then((r) => { if (vivo) setData(r.data); })
      .catch((e) => {
        if (vivo) setError(e.response?.data?.message || 'No se pudo cargar la consulta');
      });
    return () => { vivo = false; };
  }, [appointment._id]);

  const paciente =
    `${appointment.patient?.firstName || ''} ${appointment.patient?.lastName || ''}`.trim() || 'Paciente';

  return (
    <Modal isOpen onClose={onClose} title="Consulta de esta cita" size="lg">
      <div className="space-y-4">
        <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
          <p className="font-semibold text-slate-800">{paciente}</p>
          <p className="text-sm text-slate-500">
            {fmtDate(appointment.date)} · {appointment.startTime}
            {appointment.serviceName ? ` · ${appointment.serviceName}` : ''}
          </p>
        </div>

        {/**
          * FACTURA DESDE LA AGENDA (oct-2026): con ella encendida la receta se
          * cobra como una VENTA (formulario de Ventas, con su contabilidad), no
          * como el registro operativo de siempre.
          */}
        {puedeRegistrarCobro && onCobrarReceta && data && (
          <CobrarRecetaComoVenta followUps={data.followUps} onCobrar={onCobrarReceta} />
        )}
        {puedeRegistrarCobro && !onCobrarReceta && (
          <CobroReceta appointment={appointment} onSaved={onPurchaseSaved} />
        )}

        {!data && !error && (
          <div className="py-10 flex justify-center"><Spinner /></div>
        )}

        {error && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </p>
        )}

        {data && data.followUps.length === 0 && (
          <div className="text-center py-8 text-slate-500 text-sm">
            <HiOutlineClipboardDocumentList className="w-8 h-8 mx-auto mb-2 text-slate-300" />
            En esta cita no se escribió ninguna consulta.
          </div>
        )}

        {/**
          * Cuando el seguimiento no viene sellado con la cita se busca por el día
          * y por quién atendió. Se DICE, en vez de presentarlo como si fuera
          * exacto: quien lo lee tiene que saber cuánto puede fiarse.
          */}
        {data?.aproximado && (
          <p className="flex items-start gap-2 text-[12px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            <HiOutlineExclamationTriangle className="w-4 h-4 shrink-0 mt-px" />
            <span>
              Esta cita es anterior al registro por turnos, así que esto es lo que
              se escribió <b>ese día</b> por quien la atendió.
            </span>
          </p>
        )}

        {data?.followUps.map((fu) => (
          <Seguimiento key={fu._id} fu={fu} />
        ))}

        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-600 cursor-pointer"
          >
            Cerrar
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * LA RECETA COMO VENTA (factura desde la agenda, oct-2026). Junta lo que el
 * doctor recetó en esta cita —medicamentos e insumos, no servicios ni sueros— y
 * lo manda al formulario de Ventas, donde se quita lo que el paciente no se
 * lleva, se elige cómo factura y cómo paga.
 */
function CobrarRecetaComoVenta({ followUps, onCobrar }) {
  const receta = [];
  for (const fu of followUps || []) {
    for (const it of fu.recetaItems || []) {
      if (it.isService || it.isSerum || it.fromDerivacion || !String(it.name || '').trim()) continue;
      receta.push({
        product: it.product?._id || it.product || null,
        quantity: Number(it.quantity) > 0 ? Number(it.quantity) : 1,
        name: it.name,
      });
    }
  }
  if (!receta.length) return null;
  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50/60 px-4 py-3 space-y-2">
      <p className="m-0 text-sm font-semibold text-violet-900">Receta de esta cita</p>
      <ul className="m-0 pl-4 text-xs text-slate-700 space-y-0.5">
        {receta.map((r, i) => (
          <li key={i}>
            {r.name} × {r.quantity}
            {!r.product && <span className="text-amber-700"> · no está en el inventario</span>}
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => onCobrar(receta)}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 text-white hover:bg-violet-700 cursor-pointer border-none"
        >
          Cobrar la receta
        </button>
      </div>
    </div>
  );
}

/**
 * EL COBRO DE LA RECETA, EN CHECKS (sep-2026).
 *
 * Los medicamentos/insumos que el doctor recetó en ESTA cita, tal como llegan
 * del seguimiento, se ven como casillas: mostrador marca lo que el paciente se
 * lleva, anota lo que paga por ellos y con qué método, y queda registrado quién
 * cobró. Es la misma lógica del valor de la cita: OPERATIVO, no contable.
 */
function CobroReceta({ appointment, onSaved }) {
  const purchase = useAppointmentPurchase(appointment);
  const [saving, setSaving] = useState(false);

  const guardar = async () => {
    const data = purchase.payload();
    if (data.items.length === 0) {
      toast.error('Marca un producto de la receta o añade un producto adicional');
      return;
    }
    setSaving(true);
    try {
      const response = await api.patch(`/appointments/${appointment._id}/cobro-items`, data);
      purchase.reset();
      onSaved?.(response.data);
      toast.success('Compra registrada en Observaciones');
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo registrar el cobro');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <AppointmentPurchaseFields purchase={purchase} />
      <div className="flex justify-end">
        <button
          type="button"
          onClick={guardar}
          disabled={saving}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-600 text-white hover:bg-violet-700 cursor-pointer border-none disabled:opacity-50"
        >
          {saving ? 'Guardando…' : 'Registrar compra'}
        </button>
      </div>
    </div>
  );
}
