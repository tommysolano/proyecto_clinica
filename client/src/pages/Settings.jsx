import { useState, useEffect, useRef } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import PasswordInput from '../components/PasswordInput';
import { HiOutlineCog6Tooth, HiOutlineKey, HiOutlineSwatch, HiOutlinePencilSquare, HiOutlineEnvelope } from 'react-icons/hi2';

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
  const { user, hasRole, refreshMe } = useAuth();
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'green');
  const [pwd, setPwd] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [mail, setMail] = useState({ email: '', currentPassword: '' });
  const [savingMail, setSavingMail] = useState(false);
  const [saving, setSaving] = useState(false);
  /**
   * FIRMA ELECTRÓNICA (.p12). Antes esto era subir una FOTO de la firma, que no
   * firma nada: solo se parece a una firma. Ahora se sube el certificado y la
   * receta sale firmada dentro del PDF, comprobable por cualquiera.
   */
  const showSignature = hasRole('doctor', 'optica') || user?.isSuperAdmin;
  const [cert, setCert] = useState(null);       // null = aún no se ha consultado
  const [certFile, setCertFile] = useState(null);
  const [certPwd, setCertPwd] = useState('');
  const [savingSig, setSavingSig] = useState(false);
  const fileRef = useRef(null);

  const loadCert = () =>
    api.get('/users/me/signature-cert').then((r) => setCert(r.data)).catch(() => setCert({ tiene: false }));

  useEffect(() => {
    if (!showSignature) return;
    loadCert();
  }, [showSignature]);

  const onPickCert = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!/\.(p12|pfx)$/i.test(f.name)) {
      toast.error('El archivo debe ser un certificado .p12 o .pfx');
      return;
    }
    if (f.size > 5 * 1024 * 1024) {
      toast.error('El certificado no puede pasar de 5 MB');
      return;
    }
    setCertFile(f);
  };

  const saveCert = async () => {
    if (!certFile) return toast.error('Elige tu archivo .p12');
    if (!certPwd) return toast.error('Escribe la contraseña del certificado');
    setSavingSig(true);
    try {
      const fd = new FormData();
      fd.append('certificate', certFile);
      fd.append('password', certPwd);
      const { data } = await api.post('/users/me/signature-cert', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setCert(data);
      setCertFile(null);
      setCertPwd('');
      toast.success('Firma electrónica configurada');
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo guardar el certificado');
    } finally {
      setSavingSig(false);
    }
  };

  const removeCert = async () => {
    if (!window.confirm('¿Eliminar tu firma electrónica? Las recetas dejarán de salir firmadas.')) return;
    setSavingSig(true);
    try {
      await api.delete('/users/me/signature-cert');
      setCert({ tiene: false });
      toast.success('Firma electrónica eliminada');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    } finally {
      setSavingSig(false);
    }
  };

  // dd/mm/aaaa a partir de la fecha del certificado.
  const fechaCorta = (d) => (d ? new Date(d).toLocaleDateString('es-EC') : '—');
  // Un certificado caduca; avisar ANTES es la diferencia entre renovarlo con
  // tiempo y descubrirlo el día que una receta sale sin firma.
  const diasParaVencer = (d) =>
    d ? Math.ceil((new Date(d).getTime() - Date.now()) / 86400000) : null;

  const chooseTheme = (t) => {
    setTheme(t);
    applyTheme(t);
    toast.success('Paleta de colores actualizada');
  };

  /**
   * Cambio del correo de acceso. Al terminar se recarga la sesión: el correo se
   * ve en la cabecera y en la propia pantalla, y dejarlo con el viejo hace dudar
   * de si el cambio se guardó.
   */
  const submitEmail = async (e) => {
    e.preventDefault();
    setSavingMail(true);
    try {
      await api.post('/auth/change-email', {
        email: mail.email.trim(),
        currentPassword: mail.currentPassword,
      });
      toast.success('Correo actualizado. Úsalo la próxima vez que entres.');
      setMail({ email: '', currentPassword: '' });
      await refreshMe?.();
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo cambiar el correo');
    } finally {
      setSavingMail(false);
    }
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
      <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
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

      {/* Firma electrónica (doctor / especialidades) */}
      {showSignature && (
        <div className="bg-white rounded-2xl border border-emerald-100 p-6">
          <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2 mb-1">
            <HiOutlinePencilSquare className="text-emerald-600" /> Firma electrónica
          </h2>
          <p className="text-sm text-slate-500 mb-4">
            Sube tu certificado de firma electrónica (<b>.p12</b> o <b>.pfx</b>, el mismo que usas
            para firmar documentos). Con él, las recetas que emitas salen firmadas dentro del PDF y
            cualquiera puede comprobar que las firmaste tú y que nadie las modificó después.
          </p>

          <div className="space-y-3 max-w-lg">
            {/* Estado actual */}
            {cert?.tiene ? (
              <div
                className={`rounded-xl border p-3 ${
                  cert.puedeFirmar ? 'border-emerald-200 bg-emerald-50/60' : 'border-amber-300 bg-amber-50'
                }`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                      cert.puedeFirmar ? 'bg-emerald-600 text-white' : 'bg-amber-500 text-white'
                    }`}
                  >
                    {cert.puedeFirmar ? 'Activa' : 'No se puede firmar'}
                  </span>
                  <b className="text-slate-800">{cert.info?.commonName || 'Certificado'}</b>
                </div>
                <div className="mt-1.5 text-xs text-slate-600 space-y-0.5">
                  {cert.info?.issuer && <div>Emitido por: {cert.info.issuer.split(',')[0].replace(/^\w+=/, '')}</div>}
                  <div>
                    Válido hasta: <b>{fechaCorta(cert.info?.validTo)}</b>
                    {(() => {
                      const d = diasParaVencer(cert.info?.validTo);
                      if (d === null) return null;
                      if (d < 0) return <span className="text-rose-700 font-semibold"> · vencido</span>;
                      if (d <= 30) return <span className="text-amber-700 font-semibold"> · caduca en {d} días</span>;
                      return null;
                    })()}
                  </div>
                </div>
                {!cert.puedeFirmar && (
                  <p className="mt-2 mb-0 text-xs text-amber-800">
                    {cert.motivo === 'VENCIDO'
                      ? 'El certificado está vencido. Sube el renovado: mientras tanto tus recetas salen sin firma.'
                      : 'No se encuentra el archivo del certificado. Vuelve a subirlo.'}
                  </p>
                )}
              </div>
            ) : (
              <div className="border-2 border-dashed border-slate-300 rounded-xl p-4 text-center bg-slate-50/50">
                <p className="text-slate-500 text-sm m-0">Todavía no has configurado tu firma electrónica.</p>
                <p className="text-slate-400 text-xs m-0 mt-1">
                  Tus recetas saldrán con tu nombre, pero sin firma.
                </p>
              </div>
            )}

            {/* Subir / reemplazar */}
            <input
              ref={fileRef}
              type="file"
              accept=".p12,.pfx,application/x-pkcs12"
              onChange={onPickCert}
              className="hidden"
            />
            <div className="flex gap-2 flex-wrap items-center">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="px-4 py-2 rounded-lg bg-white border border-slate-200 text-sm text-slate-700 hover:border-emerald-300 cursor-pointer"
              >
                {certFile ? 'Cambiar archivo' : cert?.tiene ? 'Subir uno nuevo' : 'Elegir archivo .p12'}
              </button>
              {certFile && <span className="text-xs text-slate-600 truncate max-w-[220px]">{certFile.name}</span>}
            </div>

            {certFile && (
              <div className="space-y-2">
                <label className="block text-sm">
                  Contraseña del certificado
                  <PasswordInput
                    value={certPwd}
                    onChange={(e) => setCertPwd(e.target.value)}
                    autoComplete="off"
                    wrapperClassName="mt-1"
                    className="block w-full border border-slate-200 rounded-xl px-3 py-2 text-sm"
                  />
                </label>
                <p className="text-[11px] text-slate-500 m-0">
                  Se guarda cifrada y no vuelve a mostrarse. Hace falta para poder firmar tus recetas
                  aunque el PDF lo imprima recepción.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={saveCert}
                    disabled={savingSig}
                    className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-700 cursor-pointer border-none disabled:opacity-50"
                  >
                    {savingSig ? 'Comprobando…' : 'Guardar firma electrónica'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setCertFile(null); setCertPwd(''); }}
                    className="px-4 py-2 rounded-lg bg-white border border-slate-200 text-sm text-slate-600 cursor-pointer"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}

            {cert?.tiene && !certFile && (
              <button
                type="button"
                onClick={removeCert}
                disabled={savingSig}
                className="px-4 py-2 rounded-lg bg-white text-rose-700 border border-rose-200 hover:bg-rose-50 text-sm cursor-pointer"
              >
                Quitar mi firma electrónica
              </button>
            )}

            <p className="text-[11px] text-slate-400">
              El archivo no sale nunca del servidor y tu contraseña se guarda cifrada. Máx. 5 MB.
            </p>
          </div>
        </div>
      )}

      {/* Cambiar correo de acceso */}
      <div className="bg-white rounded-2xl border border-emerald-100 p-6">
        <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2 mb-1">
          <HiOutlineEnvelope className="text-emerald-600" /> Cambiar correo
        </h2>
        <p className="text-sm text-slate-500 mb-4">
          Es con lo que entras al sistema. Actual: <b>{user?.email}</b>
        </p>
        <form onSubmit={submitEmail} className="space-y-3 max-w-sm">
          <label className="block text-sm">Correo nuevo
            <input type="email" value={mail.email} onChange={(e) => setMail({ ...mail, email: e.target.value })}
              placeholder="nombre@correo.com"
              className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" required />
          </label>
          {/* Se pide la contraseña porque el correo ES el usuario: sin esto,
              cualquiera que pase por un ordenador desatendido se queda la cuenta. */}
          <label className="block text-sm">Tu contraseña
            <PasswordInput value={mail.currentPassword} onChange={(e) => setMail({ ...mail, currentPassword: e.target.value })}
              autoComplete="current-password" wrapperClassName="mt-1"
              className="block w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" required />
          </label>
          <button type="submit" disabled={savingMail}
            className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium border-none cursor-pointer disabled:opacity-50">
            {savingMail ? 'Guardando...' : 'Cambiar correo'}
          </button>
        </form>
      </div>

      {/* Cambiar contraseña */}
      <div className="bg-white rounded-2xl border border-emerald-100 p-6">
        <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2 mb-1">
          <HiOutlineKey className="text-emerald-600" /> Cambiar contraseña
        </h2>
        <p className="text-sm text-slate-500 mb-4">Usuario: {user?.email}</p>
        <form onSubmit={submitPassword} className="space-y-3 max-w-sm">
          <label className="block text-sm">Contraseña actual
            <PasswordInput value={pwd.currentPassword} onChange={(e) => setPwd({ ...pwd, currentPassword: e.target.value })}
              autoComplete="current-password" wrapperClassName="mt-1"
              className="block w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" required />
          </label>
          <label className="block text-sm">Nueva contraseña
            <PasswordInput value={pwd.newPassword} onChange={(e) => setPwd({ ...pwd, newPassword: e.target.value })}
              autoComplete="new-password" wrapperClassName="mt-1"
              className="block w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" required />
          </label>
          <label className="block text-sm">Confirmar nueva contraseña
            <PasswordInput value={pwd.confirm} onChange={(e) => setPwd({ ...pwd, confirm: e.target.value })}
              autoComplete="new-password" wrapperClassName="mt-1"
              className="block w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" required />
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
