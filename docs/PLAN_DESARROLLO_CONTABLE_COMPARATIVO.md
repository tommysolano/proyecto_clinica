# Plan de desarrollo contable comparativo — clínica y Micartaonline

**Fecha de revisión:** 2026-10-09  
**Estado:** plan de trabajo; ninguna fase de este documento se considera implementada por su mera publicación.  
**Fuente principal:** código actual de este repositorio y `micartaonline.zip` en la raíz.  
**Propósito:** dar a un agente de desarrollo el contexto, orden de ejecución y criterios verificables para mejorar la contabilidad de la clínica sin trasladar supuestos propios de restaurantes.

### Estado de ejecución — 2026-10-09

| Trabajo | Estado | Evidencia |
|---|---|---|
| F1.1: bloquear pago individual y masivo de compra sin asiento vigente | Implementado parcialmente | `server/controllers/paymentController.js`; `server/tests/accountingGuardrails.integration.test.js`. Una compra migrada vinculada a asiento Contífico devuelve `MIGRATED_PAYABLE_REVIEW` hasta reconciliar su CxP importada; no se crea otra CxP por accidente. |
| F1.2: impedir reverso directo de asiento operativo desde Diario | Implementado | `server/controllers/journalEntryController.js`, `client/src/pages/accounting/JournalEntries.jsx`; prueba de rechazo y reverso manual. |
| F1.3: cierres y apertura anual | Parcial | Se bloquean borradores; enero usa mayor continuo y no duplica saldos con un nuevo asiento. El cierre anual genera asiento y cierra meses en una transacción, y el reintento no duplica el resultado. `diagnoseAccountingUpgrade.js` cuenta aperturas históricas. Falta control de obligaciones/conciliaciones pendientes y revisión de cierres históricos. |
| F1.4: salud/CxC | Parcial | `accountingHealthController.js` resuelve venta y factura como una obligación y separa alertas ambiguas. Falta conciliar casos históricos reales y CxP por empresa. |
| F2.1–F2.2: tarjetas | Parcial | Lote agrupa vouchers y lleva a nueva liquidación; solo liquidación acredita banco, admite parciales y estados derivados. Cada pago de tarjeta de una venta tiene identidad por índice de renglón: puede ir a su propio lote/liquidación sin volver a tomar otro voucher de la misma venta. Búsqueda por lote, POS y tarjeta identifica cada renglón; la anulación de una liquidación conserva el vínculo de otra liquidación activa de la misma venta y bloquea depósitos conciliados. Índices únicos y 33 pruebas de tarjeta, incluidas peticiones simultáneas, impiden repetir un voucher vigente. Falta revisar comprobantes históricos sin vínculo contra recaps reales. |
| F2.3: caja/depósitos | Parcial | Un solo camino nuevo de depósito; admite documentos, cobros directos y saldo libre justificado. Anulación restaura banco y pendientes. Falta ligar caja por sesión/punto a cada fuente y revisar fondos iniciales históricos. |
| F2.5: cobros por cajero | Implementado en alcance actual | Página nueva con eventos de pago de venta, cobros `Payment` y cobro directo de venta; excluye crédito y saldo a favor como dinero nuevo. `cashierCollections.integration.test.js`. |
| F3.1–F3.3: importación/personas/catálogo | Parcial | TXT/XML desglosan incorporados, duplicados del archivo/sistema y errores; XML conserva contacto disponible y rol proveedor. Personas permite conservar varios roles a la vez. Nuevas clínicas siembran plan contable en transacción. `backfillClinicCharts.js` prepara la carga retrospectiva y excluye sucursales que leen un centro contable enlazado. Falta comparar catálogo completo con versión aprobada y aplicar la carga a sucursales existentes que corresponda. |
| F4: depreciación | Implementado con revisión histórica pendiente | Vista previa, meses pendientes por orden, asiento por mes, límite de 24 meses e idempotencia. El cierre mensual ejecuta la depreciación pendiente y cierra dentro de la misma transacción; el cierre anual también incorpora meses pendientes antes de calcular resultados. Si faltan cuentas o hay períodos previos cerrados, se detiene sin dejar asientos parciales. Falta revisar períodos históricos cerrados con activos pendientes. |
| F5: notas y vales | Pendiente de política de negocio | Se eliminó la tarifa fija de 15 % al emitir NC y se valida su base; aún falta fijar el estado que activa el asiento de NC emitida y la cuenta/soporte de los vales. No aplicar cambios de saldo hasta resolver esas reglas. |
| F6.1: conciliación bancaria local | Parcial | Se adaptó de Micartaonline el saldo ajustado por movimientos en tránsito: libro menos cheques/depósitos no procesados, con arrastre a la siguiente hoja. El cierre exige diferencia ajustada cero y ninguna línea importada sin aplicar. Se añadieron pruebas de tres meses y bloqueo de cierre. Salud Contable señala hojas locales antiguas sin cálculo ajustado y cierres con diferencia; no altera las conciliaciones históricas. Falta revisión documental antes de cualquier corrección. |
| F0/F6: diagnóstico y validación integral | En curso | `server/scripts/diagnoseAccountingUpgrade.js` es solo lectura. Ejecutado en la base configurada el 2026-10-09: seis sucursales activas; los diez indicadores de anomalías históricas fueron cero. Una tiene 551 cuentas y 16 909 ventas; las otras cinco no tienen ventas ni plan propio. Tres sucursales enlazan a un centro contable, tres no. Falta confirmar su alcance contable y revisar cifras/documentos con el contador. |

La simulación de `node server/scripts/backfillClinicCharts.js` detectó tres sucursales activas sin ventas, sin centro contable enlazado y sin catálogo propio. No se ejecutó `--commit` sobre la base configurada. Revisar su alcance empresarial antes de sembrarlas; las otras tres sucursales enlazadas leen el catálogo del centro contable y quedan excluidas.

`node server/scripts/auditCurrentFinancialReports.js` verificó el balance de la sucursal contable Central al 31-12-2026: activos 302 045,10 = pasivos 238 842,25 + patrimonio 63 202,85; descuadre 0. Este control confirma el cuadre aritmético del balance presentado, pero no valida por sí solo cada clasificación, saldo de cartera ni documento fuente.

