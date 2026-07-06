# Auditoría global de integración contable — Clínica (Ecuador)

> **Objetivo:** verificar módulo por módulo que cada operación importante (1) genere asiento
> cuando corresponde, (2) resuelva cuentas desde configuración/categorías y no manualmente,
> (3) alimente el libro mayor, (4) tenga trazabilidad al documento origen, (5) afecte
> CxC/CxP/bancos/inventario/activos/nómina/SRI según corresponda, (6) no duplique
> contabilización y (7) no deje movimientos aislados sin asiento.
>
> **Alcance:** auditoría + documentación + guardas + trazabilidad crítica + pruebas de
> integración. **No** re-implementa módulos (ver §K de limitaciones).
>
> **Fecha de auditoría:** 2026-07-05. **Rama:** `main`.
>
> **Actualización (cierre de críticos):** se implementaron los pendientes críticos
> **A** (idempotencia de pagos) y **B** (bloqueo de doble registro de compras), y se
> **endureció** **C** (pago de nómina sin banco). Ver §A-idempotencia, §B-duplicados y
> §Nómina. Las tablas de esta auditoría ya reflejan el estado corregido.

---

## 0. Cómo está construida la contabilidad (fundamentos verificados)

Toda la contabilización pasa por un único motor: [`server/utils/accounting.js`](../server/utils/accounting.js)
y el catálogo de roles [`server/utils/accountMap.js`](../server/utils/accountMap.js).

| Mecanismo | Dónde | Garantía que da |
|---|---|---|
| `createEntry({source, sourceModel, sourceRef, sourceAction, lines, date})` | accounting.js:265 | Un solo punto de creación de asientos; valida partida doble, cuentas activas y movibles, período abierto. |
| **Idempotencia** por `sourceModel + sourceRef + sourceAction` | accounting.js:251, 283 | Re-ejecutar la misma acción devuelve el asiento existente (no duplica). Respaldo con índice único (error 11000 → devuelve el existente). |
| `reverseEntry` | accounting.js:322 | Reversa conservando historia (`isReversed`, `reversedBy`); no reversa un reverso; no reversa dos veces. |
| `assertPeriodOpen(clinic, date)` | accounting.js:68 | Bloquea contabilizar en período cerrado. |
| `getAccount(clinic, role)` | accountMap.js:62 | Resuelve la cuenta por **rol configurable** (AccountingConfig) con fallback al código estándar; auto-crea la cuenta del plan si falta. |
| `applyToBalances` / `recomputeBalances` | accounting.js:31, 364 | Mantiene `AccountBalance` materializado por cuenta/mes; recomputable desde los asientos. |

**Conclusión de fundamentos:** la base es sólida. La mayoría de módulos ya cumplen los 7
criterios. Los hallazgos de esta auditoría son puntuales (no estructurales).

---

## A. Matriz de integración contable

Nomenclatura: `D` = Debe, `H` = Haber. "Rol" = cuenta resuelta por `getAccount` (configurable).
Trazabilidad = `source` / `sourceModel` / `sourceRef` / `sourceAction` del `JournalEntry`.

### Ventas / Facturación — [`saleController.js`](../server/controllers/saleController.js)

| Acción | Asiento esperado | Cuentas | Trazabilidad | Estado | Corrección |
|---|---|---|---|---|---|
| Crear venta contado (efectivo/tarjeta/transf.) | D caja/tarjetasPorLiquidar/banco · H ingresoProductos + ingresoServicios · H ivaVentas · (D descuentoVentas) · D costoProductos · H inventario | Roles + `bank.chartAccount`/`card.chartAccount` | `VENTA/Sale/{id}/POST` | ✅ Correcto | — |
| Crear venta crédito | ídem con D clientes; abre `Receivable` (CxC) | Rol `clientes` | ✅ + subledger | ✅ | — |
| Venta de paquete (ingreso diferido) | H ingresoDiferido en lugar de ingreso; crea `DeferredIncome` | Rol `ingresoDiferido` | `Sale` + `DeferredIncome` | ✅ | — |
| Baja de stock / kardex | Consume capas FIFO → COGS exacto; `InventoryMovement` salida | — | `Sale` | ✅ | — |
| Cobro de venta crédito (`collectSale`) | D caja/banco · H clientes; aplica a `Receivable`; `BankTransaction` si banco | Rol `clientes` + `bank.chartAccount` | `COBRO/Sale/{id}/COLLECT:{key}` | ✅ | — |
| Anular venta | Reversa asiento venta + cobros + ingreso diferido; devuelve kardex; revierte tratamiento; anula BankTx; cierra CxC | — | reversos | ✅ | — |
| Doble-submit | `idempotencyKey` único por clínica → devuelve la venta existente | — | — | ✅ | — |
| Editar asiento de venta | Reversa y recrea asiento manual cuadrado | libre (validado) | `VENTA/Sale/EDIT:{ts}` | ✅ | — |

### Facturación electrónica — [`invoiceController.js`](../server/controllers/invoiceController.js) / módulo EC

| Acción | Asiento | Trazabilidad | Estado | Corrección |
|---|---|---|---|---|
| Emitir factura electrónica de una venta | **No** genera asiento propio: el asiento contable es el de la `Sale` | `Invoice` ligado a `Sale` | ✅ Sin doble conteo | — |
| Anular factura AUTORIZADA | Reversa la venta asociada (`reverseSaleTx`) | reversos `Sale` | ✅ | — |

### Compras — [`purchaseInvoiceController.js`](../server/controllers/purchaseInvoiceController.js)

