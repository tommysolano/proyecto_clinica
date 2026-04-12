import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import { HiOutlineHeart, HiOutlineUserPlus } from 'react-icons/hi2';

export default function Register() {
  const [form, setForm] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    role: 'recepcionista',
    specialty: '',
    phone: '',
  });
  const [loading, setLoading] = useState(false);
  const { register } = useAuth();
  const navigate = useNavigate();

  const handleChange = (e) => {
    setForm({ ...form, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (form.password !== form.confirmPassword) {
      return toast.error('Las contraseñas no coinciden');
    }
    setLoading(true);
    try {
      const { confirmPassword, ...data } = form;
      await register(data);
      toast.success('Cuenta creada exitosamente');
      navigate('/');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al registrar');
    } finally {
      setLoading(false);
    }
  };

  const inputClass = "w-full px-4 py-3 border border-slate-200 rounded-xl outline-none text-sm bg-slate-50/50 placeholder:text-slate-400";
  const labelClass = "block text-sm font-semibold text-slate-700 mb-1.5";

  return (
    <div className="min-h-screen flex">
      {/* Panel izquierdo */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-emerald-800 via-teal-700 to-cyan-800 relative overflow-hidden">
        <div className="absolute inset-0 opacity-10">
          <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            <circle cx="70" cy="30" r="35" fill="white" />
            <circle cx="30" cy="70" r="25" fill="white" />
          </svg>
        </div>
        <div className="relative z-10 flex flex-col justify-center px-16 text-white">
          <div className="w-16 h-16 bg-white/20 backdrop-blur rounded-2xl flex items-center justify-center mb-8">
            <HiOutlineUserPlus className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-4xl font-bold mb-4 leading-tight">
            Únase a nuestro<br />equipo médico
          </h1>
          <p className="text-emerald-100 text-lg leading-relaxed max-w-md">
            Cree su cuenta para acceder a todas las herramientas de gestión clínica 
            de forma segura y eficiente.
          </p>
        </div>
      </div>

      {/* Panel derecho */}
      <div className="flex-1 flex items-center justify-center bg-gradient-to-b from-green-50 to-white p-6">
        <div className="w-full max-w-lg">
          <div className="lg:hidden text-center mb-6">
            <div className="w-14 h-14 bg-gradient-to-br from-emerald-600 to-teal-600 rounded-2xl flex items-center justify-center mx-auto mb-3 shadow-lg shadow-emerald-200">
              <HiOutlineHeart className="w-7 h-7 text-white" />
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-emerald-100 p-8">
            <div className="mb-6">
              <h2 className="text-2xl font-bold text-slate-800">Crear Cuenta</h2>
              <p className="text-muted mt-1 text-sm">Complete los datos para registrarse</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className={labelClass}>Nombre completo</label>
                <input type="text" name="name" value={form.name} onChange={handleChange} required className={inputClass} placeholder="Dr. Juan Pérez" />
              </div>
              <div>
                <label className={labelClass}>Correo electrónico</label>
                <input type="email" name="email" value={form.email} onChange={handleChange} required className={inputClass} placeholder="correo@clinica.com" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>Contraseña</label>
                  <input type="password" name="password" value={form.password} onChange={handleChange} required minLength={6} className={inputClass} placeholder="••••••" />
                </div>
                <div>
                  <label className={labelClass}>Confirmar</label>
                  <input type="password" name="confirmPassword" value={form.confirmPassword} onChange={handleChange} required className={inputClass} placeholder="••••••" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>Rol</label>
                  <select name="role" value={form.role} onChange={handleChange} className={`${inputClass} bg-white`}>
                    <option value="admin">Administrador</option>
                    <option value="recepcionista">Recepcionista</option>
                    <option value="doctor">Doctor</option>
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Teléfono</label>
                  <input type="text" name="phone" value={form.phone} onChange={handleChange} className={inputClass} placeholder="0991234567" />
                </div>
              </div>
              {form.role === 'doctor' && (
                <div>
                  <label className={labelClass}>Especialidad</label>
                  <input type="text" name="specialty" value={form.specialty} onChange={handleChange} className={inputClass} placeholder="Ej: Medicina General" />
                </div>
              )}
              <button
                type="submit"
                disabled={loading}
                className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white font-semibold py-3 rounded-xl disabled:opacity-50 cursor-pointer border-none text-sm shadow-lg shadow-emerald-200/50 mt-2"
              >
                {loading ? 'Creando cuenta...' : 'Crear Cuenta'}
              </button>
            </form>

            <div className="mt-6 pt-6 border-t border-slate-100 text-center">
              <p className="text-sm text-muted">
                ¿Ya tienes cuenta?{' '}
                <Link to="/login" className="text-emerald-600 font-semibold hover:text-emerald-700 no-underline">
                  Iniciar sesión
                </Link>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