`node server/scripts/diagnoseCardAndDepreciation.js` encontró 449 ventas con pagos mixtos que incluyen tarjeta, de las cuales 81 tienen dos renglones de tarjeta. No hay activos depreciables activos en esta base ni meses de depreciación pendientes dentro de períodos cerrados. La identidad por renglón de voucher se implementó y probó con dos lotes distintos y con dos vouchers en un mismo lote; aún debe comprobarse con documentos reales del adquirente.

La primera entrega de desarrollo pasó `accountingGuardrails.integration.test.js`, `paymentIdempotency.test.js`, `accountingIntegration.audit.test.js` y las pruebas seleccionadas de importación TXT/XML. `npm run build` del cliente pasó también después de F3.1. La compilación presenta advertencias CSS preexistentes.

La revisión de vouchers por renglón pasó 33/33 pruebas de tarjeta. La batería contable ampliada pasó 154/154 pruebas (`cardSettlementFixes`, `cardSettlementRetentions`, `banksChecksDepositsUx`, `fixedAssets`, `flows`, `cashFlowObligations`, `accountingGuardrails` y `cashierCollections`); `npm run build` del cliente pasó después de los ajustes de interfaz. Una ejecución anterior de la suite completa dejó 29 fallos en módulos ajenos a contabilidad (entre otros agenda, chat y enfermería); ese resultado no autoriza a declarar la suite global en verde.

Tras adaptar el arrastre de conciliación de Micartaonline, 134/134 pruebas de bancos, caja, tarjetas y mayor pasaron, incluida una cadena de tres meses con cheque en tránsito; el cliente volvió a compilar. La alerta posterior de Salud Contable pasó 96/96 pruebas de bancos, cartera y flujos. El cálculo ajustado se aplica a conciliaciones locales nuevas y borradores existentes al abrirlos. Las hojas históricas cerradas e importadas de Contífico conservan sus cifras originales hasta revisión documental.

## 1. Cómo usar este documento

1. Antes de cada fase, leer el código vigente: las rutas, modelos y pruebas pueden cambiar después de esta fecha. Registrar en la tarea cualquier diferencia con este diagnóstico.
2. Usar este plan como especificación de intención y pruebas, no como autorización para copiar archivos enteros de Micartaonline. Adaptar el comportamiento al modelo de clínica, a la estructura multiempresa/multisucursal y al libro mayor existente.
3. Mantener cada cambio pequeño y verificable. Un agente debe poder entregar por fase: código, pruebas de los flujos afectados, migración o diagnóstico de datos si aplica, y explicación de las cuentas y documentos que cambian.
4. No ejecutar scripts de borrado o migraciones sobre datos reales para «probar». Usar base efímera o copia anonimizada. La ruta `/api/purchase-invoices/wipe` existe y **no forma parte del plan**.
5. No dar por válida una regla tributaria actual solo porque aparezca codificada en cualquiera de los dos proyectos. El contador debe confirmar catálogo, tasas, calendario, formularios y tratamiento de casos fiscales antes de activarlos en producción.
6. El ZIP incluye `backend/backups`, archivos compilados y otras carpetas ajenas a la comparación. Consultar únicamente `micartaonline/backend/src`, `micartaonline/frontend/app/src` y las pruebas pertinentes; no importar respaldos ni datos de restaurantes a la clínica.

### Documentos existentes que sirven de contexto, pero no sustituyen este plan

- [`PLAN_CONTABILIDAD.md`](PLAN_CONTABILIDAD.md): hoja de ruta histórica. Varias tareas allí descritas como futuras ya existen (por ejemplo `Receivable`, `Payable`, `InventoryLayer`, `CashMovement`, sesiones de caja e idempotencia de ventas). No repetirlas sin revisar el código.
- [`accounting-integration-audit.md`](accounting-integration-audit.md): auditoría del 2026-07-05. Útil para entender asientos y flujos, pero no cubre todos los riesgos comparativos detectados en octubre.
- [`GUIA_USUARIO_CONTABILIDAD.md`](GUIA_USUARIO_CONTABILIDAD.md), [`DECLARACIONES_SRI.md`](DECLARACIONES_SRI.md), [`CONFIGURACION_NOMINA.md`](CONFIGURACION_NOMINA.md): comportamiento documentado para usuarios; contrastarlo siempre con implementación y pruebas actuales.

## 2. Mapa técnico y reglas que deben conservarse

La aplicación clínica es MERN. `server/index.js` monta las rutas `/api/...`; la interfaz contable está en `client/src/pages/accounting`. Los documentos contables se filtran por `clinic` y algunas rutas usan `middleware/accountingScope` para alcance de empresa. **`Company` agrupa clínicas, pero el plan de cuentas, los asientos y buena parte de los submayores están hoy asociados a `clinic`.** Al automatizar la creación del catálogo, decidir explícitamente si se siembra una vez por sucursal o se evoluciona la titularidad contable a empresa. No mezclar ambas cosas accidentalmente.

| Componente actual | Archivos para comenzar | Responsabilidad existente |
|---|---|---|
| Motor de asientos | `server/utils/accounting.js`, `server/utils/accountMap.js`, `server/models/JournalEntry.js`, `server/models/AccountBalance.js` | `createEntry`, período abierto, cuenta por rol, partida doble, idempotencia de origen y reverso. |
| Venta y facturación | `server/controllers/saleController.js`, `server/controllers/invoiceController.js` | Venta, cartera, cobro, inventario, ingreso diferido y emisión electrónica. La factura de una venta no debe reconocer otra vez la venta. |
| Compras y proveedores/personas | `server/controllers/purchaseInvoiceController.js`, `server/controllers/supplierController.js`, `server/models/Supplier.js` | Importación TXT/XML, clasificación y autorización de compra, rol de proveedor. `Supplier` también representa personas con roles; no hay que crear otra tabla de personas contables por defecto. |
| Tesorería | `server/controllers/paymentController.js`, `cashClosingController.js`, `cashDepositController.js`, `bankController.js` | Cobros/pagos, caja, depósitos, movimientos y conciliación. |
| Tarjetas | `server/controllers/creditCardBatchController.js`, `cardSettlementController.js` | Lotes y liquidaciones independientes; ambos pueden crear asiento y depósito. |
| Cartera | `server/models/Receivable.js`, `Payable.js`, `server/services/receivableObligations.js` | Saldos y resolución de ventas/facturas que representan la misma obligación. |
| Activos e inventario | `server/controllers/inventoryAdvancedController.js`, `server/models/FixedAsset.js`, `InventoryLayer.js` | FIFO por bodega, conteos, traslados, activos y depreciación mensual. |
| Nómina | `server/controllers/payrollController.js`, `server/utils/payrollPosting.js` | Rol, cierre, obligación y pago. |
| Reportes y salud | `server/controllers/accountingReportsController.js`, `accountingHealthController.js`, `server/routes/accountingReports.js` | Estados, cartera, SRI, rentabilidad por médico y chequeos. |

