const crypto = require('crypto');

/**
 * Cifrado de secrets en reposo (AES-256-GCM). Migración-segura:
 *  - Los valores cifrados llevan el prefijo `enc:v1:` → se descifran.
 *  - Los valores sin prefijo se devuelven tal cual (tokens legacy en texto plano).
 *  - Si no hay clave (SECRETS_KEY), encrypt es no-op (entornos de desarrollo).
 *
 * SECRETS_KEY debe ser de 32 bytes en hex (64 chars) o base64. Genera una con:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
const PREFIX = 'enc:v1:';

function getKey() {
  const raw = process.env.SECRETS_KEY;
  if (!raw) return null;
  try {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) return b;
  } catch {
    /* cae a null */
  }
  return null;
}

function isEncrypted(val) {
  return typeof val === 'string' && val.startsWith(PREFIX);
}

function encryptSecret(plain) {
  if (plain == null || plain === '') return plain;
  if (isEncrypted(plain)) return plain; // ya cifrado, no re-cifrar
  const key = getKey();
  if (!key) return plain; // sin clave → no-op (dev)
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decryptSecret(val) {
  if (!isEncrypted(val)) return val; // texto plano legacy o vacío
  const key = getKey();
  if (!key) return val; // sin clave no podemos descifrar; devolvemos el cifrado
  try {
    const [, , payload] = [PREFIX, '', val.slice(PREFIX.length)];
    const [ivB, tagB, ctB] = payload.split(':');
    const iv = Buffer.from(ivB, 'base64');
    const tag = Buffer.from(tagB, 'base64');
    const ct = Buffer.from(ctB, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return val;
  }
}

module.exports = { encryptSecret, decryptSecret, isEncrypted, PREFIX };
