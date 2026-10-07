import { createContext, useContext, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import useWhatsappCall from '../hooks/useWhatsappCall';
import CallPanel from '../components/CallPanel';
import { sonarEnBucle } from '../utils/sonidos';

const WhatsappCallContext = createContext(null);

function ActiveWhatsappCallProvider({ children }) {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const answerCallId = params.get('answerCall') || '';
  const pendingCallId = answerCallId || params.get('incomingCall') || '';
  const voiceCall = useWhatsappCall({ pendingCallId, autoAnswer: !!answerCallId });
  const { call } = voiceCall;

  /**
   * PANTALLA COMPLETA O MINIMIZADA (oct-2026). La llamada se abre a pantalla
   * completa, como en WhatsApp; minimizarla la deja en una pastilla para seguir
   * usando el CRM (ficha del paciente, agenda) sin colgar.
   *
   * Vuelve a pantalla completa con cada llamada NUEVA y cada vez que se toca el
   * aviso de la llamada. Con la app abierta, el service worker se lo pasa a la
   * página sin recargarla (ver `vk-aviso-abierto` en Layout); con la app
   * cerrada, la página nace con la llamada ya a pantalla completa. No se mira
   * la URL: la bandeja reescribe sus parámetros y eso reabriría la llamada que
   * el agente acaba de minimizar.
   */
  // Ligado a la llamada: una llamada nueva nace a pantalla completa sin tener
  // que reiniciar nada.
  const [minimizada, setMinimizada] = useState(null); // callId minimizado
  const minimized = !!call?.callId && minimizada === call.callId;
  const setMinimized = (v) => setMinimizada(v ? call?.callId || null : null);
  useEffect(() => {
    const alAbrirAviso = (e) => {
      if (/[?&](incomingCall|answerCall)=/.test(String(e.detail?.url || ''))) setMinimizada(null);
    };
    window.addEventListener('vk-aviso-abierto', alAbrirAviso);
    return () => window.removeEventListener('vk-aviso-abierto', alAbrirAviso);
  }, []);

  /**
   * EL TIMBRE. Entrante: suena hasta que alguien contesta o cuelga. Saliente:
   * el «tuuu…» mientras el contacto no contesta (antes de que conteste no hay
   * audio de WhatsApp que lo dé). Una sola pestaña suena (utils/sonidos.js).
   */
  const ringing = call?.status === 'ringing';
  useEffect(() => {
    if (!ringing || !call?.callId) return undefined;
    return call.direction === 'in'
      ? sonarEnBucle('timbre', call.callId, 3000)
      : sonarEnBucle('espera', call.callId, 4000);
  }, [ringing, call?.callId, call?.direction]);

  // La pestaña lo dice también en su título, para quien esté en otra pestaña.
  useEffect(() => {
    if (!ringing || call?.direction !== 'in') return undefined;
    const anterior = document.title;
    document.title = `📞 Llamada de ${call.contactName || call.phone || 'WhatsApp'}`;
    return () => { document.title = anterior; };
  }, [ringing, call?.direction, call?.contactName, call?.phone]);

  const value = {
    ...voiceCall,
    minimized,
    /** Vuelve a la pantalla completa de la llamada en curso. */
    showCall: () => setMinimized(false),
  };

  return (
    <WhatsappCallContext.Provider value={value}>
      {children}
      <CallPanel
        call={call}
        seconds={voiceCall.seconds}
        muted={voiceCall.muted}
        needsAudioUnlock={voiceCall.needsAudioUnlock}
        speakerOn={voiceCall.speakerOn}
        accepting={voiceCall.accepting}
        minimized={minimized}
        onMinimize={() => setMinimized(true)}
        onExpand={() => setMinimized(false)}
        onOpenChat={call?.conversationId
          ? () => {
              setMinimized(true);
              navigate(`/chats?chat=${encodeURIComponent(String(call.conversationId))}`);
            }
          : null}
        onAccept={voiceCall.acceptCall}
        onReject={voiceCall.rejectCall}
        onHangUp={voiceCall.hangUp}
        onToggleMute={voiceCall.toggleMute}
        onToggleSpeaker={voiceCall.toggleSpeaker}
        onResumeAudio={voiceCall.resumeAudio}
      />
    </WhatsappCallContext.Provider>
  );
}

/**
 * ¿Este usuario usa las llamadas de WhatsApp? Call center, marketing y el
 * super-admin; el administrador NO (sep-2026). Misma regla que las rutas
 * /chats/.../call* del servidor. Sin llamadas no se monta el provider y
 * `useWhatsappCallContext()` devuelve null: así lo detecta la bandeja.
 */
function canUseWhatsappCalls(user, role) {
  return !!user?.isSuperAdmin || ['call_center', 'marketing'].includes(role);
}

/** Mantiene una sola llamada WebRTC aunque el usuario cambie de pagina. */
export function WhatsappCallProvider({ children }) {
  const { user, role } = useAuth();
  if (!canUseWhatsappCalls(user, role)) return children;
  return <ActiveWhatsappCallProvider>{children}</ActiveWhatsappCallProvider>;
}

// Provider y consumidor se exportan juntos para que toda la app use la misma
// instancia global de llamada.
// eslint-disable-next-line react-refresh/only-export-components
export function useWhatsappCallContext() {
  return useContext(WhatsappCallContext);
}
