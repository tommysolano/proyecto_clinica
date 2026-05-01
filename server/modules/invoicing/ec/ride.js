/**
 * Generación del RIDE (Representación Impresa del Documento Electrónico) en PDF.
 * Usa Puppeteer para renderizar HTML.
 *
 * Nota: Puppeteer descarga Chromium la primera vez. En servidores con poco
 * espacio considerar `puppeteer-core` + Chromium del sistema.
 */
const puppeteer = require('puppeteer');

function n2(v) {
  return Number(v || 0).toFixed(2);
}
function escape(s) {
  return String(s ?? '').replace(/[<>&]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'
  );
}

/**
 * Construye el HTML del RIDE.
 */
function buildRideHtml({ invoice, sale, config, clinic, autorizacion }) {
  const fechaAut = autorizacion?.fechaAutorizacion
    ? new Date(autorizacion.fechaAutorizacion).toLocaleString('es-EC')
    : '';

  const items = (sale?.items || [])
    .map(
      (it) => `
      <tr>
        <td>${escape(it.productCode || '')}</td>
        <td>${escape(it.productName)}</td>
        <td class="r">${n2(it.quantity)}</td>
        <td class="r">${n2(it.unitPrice)}</td>
        <td class="r">${n2(it.subtotal)}</td>
      </tr>`
    )
    .join('');

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Factura ${invoice.numeroFactura}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 11px; color: #222; padding: 24px; }
  h1 { font-size: 14px; margin: 0 0 4px; }
  .row { display: flex; gap: 16px; }
  .col { flex: 1; }
  .box { border: 1px solid #999; padding: 8px; border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { border: 1px solid #999; padding: 4px 6px; }
  th { background: #eee; }
  .r { text-align: right; }
  .totales { width: 280px; margin-left: auto; margin-top: 8px; }
  .totales td { border: none; padding: 2px 6px; }
  .totales .label { color: #555; }
  .clave { font-family: monospace; font-size: 10px; word-break: break-all; }
</style>
</head>
<body>
  <div class="row">
    <div class="col box">
      <h1>${escape(config.razonSocial)}</h1>
      ${config.nombreComercial ? `<div>${escape(config.nombreComercial)}</div>` : ''}
      <div>RUC: ${escape(config.ruc)}</div>
      <div>Dir. Matriz: ${escape(config.direccionMatriz || '')}</div>
      <div>Dir. Sucursal: ${escape(config.direccionEstablecimiento || '')}</div>
      <div>Obligado a llevar contabilidad: ${escape(config.obligadoContabilidad || 'NO')}</div>
    </div>
    <div class="col box">
      <div><b>FACTURA</b></div>
      <div>No.: <b>${invoice.numeroFactura}</b></div>
      <div>Ambiente: ${invoice.ambiente === '2' ? 'PRODUCCIÓN' : 'PRUEBAS'}</div>
      <div>Emisión: NORMAL</div>
      <div>Fecha de emisión: ${escape(invoice.fechaEmision)}</div>
      <div>Fecha autorización: ${escape(fechaAut)}</div>
      <div>Estado: <b>${escape(invoice.estado)}</b></div>
      <div style="margin-top:6px">Clave de acceso:</div>
      <div class="clave">${escape(invoice.claveAcceso)}</div>
    </div>
  </div>

  <div class="box" style="margin-top:12px">
    <div><b>Cliente:</b> ${escape(invoice.razonSocialComprador)}</div>
    <div><b>Identificación:</b> ${escape(invoice.identificacionComprador)}</div>
    ${invoice.direccionComprador ? `<div><b>Dirección:</b> ${escape(invoice.direccionComprador)}</div>` : ''}
    ${invoice.emailComprador ? `<div><b>Email:</b> ${escape(invoice.emailComprador)}</div>` : ''}
  </div>

  <table>
    <thead>
      <tr><th>Código</th><th>Descripción</th><th>Cant.</th><th>P. Unit.</th><th>Total</th></tr>
    </thead>
    <tbody>${items}</tbody>
  </table>

  <table class="totales">
    <tr><td class="label">Subtotal sin imp.</td><td class="r">${n2(invoice.totalSinImpuestos)}</td></tr>
    <tr><td class="label">IVA</td><td class="r">${n2(invoice.totalImpuesto)}</td></tr>
    <tr><td class="label"><b>Total</b></td><td class="r"><b>${n2(invoice.importeTotal)}</b></td></tr>
  </table>
</body>
</html>`;
}

async function renderPdf(html) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
    });
  } finally {
    await browser.close();
  }
}

async function buildRidePdf(ctx) {
  const html = buildRideHtml(ctx);
  return renderPdf(html);
}

module.exports = { buildRidePdf, buildRideHtml };
