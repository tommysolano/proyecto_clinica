/**
 * "WHATSAPP NOS BLOQUEÓ EL NÚMERO POR EL QUE ENTRABA TODO".
 *
 * Caso real (02-sep-2026). La clínica tenía tres números conectados: «Recepcion»
 * (Cloud API, el principal), «Recepcion 2» (QR) y «Recepcion 3» (QR). WhatsApp
 * bloqueó «Recepcion 2», que era justamente por el que entraba la mayoría de la
 * bandeja: un número bloqueado no se puede reconectar —se queda pidiendo un QR
 * que nunca valida— y la resolución del número de salida seguía eligiéndolo,
 * porque solo miraba `enabled`/`archivedAt`. Resultado: todas las respuestas de
 * esos chats morían con "El número QR no está conectado". Cientos de contactos
 * sin forma de contestarles.
 *
 * Lo que fijan estos tests:
 *   1. un número que no puede enviar deja de elegirse: se cae al principal;
 *   2. el chat NO pierde el rastro de a qué número escribió el contacto;
 *   3. la bandeja lo enseña (y se puede filtrar por número);
 *   4. el agente puede FIJAR otro número desde el chat, y el siguiente entrante
 *      ya no le deshace la elección;
 *   5. «Automático» devuelve el chat a su comportamiento de siempre;
 *   6. y todo lo demás sigue igual: si el número al que escribieron funciona, se
 *      responde por él.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const MessageTemplate = require('../models/MessageTemplate');
const WhatsappAccount = require('../models/WhatsappAccount');
const messaging = require('../utils/messaging');
const gateway = require('../utils/whatsappGateway');
const chatController = require('../controllers/chatController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const TEL = '593987654321';

/** Los tres números reales: el principal vivo, el QR bloqueado y otro QR vivo. */
async function numeros() {
  const recepcion = await WhatsappAccount.create({
    label: 'Recepcion', connectionType: 'cloud_api', accessToken: 'T', phoneNumberId: '1',
    displayPhone: '+593939855651', enabled: true, isDefault: true,
  });
  // BLOQUEADO: sigue `enabled`, pero WhatsApp pide un QR que ya no valida.
  const bloqueado = await WhatsappAccount.create({
    label: 'Recepcion 2', connectionType: 'qr', connectedPhone: '593993519937',
    enabled: true, status: 'qr_pending',
  });
  const vivo = await WhatsappAccount.create({
    label: 'Recepcion 3', connectionType: 'qr', connectedPhone: '593967632250',
    enabled: true, status: 'connected',
  });
  return { recepcion, bloqueado, vivo };
}

/** Anota qué llegó de verdad al proveedor: lo que no aparece aquí, no salió. */
function fakeGateway() {
  const sent = [];
  const orig = { sendText: gateway.sendText, sendTemplate: gateway.sendTemplate };
  gateway.sendText = async (account, to, body) => {
    sent.push({ tipo: 'texto', cuenta: account.label, to, body });
    return { ok: true, data: { messages: [{ id: `wamid.${sent.length}` }] } };
  };
  gateway.sendTemplate = async (account, to, templateName) => {
    sent.push({ tipo: 'plantilla', cuenta: account.label, to, templateName });
    return { ok: true, data: { messages: [{ id: `wamid.${sent.length}` }] } };
  };
  return { sent, restore: () => Object.assign(gateway, orig) };
}

/** El contacto escribió a `cuenta` hace `haceHoras` horas. */
async function chatQueEscribioA(clinicId, cuenta, haceHoras = 2, phone = TEL) {
  const cuando = new Date(Date.now() - haceHoras * 3600 * 1000);
  const conv = await Conversation.create({
    clinic: clinicId, phone, channel: 'whatsapp',
    whatsappAccount: cuenta._id,
    lastInboundAt: cuando,
    lastInboundAccount: cuenta._id,
    window24hExpiresAt: messaging.computeWhatsappWindowExpiresAt(cuando),
    lastMessageDirection: 'in',
    lastMessageAt: cuando,
  });
  await Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'in',
    body: 'Hola, quiero información', whatsappAccount: cuenta._id, createdAt: cuando,
  });
  return conv;
}

