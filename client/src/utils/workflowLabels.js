// Etiquetas en español de las inscripciones a automatizaciones (workflows).
// Viven aquí porque las usan dos pantallas: Marketing → Automatizaciones
// (modal de inscritos) y el panel del contacto en Chats.

export const ENROLL_STATUS = {
  active: { label: 'Ejecutando', cls: 'bg-blue-100 text-blue-700' },
  waiting: { label: 'En espera', cls: 'bg-amber-100 text-amber-700' },
  done: { label: 'Completado', cls: 'bg-emerald-100 text-emerald-700' },
  cancelled: { label: 'Cancelado', cls: 'bg-slate-100 text-slate-500' },
};

// Etiquetas legibles de los tipos de paso para el registro de ejecución.
export const STEP_LABELS = {
  send_message: 'Enviar mensaje',
  send_media: 'Enviar imagen / video',
  send_template: 'Enviar plantilla',
  send_email: 'Enviar email',
  wait: 'Espera',
  wait_until: 'Espera hasta la cita',
  wait_reply: 'Esperar respuesta',
  condition: 'Condición',
  split: 'Dividir (bifurcación)',
  goal: 'Objetivo',
  add_tag: 'Añadir etiqueta',
  remove_tag: 'Quitar etiqueta',
  create_opportunity: 'Crear oportunidad',
  move_stage: 'Etapa de oportunidad (antiguo)',
  set_appointment_status: 'Cambiar estado de cita',
  assign_agent: 'Asignar agente',
  create_task: 'Crear tarea',
  webhook: 'Webhook',
  ai_reply: 'Respuesta IA',
  request_review: 'Pedir reseña',
};
