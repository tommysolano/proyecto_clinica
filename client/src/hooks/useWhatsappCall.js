import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import api from '../api/axios';
import { useSocketEvent } from '../context/SocketContext';

/**
 * Llamadas de voz de WhatsApp desde el chat (Calling API de Meta).
 *
 * El audio va por WebRTC directo entre este navegador y WhatsApp; el servidor
 * solo hace de cartero de los SDP:
 *
 *   Saliente:  creamos OFFER → POST /chats/:id/call → el ANSWER llega por el
 *              socket ('call:answered') → lo aplicamos → hay audio.
 *   Entrante:  el socket trae el OFFER ('call:incoming') → al aceptar creamos el
 *              ANSWER → POST /chats/calls/:callId/accept → hay audio.
 *
 * Requiere https (getUserMedia y WebRTC no funcionan en http salvo localhost).
 */

// Meta no admite trickle ICE: el SDP debe ir con TODOS los candidatos dentro, así
// que hay que esperar a que el navegador termine de recolectarlos antes de
// mandarlo. Sin esto el SDP viaja sin candidatos y la llamada nunca da audio.
function waitForIceGathering(pc, timeoutMs = 5000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let timer = null;
    const finish = () => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      if (timer) clearTimeout(timer);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    pc.addEventListener('icegatheringstatechange', onChange);
    // Red de seguridad: con un TURN inalcanzable la recolección puede no cerrar
    // nunca; se manda lo que haya en vez de dejar al agente esperando.
    timer = setTimeout(finish, timeoutMs);
  });
}

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

export default function useWhatsappCall() {
  // null | { callId, direction, status, contactName, phone, conversationId }
  const [call, setCall] = useState(null);
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const timerRef = useRef(null);
  // El OFFER de una entrante llega por socket y se usa recién al aceptar.
  const pendingOfferRef = useRef('');

  // Elemento <audio> oculto donde suena la voz del contacto.
  useEffect(() => {
    const el = document.createElement('audio');
    el.autoplay = true;
    document.body.appendChild(el);
    remoteAudioRef.current = el;
    return () => el.remove();
  }, []);

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    if (pcRef.current) {
      try { pcRef.current.close(); } catch { /* ya cerrada */ }
      pcRef.current = null;
    }
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    pendingOfferRef.current = '';
    setMuted(false);
    setSeconds(0);
  }, []);

  const endLocally = useCallback(() => {
    cleanup();
    setCall(null);
  }, [cleanup]);

  const startTimer = useCallback(() => {
    if (timerRef.current) return;
    setSeconds(0);
    timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
  }, []);

  // Prepara la conexión WebRTC: micrófono + reproducción de la voz del contacto.
  const buildPeerConnection = useCallback(async () => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      throw new Error('No se pudo usar el micrófono. Revisa los permisos del navegador.');
    }
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    pc.ontrack = (e) => {
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = e.streams[0];
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) {
        toast.error('Se perdió la conexión de la llamada');
        endLocally();
      }
    };
    localStreamRef.current = stream;
    pcRef.current = pc;
    return pc;
  }, [endLocally]);

  /** Llama al contacto de una conversación. */
  const startCall = useCallback(async (conversation) => {
    if (call) return;
    const convId = conversation._id;
    try {
      const pc = await buildPeerConnection();
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);
      const { data } = await api.post(`/chats/${convId}/call`, { sdp: pc.localDescription.sdp });
      setCall({
        callId: data.callId,
        conversationId: convId,
        direction: 'out',
        status: 'ringing',
        contactName: conversation.contactName || conversation.phone,
        phone: conversation.phone,
      });
    } catch (err) {
      cleanup();
      toast.error(err.response?.data?.message || err.message || 'No se pudo iniciar la llamada');
    }
  }, [call, buildPeerConnection, cleanup]);

  /** Acepta la llamada entrante que está sonando. */
  const acceptCall = useCallback(async () => {
    if (!call || call.direction !== 'in') return;
    const offer = pendingOfferRef.current;
    if (!offer) {
      toast.error('No llegó la sesión de audio de la llamada');
      return;
    }
    try {
      const pc = await buildPeerConnection();
      await pc.setRemoteDescription({ type: 'offer', sdp: offer });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGathering(pc);
      await api.post(`/chats/calls/${call.callId}/accept`, { sdp: pc.localDescription.sdp });
      setCall((c) => (c ? { ...c, status: 'active' } : c));
      startTimer();
    } catch (err) {
      cleanup();
      setCall(null);
      toast.error(err.response?.data?.message || err.message || 'No se pudo aceptar la llamada');
    }
  }, [call, buildPeerConnection, cleanup, startTimer]);

  /** Rechaza la entrante sin contestar. */
  const rejectCall = useCallback(async () => {
    if (!call) return;
    const { callId } = call;
    endLocally();
    await api.post(`/chats/calls/${callId}/reject`).catch(() => {});
  }, [call, endLocally]);

  /** Cuelga la llamada en curso (o cancela la saliente que suena). */
  const hangUp = useCallback(async () => {
    if (!call) return;
    const { callId } = call;
    endLocally();
    await api.post(`/chats/calls/${callId}/terminate`).catch(() => {});
  }, [call, endLocally]);

  const toggleMute = useCallback(() => {
    const tracks = localStreamRef.current?.getAudioTracks() || [];
    if (!tracks.length) return;
    const next = !muted;
    tracks.forEach((t) => { t.enabled = !next; });
    setMuted(next);
  }, [muted]);

  // El contacto contestó: aplicar su SDP answer para que empiece a oírse.
  useSocketEvent('call:answered', async (payload) => {
    const pc = pcRef.current;
    if (!pc || !call || payload.callId !== call.callId) return;
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
      setCall((c) => (c ? { ...c, status: 'active' } : c));
      startTimer();
    } catch {
      toast.error('No se pudo establecer el audio de la llamada');
      hangUp();
    }
  }, [call, startTimer, hangUp]);

  // Nos llaman: se guarda el OFFER y suena en pantalla hasta que el agente decide.
  useSocketEvent('call:incoming', (payload) => {
    // Si ya hay una llamada en curso, esta se ignora aquí (el backend la
    // terminará por tiempo y quedará como perdida en el historial).
    if (call) return;
    pendingOfferRef.current = payload.sdp || '';
    setCall({
      callId: payload.callId,
      conversationId: payload.conversationId,
      direction: 'in',
      status: 'ringing',
      contactName: payload.contactName,
      phone: payload.phone,
    });
  }, [call]);

  // Otro agente contestó esta entrante: quitar el panel que sigue sonando aquí.
  // Se distingue por `pcRef`: el agente que contestó ya tiene su conexión WebRTC
  // montada, los demás no.
  useSocketEvent('call:status', (payload) => {
    if (!call || payload.callId !== call.callId) return;
    if (payload.status === 'active' && call.status === 'ringing' && !pcRef.current) {
      toast(`${payload.agentName || 'Otro agente'} contestó la llamada`);
      endLocally();
    }
  }, [call, endLocally]);

  // La llamada terminó por el otro lado (o por el servidor).
  useSocketEvent('call:ended', (payload) => {
    if (!call || payload.callId !== call.callId) return;
    if (payload.status === 'missed' && call.direction === 'out') toast('El contacto no contestó');
    else if (payload.status === 'failed') toast.error(payload.errorMessage || 'La llamada falló');
    endLocally();
  }, [call, endLocally]);

  // Cerrar la página/desmontar no debe dejar el micrófono abierto.
  useEffect(() => cleanup, [cleanup]);

  return { call, seconds, muted, startCall, acceptCall, rejectCall, hangUp, toggleMute };
}
