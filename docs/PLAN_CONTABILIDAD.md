# Plan de implementación contable — Clínica (Ecuador)

> Objetivo: llevar el módulo contable/financiero/tributario a nivel **Contífico adaptado a clínica**,
> con integridad de subledger real, trazabilidad fiscal y flujos operativos sin fugas de datos.
> Este documento es la hoja de ruta. No es "lo básico": cada fase deja el sistema en un estado
> coherente, auditable y probado.

---

## 0. Estado actual (diagnóstico)

**Base sólida ya construida:**
- Motor de asientos ([server/utils/accounting.js](../server/utils/accounting.js)) con transacciones Mongo,
  idempotencia por `sourceModel+sourceRef+sourceAction`, reverso que conserva historia, validación de período.
- Motor de IVA ([server/utils/tax.js](../server/utils/tax.js)) que separa base e IVA aunque el precio lo incluya.
- Roles de cuenta configurables ([server/utils/accountMap.js](../server/utils/accountMap.js)).
- Facturación electrónica EC ([server/modules/invoicing/ec/](../server/modules/invoicing/ec/)): clave de acceso, firma XAdES, envío SRI, RIDE.
- Modelos: `JournalEntry`, `AccountBalance`, `FiscalPeriod`, `Sale`, `PurchaseInvoice`, `Payment`, `BankAccount`,
  `BankTransaction`, `CardSettlement`, `CashClosing`, `RetentionVoucher`, `CostCenter`, `Warehouse`, `FixedAsset`, etc.

**Grietas detectadas (se atacan en este plan):**

| # | Severidad | Hallazgo | Ubicación |
|---|---|---|---|
| G1 | 🔴 | Códigos de cuenta hardcodeados en pagos/compras (ignoran `AccountingConfig`/roles) | paymentController, purchaseInvoiceController |
| G2 | 🔴 | Doble-submit duplica venta (sin idempotencia en `createSale`) | saleController:70 |
| G3 | 🔴 | Dos subledgers de cobro paralelos (`collectSale` vs `Payment`) que no se hablan | sale/payment controllers |
| G4 | 🔴 | Anular venta no revierte progreso de tratamiento | saleController:620 |
| G5 | 🟠 | Anular venta cobrada deja Clientes descuadrado (no reversa cobros) | saleController:620 |
| G6 | 🟠 | IVA en compras no separa crédito tributario / no deducible | purchaseInvoiceController:155 |
| G7 | 🟠 | Costo promedio no reversible (sin kardex por capas) | purchaseInvoiceController:204 |
| G8 | 🟠 | Anticipo de paciente no se reconoce como ingreso al prestar servicio | paymentController:153 |
| G9 | 🟠 | Código muerto: versión legacy no transaccional debajo de cada flujo | sale/purchase controllers |
| G10 | 🟠 | Comprobante de retención electrónico no se emite (modelo + XML existen) | purchaseInvoiceController |
| G11 | 🟡 | Sin lotes/caducidad en inventario (crítico para fármacos) | Product/InventoryMovement |
| G12 | 🟡 | Caja sin sesión por cajero/turno; sin conciliación bancaria real | cashClosing/bankController |

---

## 1. Principios de diseño (objetivo de arquitectura)

1. **Un solo libro mayor, un solo subledger por contraparte.** Toda cartera (paciente, proveedor,
   aseguradora, tarjeta) se modela como documentos con `balance` + aplicaciones, no en flujos paralelos.
2. **Toda cuenta se resuelve por rol** (`getAccount`), nunca por código fijo. El contador puede remapear.
3. **Toda operación compuesta es transaccional** (ya es la norma; se completa donde falta).
4. **Toda operación que el usuario pueda repetir lleva idempotencia** (`idempotencyKey` cliente + índice único).
5. **El asiento es consecuencia, no fuente.** Anular/editar un documento reversa su asiento; nunca se edita el asiento a mano salvo en ajustes manuales.
6. **Inventario valorado por capas (kardex)**, no por promedio móvil destructivo.
7. **Lo fiscal es inmutable tras autorización SRI.** Solo se corrige con NC/ND o anulación fiscal.
8. **Centros de costo en cada asiento** (sucursal, doctor, especialidad) para rentabilidad por unidad.
9. **Feature flags** para migrar flujos sin romper producción.
10. **Cada fase entrega pruebas automatizadas** y deja `node --check` limpio.

