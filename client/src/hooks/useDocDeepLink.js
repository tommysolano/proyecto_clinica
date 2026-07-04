import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Deep-link a un documento desde otra pantalla (p.ej. el Libro Mayor).
 *
 * Si la URL trae `?doc=<id>` (o `?sourceRef=<id>`), invoca `onOpen(id)` UNA sola
 * vez al montar la página y luego limpia el query param para no reabrir en cada
 * re-render. El `onOpen` de cada página es responsable de buscar el documento y
 * abrirlo (modal/detalle) o mostrar el mensaje de error si no existe.
 */
export default function useDocDeepLink(onOpen) {
  const [params, setParams] = useSearchParams();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    const id = params.get('doc') || params.get('sourceRef');
    if (!id) return;
    handled.current = true;
    Promise.resolve()
      .then(() => onOpen(id))
      .catch(() => { /* el opener de la página muestra su propio mensaje de error */ })
      .finally(() => {
        const next = new URLSearchParams(params);
        next.delete('doc');
        next.delete('sourceRef');
        setParams(next, { replace: true });
      });
    // Solo al montar: el deep-link llega en la navegación inicial a la página.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
