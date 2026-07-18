# Flujo de caja diario, operativo y proyectado

Dos vistas **separadas a propósito**, porque mezclarlas es la forma más fácil de contar el
mismo dinero dos veces:

| Pestaña | Qué muestra | De dónde sale |
|---|---|---|
| **Flujo diario proyectado** | lo que va a pasar, día a día | submayor (CxC/CxP) + partidas manuales + movimientos ya realizados del rango |
| **Movimientos reales** | lo que ya pasó | libro mayor (cuentas de caja y bancos) |

Todo lo calcula **un solo motor**: `server/services/cashFlowService.js`. La API, el detalle de
una celda y el Excel salen de ahí, así que no pueden discrepar. Consultar el flujo es de
**solo lectura**: no crea asientos, pagos ni aplicaciones (hay un test que lo verifica
reprocesándolo tres veces).

## Cómo se evita el doble conteo

Cada día suma dos cosas que **no pueden solaparse**:

1. lo **real**: los movimientos del mayor sobre las cuentas de caja/banco de ese día;
2. lo **proyectado**: el **saldo abierto** de las obligaciones cuya fecha efectiva cae ese día.

Pagar una CxP hace las dos cosas a la vez: crea el asiento (entra en 1) y reduce
`Payable.balance` (sale de 2). Por eso:

- una compra, su CxP y su pago **no** se cuentan tres veces;
- una factura cobrada a medias proyecta **solo el resto**;
- una factura cobrada del todo **desaparece** del futuro;
- una **venta al contado** no abre CxC (solo la porción a crédito la abre), así que su único
  registro es el cobro real;
- la **nómina** y las **declaraciones SRI** entran *exclusivamente* por su CxP (Fase 1): no se
  vuelve a sumar `Payroll.totalNeto` ni el total de la declaración. Un borrador de declaración
  no es una obligación y no aparece.

### Transferencias internas

Un traspaso entre dos cuentas **incluidas** (Caja → Banco, Banco A → Banco B) es un solo
asiento con un débito y un crédito, ambos de liquidez. Contándolo línea a línea inflaba a la
vez los ingresos y los egresos del día, aunque el efecto consolidado de caja fuera **cero**.

El motor **netea las líneas de liquidez de cada asiento**:

```
interno     = min(Σ entradas, Σ salidas)   → efecto consolidado nulo, no suma
externalIn  = Σ entradas − interno         → entrada real al conjunto
externalOut = Σ salidas  − interno         → salida real del conjunto
```

Así salen bien los cuatro casos: un traspaso entre cuentas incluidas no suma; salir hacia una
cuenta **no** incluida sí es egreso; entrar desde una no incluida sí es ingreso; y en un
traspaso con **comisión bancaria** (D BancoB 4.990 / D Comisión 10 / H BancoA 5.000) el
interno son 4.990 y queda un egreso real de 10, que es exactamente la comisión. Funciona
también con más de dos líneas de liquidez en el mismo asiento.

Las transferencias se **muestran** (matriz, movimientos reales y Excel) con su origen y su
destino, en una fila neutral marcada «no suma». Y no se duplican por existir a la vez el
asiento y el `BankTransaction`: las filas salen **solo** del asiento.

### Obligaciones vencidas antes del rango

Una obligación abierta **no puede desaparecer** por haber vencido antes del `desde`. Se
acumula en el **primer día del rango** (`overdueBucket: FIRST_DAY`), **una sola vez**,
marcada `acumuladoVencido` y `overdue`, conservando su `dueDate`, sus **días de mora reales**
y su `proyeccionOriginal`. Aplica también a los históricos **sin `dueDate`** cuyo fallback por
emisión sea anterior al rango. Reprogramarla dentro del rango la lleva a su nueva fecha
(sigue marcada como vencida); reprogramarla **más allá** del rango la deja fuera del horizonte,
que es lo correcto: el dinero se moverá después de la ventana.

## Fechas (ninguna se mezcla con otra)

| Campo | Qué es | ¿Se modifica? |
|---|---|---|
| `issueDate` | emisión del documento | no |
| `dueDate` | **vencimiento legal** | **nunca** |
| fecha efectiva | `dueDate`/planificada llevada a día hábil | calculada, no se guarda |
| `plannedPaymentDate` | cuándo se planea pagar | sí, reprogramando (auditado) |
| `plannedCollectionDate` | cuándo se planea cobrar | igual: es el mismo campo visto desde la CxC |
| `paidAt` / `collectedAt` | cuándo se movió el dinero de verdad | lo fija el pago |
| `accountingDate` | fecha de contabilización | la fija el asiento |