// ─────────── 1. quién puede enviar y quién no ───────────

test('un QR bloqueado (esperando escaneo) no cuenta como número con el que enviar', async () => {
  await H.seedClinic();
  const { recepcion, bloqueado, vivo } = await numeros();

  assert.equal(gateway.isSendableAccount(recepcion), true);
  assert.equal(gateway.isSendableAccount(vivo), true);
  assert.equal(gateway.isSendableAccount(bloqueado), false, 'está esperando un QR que ya no valida');
  assert.equal(gateway.unsendableReason(bloqueado), 'needs_qr');
});

test('un QR que solo se está reconectando SÍ cuenta: no se le quitan sus chats', async () => {
  await H.seedClinic();
  // 'syncing'/'connecting'/'disconnected' son sesiones que vuelven solas, y el
  // envío por QR ya pregunta el estado real antes de rendirse. Tratarlas como
  // muertas desviaría al número principal envíos que sí iban a salir — y con
  // ellos la ventana de 24h del contacto.
  for (const status of ['syncing', 'connecting', 'disconnected', 'connected']) {
    // eslint-disable-next-line no-await-in-loop
    const acc = await WhatsappAccount.create({
      label: `QR ${status}`, connectionType: 'qr', connectedPhone: `59399000000${status.length}`,
      enabled: true, status,
    });
    assert.equal(gateway.isSendableAccount(acc), true, `${status} no es motivo para desviar`);
  }
});

test('un Cloud API sin credenciales tampoco puede enviar', async () => {
  await H.seedClinic();
  const sinToken = await WhatsappAccount.create({
    label: 'API a medias', connectionType: 'cloud_api', phoneNumberId: '9', enabled: true,
  });
  assert.equal(gateway.isSendableAccount(sinToken), false);
  assert.equal(gateway.unsendableReason(sinToken), 'no_credentials');
});

// ─────────── 2. el chat del número bloqueado vuelve a tener salida ───────────

test('el chat del número bloqueado responde por el principal en vez de morir', async () => {
  const { clinicId } = await H.seedClinic();
  const { bloqueado } = await numeros();
  const conv = await chatQueEscribioA(clinicId, bloqueado);

  const cuenta = await gateway.resolveAccountForConversation(await Conversation.findById(conv._id));
  assert.equal(cuenta.label, 'Recepcion', 'sale por el principal, que sí puede enviar');
});

test('el desvío NO borra a qué número escribió el contacto', async () => {
  const { clinicId } = await H.seedClinic();
  const { bloqueado } = await numeros();
  const conv = await chatQueEscribioA(clinicId, bloqueado);

  const doc = await Conversation.findById(conv._id);
  await gateway.resolveAccountForConversation(doc);
  await doc.save();

  const despues = await Conversation.findById(conv._id).lean();
  assert.equal(String(despues.whatsappAccount), String(bloqueado._id), 'el chat sigue siendo de Recepcion 2');
  assert.equal(String(despues.lastInboundAccount), String(bloqueado._id));
  // Si el desvío se grabara, se perdería para siempre el rastro del número de
  // entrada y no habría forma de devolverle el chat cuando se recupere.
});

test('fuera de ventana el texto libre se para aquí; la plantilla sí sale, y por el principal', async () => {
  const { clinicId } = await H.seedClinic();
  const { bloqueado } = await numeros();
  const conv = await chatQueEscribioA(clinicId, bloqueado);
  await MessageTemplate.create({
    clinic: clinicId, channel: 'whatsapp', name: 'reactivacion', status: 'approved',
    body: 'Hola, seguimos a tus órdenes.',
  });
  const gw = fakeGateway();

  try {
    // El contacto escribió al QR: en el principal no hay ventana ninguna.
    const libre = await messaging.send({
      clinicId, channel: 'whatsapp', conversation: await Conversation.findById(conv._id), to: TEL,
      body: 'Hola, te respondo',
    });
    assert.equal(libre.ok, false);
    assert.equal(libre.reason, 'out_of_window', 'Meta lo rechazaría con 131047: mejor pararlo aquí');
    assert.deepEqual(gw.sent, []);

    // La plantilla es la salida, y es lo que el chat le ofrece al agente.
    const plantilla = await messaging.send({
      clinicId, channel: 'whatsapp', conversation: await Conversation.findById(conv._id), to: TEL,
      template: { name: 'reactivacion', language: 'es' },
    });
    assert.equal(plantilla.ok, true);
    assert.equal(gw.sent[0].tipo, 'plantilla');
    assert.equal(gw.sent[0].cuenta, 'Recepcion', 'sale por el número que sí puede enviar');
  } finally {
    gw.restore();
  }
});

