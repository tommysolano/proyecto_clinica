/**
 * Llamadas de voz de WhatsApp desde el CRM (Calling API de Meta).
 *
 * Este controller es SOLO señalización: recibe del navegador del agente el SDP
 * (la descripción de su sesión de audio WebRTC), lo reenvía a Meta, y devuelve
 * por socket.io el SDP del otro lado. El audio nunca toca el servidor, va
 * directo navegador ↔ WhatsApp.
 *
 *   Saliente:  POST /chats/:id/call {sdp offer}
 *                → connectCall → Meta responde con callId
 *                → webhook 'connect' con el ANSWER → socket 'call:answered'
 *   Entrante:  webhook 'connect' con el OFFER del contacto
 *                → socket 'call:incoming' a todos los agentes
 *                → POST /chats/calls/:callId/accept {sdp answer} → hay audio
 *
 * Solo funciona con números Cloud API: una sesión QR (WhatsApp Web) no expone
 * llamadas, ni para hacerlas ni para recibirlas.
 */
const Call = require('../models/Call');
const Conversation = require('../models/Conversation');
const gateway = require('../utils/whatsappGateway');
const calls = require('../utils/whatsappCalls');
const { emitToCallCenter } = require('../realtime');

// Una entrante que nadie contesta no puede quedarse "sonando" para siempre en
// la UI: si Meta no manda 'terminate' se marca perdida por tiempo.
const RINGING_TIMEOUT_MS = 60 * 1000;

/**
 * Resuelve el número Cloud API por el que hablar con esta conversación y explica
 * el motivo si no se puede llamar (el front usa el motivo para el tooltip).
 */
async function resolveCallingAccount(conv) {
  const account = await gateway.resolveAccountForConversation(conv);
  if (!account) return { ok: false, reason: 'Sin número de WhatsApp configurado.' };
  if (account.connectionType !== 'cloud_api') {
    return {
      ok: false,
      reason: 'Este chat usa un número conectado por QR, y WhatsApp Web no permite llamadas. Solo los números de Cloud API pueden llamar.',
    };
  }
  return { ok: true, account, creds: gateway.cloudCreds(account) };
}

function callPayload(call) {
  return {
    _id: call._id,
    callId: call.callId,
    conversationId: call.conversation,
    direction: call.direction,
    phone: call.phone,
    status: call.status,
    agentName: call.agentName,
    startedAt: call.startedAt,
    connectedAt: call.connectedAt,
    endedAt: call.endedAt,
    durationSec: call.durationSec,
    errorMessage: call.errorMessage,
  };
}

/** ¿Se pueden hacer llamadas en el número de este chat? (para pintar el botón) */
exports.getCallingStatus = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    const resolved = await resolveCallingAccount(conv);
    // El número es QR (o no hay número): no se puede habilitar nada, es un límite
    // duro de WhatsApp Web. `canEnable:false` para que el front no ofrezca el botón.
    if (!resolved.ok) return res.json({ enabled: false, canEnable: false, reason: resolved.reason });
    const settings = await calls.getCallingSettings(resolved.creds);
    if (!settings.ok) {
      return res.json({ enabled: false, canEnable: false, reason: settings.error || 'No se pudo consultar la configuración de llamadas.' });
    }
    const status = String(settings.calling?.status || '').toUpperCase();
    return res.json({
      enabled: status === 'ENABLED',
      // Es un número Cloud API cuyas llamadas están APAGADAS: un admin puede
      // encenderlas desde la UI (POST /calling-enable) sin entrar a Meta.
      canEnable: status !== 'ENABLED',
      reason: status === 'ENABLED'
        ? ''
        : 'Las llamadas no están habilitadas en este número de WhatsApp. Un administrador puede activarlas.',
      status,
    });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/** Habilita las llamadas en el número del chat (acción de administrador). */
