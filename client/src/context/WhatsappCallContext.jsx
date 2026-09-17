import { createContext, useContext } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import useWhatsappCall from '../hooks/useWhatsappCall';
import CallPanel from '../components/CallPanel';

const WhatsappCallContext = createContext(null);

function ActiveWhatsappCallProvider({ children }) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const answerCallId = params.get('answerCall') || '';
  const pendingCallId = answerCallId || params.get('incomingCall') || '';
  const voiceCall = useWhatsappCall({ pendingCallId, autoAnswer: !!answerCallId });

  return (
    <WhatsappCallContext.Provider value={voiceCall}>
      {children}
      <CallPanel
        call={voiceCall.call}
        seconds={voiceCall.seconds}
        muted={voiceCall.muted}
        needsAudioUnlock={voiceCall.needsAudioUnlock}
        onAccept={voiceCall.acceptCall}
        onReject={voiceCall.rejectCall}
        onHangUp={voiceCall.hangUp}
        onToggleMute={voiceCall.toggleMute}
        onResumeAudio={voiceCall.resumeAudio}
      />
    </WhatsappCallContext.Provider>
  );
}

/** Mantiene una sola llamada WebRTC aunque el usuario cambie de pagina. */
export function WhatsappCallProvider({ children }) {
  const { user, role } = useAuth();
  const allowed = !!user?.isSuperAdmin || ['admin', 'call_center', 'marketing'].includes(role);
  if (!allowed) return children;
  return <ActiveWhatsappCallProvider>{children}</ActiveWhatsappCallProvider>;
}

// Provider y consumidor se exportan juntos para que toda la app use la misma
// instancia global de llamada.
// eslint-disable-next-line react-refresh/only-export-components
export function useWhatsappCallContext() {
  return useContext(WhatsappCallContext);
}
