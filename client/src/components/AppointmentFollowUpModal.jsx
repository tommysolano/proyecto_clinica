import { useEffect, useState } from 'react';
import api from '../api/axios';
import Modal from './Modal';
import Spinner from './Spinner';
import { fmtDate } from '../utils/date';
import {
  HiOutlineClipboardDocumentList,
  HiOutlineExclamationTriangle,
  HiOutlineBeaker,
  HiOutlineLockClosed,
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

function Seguimiento({ fu }) {
  const autor = fu.createdBy?.name || 'Profesional';
  const receta = fu.recetaItems || [];

  // Consulta del terapeuta vista por quien no le corresponde: el servidor manda
  // un tocón, no los campos vacíos. Se dice tal cual.
  if (fu.redacted) {
    return (
      <div className="border border-slate-200 rounded-xl px-4 py-3 bg-slate-50">
        <p className="flex items-center gap-2 text-sm text-slate-600">
          <HiOutlineLockClosed className="w-4 h-4 text-slate-400" />
          Atendido por terapeuta — esta consulta es privada.
        </p>
        <p className="text-xs text-slate-400 mt-1">{autor}</p>
      </div>
    );
  }

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <div className="bg-slate-50 px-4 py-2 border-b border-slate-200 flex items-center justify-between gap-2 flex-wrap">
        <span className="text-sm font-semibold text-slate-700">{autor}</span>
        <span className="text-xs text-slate-500">
          {fu.kind === 'enfermeria' ? 'Enfermería' : fu.kind === 'estudio' ? 'Estudio' : 'Consulta'}
        </span>
      </div>

      <div className="px-4 py-3 space-y-3">
        <Campo label="Motivo" valor={fu.motivoConsulta || fu.descripcion} />
        {(fu.diagnosticos || []).length > 0 && (
          <Campo
            label="Diagnóstico"
            valor={fu.diagnosticos
              .map((d) => [d.cie10, d.descripcion].filter(Boolean).join(' — '))
              .join(' · ')}
          />
        )}

        {receta.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Receta</p>
            <ul className="space-y-1.5">
              {receta.map((it) => (
                <li key={it._id} className="text-sm text-slate-700 bg-slate-50 rounded-lg px-3 py-2">
                  <span className="font-medium">
                    {it.name}
                    {it.quantity > 1 ? ` × ${it.quantity}` : ''}
                  </span>
                  {[it.dose, it.frequency, it.duration].filter(Boolean).length > 0 && (
                    <span className="text-slate-500">
                      {' — '}
                      {[it.dose, it.frequency, it.duration].filter(Boolean).join(', ')}
                    </span>
                  )}
                  {it.instructions && (
                    <p className="text-xs text-slate-500 mt-0.5">{it.instructions}</p>
                  )}
                  {/**
                    * EL SUERO SE DETALLA: enfermería tiene que leer exactamente
                    * lo que entra por la vena, y el recuento de dosis es lo que
                    * evita ponerle la octava de siete.
                    */}
                  {it.isSerum && (
                    <div className="mt-1.5 text-xs text-slate-600 space-y-0.5">
                      {it.serumBase?.name && (
                        <p className="flex items-center gap-1">
                          <HiOutlineBeaker className="w-3.5 h-3.5 text-sky-500 shrink-0" />
                          {it.serumBase.name}
                          {it.serumBase.volumeMl ? ` ${it.serumBase.volumeMl} ml` : ''}
                        </p>
                      )}
                      {(it.serumComponents || []).length > 0 && (
                        <p className="pl-4.5">
                          {it.serumComponents.map((c) => c.name).filter(Boolean).join(' · ')}
                        </p>
                      )}
                      <p className="pl-4.5 text-slate-500">
                        {(it.administrations || []).length} de {it.quantity} aplicadas
                      </p>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <Campo label="Plan de tratamiento" valor={fu.planTratamiento} />
        <Campo label="Recomendaciones" valor={fu.recomendacionesNoFarmacologicas} />
        <Campo label="Indicaciones" valor={fu.indicaciones} />
        <Campo label="Observaciones" valor={fu.observaciones} />

        {(fu.attachments || []).length > 0 && (
          <p className="text-xs text-slate-500">
            {fu.attachments.length} archivo{fu.attachments.length === 1 ? '' : 's'} adjunto
            {fu.attachments.length === 1 ? '' : 's'} — se abren desde la ficha del paciente.
          </p>
        )}
      </div>
    </div>
  );
}

function Campo({ label, valor }) {
  if (!valor) return null;
  return (
    <div>
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{label}</p>
      <p className="text-sm text-slate-700 whitespace-pre-wrap">{valor}</p>
    </div>
  );
}
