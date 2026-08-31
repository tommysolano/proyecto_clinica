/**
 * EL PERFIL MUERTO EN DISCO: por qué "escanea el QR otra vez" a veces no bastaba.
 *
 * CASO REAL (29-ago-2026). Un número QR conectó a las 12:39:45 y ocho segundos
 * después WhatsApp cerró la sesión ('disconnected: LOGOUT'). A partir de ahí hacía
 * falta escanear un QR nuevo… sobre el MISMO perfil de Chrome de la sesión muerta.
 *
 * La librería original borra ese perfil en cuanto WhatsApp cierra la sesión
 * (`authStrategy.logout()`), pero nuestro parche tuvo que quitar esa llamada:
 * borraba la carpeta MIENTRAS Chrome la tenía abierta y corrompía su base local.
 * Nadie ocupó su lugar, así que las credenciales muertas se quedaban ahí para
 * siempre y cada reconexión levantaba Chrome encima de ellas — encima, a menudo a
 * medio escribir, porque el Chromium se lo había llevado por delante el kernel al
 * quedarse el VPS sin memoria durante un despliegue (ver deploy.sh).
 *
 * Lo que se fija aquí:
 *   1. Si la última caída exigía QR nuevo, `connect` BORRA el perfil guardado
 *      antes de abrir Chrome: el escaneo empieza de cero.
 *   2. Una caída normal (la que se reconecta sola) NO toca el perfil: ahí está la
 *      sesión que evita tener que escanear nada.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./_integrationHelpers');
const qr = require('../utils/whatsappQrManager');
const WhatsappAccount = require('../models/WhatsappAccount');

const { clients } = qr.__test;
const WA_DATA_PATH = path.join(__dirname, '..', '.wwebjs_auth');

// whatsapp-web.js de mentira: aquí no se levanta ningún Chromium. `initialize`
// devuelve una promesa que nunca termina, que es justo lo que hace un arranque
// real mientras Chrome carga — y `connect` no la espera para responder.
const RUTA_LIB = require.resolve('whatsapp-web.js');
let libOriginal;

function stubWhatsappWeb() {
  libOriginal = require.cache[RUTA_LIB];
  class FakeClient {
    on() { return this; }
    initialize() { return new Promise(() => {}); }
    removeAllListeners() {}
    async destroy() {}
  }
  require.cache[RUTA_LIB] = {
    id: RUTA_LIB,
    filename: RUTA_LIB,
    loaded: true,
    exports: { Client: FakeClient, LocalAuth: class { constructor(o) { this.o = o; } } },
  };
}

function restoreWhatsappWeb() {
  if (libOriginal) require.cache[RUTA_LIB] = libOriginal;
  else delete require.cache[RUTA_LIB];
}

/** Crea en disco un perfil de sesión con algo dentro, como el de Chrome. */
function crearPerfil(sessionId) {
  const dir = path.join(WA_DATA_PATH, `session-${sessionId}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Default'), 'credenciales de mentira');
  return dir;
}

/** Deja el mapa de sesiones y los temporizadores como estaban. */
function limpiarSesiones() {
  for (const [key, entry] of clients) {
    if (entry.watchdog) clearTimeout(entry.watchdog);
    if (entry.syncWatchdog) clearTimeout(entry.syncWatchdog);
    clients.delete(key);
  }
}

async function cuentaQr({ needsQr }) {
  return WhatsappAccount.create({
    label: 'Recepción de prueba',
    connectionType: 'qr',
    enabled: true,
    connectedPhone: '593999999999',
    sessionId: `wa_prueba_${needsQr ? 'muerta' : 'viva'}`,
    lastDisconnectNeedsQr: needsQr,
    lastDisconnectReason: needsQr ? 'evento disconnected: LOGOUT' : 'la sesión se cortó',
  });
}

test.before(async () => {
  await H.startDb();
  stubWhatsappWeb();
});
test.after(async () => {
  restoreWhatsappWeb();
  limpiarSesiones();
  await H.stopDb();
});
test.beforeEach(async () => {
  await H.resetDb();
  limpiarSesiones();
});

test('sesión que exige QR nuevo: el perfil muerto se borra antes de abrir Chrome', async () => {
  const acc = await cuentaQr({ needsQr: true });
  const dir = crearPerfil(acc.sessionId);
  assert.equal(fs.existsSync(dir), true, 'el perfil debería existir antes de conectar');

  const r = await qr.connect(acc._id);
  assert.equal(r.ok, true);
  assert.equal(
    fs.existsSync(dir),
    false,
    'el perfil de la sesión muerta debe borrarse: escanear el QR encima de él es lo que dejaba el número sin entrar'
  );
});

test('caída normal: el perfil se conserva (es lo que evita tener que escanear)', async () => {
  const acc = await cuentaQr({ needsQr: false });
  const dir = crearPerfil(acc.sessionId);

  const r = await qr.connect(acc._id);
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(dir), true, 'una caída pasajera reconecta con la sesión guardada, no la borra');

  fs.rmSync(dir, { recursive: true, force: true });
});
