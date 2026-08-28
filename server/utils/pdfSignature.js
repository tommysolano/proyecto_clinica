/**
 * FIRMA ELECTRÓNICA DE PDFs (PAdES) con el certificado .p12 del profesional.
 *
 * La receta que se lleva el paciente deja de ser un papel con una imagen de
 * firma pegada y pasa a ser un documento firmado: dentro del PDF va una firma
 * PKCS#7 desprendida sobre el contenido, con el certificado del médico. Adobe
 * Reader (y cualquier validador) dice quién lo firmó y si se tocó algo después.
 *
 * DOS PIEZAS, y las dos importan:
 *   - La firma CRIPTOGRÁFICA, que es la que tiene valor y no se ve.
 *   - El recuadro VISIBLE que se dibuja en el HTML antes de generar el PDF
 *     (`bloqueFirmaHtml`), porque la receta se imprime en papel y en papel una
 *     firma invisible no le sirve a nadie.
 *
 * La contraseña del .p12 se guarda cifrada (ver `User.signatureCert`): quien
 * imprime la receta no siempre es quien la firmó — la firma es del médico que
 * atendió— así que el servidor tiene que poder usarla sin él delante.
 */
const fs = require('fs');
const path = require('path');

const { decrypt } = require('../modules/invoicing/ec/crypto');
const { loadP12 } = require('../modules/invoicing/ec/xadesSigner');

/** Los certificados de los profesionales, al lado del de la empresa (SRI). */
const USER_CERTS_DIR = path.join(__dirname, '..', 'storage', 'certs', 'users');

const rutaCertificado = (userId) => path.join(USER_CERTS_DIR, `${userId}.p12`);

/** Crea el directorio si no está (borrado en caliente, despliegue nuevo). */
function asegurarDirectorio() {
  fs.mkdirSync(USER_CERTS_DIR, { recursive: true });
  return USER_CERTS_DIR;
}

function guardarCertificado(userId, buffer) {
  asegurarDirectorio();
  const filename = `${userId}.p12`;
  fs.writeFileSync(path.join(USER_CERTS_DIR, filename), buffer);
  return filename;
}

function borrarCertificado(userId) {
  try {
    fs.unlinkSync(rutaCertificado(userId));
  } catch (e) {
    // Que no exista el archivo no es un error: el objetivo es que no esté.
    if (e.code !== 'ENOENT') console.warn('No se pudo borrar el certificado:', e.message);
  }
}

/**
 * ¿Puede este usuario firmar AHORA?
 *
 * Devuelve `{ ok, motivo }`. Un certificado vencido no se borra —es historia de
 * lo que ya se firmó con él— pero deja de usarse: firmar con uno caducado
 * produce un documento que ningún validador acepta, y es peor que no firmar,
 * porque parece firmado.
 */
function estadoFirma(user) {
  const cert = user?.signatureCert;
  if (!cert?.filename) return { ok: false, motivo: 'SIN_CERTIFICADO' };
  if (!fs.existsSync(rutaCertificado(user._id))) return { ok: false, motivo: 'ARCHIVO_PERDIDO' };
  const hasta = cert.info?.validTo ? new Date(cert.info.validTo) : null;
  if (hasta && hasta < new Date()) return { ok: false, motivo: 'VENCIDO' };
  if (!cert.password) return { ok: false, motivo: 'SIN_CONTRASENA' };
  return { ok: true, motivo: '' };
}

/**
 * Firma un PDF ya generado con el certificado de `user`.
 *
 * Devuelve el PDF FIRMADO, o el original tal cual si esa persona no puede
 * firmar. Nunca lanza: que falte un certificado no puede dejar al médico sin
 * poder imprimir la receta de su paciente. El motivo se registra en consola y
 * el llamador sabe si se firmó por `firmado`.
 */
