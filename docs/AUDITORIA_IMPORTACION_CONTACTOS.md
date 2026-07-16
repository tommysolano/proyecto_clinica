# Auditoría — Subida masiva de contactos (estilo Daplox / GoHighLevel)

**Objetivo del usuario:** subir contactos desde archivos Excel para poder mandarles mensajes de
WhatsApp, como se hace hoy en Daplox (47.733 contactos allí).

**Estado:** auditoría previa a implementar. Nada de esto está construido todavía.

---

## 1. Cómo funciona en Daplox / GoHighLevel

Un asistente de 4 pasos:

1. **Inicio** — elegir qué objetos importar: *Contactos*, *Oportunidades*, *Empresas*.
2. **Subir** — CSV (máx. 30 MB) + dos ajustes clave:
   - *Cómo importar*: **crear y actualizar** / solo crear / solo actualizar.
   - *Encontrar contactos existentes en función de*: la **clave de deduplicación**
     (`contact id, email, then phone`), configurable globalmente.
3. **Asignar** — el paso importante: una tabla que empareja **columna del archivo → campo del
   sistema**, mostrando *valores de muestra* de cada columna, el estado (*Asignado*), el objeto
   destino y un check **"Omita los valores vacíos"** por columna. Al pie: *"No importar datos a N
   columnas no asignadas"*.
4. **Verificar** — resumen y confirmación.

Después: los contactos caen en una lista con **etiquetas**, listas inteligentes y acciones en lote,
y las importaciones quedan en un historial.

**La idea de fondo:** el archivo manda. El sistema no exige una plantilla con cabeceras fijas; se
adapta a las columnas que traiga el usuario mediante el mapeo.

---

## 2. Qué ya tenemos (y es reutilizable)

| Pieza | Estado | Sirve para |
|---|---|---|
| `controllers/dataImportController.js` (822 líneas) | Sólido | Base del importador: lectura de Excel, errores por fila, upsert |
| Plantilla `clientes` → `Patient` | Funciona | Ya importa personas (nombres, teléfono, whatsapp, email…) |
| `Patient.tags[]` | Existe | Etiquetar lo importado |
| `Patient.marketing.whatsappOptIn / optOutAt` | Existe | Consentimiento y opt-out |
| `models/Segment.js` + `utils/segmentResolver.js` | Funciona | Filtrar por etiqueta/origen/opt-in → lista |
| `models/Campaign.js` + `MessageTemplate` | Funciona | Enviar a un segmento con plantilla aprobada |
| `utils/messaging.js` (puerta única) | Funciona | Ya bloquea opt-out, sin consentimiento y fuera de ventana 24h |
| Jobs `setInterval` cada 60 s (`index.js`) | Funciona | Patrón listo para procesar importaciones en segundo plano |

**Conclusión:** el camino *contacto → etiqueta → segmento → campaña con plantilla* **ya existe y
funciona**. Lo que falta es la puerta de entrada: meter los contactos.

---

## 3. Huecos frente a Daplox

Ordenados por lo que más duele:

1. **No hay mapeo de columnas.** Hoy las cabeceras deben coincidir con alias fijos (`CLI_ALIASES`:
   `nombres`, `apellidos`, `telefono`…). Un Excel exportado del teléfono o de Daplox trae otras
   cabeceras y no importa nada. **Este es el corazón de la función que pide el usuario.**
2. **`Patient` exige `firstName` y `lastName`.** Una lista de WhatsApp suele ser *teléfono + un
   nombre suelto* (o solo teléfono). Hoy esas filas fallan todas.
3. **La deduplicación es solo por cédula.** Los contactos de marketing no tienen cédula. Sin dedup
   por **teléfono**, reimportar el mismo archivo duplica todo.
4. **No hay normalización de teléfonos.** `099 123 4567` (Ecuador), `+593939273848` y
   `+573113380263` (Colombia) deben acabar en un formato único (E.164 sin `+`, como guardan las
   conversaciones: `593999111222`). Sin esto, ni se deduplica ni se puede enviar.
5. **Es síncrono y en memoria.** `multer` con 10 MB, ExcelJS carga el archivo entero y hace un
   `await` por fila. Con 47k filas: timeout de nginx (504) e importación a medias, sin saber por
   dónde iba. Daplox admite 30 MB.
6. **Solo `.xlsx`.** No lee CSV (Daplox exporta CSV).
7. **Rol equivocado:** `/data-import` es de `admin, contabilidad`. Marketing no puede entrar.
8. **Faltan modos de importación** (crear / actualizar / ambos) y *"omitir valores vacíos"*.
9. **No se pueden asignar etiquetas al importar** — justo lo que conecta con los segmentos.
10. **No hay historial ni deshacer.** Una importación de 47k mal mapeada no se puede revertir.
11. **No se cruza con las conversaciones existentes**: un número puede existir ya como chat sin
    paciente vinculado.

---

## 4. Los límites duros (esto es lo que de verdad manda)

**El cuello de botella no es importar: es enviar.** Se puede construir un importador perfecto y aun
así no poder mandar los mensajes. Por orden de gravedad:

1. **El número de Cloud API actual es de PRUEBA → máximo 5 destinatarios.** Tal como está hoy, no se
   puede enviar a una lista masiva, punto. Hace falta un número de producción verificado.