| Acción | Asiento esperado | Cuentas | Trazabilidad | Estado | Corrección |
|---|---|---|---|---|---|
| Compra de inventario | D inventario (categoría) · D ivaCompras (crédito tributario) · H proveedores · H retenciones por pagar | `InventoryCategory.assetAccount` (estricto) + roles | `COMPRA/PurchaseInvoice/{id}/POST` | ✅ | — |
| Compra de activo fijo | D activo (categoría) · D ivaCompras · H proveedores; crea `FixedAsset` (snapshot de categoría) | `InventoryCategory.assetAccount` | `PurchaseInvoice` + `FixedAsset` | ✅ | — |
| Compra de gasto | D gasto (cuenta/distribución) · D IVA · H proveedores | Cuenta de línea / `supplier.defaultExpenseAccount` | `COMPRA/...` | ✅ | — |
| IVA no deducible | D ivaComprasNoCredito (al gasto) | Rol `ivaComprasNoCredito` | — | ✅ | — |
| Retenciones por línea | H retRentaPorPagar / retIvaPorPagar (cuenta de la regla) | `RetentionRule.payableAccount` | cabecera derivada de líneas (fuente única) | ✅ Sin doble conteo | — |
| Entrada de kardex | capa valorada por compra; `InventoryMovement` entrada | — | `PurchaseInvoice` | ✅ | — |
| CxP | Abre `Payable` = total − retenciones | Rol/`supplier.defaultPayableAccount` | ✅ subledger | ✅ | — |
| Editar / Anular compra | Reversa asiento, revierte kardex, borra activos sin depreciar, cierra CxP | — | reversos | ✅ | — |
| Import TXT/XML SRI | Deja `POR_AUTORIZAR` con montos SRI exactos; dedup por clave de acceso | — | — | ✅ | Ver §D (dedup manual+import) |

### Inventario / Kardex — [`inventoryAdvancedController.js`](../server/controllers/inventoryAdvancedController.js)

| Acción | Asiento | Cuentas | Trazabilidad | Estado | Corrección |
|---|---|---|---|---|---|
| Traslado entre bodegas | **Sin asiento** (no cambia valor total; reubica capas) | — | `InventoryMovement traslado` | ✅ Correcto (no requiere asiento) | — |
| Toma física — sobrante/faltante | D/H inventario ↔ mermaInventario (neto) | Roles `inventario`, `mermaInventario` | `AJUSTE/PhysicalCount/{id}/CONFIRM` | ✅ | Código muerto legacy con cuentas fijas (`1.1.04.01`,`6.1.99`) — inalcanzable; ver §D/limpieza |
| Baja de activo (`disposeAsset`) | D dep.acumulada · D caja/banco · D/H pérdida/ganancia · H activo | **Códigos fijos** `1.1.01.01`/`6.1.99`/`4.2.02` | `AJUSTE/FixedAsset/{id}/DISPOSE` | ⚠️ **CORREGIDO** → ahora roles `caja`/`otrosGastos`/`otrosIngresos` | Hecho en esta auditoría |

### Depreciación — [`inventoryAdvancedController.runDepreciation`](../server/controllers/inventoryAdvancedController.js)

| Acción | Asiento | Cuentas | Trazabilidad | Estado | Corrección |
|---|---|---|---|---|---|
| Depreciación mensual | D gasto depreciación · H depreciación acumulada (consolidado por cuenta) | Snapshot del activo (o categoría) | `DEPRECIACION/FixedAsset/{primerActivo}/DEPRECIATION:{período}` | ✅ Idempotente por período; no baja de residual | `sourceRef` apunta al **primer** activo del lote (deep-link parcial) — ver §C |

### Bancos — [`bankController.js`](../server/controllers/bankController.js)

| Acción | Asiento | Cuentas | Trazabilidad | Estado | Corrección |
|---|---|---|---|---|---|
| Movimiento (depósito/retiro/comisión/interés/cheque) | D/H banco ↔ contraparte por tipo | `bank.chartAccount` + rol por tipo | `BANCO/BankTransaction/{id}/POST` | ✅ | — |
| Transferencia entre bancos | 1 solo asiento D banco destino · H banco origen; 2 `BankTransaction` ligadas | `bank.chartAccount` | `BANCO/BankTransaction/{id}/TRANSFER` | ✅ | — |
| Depósito de ventas efectivo | D banco · H caja | Rol `caja` | `BankTransaction/CASH_DEPOSIT` | ✅ | — |
| Conciliación (por corte + import extracto) | Movimientos creados por partidas del extracto llevan asiento | rol interés/comisión | `BankTransaction/STATEMENT` | ✅ | — |
| Anular movimiento | Reversa asiento, marca `voided`, ajusta `bookBalance` | — | reversos | ✅ | — |

### Caja — [`cashClosingController.js`](../server/controllers/cashClosingController.js)

| Acción | Asiento | Cuentas | Trazabilidad | Estado | Corrección |
|---|---|---|---|---|---|
| Movimiento de caja (ingreso/gasto/retiro/depósito) | D/H caja ↔ contraparte; depósito crea `BankTransaction` | Rol `caja` + contraparte | `CAJA/BANCO · CashMovement` | ✅ | Asiento sin `sourceAction` (manual, sin idempotencia) — aceptable |
| Cierre de caja (diferencia) | D faltanteCaja / H caja (faltante) · D caja / H sobranteCaja (sobrante) | Roles | `CIERRE/CashClosing/{id}/DIFFERENCE` | ✅ Efectivo esperado = fondo + neto de Caja en el mayor | — |

### Cuentas por cobrar (CxC) — subledger `Receivable` + [`paymentController.js`](../server/controllers/paymentController.js)

| Acción | Asiento | Trazabilidad | Estado | Corrección |
|---|---|---|---|---|
| Cobro (COBRO) | D caja/banco/tarjeta · H clientes; (H anticipoClientes) | `COBRO/Payment/{id}/REGISTER` + `BankTransaction` | ✅ | Idempotencia por `idempotencyKey` (ver §A-idempotencia) |
| Aplicación a `Receivable` | reduce saldo del documento | subledger | ✅ | — |
| Anular cobro | Reversa asiento, anula BankTx, des-aplica `Receivable` | reversos | ✅ | — |

