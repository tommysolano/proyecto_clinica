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

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!user || !token) return undefined;

    // En producción VITE_API_URL apunta al backend de Render.
    // En dev Vite proxea /socket.io al backend (vite.config.js).
    const SOCKET_URL = import.meta.env.VITE_API_URL || undefined;
    const socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling'],
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
  }, [user?._id]);

  // Cuando cambia la clínica activa, avisar al server para que mueva la room.
  useEffect(() => {
    if (socketRef.current && activeClinic?._id) {
      socketRef.current.emit('switch-clinic', activeClinic._id);
    }
  }, [activeClinic?._id]);

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
