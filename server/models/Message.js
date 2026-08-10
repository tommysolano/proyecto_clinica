const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },
    // 'message' = mensaje real (entrante/saliente por WhatsApp). 'event' = marca
    // INTERNA del sistema que se muestra dentro del hilo SOLO para el equipo y
    // NUNCA se envía al contacto (p.ej. "Oportunidad creada"). Se renderiza como
    // un chip centrado, no como burbuja. Igual que en Daplox.
    kind: { type: String, enum: ['message', 'event'], default: 'message', index: true },
    // Tipo del evento interno (cuando kind='event'): 'opportunity_created', …
    eventType: { type: String, trim: true, default: '' },
    // Los eventos no tienen dirección (no salen ni entran por WhatsApp): la
    // dirección solo es obligatoria para los mensajes reales.
    direction: {
      type: String,
      enum: ['in', 'out'],
      required: function () {
        return this.kind !== 'event';
      },
    },
    body: { type: String, trim: true },
    mediaUrl: { type: String, trim: true },
    // 'sticker' es un webp de WhatsApp: se guarda con su tipo propio para poder
    // pintarlo pequeño y transparente (no como una imagen normal en una burbuja).
    mediaType: { type: String, enum: ['image', 'audio', 'video', 'document', 'sticker', null], default: null },
    // Nombre original del archivo adjunto (documentos): "REPORTE DE PLASMA.xlsx".
    // Permite mostrar la tarjeta de documento igual que WhatsApp en vez de un
    // genérico "Ver adjunto".
    mediaName: { type: String, trim: true, default: '' },
    // Tamaño del adjunto en bytes (si el proveedor lo informa) para la tarjeta.
    mediaSize: { type: Number, default: 0 },
    // Identificador del archivo EN EL PROVEEDOR (media id de Meta). Permite volver
    // a pedirle el archivo si la primera descarga falló, sin esperar a que el
    // contacto lo reenvíe. En números QR no aplica: allí basta el `externalId` del
    // propio mensaje para volver a bajarlo desde la sesión de WhatsApp Web.
    mediaExternalId: { type: String, trim: true, default: '' },
    // Cómo llegó/salió el mensaje. 'phone' marca los enviados desde el teléfono
    // (número QR) fuera de nuestro sistema, para distinguirlos en la burbuja.
    origin: { type: String, enum: ['system', 'phone', ''], default: '' },
    // Número (global) por el que ENTRÓ/salió este mensaje. En los ENTRANTES es el
    // número al que el contacto escribió: sirve para responder por el mismo número
    // aunque la conversación no tenga enlazada la cuenta (auto-cura la ruta).
    whatsappAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsappAccount', default: null },
    // Identificadores externos (WhatsApp message id)
    externalId: { type: String, index: true },
    // Respuesta interactiva (botón o lista de WhatsApp): id + título del elemento
    // elegido. El id permite etiquetar interés (CRO) sin depender del texto visible.
    interactiveReply: {
      id: { type: String, trim: true, default: '' },
      title: { type: String, trim: true, default: '' },
      type: { type: String, enum: ['button_reply', 'list_reply', ''], default: '' },
    },
    // Snapshot de los botones enviados por un nodo de workflow. Permite que la
    // bandeja muestre exactamente las opciones que recibió el contacto.
    buttons: {
      type: [
        new mongoose.Schema(
          {
            id: { type: String, trim: true, default: '' },
            type: { type: String, enum: ['quick_reply', 'url', 'phone'], default: 'quick_reply' },
            text: { type: String, trim: true, default: '' },
            url: { type: String, trim: true, default: '' },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    templateName: { type: String, trim: true, default: '' },
    // Facturación TAL COMO LA INFORMA META en el webhook de estado (`statuses[].pricing`).
    // No es un cálculo nuestro: es la categoría con la que Meta cobró ESTE mensaje
    // y si lo consideró cobrable. Permite auditar el gasto por plantilla; el dinero
    // se consulta aparte a Meta (ver utils/whatsappSpend.js).
    billing: {
      billable: { type: Boolean, default: null },
      // marketing | utility | authentication | service | referral_conversion…
      category: { type: String, trim: true, default: '' },
      // regular | free_customer_service | free_entry_point
      type: { type: String, trim: true, default: '' },
      model: { type: String, trim: true, default: '' }, // PMP (por mensaje) | CBP (por conversación)
    },
    // Anuncio click-to-WhatsApp del que nació ESTE mensaje (solo entrantes, y solo
    // en el primer mensaje tras tocar el anuncio). Snapshot para pintar en el chat
    // "de qué anuncio nos escriben" (headline + link), como en la captura de Daplox.
    referral: {
      sourceId: { type: String, trim: true, default: '' }, // = referral.source_id (Ad ID)
      sourceType: { type: String, trim: true, default: '' }, // ad | post
      sourceUrl: { type: String, trim: true, default: '' }, // enlace fb.me/…
      headline: { type: String, trim: true, default: '' },
      body: { type: String, trim: true, default: '' },
      ctwaClid: { type: String, trim: true, default: '' },
    },
    // Respuesta a un mensaje específico (cita estilo WhatsApp). Snapshot para
    // renderizar la burbuja citada sin populate; `message` apunta al original
    // para poder saltar a él; `externalId` es el wamid que se manda a WhatsApp
    // como `context` para que el contacto también vea la cita.
    replyTo: {
      message: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
      externalId: { type: String, trim: true, default: '' },
      direction: { type: String, enum: ['in', 'out', ''], default: '' },
      senderName: { type: String, trim: true, default: '' },
      body: { type: String, trim: true, default: '' },
      mediaType: { type: String, trim: true, default: '' },
    },
    // Resultado REAL de la cita en WhatsApp (solo salientes con replyTo):
    // 'quoted_by_id' | 'quoted_by_text' | 'failed:<motivo>'. Vacío si no aplica.
    // Permite auditar sin acceso a los logs del servidor por qué una respuesta
    // llegó (o no) citada al destinatario.
    quoteResult: { type: String, trim: true, default: '' },
    errorCode: { type: String, trim: true, default: '' },
    errorMessage: { type: String, trim: true, default: '' },
    statusTimestamps: {
      sentAt: { type: Date },
      deliveredAt: { type: Date },
      readAt: { type: Date },
      failedAt: { type: Date },
    },
    mediaStorageKey: { type: String, trim: true, default: '' },
    // Estado: enviado, entregado, leído (para mensajes salientes)
    deliveryStatus: {
      type: String,
      enum: ['queued', 'sent', 'delivered', 'read', 'failed'],
      default: 'sent',
    },
    // Identificador que genera el NAVEGADOR para un envío concreto. Es la llave
    // de idempotencia: si la misma petición llega dos veces (doble clic del
    // agente, reintento del navegador, red inestable), el segundo intento
    // reconoce el mensaje ya creado en vez de mandarlo otra vez. Sin esto, un
    // video lento por QR se enviaba al paciente tantas veces como clics diera el
    // agente esperando a que "pasara algo".
    clientId: { type: String, trim: true, default: '' },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    sentByName: { type: String, trim: true },
    isAutoReply: { type: Boolean, default: false },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

messageSchema.index({ conversation: 1, createdAt: 1 });
// Idempotencia del envío: `clientId` es único DENTRO de la conversación. Parcial
// para no indexar los millones de mensajes que no lo llevan (entrantes, envíos
// automáticos, todo lo anterior a esta mejora).
messageSchema.index(
  { conversation: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: 'string', $gt: '' } } }
);

module.exports = mongoose.model('Message', messageSchema);
