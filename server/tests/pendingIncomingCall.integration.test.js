const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const callController = require('../controllers/callController');
const Call = require('../models/Call');
const Conversation = require('../models/Conversation');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function pending(clinicId, userId, query = {}) {
  return H.runController(
    callController.getPendingCall,
    H.mockReq(clinicId, userId, {}, { role: 'call_center', query })
  );
}

test('la PWA recupera el OFFER de una llamada que llego mientras estaba cerrada', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const userId = new H.mongoose.Types.ObjectId();
  const conv = await Conversation.create({
    clinic: clinicId,
    phone: '593999001122',
    channel: 'whatsapp',
    contactName: 'Contacto de prueba',
  });
  const call = await Call.create({
    clinic: clinicId,
    conversation: conv._id,
    callId: 'wacid.pending.1',
    direction: 'in',
    phone: conv.phone,
    status: 'ringing',
    offerSdp: 'v=0\r\no=offer-de-meta',
  });

  const response = await pending(clinicId, userId, { callId: call.callId });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.call.callId, call.callId);
  assert.equal(response.payload.call.contactName, 'Contacto de prueba');
  assert.equal(response.payload.call.sdp, 'v=0\r\no=offer-de-meta');
  assert.equal((await Call.findById(call._id)).offerSdp, undefined, 'el historial normal no expone el SDP');
});

test('no recupera una llamada reservada para otro asesor ni una que ya termino', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const ownerId = new H.mongoose.Types.ObjectId();
  const otherId = new H.mongoose.Types.ObjectId();
  const conv = await Conversation.create({
    clinic: clinicId,
    phone: '593999003344',
    channel: 'whatsapp',
    workflowRestrictedTo: ownerId,
    workflowRestrictionActive: true,
  });
  const call = await Call.create({
    clinic: clinicId,
    conversation: conv._id,
    callId: 'wacid.private.1',
    direction: 'in',
    phone: conv.phone,
    status: 'ringing',
    offerSdp: 'v=0 private',
  });

  const hidden = await pending(clinicId, otherId, { callId: call.callId });
  assert.equal(hidden.statusCode, 200);
  assert.equal(hidden.payload.call, null);

  call.status = 'missed';
  await call.save();
  const ended = await pending(clinicId, ownerId, { callId: call.callId });
  assert.equal(ended.payload.call, null);
});