exports.enableCalling = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    const resolved = await resolveCallingAccount(conv);
    if (!resolved.ok) return res.status(400).json({ message: resolved.reason });
    const r = await calls.enableCalling(resolved.creds);
    if (!r.ok) return res.status(502).json({ message: r.error || 'Meta rechazó habilitar las llamadas' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/**
 * Inicia una llamada saliente. El navegador manda su SDP offer; el answer llega
 * luego por el webhook y se reenvía por socket ('call:answered').
 */
exports.startCall = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    if (conv.blocked) return res.status(403).json({ message: 'Este contacto está bloqueado.' });
    const sdp = String(req.body.sdp || '');
    if (!sdp) return res.status(400).json({ message: 'Falta la sesión de audio (SDP) del navegador' });

    const resolved = await resolveCallingAccount(conv);
    if (!resolved.ok) return res.status(400).json({ message: resolved.reason });

    // Una llamada viva en este chat bloquea otra: evita dobles timbres al
    // contacto si dos agentes pulsan llamar a la vez.
    const live = await Call.findOne({ conversation: conv._id, status: { $in: ['ringing', 'active'] } });
    if (live) {
      return res.status(409).json({ message: 'Este chat ya tiene una llamada en curso.' });
    }

    const r = await calls.connectCall(resolved.creds, conv.phone, sdp);
    if (!r.ok || !r.callId) {
      const call = await Call.create({
        clinic: req.clinicId,
        conversation: conv._id,
        patient: conv.patient || null,
        whatsappAccount: resolved.account._id,
        direction: 'out',
        phone: conv.phone,
        status: 'failed',
        agent: req.user._id,
        agentName: req.user.name,
        endedAt: new Date(),
        errorMessage: r.error || 'Meta no devolvió un identificador de llamada',
      });
      emitToCallCenter('call:ended', callPayload(call));
      return res.status(502).json({ message: r.error || 'No se pudo iniciar la llamada', code: r.errorSubcode });
    }

    const call = await Call.create({
      clinic: req.clinicId,
      conversation: conv._id,
      patient: conv.patient || null,
      whatsappAccount: resolved.account._id,
      callId: r.callId,
      direction: 'out',
      phone: conv.phone,
      status: 'ringing',
      agent: req.user._id,
      agentName: req.user.name,
    });
    emitToCallCenter('call:status', callPayload(call));
    scheduleRingingTimeout(call._id);
    res.status(201).json(callPayload(call));
  } catch (err) {
    res.status(500).json({ message: 'Error al iniciar la llamada', error: err.message });
  }
};

/** Acepta una llamada entrante con el SDP answer del navegador del agente. */
exports.acceptCall = async (req, res) => {
  try {
    const call = await Call.findOne({ callId: req.params.callId, clinic: req.clinicId });
    if (!call) return res.status(404).json({ message: 'Llamada no encontrada' });
    if (call.status !== 'ringing') {
      return res.status(409).json({ message: 'Esa llamada ya no está sonando.' });
    }
    const sdp = String(req.body.sdp || '');
    if (!sdp) return res.status(400).json({ message: 'Falta la sesión de audio (SDP) del navegador' });
    const conv = await Conversation.findById(call.conversation);
    const resolved = await resolveCallingAccount(conv);
    if (!resolved.ok) return res.status(400).json({ message: resolved.reason });

    const r = await calls.acceptCall(resolved.creds, call.callId, sdp);
    if (!r.ok) {
      call.status = 'failed';
      call.endedAt = new Date();
      call.errorMessage = r.error || 'No se pudo aceptar la llamada';
      await call.save();
      emitToCallCenter('call:ended', callPayload(call));
      return res.status(502).json({ message: call.errorMessage });
    }
    // El agente que contesta se queda con la llamada (y con el chat si estaba libre).
    call.status = 'active';
    call.connectedAt = new Date();
    call.agent = req.user._id;
    call.agentName = req.user.name;
    await call.save();
    if (conv && !conv.assignedTo) {
      conv.assignedTo = req.user._id;
      conv.assignedToName = req.user.name;
      conv.assignedAt = new Date();
      await conv.save();
    }
    emitToCallCenter('call:status', callPayload(call));
    res.json(callPayload(call));
  } catch (err) {
    res.status(500).json({ message: 'Error al aceptar la llamada', error: err.message });
  }
};

