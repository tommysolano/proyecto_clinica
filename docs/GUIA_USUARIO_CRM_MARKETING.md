# Guía de usuario — CRM de Call Center y Marketing

> Esta guía explica, **paso a paso y campo por campo**, todo lo que el sistema ofrece para atender
> pacientes por WhatsApp/redes, convertir conversaciones en citas y ventas, automatizar mensajes,
> enviar campañas, pedir reseñas y medir resultados. Para **cada página** encontrarás **qué ves en
> pantalla**, **qué botón pulsar**, **qué modal se abre**, **qué campos llenar y con qué información**.
> Está pensada para el equipo de **recepción / call center**, **marketing** y **administración**.
>
> Idea clave: el módulo es el **centro de contacto** de la clínica. Un solo lugar para **hablar con
> los pacientes**, **clasificarlos**, **agendarlos**, **cotizarles** y **hacerles marketing medible**.
> Tu trabajo es **conectar bien los canales al inicio**, **atender los chats**, **etiquetar de forma
> ordenada** y dejar que las **automatizaciones y campañas** trabajen por ti, siempre respetando las
> reglas de WhatsApp y los permisos de cada paciente.

---

## Cómo leer esta guía

Cada página se documenta con esta estructura:

- **Para qué sirve** — el objetivo de la página.
- **La pantalla** — qué botones, pestañas, filtros y columnas verás.
- **Paso a paso** — la secuencia exacta de clics.
- **Campos del formulario/modal** — cada campo, si es **obligatorio (\*)**, y **qué escribir**.
- **Acciones por fila / por tarjeta** — los botones de cada elemento de la lista.

Convenciones de iconos y elementos comunes en todo el módulo:

| Icono / elemento | Significado |
|---|---|
| ✏️ (lápiz) | Editar el registro |
| 🗑️ (bote) | Eliminar |
| ⭐ (estrella) | Destacar / quitar destacado de un chat |
| 🖼 | Abrir la galería de imágenes (enviar foto) |
| 📄 (documento) | Insertar / elegir una **plantilla aprobada** |
| **/** | Insertar un **mensaje guardado** (respuesta rápida) |
| **IA** (✦) | Pedir a la Inteligencia Artificial que sugiera/resuma |
| **+** | Agregar (paso, oportunidad, cita, ítem, etiqueta…) |
| Interruptor **Activo/Inactivo** | Encender o apagar un canal, campaña, automatización |
| Chips verdes | Etiquetas (escribe y pulsa **Enter**; la ✕ las quita) |

> En casi todos los formularios, los campos con **\*** son obligatorios. Si intentas guardar sin
> llenarlos, el sistema **no te deja** y te avisa con un mensaje.

---

## 1. ¿Qué es este módulo y para quién es?

Es el "centro de contacto" de la clínica: un solo lugar para **hablar con los pacientes**,
**convertir conversaciones en citas y ventas**, y **hacer marketing** medible.

Lo usan tres perfiles (cada uno ve solo lo que le corresponde):

| Perfil | Para qué entra |
|---|---|
| **Call Center / Recepción** | Atender chats, agendar citas, cotizar, crear oportunidades, gestionar tareas. |
| **Marketing** | Todo lo del call center + campañas, segmentos, automatizaciones, plantillas, reputación, analítica y supervisión. |
| **Administrador** | Todo lo anterior + configuración de canales, IA y permisos. |

Todo el módulo vive en el **menú lateral izquierdo**. Más abajo se explica para qué sirve cada
opción del menú y cómo se usa por dentro.

---

## 2. Conceptos clave (glosario rápido)

Entender estas palabras hace que todo lo demás sea fácil:

- **Conversación / Chat:** un hilo de mensajes con un contacto (por WhatsApp, Instagram, etc.).
- **Contacto vs. Paciente:** el **contacto** es el número/nombre con el que chateas; el **paciente**
  es su ficha en el sistema. Un chat puede empezar **sin** paciente y luego **vincularse** a uno
  (botón *Agregar al sistema*).
- **Oportunidad:** una posible venta dentro de un chat (ej. "interesada en blanqueamiento"). Se mueve
  por etapas (**Nuevo → Contactado → Interesado → Agendado → Ganado / Perdido**). Un mismo chat puede
  tener **varias** oportunidades.
- **Etapa (del embudo):** el estado de una oportunidad. Cada etapa tiene su color en el sistema.
- **Etiqueta (tag):** una palabra para clasificar (ej. *vip*, *ortodoncia*, *reactivación*). Puedes
  ponerlas al **contacto del chat**, a una **oportunidad** y al **paciente**. Sirven para segmentar y
  para disparar automatizaciones.
- **Plantilla:** un mensaje pre-aprobado y reutilizable. Las de **WhatsApp** las aprueba Meta; las de
  **Email** quedan listas al instante. Pueden llevar **cabecera (imagen/texto/documento), botones y pie**.
- **Segmento:** una "lista inteligente" de pacientes que cumplen ciertos filtros (ej. "mujeres, sin
  visita hace 6 meses, con consentimiento"). Se **recalcula sola** cada vez que la usas.
- **Campaña:** un envío masivo (ahora o programado) a un segmento, por WhatsApp o Email.
- **Automatización (Workflow):** una secuencia de pasos que se dispara sola ante un evento (ej. "cuando
  se agenda una cita → 24h antes manda un recordatorio y pide confirmación").
- **Inscripción (enrollment):** cada paciente que "entró" a una automatización y va avanzando por sus pasos.
- **Disparador (trigger):** el evento que inicia una automatización (cita, cumpleaños, palabra clave…).
- **Ventana de 24 horas (WhatsApp):** regla de WhatsApp. Solo puedes mandar **texto libre** si el
  paciente te escribió en las últimas 24h. Pasado ese tiempo, **solo una plantilla aprobada**.
- **Opt-out / Baja:** cuando un paciente pide no recibir más mensajes (escribe "BAJA", "STOP", etc., o
  se da de baja del email). El sistema lo respeta automáticamente y no le vuelve a escribir marketing.
- **Opt-in / Consentimiento:** el permiso del paciente para recibir mensajes por WhatsApp o Email.
- **SLA / Primera respuesta:** el tiempo objetivo para responder. El **Tablero de supervisión** marca
  en rojo lo que supera el umbral (por defecto 60 min).
- **Atribución:** de dónde vino cada paciente (anuncio, referido, etc.) y cuánto dinero generó.

---

## 3. Mapa del sistema: "quiero hacer X, ¿a dónde voy?"

| Quiero… | Página del menú |
|---|---|
| Conectar WhatsApp / Email / Instagram / Messenger / TikTok | **Configuración Call Center** |
| Conectar la **Inteligencia Artificial** (sugerencias/resúmenes) | **Configuración Call Center → Inteligencia Artificial** |
| Configurar las **reseñas de Google** (URL y umbral) | **Configuración Call Center → Reputación** |
| Atender mensajes de pacientes | **Chats / WhatsApp** |
| Supervisar a los agentes (carga, SLA, embudo) | **Chats → pestaña Supervisión** |
| Ver todas las oportunidades de venta juntas y mandar un masivo | **Oportunidades** |
| Recordar llamar a alguien / pendientes del equipo | **Tareas** |
| Crear mensajes reutilizables / aprobados (WhatsApp y Email) | **Plantillas de mensaje** |
| Flujos sencillos por palabra clave en el chat (versión anterior) | **Mensajes automáticos (legacy)** |
| Armar una lista de pacientes para una campaña | **Segmentos** |
| Enviar un mensaje masivo (ahora o programado) | **Campañas** |
| Que el sistema mande mensajes solo (recordatorios, reseñas, etc.) | **Automatizaciones** |
| Que los pacientes agenden solos por un link | **Auto-agendamiento** |
| Pedir y medir reseñas de Google | **Reputación** |
| Saber qué anuncio/origen trae pacientes y ventas | **Atribución / ROI** |
| Ver tableros de tratamientos, zonas, predicciones y citas | **Marketing** |
| Ver gráficos de chats, citas y oportunidades | **Analíticas** |
| Reportes de atención por doctor y adherencia del paciente | **Reportes de atención** |

---

## 4. Antes de empezar: configuración inicial (una sola vez)

Para que todo funcione, el **administrador/marketing** debe dejar listo esto al inicio, **en este orden**:

1. **Configuración Call Center → canales** — conecta al menos **WhatsApp** (y, si los usas, Messenger,
   Instagram, TikTok, Email). Pega las credenciales del proveedor (Meta / Resend), copia la **URL del
   webhook** en su panel y **activa** el canal.
2. **Configuración Call Center → Inteligencia Artificial** — (opcional pero recomendado) pega tu **API
   Key de Anthropic (Claude)** para habilitar **sugerencias de respuesta** y **resúmenes** en el chat,
   y el paso *Responder con IA* de las automatizaciones.
3. **Configuración Call Center → Reputación** — pega tu **URL de reseñas de Google** y el **umbral**.
4. **Plantillas de mensaje** — crea (o sincroniza desde Meta) tus **plantillas de WhatsApp** para poder
   escribir fuera de la ventana de 24h, y tus **plantillas de Email**.
5. **Segmentos** — define tus listas más usadas (ej. *Inactivos 6 meses con opt-in*).
6. **Automatizaciones** — instala los **presets de clínica** (recordatorio de cita, recall, reactivación,
   cumpleaños, post-visita), revísalos y actívalos.
7. **Auto-agendamiento** — si quieres que los pacientes reserven solos, configura horario/servicios y
   comparte el **link**.

> Consejo: dedica un rato a **etiquetar de forma consistente** desde el inicio (pocos nombres y claros).
> Tus segmentos y automatizaciones por etiqueta serán mucho más útiles.

---

# 5. Guía página por página

## Grupo: Configuración

### 5.1 Configuración Call Center — *empieza aquí*

**Para qué sirve:** conectar los canales por los que la clínica se comunica, la **Inteligencia
Artificial** y la **reputación**. **Es el primer paso**: sin canales conectados, los chats funcionan
en modo prueba (usa **Simular entrante** para practicar).

**La pantalla:** un **título**, una **fila de pestañas** (una por canal) y, debajo, el **panel de
configuración** del canal elegido. Al final hay un panel de **Reputación** y una tarjeta de **Notas
importantes**. Cada pestaña muestra un ✓ verde si el canal está **activo** o una ✕ gris si está inactivo.

**Pestañas (canales):** **WhatsApp**, **Messenger**, **Instagram**, **TikTok**, **Email** e
**Inteligencia Artificial**.

**Paso a paso (cualquier canal):**
1. Pulsa la **pestaña** del canal (ej. *WhatsApp*).
2. Si el canal lo requiere, verás un recuadro **"URL del webhook"**: pulsa **Copiar** y pégala en el
   panel del proveedor (Meta / TikTok).
3. Llena los **campos de credenciales** (ver abajo) y pulsa **Guardar cambios**.
4. Pulsa **Probar conexión** para verificar que las credenciales funcionan.
5. Enciende el **interruptor Activo/Inactivo** (arriba a la derecha del panel). Al activarlo, los
   mensajes entrantes empiezan a caer en la bandeja de **Chats**.

**Campos por canal (los marcados como sensibles se guardan cifrados):**
- **WhatsApp:** *Phone Number ID*, *WhatsApp Business Account ID (WABA ID)*, *Access Token (long-lived)*
  🔒, *Verify Token* 🔒 (lo defines tú y debe coincidir en Meta), *App Secret* 🔒, *Teléfono visible*
  (formato E.164, ej. `+593987654321`).

> **Para usar las llamadas de voz** (botón 📞 en el chat) hay que hacer **dos cosas en el panel de Meta**,
> una sola vez por número:
> 1. En el webhook de WhatsApp, **suscribir el campo `calls`** (además de `messages`). Sin esta
>    suscripción no llegan ni las llamadas entrantes ni la respuesta a las salientes.
> 2. **Habilitar las llamadas** en el número. Meta las ofrece por país y tipo de cuenta, y **no están
>    disponibles en todas partes ni en los números de prueba**: si tu número no las soporta, el botón
>    📞 del chat aparecerá deshabilitado indicándolo.
>
> Recuerda que esto **solo aplica a números Cloud API**: los conectados por QR nunca podrán llamar.

- **Messenger:** *Page ID*, *Page Access Token* 🔒, *Verify Token* 🔒, *App Secret* 🔒.
- **Instagram:** *Instagram Business Account ID*, *Page ID* de la página de FB vinculada, *Page Access
  Token* 🔒, *Verify Token* 🔒, *App Secret* 🔒.
- **TikTok:** *App ID*, *App Secret* 🔒, *Access Token* 🔒, *Business ID*, *Verify Token* 🔒.
- **Email (Resend):** *API Key de Resend* 🔒, *Email remitente* (verificado en Resend), *Nombre
  remitente*, *Responder a* (opcional).

**Pestaña Inteligencia Artificial:** aquí conectas la IA que usa el sistema para **sugerir respuestas**
y **resumir conversaciones** en los chats, y para el paso *Responder con IA* de las automatizaciones.
1. Pega tu **API Key de Anthropic (Claude)** 🔒 — se guarda **cifrada**.
2. (Opcional) Indica el **Modelo**; si lo dejas vacío usa el predeterminado (`claude-opus-4-8`).
3. Pulsa **Guardar cambios** y luego **Probar conexión**.
4. Enciende el interruptor **Activo**.
> Si no configuras la IA aquí, el sistema puede usar una clave puesta por el técnico en el servidor; y
> si no hay ninguna, los botones de IA simplemente avisan que no está disponible (el resto sigue normal).

**Panel "Reputación (reseñas)" (al final de la página):**
- **URL de reseñas de Google** — el enlace "Escribir una reseña" de tu ficha de Google Business
  (`https://g.page/r/...`).
- **Calificación mínima para reseña pública** — *3, 4 o 5 estrellas o más* (por defecto 4). A los
  pacientes que califican **por encima** de este valor se les **redirige a dejar la reseña en Google**;
  a los que califican **por debajo**, se les captura el **comentario en privado** (no se hace público).
- Pulsa **Guardar reputación**.

**Tips:**
- Los campos sensibles se muestran enmascarados (•••• + últimos 4) una vez guardados. Para reemplazar
  un valor, simplemente **escribe encima**.
- El **Verify Token** lo eliges tú: debe ser **idéntico** aquí y en el panel del proveedor.
- WhatsApp/Messenger/Instagram usan **Meta for Developers**; TikTok requiere una app aprobada en TikTok
  Developers.

---

### 5.2 Auto-agendamiento — *que el paciente reserve solo*

**Para qué sirve:** generar un **link público** para que los pacientes elijan día y hora sin llamar.
Cuando alguien reserva, el sistema **crea/vincula al paciente y la cita** y dispara la automatización de
confirmación (si la tienes activa).

**La pantalla:** título con un interruptor **Activo**; una tarjeta con el **link público** (copiar y
regenerar); y una tarjeta de **configuración** (días, horarios, servicios y mensaje). Botón **Guardar**.

**Paso a paso:**
1. Enciende el interruptor **Activo** (si está apagado, el link no funciona y se avisa en ámbar).
2. Copia el **link** (`…/book/su-token`) con el botón **Copiar** y compártelo (bio de Instagram,
   anuncios, firma de email…). El botón **↻ (regenerar)** crea un link nuevo e **invalida el anterior**
   (pide confirmación).
3. Configura los campos y pulsa **Guardar**.

**Campos de configuración:**
- **Días laborables** — chips *Lun…Dom*; marca en cuáles se puede reservar.
- **Desde / Hasta** — hora de inicio y fin del horario reservable.
- **Duración slot (min)** — cada cuántos minutos hay un turno (ej. 30).
- **Citas por slot** — cuántas personas caben en el mismo turno (capacidad por hora).
- **Reservable hasta (días adelante)** — con cuánta anticipación máxima puede reservar el paciente.
- **Servicios reservables** — elige del desplegable **"Añadir servicio…"** y pulsa **Añadir**. Por cada
  servicio puedes ajustar su **duración en minutos** y quitarlo con 🗑️. *(Necesitas al menos uno para
  poder reservar.)*
- **Mensaje de confirmación** — el texto que se muestra/envía al confirmar la reserva.

---

## Grupo: Atención (Call Center)

### 5.3 Chats / WhatsApp — *el corazón del call center*

**Para qué sirve:** atender en un solo lugar todos los mensajes entrantes y salientes (WhatsApp,
Instagram, etc.), y desde ahí **crear pacientes, oportunidades, citas y cotizaciones**.

**La pantalla:** un **encabezado** con los botones **Simular entrante** y **Nuevo chat**; una fila de
**pestañas**; y, debajo, una vista de **3 columnas** (lista de chats · conversación · panel de contexto).

**Pestañas de la bandeja:**
- **Todos** — todas las conversaciones.
- **No leídos** — solo las que tienen mensajes sin leer.
- **Mis chats** — las que tienes asignadas.
- **Destacados** — las marcadas con ⭐ (con contador).
- **Oportunidades** — las que tienen una oportunidad abierta.
- **Supervisión** — *(solo admin y marketing)* el **tablero del supervisor** (ver más abajo).

**Botones del encabezado:**
- **Simular entrante** — abre un modal para **fingir un mensaje entrante** (útil para practicar sin
  WhatsApp real). Pide **Teléfono**, **Nombre del contacto** (opcional) y el **Mensaje** simulado.
- **Nuevo chat** — abre un modal para iniciar una conversación: **Teléfono \*** y **Nombre del contacto**
  (opcional). Crea la conversación y la deja seleccionada.

#### Columna izquierda — Lista de conversaciones
- **Buscador** por nombre o teléfono y un botón **↻** para recargar.
- Cada fila muestra: **avatar** con iniciales, **nombre/teléfono**, **hora** del último mensaje,
  **vista previa** del último mensaje (con "Tú:" si fue saliente), **contador de no leídos** (burbuja
  verde), la **etapa de la oportunidad** (chip de color), una etiqueta roja **Opt-out** si aplica, el
  **agente asignado** ("→ Nombre") y la **estrella** ⭐ para destacar/quitar destacado.

#### Columna central — La conversación
**Cabecera del chat:** avatar, nombre del contacto, una etiqueta roja **"Esperando respuesta"** si el
último mensaje es del paciente, e indicadores de *Paciente vinculado* y *Agente*. Botones:
- **📞 Llamar** — llama al contacto **por WhatsApp** (ver *Llamadas de voz* más abajo). Si el botón está
  gris, pasa el cursor por encima: te dirá el motivo (número conectado por QR, o llamadas no habilitadas
  en Meta).
- **Tomar** — te asignas la conversación (aparece si no es tuya).
- **Auto-asignar** — *(solo admin/marketing)* la reparte al **agente con menos chats abiertos**
  (round-robin).
- **Crear/Editar oportunidad** — abre el modal de oportunidades.
- **Crear cita** — *(solo si el contacto ya es paciente)* abre el modal de citas.
- **Cotización** — abre el modal de cotización.
- **⭐** — destacar / quitar destacado.

**Mensajes:** cada burbuja muestra el texto y, si el mensaje trae **imagen, audio o documento**, se ve
**dentro del chat** (la imagen se muestra, el audio se reproduce, el documento es un enlace de descarga).
Los mensajes **salientes** muestran quién lo envió, la hora y su **estado de entrega**: *en cola*,
*enviado*, *entregado*, *leído* (en azul) o *fallido* (⚠, con el motivo al pasar el cursor).

**Avisos sobre la caja de escritura:**
- **Contacto bloqueado** — recuadro rojo; desbloquéalo desde el panel derecho para poder escribir.
- **Contacto en opt-out** — recuadro rojo; no se enviarán mensajes de marketing.
- **Ventana de 24h cerrada** — recuadro ámbar: solo puedes enviar una **plantilla aprobada** (pulsa el
  botón **Plantilla**).

**Caja de escritura (de izquierda a derecha):**
- **🖼 Galería** — abre la galería para **enviar una imagen** (con pie de foto opcional).
- **🎤 Micrófono** — graba una **nota de voz**, igual que en WhatsApp. Pulsa el micrófono, habla (verás el
  cronómetro en rojo) y pulsa **✓** para adjuntarla o **🗑** para descartarla. Antes de enviarla puedes
  **escucharla** en el reproductor que aparece sobre el cuadro. Una nota de voz **se envía sola, sin
  texto** (WhatsApp no permite ponerle pie): si tenías algo escrito, se queda en el cuadro para que lo
  mandes aparte. La primera vez el navegador te pedirá **permiso para el micrófono**.
- **📄 Plantilla** — abre el buscador de **plantillas aprobadas por Meta**. Al elegir una, se muestra un
  recuadro con su **vista previa** y un campo de **Variables** (separadas por coma) para rellenarla.
  Funciona **siempre** (dentro o fuera de la ventana de 24h). El botón **Quitar** la deselecciona.
- **/ Mensajes guardados** — abre el menú de atajos para insertar una respuesta rápida. También puedes
  escribir **`/`** directamente en el cuadro de texto. Los mensajes se crean y editan en
  **Marketing & CRM → Mensajes Guardados** (con emojis, formato, carpetas y adjuntos de imagen/video).
