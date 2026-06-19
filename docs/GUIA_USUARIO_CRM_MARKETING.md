# Guía de usuario — CRM de Call Center y Marketing

> Esta guía explica, **sin tecnicismos**, todo lo que el sistema ofrece para atender pacientes
> por WhatsApp/redes, gestionar oportunidades de venta, automatizar mensajes, enviar campañas,
> pedir reseñas y medir resultados. Está pensada para el equipo de **recepción / call center**,
> **marketing** y **administración**.

---

## 1. ¿Qué es este módulo y para quién es?

Es el "centro de contacto" de la clínica: un solo lugar para **hablar con los pacientes**,
**convertir conversaciones en citas y ventas**, y **hacer marketing** medible.

Lo usan tres perfiles (cada uno ve solo lo que le corresponde):

| Perfil | Para qué entra |
|---|---|
| **Call Center / Recepción** | Atender chats, agendar citas, crear oportunidades, gestionar tareas. |
| **Marketing** | Campañas, segmentos, automatizaciones, plantillas, reputación, analítica. |
| **Administrador** | Todo lo anterior + configuración de canales y permisos. |

Todo el módulo vive en el **menú lateral izquierdo**. Más abajo se explica para qué sirve cada
opción del menú.

---

## 2. Conceptos clave (glosario rápido)

Entender estas 10 palabras hace que todo lo demás sea fácil:

- **Conversación / Chat:** un hilo de mensajes con un contacto (por WhatsApp, Instagram, etc.).
- **Oportunidad:** una posible venta dentro de un chat (ej. "interesada en blanqueamiento").
  Se mueve por etapas (Nuevo → Contactado → Interesado → Agendado → Ganado / Perdido).
- **Plantilla:** un mensaje pre-aprobado y reutilizable. Las de **WhatsApp** las aprueba Meta;
  las de **Email** quedan listas al instante.
- **Segmento:** una "lista inteligente" de pacientes que cumplen ciertos filtros
  (ej. "mujeres, sin visita hace 6 meses, con consentimiento"). Se recalcula sola cada vez que la usas.
- **Campaña:** un envío masivo (ahora o programado) a un segmento.
- **Automatización (Workflow):** una secuencia de pasos que se dispara sola ante un evento
  (ej. "cuando se agenda una cita → 24h antes manda un recordatorio y pide confirmación").
- **Inscripción:** cada paciente que "entró" a una automatización y va avanzando por sus pasos.
- **Ventana de 24 horas (WhatsApp):** regla de WhatsApp. Solo puedes mandar **texto libre** si el
  paciente te escribió en las últimas 24h. Pasado ese tiempo, **solo puedes usar una plantilla aprobada**.
- **Opt-out / Baja:** cuando un paciente pide no recibir más mensajes (escribe "BAJA", "STOP", etc.,
  o se da de baja del email). El sistema lo respeta automáticamente y no le vuelve a escribir marketing.
- **Atribución:** de dónde vino cada paciente (anuncio, referido, etc.) y cuánto dinero generó.

---

## 3. Mapa del sistema: "quiero hacer X, ¿a dónde voy?"

| Quiero… | Página del menú |
|---|---|
| Conectar WhatsApp / Email / Instagram | **Configuración Call Center** |
| Atender mensajes de pacientes | **Chats / WhatsApp** |
| Ver todas las oportunidades de venta juntas | **Oportunidades** |
| Recordar llamar a alguien | **Tareas** |
| Crear mensajes reutilizables / aprobados | **Plantillas de mensaje** |
| Armar una lista de pacientes para una campaña | **Segmentos** |
| Enviar un mensaje masivo (ahora o programado) | **Campañas** |
| Que el sistema mande mensajes solo (recordatorios, etc.) | **Automatizaciones** |
| Que los pacientes agenden solos por un link | **Auto-agendamiento** |
| Pedir y medir reseñas de Google | **Reputación** + **Configuración Call Center** |
| Saber qué anuncio/origen trae pacientes y ventas | **Atribución / ROI** |
| Ver tableros y predicciones de marketing | **Marketing** y **Analíticas** |
| Reportes de atención por doctor / adherencia | **Reportes de atención** |

---

## 4. Guía página por página

### 4.1 Configuración Call Center — *empieza aquí*

**Para qué sirve:** conectar los canales por los que la clínica se comunica y definir la
reputación. **Es el primer paso**: sin canales conectados, los chats funcionan en modo prueba.

**Qué encontrarás (pestañas por canal):** WhatsApp, Messenger, Instagram, TikTok y Email.
En cada una pegas las credenciales que te da el proveedor (Meta / Resend) y la activas con el
interruptor **Activo/Inactivo**.

