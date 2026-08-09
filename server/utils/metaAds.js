/**
 * Catálogo y aliases estables de anuncios de Meta.
 *
 * El usuario guarda el ID del Administrador de Anuncios UNA sola vez. En los
 * referrals de WhatsApp Meta puede entregar el ID del anuncio o el ID de la
 * publicación efectiva de su creativo. Con Marketing API resolvemos ambos y los
 * tratamos como la misma fuente, incluso después de editar el creativo.
 */
const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v23.0';
const CACHE_TTL_MS = 15 * 60 * 1000;
const aliasCache = new Map();

const cleanId = (value) => String(value || '').trim();

function addAlias(set, value) {
  const id = cleanId(value);
  if (!id) return;
  set.add(id);
  // effective_object_story_id suele ser "pageId_postId" mientras el referral
  // puede traer solo el postId. Guardamos las dos representaciones.
  if (id.includes('_')) set.add(id.split('_').pop());
}

function aliasesFromAd(ad = {}) {
  const aliases = new Set();
  addAlias(aliases, ad.id);
  addAlias(aliases, ad.effective_object_story_id);
  addAlias(aliases, ad.object_story_id);
  addAlias(aliases, ad.creative?.id);
  addAlias(aliases, ad.creative?.effective_object_story_id);
  addAlias(aliases, ad.creative?.object_story_id);
  return [...aliases];
}

async function graphJson(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
  return data;
}

const AD_FIELDS = [
  'id', 'name', 'status', 'effective_status',
  'campaign{id,name}', 'adset{id,name}',
  'creative{id,name,effective_object_story_id,object_story_id}',
].join(',');

async function fetchAd(accessToken, adId) {
  const url = `https://graph.facebook.com/${API_VERSION}/${encodeURIComponent(adId)}` +
    `?fields=${encodeURIComponent(AD_FIELDS)}&access_token=${encodeURIComponent(accessToken)}`;
  return graphJson(url);
}

/** Map<configuredAdId, Set<adId|postId aliases>>. Nunca lanza al motor. */
async function resolveAdAliases(adIds = []) {
  const ids = [...new Set(adIds.map(cleanId).filter(Boolean))];
  const result = new Map(ids.map((id) => [id, new Set([id])]));
  if (!ids.length) return result;
  const { getMarketingConfig } = require('./metaCustomAudience');
  const config = await getMarketingConfig();
  if (!config) return result;

  await Promise.all(ids.map(async (id) => {
    const cached = aliasCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      result.set(id, new Set(cached.aliases));
      return;
    }
    try {
      const ad = await fetchAd(config.accessToken, id);
      const aliases = aliasesFromAd(ad);
      aliasCache.set(id, { aliases, expiresAt: Date.now() + CACHE_TTL_MS });
      result.set(id, new Set(aliases));
    } catch (err) {
      // El matching exacto sigue funcionando aunque Meta esté caído o el token
      // no tenga ads_read. No se rompe la recepción del mensaje.
      console.error(`[Meta Ads] no se pudieron resolver aliases de ${id}:`, err.message);
    }
  }));
  return result;
}

async function adsForAccount(accessToken, accountId) {
  let url = `https://graph.facebook.com/${API_VERSION}/${accountId}/ads` +
    `?fields=${encodeURIComponent(AD_FIELDS)}&limit=200&access_token=${encodeURIComponent(accessToken)}`;
  const rows = [];
  // Hasta 1.000 anuncios por carga del editor. Es suficiente para el selector y
  // evita perseguir una cuenta enorme indefinidamente.
  for (let page = 0; url && page < 5; page++) {
    // eslint-disable-next-line no-await-in-loop
    const data = await graphJson(url);
    rows.push(...(data.data || []));
    url = data.paging?.next || '';
  }
  return rows;
}

async function listAds() {
  const { getMarketingConfig, resolveAdAccountIds } = require('./metaCustomAudience');
  const config = await getMarketingConfig();
  if (!config) return { ok: false, reason: 'marketing_api_not_configured', ads: [] };
  try {
    const accounts = await resolveAdAccountIds(config);
    if (!accounts.length) return { ok: false, reason: 'no_ad_accounts', ads: [] };
    const all = [];
    for (const accountId of accounts) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await adsForAccount(config.accessToken, accountId);
      all.push(...rows.map((ad) => {
        const aliases = aliasesFromAd(ad);
        const id = cleanId(ad.id);
        if (id) aliasCache.set(id, { aliases, expiresAt: Date.now() + CACHE_TTL_MS });
        return {
          id,
          name: ad.name || ad.id,
          status: ad.effective_status || ad.status || '',
          campaignId: cleanId(ad.campaign?.id),
          campaignName: ad.campaign?.name || '',
          adsetId: cleanId(ad.adset?.id),
          adsetName: ad.adset?.name || '',
          aliases,
        };
      }));
    }
    const seen = new Set();
    const ads = all
      .filter((ad) => ad.id && (seen.has(ad.id) ? false : (seen.add(ad.id), true)))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, ads };
  } catch (err) {
    console.error('[Meta Ads] Error al listar anuncios:', err.message);
    return { ok: false, error: err.message, ads: [] };
  }
}

module.exports = { aliasesFromAd, resolveAdAliases, listAds };
