// Helpers comunes para las páginas contables
export const fmt = (n) => {
  if (n === null || n === undefined || isNaN(n)) return '0.00';
  return Number(n).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const fmtDate = (d) => {
  if (!d) return '';
  const str = String(d);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const dt = new Date(str);
  if (Number.isNaN(dt.getTime())) return '';
  return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
};

export const today = () => new Date().toISOString().slice(0, 10);

// Encabezado del comprobante de retención (compartido por el modal de compra y el visor de solo lectura).
export const RET_ESTADO_LABEL = {
  BORRADOR: 'Borrador', EN_COLA: 'En cola', FIRMADO: 'Firmado', RECIBIDA: 'Recibida en el SRI',
  AUTORIZADO: 'Autorizado', NO_AUTORIZADO: 'No autorizado', DEVUELTA: 'Devuelta por el SRI',
  ERROR: 'Con error', ANULADA: 'Anulada', PENDIENTE_ANULACION: 'Pendiente de anulación', REGISTRADA: 'Registrada',
};
// Número legible del comprobante (estab-ptoEmi-secuencial), con la serie como respaldo.
export const retVoucherNumber = (v) => (v?.estab && v?.ptoEmi && v?.secuencial)
  ? `${v.estab}-${v.ptoEmi}-${v.secuencial}` : (v?.serie || '—');

export const startOfMonth = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
};

export const endOfMonth = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
};

export const downloadBlob = (data, filename, mime = 'text/xml') => {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
};
