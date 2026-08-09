/**
 * Meta Marketing API — Públicos Personalizados (Custom Audiences).
 *
 * Permite añadir/quitar un contacto de un Público Personalizado de Facebook desde
 * las automatizaciones (retargeting): p.ej. al agendar una cita se mete al paciente
 * en el público "Interesados", y al registrar la compra se le saca (deja de gastar
 * en anuncios con quien ya compró).
 *
 * Reglas de Meta que se respetan:
 *  - Identificadores hasheados en SHA-256, normalizados (trim + minúsculas; el
 *    teléfono solo dígitos con código de país). Se reutiliza el hashing de CAPI.
 *  - Se envía multi-clave (EMAIL/PHONE/FN/LN) para maximizar el match.
 *
 * La credencial (token de Usuario del Sistema con `ads_management`) vive en
 * CallCenterWhatsappConfig.marketingApi (singleton global) y se cifra en reposo.
 * Si está deshabilitado o sin token, las funciones devuelven { ok:false, skipped:true }
 * SIN lanzar: gestionar un público NUNCA debe romper el flujo que lo dispara.
 *
 * El ID del público personalizado se configura POR NODO (cada flujo apunta al suyo).
 */

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v23.0';

/** Config Marketing API activa o null (deshabilitada / sin token). */
async function getMarketingConfig() {
  const CallCenterWhatsappConfig = require('../models/CallCenterWhatsappConfig');
  const cfg = await CallCenterWhatsappConfig.getSingleton();
  const mkt = cfg?.marketingApi;
  if (!mkt?.enabled || !mkt.accessToken) return null;
  const { decryptSecret } = require('./secretCrypto');
  return { accessToken: decryptSecret(mkt.accessToken), adAccountId: mkt.adAccountId || '' };
}

/** IDs de cuenta publicitaria (formato act_XXXX). Usa la configurada o las descubre. */
async function resolveAdAccountIds(cfg) {
  if (cfg.adAccountId) {
    const id = String(cfg.adAccountId).trim();
    return [id.startsWith('act_') ? id : `act_${id}`];
  }
  // Auto-descubre las cuentas a las que el token tiene acceso.
  const url = `https://graph.facebook.com/${API_VERSION}/me/adaccounts?fields=account_id&limit=100&access_token=${encodeURIComponent(cfg.accessToken)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return (data.data || []).map((a) => `act_${a.account_id}`);
}

/** Públicos personalizados de una cuenta publicitaria. */
async function fetchAudiencesForAccount(accessToken, actId) {
  const url = `https://graph.facebook.com/${API_VERSION}/${actId}/customaudiences?fields=id,name,approximate_count_lower_bound,subtype&limit=500&access_token=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return (data.data || []).map((a) => ({
    id: a.id,
    name: a.name || a.id,
    count: typeof a.approximate_count_lower_bound === 'number' ? a.approximate_count_lower_bound : null,
    subtype: a.subtype || '',
  }));
}

/**
 * Lista los Públicos Personalizados definidos en Meta (para el selector del nodo).
 * Devuelve { ok, audiences:[{id,name,count,subtype}], reason?, error? }.
 */
async function listAudiences() {
  const cfg = await getMarketingConfig();
  if (!cfg) return { ok: false, reason: 'marketing_api_not_configured', audiences: [] };
  try {
    const accounts = await resolveAdAccountIds(cfg);
    if (!accounts.length) return { ok: false, reason: 'no_ad_accounts', audiences: [] };
    const all = [];
    for (const acc of accounts) {
      // eslint-disable-next-line no-await-in-loop
      const list = await fetchAudiencesForAccount(cfg.accessToken, acc);
      all.push(...list);
    }
    const seen = new Set();
    const audiences = all
      .filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, audiences };
  } catch (err) {
    console.error('[Marketing API] Error al listar públicos:', err.message);
    return { ok: false, error: err.message, audiences: [] };
  }
}

/**
 * Construye el bloque { schema, data } que exige la API a partir de un paciente:
 * una fila con los identificadores disponibles ya hasheados. null si no hay ninguno.
 */
function buildAudienceData(patient) {
  const mc = require('./metaConversions');
  const schema = [];
  const row = [];
  const em = mc.hashSha256(patient?.email);
  if (em) { schema.push('EMAIL'); row.push(em); }
  const ph = mc.hashSha256(mc.normalizePhoneForCapi(patient?.whatsapp || patient?.phone));
  if (ph) { schema.push('PHONE'); row.push(ph); }
  const fn = mc.hashSha256(patient?.firstName);
  if (fn) { schema.push('FN'); row.push(fn); }
  const ln = mc.hashSha256(patient?.lastName);
  if (ln) { schema.push('LN'); row.push(ln); }
  if (!row.length) return null;
  return { schema, data: [row] };
}

/** POST (añadir) / DELETE (quitar) usuarios del público. No lanza jamás. */
async function callAudienceUsers({ method, audienceId, patient }) {
  try {
    const id = String(audienceId || '').trim();
    if (!id) return { ok: false, error: 'El nodo no tiene el ID del público personalizado.' };
    const cfg = await getMarketingConfig();
    if (!cfg) return { ok: false, skipped: true, reason: 'marketing_api_not_configured' };
    const payload = buildAudienceData(patient);
    if (!payload) return { ok: false, skipped: true, reason: 'no_user_identifiers' };

    const url = `https://graph.facebook.com/${API_VERSION}/${encodeURIComponent(id)}/users`;
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, access_token: cfg.accessToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = data?.error?.message || `HTTP ${res.status}`;
      console.error(`[Marketing API] Error ${method} público ${id}:`, error);
      return { ok: false, error, data };
    }
    return { ok: true, data };
  } catch (err) {
    console.error('[Marketing API] Error:', err.message);
    return { ok: false, error: err.message };
  }
}

/** Añade el paciente al público personalizado indicado. */
function addToAudience({ audienceId, patient }) {
  return callAudienceUsers({ method: 'POST', audienceId, patient });
}

/** Quita el paciente del público personalizado indicado. */
function removeFromAudience({ audienceId, patient }) {
  return callAudienceUsers({ method: 'DELETE', audienceId, patient });
}

module.exports = {
  getMarketingConfig,
  resolveAdAccountIds,
  buildAudienceData,
  addToAudience,
  removeFromAudience,
  listAudiences,
};
