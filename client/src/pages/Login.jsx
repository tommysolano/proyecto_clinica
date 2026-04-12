import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import { HiOutlineHeart, HiOutlineShieldCheck } from 'react-icons/hi2';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await login(email, password);
      toast.success('Bienvenido');
      navigate('/');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al iniciar sesión');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex">
      {/* Panel izquierdo decorativo */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-emerald-800 via-teal-700 to-cyan-800 relative overflow-hidden">
        <div className="absolute inset-0 opacity-10">
          <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            <circle cx="20" cy="20" r="30" fill="white" />
            <circle cx="80" cy="80" r="40" fill="white" />
            <circle cx="60" cy="30" r="20" fill="white" />
          </svg>
        </div>
        <div className="relative z-10 flex flex-col justify-center px-16 text-white">
          <div className="w-16 h-16 bg-white/20 backdrop-blur rounded-2xl flex items-center justify-center mb-8">
            <HiOutlineHeart className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-4xl font-bold mb-4 leading-tight">
            Sistema de Gestión<br />Clínica
          </h1>
          <p className="text-emerald-100 text-lg leading-relaxed max-w-md">
            Plataforma integral para la administración de su consultorio médico. 
            Gestione pacientes, citas, inventario y facturación en un solo lugar.
          </p>
          <div className="flex items-center gap-3 mt-10 text-emerald-200 text-sm">
            <HiOutlineShieldCheck className="w-5 h-5" />
            <span>Datos protegidos y seguros</span>
          </div>
        </div>
      </div>

      {/* Panel derecho - formulario */}
      <div className="flex-1 flex items-center justify-center bg-gradient-to-b from-green-50 to-white p-6">
        <div className="w-full max-w-md">
          {/* Logo móvil */}
          <div className="lg:hidden text-center mb-8">
            <div className="w-14 h-14 bg-gradient-to-br from-emerald-600 to-teal-600 rounded-2xl flex items-center justify-center mx-auto mb-3 shadow-lg shadow-emerald-200">
              <HiOutlineHeart className="w-7 h-7 text-white" />
            </div>
            <h1 className="text-xl font-bold text-slate-800">Sistema Clínico</h1>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-emerald-100 p-8">
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-slate-800">Bienvenido</h2>
              <p className="text-muted mt-1 text-sm">Ingrese sus credenciales para acceder</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">Correo electrónico</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="w-full px-4 py-3 border border-slate-200 rounded-xl outline-none text-sm bg-slate-50/50 placeholder:text-slate-400"
                  placeholder="correo@clinica.com"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1.5">Contraseña</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="w-full px-4 py-3 border border-slate-200 rounded-xl outline-none text-sm bg-slate-50/50 placeholder:text-slate-400"
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

            <div className="mt-6 pt-6 border-t border-slate-100 text-center">
              <p className="text-sm text-muted">
                ¿No tienes cuenta?{' '}
                <Link to="/register" className="text-emerald-600 font-semibold hover:text-emerald-700 no-underline">
                  Crear cuenta
                </Link>
              </p>
            </div>
          </div>

          <p className="text-center text-xs text-slate-400 mt-6">
            © 2026 Sistema Clínico · Todos los derechos reservados
          </p>
        </div>
      </div>
    </div>
  );
}
