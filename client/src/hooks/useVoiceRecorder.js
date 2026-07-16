import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Grabación de notas de voz para el chat (MediaRecorder del navegador).
 *
 * El contenedor depende del navegador: Chrome solo sabe grabar WebM/Opus,
 * Firefox puede dar Ogg y Safari MP4. Da igual cuál salga: el servidor
 * normaliza todo a ogg/opus (utils/audioTranscode), que es lo único que
 * WhatsApp reproduce como nota de voz.
 *
 * Requiere contexto seguro (https o localhost) para acceder al micrófono.
 */
const CONTAINERS = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  return CONTAINERS.find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
}

export function formatDuration(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * @param {(blob: Blob) => void} onRecorded - recibe el audio al detener. NO se
 *   llama si la grabación se cancela.
 * @param {number} maxSeconds - corte automático de seguridad.
 */
export default function useVoiceRecorder({ onRecorded, maxSeconds = 300 } = {}) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const cancelledRef = useRef(false);
  const timerRef = useRef(null);
  // En un ref para que el handler 'stop' del recorder use siempre el callback
  // actual sin tener que re-crear el recorder.
  const onRecordedRef = useRef(onRecorded);
  onRecordedRef.current = onRecorded;

  const releaseMic = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    // Soltar el micrófono apaga el indicador de grabación del navegador.
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setRecording(false);
    setSeconds(0);
  }, []);

  const start = useCallback(async () => {
    if (recorderRef.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new Error('Este navegador no permite grabar audio');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      throw new Error('No se pudo usar el micrófono. Revisa los permisos del navegador.');
    }
    const mimeType = pickMimeType();
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    chunksRef.current = [];
    cancelledRef.current = false;
    rec.ondataavailable = (e) => {
      if (e.data?.size) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const chunks = chunksRef.current;
      chunksRef.current = [];
      const wasCancelled = cancelledRef.current;
      releaseMic();
      if (wasCancelled || !chunks.length) return;
      onRecordedRef.current?.(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
    };
    recorderRef.current = rec;
    streamRef.current = stream;
    rec.start();
    setRecording(true);
    setSeconds(0);
    timerRef.current = setInterval(() => {
      setSeconds((s) => {
        const next = s + 1;
        if (next >= maxSeconds) rec.stop(); // corte de seguridad
        return next;
      });
    }, 1000);
  }, [maxSeconds, releaseMic]);

  /** Detiene y entrega el audio grabado. */
  const stop = useCallback(() => {
    if (!recorderRef.current) return;
    cancelledRef.current = false;
    recorderRef.current.stop();
  }, []);

  /** Detiene y DESCARTA lo grabado. */
  const cancel = useCallback(() => {
    if (!recorderRef.current) return;
    cancelledRef.current = true;
    recorderRef.current.stop();
  }, []);

  // Salir del chat con la grabación activa debe soltar el micrófono.
  useEffect(() => () => {
    if (recorderRef.current) {
      cancelledRef.current = true;
      try { recorderRef.current.stop(); } catch { /* ya detenido */ }
    }
    releaseMic();
  }, [releaseMic]);

  return { recording, seconds, start, stop, cancel, supported: typeof MediaRecorder !== 'undefined' };
}