**Invariantes transversales para todas las fases:** cada operación compuesta cambia documento, submayor, banco/inventario y asiento en una transacción; cada asiento operativo identifica `sourceModel`, `sourceRef` y `sourceAction`; una sola obligación económica se cuenta una vez; los importes no dependen de un texto de pantalla; los períodos cerrados no reciben nuevos asientos; la anulación revierte por el flujo del documento origen; una repetición de la petición no crea un segundo efecto; las cuentas salen de roles o configuración validada, no de un código supuesto.

### Asientos de referencia para verificar cada recorrido

Son esquemas de **control de doble registro** basados en el flujo actual; las cuentas exactas salen de `AccountingConfig`, categoría, contraparte y reglas aprobadas por el contador. No usar esta tabla para inferir porcentajes ni tratamiento fiscal que no consten en el comprobante.

| Hecho económico | Débito esperado | Crédito esperado | Control cruzado |
|---|---|---|---|
| Venta clínica a crédito | Clientes | Ingreso por servicio/producto e IVA, según documento | `Sale`/`Invoice` representan una obligación; `Receivable` conserva saldo. |
| Venta en efectivo | Caja | Ingreso e IVA, según documento | Arqueo de caja y cobro atribuido al cajero. |
| Venta por tarjeta | Tarjetas por liquidar | Ingreso e IVA, según documento | Importe bruto pendiente de liquidar una sola vez. |
| Acreditación de tarjeta | Banco, comisión, impuesto de comisión y retenciones que procedan | Tarjetas por liquidar | Neto de `BankTransaction` = depósito real; suma de liquidaciones ≤ bruto pendiente del lote. |
| Traspaso de caja al banco | Banco | Caja | Un `CashDeposit`/origen, un asiento y un movimiento bancario. |
| Compra contabilizada | Gasto/inventario/activo e IVA que proceda | Proveedores y retenciones por pagar que procedan | `PurchaseInvoice` y `Payable` concilian; compra por autorizar no genera deuda contable definitiva. |
| Pago a proveedor | Proveedores | Banco o caja | Disminuyen saldo de compra y CxP por el mismo importe aplicado. |
| Venta de paquete aún no prestado | Caja/clientes | Ingreso diferido e impuestos que correspondan | Saldo diferido concilia con sesiones/importe no reconocido. |
| Sesión prestada de paquete | Ingreso diferido | Ingreso por servicio | Reconocimiento limitado al saldo del paquete. |
| Depreciación mensual | Gasto de depreciación | Depreciación acumulada | Un período por activo, hasta base depreciable menos residual. |
| Cierre de nómina y pago | Gasto de nómina; luego obligaciones por pagar | Obligaciones; luego banco/caja | Rol, obligación y pago no reconocen dos veces el gasto. |

Para NC/ND, vales y aseguradoras el signo y el momento del asiento se fijarán con los estados y decisiones de F0/F5. En particular, una NC emitida rechazada no debe dejar un saldo de cartera que contradiga su estado documental.

### Índice de referencia dentro de `micartaonline.zip`

| Tema | Código de referencia | Uso en este plan |
|---|---|---|
| Lotes y liquidaciones | `micartaonline/backend/src/services/cardBatchService.js`, `cardSettlementService.js`; `micartaonline/frontend/app/src/pages/owner/manage/contabilidad/OwnerTarjetasLotesPage.jsx`, `OwnerTarjetasLiquidacionesPage.jsx` | Estados derivados del lote, registro de liquidación y navegación. |
| Caja y cajeros | `backend/src/controllers/cashController.js`; `frontend/app/src/pages/owner/manage/contabilidad/OwnerCajaPage.jsx`, `OwnerCobrosPorCajeroPage.jsx` | Apertura, arqueo, depósito, vales y cobros por cajero. |
| Activos | `backend/src/services/fixedAssetDepreciationService.js`, `depreciationCronService.js`; `frontend/app/src/pages/owner/manage/contabilidad/OwnerActivosFijosPage.jsx` | Previsualización y ejecución de períodos pendientes. |
| Compras y catálogo | `backend/src/controllers/purchaseInvoiceController.js`, `backend/src/data/ecuadorChartOfAccounts.js`; `frontend/app/src/pages/owner/manage/contabilidad/OwnerImportarComprasPage.jsx` | Validación previa al pago, carga y catálogo de referencia. |
| Cierre, cartera y salud | `backend/src/controllers/accountingPeriodController.js`, `accountReceivableController.js`; `backend/src/services/accountingHealthService.js` | Guardas de cierre y conciliación entre documentos y mayor. |
| Nómina y diferidos | `backend/src/controllers/payrollIessPlanController.js`, `deferredIncomeController.js` | Capacidades adicionales, sujetas al uso real de la clínica. |

Los paths de la tabla son **internos al ZIP**; extraer selectivamente si se necesita leerlos. Los nombres no implican que su lógica sea correcta o compatible por sí sola.

## 3. Diagnóstico verificado y prioridades

### P0 — integridad contable

| ID | Evidencia actual | Riesgo y resultado buscado |
|---|---|---|
| P0-01 | `fiscalPeriodController.js`: `openYear` crea `APERTURA` con saldos acumulados anteriores; `accountingReportsController.js:getAccountBalances` y `balanceSheet` vuelven a acumular todos los asientos históricos. | Ejecutar la apertura puede duplicar activos/pasivos/patrimonio en el balance. Definir una única política de arrastre y corregir ejercicios ya afectados antes de automatizar cierres. |
| P0-02 | `paymentController.js` permite pagar una `PurchaseInvoice` si no está `ANULADA`, tanto en pago simple como masivo. `purchaseInvoiceController.js:importXml` deja `POR_AUTORIZAR` sin asiento. | La API puede descargar banco/proveedores y marcar pagada una compra cuya obligación aún no existe en mayor. La UI oculta normalmente esa acción, pero la regla debe imponerse en servidor. Micartaonline la bloquea salvo migraciones expresamente respaldadas por asiento de apertura. |
| P0-03 | `journalEntryController.js:reverse` llama a `reverseEntry` sin comprobar el origen. | Reversar desde el diario una venta, pago, compra u otro asiento operativo deja documento y submayor vigentes. Restringir el reverso genérico a asientos manuales/ajustes y canalizar los demás por el documento. |
| P0-04 | `creditCardBatchController.js:liquidate` y `cardSettlementController.js:accredit` registran cada uno banco y mayor; no comparten una clave de liquidación única. | El mismo cobro con tarjeta puede reconocerse dos veces si se usan ambos caminos. Convertir el lote en agrupador/control de liquidaciones y establecer una única aplicación económica por venta/comprobante. |
| P0-05 | `cashClosingController.js:addMovement(DEPOSITO)` y `cashDepositController.js:create` registran traspasos por rutas distintas. | Un depósito físico puede registrarse dos veces. Unificar la operación económica o impedir que el mismo efectivo pendiente se vuelva a transferir. |

