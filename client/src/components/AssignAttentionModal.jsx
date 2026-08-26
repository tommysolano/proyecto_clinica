import { useMemo, useRef, useState } from 'react';
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
 * Lo que queda es lo único que decide recepción: POR QUIÉN pasa el paciente, y
 * EN QUÉ ORDEN. Cada uno atiende, guarda su seguimiento y la cita pasa sola al
 * siguiente; el último la da por terminada.
 *
 * ENFERMERÍA ES UN PASO MÁS DE LA COLA, no una casilla al final. Antes solo se
 * podía mandar a enfermería DESPUÉS de los doctores, y el caso más común es el
 * contrario: que tome los signos antes de que pase el médico. Puede ir en
 * cualquier posición, y más de una vez (signos antes, aplicación después).
 * No se le asigna a un enfermero concreto: sale a la bandeja de todos y la
 * atiende el primero que la tome.
 *
 * Props: appointment, doctors, onClose, onDone
 */
const ENFERMERIA = 'enfermeria';

export default function AssignAttentionModal({ appointment, doctors = [], onClose, onDone }) {
  const apt = appointment;

  // Los turnos ya completados no se tocan: ese profesional ya escribió su
  // seguimiento. Los pendientes se cargan para poder reordenarlos sin empezar
  // de cero.
  const completados = useMemo(
    () => (apt?.turns || []).filter((t) => t.status === 'completado'),
    [apt]
  );

  // Cola de pasos: { kind: 'doctor', user } | { kind: 'enfermeria' }.
  // `key` solo para React: enfermería puede repetirse y los ids no bastan.
  const [cola, setCola] = useState(() => {
    const pendientes = (apt?.turns || []).filter((t) => t.status === 'pendiente');
    if (pendientes.length) {
      return pendientes.map((t, i) =>
        t.kind === ENFERMERIA
          ? { kind: ENFERMERIA, key: `enf-${i}` }
          : { kind: 'doctor', user: String(t.user?._id || t.user), key: `doc-${t.user?._id || t.user}` }
      );
    }
    return apt?.doctor?._id
      ? [{ kind: 'doctor', user: String(apt.doctor._id), key: `doc-${apt.doctor._id}` }]
      : [];
  });
  const [busy, setBusy] = useState(false);
  // Nota de recepción al recibir al paciente. No se queda en la cita: va a la
  // bitácora de Observaciones del paciente, junto a las demás.
  const [observacion, setObservacion] = useState('');
  const contador = useRef(0);

  const porId = useMemo(() => new Map(doctors.map((d) => [String(d._id), d])), [doctors]);
  const yaEnCola = cola.filter((p) => p.kind === 'doctor').map((p) => p.user);
  const disponibles = doctors.filter((d) => !yaEnCola.includes(String(d._id)));

  const agregarDoctor = (id) => {
    if (!id || yaEnCola.includes(id)) return;
    setCola((c) => [...c, { kind: 'doctor', user: id, key: `doc-${id}` }]);
  };
  const agregarEnfermeria = () =>
    setCola((c) => [...c, { kind: ENFERMERIA, key: `enf-${(contador.current += 1)}` }]);
  const quitar = (idx) => setCola((c) => c.filter((_, i) => i !== idx));
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
    if (!cola.length) {
      toast.error('Añade al menos un doctor o un paso de enfermería');
      return;
    }
    setBusy(true);
    try {
      const { data } = await api.post(`/appointments/${apt._id}/assign-doctor`, {
        steps: cola.map((p) => (p.kind === ENFERMERIA ? { kind: ENFERMERIA } : { kind: 'doctor', user: p.user })),
        observation: observacion.trim(),
      });
      const nombres = cola.map((p) =>
        p.kind === ENFERMERIA ? 'Enfermería' : porId.get(p.user)?.name || 'Doctor'
      );
      toast.success(
        nombres.length > 1 ? `Paciente asignado: ${nombres.join(' → ')}` : `Paciente asignado a ${nombres[0]}`
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

        {/* Cola de atención: doctores y enfermería, mezclados y en orden */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Por quién pasa, en orden
          </label>

          {cola.length === 0 && (
            <p className="text-xs text-slate-400 italic mb-2">
              Todavía no has añadido a nadie. Usa los botones de abajo.
            </p>
          )}

          <ul className="space-y-1.5 mb-2">
            {cola.map((paso, idx) => {
              const esEnf = paso.kind === ENFERMERIA;
              const d = esEnf ? null : porId.get(paso.user);
              return (
                <li
                  key={paso.key}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 border ${
                    esEnf ? 'bg-sky-50 border-sky-200' : 'bg-white border-slate-200'
                  }`}
                >
                  <span
                    className={`w-6 h-6 shrink-0 rounded-full text-white text-xs font-bold flex items-center justify-center ${
                      esEnf ? 'bg-sky-600' : 'bg-emerald-600'
                    }`}
                  >
                    {idx + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`flex items-center gap-1.5 text-sm truncate ${esEnf ? 'text-sky-800 font-medium' : 'text-slate-700'}`}>
                      {esEnf && <HiOutlineHeart className="w-4 h-4 shrink-0" />}
                      {esEnf ? 'Enfermería' : d?.name || 'Doctor'}
                    </span>
                    <span className={`block text-[11px] ${esEnf ? 'text-sky-700/80' : 'text-slate-400'}`}>
                      {esEnf ? 'La atiende el primer enfermero que la tome' : doctorTypeLabel(d)}
                    </span>
                  </span>
                  <button type="button" title="Subir" onClick={() => mover(idx, -1)} disabled={idx === 0}
                    className="p-1 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer disabled:opacity-30">
                    <HiOutlineArrowUp className="w-4 h-4" />
                  </button>
                  <button type="button" title="Bajar" onClick={() => mover(idx, 1)} disabled={idx === cola.length - 1}
                    className="p-1 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer disabled:opacity-30">
                    <HiOutlineArrowDown className="w-4 h-4" />
                  </button>
                  <button type="button" title="Quitar" onClick={() => quitar(idx)}
                    className="p-1 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer">
                    <HiOutlineTrash className="w-4 h-4" />
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="flex flex-col sm:flex-row gap-2">
            <select
              value=""
              onChange={(e) => agregarDoctor(e.target.value)}
              className="flex-1 px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 bg-slate-50/50 cursor-pointer"
            >
              <option value="">+ Añadir doctor…</option>
              {disponibles.map((d) => (
                <option key={d._id} value={d._id}>{doctorOptionLabel(d)}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={agregarEnfermeria}
              className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl border border-sky-200 bg-sky-50 text-sm font-medium text-sky-800 cursor-pointer hover:bg-sky-100 shrink-0"
            >
              <HiOutlineHeart className="w-4 h-4" /> Añadir enfermería
            </button>
          </div>

          {cola.length > 1 && (
            <p className="text-[11px] text-slate-500 mt-1.5">
              La cita pasa sola al siguiente cuando cada uno guarda su seguimiento. Solo le
              aparece a quien le toca.
            </p>
          )}
        </div>

        {/* Observación del paciente */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Observación <span className="font-normal text-slate-400">(opcional)</span>
          </label>
          <textarea
            value={observacion}
            onChange={(e) => setObservacion(e.target.value)}
            rows={2}
            placeholder="Vino con la mamá, pidió factura a nombre de la empresa…"
            className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50 resize-none"
          />
          <p className="text-[11px] text-slate-400 mt-1">
            Se guarda en <b>Observaciones</b> del paciente, no en la cita.
          </p>
        </div>

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