---

## 2. Modelo de datos objetivo

### Nuevos modelos
- **`Receivable` / `Payable`** (o un único `LedgerDocument` polimórfico): cartera unificada.
  Campos: `clinic, party{model,ref,name}, sourceDoc{model,ref}, type(FACTURA|VENTA|NC|ND|ANTICIPO),
  issueDate, dueDate, currency, total, applied, balance, status(ABIERTO|PARCIAL|PAGADO|ANULADO),
  costCenter`. Índice `{clinic, party, status}`.
- **`PaymentApplication`** (si no se fortalece `Payment`): `payment, document, amount, date`.
- **`InventoryLayer`** (kardex por capas FIFO/costo específico): `clinic, product, warehouse, lot,
  expiryDate, qtyIn, qtyRemaining, unitCost, sourceMovement, date`. Índice `{clinic, product, warehouse, date}`.
- **`Lot`** (opcional, si se normaliza): `product, code, expiryDate, supplier`.
- **`CashSession`**: `clinic, branch, cashier, openedAt, openedBy, openingFloat, status(ABIERTA|CERRADA),
  closedAt, expectedCash, countedCash, difference`. Reemplaza el alcance de turno de `CashClosing`.
- **`CashMovement`**: `session, type(INGRESO|EGRESO|RETIRO|DEPOSITO|GASTO), amount, paymentMethod, journalEntry`.
- **`InsurancePolicy` / `Insurer`** y **`InsuranceClaim`** (aseguradoras: copago, CxC aseguradora, glosa).
- **`TreatmentPackage`** ya parcialmente cubierto por `Treatment`; añadir `deferredIncome`, `sessionsIncluded`,
  `sessionsUsed`, `recognizedIncome`.
- **`RetentionVoucher`** (ya existe) → conectarlo al flujo de emisión.

### Cambios a modelos existentes
- **`Sale`**: añadir `idempotencyKey` (único parcial por clínica), `costCenter`, `branch`, `doctor` (ya),
  `receivable` (ref al documento de cartera).
- **`Product`**: ya tiene campos tributarios y de cuenta; añadir `tracksLot`, `tracksExpiry`,
  `vatDeductible` (default true), `costingMethod(AVG|FIFO)`.
- **`PurchaseInvoice`**: añadir `vatCreditAmount`, `vatNonCreditAmount`, `deductible(bool)`, `retentionVoucher` (ref).
- **`InventoryMovement`**: añadir `warehouse`, `lot`, `expiryDate`, `layerRefs[]`.
- **`AccountingConfig`**: añadir mapeos de roles nuevos (ver fase 1) y parámetros fiscales
  (`vatRate`, `pricesIncludeVat`, `retentionDefaults`, `vatProportionality`).

### Roles de cuenta a añadir en [accountMap.js](../server/utils/accountMap.js)
`ivaComprasNoCredito`, `anticipoClientes` (hoy 2.1.01.03 mezclado), `cxcAseguradora`,
`glosaAseguradora`, `comisionMedicaGasto`, `comisionMedicaPorPagar`, `ingresoDiferido`,
`mermaInventario`, `consumoInternoInventario`, `faltanteCaja`/`sobranteCaja` (ya), `retIvaPorPagar`/`retRentaPorPagar` (ya).

---

## 3. Fases de implementación

Cada fase: **objetivo → tareas concretas → criterios de aceptación → pruebas → riesgo**.

---

### FASE 0 — Fundamentos y red de seguridad  *(0.5–1 sem)*
**Objetivo:** poder cambiar flujos sin miedo.
- Crear harness de pruebas de integración con MongoDB en memoria (`mongodb-memory-server`) además de los
  `node:test` actuales.
- Helpers de test: `seedClinic()`, `seedChartOfAccounts()`, `openPeriod()`, factory de productos/proveedores.
- Introducir `featureFlags` por clínica (`AccountingConfig.flags`) para activar flujos nuevos gradualmente.
- **Limpiar G9**: borrar todo el código legacy muerto debajo de los bloques transaccionales en
  `saleController`, `purchaseInvoiceController`, `paymentController`, `bankController`, `cardSettlementController`.

