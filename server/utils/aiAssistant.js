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

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';

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
 * Genera una sugerencia de respuesta para una conversación.
 * @returns {{ ok:boolean, suggestion?:string, reason?:string }}
 */
async function suggestReply({ clinicId, conversationId }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, reason: 'IA no configurada (falta ANTHROPIC_API_KEY)' };

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
        model: DEFAULT_MODEL,
        max_tokens: 400,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(messages, contactName) }],
      }),
    });
  } catch (err) {
    return { ok: false, reason: `Error de red al contactar la IA: ${err.message}` };
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, reason: data?.error?.message || `IA respondió ${res.status}` };
  }
  // La IA puede declinar por seguridad: revisar stop_reason antes de leer content.
  if (data.stop_reason === 'refusal') {
    return { ok: false, reason: 'La IA no pudo generar una respuesta para este caso.' };
  }
  const suggestion = extractText(data);
  if (!suggestion) return { ok: false, reason: 'La IA no devolvió texto.' };
  return { ok: true, suggestion };
}

module.exports = { buildUserPrompt, extractText, suggestReply, DEFAULT_MODEL };
