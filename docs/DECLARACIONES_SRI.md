# Declaraciones SRI (Formularios 103 y 104)

Módulo de declaraciones **persistentes** con ciclo de vida, cierre contable y obligación
por pagar. Sustituye a la preliquidación de solo lectura de *Reportes SRI*, que se
conserva como vista rápida.

## Ciclo de vida

```
DRAFT ──finalizar──> FINALIZED ──sustituir──> (nueva versión DRAFT)
  │                      │                              │
  │                      ├─ pagar (único paso que mueve Banco)
  │                      └─ anular ──> VOID             └─ al finalizar: la anterior pasa a SUBSTITUTIVE
  └─ recalcular / guardar (sin efectos contables)
```

- Un **borrador** no toca contabilidad ni cartera. Se puede recalcular las veces que haga falta,
  incluso si el período contable ya está cerrado (no tiene efectos).
- **Finalizar** es transaccional e idempotente: genera el asiento de cierre de impuestos y,
  si hay saldo a pagar, la CxP al SRI. Exige el período contable **abierto**. A partir de ahí
  la declaración es **inmutable**.
- Corregir una declaración finalizada **nunca** modifica su snapshot: se crea una versión
  nueva (sustitutiva). Al finalizarla se reversa el asiento de la anterior y se anula su CxP,
  así que no hay pasivo duplicado. Si el período original está cerrado, se indica una **fecha
  contable en un período abierto** y tanto la reversa como el asiento nuevo se registran ahí.
- **El Banco solo se afecta al pagar** la obligación (`POST /tax-declarations/:id/pay`),
  que admite pago parcial. La **CxP es la fuente de verdad** del saldo pendiente.

### ⛔ Declaraciones ya pagadas: la sustitutiva está bloqueada

Sustituir (o anular) una declaración **reversa su asiento**. Si esa declaración ya recibió
pagos, el movimiento bancario —que ocurrió de verdad y no se puede borrar— quedaría sin
contrapartida: «SRI por pagar» terminaría con saldo deudor y la nueva obligación cobraría otra
vez lo ya pagado.

No existe todavía una política contable acordada para corregir una declaración pagada (¿pago en
exceso a favor? ¿crédito contra el período siguiente? ¿nota de crédito del SRI?), así que el
sistema **bloquea** la sustitutiva y la anulación con un mensaje explícito en vez de corromper el
historial. El procedimiento requerido es registrar primero la **reversión del pago** con el
contador. **Pendiente de definir con el contador** antes de habilitarlo.

## Contabilización

**Formulario 104 (IVA)**

| | Cuenta (rol) | |
|---|---|---|
| DEBE | `ivaVentas` | IVA generado del período (cierra el pasivo) |
| DEBE | `ivaComprasNoCredito` | IVA no deducible reclasificado al gasto |
| DEBE | `retIvaPorPagar` | Retenciones de IVA efectuadas como agente |
| HABER | `ivaCompras` | IVA disponible del período (cierra el activo) |
| HABER | `retIvaPorCobrar` | Retenciones de IVA que nos efectuaron |
| HABER | `creditoTributarioIva` | Crédito del mes anterior aplicado |
| HABER | `sriPorPagar` | Obligación resultante *(si hay que pagar)* |
| DEBE | `creditoTributarioIva` | Saldo a favor del período *(si queda crédito)* |

El IVA de una compra marcada **no deducible** ya se cargó al gasto al registrarla: no está
en la cuenta de IVA en compras y no se vuelve a reclasificar. El casillero de "IVA al gasto"
solo puede reclasificar el IVA que quedó como crédito (validado: ni negativo ni mayor al disponible).

**Formulario 103 (retenciones)**

| | Cuenta (rol) | |
|---|---|---|
| DEBE | cuenta con la que se contabilizó cada retención (fallback `retRentaPorPagar`) | Retenciones a proveedores por código |
| DEBE | `irPorPagar` | Retención en relación de dependencia |
| HABER | `sriPorPagar` | Obligación total del período |

Roles de cuenta nuevos: `creditoTributarioIva` (1.1.03.05), `sriPorPagar` (2.1.02.06),
`irPorPagar` (2.1.02.05). Se crean solas en clínicas existentes al usarse (`ensureAccountByCode`);
son configurables por clínica desde *Mapeo de cuentas*.

## Definición de casilleros

La estructura del formulario vive en `server/utils/sriForms/definitions.js` (declarativa y
versionada: sección, orden, casillero, etiqueta, origen, fórmula, editable/calculado,
validaciones, formato, ayuda). **No está en el JSX**: la pantalla se dibuja recorriéndola, y
el backend valida contra la misma definición. La versión usada se congela en cada declaración
(`definitionVersion`).

### Formulario 104 como RÉPLICA (no resumen)

El 104 (`104-borrador-2026.3`) reproduce la estructura del formulario oficial con el formato de
**3 columnas** por concepto — **Valor Bruto / Valor Neto (= Bruto − N/C) / Impuesto Generado** —
en lugar de un resumen. La numeración de adquisiciones y ventas está **confirmada contra el
formulario oficial** que mostró la contadora:

- **Ventas:** `401/411/421` gravadas ≠0%, `403/413` tarifa 0% **sin** derecho, `405/415`
  tarifa 0% **con** derecho (403/405 editables: el reparto lo define el contador), `431/441`
  no objeto, `434/444` exentas, `409/419/429` **TOTAL** (bruto/neto/IVA).
- **Adquisiciones:** `500/510/520` gravadas ≠0% con derecho (excluye activos fijos),
  `501/511/521` **activos fijos** con derecho, `540/550/560` tarifa **5%** con derecho,
  `502/512/522` gravadas ≠0% **sin** derecho *(incluye la "compra en feriado tarifa distinta
  de 0 sin derecho")*, `503-505/513-515/523-525` importaciones, `526/527` ajuste de IVA por NC
  de distinta tarifa, `506/516` importaciones 0%, `507/517` tarifa **0%** (incluye activos
  fijos), `508/518` **RISE / negocios populares**, `509/519/529` **TOTAL**, `531/541` no
  objeto, `532/542` exentas, `543` y `544/554` **notas de crédito por compensar el próximo mes**.

Cada compra se clasifica automáticamente por `docType` + tarifa (`subtotal15`/`subtotal0`/…) +
`deductible` (derecho a crédito) + `lineType` (**activo fijo** por línea) + `ivaRate` (**5%** por
línea). `docType = NOTA_VENTA` va entero a RISE. **Nada queda sin casillero.** Importaciones y 5%
se muestran aunque hoy suelan quedar en 0 (el registro de compras aún no marca importaciones).

**Notas de crédito** (`CreditDebitNote`, `kind: NC`): las EMITIDAS sobre ventas y las RECIBIDAS
sobre compras se restan automáticamente de la base **y del IVA de su misma tarifa** (valor
neto = bruto − NC). La tarifa se toma del `taxBreakdown`/`ivaRate` de la nota; las notas
antiguas la infieren del IVA (>0 ⇒ gravada, =0 ⇒ 0%). Si una NC deja el neto de una tarifa en
negativo, el excedente pasa a **"por compensar el próximo mes"** (`543` para 0%, `544/554` para
gravadas). Restar la NC también deja el cierre contable correcto (el asiento de la NC ya movió
IVA ventas/compras, así que el cierre usa el neto).

> ⚠ Confirmado contra el formulario oficial: la sección de **adquisiciones** y la de **ventas**
> (`boxVerified: true`). **Pendiente** de confirmar: la sección de **crédito tributario /
> resumen / pago** (`530/563/564/565/601/602/605/607/609/615/721/902`), que sigue
> `boxVerified: false`. Por eso el formulario como conjunto se mantiene `verified: false` hasta
> contrastar TODO contra el PDF/XML real (cuando la contadora los deje en `docs/`).

### Formulario 103 (retenciones en la fuente)

- **Casillero 302 (relación de dependencia):** se alimenta de las **nóminas CERRADAS/PAGADAS**
  del período (`utils/payrollWithholding.js`, compartido con el endpoint `GET /payroll/withholding`).
  Base = ingresos gravados (sueldo + horas extra + bonos + comisiones + rubros gravables), valor
  retenido = IR descontado en el rol. Al cerrar un rol, el `recompute` del 103 lo refleja
  automáticamente. *(La prueba end-to-end del cierre de rol queda pendiente del fix del bug de
  nómina "tabla de impuesto a la renta año 1926"; la conexión 103↔nómina se prueba directamente
  vía `payrollWithholdingForPeriod`.)*
- **Casilleros de retención a proveedores (dinámicos):** uno por cada **código de retención** de
  renta usado en el período (catálogo `RetentionRule`). Van apareciendo a medida que se emiten
  retenciones; su base y valor salen de la cabecera `retentions` de la compra (misma fuente de la
  que se genera el `RetentionVoucher`, sin doble conteo).
- **Casillero 332 (no sujetos a retención):** se llena automáticamente con la **base neta de
  compras que NO se retuvo**. Incluye tanto los comprobantes sin ninguna retención como la
  **porción no retenida** de los parcialmente retenidos, de modo que **332 = total neto de compras
  − suma de bases retenidas**. Así la suma de las bases del 103 (códigos + 332) **cuadra** con el
  total neto de compras del período (base sin impuestos: 0% + 15% + no objeto + exenta).
- **Coherencia:** el recompute concilia `base retenida + 332 = total neto de compras` y, si no
  cuadra (p. ej. una base retenida mayor que el subtotal de su comprobante), avisa y **bloquea la
  finalización** (`BASES_103_DESCUADRADAS` / `RETENCION_SOBRE_BASE`), igual que el aviso del 104.

### Eliminar borradores

`DELETE /tax-declarations/:id` borra **físicamente** una declaración **solo en estado DRAFT**
(no tocan contabilidad ni cartera, así que no dejan movimientos huérfanos). Una declaración
FINALIZED nunca se borra: se **anula** (`void`) para conservar el rastro contable. En la UI el
botón *Eliminar* solo aparece sobre borradores, con confirmación. Sirve para limpiar borradores
de prueba y quedarse con el definitivo.

## ⚠ Validación externa pendiente (para el contador)

Los **importes** son auditables: salen de las ventas, compras y nóminas del período, con sus
conciliaciones y el detalle de documentos incluidos/excluidos. Lo que **no está verificado** es:

1. **Numeración y etiquetas de los casilleros.** Se derivaron del formulario de uso corriente,
   pero no se pudieron contrastar contra el instructivo vigente del SRI (los PDF oficiales son
   imágenes escaneadas). Toda la definición está marcada `verified: false` / `boxVerified: false`,
   y la UI lo advierte. Corregirla es editar un solo archivo.
2. **Base del casillero laboral del 103.** El sistema declara los **ingresos gravados** y expone
   también la **base imponible neta** (gravados − aporte personal IESS) en la conciliación. Hay que
   confirmar cuál exige el instructivo vigente. No se aplica ninguna fórmula fija tipo "sueldo − 9,45 %":
   cada rubro se clasifica con un mapeo auditable (`utils/payrollWithholding.js`) que dice qué entró,
   qué no y por qué.
3. **Retenciones de IVA efectuadas como agente.** El sistema asume que se declaran y **pagan con el
   104** (cierra `retIvaPorPagar` y las suma a la obligación). Confirmar si corresponde.
4. **XML.** El archivo que genera el sistema es un **BORRADOR TÉCNICO**: no es el XML oficial, no es un
   archivo DIMM y no está listo para cargar. Falta la especificación (XSD) vigente del SRI para
   generar un archivo válido. Se guarda con su hash como respaldo de lo declarado.
5. **Atribución del IVA de compras.** La compra solo distingue «deducible» de «no deducible»; no
   registra si el IVA es de **atribución directa** a ventas con derecho a crédito, directa a ventas
   sin derecho, o **común** (el único que en rigor debería someterse al factor de proporcionalidad).
   El sistema no inventa esa clasificación: trata **todo el IVA acreditable como común**, lo advierte
   en la conciliación del 104 y deja editable el casillero de IVA al gasto para que el contador
   ajuste. Si se confirma la regla, el paso siguiente es registrar la atribución en la línea de compra
   y aplicar el factor solo al IVA común.

   Lo que sí está garantizado: el IVA de una compra **no deducible ya se cargó al gasto al
   registrarla** y no vuelve a cargarse en el cierre del 104 (no hay doble registro; hay un test que
   lo verifica).

## Idempotencia de los pagos

Los pagos (nómina, declaración SRI y el endpoint genérico de cobros/pagos) aceptan el header
`Idempotency-Key` (o `body.idempotencyKey` por compatibilidad). La clave identifica la
**intención** de pago, no el reintento:

| Situación | Respuesta |
|---|---|
| Misma clave, mismo contenido, **misma obligación** | `200` con `idempotentReplay: true` — se devuelve el pago ya creado. No hay otro asiento, ni otro movimiento bancario, ni otra aplicación a la CxP. |
| Misma clave, contenido distinto (otro importe, banco o fecha) | `409 Conflict`. No se modifica nada. |
| Misma clave, **otra obligación** (otro rol, otra declaración, otra CxP) | `409 Conflict`. **Nunca** se devuelve el pago de la otra obligación. |
| Claves distintas | Dos pagos reales. Dos pagos de USD 100 en momentos diferentes **sí** se registran los dos. |
| Misma clave en **otra clínica** | Sin interferencia: son operaciones independientes. |

La clave y una **huella** (sha256 estable del contenido de la solicitud) se guardan en el
propio pago (`Payroll.payments[]`, `SriDeclaration.payments[]`, `Payment.idempotencyKey`),
con índice único parcial por clínica. La comprobación vive **dentro de la transacción**, así
que dos peticiones en paralelo con la misma clave se serializan y solo una escribe.

La huella incluye siempre la **identidad del destino** —tipo de operación, `sourceModel` y
`sourceRef` (el rol, la declaración o los documentos aplicados)— aunque el id venga del
parámetro de la ruta y no del cuerpo. Y la clave se busca en **toda la clínica**, no solo
dentro del documento actual: el índice único es de clínica y puede colisionar entre
documentos, así que reutilizarla contra otra obligación se traduce a un 409 explícito en vez
de a un `E11000` crudo o —peor— a un replay del pago ajeno.

La UI genera un UUID por intención, lo reutiliza al reintentar, lo renueva al cambiar importe
/ banco / fecha y lo descarta tras el éxito. El botón se bloquea mientras la petición está en
curso, pero **la protección real está en el backend**.

## Migración

Ninguna: las cuentas nuevas se auto-crean al usarse. Para las cuentas por pagar históricas de
compras sin fecha de vencimiento, ver `scripts/backfillPayableDueDates.js`.