### Cuentas por pagar (CxP) — subledger `Payable` + `paymentController`

| Acción | Asiento | Trazabilidad | Estado | Corrección |
|---|---|---|---|---|
| Pago (PAGO) individual | D proveedores · H caja/banco; `BankTransaction` si banco | `PAGO/Payment/{id}/REGISTER` | ✅ | Idempotencia por `idempotencyKey` (§A-idempotencia); guard `bank.chartAccount` |
| Pago masivo (`createBulk`) | 1 pago por proveedor | `PAGO/Payment/{id}/REGISTER` | ✅ | Sin `idempotencyKey` (acción de escritorio, menor riesgo de doble-submit) — ver Limitaciones |
| Aplicación a `Payable` | reduce saldo, marca PAGADA | subledger | ✅ | — |
| Anular pago | Reversa asiento, anula BankTx, des-aplica `Payable` | reversos | ✅ | — |

### Retenciones — dentro de la compra (§Compras)

Las retenciones **no** generan asiento propio: se acreditan dentro del asiento de la compra
(`retRentaPorPagar`/`retIvaPorPagar`), fuente única = cabecera derivada de las líneas. ✅ Sin doble conteo.

### Comprobantes de retención — [`retentionVoucherController.js`](../server/controllers/retentionVoucherController.js)

| Acción | Asiento | Trazabilidad | Estado | Corrección |
|---|---|---|---|---|
| Emitir comprobante (cod 07) desde compra | **No** genera asiento (usa el de la compra); produce documento fiscal firmado/autorizado | `RetentionVoucher.journalEntry = inv.journalEntry`; idempotente por `purchaseInvoice` | ✅ Sin doble conteo | `fechaEmision = now` (no la de la compra) — ver §E |

### Activos fijos — [`inventoryAdvancedController.js`](../server/controllers/inventoryAdvancedController.js)

| Acción | Asiento | Cuentas | Estado | Corrección |
|---|---|---|---|---|
| Alta por compra | (en la compra) D activo · H proveedores | Categoría | ✅ | — |
| Alta manual | Sin asiento (registro de ficha) | Snapshot de categoría | ✅ | Alta manual no contabiliza el activo contra ninguna contraparte (esperado: se contabiliza vía compra) |
| Baja/venta | ver §Inventario/disposeAsset | roles (corregido) | ✅ | — |

### Nómina — [`payrollController.js`](../server/controllers/payrollController.js) + [`payrollPosting.js`](../server/utils/payrollPosting.js)

| Acción | Asiento | Cuentas | Trazabilidad | Estado | Corrección |
|---|---|---|---|---|---|
| Generar rol (borrador) | Sin asiento | — | — | ✅ | — |
| Cerrar rol | D gastos por **departamento** (Admin/Ventas/Costos) · H sueldos por pagar, IESS, IR, provisiones | Cuentas de `PayrollDepartment`/`PayrollConcept`/config | `NOMINA/Payroll/{id}/CLOSE` | ✅ Bloquea si falta cuenta crítica o tabla IR | — |
| Pagar rol desde banco | D sueldos por pagar · H banco; `BankTransaction` | config + `bank.chartAccount` | `PAGO/Payroll/{id}/PAY` | ✅ | — |
| Pagar rol **sin** banco | **ENDURECIDO**: bloquea salvo pago manual explícito (`confirmNoBank`), que genera D sueldos por pagar · H **caja** | rol `caja` + config | `PAGO/Payroll/{id}/PAY` | ✅ Ya no deja la obligación abierta | Ver §Nómina-sin-banco |

### Reportes SRI — [`sriSuperciasReportsController.js`](../server/controllers/sriSuperciasReportsController.js) / [`salesReportsController.js`](../server/controllers/salesReportsController.js)

| Reporte | Fuente | Fecha | Estado | Corrección |
|---|---|---|---|---|
| Formulario 104 (IVA) XML | Ventas `Invoice` AUTORIZADO + compras `PurchaseInvoice` no anuladas + ret. IVA | Fecha fiscal (`invoiceFiscalDate`) / `fechaEmision` | ✅ Guard mensual | NC/ND no incluidas (ver §H) |
| Formulario 103 (retenciones renta) XML | Retenciones RENTA de compras | `fechaEmision` compra | ✅ Guard mensual; solo cabecera (sin doble conteo) | — |
| ATS / SuperCías | Ventas/compras/retenciones/balances | Fecha fiscal | ✅ visual | Validación de formato oficial pendiente |

### Libro mayor / Estados financieros — [`journalEntryController.js`](../server/controllers/journalEntryController.js) / [`accountingReportsController.js`](../server/controllers/accountingReportsController.js)

| Reporte | Comportamiento | Estado |
|---|---|---|
| Libro mayor jerárquico | Cuenta padre agrega descendientes; saldo por naturaleza raíz; fila indica cuenta hija + `sourceModel/sourceRef` | ✅ |
| Balance de comprobación | Débitos/créditos/saldo por cuenta movible | ✅ |
| Balance general | Árbol con roll-up padre/hijo; `descuadre = Activo − (Pasivo+Patrimonio)` | ✅ |
| Estado de resultados | Ingresos/costos/gastos con cascada tributaria estimada | ✅ |
| Salud contable | Partida doble global, asientos descuadrados, subledger vs mayor, docs sin asiento | ✅ [`accountingHealthController.js`](../server/controllers/accountingHealthController.js) |

### Notas de crédito/débito — [`creditDebitNoteController.js`](../server/controllers/creditDebitNoteController.js)

| Acción | Asiento | Estado | Corrección |
|---|---|---|---|
| NC emitida | D ingreso + D ivaVentas · H clientes; reduce saldo factura | ✅ `NC/CreditDebitNote/{id}/POST` | — |
| NC recibida | D proveedores · H gasto + H ivaCompras; reduce saldo compra | ✅ | — |
| ND emitida/recibida | Simétrico (aumenta saldo) | ✅ | — |
| Anular NC/ND | Reversa asiento y restaura saldo del documento | ✅ | — |

