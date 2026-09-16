const test = require('node:test');
const assert = require('node:assert/strict');

let activeCall;
let activeConversation;
let conversationResolutionCount = 0;
let providerInvocation;

const callAccount = {
  _id: 'account-that-received-the-call',
  connectionType: 'cloud_api',
  phoneNumberId: 'phone-number-that-received-the-call',
};
const chatAccount = {
  _id: 'account-linked-to-the-chat',
  connectionType: 'cloud_api',
  phoneNumberId: 'different-phone-number-linked-to-the-chat',
};

function queryResult(value) {
  const query = Promise.resolve(value);
  query.select = () => Promise.resolve(value);
  return query;
}

function installMock(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

installMock('../models/Call', {
  findOne: async () => activeCall,
  findById: async () => activeCall,
});
installMock('../models/Conversation', {
  findById: () => queryResult(activeConversation),
  findOne: async () => activeConversation,
});
installMock('../utils/whatsappGateway', {
  resolveAccountForConversation: async () => {
    conversationResolutionCount += 1;
    return chatAccount;
  },
  getUsableAccount: async (id) => (String(id) === callAccount._id ? callAccount : null),
  cloudCreds: (account) => ({ phoneNumberId: account.phoneNumberId }),
});
installMock('../utils/whatsappCalls', {
  acceptCall: async (creds, callId) => {
    providerInvocation = { action: 'accept', creds, callId };
    return { ok: true };
  },
  rejectCall: async (creds, callId) => {
    providerInvocation = { action: 'reject', creds, callId };
    return { ok: true };
  },
  terminateCall: async (creds, callId) => {
    providerInvocation = { action: 'terminate', creds, callId };
    return { ok: true };
  },
});
installMock('../realtime', {
  emitToCallCenter: () => {},
  emitChatAssignment: () => {},
});
installMock('../controllers/chatController', {
  canAccessConversation: () => true,
});

const callController = require('../controllers/callController');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function arrangeCall(status, whatsappAccount = callAccount._id) {
  activeCall = {
    _id: 'call-db-id',
    callId: 'wacid.cross-number',
    clinic: 'clinic-id',
    conversation: 'conversation-id',
    whatsappAccount,
    direction: 'in',
    status,
    save: async () => {},
  };
  activeConversation = {
    _id: 'conversation-id',
    whatsappAccount: chatAccount._id,
    assignedTo: 'agent-already-assigned',
    save: async () => {},
  };
  conversationResolutionCount = 0;
  providerInvocation = null;
}

function request(body = {}) {
  return {
    params: { callId: 'wacid.cross-number' },
    clinicId: 'clinic-id',
    user: { _id: 'agent-id', name: 'Agente' },
    body,
  };
}

test('aceptar, rechazar y colgar usan el número de la llamada, no el número asociado al chat', async () => {
  const cases = [
    { action: 'accept', handler: callController.acceptCall, status: 'ringing', body: { sdp: 'v=0 answer' } },
    { action: 'reject', handler: callController.rejectCall, status: 'ringing', body: {} },
    { action: 'terminate', handler: callController.terminateCall, status: 'active', body: {} },
  ];

  for (const current of cases) {
    arrangeCall(current.status);
    const res = responseRecorder();

    await current.handler(request(current.body), res);

    assert.equal(res.statusCode, 200, `${current.action} no debe fallar`);
    assert.equal(providerInvocation.action, current.action);
    assert.equal(providerInvocation.callId, 'wacid.cross-number');
    assert.equal(providerInvocation.creds.phoneNumberId, callAccount.phoneNumberId);
    assert.equal(conversationResolutionCount, 0, 'no debe volver a resolver la cuenta desde el chat');
  }
});

test('una llamada antigua sin cuenta conserva la resolución mediante la conversación', async () => {
  arrangeCall('ringing', null);
  const res = responseRecorder();

  await callController.acceptCall(request({ sdp: 'v=0 answer' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(providerInvocation.creds.phoneNumberId, chatAccount.phoneNumberId);
  assert.equal(conversationResolutionCount, 1);
});
