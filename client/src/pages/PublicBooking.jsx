import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/axios';

// Página pública de auto-agendamiento (sin autenticación): /book/:token
export default function PublicBooking() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [service, setService] = useState('');
  const [date, setDate] = useState('');
  const [slots, setSlots] = useState(null);
  const [slot, setSlot] = useState('');
  const [form, setForm] = useState({ firstName: '', lastName: '', phone: '', cedula: '', email: '' });
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    api.get(`/public/booking/${token}`)
      .then(({ data }) => setInfo(data))
      .catch((e) => setError(e.response?.data?.message || 'Agenda no disponible'));
  }, [token]);

  // Fechas seleccionables: hoy .. horizonDays, solo días laborables.
  const dateOptions = [];
  if (info) {
    const today = new Date();
    for (let i = 0; i <= (info.horizonDays || 30); i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      if (info.days.includes(d.getDay())) {
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        dateOptions.push({ iso, label: d.toLocaleDateString('es-EC', { weekday: 'short', day: 'numeric', month: 'short' }) });
      }
    }
  }

  const loadSlots = async (d, svc) => {
    setSlots(null);
    setSlot('');
    if (!d || !svc) return;
    try {
      const { data } = await api.get(`/public/booking/${token}/slots?date=${d}&service=${svc}`);
      setSlots(data.slots);
    } catch (e) {
      setSlots([]);
    }
  };

  const submit = async () => {
    if (!service || !date || !slot) return;
    if (!form.firstName.trim() || !form.lastName.trim() || !form.phone.trim()) {
      setError('Completa nombre, apellido y teléfono');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const { data } = await api.post(`/public/booking/${token}`, { date, startTime: slot, service, ...form });
      setDone(data);
    } catch (e) {
      setError(e.response?.data?.message || 'No se pudo agendar');
    } finally {
      setSubmitting(false);
    }
  };

  if (error && !info) {
    return <Centered><h2 className="text-xl font-semibold text-slate-700">{error}</h2></Centered>;
  }
  if (!info) return <Centered><p className="text-slate-400">Cargando…</p></Centered>;

  if (done) {
    return (
      <Centered>
        <div className="text-center">
          <div className="text-4xl mb-3">✅</div>
          <h2 className="text-xl font-bold text-slate-800 mb-2">¡Cita agendada!</h2>
          <p className="text-slate-600">{done.message}</p>
          <p className="text-sm text-slate-400 mt-3">
            {done.appointment.service} · {new Date(done.appointment.date + 'T12:00').toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long' })} · {done.appointment.startTime}
          </p>
        </div>
      </Centered>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 py-10 px-4">
      <div className="max-w-lg mx-auto bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
        <h1 className="text-2xl font-bold text-slate-800">{info.clinicName}</h1>
        <p className="text-sm text-slate-500 mb-6">Reserva tu cita en línea</p>

        <div className="grid gap-4">
          <Field label="Servicio">
            <select value={service} onChange={(e) => { setService(e.target.value); loadSlots(date, e.target.value); }} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm">
              <option value="">Selecciona…</option>
              {info.services.map((s) => <option key={s.product} value={s.product}>{s.name} ({s.durationMinutes} min)</option>)}
            </select>
          </Field>

          <Field label="Fecha">
            <select value={date} onChange={(e) => { setDate(e.target.value); loadSlots(e.target.value, service); }} disabled={!service} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm disabled:bg-slate-50">
              <option value="">Selecciona…</option>
              {dateOptions.map((d) => <option key={d.iso} value={d.iso}>{d.label}</option>)}
            </select>
          </Field>

          {date && service && (
            <Field label="Hora">
              {slots === null ? (
                <p className="text-sm text-slate-400">Cargando horarios…</p>
              ) : slots.length === 0 ? (
                <p className="text-sm text-amber-600">No hay horarios disponibles ese día.</p>
              ) : (
                <div className="grid grid-cols-4 gap-2">
                  {slots.map((s) => (
                    <button key={s} type="button" onClick={() => setSlot(s)} className={`py-1.5 rounded-lg text-sm border cursor-pointer ${slot === s ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>{s}</button>
                  ))}
                </div>
              )}
            </Field>
          )}

          {slot && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Nombre"><input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" /></Field>
                <Field label="Apellido"><input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" /></Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Teléfono / WhatsApp"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="0987654321" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" /></Field>
                <Field label="Cédula (opcional)"><input value={form.cedula} onChange={(e) => setForm({ ...form, cedula: e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" /></Field>
              </div>
              <Field label="Email (opcional)"><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" /></Field>

              {error && <p className="text-sm text-red-500">{error}</p>}
              <button onClick={submit} disabled={submitting} className="w-full py-2.5 bg-emerald-600 text-white rounded-lg font-medium cursor-pointer border-none disabled:opacity-50">
                {submitting ? 'Agendando…' : 'Confirmar cita'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="text-sm block">
      <span className="text-slate-600">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Centered({ children }) {
  return <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">{children}</div>;
}