---

## B. Trazabilidad contable (source / sourceModel / sourceRef)

Revisión de todos los `createEntry` del sistema:

| sourceModel | source | sourceAction | ¿sourceRef? | Fecha | Clínica |
|---|---|---|---|---|---|
| `Sale` | VENTA/COBRO | POST / COLLECT:{key} / EDIT:{ts} | ✅ venta | `createdAt` (fecha de venta) | ✅ |
| `PurchaseInvoice` | COMPRA | POST / UPDATE:{ts} | ✅ compra | `fechaEmision` | ✅ |
| `Payment` | COBRO/PAGO | REGISTER | ✅ pago | `date` | ✅ |
| `BankTransaction` | BANCO | POST/TRANSFER/CASH_DEPOSIT/STATEMENT | ✅ tx | `date` | ✅ |
| `CashMovement` | CAJA/BANCO | *(ninguno)* | ✅ (asignado tras crear) | `date` | ✅ |
| `CashClosing` | CIERRE | DIFFERENCE | ✅ cierre | `closedAt` | ✅ |
| `Payroll` | NOMINA/PAGO | CLOSE / PAY | ✅ rol | `year,month,28` / `date` | ✅ |
| `FixedAsset` | DEPRECIACION/AJUSTE | DEPRECIATION:{período} / DISPOSE | ✅ (⚠️ depreciación: primer activo) | fin de mes / `disposalDate` | ✅ |
| `PhysicalCount` | AJUSTE | CONFIRM | ✅ conteo | `date` | ✅ |
| `CreditDebitNote` | NC/ND | POST | ✅ nota | `fechaEmision` | ✅ |
| `DeferredIncome` | (reconocimiento) | RECOGNIZE | ✅ | fecha reconocimiento | ✅ |
| `JournalEntry` | AJUSTE | REVERSAL | ✅ asiento reversado | fecha reversa | ✅ |
| `MANUAL` | MANUAL | — | — (asiento manual) | libre | ✅ |

**Hallazgos de trazabilidad:**

- **B1 (bajo).** Depreciación: el asiento consolida N activos pero `sourceRef = touchedAssets[0]`.
  El deep-link desde el mayor abre el **primer** activo, no todos. Aceptable; el detalle está en
  `FixedAsset.history[].journalEntry` de cada activo. **Mejora futura:** crear un modelo
  `DepreciationRun` como `sourceRef`.
- **B2 (info).** `CashMovement` crea el asiento y luego le asigna `sourceRef` (no en la misma
  llamada) y sin `sourceAction`. Correcto funcionalmente; sin idempotencia (acción manual única).
- Todos los asientos automáticos llevan `source`, `sourceModel` y `sourceRef`. **No se detectaron
  asientos automáticos sin origen suficiente.**

---

## C. Deep-link desde el Libro Mayor

Mapa actual en [`client/src/pages/accounting/Ledger.jsx`](../client/src/pages/accounting/Ledger.jsx) (`SOURCE_ROUTES`).
El botón "Ir a…" **solo** aparece para `deep:true`; el resto muestra etiqueta legible y el asiento
se ve en el modal → **no hay botones falsos** (criterio mínimo cumplido).

| sourceModel | Etiqueta | deep-link | Página destino soporta `?doc=` |
|---|---|---|---|
| `Sale` | Venta | ✅ | Sales.jsx ✅ |
| `PurchaseInvoice` | Factura de compra | ✅ | PurchaseInvoices.jsx ✅ |
| `FixedAsset` | Activo fijo (depreciación) | ✅ | FixedAssets.jsx ✅ |
| `Payroll` | Nómina | ✅ | Payroll.jsx ✅ |
| `Payment` | Pago / Cobro | ⬜ **PENDIENTE (alto impacto)** | Payments.jsx (requiere modal detalle) |
| `BankTransaction` | Movimiento bancario | ⬜ **PENDIENTE (alto impacto)** | BankAccounts/BankLedger |
| `RetentionVoucher` | Comprobante de retención | ⬜ pendiente | RetentionVouchers.jsx (tiene detalle) |
| `CreditDebitNote` | Nota de crédito/débito | ⬜ pendiente | CreditDebitNotes.jsx |
| `Reconciliation` | Conciliación | ⬜ pendiente | Reconciliations.jsx |
| `CashClosing` / `CashMovement` | Caja | ⬜ pendiente | CashClosing/CashBox |
| `DeferredIncome`, `CommissionPosting`, `CardSettlement`, `CreditCardBatch`, `EmployeeDeduction`, `PhysicalCount`, `Invoice`, `JournalEntry` | (etiqueta) | ⬜ | varias |

**Decisión de alcance:** implementar los deep-links restantes exige que cada página destino
monte `useDocDeepLink` y tenga un **modal de detalle de solo lectura** (hoy Payments/Bancos solo
tienen modal de "nuevo"). Es trabajo de UI verificable únicamente ejecutando el frontend. Por eso,
en esta auditoría:

- ✅ Se confirma que **no hay botones falsos** (el mapa respeta `deep`).
- ✅ Se **documentan** los pendientes (esta tabla) y su prioridad.
- ⬜ Los de mayor impacto (Payment, BankTransaction, RetentionVoucher) quedan como
  **pendiente Importante** con receta clara (abajo).

**Receta para completar un deep-link (por página):**
1. Añadir `deep:true` + `path` en `SOURCE_ROUTES`.
2. En la página destino: `useDocDeepLink((id) => openDetail(id))`.
3. Implementar `openDetail(id)` → `GET /<recurso>/:id` y abrir un modal de solo lectura que
   muestre el documento + su `journalEntry` (usar `populate('journalEntry')`).

---

## D. Doble contabilización — casos revisados

