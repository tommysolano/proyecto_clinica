const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const callController = require('../controllers/callController');

function response() {
  return {
    payload: null,
    json(value) { this.payload = value; return this; },
  };
}

test('ICE siempre entrega STUN y no inventa un TURN sin credenciales', async () => {
  const previous = {
    urls: process.env.WEBRTC_TURN_URLS,
    secret: process.env.TURN_SHARED_SECRET,
    user: process.env.WEBRTC_TURN_USERNAME,
    password: process.env.WEBRTC_TURN_CREDENTIAL,
  };
  delete process.env.WEBRTC_TURN_URLS;
  delete process.env.TURN_SHARED_SECRET;
  delete process.env.WEBRTC_TURN_USERNAME;
  delete process.env.WEBRTC_TURN_CREDENTIAL;
  try {
    const res = response();
    await callController.getIceConfig({ user: { _id: 'agente-1' } }, res);
    assert.equal(res.payload.iceServers.length, 1);
    assert.match(res.payload.iceServers[0].urls[0], /^stun:/);
  } finally {
    Object.entries(previous).forEach(([key, value]) => {
      const envKey = { urls: 'WEBRTC_TURN_URLS', secret: 'TURN_SHARED_SECRET', user: 'WEBRTC_TURN_USERNAME', password: 'WEBRTC_TURN_CREDENTIAL' }[key];
      if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
    });
  }
});

test('TURN REST entrega credenciales efímeras válidas sin revelar el secreto', async () => {
  const previousUrls = process.env.WEBRTC_TURN_URLS;
  const previousSecret = process.env.TURN_SHARED_SECRET;
  process.env.WEBRTC_TURN_URLS = 'turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349';
  process.env.TURN_SHARED_SECRET = 'secreto-de-prueba';
  try {
    const res = response();
    await callController.getIceConfig({ user: { _id: 'agente-2' } }, res);
    const turn = res.payload.iceServers[1];
    assert.equal(turn.urls.length, 2);
    assert.match(turn.username, /^\d+:agente-2$/);
    assert.equal(
      turn.credential,
      crypto.createHmac('sha1', process.env.TURN_SHARED_SECRET).update(turn.username).digest('base64')
    );
    assert.ok(!JSON.stringify(res.payload).includes(process.env.TURN_SHARED_SECRET));
  } finally {
    if (previousUrls === undefined) delete process.env.WEBRTC_TURN_URLS;
    else process.env.WEBRTC_TURN_URLS = previousUrls;
    if (previousSecret === undefined) delete process.env.TURN_SHARED_SECRET;
    else process.env.TURN_SHARED_SECRET = previousSecret;
  }
});
