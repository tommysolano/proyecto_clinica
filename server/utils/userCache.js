const User = require('../models/User');

/**
 * CACHÉ DEL USUARIO AUTENTICADO
 * =============================
 *
 * POR QUÉ EXISTE
 * --------------
 * El middleware `auth` corre en CADA petición autenticada de la aplicación y
 * hacía `User.findById(...)` siempre. Contra el Atlas M0 (118 ms de ida y vuelta
 * desde el droplet, ver la nota de infraestructura) eso son 118 ms de peaje fijo
 * en TODAS las peticiones, antes siquiera de empezar el trabajo real. Una página
 * que dispara 3 llamadas en paralelo pagaba 3 veces la MISMA búsqueda del mismo
 * usuario.
 *
 * Además se excluye la FIRMA del profesional. Antes era `signatureImage` (una
 * imagen escaneada en base64, hasta ~300 KB arrastrados en cada petición para
 * tirarlos a la basura). Hoy es `signatureCert`, mucho más pequeña, pero su
 * campo `password` es la contraseña cifrada del certificado: no la lee nadie
 * desde `req.user` —quien firma relee al autor con su propio `populate`— y una
 * credencial que no hace falta no viaja.
 *
 * QUÉ HACE
 * --------
 * Guarda el documento del usuario en memoria durante TTL_MS. Un cambio de rol o
 * una desactivación tarda como mucho ese tiempo en notarse, y en la práctica es
 * inmediato porque todos los puntos que escriben en `User` llaman a `invalidate()`.
 *
 * ⚠️ EL DOCUMENTO SE COMPARTE ENTRE PETICIONES.
 * Nadie debe mutar `req.user` (comprobado: no hay ni un `req.user.campo = ...` ni
 * un `req.user.save()` en todo el servidor). Si algún día hace falta modificar el
 * usuario dentro de una petición, hay que releerlo de la base, NO tocar este
 * objeto: sería un cambio visible para las demás peticiones en vuelo.
 */

const TTL_MS = 15 * 1000;

// Tope de entradas: el personal de una clínica son decenas de usuarios, pero un
// mapa sin límite es una fuga de memoria esperando su turno.
const MAX_ENTRIES = 500;

// `-password` era lo que había antes; se le suma la contraseña del certificado
// de firma, que ninguna ruta lee desde `req.user`.
const AUTH_FIELDS = '-password -signatureCert.password';

const cache = new Map(); // id (string) -> { user, ts }

// Contador de invalidaciones por usuario. Cierra esta carrera: la petición A no
// encuentra al usuario en caché y lanza el findById; mientras ese findById está
// EN VUELO, un admin cambia el rol y llama a invalidate() (que no borra nada,
// porque aún no hay nada). Cuando A resuelve, guardaría el documento VIEJO con
// un TTL nuevo y el cambio de rol se perdería otros 15 s. Comparando el contador
// de antes y después de la consulta se detecta y simplemente no se cachea.
const gen = new Map(); // id (string) -> nº de invalidaciones

/**
 * Devuelve el usuario autenticado, de la caché si sigue fresco.
 * @returns {Promise<object|null>} documento de mongoose (sin password ni firma)
 */
async function getAuthUser(id) {
  const key = String(id);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.user;

  const genAntes = gen.get(key) || 0;
  const user = await User.findById(key).select(AUTH_FIELDS);
  // Un id inexistente NO se cachea: es un caso de error (token de un usuario
  // borrado) y cachearlo solo serviría para recordar la ausencia.
  // Si alguien invalidó mientras consultábamos, este documento ya nació viejo.
  if (user && (gen.get(key) || 0) === genAntes) {
    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(key, { user, ts: Date.now() });
  }
  return user;
}

/** Olvida un usuario concreto (tras editarlo, desactivarlo o cambiarle el rol). */
function invalidate(id) {
  if (!id) return;
  const key = String(id);
  cache.delete(key);
  if (gen.size >= MAX_ENTRIES) gen.clear();
  gen.set(key, (gen.get(key) || 0) + 1);
}

/** Olvida a todos (pruebas, o cambios masivos de usuarios). */
function invalidateAll() {
  cache.clear();
  gen.clear();
}

module.exports = { getAuthUser, invalidate, invalidateAll, _internals: { cache, TTL_MS } };