| Escenario | ¿Protegido? | Mecanismo |
|---|---|---|
| Compra autorizada/creada dos veces | ✅ | Asiento idempotente por `PurchaseInvoice/{id}/POST`; editar reversa+recrea |
| Retención cabecera + retención por línea | ✅ | Cabecera **derivada** de las líneas (`groupLineRetentions`) = fuente única |
| Doble-submit de venta | ✅ | `idempotencyKey` único por clínica |
| Depreciación del mismo período dos veces | ✅ | `sourceAction=DEPRECIATION:{período}` + guard `asset.lastDepreciationPeriod >= período` |
| Nómina cerrada dos veces | ✅ | Guard `status !== 'BORRADOR'` + idempotencia `Payroll/{id}/CLOSE` |
| Nómina pagada dos veces | ✅ | Guard `status !== 'CERRADO'` + idempotencia `Payroll/{id}/PAY` |
| Venta facturada y cobrada duplicada | ✅ | Factura no genera asiento propio; cobro aplica a saldo con validación de exceso |
| XML importado y luego registrado manual | ✅ **CORREGIDO** | `findDuplicatePurchaseInvoice` bloquea el alta manual / la autorización de un comprobante ya registrado (por clave/autorización/proveedor+serie/estab-pto-secuencial). Ver §B-duplicados |
| **Pago de proveedor registrado dos veces** | ✅ **CORREGIDO** | `Payment.idempotencyKey` + índice único parcial: el doble-submit devuelve el pago existente sin recrear asiento/BankTransaction/aplicación. Ver §A-idempotencia |

**Hallazgos (resueltos):**

- **D1 (Importante → CORREGIDO).** El alta manual y la autorización de compras ahora validan
  duplicidad con `findDuplicatePurchaseInvoice` (§B). El import (XML/TXT) usa la misma regla.
- **D2 (Crítico → CORREGIDO).** `paymentController.create` acepta `idempotencyKey` (body o header
  `Idempotency-Key`) con índice único parcial en `Payment` (§A).

---

## D-bis. Cierre de pendientes críticos (implementado)

### §A-idempotencia — Idempotencia de pagos/cobros

**Modelo** [`Payment.js`](../server/models/Payment.js): campo `idempotencyKey: String` (default `null`)
+ índice único **parcial** `{ clinic: 1, idempotencyKey: 1 }` con
`partialFilterExpression: { idempotencyKey: { $type: 'string' } }` (dos pagos **sin** clave no
colisionan; la unicidad es por clínica).

**Controlador** [`paymentController.create`](../server/controllers/paymentController.js):
1. Lee la clave de `req.body.idempotencyKey` **o** del header `Idempotency-Key`.
2. **Pre-check:** si ya existe un `Payment` con esa clave en la clínica → responde `200` con el pago
   existente y `idempotentReplay: true`, **sin** crear otro asiento, `BankTransaction` ni re-aplicar
   CxP/CxC.
3. Al crear, persiste `idempotencyKey` en el `Payment`.
4. **Carrera:** si dos peticiones concurrentes usan la misma clave, el índice único hace fallar a la
   perdedora (`E11000`); el `catch` la recupera y devuelve el pago existente (`200`).
5. **Sin clave:** comportamiento legacy intacto (cada submit crea un pago).

Alcance: cubre `create` (cobro/pago individual, donde está el riesgo de doble-clic del cajero).
`createBulk` (pago masivo, acción de escritorio) no lleva clave por diseño (varios pagos por una
llamada). `collectSale` ya era idempotente vía `sourceAction=COLLECT:{key}`.

Respuesta de replay: `{ ...payment, idempotentReplay: true }` con `status 200` (vs `201` al crear).

### §B-duplicados — Bloqueo de doble registro de compras

Helper [`findDuplicatePurchaseInvoice`](../server/controllers/purchaseInvoiceController.js) (exportado
como `_findDuplicatePurchaseInvoice` para pruebas). Considera **duplicado** a una compra **no anulada**
que comparta identidad de comprobante, de más a menos fuerte:
`claveAcceso` (≥10) → `autorizacion` (≥10) → `supplier + serie` → `supplier + estab + ptoEmi + secuencial`.

Usos:
- **`create` (manual):** si hay duplicado `REGISTRADA/PAGADA` → `409` con referencia a la existente;
  si es `POR_AUTORIZAR` (ya importado) → `200` devolviendo esa factura (`duplicate: true`) para
  completarla/autorizarla en vez de crear otra. En el intento duplicado **no** se crea asiento, CxP,
  inventario ni activo (el chequeo ocurre antes de la transacción).
- **`authorize`:** bloquea (`409`) autorizar un `POR_AUTORIZAR` cuyo comprobante ya está registrado.
- **`importXml`:** dedup por la misma regla (antes solo clave/serie, sin excluir anuladas).
- `importTxt`: conserva su dedup por lotes (clave + proveedor+serie) por rendimiento.

Refuerzo de base de datos existente: `PurchaseInvoice` ya tenía índice único parcial
`{clinic, supplier, serie}` y `claveAcceso` indexado — el helper añade la **claridad** de mensaje y
cobertura de identidades que el índice no cubre (clave con serie distinta, estab-pto-secuencial).

Mensaje: *"Ya existe una compra registrada para este proveedor y número de comprobante."* + `existing`.

### §Nómina-sin-banco — Pago de nómina sin banco (endurecido)

Antes: pagar un rol **sin** banco marcaba `PAGADO` **sin ningún asiento**, dejando "Sueldos por pagar"
abierto indefinidamente. Ahora [`payrollController.markPaid`](../server/controllers/payrollController.js):
- Sin `bankAccountId` y **sin** `confirmNoBank` → **`400`** ("requiere un banco… o confirma pago manual").
- Sin banco **con** `confirmNoBank: true` → registra un pago **manual/efectivo** que **sí genera** el
  asiento de liquidación **D Sueldos por pagar / H Caja** (rol `caja`), idempotente por
  `sourceAction=PAY`. Así la obligación queda liquidada y no hay `PAGADO` sin asiento.
