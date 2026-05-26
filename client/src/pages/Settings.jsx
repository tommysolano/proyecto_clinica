import { useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { HiOutlineCog6Tooth, HiOutlineKey, HiOutlineSwatch } from 'react-icons/hi2';

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
  const { user } = useAuth();
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'green');
  const [pwd, setPwd] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [saving, setSaving] = useState(false);

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