2. **Meta limita las conversaciones iniciadas por el negocio cada 24 h** por niveles
   (`WhatsappAccount.messagingLimit`: 250 / 1K / 10K / 100K). Un número nuevo arranca en
   **TIER_250**: a ese ritmo, 47.733 contactos son **~191 días**. Con TIER_1K son **~48 días**, y
   solo desde TIER_10K (~5 días) empieza a ser realista. El nivel sube solo con volumen y calidad
   sostenidos: no se puede pedir.
3. **Meta exige opt-in previo.** Mandar a una lista fría es la vía rápida a que el número baje de
   calidad (ya lo vigilamos: `qualityRating` GREEN/YELLOW/RED) y acabe **bloqueado**. Ojo:
   `Patient.marketing.whatsappOptIn` **por defecto es `true`**, así que un import masivo dejaría a
   47k contactos marcados como consentidos sin que nadie lo haya consentido.
4. **Fuera de la ventana de 24 h hace falta plantilla aprobada.** Esto ya está bien: la puerta
   `messaging.send` lo obliga y las campañas lo validan. No hay que tocarlo.
5. **Los números QR no sirven para esto.** Enviar en masa desde una sesión de WhatsApp Web es la
   otra vía rápida al baneo.

> **Recomendación:** que el importador ponga `whatsappOptIn: false` por defecto y obligue a declarar
> el **origen del consentimiento** para marcarlo en `true`. Es una fricción a propósito: protege el
> número, que es el activo del call center.

---

## 5. La decisión de arquitectura: ¿un contacto es un paciente?

En Daplox, *Contacto* es una entidad de marketing, distinta de un paciente. En nuestro sistema todo
el marketing cuelga de `Patient` (`Segment.entity` es un enum con un solo valor: `['patient']`).
Hay tres caminos:

### Opción A — Importar directamente como `Patient`
- ✅ Cero trabajo extra: segmentos, campañas y workflows funcionan tal cual.
- ❌ Mete 47k no-pacientes en la base clínica. Son **41 consultas a `Patient` en 14 ficheros**
  (dashboard, reportes, agenda, ficha clínica, `birthdayJob`…). Ejemplo concreto del daño:
  `birthdayJob` empezaría a mandar felicitaciones a 47k desconocidos, y los reportes contarían 47k
  "pacientes".

### Opción B — Modelo `Contact` nuevo, separado
- ✅ Limpio: marketing por un lado, clínica por otro. Se "promociona" a paciente al agendar.
- ❌ Obliga a duplicar `segmentResolver`, campañas y workflows para una segunda entidad. Es el
  camino largo.

### Opción C — `Patient` + bandera `isLead` (recomendada)
- Los importados entran como `Patient` con `isLead: true` (y `source: 'importado'`), y **todas las
  vistas clínicas los excluyen por defecto**; marketing los incluye. Al agendar una cita, deja de
  ser lead automáticamente.
- ✅ Reutiliza todo el motor de marketing sin duplicarlo.
- ⚠️ **El riesgo real está en el barrido**: hay que revisar las **41 consultas** (14 ficheros) y
  añadir el filtro. Si se olvida una, aparecen 47k leads donde no deben (o peor: se les manda algo).
- Mitigación: el filtro por defecto en un solo sitio + tests que fijen que dashboard, reportes y
  `birthdayJob` ignoran los leads.

**Recomiendo la C**, con la condición de tratar el barrido de los 14 ficheros como parte del trabajo,
no como un detalle.

---

## 6. Propuesta por fases

**Fase 1 — Importador con mapeo (el núcleo)**
- Modelo `ContactImport` (archivo, estado, mapeo, contadores, errores).
- Subida a disco (no memoria), CSV + XLSX, streaming.
- Endpoint de *análisis*: devuelve cabeceras + 3 valores de muestra por columna → alimenta el paso
  "Asignar".
- Asistente de 4 pasos en el front, calcado del flujo de Daplox.
- Normalización de teléfono a E.164 con país por defecto (Ecuador) y validación.
- Dedup configurable: teléfono / email / cédula.
- Etiquetas y `whatsappOptIn` + origen del consentimiento en el paso de subida.

**Fase 2 — Escala**
- Procesamiento en segundo plano por lotes (patrón `setInterval` que ya existe), con progreso en
  vivo por socket.io (ya tenemos la sala `callcenter`).
- Informe de errores descargable por fila.
- Historial de importaciones + **deshacer** (borrar/desetiquetar lo de un lote).

**Fase 3 — Envío responsable**
- Aviso en la campaña cuando el segmento supera el `messagingLimit` del número, con la estimación de
  días reales.
- Goteo automático respetando el nivel de Meta.

---

## 7. Lo que hay que decidir antes de escribir código

1. **¿Opción A, B o C?** (recomiendo C).
2. **¿Los importados son "pacientes" a efectos de reportes?** De esto depende todo el barrido.
3. **¿Qué hacemos con el opt-in?** (recomiendo `false` por defecto + declarar origen).
4. **¿Hay ya un número de producción de Cloud API,** o seguimos con el de prueba (5 destinatarios)?
   Sin esto, la función se puede construir pero no se puede usar de verdad.
