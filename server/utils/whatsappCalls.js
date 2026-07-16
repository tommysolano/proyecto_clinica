/**
 * Cliente de la Calling API de WhatsApp (Meta) — llamadas de voz desde el CRM.
 *
 * CÓMO FUNCIONA (importante para entender el resto del código):
 * el audio NO pasa por este servidor. Meta usa WebRTC: el navegador del agente
 * y WhatsApp intercambian un SDP (la descripción de la sesión de audio) y a
 * partir de ahí el audio va directo entre ambos. Este módulo solo transporta
 * esos SDP por la Graph API — es pura señalización:
 *
 *   Saliente: navegador crea OFFER → connect(to, offer) → Meta responde y el
 *             webhook 'connect' trae el ANSWER → navegador lo aplica → hay audio.
 *   Entrante: webhook 'connect' trae el OFFER del contacto → el agente acepta →
 *             navegador crea ANSWER → accept(callId, answer) → hay audio.
 *
 * Las funciones reciben `creds` de whatsappGateway.cloudCreds(account); un
 * número QR no puede llamar (WhatsApp Web no expone llamadas) y el caller debe
 * comprobarlo antes.
 *
 * NOTA: Meta habilita las llamadas por número/país y no está disponible en todas
 * partes. `getCallingSettings` sirve para comprobarlo sin adivinar.
 */
const DEFAULT_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v23.0';

function isConfigured(creds) {
  return Boolean(creds && creds.accessToken && creds.phoneNumberId);
}

function apiBase(creds) {
  return `https://graph.facebook.com/${creds.apiVersion || DEFAULT_API_VERSION}`;
}

async function callGraph(creds, path, { method = 'POST', body } = {}) {
  if (!isConfigured(creds)) {
    return { ok: false, errorCode: 'provider_unavailable', error: 'El número de WhatsApp no tiene credenciales de Cloud API' };
  }
  try {
    const res = await fetch(`${apiBase(creds)}/${creds.phoneNumberId}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.accessToken}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: data?.error?.message || 'Error de la Calling API de WhatsApp',
        errorSubcode: data?.error?.error_subcode,
        data,
      };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Lee la configuración de llamadas del número. Sirve para saber si Meta tiene
 * habilitadas las llamadas en esta cuenta antes de mostrar el botón de llamar.
 */
async function getCallingSettings(creds) {
  const r = await callGraph(creds, '/settings?fields=calling', { method: 'GET' });
  if (!r.ok) return r;
  return { ok: true, calling: r.data?.calling || {}, data: r.data };
}

/** Habilita las llamadas en el número (hay que hacerlo una vez por número). */
async function enableCalling(creds, { callIconVisibility = 'DEFAULT' } = {}) {
  return callGraph(creds, '/settings', {
    body: { calling: { status: 'ENABLED', call_icon_visibility: callIconVisibility } },
  });
}

/**
 * Inicia una llamada saliente con el SDP offer del navegador del agente.
 * Devuelve `{ ok, callId }`; el SDP answer llega después por el webhook.
 */
async function connectCall(creds, to, sdpOffer) {
  const phone = String(to || '').replace(/[^\d]/g, '');
  if (!phone) return { ok: false, error: 'Teléfono inválido' };
  const r = await callGraph(creds, '/calls', {
    body: {
      messaging_product: 'whatsapp',
      to: phone,
      action: 'connect',
      session: { sdp_type: 'offer', sdp: sdpOffer },
    },
  });
  if (!r.ok) return r;
  return { ok: true, callId: r.data?.calls?.[0]?.id || '', data: r.data };
}

/** Acepta una llamada entrante respondiendo con el SDP answer del navegador. */
async function acceptCall(creds, callId, sdpAnswer) {
  return callGraph(creds, '/calls', {
    body: {
      messaging_product: 'whatsapp',
      call_id: callId,
      action: 'accept',
      session: { sdp_type: 'answer', sdp: sdpAnswer },
    },
  });
}

/** Rechaza una llamada entrante sin contestarla. */
async function rejectCall(creds, callId) {
  return callGraph(creds, '/calls', {
    body: { messaging_product: 'whatsapp', call_id: callId, action: 'reject' },
  });
}

/** Cuelga una llamada en curso (o cancela una saliente que aún suena). */
async function terminateCall(creds, callId) {
  return callGraph(creds, '/calls', {
    body: { messaging_product: 'whatsapp', call_id: callId, action: 'terminate' },
  });
}

/**
 * Pide permiso al contacto para poder llamarle. Meta exige que el usuario haya
 * concedido permiso antes de aceptar una llamada iniciada por el negocio: llega
 * como un mensaje con botones y, si acepta, se abre una ventana de permiso.
 * Requiere ventana de 24h abierta (es un mensaje normal).
 */
async function requestCallPermission(creds, to, text) {
  const phone = String(to || '').replace(/[^\d]/g, '');
  if (!phone) return { ok: false, error: 'Teléfono inválido' };
  return callGraph(creds, '/messages', {
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'interactive',
      interactive: {
        type: 'call_permission_request',
        body: { text: String(text || 'Para poder ayudarte mejor, ¿nos permites llamarte por WhatsApp?').slice(0, 1024) },
        action: { name: 'call_permission_request' },
      },
    },
  });
}

/**
 * Normaliza un evento de llamada del webhook a la forma que usa el controller.
 * Meta manda los eventos bajo `value.calls[]` del campo 'calls'.
 */
function parseCallEvent(call) {
  if (!call || typeof call !== 'object') return null;
  const dir = String(call.direction || '').toUpperCase();
  return {
    callId: call.id || '',
    event: String(call.event || '').toLowerCase(), // connect | terminate
    // USER_INITIATED = nos llaman a nosotros.
    direction: dir === 'USER_INITIATED' ? 'in' : dir === 'BUSINESS_INITIATED' ? 'out' : '',
    from: call.from || '',
    to: call.to || '',
    sdp: call.session?.sdp || '',
    sdpType: String(call.session?.sdp_type || '').toLowerCase(), // offer | answer
    status: String(call.status || '').toUpperCase(),
    duration: Number(call.duration || 0),
    timestamp: call.timestamp ? Number(call.timestamp) : null,
  };
}

module.exports = {
  isConfigured,
  getCallingSettings,
  enableCalling,
  connectCall,
  acceptCall,
  rejectCall,
  terminateCall,
  requestCallPermission,
  parseCallEvent,
};