**Cómo usarla:**
1. Elige la pestaña del canal (ej. WhatsApp).
2. Copia la **URL del webhook** que muestra la pantalla y pégala en el panel del proveedor (Meta).
3. Pega las credenciales (token, IDs, etc.) y presiona **Probar conexión** para verificar.
4. Activa el canal.
5. En **Reputación** (al final), pega tu **URL de reseñas de Google** y elige a partir de cuántas
   estrellas se considera "promotor" (por defecto 4): a esos pacientes se les enviará a Google;
   a los demás se les pedirá un comentario interno.

**Tips:**
- Los campos sensibles se muestran enmascarados (••••1234) una vez guardados; para cambiarlos,
  simplemente escribe encima.
- Los tokens se guardan **cifrados**. No los verás completos otra vez (es lo correcto por seguridad).

---

### 4.2 Chats / WhatsApp — *el corazón del call center*

**Para qué sirve:** atender en un solo lugar todos los mensajes entrantes y salientes, y desde ahí
crear pacientes, citas, cotizaciones y oportunidades.

**Cómo está organizada la pantalla (3 columnas):**

1. **Izquierda — Lista de conversaciones.** Buscador por nombre/teléfono y pestañas:
   - **Todas / Mías / Destacados / Oportunidades** y **Tablero** (panel del supervisor).
   - Cada conversación muestra el último mensaje, hora y un contador de no leídos.

2. **Centro — La conversación.**
   - **Cabecera:** nombre del contacto, una etiqueta roja **"Esperando respuesta"** si el último
     mensaje es del paciente, y botones: **Tomar** (asignártela), **Auto-asignar** (el sistema la
     reparte al agente con menos chats), **Crear/editar oportunidad**, **Crear cita**, **Cotización**
     y **destacar** (⭐).
   - **Mensajes:** cada mensaje saliente muestra su **estado de entrega** (enviado ✓, entregado ✓✓,
     leído en azul, o ⚠ fallido). Las imágenes/audios que envía el paciente **se ven dentro del chat**.
   - **Caja de escritura:**
     - Escribe y presiona Enter para enviar.
     - Escribe **`/`** para insertar un **mensaje guardado** (respuestas rápidas).
     - Botón **🖼** para enviar una imagen de la galería.
     - Botón **IA** para que el asistente **sugiera una respuesta** (la puedes editar antes de enviar).
   - **Avisos automáticos:**
     - Si pasaron **más de 24h** sin que el paciente escriba, aparece un aviso de "ventana cerrada"
       y un selector para enviar por **plantilla aprobada** (es la única forma legal de escribir entonces).
     - Si el contacto está en **opt-out**, se bloquea el envío de marketing y se avisa.

3. **Derecha — Panel de contexto.**
   - **Contacto:** datos y botones para **Agregar al sistema** (crear paciente), **Agendar cita** o
     **Crear cotización**.
   - **Oportunidad:** etapa actual, valor esperado (calculado desde los servicios de interés) y notas.
   - **Resumen IA:** botón para que la IA **resuma la conversación** en viñetas (motivo, acuerdos,
     próximo paso). Ideal cuando retomas un chat largo.
   - **Notas internas:** comentarios **solo para el equipo** (no los ve el paciente). Puedes
     **@mencionar** a un compañero escribiendo `@` y eligiéndolo; le llega una notificación.
   - **Tareas:** crea recordatorios ligados a ese chat ("llamar mañana 10am"), con fecha y responsable.
   - **Citas del paciente** y **Detalles** (canal, estado, bloquear/desbloquear contacto).

4. **Tablero (pestaña del supervisor).** Indicadores de gestión:
   - KPIs: chats abiertos, oportunidades, ganadas y **"Sin responder"** (chats que superaron el SLA).
   - **Tabla por agente:** carga de trabajo y oportunidades ganadas.
   - **Tiempo de primera respuesta por agente** (en verde si está dentro del umbral de SLA).
   - **Embudo de oportunidades** por etapa.

**Botones útiles arriba:** **Simular entrante** (para practicar sin WhatsApp real) y **Mensajes
guardados** (administrar las respuestas rápidas con `/atajo`).

---

### 4.3 Oportunidades — *el pipeline de ventas, visto en conjunto*

**Para qué sirve:** ver **todas** las oportunidades de todos los chats en una sola tabla, filtrarlas
y mandar un **mensaje masivo** a las seleccionadas.