### P1 — requerimientos de la contadora y trazabilidad

| ID | Situación actual | Objetivo |
|---|---|---|
| P1-01 | `BankMovements.jsx` ya tiene filtros; validar consistencia, paginación y exportación, no reimplementarlos. | Filtros útiles en la página de movimientos. |
| P1-02 | `CashClosing` abre/cierra y registra tipos `INGRESO`, `EGRESO`, `GASTO`, `RETIRO`, `DEPOSITO`; no hay tipo/flujo explícito de vale. | Vales con beneficiario, motivo, responsable, estado, liquidación y efecto contable definido. |
| P1-03 | `CreditCardBatches.jsx` y `CardSettlements.jsx` son pantallas separadas. | Registrar por lote y navegar a «Nueva liquidación» con lote/ventas precargados. |
| P1-04 | `runDepreciation` acepta un mes; no calcula en una sola operación todos los meses pendientes. | Vista previa y contabilización controlada de meses pendientes; automatización solo después de tener guardas. |
| P1-05 | `salesByCashier` agrupa `Sale.total` por `cashier`; no mide cobros efectivos por método y cajero. | Página «Cobros por cajero» reconciliable con pagos y caja; no confundir venta, facturación y cobro. |
| P1-06 | La pantalla de compras ya informa `created`, `skipped`, `errors` del archivo importado. No existe una consulta remota general que permita conocer todas las facturas disponibles en SRI. | Mostrar total de registros válidos del TXT/XML recibido, importados, ya existentes y errores. Solo afirmar «total en SRI» si una fuente oficial/integración realmente da ese dato. |
| P1-07 | `Supplier` es el registro de Personas contables, con `roles`, dirección, teléfono y correo; el importador XML crea proveedor con RUC y razón social únicamente. | Reutilizar registro por identificación y clínica, añadir rol `PROVEEDOR` sin quitar otros y conservar datos de identificación/contacto que estén realmente en la fuente. |
| P1-08 | `ChartOfAccounts.jsx` ofrece un botón manual de seed; `companyController.create` y `clinicController.createClinic` no lo invocan. | Plan inicial automático y repetible al crear la unidad contable correcta; no reemplazar cuentas ya usadas. |
| P1-09 | `creditDebitNoteController.js:create` afecta asiento y saldo antes de `emit` para NC emitida. | Definir estados de nota y cuándo una NC/ND emitida adquiere efecto contable, incluido rechazo y reintento del SRI. |

### P2 — cobertura y fiabilidad complementaria

- `accountingHealthController.js` compara la suma cruda de `Receivable` con el mayor; `receivableObligations.js` resuelve pares `Sale`/`Invoice` duplicados. Alinear el chequeo con la obligación canónica y distinguir errores bloqueantes de advertencias.
- `fiscalPeriodController.js:close` cambia estado sin comprobar borradores, documentos pendientes o conciliaciones; el cierre anual necesita además política única de asientos de cierre/apertura y ejecución repetible.
- `DeferredIncome` se crea desde la venta de paquetes y se reconoce por sesiones. Revisar devolución/cancelación parcial, sesiones no usadas y trazabilidad hacia prestación clínica.
- Nómina, FIFO, conciliación, cuentas por pagar, reportes SRI, centros de costo y presupuestos **ya existen**. Mejorar casos específicos tras conciliarlos con datos reales; no copiar módulos completos del restaurante.

## 4. Orden de desarrollo y entregables

Las fases están ordenadas por dependencia y riesgo. Cada identificador sirve como unidad de trabajo para un agente. No comenzar la fase de automatización de movimientos mientras sigan abiertas las rutas que pueden duplicar asientos.

### Fase 0 — línea base, decisiones y diagnóstico de datos

**F0.1 Inventariar rutas y estados.** Dibujar para `Sale`, `Invoice`, `Receivable`, `PurchaseInvoice`, `Payable`, `Payment`, `CashClosing`, `CashDeposit`, `CreditCardBatch`, `CardSettlement`, `FixedAsset`, `CreditDebitNote` y `JournalEntry`: estado inicial, transición, asiento, cuenta, banco/submayor, reverso e idempotencia. Confirmar rutas de `server/index.js` y roles de usuario. Entregable: matriz corta junto al PR de la primera fase.

**F0.2 Diagnóstico solo lectura.** Preparar consultas o script `--dry-run` que cuente por clínica y período: aperturas anuales ya registradas, compras `POR_AUTORIZAR` con pagos, asientos operativos reversados directamente, duplicados lote/liquidación, depósitos cercanos con ambas fuentes, cartera duplicada y notas emitidas no autorizadas ya contabilizadas. No corregir automáticamente registros históricos: el contador debe revisar qué representa cada asiento. No imprimir XML, información de pacientes ni datos personales completos en logs.

**F0.3 Decisiones de negocio que deben quedar explícitas.** Contador y responsable de producto deben definir: alcance contable por empresa o sucursal; qué documento constituye un vale y cómo se liquida; qué es un lote y qué es una liquidación; posibilidad de varias liquidaciones parciales por lote; criterio contable para NC emitida pendiente/rechazada; política de cierre/apertura anual; qué datos de contacto llegan realmente del SRI; si se requiere integración remota para contar comprobantes; y tratamiento de anticipos, paquetes y aseguradoras. Documentar la decisión en el PR/tarea. Si todavía no hay respuesta, implementar solo las protecciones inequívocas y dejar las opciones configurables o sin activar.