**Prioridad para proyectar**: fecha planificada → fecha efectiva → vencimiento → emisión
(este último es un *fallback documentado*, solo para históricos sin vencimiento; la fila
muestra `basedOn: EMISION` para que se vea).

`plannedCollectionDate` es un **alias** de `plannedPaymentDate` en el modelo `Receivable`:
es el mismo concepto —cuándo se mueve el dinero— en el otro sentido. Se comparte el
almacenamiento a propósito: dos campos para el mismo dato acabarían discrepando.

Reprogramar **no toca `dueDate`**. Una obligación vencida y reprogramada al futuro se sigue
mostrando como **VENCIDA** (con sus días de mora), solo que proyectada en otro día.

## Calendario

- **Lunes a sábado** son días válidos. El **sábado no se desplaza**.
- Un vencimiento en **domingo** se proyecta el **lunes**.
- Es configurable: apagar `includeSaturdays` convierte el sábado en no hábil y lo desplaza
  también. (El Excel de referencia solo tenía columnas de lunes a viernes.)
- **Feriados: no se inventan.** No hay catálogo oficial cargado, así que solo se aplica la
  regla de fin de semana. `CashFlowConfig.holidays` ya está preparado para cargarlos por
  clínica cuando se definan.

## Saldo inicial

Sale del **libro mayor**, nunca de un saldo tecleado ni de `BankAccount.bookBalance`:
se agregan los asientos **contabilizados** de las cuentas configuradas con fecha anterior al
primer día del rango. El saldo final de un día es el inicial del siguiente (roll-forward).

Las cuentas **no se deducen del nombre** («todo lo que diga banco»). Se toman de
`CashFlowConfig.cashAccounts`/`bankAccounts`; si están vacías, se resuelven por **rol
contable** (`caja`, `cajaChica`, `bancos`) más sus cuentas hijas. El conjunto se deduplica por
id, así que configurar a la vez una cuenta padre y una hija **no** duplica el saldo (cada
línea del asiento pertenece a una sola cuenta).

No hace falta una herramienta de carga inicial: el sistema **ya tiene** saldos contables
históricos. Si una clínica arranca a mitad de vida, el contador registra un **asiento de
apertura** normal desde la pantalla de Asientos; no se ha creado un segundo mecanismo
paralelo que pudiera duplicarlo.

## Día actual

El saldo inicial del primer día es el cierre del día **anterior**. La columna de hoy suma
los movimientos reales de hoy **y** las obligaciones pendientes de hoy. No hay doble conteo:
lo que ya se pagó hoy salió del saldo del submayor y solo cuenta como movimiento real.

## Clasificación

Prioridad (la fila dice **por qué** se clasificó así, en `clasificadaPor`):

1. **override** del documento (`CashFlowPlan.category`)
2. regla por **tercero** (proveedor / cliente)
3. regla por **cuenta contable** o concepto
4. regla por **origen** (`sourceModel` / `sourceAction` / tipo de documento)
5. **por defecto del módulo** (una CxP de compra → Proveedores; de nómina → Sueldos; de SRI → SRI)
6. **Sin clasificar** (se ve, no desaparece, y genera alerta)

Un préstamo, un impuesto o un gasto fijo **nunca** se clasifican buscando palabras en la
descripción. Existe un tipo de regla `DESCRIPTION`, pero solo si el usuario la crea a mano y
es el último nivel de prioridad. Los préstamos se marcan **explícitamente** (`origin: PRESTAMO`)
y su capital/interés/comisión **se capturan**, no se deducen de ningún asiento.

### Categorías de egreso y asignación de proveedores

Los egresos se subclasifican en cinco categorías por defecto (editables): **Proveedores de
inventario**, **Honorarios de doctores**, **Otros gastos**, **Gastos fijos** y **Préstamos**.
Una config existente incorpora las que le falten sin pisar personalizaciones
(`mergeExpenseDefaults`, idempotente).

Cada proveedor se **asigna** a una categoría desde el botón «＋ Agregar» de esa categoría en la
matriz (o desde el aviso de pendientes). La asignación es una regla `SUPPLIER` (nivel 2 de la
clasificación): desde ahí **todas** las CxP de ese proveedor caen en su categoría con su
vencimiento. Endpoints: `GET /cash-flow/suppliers` (disponibles/asignados), `POST
/cash-flow/suppliers/assign`, `POST /cash-flow/suppliers/unassign`.

- **Exclusión progresiva:** el selector «Agregar» solo ofrece proveedores con deuda pendiente
  que **no están asignados a ninguna categoría**. Al asignar a José, deja de aparecer como
  opción en las demás categorías. Quitarlo lo vuelve a hacer disponible en todas.