**Cómo usarla:**
1. Filtra por **fecha, paciente o servicio**.
2. Marca las casillas de las conversaciones que te interesan (o **Seleccionar todas**).
3. Escribe el mensaje y presiona **Enviar masivo**.
4. El sistema te muestra el **resultado real**: cuántos se enviaron, cuántos fallaron y cuántos se
   omitieron (por opt-out o ventana de 24h cerrada).

**Tip:** arriba ves el total de oportunidades y el **valor económico** acumulado del embudo.

---

### 4.4 Tareas — *no se te olvida nada*

**Para qué sirve:** lista de pendientes del equipo ("llamar", "enviar presupuesto", etc.).

**Cómo usarla:**
- Filtra entre **Pendientes** y **Completadas**.
- **Nueva tarea:** título, notas, fecha de vencimiento y a quién se asigna.
- Marca el círculo para completarla. Las **vencidas** se resaltan en rojo.
- Las tareas creadas desde un chat aparecen también aquí (y viceversa).

---

### 4.5 Plantillas de mensaje — *mensajes reutilizables y legales*

**Para qué sirve:** crear los mensajes que usarás en campañas, automatizaciones y **fuera de la
ventana de 24h** de WhatsApp.

**Dos tipos:**
- **WhatsApp:** son plantillas que **Meta debe aprobar**. Verás su estado (Borrador, En revisión,
  Aprobada, Rechazada). Botón **Sincronizar con Meta** para traer el estado real.
- **Email:** asunto + cuerpo. **Quedan listas para usar al instante** (no requieren aprobación).
  Los enlaces que pongas se **rastrean** (clics) y se mide la **apertura**.

**Cómo usarla:** crea la plantilla, usa variables como `{{nombre}}` para personalizar, y guárdala.
Luego estará disponible para elegir en Campañas y en las Automatizaciones.

---

### 4.6 Segmentos — *listas inteligentes de pacientes*

**Para qué sirve:** definir **a quién** le vas a hablar, una sola vez, y reutilizarlo en muchas campañas.

**Cómo usarla:**
1. **Nuevo segmento:** ponle nombre y descripción.
2. Combina filtros: **fuente** (anuncio/referido/…), **etiquetas**, **estado de tratamiento**,
   **días sin visita**, **género**, **rango de edad** y **consentimiento** (opt-in).
3. Verás un **contador en vivo** de cuántos pacientes coinciden.
4. Guárdalo. Al usarlo en una campaña, se **recalcula** con los datos del momento.

**Tip:** los segmentos son la base de un marketing limpio: en vez de "exportar y filtrar a mano",
defines la regla y el sistema mantiene la lista al día.

---

### 4.7 Campañas — *envíos masivos (ahora o programados)*

**Para qué sirve:** mandar un mensaje a todo un segmento por **WhatsApp** o **Email**.

**Cómo usarla:**
1. **Nueva campaña:** nombre y **canal** (WhatsApp o Email).
2. Elige el **segmento** de destino.
3. Define el contenido:
   - **WhatsApp:** texto libre (solo llega a quienes escribieron en 24h) **o** una **plantilla aprobada**
     (llega a todos, también inactivos).
   - **Email:** asunto y cuerpo, o **parte de una plantilla de email** que puedes editar.
4. Elige **Enviar ahora** o **Programar** para una fecha/hora.
5. Sigue los **resultados** en la tarjeta de la campaña: enviados, en cola, omitidos, fallidos y
   —en email— **abiertos** y **clics**.

**Cumplimiento:** el sistema **nunca** envía a contactos en opt-out, y respeta la ventana de 24h.
Por eso, para inactivos, **usa plantillas**.

---

### 4.8 Automatizaciones (Workflows) — *que el sistema trabaje por ti*

**Para qué sirve:** crear secuencias que se ejecutan solas cuando ocurre algo. Es lo que convierte
al sistema en un asistente que recuerda, confirma y reactiva sin que nadie haga clic.

**Cómo funciona:** cada automatización tiene **un disparador** + **una lista de pasos**.

**Disparadores disponibles:**
- De **cita:** cita agendada, cita asistida, no asistió (no-show).
- De **paciente:** cumpleaños, etiqueta añadida, venta registrada, tratamiento abandonado.
- De **chat:** mensaje entrante, **palabra clave** (ej. "precio"), nueva conversación.