**Salida:** conjunto de datos de prueba anonimizado, lista de incompatibilidades históricas y reglas aprobadas. El diagnóstico no debe modificar producción.

### Fase 1 — bloquear incoherencias del libro mayor

**F1.1 Pago de compra contabilizada (P0-02).** Extraer una validación de compra pagable usada por `paymentController.create` y `createBulk`, y cualquier otra ruta que reduzca saldo de compra. Exigir estado compatible y asiento contabilizado; si hay compra migrada, permitir excepción solo cuando se pueda vincular la obligación al asiento de apertura correcto. Rechazar con código estable (`NOT_POSTED`) y mensaje que indique «Verificar/Contabilizar». Conservar la selección de pagos existente en UI. Pruebas: XML recién importado no paga por ninguna ruta; compra contabilizada paga parcial/total; intento repetido no duplica; excepción migrada respaldada sí paga; período cerrado bloquea.

**Hallazgo de compatibilidad al ejecutar F1.1:** la migración Contífico crea `PurchaseInvoice.sourceModel = ContificoRecord`, importa `Payable` por separado y puede enlazar un asiento `MIGRACION` distinto del asiento de una compra local. El pago local abre un `Payable` nuevo con `sourceModel = PurchaseInvoice`; por eso **no** basta con aceptar el asiento migrado. El guard actual responde `MIGRATED_PAYABLE_REVIEW`. Una tarea posterior debe demostrar el vínculo documento↔CxP importada, aplicar el pago a esa obligación sin duplicarla y probar anulación/reintento. Hasta entonces, no habilitar esa excepción.

**F1.2 Reverso por origen (P0-03).** En ruta y servicio, autorizar el reverso genérico únicamente a asientos manuales/ajustes que no estén ligados a un documento operativo. Para asientos de venta, compra, pago, caja, tarjeta, nómina, activo y NC/ND devolver una indicación de usar su anulación específica. No confiar en ocultar el botón del cliente. Pruebas: asiento manual reversable; cada origen operativo rechazado sin modificar `JournalEntry` ni documento; anulación desde documento conserva mayor y submayor sincronizados.

**F1.3 Cierre y apertura anual (P0-01).** Decidir y codificar una sola de estas políticas: (a) mayor continuo sin asientos de apertura duplicadores, o (b) apertura explícita y reportes que evitan sumar otra vez el ejercicio anterior. Preferir la que preserve reportes, exportaciones y asientos históricos con menor migración. Añadir unicidad/idempotencia por clínica+año+tipo para cierre y apertura, comprobación de períodos, asientos borrador y resultados ya cerrados. Previsualizar efecto antes de confirmar. En datos existentes, detectar aperturas duplicadoras y preparar corrección por reverso auditado, nunca por borrado de asientos. Pruebas numéricas de dos ejercicios: saldo final de diciembre = inicial de enero; activo = pasivo + patrimonio; ejecutar dos veces no cambia cifras; cerrar con borradores falla; reabrir mantiene coherencia.

**F1.4 Salud contable.** Usar la obligación económica canónica de `receivableObligations` para el control CxC, validar también CxP y separar diferencias verdaderas de pares duplicados. `ok` debe tener semántica documentada: salud sin errores bloqueantes y conteo de advertencias por separado. Pruebas con venta+factura de la misma atención, pago parcial y asientos reversados por el flujo permitido.

### Fase 2 — tarjetas, caja y banco como una sola cadena de efectivo

**F2.1 Diseño canónico de tarjetas (P0-04).** Elegir un modelo rector: `CreditCardBatch` agrupa comprobantes/cobros y `CardSettlement` representa cada liquidación real del adquirente. Relacionar ambos de forma explícita (referencia e índice, no solo texto de lote). Permitir `PENDIENTE`, `PARCIAL`, `LIQUIDADO` y diferencia/sobrante cuando corresponda; derivar estado y saldo desde liquidaciones válidas, no de una marca manual. Registrar lote **sin** asiento bancario: el ingreso a banco ocurre al acreditar liquidación. Eliminar o redirigir con compatibilidad la ruta antigua `/:id/liquidate` para que no constituya un segundo mecanismo independiente. Impedir asignar un mismo cobro/comprobante a dos liquidaciones activas por importe superior al pendiente. Asegurar reverso de liquidación sin borrar lote ni venta.

**F2.2 Flujo de interfaz.** En `CreditCardBatches.jsx`, crear/abrir lote, ver comprobantes y saldo, acción «Nueva liquidación» que abre `CardSettlements.jsx` con identificación del lote, transacciones precargadas y retorno al detalle. Resolver recarga, URL directa y permisos. Diferenciar «registrar lote» de «acreditar banco»; mostrar bruto, comisiones, IVA de comisión, retenciones, neto y diferencia antes de contabilizar.

**F2.3 Depósito único de efectivo (P0-05).** Definir `CashDeposit` como documento de transferencia de efectivo pendiente a banco, o adoptar `CashMovement` como origen único y enlazar ambos; evitar tener dos asientos. El fondo debe proceder de cobros/ventas en efectivo no depositados y movimientos de caja válidos, con un identificador de aplicación que impida volver a tomar el mismo importe. Al depositar, crear un asiento `Dr Banco / Cr Caja`, un `BankTransaction` y actualizar documentos pendientes dentro de una transacción. Anular debe deshacer las tres partes. Conciliar con cierre/arqueo sin restar dos veces. Migrar/vincular depósitos históricos mediante revisión, sin inventar procedencia de importes antiguos.

**F2.4 Vales.** Diseñar vale como documento con número, sesión de caja, beneficiario, motivo, fecha, importe, responsable, estado (`ABIERTO`, `LIQUIDADO`, `ANULADO`) y comprobantes de soporte. Definir con el contador la contraparte del desembolso y de la liquidación; un egreso genérico a `otrosGastos` no basta para un vale pendiente de justificar. Mostrar vales pendientes en cierre de caja y política explícita para cierre con vales abiertos. Pruebas: emitir, liquidar parcialmente/totalmente, anular, cerrar sesión y consultar trazabilidad.

