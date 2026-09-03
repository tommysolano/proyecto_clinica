# Registrar pacientes desde las fichas físicas escaneadas

En **Herramientas → Escáner de documentos** se acumulan PDF de las fichas de
*REGISTRO DE PACIENTES* rellenadas a mano. Este procedimiento las vuelca en el
sistema. De cada ficha salen cuatro cosas:

| Se crea | Con qué |
|---|---|
| **Paciente** | el que YA existe (ver abajo) o, si no está, uno nuevo con nombres, apellidos, cédula, edad, celular (en *teléfono*), correo y dirección |
| **Ficha clínica** | los mismos datos + la **fecha escrita en el papel**, con un primer seguimiento que lleva adjunta la **primera página**: la ficha de registro |
| **Observación** | las **páginas 2 en adelante** en un solo PDF — las *hojas de seguimiento*, la tabla de fecha / servicio / costo / forma de pago / firma — en la pestaña **Observaciones** del paciente |
| **Vínculo con el CRM** | si esa persona ya nos había escrito, su chat queda vinculado al paciente y pasa a llamarse como él: el call center agenda sin registrarlo |

Un escaneo de **una sola página** no deja observación: esa página es la ficha y ya
va en el seguimiento.

Se puede repetir tantas veces como haga falta: lo que ya está hecho se salta solo.

## A quién pertenece cada ficha

Casi todos los pacientes **ya están** en el sistema: entraron por la API de
Contífico con la cédula y el teléfono tecleados por una persona. Estas fichas son
de esas mismas personas, así que lo primero es reconocerlas. Se prueba en este
orden, de más fuerte a más flojo:

1. **cédula**
2. **nombre + celular**
3. **nombre + correo**
4. **nombre a secas**, y solo si en toda la base hay UN paciente que se llame así

Si hay **dos pacientes con el mismo nombre completo**, la ficha se **aparta**: el
nombre ya no identifica a nadie y meterla en la historia de la que no es no lo
detecta nadie a simple vista. Salen en el informe como *omitidas*.

## El dato del sistema manda, pero el papel no se tira

Al reconocer a un paciente **no se pisa nada de lo que ya tiene**. Es letra
manuscrita transcrita a ojo: en la tanda de septiembre, de las cédulas que no
coincidían, **el 90 % ni siquiera pasaba el dígito verificador** — el error era de
lectura, no del sistema. Pisar habría degradado miles de campos buenos.

Lo que sí pasa:

- se **completa** lo que el paciente tiene vacío (sobre todo la **edad**, que
  Contífico no trae);
- lo que **difiere** se guarda en `scanImport.alternos` y la ficha del paciente
  enseña **los dos valores** («En la ficha física: …»);
- ese campo queda marcado y el paciente aparece en **Clientes → Fichas por
  revisar**, con el PDF al lado; ahí se adopta el valor del papel de un clic, y al
  guardar el otro desaparece.

Comparar es tan importante como el dato: `DURAN` y `Durán` son lo mismo, y por eso
las mayúsculas y las tildes no cuentan como discrepancia.

---

## Por qué no lo hace el sistema solo

La transcripción la hace el asistente (Claude Code), **no el servidor**. Es una
decisión deliberada: leer letra manuscrita desde el backend obliga a contratar la
API de Anthropic aparte del plan que ya se paga, con un costo por documento. Como
esto se hace por tandas y de forma puntual, sale gratis hacerlo desde la sesión
del asistente.

La consecuencia práctica: **la importación es un procedimiento asistido**, no un
botón de la aplicación. Los cuatro pasos son los de abajo.

---

## Paso 1 — Descargar los PDF

En **Herramientas → Escáner de documentos → Mis documentos**:

1. Selecciona las fichas que quieres importar (o todas).
2. Pulsa **Descargar ZIP**. Si son muchas, salen varios ZIP numerados
   (`escaneos_<fecha>_parte_01_de_42.zip`).
3. Descomprime los ZIP en una carpeta.

Dentro del ZIP cada archivo se llama como el documento en el escáner. Ese nombre
es lo que después empareja cada PDF con su ficha en la base, así que **no hay que
renombrar los archivos**.

## Paso 2 — Pedirle al asistente que los lea

Dile en qué carpeta quedaron. El asistente los lee y genera un JSON así:

```json
{
  "fichas": [
    {
      "documento": "Ficha Jose Cuzco",
      "fecha": "1-06-26",
      "nombres": "José",
      "apellidos": "Cuzco Espinoza",
      "cedula": "0905103495",
      "edad": "71",
      "celular": "0994967491",
      "correo": "josecuzco@gmail.com",
      "direccion": "Barrio Garay",
      "dudosos": ["direccion"]
    }
  ]
}
```

`dudosos` son los campos que se leyeron con poca seguridad. La regla al transcribir
es **marcar de más antes que adivinar**: un dígito inventado en una cédula no da un
error, da un paciente equivocado.

> **Hay dos formularios en circulación.** El clásico tiene casilla de CÉDULA; el
> nuevo (FECHA / NOMBRE / EDAD / DIRECCIÓN / MOTIVO / CORREO / TELÉFONO) **no**.
> En las fichas del nuevo, `cedula` va vacía y el paciente se reconoce por nombre
> y celular (ver más abajo).

## Paso 3 — Importar

El JSON se sube al repositorio y el script corre en el servidor, que es donde
están los PDF originales.

