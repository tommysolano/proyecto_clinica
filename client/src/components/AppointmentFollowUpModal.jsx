import { useEffect, useState } from 'react';
import api from '../api/axios';
import Modal from './Modal';
import Spinner from './Spinner';
import { fmtDate } from '../utils/date';
import { Seguimiento } from './SeguimientoLectura';
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
 * Props: appointment (la cita), onClose
 */
export default function AppointmentFollowUpModal({ appointment, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let vivo = true;
    setData(null);
    setError('');
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
