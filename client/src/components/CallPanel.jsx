import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  HiOutlinePhone,
  HiOutlinePhoneXMark,
  HiOutlinePhoneArrowDownLeft,
  HiOutlinePhoneArrowUpRight,
  HiOutlineMicrophone,
  HiOutlineSpeakerXMark,
  HiOutlineSpeakerWave,
  HiOutlineChevronDown,
  HiOutlineChevronUp,
  HiOutlineChatBubbleLeftRight,
  HiOutlineLockClosed,
  HiOutlineMinus,
} from 'react-icons/hi2';
import { formatDuration } from '../hooks/useVoiceRecorder';

/**
 * ¿Pantalla de teléfono? La pantalla completa es solo para el móvil (oct-2026):
 * en el escritorio tapaba el CRM entero en cuanto entraba una llamada y el
 * agente perdía de vista lo que estaba haciendo. Allí vuelve el panel flotante.
 */
const CONSULTA_MOVIL = '(max-width: 767px)';
function useEsMovil() {
  const [movil, setMovil] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(CONSULTA_MOVIL).matches
  );
  useEffect(() => {
    const mq = window.matchMedia?.(CONSULTA_MOVIL);
    if (!mq) return undefined;
    const alCambiar = () => setMovil(mq.matches);
    mq.addEventListener?.('change', alCambiar);
    return () => mq.removeEventListener?.('change', alCambiar);
  }, []);
  return !!movil;
}

/** Botón redondo grande con su rótulo debajo, como los de WhatsApp. */
function BotonLlamada({ onClick, label, title, icon, tono = 'neutro', activo = false, disabled = false, grande = false, rebote = false }) {
  const Icon = icon;
  const colores = {
    neutro: activo ? 'bg-white text-slate-900' : 'bg-white/15 text-white hover:bg-white/25',
    rojo: 'bg-rose-600 text-white hover:bg-rose-500',
    verde: 'bg-emerald-500 text-white hover:bg-emerald-400',
  }[tono];
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title || label}
        aria-label={label}
        className={`${grande ? 'w-[72px] h-[72px]' : 'w-16 h-16'} rounded-full border-none cursor-pointer flex items-center justify-center shadow-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${colores} ${rebote ? 'animate-bounce' : ''}`}
      >
        <Icon className={grande ? 'w-8 h-8' : 'w-7 h-7'} />
      </button>
      <span className="text-xs text-white/80">{label}</span>
    </div>
  );
}

/**
 * Llamada de WhatsApp en curso. En el MÓVIL va A PANTALLA COMPLETA (oct-2026),
 * como en WhatsApp: al entrar una llamada, al llamar y durante la conversación.
 * En el ESCRITORIO es el panel flotante de abajo a la derecha (el de antes): no
 * tapa el CRM.
 *
 * MINIMIZAR no cuelga: la deja en una pastilla para seguir usando el CRM
 * (abrir la ficha, agendar, escribir en el chat), que era la razón del panel
 * flotante de antes. «Ver chat» minimiza y abre la conversación del contacto.
 *
 * A propósito NO es un Modal: no se cierra con Escape ni con un clic fuera — de
 * una llamada solo se sale colgando. z-[10001]: encima de los modales (z-[9999]).
 *
 * Contestar es SIEMPRE una decisión de la persona: abrir la llamada desde el
 * aviso solo la enseña sonando.
 */
