import { useEffect, useRef, useState } from 'react';
import api from '../api/axios';

// Identificaciones "genéricas" que no deben disparar consulta (consumidor final).
const SKIP = new Set(['', '9999999999', '9999999999999']);

const EMPTY = { loading: false, error: false, found: false, msg: '' };

/**
 * Decide con qué valor quedarse al autocompletar un campo, respetando lo que el
 * usuario escribió a mano pero permitiendo re-sobrescribir cuando cambia la
 * cédula/RUC:
 *   - `current`: valor actual del campo.
 *   - `next`: valor nuevo del SRI ('' si no se encontró nada).
 *   - `prevAuto`: valor que ESTE mismo autocompletado puso la última vez.
 *   - `defaults`: valores "placeholder" que se tratan como vacíos (p. ej.
 *     "Consumidor Final").
 *
 * Regla: si hay dato nuevo, se llena cuando el campo está vacío, es un default,
 * o su valor coincide con el que autollenamos antes (el usuario no lo tocó). Si
 * NO hay dato nuevo, solo se limpia lo que habíamos autollenado (no se borra lo
 * que el usuario escribió).
 */
export function fillField(current, next, prevAuto, defaults = []) {
  const cur = (current ?? '').toString();
  const trimmed = cur.trim();
  const wasAuto = prevAuto != null && prevAuto !== '' && cur === String(prevAuto);
  if (next) {
    if (trimmed === '' || defaults.includes(trimmed) || wasAuto) return next;
    return current;
  }
  return wasAuto ? '' : current;
}

/**
 * Consulta una cédula (10 díg.) o RUC (13 díg.) en el SRI para autocompletar
 * formularios. Cuando el valor cambia y es válido, tras un breve debounce llama
 * al backend (`/lookup/tax-id/:id` por defecto) y:
 *   - ejecuta `onData(data, prevData)` para que el formulario llene sus campos
 *     (usar `fillField` con `prevData?.<campo>` para permitir re-sobrescritura), y
 *   - devuelve un estado `{ loading, error, found, msg }` para mostrar al usuario
 *     que se está buscando/llenando (indicador de carga).
 *
 * Los pasaportes (alfanuméricos o de otra longitud) no disparan consulta: se
 * escriben libremente y la facturación los trata como tipo de identificación 06.
 *
 * Opciones:
 *   - enabled: si es false no consulta (modal cerrado, edición, sin permiso…).
 *   - onData(data, prevData): callback para llenar el formulario.
 *   - existingIsError: si true, cuando ya existe un paciente con esa cédula se
 *     marca error y NO se llama onData (evita duplicados en el alta de pacientes).
 *   - endpoint(id): url alternativa (para la página pública de reservas).
 *   - informativo: el SRI AYUDA, no manda. Nada de lo que responda se pinta como
 *     error: si no reconoce la identificación o la consulta falla, se dice en
 *     gris y el formulario se guarda igual. Es para los formularios donde la
 *     identificación es un dato interno (el personal de la clínica) y no el de
 *     un comprobante fiscal — ahí una cédula que el SRI no valida seguía siendo
 *     un aviso rojo que se leía como «no puedes guardar esto», y bloqueaba dar
 *     de alta a alguien con pasaporte, cédula extranjera o una que el dígito
 *     verificador rechaza. En facturación NO se usa: allí un RUC malo revienta
 *     el comprobante en el SRI y el rojo está bien puesto.
 */
export default function useSriLookup(
  taxId,
  { enabled = true, onData, existingIsError = false, endpoint, informativo = false } = {}
) {
  const [status, setStatus] = useState(EMPTY);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;
  // Último dato que ESTE hook autollenó (para permitir re-sobrescritura).
  const appliedRef = useRef(null);

  const id = (taxId || '').trim();

  useEffect(() => {
    if (!enabled || SKIP.has(id) || !/^(\d{10}|\d{13})$/.test(id)) {
      setStatus(EMPTY);
      return;
    }
    let cancelled = false;
    const label = id.length === 13 ? 'RUC' : 'cédula';
    setStatus({ loading: true, error: false, found: false, msg: 'Buscando en el SRI…' });
    const t = setTimeout(async () => {
      try {
        const url = endpointRef.current ? endpointRef.current(id) : `/lookup/tax-id/${id}`;
        const { data } = await api.get(url);
        if (cancelled) return;
        if (data.alreadyExists && existingIsError) {
          setStatus({ loading: false, error: true, found: false, msg: `Ya existe un registro con esta ${label}.` });
          return;
        }
        onDataRef.current?.(data, appliedRef.current);
        appliedRef.current = data.found ? data : null;
        if (data.found) {
          setStatus({ loading: false, error: false, found: true, msg: `Datos cargados desde el SRI: ${data.fullName}` });
        } else {
          setStatus({ loading: false, error: false, found: false, msg: `Sin datos públicos para esta ${label}. Ingrésalos manualmente.` });
        }
      } catch (err) {
        if (cancelled) return;
        const m = err.response?.data?.message || 'No se pudo consultar el SRI';
        // En modo informativo el fallo del SRI es una nota, no un veto: el
        // formulario se guarda igual con lo que se haya escrito.
        setStatus(
          informativo
            ? { loading: false, error: false, found: false, msg: `${m}. Puedes guardarla igual.` }
            : { loading: false, error: true, found: false, msg: m }
        );
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, enabled, existingIsError, informativo]);

  return status;
}