**Aceptación:** suite corre contra Mongo efímero; `node --check` limpio; controllers sin ramas muertas.
**Riesgo:** bajo. Es limpieza + tooling.

---

### FASE 1 — Estabilización de integridad (los 🔴)  *(1–1.5 sem)*
**Objetivo:** que cartera, caja e impuestos cuadren siempre.

1. **G1 — Eliminar códigos hardcodeados.** Reemplazar en `paymentController` y `purchaseInvoiceController`
   todos los `findAccount({code:'...'})` por `getAccount(role)`. Añadir roles faltantes a `accountMap`.
2. **G2 — Idempotencia de venta.** `createSale` acepta `idempotencyKey`; índice único parcial
   `{clinic, idempotencyKey}` en `Sale`; si llega repetida, devolver la venta existente. Aplicar el mismo
   patrón a emisión de factura y a `purchaseInvoice.create`.
3. **G3 — Unificar cobro.** Decisión: **`collectSale` se reescribe sobre `Payment`** (o sobre el nuevo
   `Receivable`). Un cobro de venta crea un `Payment` con aplicación al documento de cartera de esa venta.
   `collectSale` queda como atajo que internamente llama al servicio de pagos. Resultado: un solo subledger.
4. **G4 + G5 — Anulación completa.** `cancelSale` (dentro de la transacción):
   - revierte progreso de tratamiento (`completed -= qty`, quita `completionRefs`),
   - bloquea o reversa cobros previos (si hay `Payment` aplicados, exige reversarlos primero o los reversa en cascada),
   - reversa asiento e inventario (ya lo hace).
5. **G6 — IVA crédito tributario.** En compra, clasificar IVA en `ivaCompras` (con derecho) vs
   `ivaComprasNoCredito`/gasto según `deductible` y tipo de bien. Guardar `vatCreditAmount`/`vatNonCreditAmount`.

**Aceptación:**
- Remapear una cuenta en `AccountingConfig` y verificar que venta y cobro usan la misma → Clientes concilia.
- Doble POST de venta con misma `idempotencyKey` → una sola venta, un solo asiento.
- Anular venta con tratamiento y cobro parcial → progreso revertido, Clientes en cero, asientos cuadrados.
**Pruebas:** une G1–G6 en tests de integración (ver §4).
**Riesgo:** medio (toca flujos productivos). Mitigar con feature flag + pruebas.

---

### FASE 2 — Motor tributario y facturación electrónica robusta  *(1.5–2 sem)*
**Objetivo:** factura/NC/ND electrónicas a prueba de SRI.
- Centralizar el cálculo de impuestos del documento (ya en `tax.js`) y exponer `totalSinImpuestos`,
  `totalConImpuestos`, `codigoPorcentaje`, `formaPago` SRI desde un único builder.
- **Idempotencia de emisión**: una venta no puede emitir dos facturas; estados claros
  `BORRADOR→FIRMADA→ENVIADA→AUTORIZADA→NO_AUTORIZADA→DEVUELTA→ANULADA→PENDIENTE_ANULACION`.
- **Reintentos** con backoff y log de errores SRI persistido; cola para autorización diferida.
- **Notas de crédito/débito** electrónicas que afectan CxC, IVA, ingresos e inventario (si aplica) y se
  ligan a la factura original con aplicación total/parcial.
- **Anulación fiscal**: no permitir anulación local de un documento AUTORIZADO sin el flujo SRI correcto.

**Aceptación:** factura con IVA 15/0/exento correcta; NC reduce CxC e IVA; reintento no duplica clave de acceso.
**Pruebas:** XML válido contra XSD del SRI; estados; idempotencia.
**Riesgo:** medio-alto (integración externa). Probar siempre en ambiente de **pruebas SRI** primero.

---

