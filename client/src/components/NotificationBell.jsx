import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  HiOutlineBell,
  HiOutlineExclamationTriangle,
  HiOutlineInformationCircle,
  HiOutlineXCircle,
} from 'react-icons/hi2';
import api from '../api/axios';
import { useAuth } from '../context/AuthContext';
import { useSocketEvent } from '../context/SocketContext';
import { fmtDateTime } from '../utils/date';

// A dónde lleva cada tipo de notificación al hacer clic. Todo lo de plantillas
// termina en la página de Plantillas, que es donde se actúa.
const TYPE_LINK = {
  template_category_changed: '/message-templates',
  template_status_changed: '/message-templates',
  template_check_failed: '/message-templates',
  whatsapp_quality_changed: '/call-center-config',
};

const SEVERITY_ICON = {
  error: { Icon: HiOutlineXCircle, color: 'text-red-500' },
  warning: { Icon: HiOutlineExclamationTriangle, color: 'text-amber-500' },
  info: { Icon: HiOutlineInformationCircle, color: 'text-sky-500' },
};

/** "hace 5 min" / "hace 3 h" / "ayer" / "12/07/2026" */
function relativeTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'ahora';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'ayer';
  if (days < 7) return `hace ${days} días`;
  return fmtDateTime(value).slice(0, 10);
}

/**
 * Campana de notificaciones del header. Muestra las alertas internas del sistema
 * (hoy: recategorización / cambio de estado de plantillas de WhatsApp y calidad
 * del número) para enterarse SIN entrar a la página de Plantillas.
 *
 * Se refresca por socket (`notification:new`) y, como respaldo, con un sondeo
 * cada 3 minutos: la notificación se crea en la clínica ancla del CRM y un
 * usuario con otra sucursal activa no está en esa sala de socket.
 */
export default function NotificationBell() {
  const navigate = useNavigate();
  const { activeClinic } = useAuth();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const boxRef = useRef(null);

  // Sin sucursal activa todavía (justo tras entrar) NO se pide nada: el endpoint
  // exige clínica y un 403 CLINIC_REQUIRED redirige la app entera.
  const clinicId = activeClinic?._id || null;

  const load = async () => {
    if (!clinicId) return;
    try {
      const { data } = await api.get('/notifications', { params: { limit: 30 } });
      setItems(data?.items || []);
      setUnread(data?.unread || 0);
    } catch {
      /* el header nunca debe romperse por esto */
    }
  };

  // Carga al montar (y al cambiar de sucursal) + sondeo de respaldo.
  useEffect(() => {
    load();
    const t = setInterval(load, 3 * 60 * 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clinicId]);

  // El `clinicId` en las dependencias no es decorativo: sin él el manejador se
  // quedaría con el closure del primer render (sin sucursal aún) y `load` saldría
  // siempre por el early-return, dejando el aviso en vivo muerto.
  useSocketEvent('notification:new', load, [clinicId]);

  // Cerrar al hacer clic fuera o con Escape (mismo comportamiento que el resto
  // de menús flotantes de la app).
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) load(); // al abrir, siempre lo último
  };

  const markRead = async (n) => {
    if (n.read) return;
    setItems((prev) => prev.map((x) => (x._id === n._id ? { ...x, read: true } : x)));
    setUnread((u) => Math.max(0, u - 1));
    try {
      await api.post(`/notifications/${n._id}/read`);
    } catch {
      load(); // si falló, que la pantalla vuelva a la verdad del servidor
    }
  };

  const markAllRead = async () => {
    setItems((prev) => prev.map((x) => ({ ...x, read: true })));
    setUnread(0);
    try {
      await api.post('/notifications/read-all');
    } catch {
      load();
    }
  };

  const openNotification = async (n) => {
    await markRead(n);
    const to = TYPE_LINK[n.type];
    setOpen(false);
    if (to) navigate(to);
  };

  return (
    <div className="relative" ref={boxRef}>
      <button
        onClick={toggle}
        title={unread ? `${unread} notificación(es) sin leer` : 'Notificaciones'}
        aria-label="Notificaciones"
        className="relative p-2 rounded-xl bg-transparent border-none cursor-pointer text-slate-500 hover:text-emerald-600 hover:bg-emerald-50"
      >
        <HiOutlineBell className="w-6 h-6" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center shadow-sm">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[min(22rem,calc(100vw-2rem))] bg-white rounded-xl border border-slate-200 shadow-xl shadow-slate-900/10 z-[10001] overflow-hidden">
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-slate-100">
            <p className="text-sm font-semibold text-slate-800">Notificaciones</p>
            {unread > 0 && (
              <button
                onClick={markAllRead}
                className="text-xs text-emerald-700 underline bg-transparent border-none cursor-pointer"
              >
                Marcar todas como leídas
              </button>
            )}
          </div>

          <div className="max-h-[60vh] overflow-y-auto divide-y divide-slate-100">
            {items.length === 0 && (
              <p className="px-3.5 py-6 text-center text-sm text-slate-400">
                No tienes notificaciones.
              </p>
            )}
            {items.map((n) => {
              const { Icon, color } = SEVERITY_ICON[n.severity] || SEVERITY_ICON.info;
              return (
                <button
                  key={n._id}
                  onClick={() => openNotification(n)}
                  className={`w-full text-left flex gap-2.5 px-3.5 py-2.5 border-none cursor-pointer hover:bg-slate-50 ${n.read ? 'bg-white' : 'bg-emerald-50/50'}`}
                >
                  <Icon className={`w-5 h-5 mt-0.5 shrink-0 ${color}`} />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-[13px] leading-snug ${n.read ? 'text-slate-700' : 'text-slate-900 font-semibold'}`}>
                      {n.title}
                    </span>
                    {n.body && (
                      <span className="block text-xs text-slate-500 mt-0.5 leading-snug">{n.body}</span>
                    )}
                    <span className="block text-[10px] text-slate-400 mt-1" title={fmtDateTime(n.createdAt)}>
                      {relativeTime(n.createdAt)}
                    </span>
                  </span>
                  {!n.read && <span className="w-2 h-2 rounded-full bg-emerald-500 mt-1.5 shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
