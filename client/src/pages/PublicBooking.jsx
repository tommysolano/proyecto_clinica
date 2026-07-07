import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/axios';
import { sanitizeHtml } from '../utils/sanitizeHtml';
import SriStatus from '../components/SriStatus';
import useSriLookup from '../hooks/useSriLookup';

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
  const [programModal, setProgramModal] = useState(null);
  const reserveRef = useRef(null);

  // Autocompletado por cédula/RUC desde el SRI (nombre/apellido), vía el endpoint
  // público gated por el token de la agenda.
  const cedulaLookup = useSriLookup(form.cedula, {
    enabled: !!slot,
    endpoint: (id) => `/public/booking/${token}/lookup/${id}`,
    onData: (d) => {
      if (!d.found) return;
      setForm((f) => ({
        ...f,
        firstName: f.firstName?.trim() ? f.firstName : d.firstName || '',
        lastName: f.lastName?.trim() ? f.lastName : d.lastName || '',
      }));
    },
  });

  useEffect(() => {
    api.get(`/public/booking/${token}`)
      .then(({ data }) => setInfo(data))
      .catch((e) => setError(e.response?.data?.message || 'Agenda no disponible'));
  }, [token]);

  const accent = info?.primaryColor || '#059669';

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
                  <ProgramCard
                    key={String(p.product)}
                    p={p}
                    accent={accent}
                    onReserve={pickService}
                    onOpen={() => setProgramModal(p)}
                  />
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
                    <ServiceCombobox
                      services={services}
                      programs={programs}
                      value={service}
                      onChange={(id) => { setService(id); loadSlots(date, id); }}
                      accent={accent}
                    />
                  </Field>

                  <Field label="Fecha">
                    <DateCalendar
                      value={date}
                      onChange={(iso) => { setDate(iso); loadSlots(iso, service); }}
                      allowedDays={info.days || []}
                      horizonDays={info.horizonDays}
                      accent={accent}
                    />
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
                        <Field label="Cédula (opcional)"><input value={form.cedula} onChange={(e) => setForm({ ...form, cedula: e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" inputMode="numeric" maxLength={13} /><SriStatus status={cedulaLookup} /></Field>
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

      {programModal && (
        <ProgramModal
          p={programModal}
          accent={accent}
          onReserve={(id) => { setProgramModal(null); pickService(id); }}
          onClose={() => setProgramModal(null)}
        />
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

// Tarjeta de programa de altura fija. La descripción se recorta con "…" y solo
// se muestra "Ver más" cuando el texto realmente desborda; abre el modal.
function ProgramCard({ p, accent, onReserve, onOpen }) {
  const descRef = useRef(null);
  const [overflow, setOverflow] = useState(false);

  useEffect(() => {
    const el = descRef.current;
    if (!el) return;
    const check = () => setOverflow(el.scrollHeight > el.clientHeight + 1);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [p.description]);

  return (
    <article className="rounded-2xl border border-slate-200 overflow-hidden flex flex-col bg-white shadow-sm h-[420px]">
      {p.imageUrl && (
        <button type="button" onClick={onOpen} className="block p-0 border-none cursor-pointer shrink-0">
          <img src={p.imageUrl} alt={p.name} className="w-full h-40 object-cover" />
        </button>
      )}
      <div className="p-4 flex flex-col flex-1 min-h-0">
        <h3
          onClick={onOpen}
          className="font-semibold text-slate-800 line-clamp-2 cursor-pointer"
        >
          {p.name}
        </h3>
        <div className="flex flex-wrap gap-3 mt-2 text-xs text-slate-500 shrink-0">
          {p.priceLabel && <span className="font-medium text-slate-700">{p.priceLabel}</span>}
          {p.durationMinutes ? <span>· {p.durationMinutes} min</span> : null}
        </div>
        {p.description && (
          <div
            ref={descRef}
            className="text-sm text-slate-600 mt-2 line-clamp-6 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(p.description) }}
          />
        )}
        <div className="mt-auto pt-3 flex items-center gap-4 shrink-0">
          <button
            onClick={() => onReserve(p.product)}
            className="py-2 rounded-lg text-sm font-medium text-white border-none cursor-pointer px-5"
            style={{ background: accent }}
          >
            Reservar
          </button>
          {overflow && (
            <button
              onClick={onOpen}
              className="text-sm font-medium bg-transparent border-none cursor-pointer p-0 hover:underline"
              style={{ color: accent }}
            >
              Ver más
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

// Modal con toda la info del programa + opción de reservar.
function ProgramModal({ p, accent, onReserve, onClose }) {
  useEffect(() => {
    const onEsc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [onClose]);

  return (
    <div onClick={onClose} className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
        {p.imageUrl && <img src={p.imageUrl} alt={p.name} className="w-full h-52 object-cover shrink-0" />}
        <div className="p-5 overflow-y-auto">
          <h3 className="text-lg font-bold text-slate-800">{p.name}</h3>
          <div className="flex flex-wrap gap-3 mt-2 text-sm text-slate-500">
            {p.priceLabel && <span className="font-medium text-slate-700">{p.priceLabel}</span>}
            {p.durationMinutes ? <span>· {p.durationMinutes} min</span> : null}
          </div>
          {p.description && (
            <div
              className="text-sm text-slate-600 mt-3 leading-relaxed [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(p.description) }}
            />
          )}
        </div>
        <div className="p-4 border-t border-slate-100 flex justify-end gap-2 shrink-0">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm bg-slate-100 text-slate-600 border-none cursor-pointer">Cerrar</button>
          <button
            onClick={() => onReserve(p.product)}
            className="px-5 py-2 rounded-lg text-sm font-medium text-white border-none cursor-pointer"
            style={{ background: accent }}
          >
            Reservar
          </button>
        </div>
      </div>
    </div>
  );
}

// Buscador autocompletable de servicios/programas: el usuario escribe y la
// lista se filtra en vivo, en vez de desplegar todo el catálogo.
function ServiceCombobox({ services, programs, value, onChange, accent }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const options = [
    ...services.map((s) => ({ id: String(s.product), name: s.name, duration: s.durationMinutes, group: 'Servicios' })),
    ...programs.map((p) => ({ id: String(p.product), name: p.name, duration: p.durationMinutes, group: 'Programas' })),
  ];
  const selected = options.find((o) => o.id === String(value));

  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options;
  const groups = ['Servicios', 'Programas'].filter((g) => filtered.some((o) => o.group === g));

  const pick = (o) => { onChange(o.id); setQuery(''); setOpen(false); };

  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <input
          value={open ? query : (selected ? selected.name : '')}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => { setQuery(''); setOpen(true); }}
          placeholder="Escribe para buscar un servicio…"
          className="w-full border border-slate-200 rounded-lg pl-3 pr-8 py-2 text-sm"
        />
        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
          {selected && !open ? '▾' : '🔍'}
        </span>
      </div>
      {open && (
        <div className="absolute z-20 mt-1 w-full max-h-60 overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {filtered.length === 0 ? (
            <p className="px-3 py-3 text-sm text-slate-400">Sin coincidencias</p>
          ) : (
            groups.map((g) => (
              <div key={g}>
                <p className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{g}</p>
                {filtered.filter((o) => o.group === g).map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => pick(o)}
                    className="w-full text-left px-3 py-2 text-sm cursor-pointer border-none bg-transparent hover:bg-slate-50 flex items-center justify-between gap-2"
                    style={o.id === String(value) ? { background: `${accent}14`, color: accent } : undefined}
                  >
                    <span>{o.name}</span>
                    {o.duration ? <span className="text-xs text-slate-400 shrink-0">{o.duration} min</span> : null}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// Calendario mensual: se elige el día directamente. Días pasados, fuera del
// horizonte de reserva o no laborables salen desactivados.
function DateCalendar({ value, onChange, allowedDays, horizonDays, accent }) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const maxDate = new Date(today); maxDate.setDate(maxDate.getDate() + (horizonDays || 30));
  const [view, setView] = useState(() => {
    const base = value ? new Date(value + 'T12:00') : today;
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });

  const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const leading = (view.getDay() + 6) % 7; // rejilla empieza en lunes
  const cells = [];
  for (let i = 0; i < leading; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(view.getFullYear(), view.getMonth(), d));

  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const isAllowed = (d) => d >= today && d <= maxDate && (allowedDays || []).includes(d.getDay());

  const canPrev = view.getFullYear() > today.getFullYear() || (view.getFullYear() === today.getFullYear() && view.getMonth() > today.getMonth());
  const maxMonth = new Date(maxDate.getFullYear(), maxDate.getMonth(), 1);
  const canNext = view < maxMonth;
  const goMonth = (delta) => setView(new Date(view.getFullYear(), view.getMonth() + delta, 1));

  return (
    <div className="border border-slate-200 rounded-lg p-3 select-none">
      <div className="flex items-center justify-between mb-2">
        <button type="button" disabled={!canPrev} onClick={() => goMonth(-1)}
          className="w-7 h-7 rounded-md text-slate-500 enabled:hover:bg-slate-100 enabled:cursor-pointer disabled:text-slate-300 border-none bg-transparent">‹</button>
        <span className="text-sm font-medium text-slate-700 capitalize">
          {view.toLocaleDateString('es-EC', { month: 'long', year: 'numeric' })}
        </span>
        <button type="button" disabled={!canNext} onClick={() => goMonth(1)}
          className="w-7 h-7 rounded-md text-slate-500 enabled:hover:bg-slate-100 enabled:cursor-pointer disabled:text-slate-300 border-none bg-transparent">›</button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-slate-400 mb-1">
        {['lu', 'ma', 'mi', 'ju', 'vi', 'sá', 'do'].map((d, i) => <span key={i}>{d}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (!d) return <span key={i} />;
          const selected = value === iso(d);
          const allowed = isAllowed(d);
          return (
            <button
              key={i}
              type="button"
              disabled={!allowed}
              onClick={() => onChange(iso(d))}
              className={`h-9 rounded-lg text-sm border-none ${
                allowed ? 'text-slate-700 hover:bg-slate-100 cursor-pointer' : 'text-slate-300 cursor-not-allowed line-through'
              }`}
              style={selected ? { background: accent, color: '#fff' } : { background: 'transparent' }}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Centered({ children }) {
  return <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">{children}</div>;
}
