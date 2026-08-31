# Registrar pacientes desde las fichas físicas escaneadas

En **Herramientas → Escáner de documentos** se acumulan PDF de las fichas de
*REGISTRO DE PACIENTES* rellenadas a mano. Este procedimiento las convierte en
pacientes del sistema. De cada ficha salen tres cosas:

| Se crea | Con qué |
|---|---|
| **Paciente** | nombres, apellidos, cédula, edad, celular (en *teléfono*), correo y dirección |
| **Ficha clínica** | los mismos datos + la **fecha escrita en el papel**, con un seguimiento que lleva el **documento adjunto** |
| **Observación** | la **última página** del PDF — la *hoja de seguimiento*, la tabla de fecha / servicio / costo / forma de pago / firma — en la pestaña **Observaciones** del paciente |

Se puede repetir tantas veces como haga falta: lo que ya está hecho se salta solo.

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
termine: lánzala suelta y déjala trabajando.

```bash
sudo -iu clinica bash -lc 'cd /var/www/clinica/server && nohup node scripts/importPatientsFromScans.js --datos=../data/fichas-escaneadas-2026-08-31.json --once --commit > /tmp/importar-fichas.log 2>&1 &'
tail -f /tmp/importar-fichas.log
```

## Paso 4 — Revisar lo dudoso

En **Pacientes** aparece un aviso con las fichas pendientes; también se llega por
`/patients/scan-review`. Ahí se ve el **PDF original al lado** de los campos, con
lo dudoso resaltado en ámbar y una nota de lo que se leyó. Al guardar salta sola a
la siguiente, y la corrección se aplica **al paciente y a su ficha clínica** a la vez.

---

## Un paciente puede tener varias fichas

El formulario nuevo no pide cédula y quien vuelve a consulta llena otra hoja, así
que la misma persona aparece en varias fichas. El importador la reconoce:

- **con cédula** → es la clave única de siempre;
- **sin cédula** → mismo **nombre** (da igual el orden de nombres y apellidos, las
  tildes o las mayúsculas) **y** mismo **celular**.

Al reconocerla **no se le tocan los datos** —los del sistema mandan sobre una
transcripción de letra manuscrita— pero **sí se le añade lo de esa ficha**: su
seguimiento con el documento y su observación con la hoja de seguimiento. **Sin
celular no se fusiona**: dos homónimos existen, y juntarlos mezcla dos historias.

## Lo que el proceso garantiza

- **No toca el escáner.** El original sigue en `/scanner` intacto. Es la única
  prueba de lo que decía el papel, y sin él una duda ya no se puede resolver.
  Lo que se adjunta al paciente son **copias reducidas** (1200 px): copiar tal cual
  6.000 fichas añadiría otros 12 GB al disco del VPS. La observación dice el nombre
  del documento por si hace falta ver el original con todo el detalle.
- **No dispara automatizaciones.** Importar un lote de pacientes antiguos no manda
  mensajes de bienvenida. El script crea el paciente con el modelo directamente, no
  por el controlador, así que el evento `patient_created` no se emite.
- **No pisa a nadie.** Si el paciente ya existe, no se crea otro: se le cuelga lo
  que aporta la ficha.
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
| `server/controllers/scanReviewController.js` | Listar pendientes y guardar correcciones |
| `client/src/pages/ScanReview.jsx` | La pantalla de revisión |
| `server/tests/scanPatientExtract.test.js` | Las reglas de validación |
| `server/tests/importPatientsFromScans.integration.test.js` | Las garantías de arriba |
| `server/tests/scanReview.integration.test.js` | La revisión |
