import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineCalendarDays, HiOutlineClipboard, HiOutlineArrowPath, HiOutlinePlus, HiOutlineTrash } from 'react-icons/hi2';

const DAYS = [
  { v: 1, l: 'Lun' }, { v: 2, l: 'Mar' }, { v: 3, l: 'Mié' }, { v: 4, l: 'Jue' },
  { v: 5, l: 'Vie' }, { v: 6, l: 'Sáb' }, { v: 0, l: 'Dom' },
];

export default function BookingConfig() {
  const [cfg, setCfg] = useState(null);
  const [products, setProducts] = useState([]);
  const [addProduct, setAddProduct] = useState('');

  const load = async () => {
    try {
      const [c, p] = await Promise.all([
        api.get('/booking-config'),
        api.get('/products').catch(() => ({ data: [] })),
      ]);
      setCfg(c.data);
      setProducts((Array.isArray(p.data) ? p.data : p.data?.items || []).filter((x) => x.category !== 'programa'));
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
  const toggleDay = (v) => setCfg({ ...cfg, days: cfg.days.includes(v) ? cfg.days.filter((d) => d !== v) : [...cfg.days, v] });
  const addService = () => {
    if (!addProduct) return;
    const p = products.find((x) => x._id === addProduct);
    if (!p || cfg.services.some((s) => String(s.product) === addProduct)) return;
    setCfg({ ...cfg, services: [...cfg.services, { product: p._id, name: p.name, durationMinutes: 30 }] });
    setAddProduct('');
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <HiOutlineCalendarDays className="text-emerald-600" /> Auto-agendamiento
        </h1>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
          Activo
        </label>
      </div>

      <div className="border border-slate-200 rounded-xl p-4 bg-white mb-4">
        <p className="text-sm text-slate-600 mb-2">Link público para tus pacientes:</p>
        <div className="flex gap-2 items-center">
          <input readOnly value={link} className="flex-1 border border-slate-200 rounded-lg px-3 py-2 text-sm bg-slate-50" />
          <button onClick={() => { navigator.clipboard.writeText(link); toast.success('Copiado'); }} className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer flex items-center gap-1"><HiOutlineClipboard /> Copiar</button>
          <button onClick={regenerate} title="Regenerar (invalida el actual)" className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer"><HiOutlineArrowPath /></button>
        </div>
        {!cfg.enabled && <p className="text-xs text-amber-600 mt-2">El link no funcionará hasta que actives el auto-agendamiento.</p>}
      </div>

      <div className="grid gap-4 border border-slate-200 rounded-xl p-4 bg-white">
        <div>
          <p className="text-sm text-slate-600 mb-2">Días laborables</p>
          <div className="flex flex-wrap gap-2">
            {DAYS.map((d) => (
              <button key={d.v} onClick={() => toggleDay(d.v)} className={`px-3 py-1 rounded-full text-xs border cursor-pointer ${cfg.days.includes(d.v) ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>{d.l}</button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-4 gap-3">
          <Field label="Desde"><input type="time" value={cfg.hourFrom} onChange={(e) => setCfg({ ...cfg, hourFrom: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm" /></Field>
          <Field label="Hasta"><input type="time" value={cfg.hourTo} onChange={(e) => setCfg({ ...cfg, hourTo: e.target.value })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm" /></Field>
          <Field label="Duración slot (min)"><input type="number" value={cfg.slotMinutes} onChange={(e) => setCfg({ ...cfg, slotMinutes: Number(e.target.value) })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm" /></Field>
          <Field label="Citas por slot"><input type="number" value={cfg.maxPerSlot} onChange={(e) => setCfg({ ...cfg, maxPerSlot: Number(e.target.value) })} className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm" /></Field>
        </div>

        <Field label="Reservable hasta (días adelante)">
          <input type="number" value={cfg.horizonDays} onChange={(e) => setCfg({ ...cfg, horizonDays: Number(e.target.value) })} className="w-32 border border-slate-200 rounded-lg px-2 py-2 text-sm" />
        </Field>

        <div>
          <p className="text-sm text-slate-600 mb-2">Servicios reservables</p>
          <div className="grid gap-2 mb-2">
            {cfg.services.map((s, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="flex-1 text-sm">{s.name}</span>
                <input type="number" value={s.durationMinutes} onChange={(e) => { const ss = [...cfg.services]; ss[i] = { ...ss[i], durationMinutes: Number(e.target.value) }; setCfg({ ...cfg, services: ss }); }} className="w-20 border border-slate-200 rounded-lg px-2 py-1 text-sm" />
                <span className="text-xs text-slate-400">min</span>
                <button onClick={() => setCfg({ ...cfg, services: cfg.services.filter((_, j) => j !== i) })} className="p-1 text-red-400 bg-transparent border-none cursor-pointer"><HiOutlineTrash /></button>
              </div>
            ))}
            {cfg.services.length === 0 && <p className="text-xs text-slate-400">Agrega al menos un servicio para poder reservar.</p>}
          </div>
          <div className="flex gap-2">
            <select value={addProduct} onChange={(e) => setAddProduct(e.target.value)} className="flex-1 border border-slate-200 rounded-lg px-2 py-2 text-sm">
              <option value="">Añadir servicio…</option>
              {products.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
            </select>
            <button onClick={addService} className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white cursor-pointer flex items-center gap-1"><HiOutlinePlus /> Añadir</button>
          </div>
        </div>

        <Field label="Mensaje de confirmación">
          <textarea value={cfg.confirmationMessage} onChange={(e) => setCfg({ ...cfg, confirmationMessage: e.target.value })} rows={2} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
        </Field>
      </div>

      <div className="flex justify-end mt-4">
        <button onClick={save} className="px-5 py-2 bg-emerald-600 text-white rounded-lg text-sm cursor-pointer border-none">Guardar</button>
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