**Pasos que puedes encadenar:**
- **Enviar mensaje / plantilla / email.**
- **Esperar** (tiempo) o **Esperar hasta la cita** (ej. 24h antes).
- **Esperar respuesta** del paciente (base del recordatorio con confirmación SÍ/NO).
- **Condición** (si/no) para ramificar según etiqueta, etapa o la última respuesta.
- **Añadir/Quitar etiqueta**, **Mover de etapa**, **Cambiar estado de la cita**.
- **Asignar agente** (round-robin o uno específico), **Crear tarea**, **Webhook** (integración externa).
- **Responder con IA** (auto-respuesta de primer contacto).
- **Pedir reseña** (reputación).
- **Objetivo** (termina la secuencia si se cumple algo).

**Organización visual (carpetas y arrastrar):**
- A la izquierda tienes un panel de **carpetas** para agrupar tus automatizaciones por tema
  (ej. *Recordatorios*, *Reactivación*, *Cumpleaños*). Crea una con el botón **＋** (icono de carpeta),
  haz clic en una carpeta para **filtrar** solo sus automatizaciones, y usa **Todas** para verlas juntas.
  Cada carpeta muestra cuántas automatizaciones contiene; pasa el cursor sobre una para **eliminarla**
  (debe estar vacía).
- Al crear o editar una automatización, elige su **Carpeta** en el campo correspondiente (puedes escribir
  una nueva o elegir una existente de la lista).
- Dentro del editor, **arrastra los pasos** (icono de líneas a la izquierda de cada paso) para
  **reordenarlos**; también puedes usar las flechas ↑/↓.

**Cómo usarla (lo más fácil):**
1. Arriba verás **plantillas de clínica listas para instalar** (se crean **pausadas** para que las
   revises): *Recordatorio de cita 24h con confirmación SÍ/NO*, *Recall de control*, *Reactivación*,
   *Cumpleaños* y *Post-visita: pedir reseña*. Instálalas con un clic.
2. Revisa los pasos (arrástralos para ordenarlos), ajústalos y **actívala**.
3. El botón **Inscritos** de cada automatización te muestra **quién está en qué paso** (para depurar).
4. Organiza tus automatizaciones en **carpetas** para mantener todo ordenado a medida que crecen.

> **Importante:** verás también una opción **"Mensajes automáticos (legacy)"** en el menú. Es la
> versión anterior; **sigue funcionando** pero está en deprecación. Para todo lo nuevo usa
> **Automatizaciones (Workflows)**, que es más completa.

---

### 4.9 Auto-agendamiento — *que el paciente reserve solo*

**Para qué sirve:** generar un **link público** para que los pacientes elijan día y hora sin llamar.

**Cómo usarla:**
1. Configura **días, horario, capacidad por hora, servicios** y el **mensaje de confirmación**.
2. Copia el **link** (`…/book/su-token`) y compártelo (en bio de Instagram, anuncios, firma de email…).
3. Cuando alguien reserva, el sistema **crea/vincula al paciente y la cita**, y dispara la
   automatización de confirmación (si la tienes activa).

---

### 4.10 Reputación — *consigue reseñas de Google*

**Para qué sirve:** pedir reseñas tras la visita y medir el resultado.

**Cómo funciona:** la automatización **Post-visita** envía al paciente un link con estrellas (1–5):
- Si califica **alto** (según tu umbral), se le **redirige a dejar la reseña en Google**.
- Si califica **bajo**, se captura su **comentario en privado** (no se hace público).

**En la página de Reputación verás:** solicitudes enviadas, cuántos calificaron, cuántos fueron a
Google, la **calificación promedio**, y el detalle con los comentarios.

> Recuerda configurar tu **URL de Google** y el **umbral** en *Configuración Call Center → Reputación*.

---

### 4.11 Atribución / ROI — *de dónde viene el dinero*

**Para qué sirve:** saber qué **origen/campaña** trae pacientes y cuánto **ingreso** generan.

**Cómo usarla:** elige el **rango** de fechas. Verás los pacientes captados por origen/campaña
(incluida la atribución de anuncios *click-to-WhatsApp*) y las ventas asociadas. Es tu medida real
de retorno de inversión.

---

### 4.12 Marketing — *tableros y acciones de captación*

**Para qué sirve:** panel analítico con acciones directas. Incluye:
- **Recordatorios de inactivos:** lista de pacientes sin visita hace X días, con envío masivo por WhatsApp.
- **Predicciones** y **servicios no completados** (para seguimiento).
- **Mapa de calor por zonas**, **programas**, **próxima semana** y **referidores**.
- **Desglose de citas** con **tasas de asistencia, no-show y confirmación** (para medir el efecto de
  los recordatorios automáticos).

---

### 4.13 Analíticas y Reportes de atención

- **Analíticas:** gráficos de actividad — chats por día, citas por día, **citas por estado** y
  **oportunidades por etapa**.
