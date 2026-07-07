import { useEffect, useState } from 'react';
import api from '../api/axios';

// Chequeo rápido de formato en el cliente (feedback instantáneo). El backend
// hace la validación real (dominio con MX + typos + desechables).
const QUICK_RE = /^(?!.*\.\.)[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EMPTY = { loading: false, error: false, valid: false, msg: '', suggestion: '' };

/**
 * Valida un correo con el mismo patrón que la cédula/RUC: formato offline
 * (instantáneo) + verificación online del dominio (MX) tras un debounce.
 * Devuelve { loading, error, valid, msg, suggestion } para mostrar el estado.
 */
export default function useEmailValidation(email, { enabled = true, path = '/lookup/email' } = {}) {
  const [status, setStatus] = useState(EMPTY);
  const e = (email || '').trim();

  useEffect(() => {
    if (!enabled || e === '') {
      setStatus(EMPTY);
      return;
    }
    // Formato inválido: feedback inmediato, sin llamar al backend.
    if (e.length > 254 || !QUICK_RE.test(e)) {
      setStatus({ loading: false, error: true, valid: false, msg: 'Correo con formato inválido', suggestion: '' });
      return;
    }
    let cancelled = false;
    setStatus({ loading: true, error: false, valid: false, msg: 'Verificando correo…', suggestion: '' });
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get(path, { params: { email: e } });
        if (cancelled) return;
        const suggestion = data.suggestion || '';
        if (data.valid) {
          setStatus({ loading: false, error: false, valid: true, msg: 'Formato y dominio válidos', suggestion });
        } else {
          const msg = !data.format
            ? 'Correo con formato inválido'
            : data.disposable
            ? 'Correo temporal/desechable — usa uno permanente'
            : 'El dominio no recibe correos, revisa que esté bien escrito';
          setStatus({ loading: false, error: true, valid: false, msg, suggestion });
        }
      } catch (err) {
        // Si el backend falla, no bloqueamos: no mostramos error.
        if (!cancelled) setStatus(EMPTY);
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [e, enabled, path]);

  return status;
}
