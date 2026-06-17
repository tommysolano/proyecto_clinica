# Plan de implementación — Marketing & CRM de mensajes (Clínica)

> Objetivo: llevar el módulo de **marketing + CRM omnicanal** a nivel **GoHighLevel adaptado a una clínica**:
> bandeja omnicanal cumpliendo la API de WhatsApp, segmentación reutilizable, un **motor de workflows con
> condiciones y disparadores por evento**, los casos verticales de clínica (recordatorios de cita, recall,
> reactivación, post-visita/reseñas) y atribución de campañas con ROI.
> Este documento es la hoja de ruta. Cada fase deja el sistema en un estado coherente, cumple normativa
> (WhatsApp + LOPDP Ecuador) y especifica **qué se trabaja en backend y qué en frontend**.

---

## 0. Estado actual (diagnóstico)

**Base sólida ya construida:**
- Bandeja omnicanal: [Conversation.js](../server/models/Conversation.js) soporta `whatsapp, sms, web, messenger, instagram, tiktok`; webhooks por canal con `clinicId` en URL y verificación Meta/TikTok ([chatController.js](../server/controllers/chatController.js)).
- Envío saliente real (WhatsApp Cloud, Messenger, Instagram) en `sendToExternalChannel` ([chatController.js:988](../server/controllers/chatController.js#L988)); TikTok es stub.
- Pipeline de oportunidades (Kanban) con múltiples oportunidades por chat, `expectedValue` desde inventario.
- Asignación a agentes, destacar, bloquear, respuestas guardadas, galería, conversión a paciente/cita/cotización desde el chat.
- Dos motores de automatización: `AutoMessage` (reglas simples) y `MessageFlow`/`FlowRun` (flujos con pasos `message/wait/opportunity`, job cada 60s en [index.js:101](../server/index.js#L101)).
- Marketing analítico: dashboard, recordatorios, predicción heurística, heatmap por zonas, evolución de servicio, breakdown de citas, referrers ([marketingController.js](../server/controllers/marketingController.js)).
- Cliente WhatsApp Cloud con `sendText` y `sendTemplate` ([whatsappCloud.js](../server/utils/whatsappCloud.js)).
- Frontend: [Chats.jsx](../client/src/pages/Chats.jsx), [Marketing.jsx](../client/src/pages/Marketing.jsx), [AutoMessages.jsx](../client/src/pages/AutoMessages.jsx), [OpportunitiesGlobal.jsx](../client/src/pages/OpportunitiesGlobal.jsx), [CallCenterConfig.jsx](../client/src/pages/CallCenterConfig.jsx).

**Grietas detectadas (se atacan en este plan):**

| # | Severidad | Hallazgo | Ubicación |
|---|---|---|---|
| G1 | 🔴 | `bulkWhatsappOpportunities` crea `Message` pero **nunca llama a `sendToExternalChannel`** → el envío masivo desde oportunidades no envía nada | [chatController.js:869](../server/controllers/chatController.js#L869) |
| G2 | 🔴 | Ventana de 24h de WhatsApp no se respeta: `sendMessage`/flujos siempre usan `type:'text'` → Meta rechaza fuera de 24h | [chatController.js:1002](../server/controllers/chatController.js#L1002) |
| G3 | 🔴 | Sin gestión de plantillas (HSM): `sendTemplate` existe pero no hay modelo ni UI ni uso en bulk/flows | whatsappCloud / CallCenterConfig |
| G4 | 🔴 | Sin consentimiento / opt-out / unsubscribe (obligatorio por WhatsApp y LOPDP Ecuador) | Patient / chatController |
| G5 | 🟠 | Webhook no procesa `statuses` → `deliveryStatus` (delivered/read) nunca se actualiza | [chatController.js:1297](../server/controllers/chatController.js#L1297) |
| G6 | 🟠 | Firma `X-Hub-Signature-256` no se valida (se guarda `appSecret` pero no se usa) | webhooks Meta |
| G7 | 🟠 | Media entrante (imagen/audio/PDF del paciente) se descarta: solo se guarda `text.body` | ingestExternalMessage |
| G8 | 🔴 | Sin email marketing (ni SMTP, ni plantillas, ni tracking) | — (no existe) |
| G9 | 🟠 | SMS es enum legacy sin implementación en `sendToExternalChannel` | chatController |
| G10 | 🔴 | Sin segmentos/audiencias guardadas; cada consulta es ad-hoc | marketingController |
| G11 | 🟠 | `tags` solo en `Conversation`, no en `Patient` (segmentación pobre) | Patient |
| G12 | 🔴 | Flujos solo `message/wait/opportunity`: sin condiciones/ramas, sin esperar respuesta, sin esperar hasta evento/fecha, sin acciones (tag/email/asignar/tarea/webhook) | MessageFlow |
| G13 | 🔴 | Sin disparadores por evento del sistema (cita creada/asistida/no-show, tratamiento abandonado, cumpleaños, venta) | — |
| G14 | 🟠 | Sin recordatorio automático de cita con confirmación (mayor reductor de no-show) | — |
| G15 | 🟠 | Dos motores de automatización paralelos (deuda técnica) | AutoMessage + MessageFlow |
| G16 | 🟠 | Sin atribución de campaña/UTM ni click-to-WhatsApp de ads → sin ROI por campaña | Patient/Conversation |
| G17 | 🟠 | Imágenes en base64 dentro de Mongo (tope ~1.8MB), no escala | ChatGalleryImage / Message.mediaUrl |
| G18 | 🟠 | Tokens/secrets en texto plano en BD | CallCenterConfig |
| G19 | 🟡 | Sin notas internas/@menciones, tareas de agente, round-robin, SLA, tiempo de primera respuesta | chatController |
| G20 | 🟡 | Job de flujos es `setInterval` en un solo proceso (duplica con varias instancias) | index.js:101 |
| G21 | 🟡 | Sin captación: forms/landing ni link público de auto-agendamiento | — |
| G22 | 🟡 | Sin reputación (solicitud/gestión de reseñas) ni IA conversacional | — |

---

## 1. Principios de diseño

1. **Cumplimiento primero.** Nada de outbound que viole la ventana de 24h, las plantillas aprobadas o el consentimiento. El opt-out es sagrado y se respeta en todo envío.
2. **Un solo motor de automatización.** Se unifica `AutoMessage` + `MessageFlow` en `Workflow`. Se deprecia el legacy con feature flag.
3. **El envío es una sola puerta.** Todo mensaje saliente (manual, bulk, flujo, recordatorio) pasa por un único servicio `messaging.send()` que decide canal, valida ventana/plantilla/opt-out y registra `deliveryStatus`. Nunca se vuelve a duplicar la lógica de envío como en G1.
4. **Segmento como ciudadano de primera clase.** Toda campaña apunta a un `Segment` resoluble, no a una query ad-hoc.
5. **Eventos del dominio.** Los controladores de cita/venta/tratamiento emiten eventos; el motor de workflows se suscribe. El CRM no conoce la lógica clínica, solo reacciona a eventos.
6. **Idempotencia en bulk y jobs.** Cada envío programado lleva clave única (`workflow+step+patient+scheduledFor`) para no duplicar al reintentar.
7. **Multi-tenant estricto.** Todo lleva `clinic`; ningún job/segmento cruza clínicas.
8. **Media en almacenamiento de objetos**, no base64 en Mongo.
9. **Secrets cifrados** en reposo.
10. **Cada fase entrega pruebas** y deja `node --check` limpio + build de Vite verde.

---

## 2. Modelo de datos objetivo

### Nuevos modelos (backend)
- **`MessageTemplate`** (plantillas WhatsApp HSM + email): `clinic, channel(whatsapp|email), name, language, category(MARKETING|UTILITY|AUTHENTICATION), status(approved|pending|rejected), body, variables:[{key,example}], headerType, footer, buttons:[{type,text,url}], metaTemplateId, syncedAt`. Índice `{clinic, channel, name}`.
- **`Segment`** (smart list reutilizable): `clinic, name, description, entity(patient|conversation), filters{ sources:[], tags:[], treatmentStatus, service, programa, daysSinceLastVisit, zone, ageRange{min,max}, gender, hasOptIn }, dynamic(Boolean), createdBy`. Un resolver convierte `filters` → lista de destinatarios.
- **`Campaign`** (envío masivo único o programado): `clinic, name, channel, template, segment, scheduledFor, status(draft|scheduled|sending|done|cancelled), stats{ targeted, sent, delivered, read, failed, replied, optedOut }, createdBy`.
- **`Workflow`** (motor unificado, reemplaza AutoMessage+MessageFlow): `clinic, folder, name, active, trigger{ type, config }, steps:[WorkflowStep], schedule{days,hourFrom,hourTo}, stats, createdBy`.
- **`WorkflowStep`** (subdoc): `type`, más config por tipo (ver §5).
- **`WorkflowEnrollment`** (reemplaza FlowRun): `clinic, workflow, conversation, patient, stepIndex, status(active|waiting|done|cancelled|goal_met), nextRunAt, waitingForReply(Boolean), context{}`. Índice `{status, nextRunAt}` y `{workflow, patient, status}` (anti-duplicado).
- **`ScheduledMessage`** (cola de salida): `clinic, channel, to, template|body, patient, conversation, source{model,ref}, scheduledFor, status(queued|sent|failed|skipped), reason, idempotencyKey(unique)`.
- **`AgentTask`** (tareas de agente): `clinic, conversation, patient, assignedTo, title, dueAt, status(open|done), createdBy`.
- **`ReviewRequest`** (reputación): `clinic, patient, appointment, channel, sentAt, clicked, ratingGiven, status`.

### Cambios a modelos existentes
- **`Patient`** ([Patient.js](../server/models/Patient.js)): añadir `tags:[String]`, `marketing{ whatsappOptIn, emailOptIn, optOutAt, optOutReason }`, `attribution{ utmSource, utmMedium, utmCampaign, adId, firstTouchAt }`.
- **`Conversation`** ([Conversation.js](../server/models/Conversation.js)): añadir `window24hExpiresAt`, `attribution{ adId, campaign, ctwaClid }`, `internalNotes:[{ author, body, at }]`, `firstResponseAt`, `lastAgentReplyAt`.
- **`Message`** ([Message.js](../server/models/Message.js)): añadir `templateName`, `errorCode`, `errorMessage`, `statusTimestamps{ sentAt, deliveredAt, readAt }`, `mediaStorageKey` (para migrar de base64).
- **`CallCenterConfig`** ([CallCenterConfig.js](../server/models/CallCenterConfig.js)): cifrar tokens; añadir `email{ provider, apiKey, fromName, fromEmail, replyTo }`, `sms{ provider, ... }`.

---

## 3. Servicio de mensajería unificado (la "puerta única")

> Backend. Resuelve G1, G2, G3, G4, G9. Es prerequisito de casi todo lo demás.

Nuevo `server/utils/messaging.js` con la firma:

```
send({ clinicId, channel, to, patient?, conversation?, template?, vars?, body?, mediaUrl?, source }) → { ok, messageId, deliveryStatus, skipped?, reason? }
```

Reglas que aplica **siempre**:
1. **Opt-out**: si `patient.marketing.optOutAt` o la conversación está bloqueada → `skipped: 'opt_out'`.
2. **Ventana 24h** (solo WhatsApp): calcular `window24hExpiresAt` a partir del último entrante. Si está dentro → texto libre; si está fuera → **exige `template`** (si no hay plantilla → `skipped: 'out_of_window'`).
3. **Canal**: despacha a WhatsApp/Messenger/Instagram/Email/SMS según `channel` y config de la clínica.
4. **Registro**: crea `Message` con `deliveryStatus`, `templateName`, `errorCode`. Actualiza snapshot de la conversación.
5. **Realtime**: `emitToClinic('chat:message')`.

**Refactor obligatorio**: `sendMessage`, `sendFlowMessage`, `bulkWhatsappOpportunities` (G1), `sendBulkWhatsapp` de marketing y `whatsappBroadcast` de tratamientos pasan a llamar a esta puerta. Se elimina la lógica de `fetch` duplicada en `sendToExternalChannel`.

**Frontend asociado**: en el compositor del chat ([Chats.jsx](../client/src/pages/Chats.jsx)) mostrar un **aviso de "ventana cerrada"** cuando hayan pasado >24h, deshabilitar texto libre y ofrecer un selector de plantillas aprobadas. Badge de estado de entrega (✓ enviado / ✓✓ entregado / ✓✓ azul leído / ⚠ fallido) por mensaje.

---

## Fase 0 — Cumplimiento y fugas (1 semana) 🔴 — ✅ COMPLETADA

> Implementada en `utils/messaging.js` (puerta única) + `utils/metaWebhook.js` (firma).
> G1, G2, G4, G5, G6 resueltos. Frontend: badges de entrega, banner de ventana,
> envío por plantilla, estado de opt-out. 22 tests verdes. Código muerto del primer
> corte ya eliminado.

**Objetivo:** poder enviar legalmente y dejar de "simular" envíos.

### Backend
- [ ] Crear `server/utils/messaging.js` (puerta única, §3) — versión mínima: WhatsApp texto + plantilla, opt-out, ventana 24h.
- [ ] **G1**: reescribir `bulkWhatsappOpportunities` para usar la puerta única.
- [ ] **G2**: `sendMessage` y `sendFlowMessage` usan la puerta; calcular y persistir `Conversation.window24hExpiresAt` en cada entrante.
- [ ] **G5**: en los webhooks (`webhookWhatsappReceive` y `webhookReceive`) procesar el array `value.statuses[]` → actualizar `Message.deliveryStatus` + `statusTimestamps` por `externalId`; emitir `chat:message:status`.
- [ ] **G6**: middleware que valide `X-Hub-Signature-256` con `appSecret` por clínica antes de procesar el webhook.
- [ ] **G4**: añadir `Patient.marketing.{whatsappOptIn, optOutAt}`; detectar `BAJA/STOP/CANCELAR` en entrantes → set `optOutAt` + responder confirmación; excluir opt-out en la puerta única.
- [ ] Guardar `externalId` del mensaje saliente devuelto por Meta (hoy se descarta) para poder casar los `statuses`.

### Frontend
- [ ] [Chats.jsx](../client/src/pages/Chats.jsx): badges de `deliveryStatus` por mensaje; banner de "ventana de 24h cerrada" + selector de plantilla.
- [ ] [Chats.jsx]/[OpportunitiesGlobal.jsx](../client/src/pages/OpportunitiesGlobal.jsx): el botón de envío masivo muestra el resultado real (enviados/fallidos/omitidos por opt-out o ventana).
- [ ] Indicador visual de contacto en opt-out (no se puede escribir marketing).

### Pruebas
- [ ] Unit: ventana 24h (dentro/fuera), opt-out, detección de "BAJA". Webhook `statuses` actualiza estado. Firma inválida → 403.

---

## Fase 1 — Plantillas + segmentación (2-3 semanas) 🔴 — ✅ COMPLETADA

> Hecho: modelos `MessageTemplate` + `Segment` + `Campaign` + `ScheduledMessage`;
> `utils/segmentResolver.js` (con tests); rutas `/api/message-templates` (CRUD +
> `sync-whatsapp`), `/api/segments` (CRUD + `preview` + `:id/resolve`), `/api/campaigns`
> (CRUD + `cancel`), `POST /api/patients/bulk-tag`. Job `processDueScheduledMessages`
> cada 60s en index.js (idempotente, por lotes, respeta opt-out/ventana). Frontend:
> `MessageTemplates.jsx`, `Segments.jsx` (constructor con preview en vivo), `Campaigns.jsx`
> (crear/programar/cancelar + stats que refrescan) + nav. 34 tests verdes, build OK.

**Objetivo:** outbound masivo legal y segmentos reutilizables.

### Backend
- [ ] Modelo `MessageTemplate` (§2). Endpoints CRUD + `POST /api/messaging/templates/sync` (sincroniza con Graph API `/{WABA_ID}/message_templates`, trae estado de aprobación).
- [ ] Render de plantilla: sustituir variables `{{1}}..{{n}}`/`{{firstName}}` desde paciente/cita; validar que el nº de variables coincide.
- [ ] Modelo `Segment` + **resolver** `GET /api/segments/:id/resolve` que devuelve destinatarios. Reutiliza la lógica que hoy vive dispersa en `marketingController` (incompleteServices, reminders, heatmap) como filtros componibles.
- [ ] **G11**: `Patient.tags` + endpoint de etiquetado masivo (`POST /api/patients/bulk-tag`).
- [ ] Modelo `Campaign` + `POST /api/campaigns` (crear/programar) y job que procesa campañas `scheduled` (vía `ScheduledMessage`), respetando rate limit de Meta y opt-out.

### Frontend
- [ ] Nueva página **Plantillas** (en [CallCenterConfig.jsx](../client/src/pages/CallCenterConfig.jsx) o sección nueva): listar plantillas con estado de aprobación, crear borrador, botón "Sincronizar con Meta", previsualización con variables.
- [ ] Nueva página **Segmentos**: constructor de filtros (fuente, tags, estado de tratamiento, servicio/programa, días sin visita, zona, edad, género, opt-in); contador en vivo de "X pacientes coinciden"; guardar/editar.
- [ ] Nueva página/modal **Campañas**: elegir segmento + canal + plantilla, previsualizar, enviar ahora o programar; panel de resultados (targeted/sent/delivered/read/failed/replied/optedOut).
- [ ] [Patients.jsx](../client/src/pages/Patients.jsx) / [PatientDetail.jsx](../client/src/pages/PatientDetail.jsx): UI de tags y estado de opt-in.

### Pruebas
- [ ] Resolver de segmento con cada filtro. Render de plantilla con variables faltantes. Campaña programada encola `ScheduledMessage` idempotentes.

---

## Fase 2 — Motor de workflows real (3-4 semanas) 🔴

**Objetivo:** la pieza que cose todo: condiciones, esperas por evento, acciones. Resuelve G12, G13, G15.

### Backend
- [ ] Modelo `Workflow` + `WorkflowStep` + `WorkflowEnrollment` (§2). Migrar `AutoMessage`+`MessageFlow` → `Workflow` (script de migración + feature flag `WORKFLOWS_V2`).
- [ ] **Tipos de paso**: `send_message`, `send_template`, `send_email`, `wait` (minutos), `wait_until` (fecha relativa a evento: "24h antes de la cita", "día del cumpleaños"), `wait_reply` (pausa hasta que el paciente responda, con timeout), `condition` (if/else por tag, stage, campo de paciente, respuesta), `add_tag`/`remove_tag`, `assign_agent` (incl. round-robin), `move_stage`, `create_task`, `webhook`, `goal` (sale del flujo si se cumple).
- [ ] **Disparadores por evento** (`trigger.type`): `inbound_message`, `keyword`, `new_conversation`, **`appointment_created`**, **`appointment_attended`**, **`appointment_no_show`**, **`treatment_abandoned`**, **`patient_birthday`**, **`sale_created`**, `tag_added`, `segment_entered`.
- [ ] **Event bus interno** (`server/utils/events.js`, EventEmitter o colección outbox): emitir eventos desde [appointmentController](../server/controllers/appointmentController.js), [saleController](../server/controllers/saleController.js), [treatmentController](../server/controllers/treatmentController.js). Un *dispatcher* arranca los `Workflow` suscritos creando `WorkflowEnrollment`.
- [ ] **Runner** (reemplaza `executeFlowRun`/`processDueFlowRuns`): ejecuta pasos hasta encontrar wait/wait_reply/wait_until; soporta condiciones y goals. Anti-duplicado por `{workflow, patient, status:active}`.
- [ ] Job de cumpleaños (diario) que dispara `patient_birthday`.

### Frontend
- [ ] Rediseñar [AutoMessages.jsx](../client/src/pages/AutoMessages.jsx) como **editor de workflows** por nodos: selector de disparador, lista ordenable de pasos con su config (mensaje/plantilla/espera/condición/acción), validación visual, activar/pausar, contador de inscritos por paso.
- [ ] Vista de **inscripciones** (quién está en qué paso, errores) para depurar.
- [ ] Biblioteca de **plantillas de workflow** prearmadas (las de Fase 3) para "instalar con un clic".

### Pruebas
- [ ] Runner con condición true/false, wait_until, wait_reply con timeout, goal. Migración legacy→v2 conserva flujos. Anti-duplicado de inscripción.

---

## Fase 3 — Casos verticales de clínica (2-3 semanas) 🟠

**Objetivo:** alto ROI inmediato sobre el motor de Fase 2. Resuelve G14.

### Backend (workflows preconfigurados + soporte de datos)
- [ ] **Recordatorio de cita** 24h y 2h antes (trigger `appointment_created` + `wait_until`): plantilla con fecha/hora/doctor; **confirmación por respuesta** — `wait_reply` interpreta "SÍ"→`Appointment.status='confirmada'`, "NO"→`cancelada`/libera cupo + notifica recepción. Necesita mapear keywords de respuesta a acción de cita.
- [ ] **Recall de controles**: trigger `appointment_attended` + `wait_until` (p. ej. 6 meses) por tipo de servicio → recordatorio de control. Configurable por servicio (`Product.recallMonths`).
- [ ] **Reactivación de inactivos / tratamiento abandonado**: trigger `treatment_abandoned` (ya existe la lógica en [treatmentRemindersController.js](../server/controllers/treatmentRemindersController.js)) → secuencia con plantilla.
- [ ] **Post-visita**: trigger `appointment_attended` + wait corto → encuesta de satisfacción; si rating alto → `ReviewRequest` con link a Google.
- [ ] **Cumpleaños**: trigger `patient_birthday`.
- [ ] Modelo `ReviewRequest` + endpoint público de captura de rating/redirección a Google.

### Frontend
- [ ] Sección **Automatizaciones de clínica** con las plantillas anteriores listas para activar y configurar (horas de antelación, plantilla, servicios aplicables).
- [ ] En [Appointments.jsx](../client/src/pages/Appointments.jsx)/[Calendar.jsx](../client/src/pages/Calendar.jsx): indicador de "recordatorio enviado / confirmado por paciente".
- [ ] Panel de **reputación**: reseñas solicitadas, clics, ratings.
- [ ] En [Marketing.jsx](../client/src/pages/Marketing.jsx): KPIs de no-show antes/después, tasa de confirmación, reactivaciones logradas.

### Pruebas
- [ ] Recordatorio dispara a la hora correcta; "SÍ/NO" muta la cita; recall respeta `recallMonths`; post-visita solo pide reseña con rating alto.

---

## Fase 4 — Email + captación + atribución (3-4 semanas) 🟠

**Objetivo:** cerrar el círculo de ROI. Resuelve G8, G16, G21.

### Backend
- [ ] Canal **email** en la puerta única: proveedor (Resend/SendGrid/SES), `EmailTemplate`, render de variables, **tracking** (pixel de apertura + redirección de clics), manejo de bounces y `unsubscribe` (link obligatorio).
- [ ] **Link público de auto-agendamiento**: endpoint que expone disponibilidad (reusa [timeBlocks](../server/controllers/timeBlockController.js)/[rooms](../server/controllers/roomController.js)) y crea la cita → dispara workflow de confirmación. Token público por clínica/servicio.
- [ ] **Atribución**: `Patient.attribution` + `Conversation.attribution`; capturar `referral.ctwa_clid`/`ad_id` del webhook de WhatsApp (click-to-WhatsApp de anuncios Meta) y `utm_*` del link de agendamiento; reporte `GET /api/marketing/attribution` (oportunidades ganadas + ventas por campaña/origen).

### Frontend
- [ ] Editor de **plantillas de email** (drag simple o HTML) + envío de campaña por email reutilizando la página de Campañas (Fase 1).
- [ ] Página pública de **agendamiento** (responsive) y su generador de links en el panel.
- [ ] En [Marketing.jsx](../client/src/pages/Marketing.jsx): **dashboard de atribución/ROI** por campaña (origen → leads → oportunidades → ganados → ingresos), reemplazando/complementando el `patientSources` actual que es manual.

### Pruebas
- [ ] Tracking de apertura/clic; unsubscribe corta envíos; auto-agendamiento crea cita válida sin choque de horario; atribución casa ad_id→paciente→venta.

---

## Fase 5 — Productividad, reputación e IA (continuo) 🟡

**Objetivo:** llevar el call center a nivel operativo de GHL. Resuelve G19, G22.

### Backend
- [ ] `Conversation.internalNotes` + @menciones (notifican al agente mencionado).
- [ ] `AgentTask` (tareas con vencimiento) + recordatorios.
- [ ] **Round-robin / colas / SLA**: asignación automática equilibrada; `firstResponseAt`/`lastAgentReplyAt`; alertas de SLA vencido.
- [ ] Métricas: tiempo de primera respuesta, tiempo de resolución, por agente.
- [ ] **IA conversacional** (Claude, modelo `claude-opus-4-8` o `claude-haiku-4-5` para coste): paso de workflow `ai_reply` (auto-respuesta de primer contacto / calificación de lead) y "sugerir respuesta" al agente; resumen de conversación. Verificar siempre la guía de la API antes de implementar.

### Frontend
- [ ] [Chats.jsx](../client/src/pages/Chats.jsx): panel de notas internas, tareas, indicador de SLA, botón "sugerir respuesta (IA)".
- [ ] Dashboard de supervisión del call center (tiempos de respuesta, carga por agente, SLA) — ampliar `getStats`.

---

## Transversal (hacer en cuanto duela)

### Backend
- [ ] **G17**: migrar media (galería + `Message.mediaUrl`) a almacenamiento de objetos (S3/R2/local con servir por URL); guardar `mediaStorageKey`. Descargar media entrante de WhatsApp (`media id` → Graph API) y persistirla.
- [ ] **G18**: cifrar tokens en `CallCenterConfig` (AES con clave de entorno); enmascarar al devolver al cliente.
- [ ] **G20**: migrar el `setInterval` de [index.js:101](../server/index.js#L101) a cola de jobs (BullMQ + Redis o Agenda) con locking → soporta múltiples instancias sin duplicar.
- [ ] Rate limiting por clínica para outbound (respeta tiers de Meta).

### Frontend
- [ ] Estados de carga/spinners en envíos largos; manejo de errores de la puerta única (mostrar `reason`).

---

## 4. Orden recomendado y dependencias

```
Fase 0 (cumplimiento) ──► Fase 1 (plantillas+segmentos) ──► Fase 2 (workflows) ──► Fase 3 (clínica)
                                                                  └──► Fase 4 (email+captación+atribución)
                                                                  └──► Fase 5 (productividad+IA)
Transversal: en paralelo, atacar G17/G18 antes de escalar volumen; G20 antes de multi-instancia.
```

- **Fase 0 es bloqueante**: sin ella cualquier campaña falla o es ilegal.
- **Fase 2 es el corazón**: las Fases 3-5 son en gran parte *configuración* sobre ese motor.
- Cada fase: commit por entrega, `node --check` limpio en backend, `npm run build` (Vite) verde en frontend, y pruebas de la fase.

## 5. Referencia: tipos de paso de Workflow (Fase 2)

| Tipo | Config | Efecto |
|------|--------|--------|
| `send_message` | `body` | Texto libre (solo dentro de ventana 24h en WA) |
| `send_template` | `template, vars` | Plantilla aprobada (fuera de ventana) |
| `send_email` | `emailTemplate, vars` | Email con tracking |
| `wait` | `minutes` | Pausa relativa |
| `wait_until` | `event, offset` | Pausa hasta fecha (cita, cumpleaños) |
| `wait_reply` | `timeoutMinutes, branches` | Pausa hasta respuesta del paciente |
| `condition` | `field, op, value, thenIdx, elseIdx` | Bifurca el flujo |
| `add_tag`/`remove_tag` | `tag` | Etiqueta paciente |
| `assign_agent` | `mode(roundrobin|user), user?` | Asigna conversación |
| `move_stage` | `stage` | Mueve oportunidad en Kanban |
| `create_task` | `title, dueOffset, assignTo` | Crea `AgentTask` |
| `webhook` | `url, method, payload` | Integración externa |
| `goal` | `condition` | Termina la inscripción si se cumple |