- **Reportes de atención:** reporte por **doctor** y **adherencia** del paciente al tratamiento
  (con detalle por paciente).

---

## 5. Flujos de trabajo típicos (recetas)

**A) Atender un chat y convertirlo en cita**
1. *Chats* → abre la conversación → **Tomar**.
2. Responde (usa `/` para respuestas rápidas o **IA** para una sugerencia).
3. Si no es paciente aún → panel derecho → **Agregar al sistema**.
4. **Crear cita** (botón de la cabecera) → elige fecha/hora/servicio.
5. Marca la **oportunidad** como *Agendado* o *Ganado*.

**B) Enviar una campaña legal a inactivos**
1. *Segmentos* → crea "Inactivos 6 meses con opt-in".
2. *Plantillas de mensaje* → ten lista una plantilla de WhatsApp **aprobada** (porque son inactivos).
3. *Campañas* → nueva → segmento + canal WhatsApp + **plantilla** → **Enviar ahora** o programar.
4. Revisa resultados (enviados/omitidos/fallidos).

**C) Recordatorio de cita con confirmación SÍ/NO (reduce el no-show)**
1. *Automatizaciones* → instala el preset **Recordatorio de cita 24h**.
2. Revisa el mensaje y (para enviar fuera de 24h) cámbialo a **plantilla aprobada**.
3. Actívala. A partir de ahí, 24h antes de cada cita se pide confirmación: **SÍ** confirma la cita,
   **NO** la cancela y libera el cupo. Mide el efecto en *Marketing → tasas*.

**D) Pedir reseñas automáticamente**
1. *Configuración Call Center → Reputación* → pega tu **URL de Google** y umbral.
2. *Automatizaciones* → instala el preset **Post-visita** y actívalo.
3. Mira los resultados en *Reputación*.

**E) Captar agenda sola desde tus anuncios**
1. *Auto-agendamiento* → configura horario/servicios y copia el **link**.
2. Ponlo en tu anuncio/biografía. Las reservas entran como citas y disparan la confirmación.
3. Mide el origen en *Atribución / ROI*.

---

## 6. Buenas prácticas y cumplimiento

- **Respeta la ventana de 24h:** para escribir a alguien que **no** te ha escrito en el día, usa
  **plantillas aprobadas**. El sistema te lo recuerda y te bloquea el texto libre cuando corresponde.
- **El opt-out es sagrado:** si un paciente pide la baja, **no** vuelvas a forzar mensajes; el sistema
  ya lo excluye solo de campañas y automatizaciones.
- **Personaliza con `{{nombre}}`** en plantillas y pasos: se ve más cercano y profesional.
- **Instala automatizaciones pausadas, revísalas y luego actívalas.** Evita sorpresas.
- **Usa notas internas y @menciones** para coordinar al equipo sin escribirle al paciente.

---

## 7. Roles y permisos (qué ve cada quien)

| Página | Admin | Marketing | Call Center |
|---|:---:|:---:|:---:|
| Chats / WhatsApp | ✔ | ✔ | ✔ |
| Oportunidades | ✔ | ✔ | ✔ |
| Tareas | ✔ | ✔ | ✔ |
| Plantillas / Segmentos / Campañas | ✔ | ✔ | — |
| Automatizaciones | ✔ | ✔ | — |
| Auto-agendamiento | ✔ | ✔ | — |
| Reputación / Atribución / Marketing / Analíticas | ✔ | ✔ | — |
| Configuración Call Center | ✔ | ✔ | — |

*(El Call Center se enfoca en atender y agendar; Marketing en campañas y análisis; Admin lo configura todo.)*

---

## 8. Preguntas frecuentes

**No puedo escribir texto libre en un chat, me pide plantilla.**
Pasaron más de 24h desde el último mensaje del paciente. Es una regla de WhatsApp: usa una plantilla aprobada.

**Mandé una campaña y dice "omitidos".**
Son contactos en **opt-out** o fuera de la ventana de 24h (si usaste texto libre). Es correcto y legal.

**¿Por qué una automatización está "pausada"?**
Los presets se instalan pausados a propósito, para que los revises antes de que empiecen a enviar.

**La IA no responde / no resume.**
Falta configurar la clave de IA del sistema (la pone el administrador). Sin ella, esos botones avisan
que no está disponible y el resto del sistema sigue funcionando normal.

**¿Los pacientes ven mis notas internas?**
No. Las notas internas y las @menciones son **solo para el equipo**.

---

*¿Dudas sobre una pantalla concreta? Búscala en la sección 4 por su nombre del menú.*
