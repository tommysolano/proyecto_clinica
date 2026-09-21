import { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  HiOutlinePhone,
  HiOutlinePhoneXMark,
  HiOutlinePhoneArrowDownLeft,
  HiOutlineMicrophone,
  HiOutlineSpeakerXMark,
  HiOutlineSpeakerWave,
  HiOutlineMinus,
  HiOutlineChevronUp,
} from 'react-icons/hi2';
import { formatDuration } from '../hooks/useVoiceRecorder';

/**
 * Panel de una llamada de WhatsApp en curso.
 *
 * A propósito NO es un Modal: durante la llamada el agente necesita seguir
 * usando el CRM (abrir la ficha del paciente, agendar, ver el historial), así
 * que es un panel flotante que no bloquea la pantalla. Tampoco se cierra con
 * Escape ni al hacer clic fuera: de una llamada solo se sale colgando.
 *
 * z-[10001]: va ENCIMA de los modales (z-[9999]) — antes cualquier modal la
 * tapaba con su fondo oscuro y el agente no sabía si la llamada seguía en
 * curso. Se puede MINIMIZAR a una pill para no tapar el formulario con el
 * que se esté trabajando.
 */
export default function CallPanel({
  call,
  seconds,
  muted,
  needsAudioUnlock,
  speakerOn,
  onAccept,
  onReject,
  onHangUp,
  onToggleMute,
  onToggleSpeaker,
  onResumeAudio,
}) {
  const [minimized, setMinimized] = useState(false);
  if (!call) return null;

  const isIncoming = call.direction === 'in';
  const ringing = call.status === 'ringing';
  const statusText = ringing
    ? isIncoming
      ? 'Llamada entrante de WhatsApp'
      : 'Llamando…'
    : formatDuration(seconds);
  const contactLabel = call.contactName || call.phone || 'Contacto';
  const initials = contactLabel.slice(0, 2).toUpperCase();

  // MINIMIZADA: pill compacta siempre visible. La llamada sigue ahí — el
  // cronómetro corre y un toque la reexpande.
  if (minimized) {
    return createPortal(
      <button
        type="button"
        onClick={() => setMinimized(false)}
        title="Mostrar la llamada"
        className={`fixed bottom-4 right-4 z-[10001] flex items-center gap-2 pl-2 pr-3 py-2 rounded-full bg-emerald-600 text-white shadow-2xl shadow-emerald-900/30 border-none cursor-pointer hover:bg-emerald-700 ${
          ringing ? 'animate-pulse' : ''
        }`}
      >
        <span className="relative w-7 h-7 rounded-full bg-white/20 flex items-center justify-center text-[10px] font-bold">
          {initials}
        </span>
        <span className="text-xs font-semibold max-w-[120px] truncate">{contactLabel}</span>
        <span className="text-xs tabular-nums text-emerald-50">{ringing ? '…' : formatDuration(seconds)}</span>
        <HiOutlineChevronUp className="w-4 h-4 text-emerald-100" />
      </button>,
      document.body
    );
  }

  return createPortal(
    <div className="fixed bottom-4 right-4 z-[10001] w-[300px] max-w-[calc(100vw-2rem)] bg-white rounded-2xl shadow-2xl shadow-slate-900/25 ring-1 ring-slate-900/10 overflow-hidden">
      <div className="px-4 py-4 flex items-center gap-3 bg-emerald-600 text-white">
        <div className="relative flex-shrink-0">
          <div className="w-11 h-11 rounded-full bg-white/20 flex items-center justify-center font-bold">
            {initials}
          </div>
          {ringing && (
            <span className="absolute inset-0 rounded-full ring-2 ring-white/70 animate-ping" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate">{contactLabel}</div>
          <div className="text-xs text-emerald-50 flex items-center gap-1">
            {isIncoming && ringing && <HiOutlinePhoneArrowDownLeft className="w-3.5 h-3.5" />}
            <span className={ringing ? '' : 'tabular-nums'}>{statusText}</span>
          </div>
        </div>
        {!ringing && (
          <button
            type="button"
            onClick={() => setMinimized(true)}
            title="Minimizar la llamada (sigue en curso)"
            className="flex-shrink-0 w-8 h-8 rounded-lg bg-white/10 border-none cursor-pointer flex items-center justify-center hover:bg-white/20"
          >
            <HiOutlineMinus className="w-4 h-4" />
          </button>
        )}
      </div>

      {needsAudioUnlock && !ringing && (
        <button
          type="button"
          onClick={onResumeAudio}
          className="mx-4 mt-3 py-2 rounded-lg bg-amber-50 text-amber-900 border border-amber-200 cursor-pointer hover:bg-amber-100 flex items-center justify-center gap-1.5 text-sm font-medium"
        >
          <HiOutlineSpeakerWave className="w-4 h-4" /> Activar audio del contacto
        </button>
      )}

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
              onClick={onToggleSpeaker}
              title={speakerOn ? 'Bajar del altavoz al auricular' : 'Subir al altavoz'}
              className={`w-11 h-11 rounded-full border flex items-center justify-center cursor-pointer ${
                speakerOn
                  ? 'bg-emerald-600 text-white border-emerald-600'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {speakerOn ? <HiOutlineSpeakerWave className="w-5 h-5" /> : <HiOutlineSpeakerXMark className="w-5 h-5" />}
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
