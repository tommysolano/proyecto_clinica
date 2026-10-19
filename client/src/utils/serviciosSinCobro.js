/**
 * CANJE / CORTESÍA POR SERVICIO (oct-2026).
 *
 * En una visita con varios servicios puede que uno se cobre y otro no. Cada
 * servicio sin cobro va en `apt.noChargeServices[{serviceItem, kind}]`; si la
 * visita entera es canje/cortesía lo dice `isCanje`/`isCortesia`. Espejo de
 * `tipoSinCobroDelServicio` en server/utils/appointmentValue.js.
 */
const idDe = (v) => String(v?._id || v || '');

/** Los servicios de la visita, el principal primero: [{ id, name }]. */
export function serviciosDeLaCita(apt) {
  const out = [];
  const vistos = new Set();
  const sumar = (si, nombre) => {
    const id = idDe(si);
    if (!id || vistos.has(id)) return;
    vistos.add(id);
    out.push({ id, name: si?.name || nombre || 'Servicio' });
  };
  sumar(apt?.serviceItem, apt?.serviceName);
  for (const s of apt?.additionalServices || []) sumar(s.serviceItem, s.name);
  return out;
}

/** '' (se cobra) | 'canje' | 'cortesia' para un servicio de la cita. */
export function tipoSinCobro(apt, serviceItem) {
  if (apt?.isCanje) return 'canje';
  if (apt?.isCortesia) return 'cortesia';
  const id = idDe(serviceItem);
  const e = (apt?.noChargeServices || []).find((x) => idDe(x.serviceItem) === id);
  return e?.kind || '';
}

/** La lista `noChargeServices` tal como la guarda la cita, en ids de texto. */
export function listaSinCobro(apt) {
  return (apt?.noChargeServices || []).map((e) => ({ serviceItem: idDe(e.serviceItem), kind: e.kind }));
}

/**
 * La lista para EDITAR: si la visita entera es canje/cortesía, todos sus
 * servicios salen marcados así (la marca de la visita los cubre a todos).
 */
export function listaSinCobroParaEditar(apt) {
  const kind = apt?.isCanje ? 'canje' : apt?.isCortesia ? 'cortesia' : '';
  if (kind) return serviciosDeLaCita(apt).map((s) => ({ serviceItem: s.id, kind }));
  return listaSinCobro(apt);
}

/** ¿Con esta lista ningún servicio se cobra? */
export function todosSinCobro(servicios, lista) {
  return servicios.length > 0
    && servicios.every((s) => (lista || []).some((e) => idDe(e.serviceItem) === String(s.id)));
}

/** Cambia el tipo de un servicio en la lista (''= se cobra). */
export function conTipo(lista, serviceItem, kind) {
  const id = idDe(serviceItem);
  const resto = (lista || []).filter((e) => idDe(e.serviceItem) !== id);
  return kind ? [...resto, { serviceItem: id, kind }] : resto;
}

export const ETIQUETA_SIN_COBRO = { canje: 'Canje', cortesia: 'Cortesía' };

/**
 * Los servicios de un FORMULARIO (principal + otros, como {_id, name} o ids
 * sueltos) en [{id, name}], sin repetir.
 */
export function serviciosDeFormulario(principal, extras = []) {
  const out = [];
  for (const s of [principal, ...(extras || [])]) {
    const id = String(s?._id || (typeof s === 'string' ? s : '') || '');
    if (id && !out.some((x) => x.id === id)) out.push({ id, name: s?.name || 'Servicio' });
  }
  return out;
}

/**
 * Lo que va al servidor: con varios servicios, la lista por servicio (y valor 0
 * si ninguno se cobra); con uno, las casillas de la visita de siempre.
 */
export function camposDeValorConServicios({ servicios, sinCobro, agreedValue, isCanje, isCortesia }) {
  if (servicios.length < 2) {
    return { agreedValue: isCanje || isCortesia ? 0 : agreedValue, isCanje: !!isCanje, isCortesia: !!isCortesia };
  }
  const lista = (sinCobro || []).filter((e) => servicios.some((s) => s.id === String(e.serviceItem)));
  return { agreedValue: todosSinCobro(servicios, lista) ? 0 : agreedValue, noChargeServices: lista };
}
