import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from './AuthContext';

const SocketContext = createContext({ socket: null, connected: false, subscribe: () => () => {} });

/**
 * Provee una única conexión Socket.IO autenticada por JWT.
 * - Se reconecta cuando cambia la clínica activa (emite `switch-clinic`).
 * - Permite suscribirse a eventos de forma declarativa con `useSocket().subscribe(event, handler)`.
 */
export function SocketProvider({ children }) {
  const { user, activeClinic } = useAuth();
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);

  // OJO: /auth/me devuelve el usuario con `id` (y ahora también `_id`). La
  // dependencia del efecto era `user?._id`, que no existía: quedaba undefined
  // siempre, el efecto no se re-ejecutaba al llegar el usuario y el socket NO
  // se conectaba nunca (sin error alguno). Usar un id que exista de verdad.
  const userId = user?.id || user?._id || null;
  // El socket se UNE a la sala 'callcenter' (la que recibe chat:message en vivo)
  // según el ROL del token con el que conecta. Pero al iniciar sesión el primer
  // token NO trae clínica ni rol; el rol llega recién al elegir sucursal (segundo
  // token). Por eso el socket debe RECONECTAR cuando cambia la clínica activa: si
  // no, un agente (no super-admin) conectaba con el token sin rol, nunca entraba a
  // 'callcenter' y el tiempo real quedaba muerto para él (había que recargar).
  const activeClinicId = activeClinic?._id || null;

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!userId || !token) return undefined;

    // En producción VITE_API_URL apunta al backend de Render.
    // En dev Vite proxea /socket.io al backend (vite.config.js).
    const SOCKET_URL = import.meta.env.VITE_API_URL || undefined;
    // Polling PRIMERO (orden por defecto de socket.io): con websocket primero,
    // si el proxy (nginx) no pasa los headers de Upgrade el intento falla y
    // socket.io NO cae a polling — se queda reintentando para siempre y el
    // tiempo real muere en silencio (visto en prod: wss:// fallando en bucle).
    // Con polling primero siempre conecta, y el upgrade a websocket se intenta
    // en segundo plano (si falla, se queda en polling sin romper nada).
    const socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionDelay: 1500,
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));

    return () => {
      socket.off();
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
    // Reconectar al cambiar de usuario O de clínica activa: el token nuevo (con el
    // rol correcto) hace que el server vuelva a unir el socket a la sala correcta,
    // incluida 'callcenter'. Sin esto el tiempo real no llegaba tras elegir sede.
  }, [userId, activeClinicId]);

  const subscribe = useCallback((event, handler) => {
    const s = socketRef.current;
    if (!s) return () => {};
    s.on(event, handler);
    return () => s.off(event, handler);
  }, []);

  return (
    <SocketContext.Provider value={{ socket: socketRef.current, connected, subscribe }}>
      {children}
    </SocketContext.Provider>
  );
}

export function useSocket() {
  return useContext(SocketContext);
}

/**
 * Hook utilitario: se suscribe a un evento y limpia automáticamente.
 *   useSocketEvent('appointment:updated', (apt) => { ... });
 */
export function useSocketEvent(event, handler, deps = []) {
  const { subscribe, connected } = useSocket();
  useEffect(() => {
    if (!connected) return undefined;
    return subscribe(event, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, connected, ...deps]);
}
