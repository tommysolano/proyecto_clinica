import { useMemo, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from './Modal';
import { doctorOptionLabel, doctorTypeLabel } from '../utils/roles';
import {
  HiOutlineHeart,
  HiOutlineTrash,
  HiOutlineArrowUp,
  HiOutlineArrowDown,
  HiOutlineCheck,
} from 'react-icons/hi2';

/**
 * ASIGNAR LA ATENCIÓN cuando el paciente llega a la clínica.
 *
 * Sustituye al antiguo modal de tres pasos (asistir → cobrar → derivar):
 *  · «asistió» se sobreentiende — quien está delante del mostrador ha venido, y
 *    el servidor pone ese estado solo al asignar;
 *  · el cobro salió de aquí al separar la parte contable de la operativa.
 *
 * Lo que queda es lo único que decide recepción: POR QUIÉN pasa el paciente. Y
 * puede pasar por VARIOS en orden — es lo normal cuando una consulta se atiende
 * entre dos especialistas: el primero atiende, guarda su seguimiento y la cita
 * pasa sola al siguiente. El último la da por terminada.
 *
 * Enfermería no se le asigna a nadie en concreto: sale a la bandeja de todos los
 * enfermeros y la atiende el que esté libre.
 *
 * Props: appointment, doctors, onClose, onDone
 */
export default function AssignAttentionModal({ appointment, doctors = [], onClose, onDone }) {
  const apt = appointment;

  // Turnos ya asignados (para reasignar sin empezar de cero). Los completados no
  // se tocan: ese profesional ya escribió su seguimiento.
  const turnosPrevios = useMemo(
    () => (apt?.turns || []).filter((t) => t.kind === 'doctor' && t.status === 'pendiente'),
    [apt]
  );
  const completados = useMemo(
    () => (apt?.turns || []).filter((t) => t.status === 'completado'),
    [apt]
  );

  const [cola, setCola] = useState(() => {
    const previos = turnosPrevios.map((t) => String(t.user?._id || t.user)).filter(Boolean);
    if (previos.length) return previos;
    return apt?.doctor?._id ? [String(apt.doctor._id)] : [];
  });
  const [enfermeria, setEnfermeria] = useState(
    () => (apt?.turns || []).some((t) => t.kind === 'enfermeria' && t.status === 'pendiente')
  );
  const [busy, setBusy] = useState(false);

  const porId = useMemo(() => new Map(doctors.map((d) => [String(d._id), d])), [doctors]);
  const disponibles = doctors.filter((d) => !cola.includes(String(d._id)));

  const agregar = (id) => { if (id && !cola.includes(id)) setCola((c) => [...c, id]); };
  const quitar = (id) => setCola((c) => c.filter((x) => x !== id));
  const mover = (idx, delta) => {
    setCola((c) => {
      const destino = idx + delta;
      if (destino < 0 || destino >= c.length) return c;
      const copia = [...c];
      [copia[idx], copia[destino]] = [copia[destino], copia[idx]];
      return copia;
    });
  };

  const guardar = async () => {
    if (!cola.length && !enfermeria) {
      toast.error('Elige al menos un doctor o marca enfermería');
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post(`/appointments/${apt._id}/assign-doctor`, {
        doctors: cola,
        nursing: enfermeria,
      });
      const nombres = cola.map((id) => porId.get(id)?.name).filter(Boolean);
      toast.success(
        nombres.length > 1
          ? `Paciente asignado: ${nombres.join(' → ')}`
          : nombres.length
            ? `Paciente asignado a ${nombres[0]}`
            : 'Paciente enviado a enfermería'
      );
      onDone?.(data);
      onClose?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo asignar la atención');
    } finally {
      setBusy(false);
    }
  };

  const paciente = apt?.patient ? `${apt.patient.firstName} ${apt.patient.lastName}` : 'Paciente';
  const servicio = apt?.serviceName || apt?.serviceItem?.name || (apt?.services || []).map((s) => s.name).filter(Boolean).join(', ');

  return (
    <Modal isOpen onClose={onClose} title="Asignar atención" size="lg">
      <div className="space-y-4">
        <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
          <p className="font-semibold text-slate-800">{paciente}</p>
          <p className="text-sm text-slate-500">
            {apt?.startTime}{servicio ? ` · ${servicio}` : ''}
          </p>
        </div>

        {completados.length > 0 && (
          <div className="text-xs text-slate-500 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
            Ya atendieron:{' '}
            {completados
              .map((t) => t.user?.name || (t.kind === 'enfermeria' ? 'Enfermería' : 'Profesional'))
              .join(', ')}
            . No se pueden quitar: su seguimiento ya está escrito.
          </div>
        )}

        {/* Cola de doctores */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Doctores, en el orden en que atenderán
          </label>

          {cola.length === 0 && (
            <p className="text-xs text-slate-400 italic mb-2">
              Sin doctores. Añade uno abajo, o marca enfermería.
            </p>
          )}

          <ul className="space-y-1.5 mb-2">
            {cola.map((id, idx) => {
              const d = porId.get(id);
              return (
                <li key={id} className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-2">
                  <span className="w-6 h-6 shrink-0 rounded-full bg-emerald-600 text-white text-xs font-bold flex items-center justify-center">
                    {idx + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-slate-700 truncate">{d?.name || 'Doctor'}</span>
                    <span className="block text-[11px] text-slate-400">{doctorTypeLabel(d)}</span>
                  </span>
                  <button type="button" title="Subir" onClick={() => mover(idx, -1)} disabled={idx === 0}
                    className="p-1 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer disabled:opacity-30">
                    <HiOutlineArrowUp className="w-4 h-4" />
                  </button>
                  <button type="button" title="Bajar" onClick={() => mover(idx, 1)} disabled={idx === cola.length - 1}
                    className="p-1 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer disabled:opacity-30">
                    <HiOutlineArrowDown className="w-4 h-4" />
                  </button>
                  <button type="button" title="Quitar" onClick={() => quitar(id)}
                    className="p-1 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer">
                    <HiOutlineTrash className="w-4 h-4" />
                  </button>
                </li>
              );
            })}
          </ul>

          <select
            value=""
            onChange={(e) => agregar(e.target.value)}
            className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 bg-slate-50/50 cursor-pointer"
          >
            <option value="">+ Añadir doctor…</option>
            {disponibles.map((d) => (
              <option key={d._id} value={d._id}>{doctorOptionLabel(d)}</option>
            ))}
          </select>
          {cola.length > 1 && (
            <p className="text-[11px] text-slate-500 mt-1.5">
              La cita pasará sola al siguiente cuando cada uno guarde su seguimiento.
            </p>
          )}
        </div>

        {/* Enfermería */}
        <label className="flex items-start gap-3 bg-sky-50 border border-sky-200 rounded-xl px-4 py-3 cursor-pointer">
          <input
            type="checkbox"
            checked={enfermeria}
            onChange={(e) => setEnfermeria(e.target.checked)}
            className="w-4 h-4 accent-sky-600 mt-0.5"
          />
          <span>
            <span className="flex items-center gap-1.5 text-sm font-medium text-sky-800">
              <HiOutlineHeart className="w-4 h-4" /> Atiende enfermería
            </span>
            <span className="block text-[11px] text-sky-700/80 mt-0.5">
              Sale a la bandeja de todos los enfermeros; la atiende el primero que la tome.
            </span>
          </span>
        </label>

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
            {busy ? 'Asignando…' : <><HiOutlineCheck className="w-4 h-4" /> Asignar</>}
          </button>
        </div>
      </div>
    </Modal>
  );
}