// ─────────── 3. la bandeja lo enseña ───────────

test('la bandeja dice a qué número escribió cada contacto y por cuál va a responder', async () => {
  const { clinicId } = await H.seedClinic();
  const { bloqueado, vivo } = await numeros();
  await chatQueEscribioA(clinicId, bloqueado, 2, '593900000001');
  await chatQueEscribioA(clinicId, vivo, 2, '593900000002');

  const { payload } = await H.runController(chatController.listConversations, H.mockReq(clinicId, null));
  const delBloqueado = payload.items.find((c) => c.phone === '593900000001');
  const delVivo = payload.items.find((c) => c.phone === '593900000002');

  assert.equal(delBloqueado.inboundAccount.label, 'Recepcion 2', 'se ve a quién le escribió');
  assert.equal(delBloqueado.inboundAccount.sendable, false, 'y que ese número está caído');
  assert.equal(delBloqueado.sendingAccount.label, 'Recepcion', 'la respuesta sale por otro');
  assert.equal(delBloqueado.sendingAccountIsFallback, true, 'y se puede avisar de que es un desvío');

  assert.equal(delVivo.inboundAccount.label, 'Recepcion 3');
  assert.equal(delVivo.sendingAccount.label, 'Recepcion 3', 'aquí NADA cambia: se responde por su número');
  assert.equal(delVivo.sendingAccountIsFallback, false);
});

test('se pueden listar SOLO los chats que entraron por el número bloqueado', async () => {
  const { clinicId } = await H.seedClinic();
  const { bloqueado, vivo } = await numeros();
  await chatQueEscribioA(clinicId, bloqueado, 2, '593900000001');
  await chatQueEscribioA(clinicId, bloqueado, 3, '593900000003');
  await chatQueEscribioA(clinicId, vivo, 2, '593900000002');

  const { payload } = await H.runController(
    chatController.listConversations,
    H.mockReq(clinicId, null, {}, { query: { account: String(bloqueado._id) } })
  );
  assert.equal(payload.total, 2, 'los dos chats a rescatar, y solo esos');
  assert.deepEqual(
    payload.items.map((c) => c.phone).sort(),
    ['593900000001', '593900000003']
  );
});

test('el filtro por número encuentra también los chats del mismo teléfono antes de reconectarlo', async () => {
  const { clinicId } = await H.seedClinic();
  const { vivo } = await numeros();
  // El mismo teléfono, borrado y vuelto a conectar: el documento nuevo se apunta
  // el id del viejo en `previousIds` y hereda su historial.
  const viejoId = new (require('mongoose').Types.ObjectId)();
  vivo.previousIds = [viejoId];
  await vivo.save();
  await Conversation.create({
    clinic: clinicId, phone: '593900000009', channel: 'whatsapp',
    whatsappAccount: viejoId, lastInboundAccount: viejoId,
  });

  const { payload } = await H.runController(
    chatController.listConversations,
    H.mockReq(clinicId, null, {}, { query: { account: String(vivo._id) } })
  );
  assert.equal(payload.total, 1, 'el chat del id viejo sigue siendo de este número');
});

test('el desplegable de números avisa de cuál está bloqueado', async () => {
  const { clinicId } = await H.seedClinic();
  await numeros();
  const { payload } = await H.runController(chatController.listChatAccounts, H.mockReq(clinicId, null));
  const porNombre = Object.fromEntries(payload.map((a) => [a.label, a]));
  assert.equal(porNombre['Recepcion'].sendable, true);
  assert.equal(porNombre['Recepcion 2'].sendable, false);
  assert.equal(porNombre['Recepcion 3'].sendable, true);
  assert.ok(!('accessToken' in porNombre['Recepcion']), 'el token no sale de aquí');
});

