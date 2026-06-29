import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/axios';

// Página pública de auto-agendamiento (sin autenticación): /book/:token
// Estilo landing (inspirado en OpenTable): hero con portada, acerca de,
// programas reservables ("experiencias"), galería de fotos y una tarjeta de
// reserva fija. Todo el contenido se configura desde /booking-config.
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
  const [lightbox, setLightbox] = useState(null);
  const reserveRef = useRef(null);

  useEffect(() => {
    api.get(`/public/booking/${token}`)
      .then(({ data }) => setInfo(data))
      .catch((e) => setError(e.response?.data?.message || 'Agenda no disponible'));
  }, [token]);

  const accent = info?.primaryColor || '#059669';

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
    } catch {
      setSlots([]);
    }
  };

  const pickService = (productId) => {
    setService(productId);
    loadSlots(date, productId);
    reserveRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      window.scrollTo({ top: 0, behavior: 'smooth' });
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

  const services = info.services || [];
  const programs = info.programs || [];
  const gallery = info.gallery || [];
  const highlights = info.highlights || [];
  const selectedName =
    services.find((s) => String(s.product) === String(service))?.name ||
    programs.find((p) => String(p.product) === String(service))?.name || '';

  return (
    <div className="min-h-screen bg-white">
      {/* ── Hero ─────────────────────────────────────────────── */}
      <header className="relative">
        <div className="h-72 sm:h-96 w-full overflow-hidden bg-slate-200">
          {info.coverImageUrl ? (
            <img src={info.coverImageUrl} alt={info.clinicName} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full" style={{ background: `linear-gradient(135deg, ${accent}, #0f172a)` }} />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
        </div>
        <div className="absolute bottom-0 left-0 right-0">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-6 text-white">
            {info.logoUrl && (
              <img src={info.logoUrl} alt="logo" className="w-16 h-16 rounded-2xl object-cover border-2 border-white/80 shadow-lg mb-3 bg-white" />
            )}
            <h1 className="text-3xl sm:text-5xl font-bold drop-shadow-sm">{info.clinicName}</h1>
            {info.tagline && <p className="mt-2 text-base sm:text-lg text-white/90 max-w-2xl">{info.tagline}</p>}
            {highlights.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-4">
                {highlights.map((h, i) => (
                  <span key={i} className="px-3 py-1 rounded-full text-xs sm:text-sm bg-white/15 backdrop-blur border border-white/25">{h}</span>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 grid lg:grid-cols-3 gap-8">
        {/* ── Columna de contenido ─────────────────────────────── */}
        <div className="lg:col-span-2 space-y-10 order-2 lg:order-1">
          {info.about && (
            <section>
              <h2 className="text-xl font-bold text-slate-800 mb-3">{info.aboutTitle || 'Acerca de nosotros'}</h2>
              <p className="text-slate-600 leading-relaxed whitespace-pre-line">{info.about}</p>
            </section>
          )}

          {programs.length > 0 && (
            <section>
              <h2 className="text-xl font-bold text-slate-800 mb-4">{info.programsTitle || 'Nuestros programas'}</h2>
              <div className="grid sm:grid-cols-2 gap-5">
                {programs.map((p) => (
                  <article key={String(p.product)} className="rounded-2xl border border-slate-200 overflow-hidden flex flex-col bg-white shadow-sm">
                    {p.imageUrl && (
                      <img src={p.imageUrl} alt={p.name} className="w-full h-40 object-cover" />
                    )}
                    <div className="p-4 flex flex-col flex-1">
                      <h3 className="font-semibold text-slate-800">{p.name}</h3>
                      <div className="flex flex-wrap gap-3 mt-2 text-xs text-slate-500">
                        {p.priceLabel && <span className="font-medium text-slate-700">{p.priceLabel}</span>}
                        {p.durationMinutes ? <span>· {p.durationMinutes} min</span> : null}
                      </div>
                      {p.description && <p className="text-sm text-slate-600 mt-2 flex-1">{p.description}</p>}
                      <button
                        onClick={() => pickService(p.product)}
                        className="mt-4 py-2 rounded-lg text-sm font-medium text-white border-none cursor-pointer self-start px-5"
                        style={{ background: accent }}
                      >
                        Reservar
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {gallery.length > 0 && (
            <section>
              <h2 className="text-xl font-bold text-slate-800 mb-4">Fotos</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {gallery.map((url, i) => (
                  <button key={i} onClick={() => setLightbox(url)} className="block p-0 border-none cursor-pointer rounded-xl overflow-hidden bg-slate-100">
                    <img src={url} alt={`foto ${i + 1}`} className="w-full h-32 sm:h-40 object-cover hover:opacity-90 transition" />
                  </button>
                ))}
              </div>
            </section>
          )}

          {(info.address || info.phone || info.instagram) && (
            <section className="border-t border-slate-100 pt-6 text-sm text-slate-500 space-y-1">
              {info.address && <p>📍 {info.address}</p>}
              {info.phone && <p>📞 {info.phone}</p>}
              {info.instagram && <p>📷 {info.instagram}</p>}
            </section>
          )}
        </div>

        {/* ── Tarjeta de reserva ───────────────────────────────── */}
        <div className="lg:col-span-1 order-1 lg:order-2">
          <div ref={reserveRef} className="lg:sticky lg:top-6 rounded-2xl border border-slate-200 shadow-sm bg-white p-5 scroll-mt-6">
            {done ? (
              <div className="text-center py-6">
                <div className="text-4xl mb-3">✅</div>
                <h2 className="text-lg font-bold text-slate-800 mb-2">¡Cita agendada!</h2>
                <p className="text-slate-600 text-sm">{done.message}</p>
                <p className="text-xs text-slate-400 mt-3">
                  {done.appointment.service} · {new Date(done.appointment.date + 'T12:00').toLocaleDateString('es-EC', { weekday: 'long', day: 'numeric', month: 'long' })} · {done.appointment.startTime}
                </p>
              </div>
            ) : (
              <>
                <h2 className="text-lg font-bold text-slate-800">Reserva tu cita</h2>
                <p className="text-xs text-slate-500 mb-4">Elige servicio, fecha y hora.</p>

                <div className="grid gap-4">
                  <Field label="Servicio">
                    <select value={service} onChange={(e) => { setService(e.target.value); loadSlots(date, e.target.value); }} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm">
                      <option value="">Selecciona…</option>
                      {services.length > 0 && (
                        <optgroup label="Servicios">
                          {services.map((s) => <option key={String(s.product)} value={s.product}>{s.name} ({s.durationMinutes} min)</option>)}
                        </optgroup>
                      )}
                      {programs.length > 0 && (
                        <optgroup label="Programas">
                          {programs.map((p) => <option key={String(p.product)} value={p.product}>{p.name} ({p.durationMinutes} min)</option>)}
                        </optgroup>
                      )}
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
                        <div className="grid grid-cols-3 gap-2">
                          {slots.map((s) => (
                            <button
                              key={s}
                              type="button"
                              onClick={() => setSlot(s)}
                              className="py-1.5 rounded-lg text-sm border cursor-pointer"
                              style={slot === s
                                ? { background: accent, color: '#fff', borderColor: accent }
                                : { background: '#fff', color: '#475569', borderColor: '#e2e8f0' }}
                            >
                              {s}
                            </button>
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
                      <Field label="Teléfono / WhatsApp"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="0987654321" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" /></Field>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Cédula (opcional)"><input value={form.cedula} onChange={(e) => setForm({ ...form, cedula: e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" /></Field>
                        <Field label="Email (opcional)"><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" /></Field>
                      </div>

                      {error && <p className="text-sm text-red-500">{error}</p>}
                      <button onClick={submit} disabled={submitting} className="w-full py-2.5 text-white rounded-lg font-medium cursor-pointer border-none disabled:opacity-50" style={{ background: accent }}>
                        {submitting ? 'Agendando…' : `Confirmar cita${selectedName ? ` · ${selectedName}` : ''}`}
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </main>

      {lightbox && (
        <div onClick={() => setLightbox(null)} className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4 cursor-zoom-out">
          <img src={lightbox} alt="foto" className="max-w-full max-h-full rounded-lg" />
        </div>
      )}
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