async function firmarPdfConUsuario(pdfBuffer, user, { reason, location, contactInfo } = {}) {
  const estado = estadoFirma(user);
  if (!estado.ok) return { pdf: pdfBuffer, firmado: false, motivo: estado.motivo };

  try {
    const { SignPdf } = require('@signpdf/signpdf');
    const { P12Signer } = require('@signpdf/signer-p12');
    const { plainAddPlaceholder } = require('@signpdf/placeholder-plain');

    const p12Buffer = fs.readFileSync(rutaCertificado(user._id));
    const password = decrypt(user.signatureCert.password);

    const conHueco = plainAddPlaceholder({
      pdfBuffer,
      reason: reason || 'Documento clínico',
      contactInfo: contactInfo || user.email || '',
      name: user.signatureCert.info?.commonName || user.name || '',
      location: location || '',
    });

    const firmado = await new SignPdf().sign(conHueco, new P12Signer(p12Buffer, { passphrase: password }));
    return { pdf: firmado, firmado: true, motivo: '' };
  } catch (e) {
    // Contraseña que ya no descifra, .p12 corrupto, clave sin permisos… Se
    // devuelve el PDF sin firmar antes que negarle el documento al paciente.
    console.warn(`No se pudo firmar el PDF de ${user?._id}:`, e.message);
    return { pdf: pdfBuffer, firmado: false, motivo: 'ERROR_FIRMA' };
  }
}

/**
 * El recuadro VISIBLE de la firma, para meterlo en el HTML antes de generar el
 * PDF. Es lo único que se ve al imprimir en papel.
 *
 * Si el profesional no tiene certificado se enseña su nombre a secas, sin
 * prometer una firma que no existe: decir «firmado electrónicamente» sin firma
 * sería exactamente el problema que este cambio viene a arreglar.
 */
function bloqueFirmaHtml(user, { esc = (s) => String(s ?? '') } = {}) {
  const nombre = user?.name || '';
  const especialidad = user?.specialty || '';
  const estado = user ? estadoFirma(user) : { ok: false };

  if (!estado.ok) {
    return `<div class="firma-e firma-e--sin">
      <div class="firma-e__nombre">${esc(nombre)}</div>
      ${especialidad ? `<div class="firma-e__sub">${esc(especialidad)}</div>` : ''}
    </div>`;
  }

  const info = user.signatureCert.info || {};
  const cn = info.commonName || nombre;
  const emisor = (info.issuer || '').split(',')[0].replace(/^\w+=/, '');
  return `<div class="firma-e">
    <div class="firma-e__tit">FIRMADO ELECTRÓNICAMENTE POR</div>
    <div class="firma-e__nombre">${esc(cn)}</div>
    ${especialidad ? `<div class="firma-e__sub">${esc(especialidad)}</div>` : ''}
    ${info.serialNumber ? `<div class="firma-e__meta">Certificado n.º ${esc(info.serialNumber)}</div>` : ''}
    ${emisor ? `<div class="firma-e__meta">Emisor: ${esc(emisor)}</div>` : ''}
    <div class="firma-e__meta">Validez de la firma comprobable en el propio archivo PDF.</div>
  </div>`;
}

/** Estilos del recuadro. Se inyectan en el <style> de cada plantilla. */
const FIRMA_CSS = `
  .firma-e { border:1px solid #94a3b8; border-radius:4px; padding:6px 8px; display:inline-block;
             min-width:240px; text-align:center; }
  .firma-e--sin { border-style:dashed; color:#475569; }
  .firma-e__tit { font-size:7px; letter-spacing:.06em; color:#047857; font-weight:bold; }
  .firma-e__nombre { font-size:11px; font-weight:bold; margin-top:2px; }
  .firma-e__sub { font-size:9px; color:#475569; }
  .firma-e__meta { font-size:7px; color:#64748b; margin-top:1px; }
`;

module.exports = {
  USER_CERTS_DIR,
  rutaCertificado,
  asegurarDirectorio,
  guardarCertificado,
  borrarCertificado,
  estadoFirma,
  firmarPdfConUsuario,
  bloqueFirmaHtml,
  FIRMA_CSS,
  loadP12,
};