**F2.5 Cobros por cajero.** Crear consulta y página basadas en eventos de cobro efectivos (`Payment`, cobro al crear venta y posibles cobros mixtos), no en `Sale.total`. Atribuir cajero, fecha, sesión, sede, método, importe bruto, anulaciones/devoluciones y neto. Deduplicar cobros reflejados tanto en `Sale` como en `Invoice`; cuadrar subtotal de efectivo con caja y tarjetas con tarjetas por liquidar. Dar filtros fecha, caja, cajero, método y exportación. Mantener `salesByCashier` como reporte de ventas, con nombre claro.

**Salida F2:** una misma venta de tarjeta o ingreso en efectivo llega una vez al banco y una vez al mayor; el lote y el arqueo explican todos los pendientes y diferencias.

### Fase 3 — compras SRI, Personas y catálogo inicial

**F3.1 Conteo de importación (P1-06).** Mantener `created/skipped/errors`; devolver además `sourceRows`, `validRows`, `duplicateInFile`, `duplicateInSystem` y `invalidRows` cuando puedan calcularse de forma fiable. En XML, «sourceRows» es número de XML recibidos; en TXT, número de filas de comprobantes tras excluir encabezados, totales y líneas vacías según el parser. Hacer explícita la igualdad `sourceRows = imported + alreadyExisting + duplicateInFile + invalidRows + excludedByDocumentType` (con categorías que no se solapen). La pantalla debe indicar «en el archivo/reporte SRI cargado»; **no** «en todo el SRI» sin una consulta remota validada y un período definido. Si se autoriza tal integración, agregar una fase separada de autenticación, paginación y reconciliación de conteos por fecha/identificación.

**F3.2 Identidad y rol proveedor (P1-07).** Crear servicio de búsqueda/alta por `clinic + tipoIdentificacion + identificación normalizada`. Reutilizar el `Supplier` existente, agregar `PROVEEDOR` a `roles` con `$addToSet`, preservar `CLIENTE` y otros roles; no duplicar por RUC. Conservar razón social, nombre comercial, dirección, teléfono y correo **solo si el XML/TXT contiene cada dato**; no fabricar contacto ni sobrescribir un valor confirmado por uno vacío o menos confiable. Guardar procedencia/fecha del dato si se requiere auditoría. Reusar el servicio al importar TXT/XML y al contabilizar; migrar registros duplicados solo después de mapear referencias desde compras, pagos y personas. Pruebas con proveedor nuevo, cliente existente que también compra, importación repetida y campos ausentes.

**F3.3 Plan de cuentas (P1-08).** Comparar `server/utils/defaultChartOfAccounts.js` y los roles de `accountMap.js` con `micartaonline/backend/src/data/ecuadorChartOfAccounts.js` y el catálogo vigente validado por contador. Decidir si el plan clínico será subconjunto extendido, versión seleccionable o catálogo completo; no sustituir cuentas usadas ni códigos configurados por una copia ciega. Integrar `seedChartOfAccounts` en la creación de **la clínica/unidad contable**, no en `Company.create` sin resolver la titularidad. Idempotencia ante reintento y concurrencia, padres antes de hijos, índices por clínica+código, rollback/estado de aprovisionamiento si falla, y cobertura de los roles obligatorios. Las clínicas existentes requieren migración aditiva en `dry-run` y reporte de conflictos. Pruebas: clínica nueva lista para asiento sin botón manual; dos ejecuciones no duplican; cuentas existentes personalizadas permanecen intactas; dos sucursales de una empresa conservan alcance correcto.

**F3.4 Contabilización de compras.** Mantener la clasificación consciente de líneas entre gasto, inventario y activo; el sistema no debe elegir una cuenta de gasto por defecto para ocultar datos faltantes. Mostrar al contador campos del XML/TXT ya recuperados para confirmar o corregir, sin volver a capturar RUC y razón social. La autorización/contabilización solo ocurre después de validar proveedor, importes, fecha, cuentas y retenciones. Registrar qué dato fue corregido respecto de la fuente.

### Fase 4 — activos fijos y cierre mensual

**F4.1 Vista previa de depreciación pendiente (P1-04).** Calcular desde `FixedAsset.startDate`, vida útil, valor residual, historial e importes ya reconocidos; enumerar por activo cada mes elegible hasta el último mes cerrado o elegido. Excluir activos sin depreciación, dados de baja o aún no disponibles; marcar períodos cerrados y cuentas incompletas como bloqueos visibles. No modificar datos durante preview. Mostrar importe por mes, gasto, depreciación acumulada y saldo final.

**F4.2 Ejecución de meses pendientes.** Reutilizar o extraer la lógica actual de `runDepreciation`, con un asiento idempotente por clínica+mes y vínculos explícitos a los activos incluidos. Ejecutar por orden cronológico; si un mes falla, informar exactamente cuál y no saltarlo silenciosamente. No contabilizar en período cerrado ni sobrepasar base depreciable. El botón «Depreciar pendientes» debe pedir rango y mostrar preview antes de ejecutar. Pruebas: activo comprado a mitad de año, varios activos/categorías, baja, residual, reintento y períodos cerrados.

**F4.3 Automatización.** Solo después de estabilizar F4.1/F4.2, programar ejecución al cierre mensual o tarea controlada con registro de ejecución, reintentos seguros y aviso de errores. No usar un cron que escriba en períodos cerrados o pendientes de revisión. El contador debe poder revisar el lote antes de mayorizar si así se acuerda.

### Fase 5 — notas, cartera y servicios clínicos

**F5.1 NC/ND emitidas (P1-09).** Diseñar máquina de estados fiscal/contable: borrador, pendiente de emisión, enviada, autorizada, rechazada, anulada, y un estado contable explícito. Precisar con contador el hecho económico que habilita ajustar saldo/IVA/ingreso. Para las notas emitidas, la creación del borrador no debe alterar cartera y mayor de forma irreversible si después se rechaza. Implementar operación idempotente de contabilización y reverso documental; contemplar notas recibidas con reglas propias. Revisar qué reportes SRI consumen la fecha y estado de notas antes de cambiarlo. Pruebas con autorización, rechazo, reintento, nota parcial, factura ya cobrada y período cerrado.

**F5.2 CxC y CxP.** Mantener la resolución canónica `Sale`↔`Invoice`. En la pantalla `Receivables.jsx`, separar claramente «pendiente de cobro» de «historial/documentos pagados»; un documento PAGADO puede verse en historial sin sumar al pendiente. Conciliar todos los saldos con mayor por cuenta de control, incluidas aplicaciones de anticipos y notas. El mismo principio se aplica a `Payable` y pagos masivos. No crear otro submayor paralelo.

