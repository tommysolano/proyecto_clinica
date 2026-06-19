/**
 * Asistente de IA (Claude) para el call center: sugiere una respuesta al agente
 * a partir de la conversación. Llama a la Messages API de Anthropic por HTTP
 * (sin SDK, este proyecto no lo usa).
 *
 * La API key se toma de la variable de entorno ANTHROPIC_API_KEY (no se guarda
 * en BD). Si no está configurada, degrada con gracia: { ok:false, reason }.
 *
 * Modelo por defecto: claude-opus-4-8 (configurable con ANTHROPIC_MODEL).
 */
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const CallCenterConfig = require('../models/CallCenterConfig');
const { decryptSecret } = require('./secretCrypto');

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

/**
 * Resuelve la configuración de IA de una clínica: usa CallCenterConfig.ai si está
 * habilitada y tiene key; si no, cae a las variables de entorno. Devuelve
 * { apiKey, model } o { apiKey: null } si no hay forma de llamar a la IA.
 */
async function getAiConfig(clinicId) {
  if (clinicId) {
    const cfg = await CallCenterConfig.findOne({ clinic: clinicId }).select('ai').lean();
    const ai = cfg?.ai;
    if (ai?.enabled && ai?.apiKey) {
      return { apiKey: decryptSecret(ai.apiKey), model: ai.model || DEFAULT_MODEL };
    }
  }
  const envKey = process.env.ANTHROPIC_API_KEY;
  return { apiKey: envKey || null, model: DEFAULT_MODEL };
}

const SYSTEM_PROMPT =
  'Eres un asistente del call center de una clínica estética en Ecuador. ' +
  'A partir de la conversación de WhatsApp, redacta UNA sola respuesta para enviar al paciente: ' +
  'breve (2-4 frases), cálida, profesional y en español. ' +
  'No inventes precios, fechas, ni datos médicos que no aparezcan en la conversación. ' +
  'No incluyas firma ni "Equipo de...". Devuelve únicamente el texto del mensaje, sin comillas ni explicaciones.';

/**
 * Construye el prompt de usuario (transcripción + instrucción). PURO y testeable.
 */
function buildUserPrompt(messages, contactName) {
  const transcript = (messages || [])
    .filter((m) => m.body)
    .map((m) => `${m.direction === 'in' ? 'Paciente' : 'Agente'}: ${m.body}`)
    .join('\n');
  const who = contactName ? ` El paciente se llama ${contactName}.` : '';
  return (
    `Conversación hasta ahora:\n${transcript}\n\n` +
    `Redacta la próxima respuesta del Agente.${who}`
  );
}

function extractText(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/**
 * Llama a la Messages API de Claude con un system + un mensaje de usuario.
 * Centraliza el manejo de errores y de `stop_reason:'refusal'`.
 * @returns {{ ok:boolean, text?:string, reason?:string }}
 */
async function callClaude({ apiKey, model, system, userContent, maxTokens = 400 }) {
  let res;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userContent }],
      }),
    });
  } catch (err) {
    return { ok: false, reason: `Error de red al contactar la IA: ${err.message}` };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, reason: data?.error?.message || `IA respondió ${res.status}` };
  // La IA puede declinar por seguridad: revisar stop_reason antes de leer content.
  if (data.stop_reason === 'refusal') {
    return { ok: false, reason: 'La IA no pudo generar una respuesta para este caso.' };
  }
  const text = extractText(data);
  if (!text) return { ok: false, reason: 'La IA no devolvió texto.' };
  return { ok: true, text };
}

/**
 * Genera una sugerencia de respuesta para una conversación.
 * @returns {{ ok:boolean, suggestion?:string, reason?:string }}
 */
async function suggestReply({ clinicId, conversationId }) {
  const { apiKey, model } = await getAiConfig(clinicId);
  if (!apiKey) return { ok: false, reason: 'IA no configurada. Actívala en Configuración Call Center → IA.' };

  const conv = await Conversation.findOne({ _id: conversationId, clinic: clinicId })
    .populate('patient', 'firstName lastName');
  if (!conv) return { ok: false, reason: 'Conversación no encontrada' };

  const messages = await Message.find({ conversation: conv._id, clinic: clinicId })
    .sort({ createdAt: -1 })
    .limit(15)
    .select('direction body createdAt');
  messages.reverse();
  if (!messages.length) return { ok: false, reason: 'No hay mensajes en la conversación' };

  const contactName =
    (conv.patient ? `${conv.patient.firstName || ''}`.trim() : '') || conv.contactName || '';

  const r = await callClaude({
    apiKey,
    model,
    system: SYSTEM_PROMPT,
    userContent: buildUserPrompt(messages, contactName),
    maxTokens: 400,
  });
  return r.ok ? { ok: true, suggestion: r.text } : r;
}

const SUMMARY_SYSTEM =
  'Eres un asistente del call center de una clínica estética en Ecuador. ' +
  'Resume la conversación de WhatsApp en español, en 3-5 viñetas breves: ' +
  'motivo del paciente, servicios o precios mencionados, estado/acuerdos, y el próximo ' +
  'paso pendiente. Sé conciso y objetivo. Devuelve solo las viñetas, sin preámbulo.';

/**
 * Resume una conversación para el agente. Mismo patrón que suggestReply.
 * @returns {{ ok:boolean, summary?:string, reason?:string }}
 */
async function summarizeConversation({ clinicId, conversationId }) {
  const { apiKey, model } = await getAiConfig(clinicId);
  if (!apiKey) return { ok: false, reason: 'IA no configurada. Actívala en Configuración Call Center → IA.' };

  const conv = await Conversation.findOne({ _id: conversationId, clinic: clinicId });
  if (!conv) return { ok: false, reason: 'Conversación no encontrada' };

  const messages = await Message.find({ conversation: conv._id, clinic: clinicId })
    .sort({ createdAt: -1 })
    .limit(40)
    .select('direction body createdAt');
  messages.reverse();
  if (!messages.length) return { ok: false, reason: 'No hay mensajes en la conversación' };

  const transcript = messages
    .filter((m) => m.body)
    .map((m) => `${m.direction === 'in' ? 'Paciente' : 'Agente'}: ${m.body}`)
    .join('\n');

  const r = await callClaude({
    apiKey,
    model,
    system: SUMMARY_SYSTEM,
    userContent: `Conversación:\n${transcript}\n\nResume la conversación.`,
    maxTokens: 500,
  });
  return r.ok ? { ok: true, summary: r.text } : r;
}

/**
 * Prueba la configuración de IA de una clínica con una llamada mínima.
 * @returns {{ ok:boolean, reason?:string, model?:string }}
 */
async function testAiConnection(clinicId) {
  const { apiKey, model } = await getAiConfig(clinicId);
  if (!apiKey) return { ok: false, reason: 'No hay API key configurada (ni en config ni en entorno).' };
  const r = await callClaude({
    apiKey,
    model,
    system: 'Responde con la palabra "ok".',
    userContent: 'ping',
    maxTokens: 10,
  });
  return r.ok ? { ok: true, model } : { ok: false, reason: r.reason };
}

module.exports = { buildUserPrompt, extractText, callClaude, suggestReply, summarizeConversation, getAiConfig, testAiConnection, DEFAULT_MODEL };
