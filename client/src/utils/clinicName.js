/** Nombre visible de una sucursal: el comercial si lo tiene, si no el legal. */
export const nombreSucursal = (c) => c?.nombreComercial || c?.name || 'Sucursal';
