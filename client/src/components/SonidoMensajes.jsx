import { useEffect, useRef } from 'react';
import { useSocketEvent } from '../context/SocketContext';
import { chatALaVista, iniciarSonidos, sonarMensaje } from '../utils/sonidos';

// Un mensaje que se vuelve a emitir más tarde (p. ej. al recuperar su adjunto)
// no es «nuevo»: solo suenan los recién llegados.
const MAX_ANTIGUEDAD_MS = 2 * 60 * 1000;

/**
 * SONIDO DE MENSAJE NUEVO, en cualquier pantalla de la app (oct-2026).
 *
 * El socket ya solo entrega `chat:message` a quien puede ver ese chat (ver
 * `emitToCallCenter` en el servidor), así que aquí basta con decidir si el
 * mensaje merece sonar:
 *   · ENTRANTE (lo escribió el contacto), no uno nuestro ni un evento interno;
 *   · NUEVO, y una sola vez por mensaje (el mismo llega varias veces: al
 *     guardarse, al bajar su adjunto…);
 *   · y no está a la vista: con ese chat abierto y la ventana enfocada, como
 *     en WhatsApp, no suena.
 *
 * Además desbloquea el audio con el primer clic (ver utils/sonidos.js).
 */
export default function SonidoMensajes() {
  const oidos = useRef(new Set());

  useEffect(() => iniciarSonidos(), []);

  useSocketEvent('chat:message', (payload) => {
    const msg = payload?.message;
    if (!msg?._id || msg.direction !== 'in' || msg.kind === 'event') return;
    const id = String(msg._id);
    if (oidos.current.has(id)) return;
    oidos.current.add(id);
    if (oidos.current.size > 500) oidos.current = new Set([...oidos.current].slice(-200));
    const creado = new Date(msg.createdAt || msg.timestamp || Date.now()).getTime();
    if (Date.now() - creado > MAX_ANTIGUEDAD_MS) return;
    if (chatALaVista(payload.conversationId)) return;
    sonarMensaje(id);
  });

  return null;
}