// ─────────── 4. el agente elige el número desde el chat ───────────

test('el agente fija el número de salida y el siguiente entrante NO se lo deshace', async () => {
  const { clinicId } = await H.seedClinic();
  const { recepcion, bloqueado, vivo } = await numeros();
  const conv = await chatQueEscribioA(clinicId, bloqueado);

  const { payload } = await H.runController(
    chatController.setConversationAccount,
    H.mockReq(clinicId, null, { whatsappAccountId: String(vivo._id) }, { params: { id: String(conv._id) } })
  );
  assert.equal(payload.sendingAccount.label, 'Recepcion 3');
  assert.equal(payload.accountPinned, true);
  assert.ok(payload.window, 'la respuesta trae la ventana recalculada, que es lo que repinta el compositor');

  // Llega un entrante por el número principal: antes esto reenlazaba el chat en
  // silencio y tiraba a la basura la elección del agente.
  await chatController.ingestExternalMessage({
    clinicId, channel: 'whatsapp', phone: TEL, externalUserId: TEL,
    body: 'Sigo esperando', externalId: 'wamid.entrante.1', account: recepcion,
  });

  const despues = await Conversation.findById(conv._id).lean();
  assert.equal(String(despues.whatsappAccount), String(vivo._id), 'la elección del agente manda');
  assert.equal(String(despues.lastInboundAccount), String(recepcion._id), 'pero se anota por dónde entró de verdad');
});

test('no se puede fijar un número que está bloqueado', async () => {
  const { clinicId } = await H.seedClinic();
  const { bloqueado, vivo } = await numeros();
  const conv = await chatQueEscribioA(clinicId, vivo);

  const { statusCode, payload } = await H.runController(
    chatController.setConversationAccount,
    H.mockReq(clinicId, null, { whatsappAccountId: String(bloqueado._id) }, { params: { id: String(conv._id) } })
  );
  assert.equal(statusCode, 409, 'elegirlo dejaría el chat peor que antes: todo en rojo y sin explicación');
  assert.match(payload.message, /no puede enviar/i);
});

test('«Automático» devuelve el chat al número al que escribió el contacto', async () => {
  const { clinicId } = await H.seedClinic();
  const { recepcion, vivo } = await numeros();
  const conv = await chatQueEscribioA(clinicId, vivo);

  await H.runController(
    chatController.setConversationAccount,
    H.mockReq(clinicId, null, { whatsappAccountId: String(recepcion._id) }, { params: { id: String(conv._id) } })
  );
  const { payload } = await H.runController(
    chatController.setConversationAccount,
    H.mockReq(clinicId, null, { whatsappAccountId: '' }, { params: { id: String(conv._id) } })
  );
  assert.equal(payload.accountPinned, false);
  assert.equal(payload.sendingAccount.label, 'Recepcion 3', 'vuelve al número al que el contacto escribió');

  const doc = await Conversation.findById(conv._id).lean();
  assert.equal(String(doc.whatsappAccount), String(vivo._id));
  assert.equal(doc.whatsappAccountPinned, false);
});

test('el número fijado es por el que sale de verdad el mensaje', async () => {
  const { clinicId } = await H.seedClinic();
  const { vivo, bloqueado } = await numeros();
  const conv = await chatQueEscribioA(clinicId, bloqueado);
  const gw = fakeGateway();

  try {
    await H.runController(
      chatController.setConversationAccount,
      H.mockReq(clinicId, null, { whatsappAccountId: String(vivo._id) }, { params: { id: String(conv._id) } })
    );
    // Recepcion 3 es QR: no tiene ventana de 24h, así que el texto libre sale.
    const r = await messaging.send({
      clinicId, channel: 'whatsapp', conversation: await Conversation.findById(conv._id), to: TEL,
      body: 'Buenos días, le respondo por aquí',
    });
    assert.equal(r.ok, true);
    assert.equal(gw.sent[0].cuenta, 'Recepcion 3');
  } finally {
    gw.restore();
  }
});

