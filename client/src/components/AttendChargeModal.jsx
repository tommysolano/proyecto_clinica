import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from './Modal';
import {
  HiOutlineCheckCircle,
  HiOutlineBanknotes,
  HiOutlineUserPlus,
  HiOutlineHeart,
} from 'react-icons/hi2';

const PAYMENT_METHODS = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  transferencia: 'Transferencia',
  credito: 'Crédito (CxC)',
};

/**
 * Flujo de recepción al llegar el paciente a una cita:
 *   1) Marcar asistencia (llegada)
 *   2) Cobrar los servicios (respetando la configuración contable:
 *      cuenta bancaria para transferencia, tarjeta/POS para tarjeta)
 *   3) Derivar: asignar doctor — o, si el servicio es de enfermería,
 *      dejarla disponible para que cualquier enfermero la atienda.
 *
 * Props: appointment, doctors, onClose, onDone
 */
export default function AttendChargeModal({ appointment, doctors = [], onClose, onDone }) {
  const apt = appointment;
  const isNursing = useMemo(
    () => (apt?.services || []).some((s) => s.product?.nursingService),
    [apt]
  );

  const [step, setStep] = useState('asistir'); // asistir | cobro | doctor
  const [busy, setBusy] = useState(false);
  const [doctorId, setDoctorId] = useState(apt?.doctor?._id || '');

  const [payOptions, setPayOptions] = useState({ accounts: [], cards: [] });
  const [staff, setStaff] = useState([]);
  const [pay, setPay] = useState({
    paymentMethod: 'efectivo',
    bankAccount: '',
    creditCard: '',
    cardPos: '',
    recommendedBy: '',
  });

  useEffect(() => {
    api.get('/banks/payment-options')
      .then((r) => setPayOptions({ accounts: r.data?.accounts || [], cards: r.data?.cards || [] }))
      .catch(() => {});
    api.get('/users')
      .then((r) => setStaff(r.data || []))
      .catch(() => {});
  }, []);

  const items = (apt?.services || []).map((s) => ({
    product: s.product?._id || s.product,
    name: s.name || s.product?.name,
    price: Number(s.price ?? s.product?.salePrice ?? 0),
  }));
  const total = items.reduce((sum, i) => sum + i.price, 0);

  // Paso 1: marcar asistencia (sin doctor todavía)
  const markAttended = async () => {
    setBusy(true);
    try {
      await api.post(`/appointments/${apt._id}/attended`, {});
      toast.success('Paciente marcado como asistido');
      setStep('cobro');
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo marcar la asistencia');
    } finally {
      setBusy(false);
    }
  };

  // Paso 2: registrar cobro
  const charge = async () => {
    if (pay.paymentMethod === 'transferencia' && payOptions.accounts.length && !pay.bankAccount) {
      return toast.error('Selecciona la cuenta bancaria');
    }
    if (pay.paymentMethod === 'tarjeta' && payOptions.cards.length && !pay.creditCard) {
      return toast.error('Selecciona la tarjeta / POS');
    }
    setBusy(true);
    try {
      await api.post('/sales', {
        patient: apt.patient?._id || apt.patient,
        clientName: `${apt.patient?.firstName || ''} ${apt.patient?.lastName || ''}`.trim() || 'Consumidor Final',
        clientCedula: apt.patient?.cedula || '9999999999999',
        appointment: apt._id,
        paymentMethod: pay.paymentMethod,
        bankAccount: pay.paymentMethod === 'transferencia' ? pay.bankAccount || null : null,
        creditCard: pay.paymentMethod === 'tarjeta' ? pay.creditCard || null : null,
        cardPos: pay.paymentMethod === 'tarjeta' ? pay.cardPos || '' : '',
        recommendedBy: pay.recommendedBy || null,
        items: items.map((i) => ({ product: i.product, quantity: 1 })),
      });
      toast.success('Cobro registrado');
      setStep('doctor');
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo registrar el cobro');
    } finally {
      setBusy(false);
    }
  };

  // Paso 3a: asignar doctor
  const assignDoctor = async () => {
    if (!doctorId) return toast.error('Selecciona un doctor');
    setBusy(true);
    try {
      await api.post(`/appointments/${apt._id}/assign-doctor`, { doctorId });
      toast.success('Doctor asignado. Cita lista para atención.');
      onDone?.();
      onClose?.();
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo asignar el doctor');
    } finally {
      setBusy(false);
    }
  };

  // Paso 3b: cita de enfermería — no se asigna doctor
  const finishNursing = () => {
    toast.success('Cita disponible para enfermería');
    onDone?.();
    onClose?.();
  };

  const card = payOptions.cards.find((c) => c._id === pay.creditCard);

  return (
    <Modal isOpen={!!apt} onClose={onClose} title="Recepción del paciente" size="md">
      {apt && (
        <div className="space-y-4">
          {/* Cabecera paciente */}
          <div className="bg-emerald-50 rounded-xl p-3 text-sm">
            <div className="font-semibold text-slate-800">
              {apt.patient?.firstName} {apt.patient?.lastName}
            </div>
            <div className="text-xs text-slate-600 mt-1">
              Servicio: {items.map((i) => i.name).filter(Boolean).join(', ') || '—'}
            </div>
          </div>

          {/* Stepper */}
          <div className="flex items-center gap-2 text-[11px] font-semibold">
            {[
              ['asistir', '1. Asistencia'],
              ['cobro', '2. Cobro'],
              ['doctor', isNursing ? '3. Enfermería' : '3. Doctor'],
            ].map(([k, label]) => (
              <span
                key={k}
                className={`px-2.5 py-1 rounded-full ${
                  step === k ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-500'
                }`}
              >
                {label}
              </span>
            ))}
          </div>

          {/* Paso 1 */}
          {step === 'asistir' && (
            <div className="space-y-3">
              <p className="text-sm text-slate-600">
                Confirma que el paciente llegó a la clínica. Después se registrará el cobro y se derivará.
              </p>
              <div className="flex justify-end gap-2">
                <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm bg-slate-100 hover:bg-slate-200 border-none cursor-pointer">Cancelar</button>
                <button onClick={markAttended} disabled={busy} className="px-4 py-2 rounded-xl text-sm bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 border-none cursor-pointer flex items-center gap-2">
                  <HiOutlineCheckCircle className="w-4 h-4" /> Confirmar llegada
                </button>
              </div>
            </div>
          )}

          {/* Paso 2 */}
          {step === 'cobro' && (
            <div className="space-y-3">
              <div className="rounded-xl border border-slate-200 divide-y divide-slate-100">
                {items.length === 0 && (
                  <div className="px-3 py-3 text-sm text-slate-400 text-center">Esta cita no tiene servicios para cobrar.</div>
                )}
                {items.map((i, idx) => (
                  <div key={idx} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span className="text-slate-700">{i.name}</span>
                    <span className="font-mono text-slate-800">${i.price.toFixed(2)}</span>
                  </div>
                ))}
                {items.length > 0 && (
                  <div className="flex items-center justify-between px-3 py-2 text-sm font-semibold bg-slate-50">
                    <span>Total</span>
                    <span className="font-mono text-emerald-700">${total.toFixed(2)}</span>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm">Método de pago
                  <select value={pay.paymentMethod} onChange={(e) => setPay({ ...pay, paymentMethod: e.target.value, bankAccount: '', creditCard: '', cardPos: '' })} className="block w-full mt-1 border border-slate-200 rounded-xl px-3 py-2 text-sm bg-slate-50/50">
                    {Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </label>
                <label className="block text-sm">Recomendado por
                  <select value={pay.recommendedBy} onChange={(e) => setPay({ ...pay, recommendedBy: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-xl px-3 py-2 text-sm bg-slate-50/50">
                    <option value="">— Nadie —</option>
                    {staff.map((u) => <option key={u._id} value={u._id}>{u.name}</option>)}
                  </select>
                </label>
              </div>

              {pay.paymentMethod === 'transferencia' && (
                <label className="block text-sm">Cuenta bancaria
                  <select value={pay.bankAccount} onChange={(e) => setPay({ ...pay, bankAccount: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-xl px-3 py-2 text-sm bg-slate-50/50">
                    <option value="">{payOptions.accounts.length ? 'Seleccionar cuenta…' : 'No hay cuentas configuradas'}</option>
                    {payOptions.accounts.map((a) => <option key={a._id} value={a._id}>{a.name} — {a.bank}</option>)}
                  </select>
                </label>
              )}
              {pay.paymentMethod === 'tarjeta' && (
                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-sm">Tarjeta
                    <select value={pay.creditCard} onChange={(e) => setPay({ ...pay, creditCard: e.target.value, cardPos: '' })} className="block w-full mt-1 border border-slate-200 rounded-xl px-3 py-2 text-sm bg-slate-50/50">
                      <option value="">{payOptions.cards.length ? 'Seleccionar…' : 'No hay tarjetas'}</option>
                      {payOptions.cards.map((c) => <option key={c._id} value={c._id}>{c.name} ({c.brand})</option>)}
                    </select>
                  </label>
                  {card?.pos?.length > 0 && (
                    <label className="block text-sm">POS / Terminal
                      <select value={pay.cardPos} onChange={(e) => setPay({ ...pay, cardPos: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-xl px-3 py-2 text-sm bg-slate-50/50">
                        <option value="">Seleccionar POS…</option>
                        {card.pos.map((p) => <option key={p.code} value={p.code}>{p.name || p.code}</option>)}
                      </select>
                    </label>
                  )}
                </div>
              )}

              <div className="flex justify-between gap-2 pt-1">
                <button onClick={() => setStep('doctor')} className="px-3 py-2 rounded-xl text-xs text-slate-500 bg-transparent border-none cursor-pointer hover:text-slate-700" title="Si el paciente ya pagó por adelantado">
                  Omitir cobro
                </button>
                <button onClick={charge} disabled={busy || items.length === 0} className="px-4 py-2 rounded-xl text-sm bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 border-none cursor-pointer flex items-center gap-2">
                  <HiOutlineBanknotes className="w-4 h-4" /> Registrar cobro
                </button>
              </div>
            </div>
          )}

          {/* Paso 3 */}
          {step === 'doctor' && (
            isNursing ? (
              <div className="space-y-3">
                <div className="bg-sky-50 border border-sky-200 rounded-xl p-3 text-sm text-sky-800 flex items-start gap-2">
                  <HiOutlineHeart className="w-5 h-5 flex-shrink-0 mt-0.5" />
                  <span>Servicio de enfermería. La cita quedará disponible para que cualquier enfermero/a la atienda — no se asigna doctor.</span>
                </div>
                <div className="flex justify-end gap-2">
                  <button onClick={finishNursing} className="px-4 py-2 rounded-xl text-sm bg-emerald-600 text-white hover:bg-emerald-700 border-none cursor-pointer flex items-center gap-2">
                    <HiOutlineCheckCircle className="w-4 h-4" /> Finalizar
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <label className="block text-sm font-medium text-slate-700">Asignar doctor disponible *
                  <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)} className="block w-full mt-1.5 px-4 py-2.5 border border-slate-200 rounded-xl text-sm bg-slate-50/50">
                    <option value="">Seleccionar doctor</option>
                    {doctors.map((d) => <option key={d._id} value={d._id}>Dr. {d.name}{d.specialty ? ` — ${d.specialty}` : ''}</option>)}
                  </select>
                </label>
                <div className="flex justify-end gap-2">
                  <button onClick={assignDoctor} disabled={busy || !doctorId} className="px-4 py-2 rounded-xl text-sm bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 border-none cursor-pointer flex items-center gap-2">
                    <HiOutlineUserPlus className="w-4 h-4" /> Asignar doctor
                  </button>
                </div>
              </div>
            )
          )}
        </div>
      )}
    </Modal>
  );
}