exports.rejectCall = async (req, res) => {
  try {
    const call = await Call.findOne({ callId: req.params.callId, clinic: req.clinicId });
    if (!call) return res.status(404).json({ message: 'Llamada no encontrada' });
    // Solo se rechaza lo que aún suena: si otro agente ya contestó, el panel
    // rezagado de un tercero no puede tumbarle la llamada.
    if (call.status !== 'ringing') {
      return res.status(409).json({ message: 'Esa llamada ya fue atendida o terminó.' });
    }
    const conv = await Conversation.findById(call.conversation);
    const resolved = await resolveCallingAccount(conv);
    if (resolved.ok) await calls.rejectCall(resolved.creds, call.callId);
    await finishCall(call, { status: 'rejected' });
    res.json(callPayload(call));
  } catch (err) {
    res.status(500).json({ message: 'Error al rechazar la llamada', error: err.message });
  }
};

/** Cuelga una llamada activa (o cancela una saliente que aún suena). */
exports.terminateCall = async (req, res) => {
  try {
    const call = await Call.findOne({ callId: req.params.callId, clinic: req.clinicId });
    if (!call) return res.status(404).json({ message: 'Llamada no encontrada' });
    const conv = await Conversation.findById(call.conversation);
    const resolved = await resolveCallingAccount(conv);
    if (resolved.ok) await calls.terminateCall(resolved.creds, call.callId);
    await finishCall(call, { status: 'completed' });
    res.json(callPayload(call));
  } catch (err) {
    res.status(500).json({ message: 'Error al colgar', error: err.message });
  }
};