- **Compatibilidad:** el botón del frontend ("Pagar en efectivo (Caja)") ahora envía `confirmNoBank`;
  las nóminas ya `PAGADO` no se tocan.

## E. Fechas fiscales y contables

| Módulo | Fecha usada | ¿Correcta? |
|---|---|---|
| Ventas | `Sale.createdAt` (= `req.body.date` si se envía) → asiento y reportes | ✅ (fecha de emisión operativa) |
| Facturas electrónicas | `Invoice.fechaEmision` (fiscal) para reportes SRI | ✅ vía `invoiceFiscalDate` |
| Compras | `PurchaseInvoice.fechaEmision` (emisión fiscal) | ✅ |
| Bancos | `BankTransaction.date` | ✅ |
| Caja | fecha del movimiento / `closedAt` | ✅ |
| Nómina cierre | `new Date(year, month-1, 28)` (dentro del mes del período) | ✅ |
| Nómina pago | `date` del pago | ✅ |
| Depreciación | fin de mes del período (`new Date(y, m, 0, 23:59:59)`) | ✅ |
| Retenciones (asiento) | fecha de la compra (dentro del asiento de compra) | ✅ |
| Comprobante de retención (documento) | `new Date()` al emitir | ⚠️ **E1** |
| Reportes SRI | fecha fiscal (`invoiceFiscalDate` / `fechaEmision`) | ✅ |
| Libro mayor | `JournalEntry.date` | ✅ |

- **E1 (bajo).** El `RetentionVoucher.fechaEmision` se fija en `now()` al emitir, no en la fecha
  de la compra. No afecta contabilidad (el asiento ya está en la compra) pero puede desalinear el
  período fiscal del comprobante si se emite en un mes distinto al de la compra. **Recomendación:**
  permitir/derivar `fechaEmision` de la compra o validar mismo período.

---

## F. Configuración obligatoria (operaciones bloqueadas si falta config)

| Regla | ¿Se bloquea hoy? | Dónde |
|---|---|---|
| Producto físico sin categoría contable de inventario | ✅ (carga masiva rechaza fila; compra estricta bloquea) | productCategoryResolver / `resolveInventoryAccount` |
| Categoría de inventario sin `assetAccount` | ✅ (compra estricta bloquea) | purchaseInvoiceController:170 |
| Categoría de activo fijo incompleta | ✅ (validación al crear categoría y al comprar) | `validateAssetCategory`, `assetCategoryIssues` |
| Retención sin cuenta/fallback válido | ✅ (bloquea con mensaje; fallback por rol) | `resolveRetentionPayableAccount` |
| Nómina sin cuentas críticas (sueldos/depto) | ✅ (bloquea el cierre) | `buildPayrollEntryLines` |
| Nómina sin tabla IR del año (con ingreso gravado) | ✅ (bloquea el cierre) | payrollController:397 |
| Banco sin `chartAccount` (pago/cobro por banco) | ✅ (esquema `required`) + guarda defensiva | `BankAccount.chartAccount required` + `paymentController.create` |
| Forma de pago sin cuenta | ✅ (roles con fallback estándar) | accountMap |
| Cuenta inactiva / no movible en cualquier asiento | ✅ | `resolveEntryLines` |

- **F1 (defensiva).** El esquema `BankAccount` ya declara `chartAccount` como **`required`**, por lo
  que en la práctica un banco no puede existir sin cuenta contable. Aun así, `paymentController.create`
  usaba `bank.chartAccount` sin verificarlo; si un dato legacy lo tuviera nulo, el error sería críptico
  ("Cuenta no encontrada: undefined"). **En esta auditoría** se agregó una guarda defensiva con
  mensaje claro (redundante con el esquema, pero robusta ante datos migrados). No es un bug reachable
  hoy: es endurecimiento.

---

## G. Estados financieros

| Verificación | Resultado |
|---|---|
| Balance general incluye cuentas padre/hijas con roll-up | ✅ `buildAccountTree` acumula subtotales |
| Estado de resultados separa ingresos, costos y gastos | ✅ por `type` (INGRESO/COSTO/GASTO) |
| Presentación de gastos admin/ventas/financieros | ⚠️ Parcial: se listan por cuenta; **no** hay segregación explícita admin/ventas/financiero salvo por la estructura del plan de cuentas. La nómina sí separa gasto por departamento en el asiento. |
| Depreciación alimenta el estado de resultados | ✅ (cuenta de gasto de depreciación) |
| Nómina alimenta el estado de resultados | ✅ (gastos de sueldos/beneficios) |
| Inventario y activos alimentan el balance | ✅ |
| CxC/CxP cuadran con submayores | ✅ verificado por `accountingHealthController` (AR_MISMATCH/AP_MISMATCH) |
| Balance general cuadrado (`descuadre`≈0) | ✅ expuesto como métrica |

- **G1 (mejora futura).** Segregación de gastos por función (administrativos / ventas /
  financieros) para el Estado de Resultados por función requiere marcar cuentas por sub-tipo; hoy
  se apoya en la jerarquía del plan. No es un error, es una mejora de presentación.

---

## H. SRI

| Verificación | Resultado |
|---|---|
| Ventas AUTORIZADAS alimentan reportes SRI | ✅ (`Invoice.estado='AUTORIZADO'`, fecha fiscal) |
| Compras registradas alimentan reportes SRI | ✅ (`PurchaseInvoice` no anuladas, `fechaEmision`) |
| Retenciones por línea alimentan Formulario 103 | ✅ (retenciones RENTA agrupadas por código) |
| IVA compras/ventas alimenta Formulario 104 | ✅ (ventas − compras − ret. IVA) |
| ATS toma ventas/compras/retenciones | ✅ visual |
| XML oficial mensual bloqueado para rangos inválidos | ✅ `monthlyGuard` en 103 y 104 |
| Validación de formato oficial completo | ⚠️ **Pendiente** (marcado como preliquidación) |

