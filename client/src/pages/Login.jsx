import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import { HiOutlineShieldCheck, HiOutlineBuildingOffice2, HiOutlineNoSymbol } from 'react-icons/hi2';
import shiluvLogo from '../Shiluv-logo-4.png';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState('credentials');
  const [availableClinics, setAvailableClinics] = useState([]);
  const [blockMsg, setBlockMsg] = useState('');
  const { login, selectClinic } = useAuth();
  const navigate = useNavigate();

  // Si el usuario fue expulsado por un bloqueo de acceso, mostrar el motivo.
  useEffect(() => {
    const msg = localStorage.getItem('accessBlockMsg');
    if (msg) {
      setBlockMsg(msg);
      localStorage.removeItem('accessBlockMsg');
    }
  }, []);

  const handleCredentials = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const data = await login(email, password);
      if ((data.clinics || []).length === 0) {
        toast.error('No tiene sucursales asignadas. Contacte al administrador.');
        return;
      }
      if (data.clinics.length === 1) {
        toast.success('Bienvenido');
        navigate('/');
        return;
      }
      setAvailableClinics(data.clinics);
      setStep('clinic');
    } catch (err) {
      const msg = err.response?.data?.message || 'Error al iniciar sesión';
      if (err.response?.status === 403 && err.response?.data?.code === 'ACCESS_BLOCKED') {
        setBlockMsg(msg);
      } else {
        toast.error(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSelectClinic = async (clinicId) => {
    setLoading(true);
    try {
      await selectClinic(clinicId);
      toast.success('Bienvenido');
      navigate('/');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al seleccionar sucursal');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex">
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-emerald-800 via-teal-700 to-cyan-800 relative overflow-hidden">
        <div className="absolute inset-0 opacity-10">
          <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            <circle cx="20" cy="20" r="30" fill="white" />
            <circle cx="80" cy="80" r="40" fill="white" />
            <circle cx="60" cy="30" r="20" fill="white" />
          </svg>
        </div>
        <div className="relative z-10 flex flex-col justify-center px-16 text-white">
          <div className="w-24 h-24 bg-white rounded-2xl flex items-center justify-center p-3 mb-8 shadow-xl">
            <img src={shiluvLogo} alt="Shiluv" className="w-full h-full object-contain" />
          </div>
          <h1 className="text-4xl font-bold mb-4 leading-tight">
            Shiluv<br />Sistema de Gestión Médica
          </h1>
          <p className="text-emerald-100 text-lg leading-relaxed max-w-md">
            Plataforma integral con facturación electrónica SRI Ecuador. Pacientes, citas,
            inventario y facturación en un solo lugar.
          </p>
          <div className="flex items-center gap-3 mt-10 text-emerald-200 text-sm">
            <HiOutlineShieldCheck className="w-5 h-5" />
            <span>Datos protegidos y seguros</span>
          </div>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center bg-gradient-to-b from-green-50 to-white p-6">
        <div className="w-full max-w-md">
          <div className="lg:hidden text-center mb-8">
            <div className="w-16 h-16 bg-white rounded-2xl flex items-center justify-center mx-auto mb-3 shadow-lg shadow-emerald-200 p-2">
              <img src={shiluvLogo} alt="Shiluv" className="w-full h-full object-contain" />
            </div>
            <h1 className="text-xl font-bold text-slate-800">Shiluv</h1>
          </div>

          <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-8">
            {step === 'credentials' && (
              <>
                <div className="mb-6">
                  <h2 className="text-2xl font-bold text-slate-800 tracking-tight">Bienvenido</h2>
                  <p className="text-muted mt-1 text-sm">Ingrese sus credenciales para acceder</p>
                </div>
                {blockMsg && (
                  <div className="mb-5 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                    <HiOutlineNoSymbol className="w-5 h-5 flex-shrink-0 mt-0.5" />
                    <span>{blockMsg}</span>
                  </div>
                )}
                <form onSubmit={handleCredentials} className="space-y-5">
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1.5">Correo electrónico</label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className="w-full px-4 py-3 border border-slate-200 rounded-xl outline-none text-sm bg-slate-50/50"
                      placeholder="correo@shiluv.com"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1.5">Contraseña</label>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      className="w-full px-4 py-3 border border-slate-200 rounded-xl outline-none text-sm bg-slate-50/50"
                      placeholder="••••••••"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={loading}
                    className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold py-3 rounded-xl disabled:opacity-50 cursor-pointer border-none text-sm shadow-lg shadow-emerald-200/50"
                  >
                    {loading ? 'Ingresando...' : 'Iniciar Sesión'}
                  </button>
                </form>
              </>
            )}

            {step === 'clinic' && (
              <>
                <div className="mb-6">
                  <h2 className="text-2xl font-bold text-slate-800 tracking-tight">Seleccione sucursal</h2>
                  <p className="text-muted mt-1 text-sm">
                    Tiene acceso a múltiples sucursales. Elija con cuál desea trabajar.
                  </p>
                </div>
                <div className="space-y-3">
                  {availableClinics.map((c) => (
                    <button
                      key={c._id}
                      onClick={() => handleSelectClinic(c._id)}
                      disabled={loading}
                      className="w-full flex items-center gap-3 p-4 border border-slate-200 hover:border-emerald-400 hover:bg-emerald-50 rounded-xl text-left disabled:opacity-50 cursor-pointer bg-white"
                    >
                      <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center">
                        <HiOutlineBuildingOffice2 className="w-5 h-5 text-emerald-600" />
                      </div>
                      <div className="flex-1">
                        <p className="font-semibold text-slate-800">{c.name}</p>
                        <p className="text-xs text-slate-500">
                          {c.razonSocial} · Rol: <span className="capitalize">{c.role}</span>
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setStep('credentials')}
                  className="w-full mt-4 text-sm text-slate-500 hover:text-slate-700 cursor-pointer bg-transparent border-none"
                >
                  ← Volver
                </button>
              </>
            )}
          </div>

          <p className="text-center text-xs text-slate-400 mt-6">
            © 2026 Shiluv · Todos los derechos reservados
          </p>
        </div>
      </div>
    </div>
  );
}
