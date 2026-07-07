import { useEffect, useRef, useState } from 'react';
import api from '../api/axios';

// Identificaciones "genéricas" que no deben disparar consulta (consumidor final).
const SKIP = new Set(['', '9999999999', '9999999999999']);

const EMPTY = { loading: false, error: false, found: false, msg: '' };

/**
 * Consulta una cédula (10 díg.) o RUC (13 díg.) en el SRI para autocompletar
 * formularios. Cuando el valor cambia y es válido, tras un breve debounce llama
 * al backend (`/lookup/tax-id/:id` por defecto) y:
 *   - ejecuta `onData(data)` con los datos encontrados para que el formulario
 *     llene sus campos, y
 *   - devuelve un estado `{ loading, error, found, msg }` para mostrar al usuario
 *     que se está buscando/llenando (indicador de carga).
 *
 * Opciones:
 *   - enabled: si es false no consulta (modal cerrado, edición, sin permiso…).
 *   - onData(data): callback para llenar el formulario con lo encontrado.
 *   - existingIsError: si true, cuando ya existe un paciente con esa cédula se
 *     marca error y NO se llama onData (evita duplicados en el alta de pacientes).
 *   - endpoint(id): url alternativa (para la página pública de reservas).
 */
export default function useSriLookup(
  taxId,
  { enabled = true, onData, existingIsError = false, endpoint } = {}
) {
  const [status, setStatus] = useState(EMPTY);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;

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
        onDataRef.current?.(data);
        if (data.found) {
          setStatus({ loading: false, error: false, found: true, msg: `Datos cargados desde el SRI: ${data.fullName}` });
        } else {
          setStatus({ loading: false, error: false, found: false, msg: `Sin datos públicos para esta ${label}. Ingrésalos manualmente.` });
        }
      } catch (err) {
        if (cancelled) return;
        const m = err.response?.data?.message || 'No se pudo consultar el SRI';
        setStatus({ loading: false, error: true, found: false, msg: m });
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, enabled, existingIsError]);

  return status;
}