- **H1 (bajo).** El 104 no incluye NC/ND (emitidas/recibidas) en la liquidación de IVA. Para
  clínicas con volumen bajo de notas es tolerable, pero debe documentarse como preliquidación.
- **H2 (info).** Los XML 103/104 son formatos **simplificados** (no el esquema DIMM oficial
  completo). Sirven de preliquidación/insumo; requieren validación contra el formato vigente del SRI.

---

## I. Scripts pendientes de producción (orden recomendado)

Todos en [`server/scripts/`](../server/scripts/), idempotentes, con `--dry-run` por defecto y
`--commit` para aplicar (patrón `_common.js`). **Ejecutar en este orden** tras desplegar:

| # | Script | Objetivo | Dry-run | Commit | Riesgo | Cuándo |
|---|---|---|---|---|---|---|
| 1 | `ensureRoleAccounts.js` | Garantiza que existan las cuentas de todos los roles de `accountMap` por clínica | `node scripts/ensureRoleAccounts.js` | `--commit` | Bajo (solo crea faltantes) | Primero, base de todo |
| 2 | `migrateProductCategoriesToInventoryCategories.js` | Asigna categoría contable de inventario a productos físicos | `node scripts/migrateProductCategoriesToInventoryCategories.js` | `--commit` | Medio (revisar mapeo) | Antes de compras estrictas |
| 3 | `backfillStrictAccounts.js` | Marca `strictAccounts` y normaliza cuentas de compras existentes | `node scripts/backfillStrictAccounts.js` | `--commit` | Medio | Tras (2) |
| 4 | `dropRetentionRuleUniqueIndex.js` | Elimina el índice único legacy que impedía versiones históricas de una regla | `node scripts/dropRetentionRuleUniqueIndex.js` | `--commit` | Bajo | Antes de editar catálogo de retenciones |
| 5 | `migrateInventoryToLayers.js` | Crea la capa inicial de kardex por producto (`qtyRemaining=stock`, `unitCost=averageCost`) | `node scripts/migrateInventoryToLayers.js` | `--commit` | Medio (verificar cuadre de valor) | Antes de operar kardex |
| 6 | `migrateCarteraToSubledger.js` | Puebla `Receivable`/`Payable` desde saldos de ventas/compras | `node scripts/migrateCarteraToSubledger.js` | `--commit` | Medio | Tras (1) |
| 7 | `seedPayrollConcepts.js` | Siembra el catálogo estándar de conceptos de nómina | `node scripts/seedPayrollConcepts.js` | `--commit` | Bajo | Antes de nómina |
| 8 | `migratePayrollDepartments.js` | Crea/asigna departamentos y sus cuentas | `node scripts/migratePayrollDepartments.js` | `--commit` | Medio (mapear cuentas) | Tras (7) |
| 9 | `seedPayrollIncomeTax.js` | Siembra la tabla de IR del año (valida valores vigentes) | `node scripts/seedPayrollIncomeTax.js --year=2026` | `--commit` | Bajo (validar valores) | Antes de cerrar rol |

**Verificación post-scripts (obligatoria):** correr el endpoint de **salud contable**
(`accountingHealthController.check`) y `recomputeBalances` para confirmar: partida doble global,
subledger = mayor, sin asientos descuadrados, sin documentos con saldo sin asiento.

> Nota: los scripts `wipeInventory.js` / `wipePurchaseInvoices.js` son **destructivos** (limpieza
> de datos de prueba). **No** ejecutar en producción salvo reinicio controlado de datos.

---

## J. Pruebas de regresión

Cobertura de integración existente (harness `mongodb-memory-server`, controllers reales):

| Archivo | Flujos |
|---|---|
| `flows.integration.test.js` | Ventas, cobros, caja, arqueo (end-to-end) |
| `purchaseFlow.integration.test.js` | Compra gasto/inventario, asiento, CxP |
| `purchaseRetentions.integration.test.js` | Compra con RENTA+IVA, retenciones por pagar |
| `purchaseMixed.integration.test.js` | Factura mixta (gasto+inventario+activo) |
| `fixedAssets.integration.test.js` | Activo por categoría, depreciación, no baja de residual |
| `sriReports.integration.test.js` | 103/104 por período, guard mensual |
| `payroll.integration.test.js` | Rol, cierre, pago desde banco |
| `kardex.test.js`, `subledger.test.js`, `ledgerHierarchy.test.js` | Motor kardex, subledger, mayor jerárquico |

**Añadido en esta auditoría:** [`accountingIntegration.audit.test.js`](../server/tests/accountingIntegration.audit.test.js)
que codifica invariantes globales de la auditoría:

1. Compra de inventario con retención → asiento cuadrado, CxP neto, kardex, IVA crédito, ret. por pagar, alimenta 103/104.
2. Depreciación idempotente (correr dos veces el mismo período → un solo asiento).
3. Baja de activo (`disposeAsset`) usa **cuentas por rol** (no códigos fijos) y cuadra.
4. Todo asiento automático (VENTA/COMPRA/PAGO/COBRO/NOMINA/DEPRECIACION/…) tiene `source`, `sourceModel` y `sourceRef`.
5. Guardas anti-duplicado: nómina no se cierra dos veces; compra no se re-contabiliza; período cerrado bloquea.

Los flujos J1–J9 del pedido quedan cubiertos entre los tests existentes y el nuevo (ver mapeo en
el propio archivo de test).

**Añadido al cerrar los críticos:**
- [`paymentIdempotency.test.js`](../server/tests/paymentIdempotency.test.js) — doble-submit con misma
  clave (un solo Payment/asiento/BankTransaction/aplicación CxP), banco, pre-check de carrera, misma
  clave en otra clínica, y comportamiento legacy sin clave.