// ─────────── 5. lo de siempre sigue igual ───────────

test('con su número vivo, la respuesta sigue saliendo por el número al que escribieron', async () => {
  const { clinicId } = await H.seedClinic();
  const { vivo } = await numeros();
  const conv = await chatQueEscribioA(clinicId, vivo);
  const gw = fakeGateway();

  try {
    const r = await messaging.send({
      clinicId, channel: 'whatsapp', conversation: await Conversation.findById(conv._id), to: TEL,
      body: 'Claro que sí, le cuento',
    });
    assert.equal(r.ok, true);
    assert.equal(gw.sent[0].cuenta, 'Recepcion 3', 'ni desvíos ni número por defecto: su mismo número');
  } finally {
    gw.restore();
  }
});

test('un chat que nunca recibió nada sigue saliendo por el número principal', async () => {
  const { clinicId } = await H.seedClinic();
  await numeros();
  const conv = await Conversation.create({ clinic: clinicId, phone: '593911111111', channel: 'whatsapp' });
  const cuenta = await gateway.resolveAccountForConversation(conv);
  assert.equal(cuenta.label, 'Recepcion');
});

test('si el principal está caído, el respaldo es otro número vivo (no uno muerto)', async () => {
  const { clinicId } = await H.seedClinic();
  const { recepcion, bloqueado, vivo } = await numeros();
  recepcion.accessToken = ''; // al principal le faltan credenciales
  await recepcion.save();
  const conv = await chatQueEscribioA(clinicId, bloqueado);

  const cuenta = await gateway.resolveAccountForConversation(await Conversation.findById(conv._id));
  assert.equal(String(cuenta._id), String(vivo._id), 'el respaldo tiene que poder enviar de verdad');
});

// ─────────── 6. los agujeros que abría el desvío, tapados ───────────

test('chat VIEJO sin `lastInboundAccount`: el desvío NO promete una ventana que no existe', async () => {
  const { clinicId } = await H.seedClinic();
  const { bloqueado } = await numeros();
  // Estado real de la base antes de que existiera `lastInboundAccount`: solo el
  // enlace del chat dice por dónde entró.
  const cuando = new Date(Date.now() - 2 * 3600 * 1000);
  const conv = await Conversation.create({
    clinic: clinicId, phone: TEL, channel: 'whatsapp',
    whatsappAccount: bloqueado._id,
    lastInboundAt: cuando,
    lastInboundAccount: null,
    window24hExpiresAt: messaging.computeWhatsappWindowExpiresAt(cuando),
    lastMessageDirection: 'in', lastMessageAt: cuando,
  });
  const gw = fakeGateway();

  try {
    const { payload } = await H.runController(chatController.listConversations, H.mockReq(clinicId, null));
    const chat = payload.items.find((c) => c.phone === TEL);
    assert.equal(chat.sendingAccount.label, 'Recepcion', 'se desvía al principal');
    assert.equal(
      chat.window.open, false,
      'y la ventana se cierra: el contacto escribió a Recepcion 2, no a Recepcion'
    );
    assert.equal(chat.window.otherNumber, true, 'con su explicación');

    // Y el envío coincide con lo que dice la UI: no se cuela texto libre.
    const r = await messaging.send({
      clinicId, channel: 'whatsapp', conversation: await Conversation.findById(conv._id), to: TEL,
      body: 'Hola',
    });
    assert.equal(r.reason, 'out_of_window');
    assert.deepEqual(gw.sent, []);
  } finally {
    gw.restore();
  }
});

test('fijar un número a mano NO cambia a qué número dice la bandeja que escribió el contacto', async () => {
  const { clinicId } = await H.seedClinic();
  const { recepcion, bloqueado } = await numeros();
  const conv = await chatQueEscribioA(clinicId, bloqueado);

  await H.runController(
    chatController.setConversationAccount,
    H.mockReq(clinicId, null, { whatsappAccountId: String(recepcion._id) }, { params: { id: String(conv._id) } })
  );
  const { payload } = await H.runController(chatController.listConversations, H.mockReq(clinicId, null));
  const chat = payload.items.find((c) => c.phone === TEL);
  assert.equal(chat.inboundAccount.label, 'Recepcion 2', 'el HECHO no cambia porque alguien tome una decisión');
  assert.equal(chat.sendingAccount.label, 'Recepcion');
  assert.equal(chat.accountPinned, true);
});

