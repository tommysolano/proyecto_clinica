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
 *
 * Cada EMPRESA tiene su catálogo (oct-2026): quien agenda en una sucursal de otra
 * empresa (el call center) pasa esa sucursal en `clinic` y recibe el de su empresa.
 * Sin `clinic`, el de la sucursal activa.
 */
const VIGENCIA_MS = 60 * 1000;
const porSucursal = new Map(); // clinic ('' = la activa) -> { promesa, cuando }

export function cargarServiciosAgenda({ fresco = false, clinic = '' } = {}) {
  const clave = clinic ? String(clinic) : '';
  const hit = porSucursal.get(clave);
  if (!fresco && hit && Date.now() - hit.cuando < VIGENCIA_MS) return hit.promesa;
  const promesa = api
    .get('/appointment-service-items', { params: clave ? { clinic: clave } : {} })
    .then((r) => (Array.isArray(r.data) ? r.data : []))
    .catch((err) => {
      // Un fallo no se queda guardado: el siguiente buscador lo vuelve a pedir.
      porSucursal.delete(clave);
      throw err;
    });
  porSucursal.set(clave, { promesa, cuando: Date.now() });
  return promesa;
}

/** La lista, para pintarla en un componente. Vacía mientras llega o si falla. */
export function useServiciosAgenda(clinic = '') {
  const [cargada, setCargada] = useState({ clinic: null, lista: [] });
  const clave = clinic ? String(clinic) : '';
  useEffect(() => {
    let vivo = true;
    cargarServiciosAgenda({ clinic: clave })
      .then((lista) => { if (vivo) setCargada({ clinic: clave, lista }); })
      .catch(() => {});
    return () => { vivo = false; };
  }, [clave]);
  // Al cambiar de sucursal no se enseña el catálogo de la anterior mientras llega.
  return cargada.clinic === clave ? cargada.lista : [];
}