- **Cuadro de texto** — escribe y pulsa **Enter** para enviar (**Shift+Enter** = salto de línea). Se
  deshabilita si el contacto está bloqueado/opt-out, si la ventana de 24h está cerrada, si tienes una
  plantilla seleccionada o si has adjuntado una nota de voz.
  **Pegar imágenes:** copia una imagen (una captura de pantalla, o *clic derecho → copiar imagen*) y
  pulsa **Ctrl+V** dentro del cuadro, igual que en WhatsApp Web: se adjunta sola y lo que escribas será
  su **pie de foto**. Las imágenes muy grandes se reducen automáticamente para que puedan enviarse.
- **IA** — pide al asistente una **sugerencia de respuesta** (la rellena en el cuadro para que la edites
  antes de enviar). Requiere la IA configurada.
- **Enviar** — manda el mensaje (texto libre o la plantilla seleccionada).

#### Llamadas de voz por WhatsApp
Desde la cabecera del chat puedes **llamar al contacto** y **recibir sus llamadas**, sin salir del CRM.

- **Llamar:** pulsa **📞 Llamar**. Se abre un panel abajo a la derecha con el estado (*Llamando…* y luego
  el cronómetro). Puedes **silenciar** el micrófono o **colgar**. El panel **no bloquea la pantalla**: sigue
  navegando por el CRM (abrir la ficha, agendar) mientras hablas.
