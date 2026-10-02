import { useEffect, useState } from 'react';
import api from '../api/axios';

/**
 * EL CATÁLOGO DE SERVICIOS DE LA AGENDA, una sola descarga para toda la página.
 *
 * Desde oct-2026 son los productos de tipo SERVICIO del inventario: cerca de mil
 * nombres, y el servidor no comprime las respuestas. Un formulario de cita monta
 * varios buscadores a la vez (el servicio, los otros servicios, cada cita de la
 * tanda del chat…) y cada uno lo pedía por su cuenta. Aquí se pide una vez y se
 * comparte durante un minuto.
 */
const VIGENCIA_MS = 60 * 1000;
let pendiente = null;
let cuando = 0;

export function cargarServiciosAgenda({ fresco = false } = {}) {
  if (!fresco && pendiente && Date.now() - cuando < VIGENCIA_MS) return pendiente;
  cuando = Date.now();
  pendiente = api
    .get('/appointment-service-items')
    .then((r) => (Array.isArray(r.data) ? r.data : []))
    .catch((err) => {
      // Un fallo no se queda guardado: el siguiente buscador lo vuelve a pedir.
      pendiente = null;
      throw err;
    });
  return pendiente;
}

/** La lista, para pintarla en un componente. Vacía mientras llega o si falla. */
export function useServiciosAgenda() {
  const [lista, setLista] = useState([]);
  useEffect(() => {
    let vivo = true;
    cargarServiciosAgenda()
      .then((l) => { if (vivo) setLista(l); })
      .catch(() => {});
    return () => { vivo = false; };
  }, []);
  return lista;
}
