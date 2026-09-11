/**
 * Cuenta el avance de una línea de suero tal como se registra en la ficha:
 * cada entrada en `administrations` equivale a una dosis aplicada.
 */
export function serumProgress(item) {
  const prescribed = Math.max(0, Number(item?.quantity) || 0);
  const applied = Array.isArray(item?.administrations) ? item.administrations.length : 0;
  const remaining = Math.max(0, prescribed - applied);

  return {
    prescribed,
    applied,
    remaining,
    pending: prescribed > applied,
  };
}

export function pendingSerums(followUp) {
  return (followUp?.recetaItems || []).filter(
    (item) => item?.isSerum && serumProgress(item).pending
  );
}
