import { useState, useEffect, useRef } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { HiOutlineCog6Tooth, HiOutlineKey, HiOutlineSwatch, HiOutlinePencilSquare } from 'react-icons/hi2';

const THEMES = [
  { value: 'green', label: 'Verde (por defecto)', swatch: '#0f766e' },
  { value: 'purple', label: 'Lila', swatch: '#b284be' },
  { value: 'blue', label: 'Azul', swatch: '#2563eb' },
  { value: 'rose', label: 'Rosa', swatch: '#e11d48' },
];

function applyTheme(theme) {
  if (!theme || theme === 'green') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
  localStorage.setItem('theme', theme);
}

export default function Settings() {
  const { user, hasRole } = useAuth();
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'green');
  const [pwd, setPwd] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [saving, setSaving] = useState(false);
  // Firma digital (doctor / óptica)
  const showSignature = hasRole('doctor', 'optica') || user?.isSuperAdmin;
  const [signature, setSignature] = useState('');
  const [savingSig, setSavingSig] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!showSignature) return;
    api.get('/users/me/signature').then((r) => setSignature(r.data?.signatureImage || '')).catch(() => {});
  }, [showSignature]);

  const onPickSignature = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!/^image\/(png|jpe?g|webp)$/.test(f.type)) {
      toast.error('Solo PNG, JPG o WEBP');
      return;
    }
    if (f.size > 300 * 1024) {
      toast.error('Máximo 300KB');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => setSignature(ev.target.result);
    reader.readAsDataURL(f);
  };

  const saveSignature = async () => {
    setSavingSig(true);
    try {
      await api.put('/users/me/signature', { signatureImage: signature });
      toast.success('Firma actualizada');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar firma');
    } finally {
      setSavingSig(false);
    }
  };

  const removeSignature = async () => {
    if (!window.confirm('¿Eliminar tu firma actual?')) return;
    setSavingSig(true);
    try {
      await api.put('/users/me/signature', { signatureImage: '' });
      setSignature('');
      toast.success('Firma eliminada');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    } finally {
      setSavingSig(false);
    }
  };

  const chooseTheme = (t) => {
    setTheme(t);
    applyTheme(t);
    toast.success('Paleta de colores actualizada');
  };

  const submitPassword = async (e) => {
    e.preventDefault();
    if (pwd.newPassword.length < 6) {
      toast.error('La nueva contraseña debe tener al menos 6 caracteres');
      return;
    }
    if (pwd.newPassword !== pwd.confirm) {
      toast.error('Las contraseñas no coinciden');
      return;
    }
    setSaving(true);
    try {
      await api.post('/auth/change-password', {
        currentPassword: pwd.currentPassword,
        newPassword: pwd.newPassword,
      });
      toast.success('Contraseña actualizada');
      setPwd({ currentPassword: '', newPassword: '', confirm: '' });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cambiar contraseña');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
        <HiOutlineCog6Tooth className="text-emerald-600" /> Configuración
      </h1>

      {/* Paleta de colores */}
      <div className="bg-white rounded-2xl border border-emerald-100 p-6">
        <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2 mb-1">
          <HiOutlineSwatch className="text-emerald-600" /> Paleta de colores
        </h2>
        <p className="text-sm text-slate-500 mb-4">
          Cambia el color principal de toda la plataforma. Se guarda en este dispositivo.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {THEMES.map((t) => (
            <button
              key={t.value}
              onClick={() => chooseTheme(t.value)}
              className={`flex items-center gap-3 p-3 rounded-xl border-2 cursor-pointer bg-white transition-all ${
                theme === t.value ? 'border-emerald-500 shadow-md' : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <span className="w-8 h-8 rounded-full flex-shrink-0" style={{ backgroundColor: t.swatch }} />
              <span className="text-sm font-medium text-slate-700 text-left">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Firma digital (doctor / óptica) */}
      {showSignature && (
        <div className="bg-white rounded-2xl border border-emerald-100 p-6">
          <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2 mb-1">
            <HiOutlinePencilSquare className="text-emerald-600" /> Firma digital
          </h2>
          <p className="text-sm text-slate-500 mb-4">
            Esta imagen aparecerá al final de las recetas que emitas (PDF).
          </p>
          <div className="space-y-3 max-w-md">
            <div className="border-2 border-dashed border-slate-300 rounded-xl p-4 flex flex-col items-center gap-2 bg-slate-50/50 min-h-[120px]">
              {signature ? (
                <img src={signature} alt="Firma" className="max-h-24 max-w-full object-contain" />
              ) : (
                <p className="text-slate-400 text-sm">Sin firma configurada</p>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={onPickSignature}
              className="hidden"
            />
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-700 cursor-pointer border-none"
              >
                {signature ? 'Cambiar imagen' : 'Elegir imagen'}
              </button>
              <button
                type="button"
                onClick={saveSignature}
                disabled={!signature || savingSig}
                className="px-4 py-2 rounded-lg bg-slate-700 text-white text-sm hover:bg-slate-800 cursor-pointer border-none disabled:opacity-50"
              >
                {savingSig ? 'Guardando…' : 'Guardar firma'}
              </button>
              {signature && (
                <button
                  type="button"
                  onClick={removeSignature}
                  disabled={savingSig}
                  className="px-4 py-2 rounded-lg bg-white text-rose-700 border border-rose-200 hover:bg-rose-50 text-sm cursor-pointer"
                >
                  Quitar
                </button>
              )}
            </div>
            <p className="text-[11px] text-slate-400">PNG/JPG/WEBP · Máx. 300KB · Recomendado fondo transparente.</p>
          </div>
        </div>
      )}

      {/* Cambiar contraseña */}
      <div className="bg-white rounded-2xl border border-emerald-100 p-6">
        <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2 mb-1">
          <HiOutlineKey className="text-emerald-600" /> Cambiar contraseña
        </h2>
        <p className="text-sm text-slate-500 mb-4">Usuario: {user?.email}</p>
        <form onSubmit={submitPassword} className="space-y-3 max-w-sm">
          <label className="block text-sm">Contraseña actual
            <input type="password" value={pwd.currentPassword} onChange={(e) => setPwd({ ...pwd, currentPassword: e.target.value })}
              className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" required />
          </label>
          <label className="block text-sm">Nueva contraseña
            <input type="password" value={pwd.newPassword} onChange={(e) => setPwd({ ...pwd, newPassword: e.target.value })}
              className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" required />
          </label>
          <label className="block text-sm">Confirmar nueva contraseña
            <input type="password" value={pwd.confirm} onChange={(e) => setPwd({ ...pwd, confirm: e.target.value })}
              className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" required />
          </label>
          <button type="submit" disabled={saving}
            className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium border-none cursor-pointer disabled:opacity-50">
            {saving ? 'Guardando...' : 'Cambiar contraseña'}
          </button>
        </form>
      </div>
    </div>
  );
}
