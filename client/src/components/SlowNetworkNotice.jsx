import { useEffect, useState } from 'react';
import { subscribeSlowRequests } from '../api/axios';

/**
 * Aviso discreto cuando la conexión va lenta o se cae.
 *
 * Con internet débil el usuario veía un spinner girando sin saber si el sistema
 * estaba colgado, y recargaba —lo que empezaba todo de nuevo y tardaba aún más—.
 * Esto le dice qué pasa: que se está esperando al servidor (alguna petición
 * lleva más de unos segundos, ver api/axios.js) o que el equipo se quedó sin
 * internet. Desaparece solo cuando todo vuelve a responder.
 */
export default function SlowNetworkNotice() {
  const [slow, setSlow] = useState(0);
  const [offline, setOffline] = useState(typeof navigator !== 'undefined' && navigator.onLine === false);

  useEffect(() => subscribeSlowRequests(setSlow), []);
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  if (!offline && !slow) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed bottom-3 left-1/2 -translate-x-1/2 z-[20001] flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium shadow-lg border pointer-events-none ${
        offline ? 'bg-rose-50 text-rose-800 border-rose-200' : 'bg-amber-50 text-amber-800 border-amber-200'
      }`}
    >
      <span className={`w-2 h-2 rounded-full ${offline ? 'bg-rose-500' : 'bg-amber-500 animate-pulse'}`} />
      {offline
        ? 'Sin conexión a internet. Los cambios no se guardarán hasta que vuelva.'
        : 'Conexión lenta: esperando al servidor…'}
    </div>
  );
}