**F5.3 Ingresos diferidos y clínica.** Revisar paquetes prepagados, consumo por sesión, cancelación, devolución y sesiones no usadas. Una venta de paquete no equivale a ingreso de servicio devengado en su totalidad; vincular el reconocimiento al evento clínico verificable. Si existen aseguradoras/convenios, modelar copago, CxC de aseguradora, glosa y liquidación por separado del saldo del paciente. Decidir con negocio antes de introducir esas entidades; no copiar mesas, propinas, plataformas de reparto ni costeo por plato.

### Fase 6 — reportes, conciliación y cobertura restante

**F6.1 Reportes y conciliación.** Validar con datos de prueba cruzados: balance, resultados, mayor, flujo directo/indirecto, antigüedad CxC/CxP, depósitos, tarjetas, conciliación bancaria, ATS, 103, 104, RDEP y exportaciones Supercias. Los importes de un reporte deben poder rastrearse a documentos y asientos. La conciliación de extracto debe conservar pendientes y diferencias al reabrir/cerrar, sin crear un asiento por marcar una partida ya existente como conciliada.

**F6.2 Nómina.** La clínica ya contabiliza cierre, obligación y pago. Determinar si necesita planilla consolidada IESS/BIESS y conciliación por empleado/mes como Micartaonline. Si se aprueba, partir de los pasivos reales generados por nómina y no crear otra deuda al emitir la planilla. Validar tasas y formatos con contador antes de emitir documentos oficiales.

**F6.3 Inventario, centros de costo y presupuestos.** Mantener FIFO y ajuste por conteo ya implementados. Probar fármacos/insumos por lote, caducidad, consumo en atención, traspaso entre bodegas y devolución. Asignar costo e ingreso a sede/especialidad/médico con regla trazable; comparar presupuestos contra asientos reales, sin doble atribución por sucursales. Estos son trabajos de adaptación clínica, no portabilidad de funcionalidades de restaurante.

### Mapa de ejecución para repartir trabajo entre agentes

Cada fila identifica el punto de entrada; **leer también el modelo, las rutas y las llamadas desde la interfaz antes de editar**. Las pruebas citadas son una base existente para ampliar, no una afirmación de que hoy cubren el caso nuevo.

| Paquete | Depende de | Backend y modelos de entrada | Interfaz de entrada | Pruebas existentes relacionadas |
|---|---|---|---|---|
| F1.1 Pagos de compra | F0 | `controllers/paymentController.js`, `purchaseInvoiceController.js`; `models/PurchaseInvoice.js`, `Payable.js`; `routes/payments.js` | `PurchaseInvoices.jsx`, `Payments.jsx` | `purchaseFlow.integration.test.js`, `paymentIdempotency.test.js`, `sriPurchaseImport.test.js` |
| F1.2 Reverso | F0 | `controllers/journalEntryController.js`, `utils/accounting.js`; `routes/journalEntries.js` | `JournalEntries.jsx`, visor de asiento | `journalEntry.test.js`, `accountingIntegration.audit.test.js` |
| F1.3 Ejercicios | F0 y política contable | `controllers/fiscalPeriodController.js`, `accountingReportsController.js`; `models/FiscalPeriod.js`, `JournalEntry.js` | `FiscalPeriods.jsx`, `FinancialReports.jsx` | `fiscalDocumentDate.integration.test.js`, `accountingIntegration.audit.test.js` |
| F1.4 Salud/cartera | F1.1–F1.3 | `controllers/accountingHealthController.js`, `services/receivableObligations.js`; `models/Receivable.js`, `Payable.js` | `AccountingHealth.jsx`, `Receivables.jsx` | `cashFlowObligations.integration.test.js`, `accountingIntegration.audit.test.js` |
| F2.1–F2.2 Tarjetas | F1.2, decisión lote | `controllers/creditCardBatchController.js`, `cardSettlementController.js`; `models/CreditCardBatch.js`, `CardSettlement.js` | `CreditCardBatches.jsx`, `CardSettlements.jsx` | `cardSettlementFixes.integration.test.js`, `cardSettlementRetentions.integration.test.js` |
| F2.3–F2.4 Caja | F1.2, decisión vale | `controllers/cashClosingController.js`, `cashDepositController.js`, `bankController.js`; `models/CashClosing.js`, `CashMovement.js`, `CashDeposit.js` | `CashClosing.jsx`, `CashDeposits.jsx`, `CashBox.jsx` | `banksChecksDepositsUx.integration.test.js`, `bankJournalLedger.integration.test.js` |
| F2.5 Cobros cajero | F2.3, reglas de atribución | `controllers/accountingReportsController.js`, `paymentController.js`, `saleController.js` | `SalesReports.jsx` y nueva página contable | `accountingIntegration.audit.test.js`, `cashFlowObligations.integration.test.js` |
| F3.1 Importación | F0 | `controllers/purchaseInvoiceController.js`, parsers TXT/XML en ese archivo | `PurchaseInvoices.jsx` | `sriPurchaseImport.test.js`, `purchaseImportLarge.test.js` |
| F3.2 Personas | F3.1 | `controllers/supplierController.js`, `purchaseInvoiceController.js`; `models/Supplier.js` | `Suppliers.jsx`, `PurchaseInvoices.jsx` | `sriPurchaseImport.test.js`, `purchaseDuplicate.test.js` |
| F3.3 Catálogo | decisión empresa/sucursal | `controllers/companyController.js`, `clinicController.js`, `chartOfAccountController.js`; `utils/defaultChartOfAccounts.js`, `accountMap.js`, `accounting.js` | `ChartOfAccounts.jsx` | `accountingScope.integration.test.js`, `accountingIntegration.audit.test.js` |
| F4 Depreciación | F1.3, catálogo | `controllers/inventoryAdvancedController.js`; `models/FixedAsset.js`; `routes/inventoryAdvanced.js` | `FixedAssets.jsx` | `fixedAssets.integration.test.js`, `fixedAssetsFromPurchase.integration.test.js` |
| F5 Notas y diferidos | F1.2, política NC | `controllers/creditDebitNoteController.js`, `deferredIncomeController.js`, `saleController.js`; `models/CreditDebitNote.js`, `DeferredIncome.js` | `CreditDebitNotes.jsx`, `DeferredIncome.jsx`, `Receivables.jsx` | `sriReports.integration.test.js`, `cashFlowObligations.integration.test.js` |
| F6 Reportes/resto | F1–F5 según dato | `controllers/accountingReportsController.js`, `sriSuperciasReportsController.js`, `payrollController.js`, `inventoryAdvancedController.js` | `FinancialReports.jsx`, `SriReports.jsx`, `Payroll.jsx`, `Kardex.jsx`, `CostCenters.jsx` | `sriReports.integration.test.js`, `payroll.integration.test.js`, `inventoryKardex.integration.test.js` |