test('el desvío no se graba como número del chat', async () => {
  const { clinicId } = await H.seedClinic();
  const { bloqueado } = await numeros();
  // Chat SIN enlace pero con rastro de entrada por el número bloqueado.
  const cuando = new Date(Date.now() - 2 * 3600 * 1000);
  const conv = await Conversation.create({
    clinic: clinicId, phone: TEL, channel: 'whatsapp',
    whatsappAccount: null, lastInboundAt: cuando, lastInboundAccount: bloqueado._id,
    window24hExpiresAt: messaging.computeWhatsappWindowExpiresAt(cuando),
  });
  await MessageTemplate.create({
    clinic: clinicId, channel: 'whatsapp', name: 'reactivacion', status: 'approved', body: 'Hola.',
  });
  const gw = fakeGateway();

  try {
    await messaging.send({
      clinicId, channel: 'whatsapp', conversation: await Conversation.findById(conv._id), to: TEL,
      template: { name: 'reactivacion', language: 'es' },
    });
    const despues = await Conversation.findById(conv._id).lean();
    assert.equal(despues.whatsappAccount, null, 'el número de respaldo no se queda como el número del chat');
    assert.equal(String(despues.lastInboundAccount), String(bloqueado._id));
  } finally {
    gw.restore();
  }
});

test('una campaña fijada al número bloqueado sale por el de respaldo, no muere', async () => {
  const { clinicId } = await H.seedClinic();
  const { bloqueado, vivo } = await numeros();
  const conv = await chatQueEscribioA(clinicId, vivo);
  const gw = fakeGateway();

  try {
    const r = await messaging.send({
      clinicId, channel: 'whatsapp', conversation: await Conversation.findById(conv._id), to: TEL,
      body: 'Promoción de septiembre',
      whatsappAccount: bloqueado._id, // "enviar todo desde este número"
    });
    assert.equal(r.ok, true);
    assert.equal(gw.sent[0].cuenta, 'Recepcion 3', 'cae al número del chat, que sí puede enviar');
  } finally {
    gw.restore();
  }
});

test('volver a «Automático» sin `lastInboundAccount` no borra el rastro del número de entrada', async () => {
  const { clinicId } = await H.seedClinic();
  const { recepcion, bloqueado } = await numeros();
  const conv = await Conversation.create({
    clinic: clinicId, phone: TEL, channel: 'whatsapp',
    whatsappAccount: bloqueado._id, lastInboundAccount: null,
    lastInboundAt: new Date(), lastMessageDirection: 'in',
  });
  // El rastro solo vive en los mensajes (chat anterior al campo).
  await Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'in', body: 'Hola',
    whatsappAccount: bloqueado._id,
  });

  await H.runController(
    chatController.setConversationAccount,
    H.mockReq(clinicId, null, { whatsappAccountId: String(recepcion._id) }, { params: { id: String(conv._id) } })
  );
  await H.runController(
    chatController.setConversationAccount,
    H.mockReq(clinicId, null, { whatsappAccountId: 'auto' }, { params: { id: String(conv._id) } })
  );

  const doc = await Conversation.findById(conv._id).lean();
  assert.equal(String(doc.whatsappAccount), String(bloqueado._id), 'se recupera del historial, no se pierde');
  assert.equal(doc.whatsappAccountPinned, false);
});

