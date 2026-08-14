/**
 * DIAGNÓSTICO TEMPORAL: ¿manda WhatsApp Web el `ctwa_clid`?
 *
 * La Conversions API atribuye la conversión al anuncio con el `ctwa_clid` (el id
 * del CLIC). Por Cloud API llega siempre; por QR, en 5.959 mensajes reales, nunca.
 * Antes de dar eso por cerrado, el rastreador recorre el mensaje crudo entero por
 * si el dato viajara bajo otro nombre.
 *
 * Estas pruebas fijan las dos condiciones que lo hacen fiable:
 *   1. Si el dato ESTÁ —donde sea, con el nombre que sea— lo encuentra.
 *   2. Nunca escribe el valor de nada: solo rutas, tipos y longitudes. El informe
 *      se guarda en la base y acaba en los logs, así que no puede llevarse por
 *      delante el cuerpo de un mensaje ni el teléfono de un paciente.
 *
 * ►► BORRAR JUNTO CON EL DIAGNÓSTICO. ◄◄
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { rastrearSenalesDeAnuncio } = require('../utils/whatsappQrManager').__test;

test('encuentra el clid aunque venga anidado y con otro nombre', () => {
  const crudo = {
    body: 'Hola, quiero información',
    notifyName: 'Ana',
    contextInfo: {
      externalAdReply: {
        sourceId: '120256116638830399',
        title: 'Revisa Tu Próstata A Tiempo',
        ctwaSignals: { clickId: 'AfxABC123DEF456' },
      },
    },
  };
  const { contextos, rutas } = rastrearSenalesDeAnuncio(crudo);
  assert.ok(
    contextos.some((c) => c.includes('contextInfo.externalAdReply') && c.includes('sourceId')),
    'debe señalar el objeto de anuncio con sus claves'
  );
  assert.ok(
    rutas.some((r) => r.startsWith('contextInfo.externalAdReply.ctwaSignals.clickId')),
    `esperaba la ruta del clic; salieron: ${rutas.join(' | ')}`
  );
});

test('NO escribe el valor de nada: ni el clid, ni el cuerpo, ni el teléfono', () => {
  const crudo = {
    body: 'Mi cédula es 0912345678 y vivo en Urdesa',
    from: '593987654321@c.us',
    ctwaContext: { sourceId: 'ad-1', ctwaClid: 'SECRETO_QUE_NO_DEBE_SALIR' },
  };
  const informe = JSON.stringify(rastrearSenalesDeAnuncio(crudo));
  for (const secreto of ['SECRETO_QUE_NO_DEBE_SALIR', '0912345678', '593987654321', 'Urdesa']) {
    assert.equal(informe.includes(secreto), false, `se filtró «${secreto}» en el informe`);
  }
  // Del clid solo se dice que existe, de qué tipo es y cuánto mide.
  assert.ok(informe.includes('ctwaClid [string 25 car.]'), informe);
});

test('marca los campos VACÍOS (es el caso real del QR: la clave existe y no trae nada)', () => {
  const { rutas } = rastrearSenalesDeAnuncio({ ctwaContext: { sourceId: 'ad-1', ctwaClid: '' } });
  assert.ok(rutas.some((r) => r.includes('ctwaClid') && r.includes('VACÍO')), rutas.join(' | '));
});

test('un mensaje normal sin anuncio no genera ruido', () => {
  const { contextos, rutas } = rastrearSenalesDeAnuncio({ body: 'Buenos días', notifyName: 'Luis' });
  assert.deepEqual(contextos, []);
  assert.deepEqual(rutas, []);
});

test('aguanta objetos con ciclos y muy anidados sin colgarse', () => {
  const hondo = { ctwaContext: { sourceId: 'ad-1' } };
  let cursor = hondo;
  for (let i = 0; i < 40; i++) { cursor.dentro = { nivel: i }; cursor = cursor.dentro; }
  hondo.yo = hondo; // ciclo
  const { contextos } = rastrearSenalesDeAnuncio(hondo);
  assert.equal(contextos.length >= 1, true);
});
