import { useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from './Modal';
import ServiceItemPicker from './ServiceItemPicker';
import AppointmentValueFields from './AppointmentValueFields';
import { HiOutlineCheck, HiOutlineLockClosed, HiOutlineXMark, HiOutlinePlus } from 'react-icons/hi2';

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
  // Lo que el paciente dejó pagado (normalmente por teléfono, al agendar). Se
  // corrige aquí junto al valor: al cobrar es cuando se sabe si aquello cubría
  // lo que al final se hizo.
  const [adelanto, setAdelanto] = useState(apt?.advancePayment || '');
  const [abonado, setAbonado] = useState(apt?.advanceAmount ? String(apt.advanceAmount) : '');
  const [busy, setBusy] = useState(false);

  // Los OTROS servicios de la visita, como {_id, name}. El nombre guardado es el
  // que manda: si alguien renombró el ítem del catálogo, aquí sigue diciendo lo
  // que se hizo ese día.
  const [extras, setExtras] = useState(() =>
    (apt?.additionalServices || [])
      .map((s) => ({
        _id: String(s.serviceItem?._id || s.serviceItem || ''),
        name: s.name || s.serviceItem?.name || '',
      }))
      .filter((s) => s._id && s.name)
  );
  /**
   * El selector de abajo es de «añadir», no de «elegir»: se queda siempre vacío.
   * Como su texto interno solo se resincroniza cuando cambia el `value` —y aquí
   * es null siempre—, se le cambia la llave para que vuelva a nacer limpio; si
   * no, el nombre recién añadido se quedaba escrito en el campo.
   */
  const [llaveSelector, setLlaveSelector] = useState(0);

  const agregarExtra = (item) => {
    if (!item?._id) return;
    const id = String(item._id);
    // Ni repetido ni igual al principal: la cita no puede decir que la misma
    // ecografía se hizo dos veces.
    if (id === String(servicio?._id || '')) {
      toast('Ese ya es el servicio principal de la cita', { icon: 'ℹ️' });
      return;
    }
    setExtras((prev) => (prev.some((s) => s._id === id) ? prev : [...prev, { _id: id, name: item.name }]));
    setLlaveSelector((k) => k + 1);
  };

  const quitarExtra = (id) => setExtras((prev) => prev.filter((s) => s._id !== id));

  const paciente = apt?.patient
    ? `${apt.patient.firstName || ''} ${apt.patient.lastName || ''}`.trim() || 'Paciente'
    : 'Paciente';

  const guardar = async () => {
    setBusy(true);
    try {
      const { data } = await api.patch(`/appointments/${apt._id}/service-value`, {
        serviceItem: servicio?._id || null,
        // La lista COMPLETA, no un "añade este": quitar uno es mandarla sin él.
        additionalServices: extras.map((s) => s._id),
        agreedValue: canje ? 0 : valor === '' ? null : Number(valor),
        isCanje: canje,
        advancePayment: adelanto || '',
        advanceAmount: abonado === '' ? 0 : Number(abonado),
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

        {/* OTROS SERVICIOS de la misma visita. El paciente entra por una consulta
            y de paso le hacen una ecografía: antes había que elegir cuál de los
            dos se anotaba y el otro se perdía. */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Otros servicios de esta visita
          </label>

          {extras.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {extras.map((s) => (
                <span
                  key={s._id}
                  className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-violet-100 text-violet-800 text-xs font-medium"
                >
                  {s.name}
                  <button
                    type="button"
                    onClick={() => quitarExtra(s._id)}
                    title={`Quitar ${s.name}`}
                    className="p-0.5 rounded-full hover:bg-violet-200 text-violet-600 bg-transparent border-none cursor-pointer"
                  >
                    <HiOutlineXMark className="w-3.5 h-3.5" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <ServiceItemPicker
            key={llaveSelector}
            value={null}
            onChange={agregarExtra}
            placeholder="Añade otro servicio…"
          />
          <p className="flex items-center gap-1 text-[11px] text-slate-400 mt-1">
            <HiOutlinePlus className="w-3 h-3 shrink-0" />
            Se añaden uno a uno. El valor de abajo es el total de la visita, con
            estos incluidos.
          </p>
        </div>

        <AppointmentValueFields
          value={valor}
          onValueChange={setValor}
          isCanje={canje}
          onCanjeChange={setCanje}
          advancePayment={adelanto}
          onAdvancePaymentChange={setAdelanto}
          advanceAmount={abonado}
          onAdvanceAmountChange={setAbonado}
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
