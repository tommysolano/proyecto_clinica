const { decryptSecret } = require('./secretCrypto');

// El PSID que llega en el webhook no es un nombre ni un número de teléfono.
// Meta solo entrega los campos de perfil que la app puede consultar.
async function fetchMessengerProfileName({ senderId, encryptedPageAccessToken }) {
  if (!senderId || !encryptedPageAccessToken) return '';
  const accessToken = decryptSecret(encryptedPageAccessToken);
  if (!accessToken) return '';
  const version = process.env.META_GRAPH_API_VERSION || process.env.WHATSAPP_API_VERSION || 'v23.0';
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(senderId)}?fields=first_name,last_name`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      console.warn('[messenger profile] consulta sin nombre, estado:', response.status);
      return '';
    }
    const profile = await response.json();
    return [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim();
  } catch (err) {
    console.warn('[messenger profile] no se pudo consultar:', err.name || 'Error');
    return '';
  }
}

module.exports = { fetchMessengerProfileName };