- **Recibir:** cuando un contacto llama, el panel aparece sonando con **Contestar** / **Rechazar** —
  aunque estés mirando otro chat. Al contestar, si la conversación no tenía agente, **te la asignas**.
- **Historial:** toda llamada queda registrada (entrante/saliente, agente, duración, y si fue *perdida*,
  *rechazada* o *fallida*).

> **Requisitos.** Las llamadas solo funcionan en números conectados por **Cloud API**: un número
> vinculado por **QR** no puede llamar ni recibir llamadas (WhatsApp Web no lo permite), y en esos chats
> el botón aparece deshabilitado. Además Meta debe tener las **llamadas habilitadas** en el número, y
> las ofrece por país/cuenta: si no está disponible, el botón lo indica. El navegador pedirá **permiso
> de micrófono** y la página debe abrirse por **https**.

#### Columna derecha — Panel de contexto
Secciones, de arriba a abajo:
- **Contacto:** nombre y teléfono. Si **no** es paciente, botón **+ Agregar al sistema** (abre el modal
  de registro). Botones **Agendar cita(s)** (requiere paciente) y **Crear cotización y enviar**.
- **Oportunidad:** la etapa actual (chip de color), el **valor esperado**, los **servicios de interés**,
  las **etiquetas** de la oportunidad y las **notas**. Enlace **Crear/Editar** para abrir el modal.
- **Etiquetas:** clasifica el **contacto/conversación** con chips (escribe y pulsa **Enter**; la ✕ las
  quita). Se guardan solas y sirven para segmentar.
- **Resumen IA:** botón **Generar/Regenerar** para que la IA **resuma la conversación** en pocas líneas
  (ideal al retomar un chat largo).
- **Notas internas:** comentarios **solo para el equipo** (no los ve el paciente). Puedes **@mencionar**
  a un compañero escribiendo `@` y eligiéndolo de la lista; le llega la mención. Botón **Agregar nota**.
- **Tareas:** crea recordatorios ligados a este chat. Campos: **título**, **fecha/hora de vencimiento**
  y **asignar a** (a ti o a otro agente). Marca la casilla para completarlas.
- **Destacado:** si el chat está destacado, muestra su nota.
- **Citas del paciente:** *(si hay paciente)* el número de citas y un listado con fecha, hora y estado.
- **Detalles:** **Canal**, **Estado**, **fecha de creación** y el botón **Bloquear / Desbloquear
  contacto** (pide confirmación; al bloquear, no se le puede escribir).

#### Modales que se abren desde el chat

**Agregar paciente al sistema** (*+ Agregar al sistema*):
- **Nombres \*** y **Apellidos \*** — se pre-rellenan con el nombre del contacto.
- **Cédula** (opcional).
- **Género \*** — Masculino / Femenino / Otro.
- Muestra el **teléfono** del contacto. Pulsa **Agregar paciente** y el chat queda **vinculado**.

**Oportunidades** (*Crear/Editar oportunidad*): soporta **varias oportunidades por chat**. Por cada una:
- **Etapa** — botones *Nuevo / Contactado / Interesado / Agendado / Ganado / Perdido*.
- **Servicios de interés** — buscador para añadir servicios; abajo se calcula el **valor esperado**
  (desde el precio de inventario de cada servicio).
- **Etiquetas** — chips propios de la oportunidad (ej. *presupuesto enviado*).
- **Notas**.
- **Motivo (perdido)** — aparece solo si la etapa es *Perdido*.
- Botón **+ Agregar otra oportunidad** y, por cada una, **Quitar**. Guarda con **Guardar**.

**Agendar cita(s) desde chat** (*Crear cita* / *Agendar cita(s)*): permite crear **varias citas** a la
vez. Si manejas varias sucursales, primero eliges la **Clínica**. Por cada cita:
- **Fecha \*** y **Hora \***.
- **Motivo** (opcional).
- **Servicios \*** — buscador para añadir uno o más (obligatorio).
- Debajo, un **panel de disponibilidad** que te muestra si hay cupo en ese día/hora.
- Botón **+ Agregar otra cita**. Pulsa **Crear cita** (o **Crear N citas**).

**Crear cotización y enviar al chat** (*Cotización*):
- **Agregar producto/servicio** — buscador; cada ítem entra con su **precio**.
- Tabla de ítems con **Cantidad**, **Precio unitario** y **Descuento %** editables (y 🗑️ para quitar).
- Abajo se ven **Subtotal, Descuento y Total** en vivo.
- **Válida hasta** (fecha) y **Notas** (opcional).
- Pulsa **Crear y enviar al chat**: genera la cotización y **manda un mensaje con el enlace al PDF** en
  el propio chat.

**Mensajes guardados** (se configuran en **Marketing & CRM → Mensajes Guardados**):
- Crea fragmentos con **Nombre**, **Atajo** (ej. `saludo`), **Carpeta**, **Cuerpo** (con emojis, *negrita*,
  viñetas y variables como `{{nombre}}`) y un **adjunto** opcional (imagen o video, subido o por URL).
- La página incluye **vista previa** tipo teléfono y un **envío de prueba** a cualquier número.
- Luego, en el chat, escribe **`/saludo`** para insertarlos al instante: las variables se rellenan con los
  datos del contacto y el adjunto se envía junto al texto.

**Galería de imágenes** (botón **🖼**):
- **+ Subir nueva imagen** (máx ~1.8 MB). Selecciona una imagen de la cuadrícula, escribe un **pie de
  foto** opcional y pulsa **Enviar**. Las imágenes se pueden **Eliminar**.

#### Pestaña "Supervisión" (tablero del supervisor) — *solo admin/marketing*
Indicadores de gestión:
- **KPIs:** *Chats abiertos*, *Oportunidades*, *Ganadas* y **"Sin responder"** (chats que superaron el
  umbral de SLA, en rojo si hay alguno).
- **Por agente:** tabla con total de chats, abiertos, destacados, oportunidades y **ganadas** por agente.
- **Tiempo de primera respuesta por agente:** promedio (en verde si está dentro del umbral de SLA, en
  rojo si lo supera) y número de conversaciones.
- **Embudo de oportunidades:** total y valor económico por etapa.

---

### 5.4 Oportunidades — *el pipeline de ventas, visto en conjunto*

**Para qué sirve:** ver **todas** las oportunidades de todos los chats en una sola tabla, filtrarlas y
mandar un **mensaje masivo** por WhatsApp a las seleccionadas.

**La pantalla:** título con el **total** y el **valor económico** acumulado; una **barra de filtros**;
una **caja de mensaje masivo**; y la **tabla** de oportunidades.

**Filtros:** **Desde** / **Hasta** (fechas), **Paciente** (nombre o teléfono) y **Servicio** (buscador
con autocompletado). Pulsa **Filtrar**.

