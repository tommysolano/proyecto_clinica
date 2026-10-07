import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { HiOutlineBanknotes } from 'react-icons/hi2';
import api from '../../api/axios';

/**
 * FACTURA DESDE LA AGENDA — quién la tiene (oct-2026, solo super admin).
 *
 * Con el permiso encendido, al recibir una cita el cajero/administrador cobra
 * primero con el formulario de Ventas (consumidor final o factura, forma de
 * pago, pago dividido; con su asiento, su caja y, si tiene punto de emisión, su
 * factura) y después asigna al doctor o enfermero. La receta también se cobra
 * como venta. Sin el permiso, la agenda sigue como siempre.
 *
 * Es para PROBAR el punto de venta con una persona antes de abrirlo a todos.
 */
export default function FacturacionTab() {
  const [lista, setLista] = useState(null);
  const [guardando, setGuardando] = useState('');

  useEffect(() => {
    api.get('/users/billing')
      .then((r) => setLista(r.data || []))
      .catch((e) => {
        toast.error(e.response?.data?.message || 'No se pudo cargar el personal de caja');
        setLista([]);
      });
  }, []);

  const cambiar = async (u, canBill) => {
    setGuardando(String(u._id));
    try {
      const { data } = await api.patch(`/users/${u._id}/billing`, { canBill });
      setLista((l) => l.map((x) => (String(x._id) === String(u._id) ? { ...x, canBill: data.canBill } : x)));
      toast.success(canBill ? `${u.name} ya factura desde la agenda` : `${u.name} vuelve al cobro de siempre`);
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo guardar');
    } finally {
      setGuardando('');
    }
  };

  if (!lista) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600"></div>
      </div>
    );
  }

  const activos = lista.filter((u) => u.canBill).length;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4 text-sm text-emerald-900 flex gap-3">
        <HiOutlineBanknotes className="w-6 h-6 shrink-0 text-emerald-600" />
        <div className="space-y-1">
          <p className="m-0 font-semibold">Factura desde la agenda (en prueba)</p>
          <p className="m-0 text-xs">
            Quien lo tenga encendido, al recibir una cita <b>cobra primero</b> —consumidor final o factura, forma de pago y
            pago dividido— y después asigna al doctor o enfermero. La receta también se cobra como venta. Todo queda en
            contabilidad: asiento, caja y, si tiene punto de emisión, la factura electrónica. El resto del personal sigue
            como siempre.
          </p>
          <p className="m-0 text-xs text-emerald-700">
            {activos ? `${activos} ${activos === 1 ? 'persona lo tiene' : 'personas lo tienen'} encendido.` : 'Nadie lo tiene encendido todavía.'}
          </p>
        </div>
      </div>

      {lista.length === 0 ? (
        <p className="text-sm text-slate-500">No hay administradores ni cajeros activos.</p>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 divide-y divide-slate-100">
          {lista.map((u) => (
            <label
              key={u._id}
              className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium text-slate-800 truncate">{u.name}</span>
                <span className="block text-xs text-slate-500 truncate">
                  {(u.sucursales || []).map((s) => `${s.nombre || 'Sucursal'} (${s.rol === 'cajero' ? 'cajero' : 'administrador'})`).join(' · ') || u.email}
                </span>
              </span>
              <span className="flex items-center gap-2 shrink-0">
                <span className={`text-xs font-medium ${u.canBill ? 'text-emerald-700' : 'text-slate-400'}`}>
                  {u.canBill ? 'Factura' : 'No factura'}
                </span>
                <input
                  type="checkbox"
                  className="w-5 h-5 accent-emerald-600 cursor-pointer"
                  checked={!!u.canBill}
                  disabled={guardando === String(u._id)}
                  onChange={(e) => cambiar(u, e.target.checked)}
                />
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
