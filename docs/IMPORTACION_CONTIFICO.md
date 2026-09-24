# Importación desde Contífico

Cómo se trae la contabilidad de Contífico, cómo se vuelve a correr y cómo
comprobar que lo importado cuadra con el origen.

## Credencial

En Contífico, **Configuración → API** entrega dos cadenas. La que sirve para leer
es la **Clave de sincronización**; el *API Token* devuelve `401` en estos
endpoints. Va en `server/.env`:

```
CONTIFICO_API_KEY=<clave de sincronizacion>
```

## Las tres fases

La importación separa *archivar* de *proyectar*: primero se guarda el JSON crudo
de Contífico y después se convierte en documentos del sistema. Así una corrección
en la proyección no obliga a volver a descargar.

| Fase | Comando | Qué hace |
| --- | --- | --- |
| Extraer | `node scripts/migrateContifico.js --phase=extract --clinic-name=Central --commit` | Descarga y archiva el crudo en `ContificoRecord`. |
| Proyectar | `node scripts/migrateContificoProject.js --clinic-name=Central --commit` | Crea cuentas, personas, productos, ventas, compras y asientos. |
| Completar | `node scripts/projectContificoSupplemental.js --clinic-name=Central --commit` | Cobros/pagos, roles de pago, capas de stock y notas de crédito/débito. |

Sin `--commit` los tres corren en seco y solo informan. Son idempotentes: volver a
correrlos actualiza lo que cambió en Contífico en vez de duplicarlo.

## La trampa de la paginación

Los endpoints v2 de Contífico **no garantizan un orden estable entre páginas**.
Mientras se recorre, las filas se desplazan: una pasada repite filas en los bordes
de página y, por cada repetida, se salta otra distinta. En una descarga completa
del 2026 eso eran del orden de 1 de cada 1.000 asientos.

No era un problema cosmético. La proyección trata la última extracción completa
como instantánea y **retira** lo que no aparece en ella, así que una fila perdida
por paginación terminaba borrada del sistema pese a seguir viva en Contífico.

`ContificoApi.pages()` lo corrige: compara las filas únicas con el `count` que
informa el propio endpoint y, si no llegan, repite la ventana con otro tamaño de
página —lo que mueve los bordes— hasta completarlas, emitiendo cada fila una sola
vez. Si aun así no se completa, la etapa se marca `INCOMPLETE` en
`ContificoMigrationRun` y **deja de contar como instantánea**, de modo que nada se
retira a partir de datos parciales.

## Comprobar que cuadra

```
node scripts/auditContificoLedger.js --clinic-name=Central
node scripts/auditContificoLedger.js --clinic-name=Central --from=01/01/2026 --through=31/12/2026 --detail=20
```

Es de solo lectura. Descarga los asientos del rango, los agrupa por código de
cuenta y los enfrenta al mayor local. Informa la diferencia cuenta a cuenta y
lista los asientos que están en un solo lado, con fecha, glosa e importes, para
poder explicar cada centavo.

Otros dos, que no consultan Contífico y sirven para revisar una carga ya hecha:

- `scripts/reconcileContifico.js` — inventario de lo archivado y lo proyectado.
- `scripts/reconcileContificoSnapshot.js` — compara el archivo crudo con las
  proyecciones.

## Al comparar contra un reporte de Contífico

Dos avisos que explican casi todas las "diferencias" que no lo son:

- **El rango.** El atajo *Año* del sistema toma 01/01 a 31/12. Si en Contífico se
  pidió otro corte —o al revés, si en el sistema se dejó el rango en la fecha de
  hoy— las cifras no pueden coincidir: en Contífico hay asientos con fecha
  posterior a hoy y solo entran en el rango que llegue hasta fin de año.
- **El momento.** Contífico se sigue moviendo. Un asiento registrado después de la
  extracción no está en el sistema hasta la siguiente. `auditContificoLedger.js`
  los lista uno a uno bajo «Solo en Contífico».

## Nómina

`/api/v1/rrhh/rol-pago/` exige `cedula`: **no hay forma de listar el rol de un
período entero**, ni por comprobante. La extracción tiene que saber a quién
preguntar, y la marca `es_empleado` de Contífico no alcanza —a quien sale de la
nómina se la quitan, y su rol histórico dejaría de llegar—. Por eso se consulta:

1. toda persona marcada `es_empleado`,
2. toda cédula que ya figure en un rol archivado (se autocura: quien entró una
   vez se sigue consultando), y
3. las que se pasen a mano con `--payroll-cedulas=0941502387,0950114694`.

Si en una nómina de Contífico aparece alguien que el sistema no muestra, casi
siempre es que esa persona **nunca** estuvo marcada `es_empleado` y por tanto
jamás se le preguntó. Se arregla de las dos formas: marcándola en Contífico, o
nombrándola una vez con `--payroll-cedulas` (a partir de ahí ya entra sola).

Los períodos que Contífico no tiene responden «Período solicitado no existe» y no
se archivan; los que sí existen pero sin esa persona, «La persona no se encuentra
registrada en el período solicitado».

Para volver a traer solo la nómina, sin repetir la descarga entera:

```
node scripts/migrateContifico.js --phase=extract --clinic-name=Central \
  --only=payroll_roles --from=01/01/2026 --commit
node scripts/projectContificoSupplemental.js --clinic-name=Central --only=payroll --commit
```