**Paso a paso (mensaje masivo):**
1. Marca las casillas de las conversaciones que te interesan, o usa **Seleccionar todas** / **Limpiar**.
2. Escribe el **mensaje** en la caja de texto.
3. Pulsa **Enviar masivo** y confirma.
4. El sistema te muestra el **resultado real**: cuántos se **enviaron**, cuántos **fallaron** y cuántos
   se **omitieron** (por opt-out o ventana de 24h cerrada).

**Columnas de la tabla:** casilla de selección, **Fecha**, **Contacto / Paciente** (con teléfono),
**Etapa** (chip de color), **Servicios de interés**, **Valor** y **Notas**.

---

### 5.5 Tareas — *no se te olvida nada*

**Para qué sirve:** la lista de pendientes del equipo ("llamar", "enviar presupuesto", etc.). Incluye
las tareas creadas desde los chats (y viceversa).

**La pantalla:** título con botón **Nueva tarea**; dos filtros (**Pendientes** / **Completadas**); y la
lista de tareas.

**Paso a paso:**
- **Nueva tarea** (modal): **Título \***, **Notas** (opcional), **Vence** (fecha/hora) y **Asignar a**
  (Yo u otro agente). Pulsa **Crear**.
- Marca el **círculo** ✓ de una tarea para completarla (o reabrirla). Las **vencidas** se resaltan en rojo.
- Cada tarea muestra el **responsable**, el **paciente** (si está ligada a uno) y la **fecha**. Botón 🗑️
  para eliminar.

---

## Grupo: Mensajería y plantillas

### 5.6 Plantillas de mensaje — *mensajes reutilizables y legales*

**Para qué sirve:** crear los mensajes que usarás en campañas, automatizaciones y **fuera de la ventana
de 24h** de WhatsApp.

**La pantalla:** título con botones **Sincronizar con Meta** y **Nueva plantilla**; una zona de
**alertas** (si las hay); y la **lista** de plantillas. Cada plantilla muestra su **nombre**, una
**etiqueta de estado** de color, su canal/idioma/categoría, una **vista previa del cuerpo**, el **motivo
de rechazo** (si aplica) y sus **variables**. Acciones por fila: ✏️ **Editar** y 🗑️ **Eliminar**.

**Tipos de plantilla:**
- **WhatsApp:** las debe **aprobar Meta**. Estados con su color: **Borrador**, **En revisión**,
  **Aprobada** (verde), **Rechazada**, **Deshabilitada**. Solo las **Aprobadas** aparecen para elegir en
  el chat y en campañas/automatizaciones.
- **Email:** asunto + cuerpo. **Quedan listas para usar al instante** (no requieren aprobación). Los
  enlaces que pongas se **rastrean** (clics) y se mide la **apertura**.

**Sincronizar con Meta:** trae el estado real de tus plantillas de WhatsApp (y, si una fue rechazada, su
**motivo**). Informa cuántas se **importaron**, **actualizaron** y si hay **alertas**.

**Alertas de cambio de categoría:** Meta puede **recategorizar** tus plantillas (p. ej. de *Marketing* a
*Utilidad*), lo que cambia su costo. El sistema **revisa esto automáticamente** y, si detecta un cambio
o que una plantilla pasó a **Rechazada/Deshabilitada**, te muestra una **alerta** arriba. Pulsa
**Descartar** cuando la hayas leído.

**Constructor (modal Nueva/editar plantilla) — con previsualización tipo WhatsApp en vivo:** a la
izquierda el editor, a la derecha la **vista previa** (se ve tal como llegará al paciente; las variables
`{{...}}` se rellenan al enviar).
- **Nombre \*** — sin espacios, minúsculas (ej. `recordatorio_cita`). *(No editable si la plantilla ya
  está ligada a Meta.)*
- **Canal** — WhatsApp o Email.
- **Idioma** — código del idioma (ej. `es`).
- **Categoría** — *MARKETING (promocional)*, *UTILITY (transaccional)* o *AUTHENTICATION (códigos)*.
- **Asunto** — solo si el canal es **Email**.
- **Cabecera** *(solo WhatsApp)* — *Ninguna*, *Texto*, *Imagen* o *Documento*. Para **imagen** puedes
  **Subir imagen** (el sistema la **aloja** y genera su enlace; máx ~1.8 MB) o **pegar una URL pública**.
- **Cuerpo \*** — el mensaje, con variables como `{{firstName}}` o `{{1}}` para personalizar.
- **Pie** (opcional).
- **Botones** *(solo WhatsApp, máx 3)* — por cada uno: **tipo** (*Respuesta rápida*, *Enlace (URL)* o
  *Llamar*), **texto** y, para URL/Llamar, el **enlace o número**.
- Guarda con **Guardar**. Las de WhatsApp deberás **aprobarlas en Meta** (o sincronizar si ya las creaste
  allí); las de email quedan listas.

---

### 5.7 Mensajes automáticos (legacy) — *flujos sencillos por chat (en deprecación)*

**Para qué sirve:** la **versión anterior** de las automatizaciones, enfocada en el chat. **Sigue
funcionando**, pero para todo lo nuevo conviene usar **Automatizaciones (Workflows)** (más completa:
email, asignación de agente, tareas, webhooks, condiciones…). La página muestra un **aviso de
deprecación** en la parte superior.

**La pantalla:** un panel de **carpetas** a la izquierda (con botón **＋** para crear, clic para filtrar
y 🗑️ para eliminar) y, a la derecha, la **tabla de flujos** (Flujo, Carpeta, nº de Disparadores, nº de
Pasos, Estado y acciones ✏️/🗑️). Botón **Nuevo flujo** arriba.

**Editor de un flujo:**
- **Nombre del flujo \*** y **Carpeta**.
- Interruptor **Activo / Borrador** y botón **Guardar flujo**.
- **Cuándo está activo:** chips de **días** (*Lun…Dom*) y franja horaria **De / a**.
- **Disparadores** (uno o varios): cada uno con **tipo** (*Cuando el cliente escribe — palabras clave*,
  *Al iniciar una conversación nueva*, *Con cualquier mensaje entrante*) y **audiencia** (*Todos / Solo
  nuevos / Solo pacientes registrados*). Para el tipo *palabras clave*: lista de **palabras** (separadas
  por coma) y **tipo de coincidencia** (*Contiene / Es exactamente / Empieza con*). Botón **Añadir
  disparador**.
- **Pasos** (se encadenan y se **arrastran para reordenar**): **Mensaje** (texto, con `{{nombre}}`),
  **Espera** (minutos antes del siguiente paso) y **Crear oportunidad** (en la etapa que elijas). Cada
  paso se puede subir/bajar o eliminar.

---

## Grupo: Marketing y campañas

### 5.8 Segmentos — *listas inteligentes de pacientes*

**Para qué sirve:** definir **a quién** le vas a hablar, una sola vez, y reutilizarlo en muchas
campañas. Se **recalcula** con los datos del momento cada vez que lo usas.

**La pantalla:** título con botón **Nuevo segmento** y la **lista** de segmentos (cada uno muestra su
nombre, descripción y un resumen de sus filtros, con ✏️ y 🗑️).