/** Pide al contacto permiso para llamarle (Meta lo exige antes de una saliente). */
exports.requestCallPermission = async (req, res) => {
  try {
    const conv = await Conversation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!conv) return res.status(404).json({ message: 'Conversación no encontrada' });
    const resolved = await resolveCallingAccount(conv);
    if (!resolved.ok) return res.status(400).json({ message: resolved.reason });
    const r = await calls.requestCallPermission(resolved.creds, conv.phone, req.body.text);
    if (!r.ok) return res.status(502).json({ message: r.error || 'No se pudo pedir permiso para llamar' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

/** Historial de llamadas del chat (se muestra en el panel lateral). */
exports.listCalls = async (req, res) => {
  try {
    const list = await Call.find({ conversation: req.params.id, clinic: req.clinicId })
      .sort({ createdAt: -1 })
      .limit(50);
    res.json(list.map(callPayload));
  } catch (err) {
    res.status(500).json({ message: 'Error', error: err.message });
  }
};

// ─────────────────────────── Webhook de Meta ───────────────────────────

/** Cierra una llamada, calcula la duración y avisa a la UI. */
async function finishCall(call, { status, errorMessage = '' } = {}) {
  if (['completed', 'rejected', 'missed', 'failed'].includes(call.status)) return call;
  call.status = status;
  call.endedAt = new Date();
  if (call.connectedAt) {
    call.durationSec = Math.max(0, Math.round((call.endedAt - call.connectedAt) / 1000));
  }
  if (errorMessage) call.errorMessage = errorMessage;
  await call.save();
  emitToCallCenter('call:ended', callPayload(call));
  return call;
}

// Marca como perdida una entrante que nadie contestó (o una saliente que nunca
// fue respondida) si Meta no manda el 'terminate'.
function scheduleRingingTimeout(callId) {
  const t = setTimeout(async () => {
    try {
      const fresh = await Call.findById(callId);
      if (fresh && fresh.status === 'ringing') {
        await finishCall(fresh, { status: 'missed' });
      }
    } catch {
      /* noop */
    }
  }, RINGING_TIMEOUT_MS);
  t.unref?.();
}

/** Llamada entrante: crea (o reutiliza) la conversación del número que llama. */
async function conversationForIncomingCall(clinicId, phone, account) {
  const chatCtrl = require('./chatController');
  const normalized = chatCtrl.normalizePhone(phone) || phone;
  let conv = await Conversation.findOne({ clinic: clinicId, channel: 'whatsapp', phone: normalized });
  if (!conv) {
    const patient = await chatCtrl.findPatientForIncoming(clinicId, normalized);
    conv = await Conversation.create({
      clinic: clinicId,
      phone: normalized,
      channel: 'whatsapp',
      contactName: patient ? `${patient.firstName || ''} ${patient.lastName || ''}`.trim() : '',
      patient: patient?._id || null,
      whatsappAccount: account?._id || null,
    });
    emitToCallCenter('chat:conversation', { conversationId: conv._id });
  }
  return conv;
}

/**
 * Procesa el campo 'calls' del webhook de WhatsApp. Meta manda:
 *   - event 'connect': con el SDP. En una entrante es el OFFER del contacto; en
 *     una saliente es el ANSWER (el contacto descolgó).
 *   - event 'terminate': la llamada acabó, con estado y duración.
 */
exports.handleCallWebhook = async (clinicId, value, account) => {
  const list = Array.isArray(value?.calls) ? value.calls : [];
  for (const raw of list) {
    const ev = calls.parseCallEvent(raw);
    if (!ev || !ev.callId) continue;

    if (ev.event === 'connect') {
      // eslint-disable-next-line no-await-in-loop
      await handleConnect(clinicId, ev, account);
      continue;
    }
    if (ev.event === 'terminate') {
      // eslint-disable-next-line no-await-in-loop
      const call = await Call.findOne({ callId: ev.callId });
      if (!call) continue;
      const failed = ev.status && ev.status !== 'COMPLETED';
      // Sin conectar nunca = nadie contestó; con conexión = colgada normal.
      const status = failed ? (call.connectedAt ? 'completed' : 'missed') : 'completed';
      if (ev.duration && !call.durationSec) call.durationSec = ev.duration;
      // eslint-disable-next-line no-await-in-loop
      await finishCall(call, { status, errorMessage: failed ? `WhatsApp: ${ev.status}` : '' });
      continue;
    }
    console.warn('[whatsapp calls] evento no reconocido:', ev.event, JSON.stringify(raw).slice(0, 300));
  }
};

async function handleConnect(clinicId, ev, account) {
  // Saliente: el contacto aceptó y Meta manda su ANSWER → al navegador que llamó.
  if (ev.sdpType === 'answer' || ev.direction === 'out') {
    const call = await Call.findOne({ callId: ev.callId });
    if (!call) {
      console.warn('[whatsapp calls] answer de una llamada desconocida:', ev.callId);
      return;
    }
    call.status = 'active';
    call.connectedAt = new Date();
    await call.save();
    emitToCallCenter('call:answered', { ...callPayload(call), sdp: ev.sdp });
    return;
  }

  // Entrante: el contacto nos llama y manda su OFFER → suena en el call center.
  const phone = ev.from || '';
  const conv = await conversationForIncomingCall(clinicId, phone, account);
  if (conv.blocked) {
    const resolved = await resolveCallingAccount(conv);
    if (resolved.ok) await calls.rejectCall(resolved.creds, ev.callId);
    return;
  }
  // Meta puede reintentar el webhook: no crear dos llamadas para el mismo id.
  const existing = await Call.findOne({ callId: ev.callId });
  if (existing) return;

  const call = await Call.create({
    clinic: clinicId,
    conversation: conv._id,
    patient: conv.patient || null,
    whatsappAccount: account?._id || null,
    callId: ev.callId,
    direction: 'in',
    phone: conv.phone,
    status: 'ringing',
  });
  emitToCallCenter('call:incoming', {
    ...callPayload(call),
    sdp: ev.sdp,
    contactName: conv.contactName || conv.phone,
  });
  scheduleRingingTimeout(call._id);
}
