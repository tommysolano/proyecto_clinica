import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { HiOutlineBellAlert, HiOutlineXMark } from 'react-icons/hi2';
import { useAuth } from '../context/AuthContext';
import { activarPush, estadoPush, pwaInstalada } from '../utils/push';

const SESSION_KEY = 'incoming-call-push-prompt-dismissed';

/**
 * iOS exige que el permiso Push nazca de un toque del usuario. Al abrir la PWA
 * instalada, los perfiles que atienden llamadas ven primero esta explicacion.
 */
export default function IncomingCallPushPrompt() {
  const { user, role } = useAuth();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const eligible = !!user?.isSuperAdmin || ['call_center', 'marketing'].includes(role);

  useEffect(() => {
    if (!eligible || !pwaInstalada()) return undefined;
    try {
      if (sessionStorage.getItem(SESSION_KEY)) return undefined;
    } catch {
      // El almacenamiento privado puede estar deshabilitado; el aviso funciona igual.
    }

    let active = true;
    estadoPush().then((state) => {
      if (active && state.soportado && !state.suscrito && state.permiso !== 'denied') {
        setVisible(true);
      }
    });
    return () => { active = false; };
  }, [eligible]);

  const dismiss = () => {
    setVisible(false);
    try { sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* opcional */ }
  };

  const enable = async () => {
    setBusy(true);
    const result = await activarPush({ pedirPermiso: true });
    setBusy(false);
    if (result === 'ok') {
      setVisible(false);
      toast.success('Avisos de llamadas activados en este celular');
    } else if (result === 'denegado') {
      setVisible(false);
      toast.error('Los avisos están bloqueados. Actívalos en los ajustes del celular.');
    } else {
      toast.error('No se pudieron activar los avisos de llamadas');
    }
  };

  if (!visible) return null;

  return (
    <div className="fixed left-3 right-3 top-20 sm:left-auto sm:right-5 sm:w-[390px] z-[10002] rounded-2xl border border-emerald-200 bg-white shadow-2xl shadow-slate-900/20 p-4">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 shrink-0 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center">
          <HiOutlineBellAlert className="w-6 h-6" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="m-0 text-sm font-bold text-slate-900">Recibe las llamadas con la app cerrada</p>
          <p className="m-0 mt-1 text-xs leading-relaxed text-slate-600">
            Activa los avisos para que el celular te muestre cuando un contacto llame por WhatsApp.
          </p>
          <button
            type="button"
            onClick={enable}
            disabled={busy}
            className="mt-3 rounded-xl border-none bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white cursor-pointer hover:bg-emerald-700 disabled:opacity-60"
          >
            {busy ? 'Activando...' : 'Activar avisos de llamadas'}
          </button>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Cerrar"
          className="p-1 border-none bg-transparent text-slate-400 hover:text-slate-700 cursor-pointer"
        >
          <HiOutlineXMark className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}