- **Proveedores pendientes de clasificar:** el recuadro a la derecha del resumen lista los
  **nombres** (sin montos) de los proveedores con CxP abierta y sin categoría. Al asignarlos,
  desaparecen. Mientras tanto su CxP sigue proyectándose en el default de módulo
  (Proveedores de inventario), así que ningún egreso se pierde.

## Saldo bancario inicial

El saldo del primer día tiene dos modos (`CashFlowConfig.openingBalanceMode`):

- **AUTO** (por defecto): la suma de las cuentas de caja/banco al cierre del día anterior,
  leída del **libro mayor** (auditable).
- **MANUAL**: un valor tecleado por la clínica (`openingBalanceManual`), útil al arrancar el
  módulo cuando el mayor aún no refleja el efectivo real. La proyección informa siempre el
  saldo AUTO aparte (`saldoInicialAuto`), y el resumen indica qué modo está activo.

## Partidas manuales y liquidación

Una previsión (`CashFlowManualItem`) **no genera asiento**: es una previsión, no un hecho
económico. Y **no se liquida cambiando su estado**. `POST /cash-flow/manual-items/:id/settle`
exige uno de dos caminos, y el estado se toca **al final**:

| `mode` | Qué hace |
|---|---|
| `CREAR` | Contabiliza el movimiento: pide cuenta de caja/banco, contrapartida, fecha, método y referencia; crea el **asiento balanceado** y el `BankTransaction`, todo en **una transacción**; solo entonces la partida pasa a `REALIZADO`. Idempotente por `Idempotency-Key`. Un fallo intermedio revierte todo y la partida sigue `PLANIFICADO`. |
| `VINCULAR` | Enlaza un movimiento **ya registrado** (`Payment`, `BankTransaction` o `JournalEntry`), validando **misma clínica**, **dirección** compatible, **importe** compatible y que ese movimiento **no respalde ya otra partida** (409). No crea nada. |

**Cancelar** una partida ya liquidada está **bloqueado**: no puede borrar ni reversar un
movimiento contable real. Hay que anular ese movimiento por su propia vía.

### Interfaz

Se liquida desde la pestaña **Partidas manuales** o desde el **detalle de una celda** (solo si
sigue `PLANIFICADO`). El modal (`_ManualSettleModal.jsx`) muestra qué se está liquidando y
ofrece los dos caminos. En `VINCULAR`, `GET /cash-flow/settlement-candidates` busca movimientos
reales por rango, importe, tercero o referencia: los que ya respaldan otra partida **se
muestran marcados** (`YA VINCULADO`, con el nombre de la partida) en vez de desaparecer, y los
de importe distinto se marcan con su **diferencia** y no se pueden elegir. La
`Idempotency-Key` es **por intención**: se reutiliza al reintentar y se renueva al cambiar el
formulario, así un doble clic no contabiliza dos veces y un cambio de contenido con la misma
clave devuelve **409** (nunca un `E11000`). Los estados llevan **texto**, no solo color.

## Ciclo de la CxC de una factura

Cobrar una factura reduce `Invoice.balance` **y** aplica al `Receivable`; **anular** el cobro
devuelve el saldo a **ambos** (`unapplyFromReceivable`). Sin esa simetría la CxC quedaba
reducida para siempre y el saldo desaparecía del aging y del flujo.

La aplicación guarda **dónde** se aplicó (`Payment.applications[].appliedTo`), porque cobrar
una factura enlazada a una venta reduce la cartera **canónica** (ver abajo). Anular devuelve el
saldo a **esa misma** cartera: reversar contra el documento en vez de contra la cartera real
dejaría las dos descuadradas para siempre.

### Anular un cobro ANTIGUO (sin `appliedTo`)

Los cobros históricos no dicen dónde se aplicaron, y el destino **no puede deducirse
recalculando el documento canónico con los saldos de hoy**: esos saldos ya incluyen el efecto
del cobro que se está anulando, así que sería razonar en círculo. Se reconstruye por
**evidencia** (`legacyUnapplyTarget`): el **residuo** de cada cartera es lo aplicado que **no**
explican los demás cobros vigentes.