### FASE 3 — Inventario valorado (kardex por capas)  *(1.5 sem)*
**Objetivo:** costo de venta y valor de inventario reales y reversibles.
- Implementar `InventoryLayer` (FIFO por defecto, costo específico por lote opcional).
- Compra: crea capas. Venta: consume capas FIFO y calcula COGS exacto. Anulación: devuelve a la capa.
- **Lotes y caducidad** (`tracksLot`, `tracksExpiry`): selección de lote en venta, alertas de vencimiento,
  reporte de próximos a caducar (clave para fármacos/sueros).
- Asientos de **merma/caducidad** (`Dr Merma / Cr Inventario`), **consumo interno** (`Dr Gasto consumo / Cr Inventario`),
  **ajuste por conteo físico** (`PhysicalCount` → asiento de sobrante/faltante).
- Trazabilidad por **bodega** (`Warehouse`).

**Aceptación:** vender de dos capas con costos distintos → COGS ponderado correcto; anular → capa restaurada;
conteo físico genera asiento; vencimiento alerta.
**Pruebas:** FIFO multicapa, reverso, merma, consumo interno, conteo.
**Riesgo:** medio. Requiere migración de stock actual a capas iniciales (ver §5).

---

### FASE 4 — Compras y retenciones electrónicas  *(1.5 sem)*
**Objetivo:** ciclo de compra fiscal completo.
- Importación XML/TXT SRI con **deduplicación por clave de acceso** (ya parcial), proveedor automático.
- Clasificación de compra: **gasto deducible/no deducible, inventario, activo fijo, ICE, propina, exento/no objeto**.
- **Comprobante de retención electrónico (G10)**: usar `RetentionVoucher` + `buildRetentionXml` ya existentes →
  secuencia por establecimiento/punto de emisión, firma, envío SRI, autorización, RIDE, correo al proveedor,
  asiento (ya lo cubre la compra), estado.
- Pago a proveedor unificado con la cartera (Fase 6): aplica anticipos, parciales.

**Aceptación:** compra con retención emite comprobante autorizado; ATS toma la retención sin duplicar;
compra XML duplicada se rechaza.
**Pruebas:** compra gasto/inventario/activo; retención; XML duplicado; pago parcial.
**Riesgo:** medio-alto (SRI). Ambiente de pruebas primero.

---

### FASE 5 — Caja, bancos, tarjetas y transferencias  *(1.5 sem)*
**Objetivo:** tesorería formal y conciliable.
- **`CashSession`/`CashMovement`**: apertura por cajero/sucursal/punto de emisión, ingresos/egresos/retiros/
  gastos caja chica, cierre con arqueo, faltante/sobrante con asiento, depósito a banco.
- **Bancos**: saldo inicial con asiento de apertura; todo `BankTransaction` ligado a asiento; transferencias
  entre bancos con asiento único; cheques con estado (emitido/cobrado/anulado).
- **Conciliación bancaria** real: importar estado de cuenta, match por monto/fecha/referencia, marcar conciliado,
  reporte de partidas no conciliadas. Comparar **saldo operativo vs mayor**.
- **Tarjetas**: venta → `Tarjetas por liquidar`; liquidación → banco + comisión + retención recibida;
  conciliación con depósito del adquirente; reporte de pendientes y diferencias.

**Aceptación:** abrir/cerrar caja con arqueo y diferencia contabilizada; transferencia con un solo asiento;
liquidación de tarjeta cuadra contra banco; conciliación deja partidas pendientes visibles.
**Pruebas:** sesión caja, faltante/sobrante, depósito, transferencia, liquidación tarjeta, conciliación.
**Riesgo:** medio.

---

### FASE 6 — Cartera unificada (CxC / CxP)  *(1.5 sem)*
**Objetivo:** un estado de cuenta por contraparte, con aging real.
- Introducir `Receivable`/`Payable` (o fortalecer `Payment` + balances de documento) como **única fuente** de cartera.
- Soportar: facturas a crédito, pagos parciales, abonos, **anticipos de pacientes/proveedores**,
  **NC aplicadas**, saldos por paciente/proveedor, **aging CxC/CxP**, **estado de cuenta** documento por documento.
- Reglas: no aplicar a anulados, no pagar más que el saldo, no duplicar, no en período cerrado, todo con asiento,
  pago bancario crea `BankTransaction`, todo transaccional.
