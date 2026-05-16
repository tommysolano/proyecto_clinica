// Helpers comunes para las páginas contables
export const fmt = (n) => {
  if (n === null || n === undefined || isNaN(n)) return '0.00';
  return Number(n).toLocaleString('es-EC', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const fmtDate = (d) => {
  if (!d) return '';
  return new Date(d).toLocaleDateString('es-EC');
};

export const today = () => new Date().toISOString().slice(0, 10);

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
