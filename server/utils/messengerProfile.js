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

/**
 * Perfil de quien escribe por Instagram. El webhook solo trae el IGSID (un número
 * opaco): sin esta consulta el chat se veía como «Contacto de Instagram» y nadie
 * sabía con quién hablaba. Meta da el nombre (si la persona lo puso) y el @usuario
 * —este siempre existe—. Se consulta con el MISMO token de página que envía.
 */
async function fetchInstagramProfile({ senderId, encryptedPageAccessToken }) {
  const empty = { name: '', username: '' };
  if (!senderId || !encryptedPageAccessToken) return empty;
  const accessToken = decryptSecret(encryptedPageAccessToken);
  if (!accessToken) return empty;
  const version = process.env.META_GRAPH_API_VERSION || process.env.WHATSAPP_API_VERSION || 'v23.0';
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(senderId)}?fields=name,username`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      console.warn('[instagram profile] consulta sin nombre, estado:', response.status);
      return empty;
    }
    const profile = await response.json();
    return {
      name: String(profile.name || '').trim(),
      username: String(profile.username || '').trim().replace(/^@/, ''),
    };
  } catch (err) {
    console.warn('[instagram profile] no se pudo consultar:', err.name || 'Error');
    return empty;
  }
}

/** Nombre a mostrar: el real si lo hay; si no, el @usuario. */
function instagramDisplayName({ name, username } = {}) {
  return String(name || '').trim() || (username ? `@${username}` : '');
}

module.exports = { fetchMessengerProfileName, fetchInstagramProfile, instagramDisplayName };