- **G8 — Anticipos**: al cobrar antes del servicio → `Cr Anticipos clientes` (pasivo). Al prestar servicio →
  `Dr Anticipos clientes / Cr Ingresos (+IVA)`. El anticipo se "consume" contra el documento.

**Aceptación:** estado de cuenta de un paciente con factura + abono + NC + anticipo cuadra; aging por tramos correcto.
**Pruebas:** parcial, total, sobrepago rechazado, anticipo aplicado, NC aplicada, período cerrado rechazado.
**Riesgo:** medio-alto (es el corazón del subledger; coordinar con Fase 1.G3).

---

### FASE 7 — Lógica clínica específica  *(2 sem)*
**Objetivo:** lo que un ERP genérico no cubre.
1. **Paquetes de tratamiento con ingreso diferido**: vender paquete → `Cr Ingreso diferido`;
   reconocer por sesión usada → `Dr Ingreso diferido / Cr Ingresos`. Reporte de sesiones pendientes vs reconocidas.
2. **Aseguradoras/convenios**: venta con copago → `Dr Caja (copago) + Dr CxC aseguradora / Cr Ingresos (+IVA)`;
   liquidación de aseguradora; **glosa/rechazo** → `Dr Glosa / Cr CxC aseguradora`; descuentos por convenio.
3. **Comisiones médicas** como gasto/provisión: `Dr Gasto comisión médica / Cr Comisión por pagar médico`;
   al pagar → `Dr Comisión por pagar / Cr Banco`. (Hoy las comisiones se calculan en vivo; formalizar el devengo.)
4. **Centros de costo poblados**: que venta, compra, nómina y costo lleven `costCenter`/`branch`/`doctor`/`servicio`.
   Reportes de rentabilidad por sucursal/doctor/especialidad.

**Aceptación:** paquete reconoce ingreso por sesión; venta con aseguradora deja CxC aseguradora; glosa ajusta;
P&L por sucursal y por doctor.
**Pruebas:** paquete (venta+reconocimiento), aseguradora (copago+glosa), comisión médica (devengo+pago).
**Riesgo:** medio. Requiere definición de negocio con el cliente (qué aseguradoras, % comisión).

---

### FASE 8 — Reportes financieros y SRI  *(1.5 sem)*
**Objetivo:** reportes que cuadran con la realidad tributaria.
- Financieros: Balance General, Estado de Resultados, Flujo de Caja, Mayor, Balance de Comprobación,
  Libro Diario, Libro Bancos (validar contra mayor).
- Tributarios: **Formulario 104** (IVA con crédito/no crédito, 0/exento/no objeto, NC/ND),
  **Formulario 103** (retenciones renta), **ATS** (ventas, compras, retenciones, anulados; sin duplicar electrónicas),
  **RDEP** (nómina), retenciones emitidas/recibidas (incluye tarjetas).
- Reglas: excluir anulados correctamente; diferenciar electrónico vs físico; marcar **"preliquidación"**
  mientras no se valide contra el formato oficial completo; advertencias de inconsistencia.

**Aceptación:** 104 cuadra IVA ventas-compras-retenciones; ATS no duplica; balance comprobación en cero.
**Pruebas:** 103/104 preliminar, ATS con reglas básicas, balance de comprobación cuadrado.
**Riesgo:** medio. Validar formatos oficiales vigentes.

---

### FASE 9 — Cierre contable, auditoría y endurecimiento  *(1 sem)*
**Objetivo:** operación de fin de mes/año.
- Cierre de período: bloqueo, asiento de cierre de resultados a `resultadoEjercicio`, apertura del siguiente.
- Re-cálculo y verificación de `AccountBalance` vs `JournalEntry` (cuadre automático nocturno).
- Pista de auditoría completa (`AuditLog`) en todas las operaciones contables.
- Endpoint de "salud contable": detecta asientos descuadrados, documentos sin asiento, subledger ≠ mayor.

**Aceptación:** cerrar mes genera asiento de resultados; chequeo de salud sin hallazgos.
**Riesgo:** bajo.

---

## 4. Estrategia de pruebas (transversal)

Por cada fase, mínimo:
- **Motor**: asiento balanceado / descuadrado falla / cuenta no movible falla / período cerrado falla /
  reverso no altera historia / reverso no se duplica / `AccountBalance` recalcula.
