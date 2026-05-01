/**
 * Cifrado simétrico para almacenar la contraseña del certificado P12.
 * Algoritmo: AES-256-CBC con clave derivada vía scryptSync.
 *
 * NUNCA guardar contraseñas en texto plano. Configurar INVOICE_ENCRYPTION_KEY
 * con un valor aleatorio largo en variables de entorno.
 */
const crypto = require('crypto');

const ALG = 'aes-256-cbc';
const IV_LEN = 16;
const KEY_LEN = 32;

function getKey() {
  const secret = process.env.INVOICE_ENCRYPTION_KEY;
  if (!secret || secret.length < 16) {
    throw new Error(
      'INVOICE_ENCRYPTION_KEY no configurada o demasiado corta (mínimo 16 caracteres)'
    );
  }
  return crypto.scryptSync(secret, 'sri-clinica-salt', KEY_LEN);
}

function encrypt(plain) {
  if (plain == null) return '';
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(payload) {
  if (!payload) return '';
  const [ivHex, dataHex] = String(payload).split(':');
  if (!ivHex || !dataHex) {
    throw new Error('Payload cifrado inválido');
  }
  const key = getKey();
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