**Modal Nuevo/editar segmento:**
- **Nombre del segmento \*** (ej. "Inactivos 6 meses") y **Descripción** (opcional).
- **Filtros** (se combinan todos):
  - **Fuente** — chips *Anuncio / Referido / Recepción / Orgánico* (puedes marcar varias).
  - **Etiquetas** — separadas por coma; el paciente debe tenerlas **todas**.
  - **Género** — Cualquiera / Femenino / Masculino / Otro.
  - **Edad mín. / Edad máx.**
  - **Consentimiento** — *Sin filtrar*, *Con opt-in WhatsApp* o *Con opt-in Email*.
  - **Zona (Guayaquil)** — del listado de zonas.
  - **Estado de tratamiento** — Cualquiera / Activo / Completado / Abandonado.
  - **Inactivo ≥ N días** — días sin visita.
  - **Servicio contratado** *o* **Programa** (elige uno u otro).
- **Previsualizar** — muestra **cuántos pacientes coinciden** y una lista de los primeros (con su
  contacto). Pulsa **Guardar segmento**.

---

### 5.9 Campañas — *envíos masivos (ahora o programados)*

**Para qué sirve:** mandar un mensaje a todo un **segmento** por **WhatsApp** o **Email**. Respeta
**opt-out** y la **ventana de 24h**.

**La pantalla:** título con botón **Nueva campaña** y la **lista** de campañas. Cada tarjeta muestra el
nombre, una **etiqueta de estado** (*Borrador, Programada, Enviando, Finalizada, Cancelada*), su
canal/segmento/contenido y los **resultados**: 🎯 objetivo, ✓ enviados, ⏳ en cola, ⊘ omitidos, ✗
fallidos y —en email— 👁 abiertos y 🔗 clics. Las campañas en curso se **refrescan solas**. Las
*Programadas/Enviando* tienen botón **Cancelar**.

**Modal Nueva campaña:**
- **Nombre de la campaña \***.
- **Canal de envío** — WhatsApp o Email.
- **Segmento de destino \*** — al elegirlo se muestra **cuántos destinatarios** tiene.
- **Contenido:**
  - **WhatsApp:** elige **Texto libre** (solo llega a quien escribió en 24h) **o** **Plantilla** (una
    plantilla **aprobada**, que llega a todos, también inactivos).
  - **Email:** **Asunto \*** y **Cuerpo \***. Opcionalmente parte de una **plantilla de email** que puedes
    editar. Se añade automáticamente un **enlace de baja**; solo se envía a pacientes con email y opt-in.
- **Cuándo** — **Enviar ahora** o **Programar** (fecha y hora).
- **Máximo de personas** (opcional) — un tope de destinatarios.
- **Enviar por lotes (goteo)** — en vez de mandar todo de golpe, el sistema envía en **tandas** (ej. *50
  personas cada 30 minutos*). Cuida tu número de WhatsApp y mejora la entrega. Define **cuántas personas**
  y **cada cuántos minutos**.
- Pulsa **Enviar** (o **Programar**).

---

### 5.10 Automatizaciones (Workflows) — *que el sistema trabaje por ti*

**Para qué sirve:** crear secuencias que se ejecutan solas cuando ocurre algo. Es lo que convierte al
sistema en un asistente que recuerda, confirma, reactiva y pide reseñas sin que nadie haga clic.

**La pantalla:** título con botón **Nuevo workflow**; una zona de **presets** (plantillas de clínica
listas para instalar, se crean **pausadas**); un panel de **carpetas** a la izquierda (crear con **＋**,
filtrar al hacer clic, 🗑️ para eliminar); y la **lista** de automatizaciones a la derecha. Cada tarjeta
muestra el nombre, si está **Activo/Pausado**, la carpeta, un resumen del disparador y el nº de pasos, y
los contadores **Inscritos / Completados**. Acciones por tarjeta: **Pausar/Activar**, **Inscritos**,
✏️ **Editar** y 🗑️ **Eliminar**.

**Presets disponibles (instalar con un clic, quedan pausados):** *Recordatorio de cita 24h con
confirmación SÍ/NO*, *Recall de control*, *Reactivación*, *Cumpleaños* y *Post-visita: pedir reseña*.

**Modal "Inscritos":** muestra **quién está en qué paso** de la automatización (para depurar). Filtra por
estado (*Ejecutando / En espera / Completado / Cancelado*) y muestra paciente, estado, paso y próxima
ejecución.

#### Editor visual a pantalla completa (estilo GoHighLevel)
Al pulsar **Nuevo workflow** o **editar** se abre un **editor a pantalla completa**: arriba el **nombre**,
la **carpeta**, el interruptor **Activo** y los botones **Cancelar/Guardar**; abajo, el **lienzo** con el
diagrama ocupando todo el ancho. A la izquierda del lienzo están los botones **Añadir flujo** y
**Auto-organizar**.

**Disparador (tarjeta verde):** el inicio del flujo.
- Haz clic en él (o en uno de sus disparadores) para abrir el **panel derecho** y **elegir el evento**.
- **"+ Añadir disparador a este flujo"** hace que el flujo arranque con **cualquiera** de varios eventos
  (lógica "cualquiera": ej. *cita asistida* **o** *venta registrada*).

**Disparadores disponibles (12):** *Cita agendada*, *Cita asistida*, *No asistió (no-show)*, *Cita
cancelada*, *Tratamiento abandonado*, *Cumpleaños del paciente*, *Venta registrada*, *Cotización
enviada*, *Mensaje entrante (chat)*, *Palabra clave (chat)*, *Nueva conversación (chat)*, *Etiqueta
añadida*. Según el disparador, el panel pide datos extra: **Audiencia** (Todos / Solo primera visita /
Solo recurrentes), **palabras clave** + tipo de coincidencia (para *Palabra clave*), o la **etiqueta**
(para *Etiqueta añadida*).

**Añadir pasos desde el diagrama:** pulsa el botón **"+"** que aparece **debajo de un nodo** (para
encadenar) o **sobre una línea** (para **insertar** un paso entre dos). Se abre un **buscador de pasos**
agrupado por categoría. (Ya no hay que arrastrar conectores.)

**Pasos disponibles (agrupados):**
- **Comunicación:** *Enviar mensaje*, *Enviar plantilla*, *Enviar email*, *Responder con IA*, *Pedir reseña*.
- **Esperas:** *Esperar (tiempo)*, *Esperar hasta la cita*, *Esperar respuesta*.
- **Lógica:** *Condición (sí/no)*, *Objetivo (terminar si)*.
- **Contacto / CRM:** *Añadir etiqueta*, *Quitar etiqueta*, *Mover etapa*, *Asignar agente*, *Cambiar
  estado de cita*.
- **Otros:** *Crear tarea*, *Webhook (integración)*.

**Configurar un paso:** haz clic en su nodo y se abre el **panel a la derecha**. Según el tipo:
- **Enviar mensaje / Pedir reseña:** el texto (con `{{nombre}}`).
- **Enviar plantilla:** elige una plantilla **aprobada**.
- **Enviar email:** asunto + cuerpo (lleva enlace de baja automático).
- **Esperar:** minutos. **Esperar hasta la cita:** nº de horas **antes/después** de la cita. **Esperar
  respuesta:** horas de espera máxima.
- **Condición / Objetivo:** un **campo** (*Etiqueta del paciente, Etapa de oportunidad, Fuente, Última
  respuesta, Tiene paciente vinculado*), un **operador** (*es igual a, es distinto de, contiene, existe*)
  y un **valor**. Para *Última respuesta*, el valor es *Sí / No / Otra*.
- **Añadir/Quitar etiqueta:** la etiqueta. **Mover etapa:** la etapa destino. **Cambiar estado de cita:**
  *CONFIRMADA* o *CANCELADA*.
