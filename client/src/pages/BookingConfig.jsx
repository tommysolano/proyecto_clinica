import { useEffect, useRef, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import {
  HiOutlineCalendarDays, HiOutlineClipboard, HiOutlineArrowPath, HiOutlinePlus,
  HiOutlineTrash, HiOutlinePhoto, HiOutlineArrowTopRightOnSquare,
} from 'react-icons/hi2';
import NumericInput from '../components/NumericInput';

const DAYS = [
  { v: 1, l: 'Lun' }, { v: 2, l: 'Mar' }, { v: 3, l: 'Mié' }, { v: 4, l: 'Jue' },
  { v: 5, l: 'Vie' }, { v: 6, l: 'Sáb' }, { v: 0, l: 'Dom' },
];

// Sube una imagen al backend y devuelve su URL pública. Usado por la portada,
// logo, galería y programas de la landing.
async function uploadImage(file) {
  if (!file) return null;
  if (file.size > 1_800_000) { toast.error('Imagen muy grande (máx ~1.8MB)'); return null; }
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  const { data } = await api.post('/booking-config/upload-image', { dataUrl, name: file.name });
  return data.url;
}

export default function BookingConfig() {
  const [cfg, setCfg] = useState(null);
  const [serviceProducts, setServiceProducts] = useState([]);
  const [programProducts, setProgramProducts] = useState([]);
  const [addProduct, setAddProduct] = useState('');
  const [addProgram, setAddProgram] = useState('');
  const [highlightInput, setHighlightInput] = useState('');

  const load = async () => {
    try {
      const [c, p] = await Promise.all([
        api.get('/booking-config'),
        api.get('/products').catch(() => ({ data: [] })),
      ]);
      setCfg(c.data);
      const all = Array.isArray(p.data) ? p.data : p.data?.items || [];
      setServiceProducts(all.filter((x) => x.category !== 'programa'));
      setProgramProducts(all.filter((x) => x.category === 'programa'));
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al cargar');
    }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    try {
      const { data } = await api.put('/booking-config', cfg);
      setCfg(data);
      toast.success('Guardado');
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al guardar');
    }
  };

  const regenerate = async () => {
    if (!window.confirm('Esto invalidará el link actual. ¿Continuar?')) return;
    try {
      const { data } = await api.post('/booking-config/regenerate-token');
      setCfg(data);
      toast.success('Nuevo link generado');
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error');
    }
  };

  if (!cfg) return <div className="p-6 text-slate-400">Cargando…</div>;

  const link = `${window.location.origin}/book/${cfg.token}`;
  const set = (patch) => setCfg({ ...cfg, ...patch });
  const toggleDay = (v) => set({ days: cfg.days.includes(v) ? cfg.days.filter((d) => d !== v) : [...cfg.days, v] });

  const addService = () => {
    if (!addProduct) return;
    const p = serviceProducts.find((x) => x._id === addProduct);
    if (!p || cfg.services.some((s) => String(s.product) === addProduct)) return;
    set({ services: [...cfg.services, { product: p._id, name: p.name, durationMinutes: 30 }] });
    setAddProduct('');
  };

  // Añade de golpe todos los servicios que aún no estén en la lista.
  const addAllServices = () => {
    const existing = new Set(cfg.services.map((s) => String(s.product)));
    const toAdd = serviceProducts
      .filter((p) => !existing.has(String(p._id)))
      .map((p) => ({ product: p._id, name: p.name, durationMinutes: 30 }));
    if (toAdd.length === 0) { toast('Ya están todos los servicios añadidos'); return; }
    set({ services: [...cfg.services, ...toAdd] });
    setAddProduct('');
    toast.success(`${toAdd.length} servicio(s) añadido(s)`);
  };

  const addProgramItem = () => {
    if (!addProgram) return;
    const p = programProducts.find((x) => x._id === addProgram);
    if (!p || (cfg.programs || []).some((s) => String(s.product) === addProgram)) return;
    set({
      programs: [...(cfg.programs || []), {
        product: p._id, name: p.name, description: p.description || '',
        imageUrl: '', priceLabel: p.salePrice ? `$${p.salePrice}` : '', durationMinutes: 60,
      }],
    });
    setAddProgram('');
  };

  // Añade de golpe todos los programas que aún no estén en la lista.
  const addAllPrograms = () => {
    const existing = new Set((cfg.programs || []).map((s) => String(s.product)));
    const toAdd = programProducts
      .filter((p) => !existing.has(String(p._id)))
      .map((p) => ({
        product: p._id, name: p.name, description: p.description || '',
        imageUrl: '', priceLabel: p.salePrice ? `$${p.salePrice}` : '', durationMinutes: 60,
      }));
    if (toAdd.length === 0) { toast('Ya están todos los programas añadidos'); return; }
    set({ programs: [...(cfg.programs || []), ...toAdd] });
    setAddProgram('');
    toast.success(`${toAdd.length} programa(s) añadido(s)`);
  };
  const updateProgram = (i, patch) => {
    const programs = [...(cfg.programs || [])];
    programs[i] = { ...programs[i], ...patch };
    set({ programs });
  };

  const addHighlight = () => {
    const v = highlightInput.trim();
    if (!v) return;
    set({ highlights: [...(cfg.highlights || []), v] });
    setHighlightInput('');
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <HiOutlineCalendarDays className="text-emerald-600" /> Auto-agendamiento
        </h1>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          Activo
        </label>
      </div>

      {/* Link público */}
      <div className="border border-slate-200 rounded-xl p-4 bg-white mb-4">
        <p className="text-sm text-slate-600 mb-2">Link público para tus pacientes:</p>
        <div className="flex gap-2 items-center">
          <input readOnly value={link} className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm bg-slate-50" />
          <button onClick={() => { navigator.clipboard.writeText(link); toast.success('Copiado'); }} className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer flex items-center gap-1"><HiOutlineClipboard /> Copiar</button>
          <a href={link} target="_blank" rel="noreferrer" title="Ver página" className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer flex items-center"><HiOutlineArrowTopRightOnSquare /></a>
          <button onClick={regenerate} title="Regenerar (invalida el actual)" className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer"><HiOutlineArrowPath /></button>
        </div>
        {!cfg.enabled && <p className="text-xs text-amber-600 mt-2">El link no funcionará hasta que actives el auto-agendamiento.</p>}
      </div>

      {/* ── Apariencia de la página ──────────────────────────── */}
      <Section title="Apariencia de la página">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Imagen de portada (hero)">
            <ImagePicker value={cfg.coverImageUrl} onChange={(url) => set({ coverImageUrl: url })} aspect="h-32" />
          </Field>
          <Field label="Logo (opcional)">
            <ImagePicker value={cfg.logoUrl} onChange={(url) => set({ logoUrl: url })} aspect="h-32" contain />
          </Field>
        </div>
        <Field label="Subtítulo (bajo el nombre)">
          <input value={cfg.tagline || ''} onChange={(e) => set({ tagline: e.target.value })} placeholder="Reserva tu cita en línea" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
        </Field>
        <Field label="Color de acento">
          <div className="flex items-center gap-2">
            <input type="color" value={cfg.primaryColor || '#059669'} onChange={(e) => set({ primaryColor: e.target.value })} className="w-10 h-9 rounded border border-slate-200 cursor-pointer p-0.5" />
            <input value={cfg.primaryColor || ''} onChange={(e) => set({ primaryColor: e.target.value })} className="w-32 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
          </div>
        </Field>
      </Section>

      {/* ── Acerca de ────────────────────────────────────────── */}
      <Section title="Acerca de la clínica">
        <Field label="Título de la sección">
          <input value={cfg.aboutTitle || ''} onChange={(e) => set({ aboutTitle: e.target.value })} placeholder="Acerca de nosotros" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
        </Field>
        <Field label="Descripción">
          <textarea value={cfg.about || ''} onChange={(e) => set({ about: e.target.value })} rows={4} placeholder="Cuenta qué es la clínica, su historia y qué la hace especial…" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
        </Field>
        <Field label="Etiquetas destacadas">
          <div className="flex flex-wrap gap-2 mb-2">
            {(cfg.highlights || []).map((h, i) => (
              <span key={i} className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs bg-slate-100 border border-slate-200">
                {h}
                <button onClick={() => set({ highlights: cfg.highlights.filter((_, j) => j !== i) })} className="text-slate-400 hover:text-red-500 bg-transparent border-none cursor-pointer p-0">×</button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input value={highlightInput} onChange={(e) => setHighlightInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addHighlight())} placeholder="Ej. Atención personalizada" className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            <button onClick={addHighlight} className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer flex items-center gap-1"><HiOutlinePlus /> Añadir</button>
          </div>
        </Field>
      </Section>

      {/* ── Programas ────────────────────────────────────────── */}
      <Section title="Programas reservables">
        <Field label="Título de la sección">
          <input value={cfg.programsTitle || ''} onChange={(e) => set({ programsTitle: e.target.value })} placeholder="Nuestros programas" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
        </Field>
        <div className="grid gap-4">
          {(cfg.programs || []).map((p, i) => (
            <div key={i} className="border border-slate-200 rounded-xl p-3 grid sm:grid-cols-[8rem,1fr] gap-3">
              <ImagePicker value={p.imageUrl} onChange={(url) => updateProgram(i, { imageUrl: url })} aspect="h-24" />
              <div className="grid gap-2">
                <div className="flex items-center gap-2">
                  <input value={p.name} onChange={(e) => updateProgram(i, { name: e.target.value })} placeholder="Nombre del programa" className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm font-medium" />
                  <button onClick={() => set({ programs: cfg.programs.filter((_, j) => j !== i) })} className="p-1 text-red-400 bg-transparent border-none cursor-pointer"><HiOutlineTrash /></button>
                </div>
                <textarea value={p.description} onChange={(e) => updateProgram(i, { description: e.target.value })} rows={2} placeholder="Descripción breve…" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-slate-500">Precio (texto)
                    <input value={p.priceLabel} onChange={(e) => updateProgram(i, { priceLabel: e.target.value })} placeholder="$54.99 por persona" className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                  </label>
                  <label className="text-xs text-slate-500">Duración (min)
                    <NumericInput value={p.durationMinutes} onChange={(e) => updateProgram(i, { durationMinutes: Number(e.target.value) })} className="w-full mt-1 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                  </label>
                </div>
              </div>
            </div>
          ))}
          {(cfg.programs || []).length === 0 && <p className="text-xs text-slate-400">Aún no agregas programas. Los clientes podrán reservarlos desde la página.</p>}
        </div>
        <div className="flex gap-2 mt-2">
          <select value={addProgram} onChange={(e) => setAddProgram(e.target.value)} className="flex-1 min-w-0 border border-slate-200 rounded-lg px-2 py-2 text-sm">
            <option value="">Añadir programa…</option>
            {programProducts.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
          </select>
          <button onClick={addProgramItem} className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer flex items-center gap-1"><HiOutlinePlus /> Añadir</button>
          <button onClick={addAllPrograms} disabled={programProducts.length === 0} className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed">Añadir todos</button>
        </div>
        {programProducts.length === 0 && <p className="text-xs text-amber-600 mt-1">No hay productos de tipo "programa". Créalos en Inventario para poder reservarlos.</p>}
      </Section>

      {/* ── Galería ──────────────────────────────────────────── */}
      <Section title="Galería de fotos">
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
          {(cfg.gallery || []).map((url, i) => (
            <div key={i} className="relative rounded-lg overflow-hidden border border-slate-200">
              <img src={url} alt={`foto ${i + 1}`} className="w-full h-24 object-cover" />
              <button onClick={() => set({ gallery: cfg.gallery.filter((_, j) => j !== i) })} className="absolute top-1 right-1 bg-white/90 border border-slate-200 rounded-full p-1 cursor-pointer text-red-500"><HiOutlineTrash className="w-3.5 h-3.5" /></button>
            </div>
          ))}
          <UploadTile onUpload={(url) => set({ gallery: [...(cfg.gallery || []), url] })} />
        </div>
      </Section>

      {/* ── Contacto (pie de la página) ──────────────────────── */}
      <Section title="Contacto">
        <p className="text-xs text-slate-400 -mt-1">Se muestra al pie de la página pública. Si dejas un campo vacío, se usa el dato de la clínica.</p>
        <Field label="Dirección">
          <input value={cfg.addressText || ''} onChange={(e) => set({ addressText: e.target.value })} placeholder="Av. Principal y calle Secundaria, Guayaquil" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
        </Field>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Teléfono / WhatsApp">
            <input value={cfg.phoneText || ''} onChange={(e) => set({ phoneText: e.target.value })} placeholder="0987654321" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
          </Field>
          <Field label="Instagram">
            <input value={cfg.instagram || ''} onChange={(e) => set({ instagram: e.target.value })} placeholder="@miclinica" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
          </Field>
        </div>
      </Section>

      {/* ── Disponibilidad ───────────────────────────────────── */}
      <Section title="Disponibilidad">
        <div>
          <p className="text-sm text-slate-600 mb-2">Días laborables</p>
          <div className="flex flex-wrap gap-2">
            {DAYS.map((d) => (
              <button key={d.v} onClick={() => toggleDay(d.v)} className={`px-3 py-1 rounded-full text-xs border cursor-pointer ${cfg.days.includes(d.v) ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>{d.l}</button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 min-w-0">
          <Field label="Desde"><input type="time" value={cfg.hourFrom} onChange={(e) => set({ hourFrom: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm" /></Field>
          <Field label="Hasta"><input type="time" value={cfg.hourTo} onChange={(e) => set({ hourTo: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm" /></Field>
          <Field label="Duración slot (min)"><NumericInput value={cfg.slotMinutes} onChange={(e) => set({ slotMinutes: Number(e.target.value) })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm" /></Field>
          <Field label="Citas por slot"><NumericInput value={cfg.maxPerSlot} onChange={(e) => set({ maxPerSlot: Number(e.target.value) })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm" /></Field>
        </div>

        <Field label="Reservable hasta (días adelante)">
          <NumericInput value={cfg.horizonDays} onChange={(e) => set({ horizonDays: Number(e.target.value) })} className="w-32 border border-slate-200 rounded-lg px-2 py-2 text-sm" />
        </Field>

        <div>
          <p className="text-sm text-slate-600 mb-2">Servicios reservables</p>
          <div className="grid gap-2 mb-2">
            {cfg.services.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="flex-1 text-sm">{s.name}</span>
                <NumericInput value={s.durationMinutes} onChange={(e) => { const ss = [...cfg.services]; ss[i] = { ...ss[i], durationMinutes: Number(e.target.value) }; set({ services: ss }); }} className="w-20 border border-slate-200 rounded-lg px-2 py-1 text-sm" />
                <span className="text-xs text-slate-400">min</span>
                <button onClick={() => set({ services: cfg.services.filter((_, j) => j !== i) })} className="p-1 text-red-400 bg-transparent border-none cursor-pointer"><HiOutlineTrash /></button>
              </div>
            ))}
            {cfg.services.length === 0 && <p className="text-xs text-slate-400">Agrega al menos un servicio para poder reservar.</p>}
          </div>
          <div className="flex gap-2">
            <select value={addProduct} onChange={(e) => setAddProduct(e.target.value)} className="flex-1 min-w-0 border border-slate-200 rounded-lg px-2 py-2 text-sm">
              <option value="">Añadir servicio…</option>
              {serviceProducts.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
            </select>
            <button onClick={addService} className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer flex items-center gap-1"><HiOutlinePlus /> Añadir</button>
            <button onClick={addAllServices} disabled={serviceProducts.length === 0} className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed">Añadir todos</button>
          </div>
        </div>

        <Field label="Mensaje de confirmación">
          <textarea value={cfg.confirmationMessage} onChange={(e) => set({ confirmationMessage: e.target.value })} rows={2} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
        </Field>
      </Section>

      <div className="flex justify-end mt-4">
        <button onClick={save} className="px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm cursor-pointer border-none">Guardar</button>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="grid grid-cols-1 gap-4 border border-slate-200 rounded-xl p-4 bg-white mb-4">
      <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="text-sm block min-w-0">
      <span className="text-slate-600">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

// Selector de imagen única: muestra la imagen actual o un botón para subir.
function ImagePicker({ value, onChange, aspect = 'h-28', contain = false }) {
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const pick = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const url = await uploadImage(file);
      if (url) onChange(url);
    } catch {
      toast.error('Error al subir imagen');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`relative ${aspect} rounded-lg border border-dashed border-slate-300 overflow-hidden bg-slate-50`}>
      {value ? (
        <>
          <img src={value} alt="" className={`w-full h-full ${contain ? 'object-contain' : 'object-cover'}`} />
          <button onClick={() => onChange('')} className="absolute top-1 right-1 bg-white/90 border border-slate-200 rounded-full p-1 cursor-pointer text-red-500"><HiOutlineTrash className="w-3.5 h-3.5" /></button>
        </>
      ) : (
        <button onClick={() => inputRef.current?.click()} className="w-full h-full flex flex-col items-center justify-center gap-1 text-slate-400 bg-transparent border-none cursor-pointer text-xs">
          <HiOutlinePhoto className="w-6 h-6" />
          {busy ? 'Subiendo…' : 'Subir imagen'}
        </button>
      )}
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
    </div>
  );
}

// Cuadro de "añadir" para la galería.
function UploadTile({ onUpload }) {
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const pick = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const url = await uploadImage(file);
      if (url) onUpload(url);
    } catch {
      toast.error('Error al subir imagen');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button onClick={() => inputRef.current?.click()} className="h-24 rounded-lg border border-dashed border-slate-300 flex flex-col items-center justify-center gap-1 text-slate-400 bg-slate-50 cursor-pointer text-xs">
        <HiOutlinePhoto className="w-6 h-6" />
        {busy ? 'Subiendo…' : 'Añadir foto'}
      </button>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
    </>
  );
}
