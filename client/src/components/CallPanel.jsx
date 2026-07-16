import { createPortal } from 'react-dom';
import {
  HiOutlinePhone,
  HiOutlinePhoneXMark,
  HiOutlinePhoneArrowDownLeft,
  HiOutlineMicrophone,
  HiOutlineSpeakerXMark,
} from 'react-icons/hi2';
import { formatDuration } from '../hooks/useVoiceRecorder';

/**
 * Panel de una llamada de WhatsApp en curso.
 *
 * A propósito NO es un Modal: durante la llamada el agente necesita seguir
 * usando el CRM (abrir la ficha del paciente, agendar, ver el historial), así
 * que es un panel flotante que no bloquea la pantalla. Tampoco se cierra con
 * Escape ni al hacer clic fuera: de una llamada solo se sale colgando.
 */
export default function CallPanel({ call, seconds, muted, onAccept, onReject, onHangUp, onToggleMute }) {
  if (!call) return null;

  const isIncoming = call.direction === 'in';
  const ringing = call.status === 'ringing';
  const statusText = ringing
    ? isIncoming
      ? 'Llamada entrante de WhatsApp'
      : 'Llamando…'
    : formatDuration(seconds);

  return createPortal(
    <div className="fixed bottom-4 right-4 z-[9998] w-[300px] bg-white rounded-2xl shadow-2xl shadow-slate-900/25 ring-1 ring-slate-900/10 overflow-hidden">
      <div className="px-4 py-4 flex items-center gap-3 bg-emerald-600 text-white">
        <div className="relative flex-shrink-0">
          <div className="w-11 h-11 rounded-full bg-white/20 flex items-center justify-center font-bold">
            {(call.contactName || call.phone || '?').slice(0, 2).toUpperCase()}
          </div>
          {ringing && (
            <span className="absolute inset-0 rounded-full ring-2 ring-white/70 animate-ping" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate">{call.contactName || call.phone}</div>
          <div className="text-xs text-emerald-50 flex items-center gap-1">
            {isIncoming && ringing && <HiOutlinePhoneArrowDownLeft className="w-3.5 h-3.5" />}
            <span className={ringing ? '' : 'tabular-nums'}>{statusText}</span>
          </div>
        </div>
      </div>

      <div className="px-4 py-3 flex items-center justify-center gap-3">
        {isIncoming && ringing ? (
          <>
            <button
              type="button"
              onClick={onReject}
              title="Rechazar la llamada"
              className="flex-1 py-2.5 rounded-xl bg-rose-600 text-white border-none cursor-pointer hover:bg-rose-700 flex items-center justify-center gap-1.5 text-sm font-medium"
            >
              <HiOutlinePhoneXMark className="w-4 h-4" /> Rechazar
            </button>
            <button
              type="button"
              onClick={onAccept}
              title="Contestar la llamada"
              className="flex-1 py-2.5 rounded-xl bg-emerald-600 text-white border-none cursor-pointer hover:bg-emerald-700 flex items-center justify-center gap-1.5 text-sm font-medium"
            >
              <HiOutlinePhone className="w-4 h-4" /> Contestar
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onToggleMute}
              disabled={ringing}
              title={muted ? 'Activar el micrófono' : 'Silenciar el micrófono'}
              className={`w-11 h-11 rounded-full border flex items-center justify-center cursor-pointer disabled:opacity-40 ${
                muted
                  ? 'bg-slate-800 text-white border-slate-800'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {muted ? <HiOutlineSpeakerXMark className="w-5 h-5" /> : <HiOutlineMicrophone className="w-5 h-5" />}
            </button>
            <button
              type="button"
              onClick={onHangUp}
              title={ringing ? 'Cancelar la llamada' : 'Colgar'}
              className="flex-1 py-2.5 rounded-xl bg-rose-600 text-white border-none cursor-pointer hover:bg-rose-700 flex items-center justify-center gap-1.5 text-sm font-medium"
            >
              <HiOutlinePhoneXMark className="w-4 h-4" /> {ringing ? 'Cancelar' : 'Colgar'}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
