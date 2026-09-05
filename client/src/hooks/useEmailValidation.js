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
 *
 * `informativo`: el aviso AYUDA, no manda. No se pinta nada en rojo y nunca se
 * marca `error`, así que el formulario se guarda con el correo que sea. Es para
 * los correos internos (el del personal de la clínica), donde la comprobación de
 * dominio con MX daba falsos negativos —un servidor de correo propio, un dominio
 * que no contesta en ese momento— y el rojo se leía como «este correo no vale».
 * En facturación NO se usa: allí el correo es a donde va el comprobante.
 */
export default function useEmailValidation(
  email,
  { enabled = true, path = '/lookup/email', informativo = false } = {}
) {
  const [status, setStatus] = useState(EMPTY);
  const e = (email || '').trim();

  useEffect(() => {
    if (!enabled || e === '') {
      setStatus(EMPTY);
      return;
    }
    // Formato inválido: feedback inmediato, sin llamar al backend.
    if (e.length > 254 || !QUICK_RE.test(e)) {
      setStatus({
        loading: false,
        error: !informativo,
        valid: false,
        msg: informativo ? 'No parece un correo, pero se guarda igual' : 'Correo con formato inválido',
        suggestion: '',
      });
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
          // Informativo: se dice lo mismo, en gris, y se puede guardar igual.
          setStatus(
            informativo
              ? { loading: false, error: false, valid: false, msg: `${msg}. Puedes guardarlo igual.`, suggestion }
              : { loading: false, error: true, valid: false, msg, suggestion }
          );
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
  }, [e, enabled, path, informativo]);

  return status;
}
