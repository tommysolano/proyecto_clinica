import { useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from './Modal';
import { HiOutlineCheckCircle } from 'react-icons/hi2';

/**
 * Finalización de una cita de enfermería. El enfermero no llena el seguimiento:
 * solo registra (opcionalmente) los signos vitales y marca la cita como terminada.
 * El sistema guarda automáticamente en el seguimiento del paciente que se aplicó
 * el servicio y qué enfermero lo aplicó.
 *
 * Props: appointment, onClose, onDone
 */
export default function NurseFinishModal({ appointment, onClose, onDone }) {
  const apt = appointment;
  const [busy, setBusy] = useState(false);
  const [vs, setVs] = useState({
    temperature: '', bloodPressure: '', heartRate: '', respiratoryRate: '',
    oxygenSaturation: '', weight: '', glucose: '',
  });
  const [note, setNote] = useState('');

  const finish = async () => {
    setBusy(true);
    try {
      const vitalSigns = {
        temperature: vs.temperature ? Number(vs.temperature) : null,
        bloodPressure: vs.bloodPressure || '',
        heartRate: vs.heartRate ? Number(vs.heartRate) : null,
        respiratoryRate: vs.respiratoryRate ? Number(vs.respiratoryRate) : null,
        oxygenSaturation: vs.oxygenSaturation ? Number(vs.oxygenSaturation) : null,
        weight: vs.weight ? Number(vs.weight) : null,
        glucose: vs.glucose ? Number(vs.glucose) : null,
      };
      await api.post(`/appointments/${apt._id}/nurse-complete`, { vitalSigns, note });
      toast.success('Cita finalizada y registrada en el seguimiento');
      onDone?.();
      onClose?.();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo finalizar');
    } finally {
      setBusy(false);
    }
  };

  const field = (key, label, placeholder = '') => (
    <label className="block text-xs text-slate-500">{label}
      <input
        value={vs[key]}
        onChange={(e) => setVs({ ...vs, [key]: e.target.value })}
        placeholder={placeholder}
        className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
      />
    </label>
  );

  const services = (apt?.services || []).map((s) => s.name || s.product?.name).filter(Boolean).join(', ');

  return (
    <Modal isOpen={!!apt} onClose={onClose} title="Terminar atención de enfermería" size="md">
      {apt && (
        <div className="space-y-3">
          <div className="bg-sky-50 rounded-xl p-3 text-sm">
            <div className="font-semibold text-slate-800">{apt.patient?.firstName} {apt.patient?.lastName}</div>
            <div className="text-xs text-slate-600 mt-1">Servicio: {services || '—'}</div>
          </div>
          <p className="text-xs text-slate-500">Signos vitales (opcional). Se guardarán en el seguimiento del paciente.</p>
          <div className="grid grid-cols-2 gap-3">
            {field('temperature', 'Temperatura (°C)')}
            {field('bloodPressure', 'Presión arterial', '120/80')}
            {field('heartRate', 'Frec. cardíaca (lpm)')}
            {field('oxygenSaturation', 'Saturación O₂ (%)')}
            {field('respiratoryRate', 'Frec. respiratoria (rpm)')}
            {field('glucose', 'Glucosa (mg/dL)')}
          </div>
          <label className="block text-xs text-slate-500">Nota (opcional)
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="mt-1 w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm bg-slate-100 hover:bg-slate-200 border-none cursor-pointer">Cancelar</button>
            <button onClick={finish} disabled={busy} className="px-4 py-2 rounded-xl text-sm bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 border-none cursor-pointer flex items-center gap-2">
              <HiOutlineCheckCircle className="w-4 h-4" /> Terminar cita
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