| Evidencia | Qué se hace |
|---|---|
| El residuo de **una sola** cartera es exactamente el importe del cobro | Se des-aplica **ahí**. |
| El residuo de **las dos** lo es | Es el mismo cobro **espejado** en el par: se devuelve a las dos, pero el efecto **económico es UNO** (solo la canónica suma en el flujo y en el aging). |
| **Ninguna** refleja nada sin explicar (residuos 0) | El cobro nunca llegó al submayor (bug histórico): se anula **sin tocar** la cartera. |
| Hay saldo aplicado que **no cuadra** con este cobro | Se **bloquea** la anulación (**409**, error contable controlado) y se pide conciliación manual. **Nada** se modifica: ni `Payment`, ni banco, ni asiento, ni `Sale`, ni `Invoice`, ni cartera (todo va dentro de la transacción). |

A un cobro histórico **no se le toca `Sale.balance`**: no se puede saber si llegó a bajarlo.

## Obligaciones económicas: una venta y su factura son UNA sola

`Sale.invoice` enlaza una venta con su factura. El script histórico
`migrateCarteraToSubledger` abría cartera para toda venta a crédito con saldo **y** para toda
factura con saldo, sin mirar ese vínculo: una venta a crédito facturada quedó con **dos CxC
para una sola obligación económica**.

La resolución vive en **un solo sitio** —`services/receivableObligations.js`— y la consumen el
**motor del flujo**, la **antigüedad de cartera** (`ar-aging`), su **exportación** y el
**cobro/anulación** de una factura. No hay una segunda copia de la regla en ningún controlador.

**Identidad económica inequívoca o nada**: solo se vinculan por `Sale.invoice` y misma clínica.
Nunca por importe, cliente, fecha o número iguales.

| Clasificación | Cuándo | Qué se hace |
|---|---|---|
| `SAFE_DUPLICATE` | Ninguna cartera tiene cobros, o **las dos reflejan los mismos cobros** (mismo `Payment._id`). | Se consolida: canónica la **venta**. Consolidable automáticamente. |
| `DIVERGENT_BUT_RESOLVABLE` | Los cobros están aplicados **solo en una** de las dos. | Manda **la que tiene la actividad real**, no siempre la venta: si los cobros fueron a la factura, la canónica es la factura. |
| `AMBIGUOUS` | Aplicaciones distintas en ambas, importes que no concilian, o una anulación reflejada en una sola. | **No se oculta nada**: alerta `CXC_DUPLICADA_AMBIGUA`, se muestran las **dos referencias** y el motivo, la consolidación automática queda **bloqueada** y el total usa una política **conservadora** (ver abajo). |

**Saldo económico** = importe original − **cobros reales únicos**. Los cobros se deduplican por
`Payment._id`: el mismo cobro reflejado en los dos submayores cuenta **una vez**. En los casos
`AMBIGUOUS` se toma el **mayor cobro demostrable** (máximo entre lo aplicado en cada cartera y
la suma de cobros únicos) y el **menor importe original**, de modo que la cartera nunca quede
sobrestimada.

### Confirmado ≠ estimado

Un saldo ambiguo es una **estimación conservadora**, no cartera conciliada, y **nunca** se
presenta como tal. El resolver, la API, el aging y el Excel exponen tres cifras separadas:

| Campo | Qué es |
|---|---|
| `confirmedBalance` | Obligaciones resueltas de forma segura. |
| `ambiguousEstimatedBalance` | Estimación conservadora de las ambiguas. **Requiere conciliación humana.** |
| `operationalBalance` | Lo que usa el flujo de caja (`confirmed + ambiguous`). |
| `ambiguousCount` | Cuántas obligaciones están sin resolver. |

El **aging** muestra una fila por obligación (`Venta + Factura`) con el **mismo saldo que el
flujo**, los **vínculos a la venta, la factura y las dos carteras**, el **estado de
resolución**, la **fórmula** usada y el **motivo** de la ambigüedad. Cada rango de edad declara
cuánto de su saldo es estimado (`totals.confirmed` / `totals.ambiguous`), los totales concilian
con el detalle y el Excel —mismo resolver— añade las columnas *Resolución*, *Saldo confirmado*,
*Saldo ambiguo estimado*, *Saldo operativo*, *Motivo* y *Requiere revisión*, más una sección de
resumen con los tres totales.

El **flujo** puede seguir proyectando el saldo operativo (es conservador), pero la fila va
marcada como **estimada**, permite abrir **ambas referencias** y levanta la alerta
`CXC_DUPLICADA_AMBIGUA` con el importe estimado. `totales.ingresosEstimados` dice qué parte de
los ingresos proyectados **no es un cobro confirmado**.

**No se corrige la cartera automáticamente**: `scripts/diagnoseDuplicateReceivables.js` (solo
lectura) reporta cada par con importes, saldos, aplicaciones, cobros únicos, anulaciones,
clasificación, motivo, saldo económico sugerido y si es corregible solo. Fusionar documentos
con pagos repartidos destruiría historia contable: es una decisión del contador. La migración
ya **no** vuelve a crear la segunda CxC.

