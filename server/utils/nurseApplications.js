/**
 * QUÉ APLICÓ ENFERMERÍA EN ESTE TURNO.
 *
 * ─── EL PROBLEMA QUE RESUELVE ──────────────────────────────────────────────────
 * Cuando el enfermero pone un suero, la aplicación NO se guarda donde se lee. Se
 * guarda dentro de la línea de la receta del DOCTOR que lo mandó
 * (`followUps[N].recetaItems[K].administrations[]`), que es otra tarjeta y casi
 * siempre otro día. La tarjeta del turno de enfermería decía «Aplicación de
 * enfermería: Medicina General · Observaciones: Servicio aplicado por
 * enfermería» — o sea, nada de lo que de verdad entró por la vena del paciente.
 *
 * Esto recoge las administraciones que hizo UNA persona desde que empezó su
 * turno, para copiarlas en su propio seguimiento. Se COPIA, no se referencia:
 * una historia clínica tiene que decir lo que se hizo ese día aunque después
 * alguien corrija la receta.
 */

/**
 * Administraciones hechas por `userId` en este `record` desde `desde`.
 *
 * @param {object} record  documento (o lean) de ClinicalRecord
 * @param {string} userId  quién aplicó
 * @param {Date}   desde   momento a partir del cual cuenta (inicio del turno).
 *                         Sin fecha se toman TODAS las suyas, que es lo correcto
 *                         para la atención sin cita: no hay turno del que colgar.
 * @returns {Array} entradas listas para `followUps[].aplicaciones`
 */
function aplicacionesDelTurno(record, userId, desde = null) {
  if (!record || !userId) return [];
  const limite = desde ? new Date(desde).getTime() : null;
  const salida = [];

  for (const fu of record.followUps || []) {
    /**
     * Lo que el enfermero anotó en SU PROPIO parte no se copia.
     *
     * Cuando el enfermero registra un suero, el sistema lo administra en el acto
     * sobre su propia línea de receta: eso ya se ve en su tarjeta. Recogerlo aquí
     * además lo metería en el parte SIGUIENTE —el de mañana, el del otro
     * paciente— como si se hubiera puesto entonces.
     */
    if (String(fu.createdBy?._id || fu.createdBy || '') === String(userId)) continue;
    for (const item of fu.recetaItems || []) {
      for (const adm of item.administrations || []) {
        if (String(adm.by || '') !== String(userId)) continue;
        const cuando = adm.at ? new Date(adm.at).getTime() : null;
        // Sin fecha de aplicación no se puede saber si es de este turno; se deja
        // fuera antes que atribuirle a alguien algo que puso la semana pasada.
        if (limite !== null && (cuando === null || cuando < limite)) continue;
        salida.push({
          itemName: item.name || '',
          baseVolumeMl: adm.baseVolumeMl ?? null,
          baseName: item.serumBase?.name || '',
          components: (adm.components || []).map((c) => ({
            code: c.code || '',
            name: c.name || '',
            grupo: c.grupo || '',
            quantityPrescribed: Number(c.quantityPrescribed || 0),
            quantityApplied: Number(c.quantityApplied || 0),
            omitReason: c.omitReason || '',
          })),
          note: adm.note || '',
          at: adm.at || null,
          by: adm.by || null,
          byName: adm.byName || '',
        });
      }
    }
  }

  // En el orden en que se pusieron, que es como se cuenta lo que se hizo.
  salida.sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  return salida;
}

/**
 * Una línea legible de lo aplicado, para el motivo del seguimiento automático y
 * para los PDF. Ejemplo:
 *   «Sueroterapia (Cloruro 500 ml + Vitamina C ×2, Complejo B ×1)»
 */
function resumenAplicacion(a) {
  if (!a) return '';
  const partes = [];
  if (a.baseVolumeMl) partes.push(`${a.baseName || 'Cloruro'} ${a.baseVolumeMl} ml`);
  for (const c of a.components || []) {
    if (!Number(c.quantityApplied)) continue;
    partes.push(`${c.name}${Number(c.quantityApplied) > 1 ? ` ×${c.quantityApplied}` : ''}`);
  }
  const detalle = partes.join(' + ');
  return `${a.itemName || 'Aplicación'}${detalle ? ` (${detalle})` : ''}`;
}

/**
 * Desde cuándo contar cuando NO hay turno del que colgarse (atención sin cita).
 *
 * Se toma el último parte que ya escribió esta misma persona para este paciente:
 * lo que va después es lo nuevo. Sin esto, un paciente que viene a diario a su
 * serie de sueros vería en el parte de hoy también los de ayer y anteayer.
 *
 * MANDA `createdAt`, NO `fecha`. `fecha` la elige quien escribe (y por defecto es
 * el día de hoy, o sea las 00:00): con dos partes el mismo día —el detox de la
 * mañana y el suero de la tarde— el corte caería en la medianoche y el segundo
 * parte repetiría las dosis del primero. `createdAt` es la hora real en que se
 * guardó, que es lo que separa un turno del siguiente.
 */
function desdeElUltimoParteDe(record, userId) {
  let ultimo = null;
  for (const fu of record?.followUps || []) {
    if (String(fu.createdBy?._id || fu.createdBy || '') !== String(userId)) continue;
    if (!(fu.aplicaciones || []).length && fu.kind !== 'enfermeria') continue;
    // Los seguimientos anteriores a `timestamps` no tienen createdAt; ahí se cae
    // a `fecha`, que es lo único que hay.
    const cuando = fu.createdAt ? new Date(fu.createdAt) : (fu.fecha ? new Date(fu.fecha) : null);
    if (cuando && (!ultimo || cuando > ultimo)) ultimo = cuando;
  }
  return ultimo;
}

module.exports = { aplicacionesDelTurno, resumenAplicacion, desdeElUltimoParteDe };