export default function CallPanel({
  call,
  seconds,
  muted,
  needsAudioUnlock,
  speakerOn,
  minimized,
  onMinimize,
  onExpand,
  onOpenChat,
  onAccept,
  onReject,
  onHangUp,
  onToggleMute,
  onToggleSpeaker,
  onResumeAudio,
  accepting = false,
}) {
  const esMovil = useEsMovil();
  if (!call) return null;

  const isIncoming = call.direction === 'in';
  const ringing = call.status === 'ringing';
  const contactLabel = call.contactName || call.phone || 'Contacto';
  const mostrarTelefono = !!call.phone && call.contactName && call.contactName !== call.phone;
  const initials = contactLabel.replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/)
    .slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '?';
  const statusText = ringing
    ? isIncoming ? 'Llamada entrante de WhatsApp' : 'Llamando…'
    : formatDuration(seconds);

  // MINIMIZADA: pastilla siempre visible. La llamada sigue (y el timbre también,
  // si está sonando); un toque la devuelve a pantalla completa.
  if (minimized) {
    return createPortal(
      <button
        type="button"
        onClick={onExpand}
        title="Volver a la llamada"
        className={`fixed bottom-4 right-4 z-[10001] flex items-center gap-2 pl-2 pr-3 py-2 rounded-full text-white shadow-2xl shadow-emerald-900/30 border-none cursor-pointer ${
          ringing && isIncoming ? 'bg-amber-500 hover:bg-amber-600 animate-pulse' : 'bg-emerald-600 hover:bg-emerald-700'
        }`}
      >
        <span className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center text-[10px] font-bold">
          {initials}
        </span>
        <span className="flex flex-col items-start leading-tight">
          <span className="text-xs font-semibold max-w-[140px] truncate">{contactLabel}</span>
          <span className="text-[10px] tabular-nums text-white/85">
            {ringing ? (isIncoming ? 'Te está llamando · toca para ver' : 'Llamando…') : formatDuration(seconds)}
          </span>
        </span>
        <HiOutlineChevronUp className="w-4 h-4 text-white/80" />
      </button>,
      document.body
    );
  }

  // ESCRITORIO: panel flotante, sin tapar el CRM.
  if (!esMovil) {
    return createPortal(
      <div
        role="dialog"
        aria-label={`Llamada con ${contactLabel}`}
        className="fixed bottom-4 right-4 z-[10001] w-[320px] max-w-[calc(100vw-2rem)] bg-white rounded-2xl shadow-2xl shadow-slate-900/25 ring-1 ring-slate-900/10 overflow-hidden"
      >
        <div className="px-4 py-4 flex items-center gap-3 bg-emerald-600 text-white">
          <div className="relative flex-shrink-0">
            <div className="w-11 h-11 rounded-full bg-white/20 flex items-center justify-center font-bold">
              {initials}
            </div>
            {ringing && <span className="absolute inset-0 rounded-full ring-2 ring-white/70 animate-ping" />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold truncate">{contactLabel}</div>
            <div className="text-xs text-emerald-50 flex items-center gap-1">
              {isIncoming && ringing && <HiOutlinePhoneArrowDownLeft className="w-3.5 h-3.5" />}
              <span className={ringing ? '' : 'tabular-nums'}>{accepting ? 'Conectando…' : statusText}</span>
            </div>
          </div>
          {onOpenChat && (
            <button
              type="button"
              onClick={onOpenChat}
              title="Abrir el chat del contacto (la llamada sigue)"
              className="flex-shrink-0 w-8 h-8 rounded-lg bg-white/10 border-none cursor-pointer flex items-center justify-center hover:bg-white/20 text-white"
            >
              <HiOutlineChatBubbleLeftRight className="w-4 h-4" />
            </button>
          )}
          <button
            type="button"
            onClick={onMinimize}
            title="Minimizar la llamada (sigue en curso)"
            className="flex-shrink-0 w-8 h-8 rounded-lg bg-white/10 border-none cursor-pointer flex items-center justify-center hover:bg-white/20 text-white"
          >
            <HiOutlineMinus className="w-4 h-4" />
          </button>
        </div>

        {muted && !ringing && (
          <p className="m-0 mx-4 mt-3 text-xs text-slate-500 text-center">Tu micrófono está silenciado</p>
        )}
        {needsAudioUnlock && !ringing && (
          <button
            type="button"
            onClick={onResumeAudio}
            className="mx-4 mt-3 w-[calc(100%-2rem)] py-2 rounded-lg bg-amber-50 text-amber-900 border border-amber-200 cursor-pointer hover:bg-amber-100 flex items-center justify-center gap-1.5 text-sm font-medium"
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
                disabled={accepting}
                title="Rechazar la llamada"
                className="flex-1 py-2.5 rounded-xl bg-rose-600 text-white border-none cursor-pointer hover:bg-rose-700 flex items-center justify-center gap-1.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <HiOutlinePhoneXMark className="w-4 h-4" /> Rechazar
              </button>
              <button
                type="button"
                onClick={onAccept}
                disabled={accepting}
                title="Contestar la llamada"
                className="flex-1 py-2.5 rounded-xl bg-emerald-600 text-white border-none cursor-pointer hover:bg-emerald-700 flex items-center justify-center gap-1.5 text-sm font-medium disabled:opacity-60 disabled:cursor-wait"
              >
                <HiOutlinePhone className="w-4 h-4" /> {accepting ? 'Conectando…' : 'Contestar'}
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
                  muted ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
              >
                <HiOutlineMicrophone className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={onToggleSpeaker}
                title={speakerOn ? 'Bajar del altavoz al auricular' : 'Subir al altavoz'}
                className={`w-11 h-11 rounded-full border flex items-center justify-center cursor-pointer ${
                  speakerOn ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
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

  // MÓVIL: pantalla completa, como WhatsApp.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Llamada con ${contactLabel}`}
      className="fixed inset-0 z-[10001] flex flex-col text-white bg-gradient-to-b from-emerald-900 via-slate-900 to-slate-950"
      style={{
        paddingTop: 'max(env(safe-area-inset-top), 0.75rem)',
        paddingBottom: 'max(env(safe-area-inset-bottom), 1.5rem)',
      }}
    >
      {/* Barra superior: minimizar · cifrado · ver chat */}
      <div className="flex items-center justify-between px-4 gap-3">
        <button
          type="button"
          onClick={onMinimize}
          title="Minimizar (la llamada sigue)"
          className="flex items-center gap-1.5 px-3 py-2 rounded-full bg-white/10 hover:bg-white/20 border-none cursor-pointer text-white text-sm"
        >
          <HiOutlineChevronDown className="w-5 h-5" />
          <span className="hidden sm:inline">Minimizar</span>
        </button>
        <span className="flex items-center gap-1.5 text-xs text-white/60 min-w-0">
          <HiOutlineLockClosed className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">Llamada de WhatsApp</span>
        </span>
        {onOpenChat ? (
          <button
            type="button"
            onClick={onOpenChat}
            title="Abrir el chat del contacto (la llamada sigue)"
            className="flex items-center gap-1.5 px-3 py-2 rounded-full bg-white/10 hover:bg-white/20 border-none cursor-pointer text-white text-sm"
          >
            <HiOutlineChatBubbleLeftRight className="w-5 h-5" />
            <span className="hidden sm:inline">Ver chat</span>
          </button>
        ) : <span className="w-10" />}
      </div>

      {/* Contacto */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center min-h-0">
        <div className="relative mb-6">
          {ringing && (
            <>
              <span className="absolute inset-0 rounded-full bg-emerald-400/25 animate-ping" />
              <span className="absolute -inset-4 rounded-full ring-2 ring-emerald-300/20" />
            </>
          )}
          <div className="relative w-32 h-32 sm:w-40 sm:h-40 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-700 flex items-center justify-center text-4xl sm:text-5xl font-bold shadow-2xl shadow-black/40">
            {initials}
          </div>
        </div>
        <h2 className="m-0 text-2xl sm:text-3xl font-semibold tracking-tight max-w-full truncate">{contactLabel}</h2>
        {mostrarTelefono && <p className="m-0 mt-1 text-sm text-white/60 tabular-nums">{call.phone}</p>}
        <p className={`m-0 mt-3 flex items-center gap-1.5 text-base ${ringing ? 'text-emerald-200' : 'text-white/85 tabular-nums'}`}>
          {ringing && (isIncoming
            ? <HiOutlinePhoneArrowDownLeft className="w-4 h-4" />
            : <HiOutlinePhoneArrowUpRight className="w-4 h-4" />)}
          {accepting ? 'Conectando…' : statusText}
        </p>
        {muted && !ringing && (
          <p className="m-0 mt-3 text-xs px-3 py-1 rounded-full bg-white/10 text-white/80">Tu micrófono está silenciado</p>
        )}
        {needsAudioUnlock && !ringing && (
          <button
            type="button"
            onClick={onResumeAudio}
            className="mt-5 px-4 py-2.5 rounded-full bg-amber-400 text-amber-950 border-none cursor-pointer hover:bg-amber-300 flex items-center gap-2 text-sm font-semibold"
          >
            <HiOutlineSpeakerWave className="w-5 h-5" /> Activar el audio del contacto
          </button>
        )}
      </div>

      {/* Controles */}
      <div className="px-6 pb-2">
        {isIncoming && ringing ? (
          <div className="flex items-start justify-center gap-20 sm:gap-28">
            <BotonLlamada onClick={onReject} disabled={accepting} label="Rechazar" title="Rechazar la llamada" icon={HiOutlinePhoneXMark} tono="rojo" grande />
            <BotonLlamada
              onClick={onAccept}
              disabled={accepting}
              label={accepting ? 'Conectando…' : 'Contestar'}
              title="Contestar la llamada"
              icon={HiOutlinePhone}
              tono="verde"
              grande
              rebote={!accepting}
            />
          </div>
        ) : (
          <div className="flex items-start justify-center gap-8 sm:gap-12">
            <BotonLlamada
              onClick={onToggleSpeaker}
              label={speakerOn ? 'Altavoz' : 'Auricular'}
              title={speakerOn ? 'Bajar del altavoz al auricular' : 'Subir al altavoz'}
              icon={speakerOn ? HiOutlineSpeakerWave : HiOutlineSpeakerXMark}
              activo={speakerOn}
            />
            <BotonLlamada
              onClick={onToggleMute}
              disabled={ringing}
              label={muted ? 'Silenciado' : 'Silenciar'}
              title={muted ? 'Activar el micrófono' : 'Silenciar el micrófono'}
              icon={HiOutlineMicrophone}
              activo={muted}
            />
            <BotonLlamada
              onClick={onHangUp}
              label={ringing ? 'Cancelar' : 'Colgar'}
              title={ringing ? 'Cancelar la llamada' : 'Colgar'}
              icon={HiOutlinePhoneXMark}
              tono="rojo"
              grande
            />
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
