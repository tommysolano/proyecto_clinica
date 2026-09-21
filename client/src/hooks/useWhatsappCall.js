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
function waitForIceGathering(pc, timeoutMs = 10000) {
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

const FALLBACK_ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302'] }];

export default function useWhatsappCall({ pendingCallId = '', autoAnswer = false } = {}) {
  // null | { callId, direction, status, contactName, phone, conversationId }
  const [call, setCall] = useState(null);
  const [muted, setMuted] = useState(false);
  const [needsAudioUnlock, setNeedsAudioUnlock] = useState(false);
  const [seconds, setSeconds] = useState(0);
  // Altavoz apagado por defecto (estilo WhatsApp): la voz va a la salida por
  // defecto del sistema y el agente la sube al altavoz cuando quiere.
  const [speakerOn, setSpeakerOn] = useState(false);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const timerRef = useRef(null);
  const autoAnswerAttemptRef = useRef('');
  // El OFFER de una entrante llega por socket y se usa recién al aceptar.
  const pendingOfferRef = useRef('');
  // Salidas de audio del sistema y espejo de speakerOn para usarlas dentro de
  // callbacks sin reconstruirlos en cada render.
  const outputsRef = useRef([]);
  const speakerOnRef = useRef(false);

  // Elemento <audio> oculto donde suena la voz del contacto.
  useEffect(() => {
    const el = document.createElement('audio');
    el.autoplay = true;
    el.playsInline = true;
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
    remoteStreamRef.current = null;
    pendingOfferRef.current = '';
    setMuted(false);
    setNeedsAudioUnlock(false);
    setSeconds(0);
    setSpeakerOn(false);
    speakerOnRef.current = false;
  }, []);

  // Lista de salidas de audio. Los labels solo llegan con permiso de micro ya
  // concedido, así que se refresca al montar la conexión de cada llamada.
  const refreshOutputs = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      outputsRef.current = (devices || []).filter((d) => d.kind === 'audiooutput');
    } catch {
      outputsRef.current = [];
    }
  }, []);

  /**
   * Enruta el audio remoto según el altavoz. `setSinkId` solo existe en
   * Chrome/Edge/Opera (desktop y Android): donde no está —Safari/iOS, Firefox—
   * la llamada suena por la salida por defecto y el botón no tiene efecto.
   */
  const applyOutput = useCallback(async (on) => {
    const el = remoteAudioRef.current;
    if (!el || typeof el.setSinkId !== 'function') return;
    try {
      if (!on) {
        // Auricular: si el sistema expone un dispositivo concreto (auricular/
        // manos libres/communications), usarlo; si no, la salida por defecto.
        const outputs = outputsRef.current.filter((d) => d.deviceId && d.deviceId !== 'default');
        const auricular = outputs.find((d) => /hand|ear|comm|head|auric/i.test(d.label || ''));
        await el.setSinkId(auricular ? auricular.deviceId : '');
      } else {
        // Altavoz: el 'default' del sistema ES el altavoz en la mayoría de
        // equipos; pedidos por id explícito para que el cambio siempre dispare.
        await el.setSinkId('default');
      }
    } catch (err) {
      console.warn('[call] no se pudo cambiar la salida de audio:', err?.message || err);
    }
  }, []);

  /** Alterna altavoz / auricular de la llamada en curso. */
  const toggleSpeaker = useCallback(() => {
    const next = !speakerOnRef.current;
    speakerOnRef.current = next;
    setSpeakerOn(next);
    applyOutput(next);
  }, [applyOutput]);

  const endLocally = useCallback(() => {
    cleanup();
    setCall(null);
  }, [cleanup]);

  const startTimer = useCallback(() => {
    if (timerRef.current) return;
    setSeconds(0);
    timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
  }, []);

  const playRemoteAudio = useCallback(async () => {
    const el = remoteAudioRef.current;
    if (!el?.srcObject) return;
    try {
      await el.play();
      setNeedsAudioUnlock(false);
    } catch (err) {
      // Safari/iOS y algunos Chrome bloquean autoplay aunque la llamada se haya
      // contestado desde un clic. La UI ofrece un botón explícito para activarlo.
      if (err?.name === 'NotAllowedError') setNeedsAudioUnlock(true);
      else console.warn('[call] no se pudo reproducir el audio remoto:', err?.message || err);
    }
  }, []);

  // Prepara la conexión WebRTC: micrófono + reproducción de la voz del contacto.
  const buildPeerConnection = useCallback(async () => {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      throw new Error('No se pudo usar el micrófono. Revisa los permisos del navegador.');
    }
    let iceServers = FALLBACK_ICE_SERVERS;
    try {
      const { data } = await api.get('/chats/calls/ice-config');
      if (Array.isArray(data?.iceServers) && data.iceServers.length) iceServers = data.iceServers;
    } catch {
      // El STUN público conserva el comportamiento anterior mientras se termina
      // de configurar TURN en un entorno recién desplegado.
    }
    const pc = new RTCPeerConnection({ iceServers });
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    pc.ontrack = (e) => {
      // Meta puede mandar una pista "streamless": en ese caso `streams` está
      // vacío. Antes asignábamos undefined al <audio>, causando exactamente el
      // audio de un solo sentido que reportaron los usuarios.
      let remoteStream = e.streams?.[0];
      if (!remoteStream) {
        remoteStream = remoteStreamRef.current || new MediaStream();
        if (!remoteStream.getTracks().some((track) => track.id === e.track.id)) {
          remoteStream.addTrack(e.track);
        }
      }
      remoteStreamRef.current = remoteStream;
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStream;
        playRemoteAudio();
        // La salida elegida (altavoz/auricular) sobrevive al nuevo stream.
        applyOutput(speakerOnRef.current);
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        toast.error('No se pudo conectar el audio. Revisa la red o la configuración TURN.');
        endLocally();
      }
    };
    localStreamRef.current = stream;
    pcRef.current = pc;
    // Con el permiso concedido ya hay labels: enumerar salidas y aplicar la
    // elección vigente de altavoz/auricular.
    refreshOutputs().then(() => applyOutput(speakerOnRef.current));
    return pc;
  }, [endLocally, playRemoteAudio, applyOutput, refreshOutputs]);

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
      const offerToRetry = offer;
      cleanup();
      // Si fue un permiso de microfono o un fallo local, la llamada aun puede
      // estar sonando: se conserva el panel y el OFFER para que el usuario
      // habilite el permiso y vuelva a pulsar Contestar. 404/409/502 significan
      // que la llamada ya termino o el proveedor rechazo la conexion.
      if ([404, 409, 502].includes(err.response?.status)) {
        setCall(null);
      } else {
        pendingOfferRef.current = offerToRetry;
      }
      toast.error(err.response?.data?.message || err.message || 'No se pudo aceptar la llamada');
    }
  }, [call, buildPeerConnection, cleanup, startTimer]);

  // Al abrir la PWA desde una notificacion no existe un socket historico que
  // pueda repetir el evento. Se recupera del servidor el OFFER que aun esta
  // sonando y se reconstruye exactamente el mismo panel de llamada entrante.
  useEffect(() => {
    let cancelled = false;
    const config = pendingCallId ? { params: { callId: pendingCallId } } : undefined;
    api.get('/chats/calls/pending', config)
      .then(({ data }) => {
        const incoming = data?.call;
        if (cancelled || !incoming?.callId || !incoming?.sdp) return;
        setCall((current) => {
          if (current) return current;
          pendingOfferRef.current = incoming.sdp;
          return {
            callId: incoming.callId,
            conversationId: incoming.conversationId,
            direction: 'in',
            status: 'ringing',
            contactName: incoming.contactName,
            phone: incoming.phone,
          };
        });
      })
      .catch(() => {
        // La bandeja sigue funcionando; puede que la llamada terminara durante
        // el arranque o que el telefono recuperara internet demasiado tarde.
      });
    return () => { cancelled = true; };
  }, [pendingCallId]);

  // La accion Contestar del aviso abre la PWA con answerCall=<id>. El toque en
  // la notificacion es la decision explicita del usuario: una vez recuperado el
  // OFFER se crea el answer WebRTC sin exigir un segundo toque en el panel.
  useEffect(() => {
    if (!autoAnswer || !pendingCallId || !call) return;
    if (call.callId !== pendingCallId || call.direction !== 'in' || call.status !== 'ringing') return;
    if (autoAnswerAttemptRef.current === call.callId) return;
    autoAnswerAttemptRef.current = call.callId;
    // Se difiere un tick para que la restauracion del panel termine su render
    // antes de abrir el permiso de microfono y crear la conexion WebRTC.
    const timer = setTimeout(() => acceptCall(), 0);
    return () => clearTimeout(timer);
  }, [autoAnswer, pendingCallId, call, acceptCall]);

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

  return {
    call,
    seconds,
    muted,
    needsAudioUnlock,
    speakerOn,
    startCall,
    acceptCall,
    rejectCall,
    hangUp,
    toggleMute,
    toggleSpeaker,
    resumeAudio: playRemoteAudio,
  };
}