- **Asignar agente:** *Round-robin* o *Agente específico*. **Crear tarea:** título, vencimiento (horas)
  y a quién se asigna. **Webhook:** URL y método (POST/GET).
- **Responder con IA:** no requiere configuración (la IA redacta usando el contexto del chat).

**Ramificaciones (sí/no):** los nodos de **Condición** tienen **dos salidas**: **"Sí"** (verde, a la
izquierda) y **"No"** (rojo, a la derecha), cada una con su propio **"+"** (ej. si confirma → marcar
cita; si no → ofrecer reagendar).

**Varios flujos en el mismo diagrama:** el botón **"Añadir flujo"** crea **otro disparador con su propia
cadena de pasos**, independiente, dentro del mismo diagrama. Cada flujo se puede eliminar con su 🗑️.

**Mover y ordenar:** arrastra cualquier nodo para acomodarlo (es fluido). **Auto-organizar** los
reordena en un árbol limpio. El icono de papelera del panel elimina el paso seleccionado.

> Las automatizaciones antiguas (formato de lista o diagrama anterior) se **adaptan automáticamente** al
> abrirlas, conservando su orden y su disparador.

---

## Grupo: Reputación y análisis

### 5.11 Reputación — *consigue reseñas de Google*

**Para qué sirve:** medir el resultado de las solicitudes de reseña post-visita.

**La pantalla:** cuatro **KPIs** (*Solicitudes enviadas*, *Calificaron* con %, *Reseñas a Google*,
*Calificación promedio* ★) y una **tabla** de solicitudes con un **filtro** por estado.

**Cómo funciona:** la automatización **Post-visita** (o el paso *Pedir reseña*) envía al paciente un link
con estrellas (1–5). Si califica **alto** (según tu umbral en *Configuración Call Center → Reputación*),
se le **redirige a Google**; si califica **bajo**, se captura su **comentario en privado**.

**Columnas de la tabla:** **Paciente**, **Estado** (*Enviada / Abrió el enlace / Calificó / Reseña en
Google*), **Calificación** (estrellas), **Comentario** y **fecha de envío**.

---

### 5.12 Atribución / ROI — *de dónde viene el dinero*

**Para qué sirve:** saber qué **origen/campaña** trae pacientes y cuánto **ingreso** generan.

**La pantalla:** título con un selector de **Rango** (*Este mes / Trimestre / Año*); dos tarjetas
(*Pacientes captados* e *Ingresos atribuidos*); y una **tabla** por origen/campaña.

**Columnas de la tabla:** **Origen**, **Campaña**, **Pacientes**, **Ingresos** (con barra) y
**$/paciente**. Incluye la atribución de anuncios *click-to-WhatsApp*. Es tu medida real de retorno de
inversión.

---

### 5.13 Marketing — *tableros y acciones de captación*

**Para qué sirve:** el panel analítico más completo del módulo, con **acciones directas**. Reúne
tratamientos, conversión, predicciones, zonas y desglose de citas.

**La pantalla (secciones, de arriba a abajo):**
- **Tarjetas resumen:** *Tratamientos activos*, *completados*, *abandonados* y *Recordatorios pendientes*.
- **¿Cómo nos conocieron?** — gráfico de pastel por **fuente** (anuncio/referido/recepción/orgánico) con
  porcentajes.
- **Servicios no completados** — productos/servicios prescritos pero no realizados. Cada fila se
  **expande** para ver los pacientes con cuántas sesiones les faltan y su teléfono.
- **Evolución de un servicio** — elige un **servicio** y un **rango** (con opción *Personalizado* y
  fechas) para ver su línea de tiempo (vendidos, en citas, pacientes únicos) y totales.
- **Recordatorios de pacientes ausentes** — tabla de pacientes sin venir hace **N días** (configurable),
  con filtros por **servicio/programa**. Marca pacientes y pulsa **WhatsApp masivo** para enviarles un
  recordatorio (ver modal abajo). Botones para **mostrar más** / **ver todos** / **colapsar**.
- **Predicciones de demanda (próximo mes)** — por servicio, basadas en estacionalidad y promedio de los
  últimos 3 meses.
- **Próxima semana** — citas y proyección para los próximos 7 días (cita general, promedio histórico/día,
  pronóstico 7 días, gráfico por día y top de servicios).
- **Estadísticas de citas** — con filtros (**rango**, **servicio**, **programa**): total, pendientes,
  asistidos, no asistidos, nuevos, y un desglose extra (nuevos que asistieron, canceladas, por Call
  Center…). Incluye **tasas de asistencia, no-show y confirmación** (útiles para medir el efecto de los
  recordatorios automáticos) y un detalle **por doctor**.
- **Programas y servicios — desempeño mensual** — tabla con los últimos 12 meses por programa.
- **Mapa de zonas de Guayaquil** — un mapa de burbujas con la procedencia geográfica de los clientes
  (filtrable por servicio/programa) y un **ranking de zonas**.
- **Quién refirió a cada paciente** y **Top doctores por derivaciones**.

**Modal "Enviar WhatsApp masivo" (recordatorios de ausentes):**
- Indica a **cuántos** pacientes se enviará (los que tengan teléfono/WhatsApp).
- **Mensaje** — editable; usa `{{nombre}}` para personalizar.
- Recuerda el aviso de la **ventana de 24h** (fuera de ella se necesita plantilla). Pulsa **Enviar**.

---

### 5.14 Analíticas — *gráficos de actividad*

**Para qué sirve:** ver de un vistazo chats, citas y oportunidades en un rango de fechas.

**La pantalla:** filtros **Desde / Hasta** y botón **Actualizar**; tres **KPIs** (*Chats*, *Citas en
rango*, *Oportunidades*); y cuatro gráficos: **Chats por día**, **Citas agendadas por día**, **Citas por
estado** (pastel) y **Oportunidades por etapa**.

---

### 5.15 Reportes de atención

**Para qué sirve:** medir la **atención por doctor/proveedor** y la **adherencia** del paciente al
tratamiento.

**La pantalla:** filtros **Desde / Hasta** y **Doctor**; botón **Calcular**. Muestra el **total de
atenciones** y una tarjeta por proveedor con sus atenciones, pacientes únicos y los **tratamientos /
servicios atendidos**. Cada tarjeta se **expande** para ver el detalle de pacientes (fecha, paciente,
servicio).

**Adherencia:** en el detalle de un paciente, pulsa **Ver adherencia** para abrir un modal con sus
tratamientos, el **% de avance** y, por ítem, cuántas sesiones lleva de las recetadas.

---

## 6. Flujos de trabajo típicos (recetas)

**A) Atender un chat y convertirlo en cita**
1. *Chats* → abre la conversación → **Tomar**.
2. Responde (usa `/` para mensajes guardados o **IA** para una sugerencia).
3. Si no es paciente aún → panel derecho → **Agregar al sistema** (nombres, género).
4. **Crear cita** (botón de la cabecera) → elige fecha/hora/servicio (verifica la disponibilidad).
5. Marca/edita la **oportunidad** como *Agendado* o *Ganado*.

**B) Enviar una campaña legal a inactivos**
1. *Segmentos* → crea "Inactivos 6 meses con opt-in WhatsApp" y previsualiza el conteo.
2. *Plantillas de mensaje* → ten lista una plantilla de WhatsApp **aprobada** (porque son inactivos).
3. *Campañas* → **Nueva** → segmento + canal WhatsApp + **Plantilla** → **Enviar ahora** o **Programar**.
4. Revisa los **resultados** (enviados/omitidos/fallidos) en la tarjeta de la campaña.