test('traspasar los chats a OTRO teléfono no mueve la ventana de 24h (sería mentira)', async () => {
  const { clinicId } = await H.seedClinic();
  const { recepcion, bloqueado } = await numeros();
  const conv = await chatQueEscribioA(clinicId, bloqueado);
  const callCenterConfigController = require('../controllers/callCenterConfigController');

  await H.runController(
    callCenterConfigController.deleteWhatsappAccount,
    H.mockReq(clinicId, null, { replacementId: String(recepcion._id) }, { params: { id: String(bloqueado._id) } })
  );

  const doc = await Conversation.findById(conv._id).lean();
  assert.equal(String(doc.whatsappAccount), String(recepcion._id), 'se responderá por el número nuevo');
  assert.equal(
    String(doc.lastInboundAccount), String(bloqueado._id),
    'pero el contacto siguió escribiendo al viejo: la ventana de Recepcion NO existe'
  );
  const mensaje = await Message.findOne({ conversation: conv._id, direction: 'in' }).lean();
  assert.equal(String(mensaje.whatsappAccount), String(bloqueado._id), 'el historial dice por dónde entró de verdad');
});

test('un chat de «número oculto» (@lid) NO se desvía: el LID no es un teléfono', async () => {
  const { clinicId } = await H.seedClinic();
  const { bloqueado } = await numeros();
  // Así queda un chat cuyo contacto escribió con el número oculto y del que
  // todavía no se conoce el teléfono real: `phone` son los dígitos del LID.
  const LID = '128374619283746';
  const conv = await Conversation.create({
    clinic: clinicId, phone: LID, externalUserId: `${LID}@lid`, channel: 'whatsapp',
    whatsappAccount: bloqueado._id, lastInboundAccount: bloqueado._id,
    lastInboundAt: new Date(), lastMessageDirection: 'in',
  });

  const cuenta = await gateway.resolveAccountForConversation(await Conversation.findById(conv._id));
  assert.equal(
    String(cuenta._id), String(bloqueado._id),
    'desviarlo mandaría el chat del paciente al teléfono 128374619283746, que es de otra persona o de nadie'
  );

  // Y la bandeja dice lo mismo que hará el envío.
  const { payload } = await H.runController(chatController.listConversations, H.mockReq(clinicId, null));
  const chat = payload.items.find((c) => c.phone === LID);
  assert.equal(chat.sendingAccount.label, 'Recepcion 2');
  assert.equal(chat.sendingAccountIsFallback, false);
});

test('un chat @lid SIN número enlazado sale por un QR conectado, nunca por Cloud API', async () => {
  const { clinicId } = await H.seedClinic();
  const { vivo } = await numeros(); // «Recepcion» (Cloud) es la principal
  const LID = '204496395366461';
  const conv = await Conversation.create({
    clinic: clinicId, phone: LID, externalUserId: `${LID}@lid`, channel: 'whatsapp',
  });

  const cuenta = await gateway.resolveAccountForConversation(conv);
  assert.equal(
    String(cuenta._id), String(vivo._id),
    'por Cloud el envío iría a los dígitos del LID; solo una sesión QR puede escribir a un LID'
  );
});

test('un chat @lid con el teléfono real ya resuelto SÍ se desvía como cualquier otro', async () => {
  const { clinicId } = await H.seedClinic();
  const { bloqueado } = await numeros();
  const conv = await Conversation.create({
    clinic: clinicId, phone: TEL, externalUserId: '128374619283746@lid', channel: 'whatsapp',
    whatsappAccount: bloqueado._id, lastInboundAccount: bloqueado._id,
    lastInboundAt: new Date(), lastMessageDirection: 'in',
  });

  const cuenta = await gateway.resolveAccountForConversation(await Conversation.findById(conv._id));
  assert.equal(cuenta.label, 'Recepcion', 'aquí sí hay un teléfono de verdad al que escribir');
});

test('si NINGÚN número puede enviar, se intenta por el del chat (y su error real)', async () => {
  const { clinicId } = await H.seedClinic();
  const { recepcion, bloqueado, vivo } = await numeros();
  recepcion.accessToken = '';
  await recepcion.save();
  vivo.status = 'auth_failure';
  await vivo.save();
  const conv = await chatQueEscribioA(clinicId, bloqueado);

  const cuenta = await gateway.resolveAccountForConversation(await Conversation.findById(conv._id));
  assert.equal(String(cuenta._id), String(bloqueado._id), 'mejor el error del proveedor que un desvío inútil');
});