```bash
# Ver qué haría, sin escribir nada:
cd /var/www/clinica/server && node scripts/importPatientsFromScans.js --datos=../data/fichas-escaneadas.json

# Aplicarlo:
cd /var/www/clinica/server && node scripts/importPatientsFromScans.js --datos=../data/fichas-escaneadas.json --commit

# Por trozos (útil en tandas de miles: se puede parar y seguir):
… --commit --desde=500 --limite=100
```

Una tanda de miles de fichas tarda **horas** (por cada una se reduce la foto de
cada página con Chromium). No la metas en un paso del despliegue que espere a que
termine: `deploy.sh` la lanza **al final y en segundo plano**, ya con el backend
reiniciado, para que la clínica siga trabajando mientras avanza.

```bash
tail -f /home/clinica/import-fichas.log
```

Sin tocar el VPS también se puede: **Actions → «Ensayo fichas escaneadas»**
(`.github/workflows/ensayo-fichas.yml`) corre el dry-run allí y devuelve el
informe, además del estado de cada tanda en `onetimetasks`. Empieza con
`limite=50`, que tarda segundos.

## Paso 4 — Revisar lo dudoso

En **Pacientes** aparece un aviso con las fichas pendientes; también se llega por
`/patients/scan-review`. Ahí se ve el **PDF original al lado** de los campos, con
lo dudoso resaltado en ámbar y una nota de lo que se leyó. Al guardar salta sola a
la siguiente, y la corrección se aplica **al paciente y a su ficha clínica** a la vez.

---

## Un paciente puede tener varias fichas

El formulario nuevo no pide cédula y quien vuelve a consulta llena otra hoja, así
que la misma persona aparece en varias fichas. Se reconoce con la escalera de
arriba (da igual el orden de nombres y apellidos, las tildes o las mayúsculas) y
se le **añade** lo de cada ficha: su seguimiento con la ficha de registro y su
observación con las hojas. Si una hoja trae un dato distinto, se guarda como *el
otro valor* — no se sobrescribe el anterior.

## El chat del CRM

Si el número de la ficha es el de un chat que ya existe, ese chat queda
**vinculado al paciente** y toma su nombre. Para eso: el call center abría un chat
llamado *"Karol❤️"* y, para poder agendar, tenía que registrar al paciente a mano
aunque llevara meses en el sistema.

Dos cosas que **no** hace: pisar un nombre que escribió un agente (eso manda sobre
cualquier vía automática) y robarle el chat a otro paciente ya vinculado. Y no
crea chats ni envía nada: solo vincula los que ya están.

## Lo que el proceso garantiza

- **No toca el escáner.** El original sigue en `/scanner` intacto. Es la única
  prueba de lo que decía el papel, y sin él una duda ya no se puede resolver.
  Lo que se adjunta al paciente son **copias reducidas** (1200 px): copiar tal cual
  6.000 fichas añadiría otros 12 GB al disco del VPS. La observación dice el nombre
  del documento por si hace falta ver el original con todo el detalle.
- **No dispara automatizaciones.** Importar un lote de pacientes antiguos no manda
  mensajes de bienvenida. El script crea el paciente con el modelo directamente, no
  por el controlador, así que el evento `patient_created` no se emite.
- **No pisa a nadie.** Si el paciente ya existe, no se crea otro y no se le
  sobrescribe ningún dato: se le completa lo vacío y lo que difiere queda a la
  vista como *el otro valor*.
- **No filtra datos de contacto.** El otro valor es el mismo dato del paciente
  (cédula, teléfono, correo, dirección), así que el servidor lo censura por rol
  igual que el campo original: sin eso, `scanImport.alternos` sería una puerta de
  atrás para ver el teléfono que se le oculta a un doctor.
- **Se puede repetir.** Cada pieza tiene su marca — el paciente por `scanImport.scan`,
  la observación por su índice único, el seguimiento por el nombre del adjunto — así
  que un reintento completa lo que falte sin duplicar nada. Si una ficha falla a
  mitad, se deshace lo que hubiera creado.
- **Un escaneo de una sola página no genera observación**: esa única página es la
  ficha, que ya va en el seguimiento; no hay hoja de seguimiento que colgar.
- **No rellena WhatsApp.** La ficha dice "celular" y eso va a *teléfono*. Dar por
  hecho que es WhatsApp metería a estos pacientes en el alcance de las campañas, y
  eso lo decide el usuario, no una importación.

## Dónde está cada cosa

| Archivo | Qué hace |
|---|---|
| `server/scripts/importPatientsFromScans.js` | El importador |
| `server/utils/scanPatientExtract.js` | Valida y normaliza (cédula, fecha, celular, correo) y arma la clave de nombre |
| `server/utils/scanMedia.js` | Saca las páginas del PDF, las reduce y las vuelve a empaquetar |
| `server/models/Patient.js` | `scanImport.alternos`: el otro valor, el que dijo el papel |
| `server/controllers/scanReviewController.js` | Listar pendientes y guardar correcciones |
| `client/src/pages/ScanReview.jsx` | La pantalla de revisión (adopta el valor del papel de un clic) |
| `client/src/pages/PatientDetail.jsx` | La ficha del paciente, que enseña los dos valores |
| `.github/workflows/ensayo-fichas.yml` | Ensayo en el VPS sin escribir nada |
| `server/tests/scanPatientExtract.test.js` | Las reglas de validación |
| `server/tests/importPatientsFromScans.integration.test.js` | Las garantías de arriba |
| `server/tests/scanReview.integration.test.js` | La revisión |