**C) Recordatorio de cita con confirmación SÍ/NO (reduce el no-show)**
1. *Automatizaciones* → instala el preset **Recordatorio de cita 24h con confirmación SÍ/NO** (queda pausado).
2. Ábrelo, revisa el mensaje (para enviar fuera de 24h, cámbialo a **plantilla aprobada**) y **actívalo**.
3. A partir de ahí, 24h antes de cada cita se pide confirmación: **SÍ** confirma, **NO** cancela y libera
   el cupo. Mide el efecto en *Marketing → tasas de asistencia/no-show/confirmación*.

**D) Pedir reseñas automáticamente**
1. *Configuración Call Center → Reputación* → pega tu **URL de Google** y el **umbral**.
2. *Automatizaciones* → instala el preset **Post-visita: pedir reseña** y actívalo.
3. Mira los resultados en *Reputación*.

**E) Captar agenda sola desde tus anuncios**
1. *Auto-agendamiento* → actívalo, configura horario/servicios y copia el **link**.
2. Ponlo en tu anuncio/biografía. Las reservas entran como citas y disparan la confirmación.
3. Mide el origen en *Atribución / ROI*.

**F) Reactivar pacientes ausentes desde Marketing**
1. *Marketing → Recordatorios de pacientes ausentes* → ajusta los días y filtra por servicio/programa.
2. Marca a los pacientes y pulsa **WhatsApp masivo**; personaliza el mensaje con `{{nombre}}`.
3. Recuerda la ventana de 24h: para inactivos, conviene una automatización con **plantilla**.

---

## 7. Buenas prácticas y cumplimiento

- **Respeta la ventana de 24h:** para escribir a alguien que **no** te ha escrito en el día, usa
  **plantillas aprobadas**. El sistema te lo recuerda y te bloquea el texto libre cuando corresponde.
- **El opt-out es sagrado:** si un paciente pide la baja, **no** fuerces mensajes; el sistema ya lo
  excluye solo de campañas y automatizaciones, y te lo marca en rojo en el chat.
- **Personaliza con `{{nombre}}`** en plantillas, campañas y pasos: se ve más cercano y profesional.
- **Instala automatizaciones pausadas, revísalas y luego actívalas.** Evita sorpresas.
- **Usa notas internas y @menciones** para coordinar al equipo sin escribirle al paciente.
- **Para listas grandes, usa el goteo** (envío por lotes) en las campañas: protege tu número de WhatsApp
  y mejora la entrega frente a envíos masivos de golpe.
- **Etiqueta de forma consistente** (pocos nombres y claros): tus segmentos y automatizaciones por
  etiqueta serán mucho más útiles.
- **Asigna o auto-asigna los chats** para que ningún paciente quede "sin responder"; vigílalo en el
  **Tablero de supervisión**.

---

## 8. Roles y permisos (qué ve cada quien)

| Página | Admin | Marketing | Call Center |
|---|:---:|:---:|:---:|
| Chats / WhatsApp | ✔ | ✔ | ✔ |
| Chats → pestaña **Supervisión** | ✔ | ✔ | — |
| Oportunidades | ✔ | ✔ | ✔ |
| Tareas | ✔ | ✔ | ✔ |
| Mensajes automáticos (legacy) | ✔ | ✔ | ✔ |
| Plantillas / Segmentos / Campañas | ✔ | ✔ | — |
| Automatizaciones | ✔ | ✔ | — |
| Auto-agendamiento | ✔ | ✔ | — |
| Reputación / Atribución / Marketing / Analíticas / Reportes | ✔ | ✔ | — |
| Configuración Call Center (canales / IA / reputación) | ✔ | ✔ | — |

*(El Call Center se enfoca en atender, agendar y cotizar; Marketing añade campañas, automatización,
análisis y supervisión; Admin lo configura todo.)*

---

## 9. Preguntas frecuentes

**No puedo escribir texto libre en un chat, me pide plantilla.**
Pasaron más de 24h desde el último mensaje del paciente. Es una regla de WhatsApp: pulsa **Plantilla** y
envía una **aprobada**.

**Puse el nombre de una plantilla pero no aparece en el chat.**
En el chat se eligen desde el botón **Plantilla**, y solo se listan las que están **Aprobadas por Meta**
(etiqueta verde en *Plantillas de mensaje*). Si la tuya está en Borrador/En revisión, primero apruébala
en Meta y luego pulsa **Sincronizar con Meta**.

**Mandé una campaña o un masivo y dice "omitidos".**
Son contactos en **opt-out** o fuera de la ventana de 24h (si usaste texto libre). Es correcto y legal.

**¿Por qué una automatización está "pausada"?**
Los presets se instalan pausados a propósito, para que los revises antes de que empiecen a enviar. Actívalos
cuando estén listos.

**La IA no responde / no resume.**
Falta activar la IA. El administrador la configura en **Configuración Call Center → Inteligencia
Artificial** (pega la API key de Claude y pulsa *Probar conexión*). Sin ella, esos botones avisan que no
está disponible y el resto del sistema sigue funcionando normal.

**Me llegó una alerta de que una plantilla "cambió de categoría". ¿Qué hago?**
Meta recategorizó esa plantilla (cambia su costo/uso). Es solo un aviso; revísala y **Descarta** la
alerta. No necesitas hacer nada más salvo que prefieras ajustar su contenido.

**¿Dónde pongo etiquetas a un paciente?**
En tres lugares: en el **chat** (panel derecho → *Etiquetas*), dentro de una **oportunidad**, y en la
**ficha del paciente**. Luego puedes usarlas como filtro en *Segmentos* o como disparador en *Automatizaciones*.

**¿Un chat puede tener varias oportunidades?**
Sí. En el modal *Crear/Editar oportunidad* puedes **Agregar otra oportunidad** (cada una con su etapa,
servicios, etiquetas y notas).

**¿Puedo agendar varias citas o cotizar desde el mismo chat?**
Sí. El modal *Agendar cita(s)* permite crear **varias citas** a la vez (con verificación de disponibilidad),
y *Crear cotización* arma una cotización y **envía el enlace al PDF** dentro del chat.

**¿Los pacientes ven mis notas internas?**
No. Las notas internas y las @menciones son **solo para el equipo**.

**¿Cómo reparto los chats entre agentes?**
Cada agente puede **Tomar** un chat; el admin/marketing puede usar **Auto-asignar** (lo da al agente con
menos chats abiertos). La carga y el SLA se vigilan en la pestaña **Supervisión**.

**¿Cuál es la diferencia entre "Mensajes automáticos (legacy)" y "Automatizaciones"?**
*Mensajes automáticos* es la versión anterior (flujos de chat por palabra clave); **sigue funcionando**
pero está en deprecación. **Automatizaciones (Workflows)** es la versión nueva y completa (email,
asignación de agente, tareas, webhooks, condiciones, reseñas, IA…). Usa esta para todo lo nuevo.

**Quiero practicar sin tener WhatsApp conectado.**
En *Chats*, usa **Simular entrante**: crea/reutiliza la conversación con ese número y agrega un mensaje
entrante de prueba.

---

*¿Dudas sobre una pantalla concreta? Búscala en la sección 5 por su nombre del menú.*