- **Ventas**: contado, crédito, IVA incluido, IVA 0, descuento, tarjeta, transferencia, costo de inventario,
  anulación con reverso completo, **doble-submit idempotente**.
- **Compras**: gasto, inventario, activo, con IVA, con retención, XML duplicado, pago parcial, reverso.
- **Pagos/cartera**: parcial, total, sobrepago falla, período cerrado falla, banco crea `BankTransaction`,
  anticipo aplicado, NC aplicada.
- **Caja/bancos**: apertura, cierre, faltante, sobrante, depósito, transferencia, conciliación.
- **SRI**: factura IVA correcto, IVA 0, NC, retención, 103/104 preliminar, ATS básico.
- **Clínica**: paquete (reconocimiento), aseguradora (copago+glosa), comisión médica (devengo+pago).

Meta de cobertura: flujos contables críticos con prueba de integración end-to-end (no solo unitaria).

---

## 5. Migración de datos

- **Inventario → capas**: generar una `InventoryLayer` inicial por producto con `qtyRemaining = stock` y
  `unitCost = averageCost`. Script idempotente, ejecutable por clínica.
- **Cartera → documentos**: poblar `Receivable`/`Payable` desde `Sale.balance`, `Invoice.balance`,
  `PurchaseInvoice.balance` actuales.
- **Cuentas remapeadas**: validar que toda clínica tenga las cuentas de los roles nuevos (auto-crear con `ensureAccountByCode`).
- Todos los scripts: en `server/scripts/`, idempotentes, con `--dry-run`, sin exponer secretos.

---

## 6. Secuencia recomendada y dependencias

```
Fase 0 (fundamentos)
   └─> Fase 1 (integridad 🔴)  ← arrancar aquí
          ├─> Fase 6 (cartera unificada)  [depende de G3]
          ├─> Fase 2 (facturación/SRI)
          └─> Fase 3 (inventario kardex)
                 └─> Fase 4 (compras/retenciones)  [depende de kardex + SRI]
   Fase 5 (caja/bancos)  [independiente, en paralelo]
   Fase 7 (clínica)  [depende de cartera + inventario]
   Fase 8 (reportes)  [depende de todo lo anterior]
   Fase 9 (cierre/auditoría)  [al final]
```

**Estimación total:** ~12–15 semanas de un dev enfocado. Las fases 0 y 1 son prerrequisito de todo;
el resto admite paralelización.

---

## 7. Riesgos globales y mitigación

| Riesgo | Mitigación |
|---|---|
| Romper producción al refactorizar flujos vivos | Feature flags por clínica + pruebas de integración + despliegue gradual |
| Integración SRI inestable | Ambiente de pruebas SRI primero; reintentos con log; nunca anular fiscal sin flujo |
| Migración de inventario/cartera | Scripts idempotentes con `--dry-run` y verificación de cuadre antes de activar |
| Costo promedio histórico irreversible | Kardex por capas (Fase 3) corta el problema de raíz hacia adelante |
| Definiciones de negocio (aseguradoras, % comisión) | Levantar requisitos con el cliente antes de Fase 7 |

---

## 8. Criterios de aceptación globales (Definition of Done del módulo)

1. Ninguna operación crítica falla contabilidad silenciosamente.
2. Todo asiento balanceado, con cuentas activas y movibles.
3. Períodos cerrados intocables; reverso conserva historia.
4. Ventas gravadas separan base e IVA aunque el precio lo incluya.
5. Ventas de inventario generan costo de venta exacto (kardex).
6. Pagos actualizan saldos sin duplicar; un solo subledger por contraparte.
7. Compras con retención emiten comprobante electrónico y asiento correcto.
8. Tarjetas pasan por "por liquidar" antes de banco; transferencias pendientes no se contabilizan como banco.
9. Saldo de banco operativo y mayor comparables y conciliables.
10. Reportes SRI marcados como preliquidación hasta validar formato oficial.
11. Suite de pruebas de integración verde; `node --check` limpio.
12. Anular cualquier documento revierte TODOS sus efectos (stock, cartera, tratamiento, comisión, asiento).