**Secuencia sugerida para un agente autónomo:** tomar un paquete, comprobar que sus dependencias están resueltas, escribir primero el caso de integración que exhibe la diferencia, aplicar el cambio mínimo en servidor y cliente, volver a probar los recorridos vinculados, actualizar documentación de usuario y registrar qué datos históricos necesitan tratamiento. Si varios agentes trabajan en paralelo, dividir por archivos y acordar una sola decisión sobre contratos compartidos (`JournalEntry`, `Payment`, `BankTransaction`, `Receivable`).

## 5. Matriz mínima de pruebas de aceptación

| Caso | Preparación y acción | Resultado verificable |
|---|---|---|
| A01 | Importar compra XML y pedir pago por API simple y masiva antes de contabilizar. | Ambas responden `NOT_POSTED`; no cambian `Payment`, banco, CxP ni asiento. |
| A02 | Contabilizar la compra y pagar parcialmente, repetir petición con misma clave. | Una obligación, un pago aplicado y un asiento; saldo de documento = saldo CxP = cuenta de control. |
| A03 | Reversar desde diario un asiento de venta y uno manual. | Operativo rechazado sin cambios; manual permitido y trazado. |
| A04 | Cerrar año y abrir siguiente con saldos conocidos; repetir llamadas. | Balance inicial igual a final anterior, sin duplicación; un cierre/apertura efectivos por ejercicio. |
| A05 | Crear venta con tarjeta, lote, dos liquidaciones parciales y reintentar acreditación. | Bruto asignado una vez; banco = netos acreditados; comisiones/retenciones cuadran; lote pasa de parcial a liquidado. |
| A06 | Depositar efectivo cobrado y probar segundo depósito del mismo origen por las dos pantallas. | Solo una salida de caja, un ingreso a banco y una `BankTransaction`; segundo intento bloqueado o sin efecto. |
| A07 | Abrir caja, emitir vale, liquidarlo y cerrar; consultar cobros de dos cajeros con pagos mixtos. | Vale trazable y caja cuadrada; cobros por método/cajero equivalen a eventos de pago, no al total de ventas. |
| A08 | Importar TXT con encabezado, repetidos, inválidos y dos facturas nuevas. | Resumen de fuente/importadas/existentes/repetidas/errores con suma coherente y texto «archivo cargado». |
| A09 | Importar factura de un RUC ya registrado como cliente. | Una persona conserva `CLIENTE` y agrega `PROVEEDOR`; compras apuntan al mismo registro. |
| A10 | Crear clínica nueva y ejecutar aprovisionamiento dos veces. | Catálogo y roles completos una sola vez; otra clínica/empresa no resulta alterada. |
| A11 | Depreciar tres meses pendientes, reintentar y dar de baja un activo. | Un asiento por mes elegible; valor residual respetado; no contabilización en período cerrado. |
| A12 | Crear NC emitida y simular rechazo/autorización SRI. | Saldo y mayor cambian exactamente en el estado aprobado por contador; reintento no duplica. |
| A13 | Venta a crédito facturada y cobrada, con duplicado `Receivable` histórico. | Cartera pendiente y salud contable cuentan una obligación; documento pagado queda en historial. |

Ejecutar primero pruebas de unidad de parsers/cálculos donde aporten valor; usar integración con Mongo efímero para asientos, transacciones y rutas. Ver scripts en `server/package.json` (`npm test`, `npm run test:unit`, `npm run test:flows`) y compilación de cliente con `npm run build` desde `client`. Añadir pruebas enfocadas en el riesgo modificado; no exigir ejecutar toda la suite por cada cambio menor si un conjunto preciso ya valida la operación.

## 6. Migración y despliegue por etapas

1. **Antes de alterar datos:** respaldo verificable, conteos por clínica y período, lista de documentos afectados, conciliación inicial mayor↔submayores↔bancos y revisión del contador. La auditoría puede mostrar diferencias legítimas por migración: no corregirlas por importe agregado sin identificar documentos.
2. **Compatibilidad:** nuevas referencias entre lote/liquidación y depósito/origen deben añadirse de forma opcional a los datos antiguos; backfill solo si la relación es demostrable. Mantener lectura de registros anteriores durante transición.
3. **Corrección histórica:** usar asientos de reverso y documentos de ajuste con motivo, actor y fecha; no editar/borrar asientos contabilizados para «cuadrar» saldos. Toda corrección debe tener vista previa y reporte por clínica.
4. **Activación:** primero guardas del servidor y consultas de diagnóstico; después nuevos flujos en una clínica de prueba; luego migración supervisada de datos históricos; finalmente interfaz y automatizaciones. Si hay bandera de función, documentar valor predeterminado y plan para retirarla.
5. **Control posterior:** comparar por período total de libro mayor, CxC, CxP, caja, banco, tarjetas pendientes, ingresos diferidos y depreciación; investigar diferencias antes de ampliar despliegue.

## 7. Definición de terminado para cada tarea

Una tarea se considera terminada cuando: (1) el flujo de API y pantalla representa la misma regla; (2) hay pruebas de éxito, fallo y repetición pertinentes; (3) documento, saldo, submayor, banco/inventario y asiento concilian; (4) la anulación/reverso mantiene esa conciliación; (5) se conserva alcance por clínica/empresa y permisos; (6) existe diagnóstico o migración para datos anteriores si cambió el modelo; (7) se actualiza la guía de usuario correspondiente; (8) el PR explica cualquier decisión de negocio pendiente, el riesgo residual y los comandos de verificación ejecutados.

**Prioridad práctica:** F1.1 y F1.2 pueden ejecutarse primero como bloqueos claros. F1.3 requiere decisión de política de ejercicio y revisión de aperturas existentes. F2 debe preceder a la navegación nueva de lotes y a cualquier automatización de depósitos. F3, F4 y F5 pueden avanzar después de estabilizar sus dependencias del mayor. F6 valida el conjunto con contabilidad clínica real.
