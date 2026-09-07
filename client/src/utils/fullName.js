/**
 * UN SOLO CAMPO «NOMBRE COMPLETO» → los dos que guarda el paciente.
 *
 * El sistema guarda `firstName` y `lastName` por separado (los usan la búsqueda,
 * la factura y todas las pantallas), pero quien registra a un contacto desde el
 * chat no está leyendo una cédula: está copiando lo que el paciente acaba de
 * escribir por WhatsApp. Pedirle que reparta ese texto en dos casillas es
 * trabajo que no aporta nada, y en la mitad de los casos se rellenaba mal.
 *
 * El reparto es HEURÍSTICO, con la convención ecuatoriana de dos apellidos:
 *   «Ana»                       → Ana
 *   «Ana Pérez»                 → Ana / Pérez
 *   «Ana Pérez Chávez»          → Ana / Pérez Chávez
 *   «Ana María Pérez Chávez»    → Ana María / Pérez Chávez
 *   «Ana María José Pérez Ch.»  → Ana María José / Pérez Ch.  (2 apellidos al final)
 *
 * Se puede equivocar («Juan Carlos Pérez» acaba como Juan / Carlos Pérez) y no
 * pasa nada grave: el nombre completo se ve igual en todas partes, y la ficha
 * del paciente es donde se corrige con el dato delante.
 */
export function partirNombreCompleto(fullName) {
  const tokens = String(fullName || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!tokens.length) return { firstName: '', lastName: '' };
  if (tokens.length === 1) return { firstName: tokens[0], lastName: '' };
  if (tokens.length === 2) return { firstName: tokens[0], lastName: tokens[1] };
  // 3 o más: los DOS últimos son los apellidos, el resto son nombres.
  return {
    firstName: tokens.slice(0, -2).join(' '),
    lastName: tokens.slice(-2).join(' '),
  };
}

/** «Ana» + «Pérez Chávez» → «Ana Pérez Chávez» (sin espacios sobrantes). */
export function unirNombreCompleto(firstName, lastName) {
  return `${firstName || ''} ${lastName || ''}`.replace(/\s+/g, ' ').trim();
}