- [`purchaseDuplicate.test.js`](../server/tests/purchaseDuplicate.test.js) — helper (clave/serie/estab-pto-secuencial,
  excluye anuladas, sin falsos positivos), import+manual retorna existente, 409 sin asiento en
  duplicado, autorización de duplicado bloqueada, re-registro permitido tras anular.
- `payroll.integration.test.js` (H1/H2) — pago sin banco bloqueado sin confirmación; con
  `confirmNoBank` liquida contra Caja con asiento (sin BankTransaction).

---

## K. Correcciones aplicadas en esta auditoría

| # | Archivo | Cambio | Motivo |
|---|---|---|---|
| K1 | `inventoryAdvancedController.js` (`disposeAsset`) | Cuentas de baja de activo por **rol** (`caja`/`otrosGastos`/`otrosIngresos`) en vez de códigos fijos `1.1.01.01`/`6.1.99`/`4.2.02` | Elimina hardcode (grieta G1); respeta remapeo del contador |
| K2 | `models/Payment.js` | `applications.docModel` acepta `'Sale'` además de `Invoice`/`PurchaseInvoice` | El cobro de una venta directa (`Sale`) por el flujo de `Payment` fallaba la validación de esquema (bug latente) |
| K3 | `paymentController.js` (`create`) + `disposeAsset` | Guarda **defensiva**: exige `bank.chartAccount` con mensaje claro | Endurecimiento (F1). Redundante con el esquema (`chartAccount` es `required`), pero robusto ante datos migrados |
| K4 | `models/Payment.js` + `paymentController.create` | **Idempotencia de pagos/cobros** (`idempotencyKey` + índice único parcial + replay) | Evita pagos/cobros duplicados por doble-submit (crítico D2). Ver §A-idempotencia |
| K5 | `purchaseInvoiceController.js` (`create`/`authorize`/`importXml`) | **Bloqueo de doble registro de compras** (`findDuplicatePurchaseInvoice`) | Evita registrar dos veces la misma factura (import + manual) (crítico/importante D1). Ver §B-duplicados |
| K6 | `payrollController.markPaid` + `client/.../Payroll.jsx` | **Endurece pago de nómina sin banco**: exige confirmación y genera asiento D Sueldos por pagar / H Caja | Ya no deja la obligación abierta sin liquidar (importante C). Ver §Nómina-sin-banco |

> Se respetó la consigna de **no rehacer módulos**. No se tocaron flujos productivos de venta,
> compra ni nómina más allá de guardas puntuales.

---

## L. Entregable — resumen ejecutivo

**Estado general:** el sistema está **bien integrado contablemente**. Los 7 criterios de la
auditoría se cumplen en la gran mayoría de operaciones. Los hallazgos son **puntuales**, no
estructurales, y los de mayor riesgo tienen guardas o corrección.

### Pendientes clasificados por prioridad

**🔴 Crítico antes de producción**
- Ejecutar los scripts de §I en orden y correr salud contable + `recomputeBalances`.
- Asegurar que se creen los **índices nuevos** al desplegar: `Payment {clinic, idempotencyKey}`
  (único parcial). Con `autoIndex` activo Mongoose los crea al iniciar; en colecciones grandes,
  construirlos explícitamente (`Payment.syncIndexes()`) en ventana de baja carga.
- ~~**D2** — Idempotencia de pagos~~ → **IMPLEMENTADO** (§A-idempotencia).

**🟠 Importante**
- ~~**D1** — Bloqueo duro de doble registro compra~~ → **IMPLEMENTADO** (§B-duplicados).
- ~~**Nómina pago sin banco**~~ → **ENDURECIDO** (§Nómina-sin-banco).
- **Deep-links §C** — implementar Payment, BankTransaction y RetentionVoucher (receta incluida).
- **E1** — Fecha fiscal del comprobante de retención = fecha de la compra.
- **Pago masivo idempotente** — `createBulk` no lleva `idempotencyKey` (ver Limitaciones); evaluar
  si se requiere para lotes grandes.

**🟢 Mejora futura**
- **B1** — `DepreciationRun` para deep-link de depreciación a todo el lote.
- **G1** — Estado de Resultados por función (admin/ventas/financiero).
- **H1/H2** — NC/ND en el 104; XML 103/104 en formato oficial DIMM.
- Limpieza de código muerto legacy (ramas inalcanzables en `runDepreciation` y `confirmCount`).

### No implementado en este bloque (por consigna explícita)
RDEP oficial completo · XML SRI oficial completo (requiere investigación externa) ·
liquidación de haberes/finiquito · roles quincenales · comprobante electrónico de retención
completo · reestructuración mayor de estados financieros.

### Limitaciones honestas
- Los deep-links pendientes son trabajo de UI **no verificable** sin ejecutar el frontend; se
  documentaron con receta en lugar de implementarlos a ciegas.
- Los formularios SRI son **preliquidación** (formato simplificado), no el esquema oficial.
- **Idempotencia de pagos:** cubre `create` (cobro/pago individual). El **pago masivo** (`createBulk`)
  no lleva clave por diseño (una llamada crea varios pagos); es una acción de escritorio con menor
  riesgo de doble-clic. Si se requiere, se puede añadir una clave de lote.
- **Bloqueo de duplicados de compra:** el re-registro tras **anular** solo es posible si el nuevo
  comprobante no colisiona con el índice único de BD `{clinic, supplier, serie}` (que sí cuenta
  anuladas). Es decir, se puede re-registrar con **otra serie** (caso normal); re-usar exactamente la
  misma serie de un documento anulado requeriría eliminarla. Documentado, no bloqueante en la práctica.
- **Índice `Payment.idempotencyKey`:** debe existir en producción para que el guard sea efectivo bajo
  concurrencia (ver Crítico).
</content>
</invoke>