## Auditoría

Reprogramar, reclasificar, excluir o cambiar el importe previsto queda en `history[]` con
**valor anterior, valor nuevo, usuario, fecha y motivo**. El motivo es **obligatorio** para
reprogramar y para excluir.

## Excel

Cuatro hojas, todas del mismo servicio (los filtros aplicados en pantalla se aplican también
a la exportación):

- **Flujo** — fechas en columnas, categorías/subcategorías en filas, saldo inicial, totales y
  saldo proyectado; encabezado y primera columna congelados.
- **Saldos bancarios** — código, nombre, tipo, saldo inicial y fecha de corte, más el total
  consolidado. **No se inventa la columna «cheques posfechados»** del Excel de referencia:
  no existe una entidad de cheque posfechado en el sistema y no se rellena con datos falsos.
- **Detalle** — una fila por documento; su suma **concilia** con la hoja Flujo (hay un test).
- **Movimientos reales**.

## Diferencias conscientes con el Excel de referencia

Al comparar las fórmulas del Excel contra el sistema aparecieron dos cosas:

1. **`TOTAL INGRESOS` del Excel es `SUM(B10:B17)` y la fila 18 es `PRESTAMO`**: los préstamos
   recibidos **no se están sumando** a los ingresos del día. Es un error de la hoja. El
   sistema **sí** los suma (categoría `Préstamos recibidos`, marcada como préstamo).
2. El Excel solo tiene columnas de **lunes a viernes** (ni un sábado en 216 columnas) y las
   de enero están tecleadas con el **año 2025 en lugar de 2026**. El sistema aplica la regla
   acordada (lunes a sábado) y deja el sábado configurable.

## Vencimiento de una compra (días de crédito)

Fuente **única**: `utils/purchaseDueDate.js`. Todos los caminos que abren la CxP de una compra
(creación, actualización, autorización, importación XML y los pagos que abren cartera legacy)
resuelven la fecha ahí, con esta prioridad:

1. `PurchaseInvoice.fechaVencimiento` explícita
2. días de crédito pactados **en la compra** (`PurchaseInvoice.creditDays`)
3. días de crédito **del proveedor** (`Supplier.creditDays`)
4. nada → la CxP queda **sin vencimiento** (no se inventa una fecha) y se proyecta por la
   emisión, marcada `basedOn: EMISION`

```
dueDate = fechaEmision + creditDays días CALENDARIO
```

El vencimiento **legal no se lleva a día hábil**: un sábado sigue siendo sábado y un domingo
sigue siendo domingo. El desplazamiento (domingo → lunes) es la fecha **efectiva** y se
calcula al proyectar, sin tocar el dato.

Una fecha **derivada** de los días de crédito **no pisa** la que ya tenga la CxP (pudo
corregirse a mano). Una fecha **explícita** de la compra sí se propaga.

## Migraciones y comandos

```bash
# Completa el vencimiento de las CxP de compras que no lo tienen (dry-run por defecto)
node scripts/backfillPayableDueDates.js --clinic=<id>
node scripts/backfillPayableDueDates.js --clinic=<id> --commit

# Reporta CxC duplicadas entre una venta y su factura (SOLO LECTURA, no corrige)
node scripts/diagnoseDuplicateReceivables.js --clinic=<id>
```

El backfill es idempotente, **nunca** sobrescribe una fecha existente y **nunca** toca CxP
pagadas o anuladas (solo las reporta). Informa: encontradas, elegibles, calculadas desde la
compra, calculadas desde el proveedor, omitidas, cerradas, sin proveedor, sin plazo y
huérfanas.

## Riesgos abiertos

- **Feriados**: sin catálogo. Solo se aplica la regla de fin de semana.
- **CxC duplicadas históricas**: el flujo y la antigüedad ya las cuentan una sola vez, pero la
  **cartera sigue teniendo los dos documentos** en la base. Consolidarla (borrar/fusionar) es
  una decisión contable: el diagnóstico dice cuáles son seguras y cuáles no.
- **Casos `AMBIGUOUS`**: se informan aparte (estimados, nunca como cartera confirmada) pero
  **nadie los resuelve solo**. Hace falta que un humano decida qué cartera dice la verdad; no
  hay todavía una pantalla para hacerlo (se corrige por el documento correspondiente). Mientras
  tanto, **anular un cobro antiguo de esas obligaciones está bloqueado**.
- El **buscador de movimientos** para vincular una partida limita a 100 candidatos por tipo:
  con mucho volumen conviene acotar por fecha o texto.
