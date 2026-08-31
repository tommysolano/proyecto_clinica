import { useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from './Modal';
import ServiceItemPicker from './ServiceItemPicker';
import AppointmentValueFields from './AppointmentValueFields';
import { HiOutlineCheck, HiOutlineLockClosed } from 'react-icons/hi2';

/**
 * CORREGIR EL SERVICIO Y EL VALOR de una cita, también después de atenderla.
 *
 * El servicio real se sabe muchas veces al final —el paciente entró por una
 * consulta y salió con un procedimiento—, y el importe se cierra ahí mismo.
 * Hasta ahora eso obligaba a llamar a un administrador, porque una cita
 * completada estaba cerrada para todo el mundo.
 *
 * Va contra `PATCH /appointments/:id/service-value`, una puerta que SOLO deja
 * cambiar estas tres cosas. Quién atendió no se toca: los turnos, el doctor y el
 * enfermero se quedan como están, pase lo que pase.
 *
 * Props: appointment, onClose, onDone(citaActualizada)
 */
export default function AppointmentServiceValueModal({ appointment, onClose, onDone }) {
  const apt = appointment;

  const [servicio, setServicio] = useState(
    apt?.serviceItem
      ? {
          _id: apt.serviceItem._id || apt.serviceItem,
          name: apt.serviceItem.name || apt.serviceName || '',
        }
      : null
  );
  const [valor, setValor] = useState(
    apt?.agreedValue === null || apt?.agreedValue === undefined ? '' : String(apt.agreedValue)
  );
  const [canje, setCanje] = useState(!!apt?.isCanje);
  const [busy, setBusy] = useState(false);

  const paciente = apt?.patient
    ? `${apt.patient.firstName || ''} ${apt.patient.lastName || ''}`.trim() || 'Paciente'
    : 'Paciente';

  const guardar = async () => {
    setBusy(true);
    try {
      const { data } = await api.patch(`/appointments/${apt._id}/service-value`, {
        serviceItem: servicio?._id || null,
        agreedValue: canje ? 0 : valor === '' ? null : Number(valor),
        isCanje: canje,
      });
      toast.success('Servicio y valor actualizados');
      onDone?.(data);
      onClose?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo actualizar la cita');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Servicio y valor de la cita" size="md">
      <div className="space-y-4">
        <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
          <p className="font-semibold text-slate-800">{paciente}</p>
          <p className="text-sm text-slate-500">
            {apt?.startTime}
            {apt?.serviceName ? ` · ${apt.serviceName}` : ''}
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Servicio por el que asistió
          </label>
          <ServiceItemPicker value={servicio} onChange={setServicio} />
        </div>

        <AppointmentValueFields
          value={valor}
          onValueChange={setValor}
          isCanje={canje}
          onCanjeChange={setCanje}
        />

        <p className="flex items-start gap-2 text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          <HiOutlineLockClosed className="w-4 h-4 shrink-0 mt-px text-slate-400" />
          <span>
            Quién atendió al paciente no se cambia desde aquí: su seguimiento ya está
            escrito a su nombre.
          </span>
        </p>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-slate-200 bg-white text-sm text-slate-600 cursor-pointer"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={guardar}
            disabled={busy}
            className="flex items-center gap-1.5 px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium border-none cursor-pointer disabled:opacity-50"
          >
            {busy ? 'Guardando…' : <><HiOutlineCheck className="w-4 h-4" /> Guardar</>}
          </button>
        </div>
      </div>
    </Modal>
  );
}
