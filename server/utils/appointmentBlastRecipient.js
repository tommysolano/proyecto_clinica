// The appointment patient owns the reminder. When someone booked for another
// patient through WhatsApp, the reminder goes to that originating chat.
const enviable = (p) => p?.marketing?.whatsappOptIn !== false && !p?.marketing?.optOutAt;

function recipientForAppointment(apt, anchorClinic) {
  const patient = apt.patient;
  if (!patient?._id) return { reason: 'sin_paciente' };
  if (!enviable(patient)) return { reason: 'baja' };
  const conversation = apt.conversation;
  const owner = conversation?.patient;
  if (conversation?._id && String(conversation.clinic) === String(anchorClinic) &&
      (conversation.channel || 'whatsapp') === 'whatsapp' && owner?._id &&
      String(owner._id) !== String(patient._id)) {
    if (!enviable(owner)) return { reason: 'baja' };
    const chatPhone = String(conversation.linkedPhone || conversation.phone || '').trim();
    if (chatPhone) return { phone: chatPhone, conversation: conversation._id };
  }
  const phone = String(patient.whatsapp || patient.phone || '').trim();
  if (phone) return { phone };
  return { reason: 'sin_telefono' };
}

const conversationPopulation = {
  path: 'conversation', select: 'clinic channel phone linkedPhone patient',
  populate: { path: 'patient', select: 'marketing' },
};

module.exports = { recipientForAppointment, conversationPopulation };
