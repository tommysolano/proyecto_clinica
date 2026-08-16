# Registrar pacientes desde las fichas físicas escaneadas

En **Herramientas → Escáner de documentos** se acumulan PDF de las fichas de
*REGISTRO DE PACIENTES* rellenadas a mano. Este procedimiento las convierte en
pacientes del sistema, cada uno con su ficha clínica y un primer seguimiento que
lleva el PDF adjunto para que el doctor pueda ver el original.

Se puede repetir tantas veces como haga falta: las fichas ya importadas se
omiten solas.

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
2. Pulsa **Descargar ZIP**.
3. Descomprime el ZIP en una carpeta.

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

## Paso 3 — Importar

El JSON se sube al repositorio y el script corre en el servidor, que es donde
están los PDF originales.

```bash
# Ver qué haría, sin escribir nada:
cd /var/www/clinica/server && node scripts/importPatientsFromScans.js --datos=../data/fichas-escaneadas.json

# Aplicarlo:
cd /var/www/clinica/server && node scripts/importPatientsFromScans.js --datos=../data/fichas-escaneadas.json --commit
```

Por cada ficha crea:

| Se crea | Con qué |
|---|---|
| **Paciente** | nombres, apellidos, cédula, edad, celular (en *teléfono*), correo y dirección |
| **Ficha clínica** | los mismos datos + la **fecha escrita en el papel** |
| **Seguimiento** | esa misma fecha, con el **PDF adjunto** |

## Paso 4 — Revisar lo dudoso

En **Pacientes** aparece un aviso con las fichas pendientes; también se llega por
`/patients/scan-review`. Ahí se ve el **PDF original al lado** de los campos, con
lo dudoso resaltado en ámbar y una nota de lo que se leyó. Al guardar salta sola a
la siguiente, y la corrección se aplica **al paciente y a su ficha clínica** a la vez.

---

## Lo que el proceso garantiza

- **No toca el escáner.** El PDF se copia; el original sigue en `/scanner` intacto.
  Es la única prueba de lo que decía el papel, y sin él una duda ya no se puede resolver.
- **No dispara automatizaciones.** Importar un lote de pacientes antiguos no manda
  mensajes de bienvenida. El script crea el paciente con el modelo directamente, no
  por el controlador, así que el evento `patient_created` no se emite.
- **No pisa a nadie.** Si la cédula ya existe, la ficha se omite y se avisa.
- **Se puede repetir.** Las ya importadas se saltan, y si una falla a mitad se
  deshace lo que hubiera creado para que el reintento la haga limpia.
- **No rellena WhatsApp.** La ficha dice "celular" y eso va a *teléfono*. Dar por
  hecho que es WhatsApp metería a estos pacientes en el alcance de las campañas, y
  eso lo decide el usuario, no una importación.

## Dónde está cada cosa

| Archivo | Qué hace |
|---|---|
| `server/scripts/importPatientsFromScans.js` | El importador |
| `server/utils/scanPatientExtract.js` | Valida y normaliza (cédula, fecha, celular, correo) |
| `server/controllers/scanReviewController.js` | Listar pendientes y guardar correcciones |
| `client/src/pages/ScanReview.jsx` | La pantalla de revisión |
| `server/tests/scanPatientExtract.test.js` | Las reglas de validación |
| `server/tests/importPatientsFromScans.integration.test.js` | Las garantías de arriba |
| `server/tests/scanReview.integration.test.js` | La revisión |
