# Guía de usuario — Contabilidad, Tesorería y SRI

> Esta guía explica, **sin tecnicismos**, todo lo que el sistema ofrece para llevar la
> **contabilidad** de la clínica: ventas y facturación, caja y bancos, tarjetas, inventario,
> nómina, compras con retenciones, impuestos del **SRI** y reportes financieros. Está pensada
> para el equipo de **contabilidad**, **caja** y **administración**.
>
> Una idea clave para empezar: **gran parte de la contabilidad se genera sola**. Cuando registras
> una venta, cobras una cita, cierras la caja o corres la nómina, el sistema crea los **asientos
> contables** automáticamente. Tu trabajo es **configurar bien al inicio**, **revisar** y **declarar**.

---

## 1. ¿Qué es este módulo y para quién es?

Es el "motor financiero" de la clínica: un solo lugar para **registrar el dinero que entra y sale**,
**controlar inventario y activos**, **pagar al personal**, **cumplir con el SRI** y **ver cómo va el
negocio** con reportes.

Lo usan tres perfiles (cada uno ve solo lo que le corresponde):

| Perfil | Para qué entra |
|---|---|
| **Cajero** | Vender, cobrar, **abrir y cerrar la caja**, facturar, aplicar descuentos. |
| **Contabilidad** | Todo lo contable: plan de cuentas, asientos, bancos, compras, retenciones, nómina, reportes, SRI. |
| **Administrador** | Todo lo anterior + configuración general y permisos. |

Todo el módulo vive en el **menú lateral izquierdo**, organizado en grupos desplegables:
**Ventas, Inventario, Bancos, Tarjetas de Crédito, Recursos Humanos, Contabilidad** y **Reportería**.

---

## 2. Conceptos clave (glosario rápido)

Entender estas palabras hace que todo lo demás sea fácil:

- **Asiento contable:** el registro de un movimiento de dinero con su **Debe** y su **Haber**
  (siempre cuadran: lo que entra a una cuenta sale de otra). La mayoría se generan **solos**.
- **Plan de cuentas:** el catálogo de "cajones" donde se clasifica el dinero (caja, bancos, ventas,
  IVA, gastos, etc.), bajo la norma de **Supercías**.
- **Cuenta por concepto (mapeo):** la regla que dice *"para las ventas usa esta cuenta, para el IVA
  esta otra"*. Si no la tocas, el sistema usa la cuenta estándar.
- **Período fiscal:** el mes/año contable. Para registrar algo, el período debe estar **abierto**.
  Al final se **cierra** para que nadie modifique lo ya declarado.
- **Centro de costo:** una etiqueta para saber **a qué área** pertenece un ingreso o gasto
  (ej. una sucursal o especialidad).
- **Caja vs. Cierre de caja:** *Caja* es el efectivo del día a día (caja chica). *Cierre de caja* es
  el **arqueo**: abrir el turno con un fondo, y al final contar el efectivo y cuadrarlo.
- **Cartera (CxC / CxP):** lo que te **deben** los clientes (Cuentas por Cobrar) y lo que **debes** a
  proveedores (Cuentas por Pagar).
- **Persona:** un cliente o proveedor (con su RUC/cédula). Se usa en compras, cobros, pagos y SRI.
- **Retención:** una parte del pago que, por ley, **retienes** al proveedor (de IVA o de Renta) y
  luego le **entregas al SRI** en su nombre, con un comprobante.
- **Ingreso diferido:** dinero que ya cobraste pero que corresponde a un servicio **aún no prestado**
  (ej. un paquete de sesiones). Se reconoce como ingreso a medida que se va usando.
- **Kardex:** el historial de entradas/salidas de cada producto y su **costo** (valoración del
  inventario por capas).
- **SRI:** la autoridad tributaria del Ecuador. El sistema genera la **facturación electrónica** y los
  **anexos/declaraciones** (ATS, formularios 103/104, RDEP).
- **Conciliación bancaria:** comparar tus movimientos con el **estado de cuenta del banco** para que
  ambos cuadren.

---

## 3. Mapa del sistema: "quiero hacer X, ¿a dónde voy?"

| Quiero… | Página del menú |
|---|---|
| Registrar una **venta** y cobrarla | **Ventas** (y la caja/cobro de la cita) |
| Emitir una **factura electrónica** | **Facturación** |
| Configurar **RUC, certificado y SRI** | **Config. SRI** |
| **Abrir / cerrar la caja** del día | **Caja (Apertura/Cierre)** |
| Mover dinero de **caja a banco** | **Bancos → Caja** (depositar) |
| Registrar **cuentas y movimientos bancarios** | **Bancos → Cuentas Bancarias** |
| **Conciliar** con el estado de cuenta | **Bancos → Conciliaciones** / **Importar Estado Cta.** |
| Registrar una **compra** y su **retención** | **Contabilidad → Compras** |
| Ver lo que me **deben / debo** | **Contabilidad → Cartera (CxC/CxP)** |
| Registrar un **pago o cobro** | **Bancos → Pagos / Cobros** |
| Definir qué **cuenta** usa cada concepto | **Contabilidad → Config. Cuentas** |
| Crear un **asiento manual** | **Contabilidad → Asientos** |
| Ver el **mayor** de una cuenta / el **balance** | **Consultas Mayor** / **Balance Comprobación** |
| Controlar **stock, bodegas y costo** | **Inventario** (Productos, Bodegas, Kardex…) |
| Registrar **activos fijos** y su depreciación | **Inventario → Activos Fijos** |
| **Pagar al personal** | **Recursos Humanos → Nómina** |
| Cobros con **tarjeta** y sus liquidaciones | **Tarjetas de Crédito** |
| Sacar **Estado de Resultados / Balance** | **Reportería → Rep. Financieros** |
| Declarar **IVA / retenciones / ATS / RDEP** | **Reportería → Rep. SRI** |
| Ver **cómo va el negocio** de un vistazo | **Contabilidad → Dashboard Contable** |
| Revisar que la contabilidad esté **sana** | **Contabilidad → Salud Contable** |

---

## 4. Guía página por página

### 4.0 Antes de empezar: configuración inicial (una sola vez)

Para que todo funcione bien, el **administrador/contador** debe dejar listo esto al inicio:

1. **Config. SRI** *(menú: Config. SRI)* — datos de la empresa y **certificado digital** para la
   firma electrónica: RUC, dirección, **establecimiento** (ej. 001), **punto de emisión**,
   **secuencial** y **ambiente** (*pruebas* o *producción*). Sube tu certificado **`.p12` / `.pfx`**
   con su contraseña; el sistema autocompleta algunos datos a partir de él.
2. **Plan de Cuentas** *(Contabilidad)* — viene un catálogo base bajo norma Supercías; ajústalo si tu
   contador lo necesita.
3. **Config. Cuentas** *(Contabilidad)* — define **qué cuenta usa cada concepto** (ventas, IVA, caja,
   bancos, costo de ventas, etc.). Si dejas *"(Predeterminada)"* usa la estándar. La columna
   **"Efectiva actual"** te dice cuál se está usando; si aparece **"No resuelta"**, hay que asignarla.
4. **Períodos Fiscales** *(Contabilidad)* — crea/abre el año y los meses en los que vas a operar.
5. **Centros de Costo**, **Bodegas**, **Cuentas Bancarias** y **Empleados** según tu operación.

> Consejo: dedica un rato a **Config. Cuentas** al inicio. Es lo que hace que las ventas, compras y
> cierres generen asientos correctos **sin que tengas que tocarlos**.

---

### Grupo: Ventas y Facturación

#### 4.1 Ventas
**Para qué sirve:** registrar lo que se vende. Cada venta **genera su asiento** (ingreso + IVA + costo
de ventas) y **descuenta el inventario** automáticamente. *(El cajero crea ventas pero el historial
solo lo ven admin/contabilidad.)*

**Registrar una venta** (botón **Nueva**):
1. **Cliente:** por defecto *"Consumidor Final"*; o escribe **nombre, cédula/RUC, email, teléfono,
   dirección/ciudad**, o vincula un **paciente**.
2. **Ítems:** busca el producto con el autocompletado, pon la **cantidad** y agrégalo. Repite por cada
   producto/servicio.
3. **Método de pago:** **Efectivo**, **Tarjeta**, **Transferencia** o **Crédito (CxC)**.
   - Tarjeta → elige **tarjeta**, **POS**, **lote** y **voucher**.
   - Transferencia → elige la **cuenta bancaria**.
   - Crédito → queda como **cuenta por cobrar** (cartera).
4. Opcional: **recomendado por** (para comisiones) y **notas**. Guarda.
- Con permiso, desde una venta puedes **Facturarla** (emitir el comprobante electrónico), **ver** el
  detalle, **anular** (solo admin) y **exportar** el listado. Hay filtros por fecha/producto y un
  gráfico de **top productos**.

#### 4.2 Cotizaciones
**Para qué sirve:** armar **propuestas de precio** para el paciente, **compartirlas por WhatsApp** y
luego **convertirlas en venta** si las acepta.

#### 4.3 Facturación
**Para qué sirve:** ver y emitir los **comprobantes electrónicos** (facturas) al SRI a partir de las
ventas. Requiere la **Config. SRI** lista (certificado y secuenciales). En la lista ves el **estado**
de cada documento (autorizado por el SRI, etc.). Lo normal es **facturar desde la venta**.

#### 4.4 Descuentos
**Para qué sirve:** definir **reglas de descuento** que el cajero puede aplicar en ventas/cobros (por
porcentaje o monto, con sus límites). Se administran aquí y aparecen al cobrar.

---

### Grupo: Inventario

#### 4.5 Productos
**Para qué sirve:** el **catálogo** de productos y servicios. Tiene dos pestañas: **Productos** y
**Movimientos**. Arriba puedes **buscar**, filtrar por **categoría** y ver **stock bajo**.

**Crear/editar un producto:** botón **+** (Nuevo) → código, nombre, **categoría** (medicamento,
insumo, servicio, programa, otro), **precios** (compra/venta), **stock** y **stock mínimo**, **unidad**
e **IVA**. Los **servicios** se marcan como "ilimitado" (no controlan stock).

**Registrar un movimiento de stock** (pestaña Movimientos o botón correspondiente): elige el
**producto**, el **tipo** (entrada/salida), la **cantidad** y el **motivo**.

**Carga masiva por Excel:** botón de **carga masiva** → **descarga la plantilla**, llénala y **súbela**.
El sistema informa cuántos productos se **crearon/actualizaron** y los **errores** por fila.
> Si el Excel da error al subir, ábrelo en Excel/Google Sheets y **vuelve a guardarlo como .xlsx**
> (algunos generadores producen un formato que el sistema no puede leer).

#### 4.6 Bodegas
**Para qué sirve:** las **ubicaciones físicas** del inventario. **Nueva bodega** → código, nombre y, si
aplica, su **cuenta contable**. El stock se controla por bodega y permite **traslados** entre ellas.

#### 4.7 Categorías de Inventario
**Para qué sirve:** agrupar productos y asignarles las **cuentas contables** que usan (activo de
inventario, gasto/costo de ventas, ingreso, depreciación para activos, etc.). **Nueva categoría** →
nombre y cuentas asociadas.

#### 4.8 Inventario Consolidado
**Para qué sirve:** una vista global de solo lectura con **SKUs totales**, **unidades en stock** y
**valor total** del inventario sumando todas las bodegas, con el detalle por producto.

#### 4.9 Tomas Físicas
**Para qué sirve:** el **conteo físico** y su ajuste automático.
1. **Nueva toma** → elige la **bodega** (o todas) y una **descripción** → **Iniciar**. El sistema carga
   todos los productos con su **cantidad en sistema**.
2. Haz clic en la toma (estado **BORRADOR**) y escribe la **cantidad contada** de cada producto; verás
   la **diferencia** y su **valor**.
3. **Guardar** para conservar el avance.
4. **Confirmar** → ajusta el stock a lo contado y genera el **asiento de ajuste**.

#### 4.10 Activos Fijos
**Para qué sirve:** registrar equipos/bienes y su depreciación.
- **Nuevo activo fijo** → código, nombre, **valor inicial (de adquisición)** y datos de depreciación.
- El **ojo** abre el detalle: **valor inicial**, **valor depreciado** (acumulado) y **valor actual (en
  libros)**.
- **Correr depreciación mensual:** genera un **asiento consolidado** con la depreciación del mes
  elegido. Es **idempotente por período** (no duplica si lo corres dos veces el mismo mes).

#### 4.11 Kardex
**Para qué sirve:** consultar el **historial** de un producto.
1. Elige el **Producto** (obligatorio) y, opcional, **Bodega**, **Tipo de movimiento** (Ingreso /
   Egreso / Ajuste / Traslado) y rango **Desde/Hasta**.
2. **Consultar.** Muestra el **saldo actual** y cada movimiento con fecha, tipo, bodega, cantidad
   (con signo), **costo unitario** y **saldo acumulado**.

---

### Grupo: Bancos y Tesorería

#### 4.12 Cuentas Bancarias
**Para qué sirve:** registrar tus cuentas de banco, ver su **saldo** y sus **movimientos**.

**La pantalla:** arriba dos botones — **Caja → Banco** (atajo a depositar efectivo) y **Nueva cuenta**.
Debajo, una **tarjeta por cada cuenta** con su nombre, banco, número y **saldo actual** en grande. Al
hacer **clic en una tarjeta** se abre abajo el listado de sus movimientos.

**Crear una cuenta bancaria:**
1. Pulsa **Nueva cuenta**.
2. Llena: **Nombre** (ej. "Cuenta Pichincha principal"), **Banco**, **Nro de cuenta**, **Tipo**
   (Corriente / Ahorros / Virtual), **Ciudad**, **Saldo inicial**, **Próximo cheque #** y
   **Cuenta contable** (elige la del plan que empieza por `1.1.01…`, obligatoria).
3. **Guardar**. (El lápiz edita, el bote de basura elimina.)

**Registrar un movimiento manual:** selecciona la cuenta → **+ Movimiento** y completa:
- **Tipo:** Depósito, Retiro, Cheque emitido, Comisión, Interés, Ajuste, Transferencia (entrada/salida).
- **Fecha**, **Monto**, **N° Comprobante** (obligatorio para depósito, transferencia y cheque),
  **URL comprobante** (opcional), **Referencia** y **Descripción**.
- Si es **transferencia**, elige además el **banco contraparte**.
- En la tabla, la columna **Concil.** muestra ✓ cuando el movimiento ya fue conciliado.

> La mayoría de movimientos bancarios se generan **solos** desde cobros, pagos, depósitos de caja y
> liquidaciones de tarjeta. Usa el movimiento manual solo para comisiones, intereses o ajustes.

#### 4.13 Caja (efectivo pendiente de depósito)
**Para qué sirve:** ver el **efectivo de ventas** que aún no se ha llevado al banco y **depositarlo**.

**La pantalla** muestra tres tarjetas: **Efectivo en caja**, **Seleccionado** y **Cuentas bancarias
disponibles**, y una tabla con cada venta en efectivo pendiente.

**Depositar al banco:**
1. **Marca** las ventas que vas a depositar (casilla por fila, o la casilla del encabezado para todas).
2. Pulsa **Depositar a banco**.
3. Elige la **cuenta bancaria destino**, escribe el **número de papeleta/comprobante** (el que da el
   banco), la **fecha** y una **descripción**.
4. **Confirmar depósito.** El sistema crea el movimiento bancario y su asiento (efectivo → banco).

#### 4.14 Cierre de Caja *(menú: "Caja (Apertura/Cierre)")*
**Para qué sirve:** el **arqueo del turno** del cajero. Es lo que se usa a diario.

**Abrir la caja:**
1. Pulsa **Abrir caja**.
2. Escribe el **Fondo de caja inicial** (el efectivo con el que arrancas) y, si quieres, observaciones.
3. **Abrir caja.** A partir de ahí ves el panel **CAJA ABIERTA** con: fondo inicial, **efectivo de
   ventas**, **tarjeta**, **transferencia** y **efectivo esperado**, todo en vivo.

**Registrar un movimiento durante el turno** (caja chica): botón **+ Movimiento** →
- **Tipo:** Ingreso a caja, Gasto (caja chica), Egreso, Retiro o **Depósito a banco**.
- **Monto**, **Descripción**; si es **Depósito a banco**, elige el **banco destino**.
- Cada movimiento se puede **anular** desde su fila.

**Cerrar la caja:**
1. Pulsa **Cerrar caja**.
2. El sistema muestra fondo, efectivo de ventas, tarjeta y transferencia. Escribe el **Efectivo físico
   contado**.
3. Verás en vivo: **esperado**, **contado** y **diferencia** (faltante en rojo, sobrante en ámbar,
   cuadrado en verde).
4. **Cerrar caja.** Se genera **automáticamente el asiento** de la diferencia (faltante = gasto,
   sobrante = ingreso).

**Historial:** abajo, todos los cierres con fondo, efectivo, esperado, contado, diferencia, cajero y
estado. El **ojo** abre el detalle de cada cierre.

#### 4.15 Conciliaciones
**Para qué sirve:** **cuadrar** tus movimientos con el **estado de cuenta** del banco.

**Cómo se hace:**
1. **Nueva** → elige la **cuenta bancaria**, el **período (desde/hasta)** y el **saldo del extracto**;
   pulsa **Iniciar**. El sistema carga los movimientos del período como ítems.
2. En el panel derecho, **marca con ✓** cada movimiento que también aparece en el extracto del banco.
3. **Guardar** para conservar el avance.
4. Cuando todo cuadre, **Cerrar** la conciliación (queda en estado CERRADA y ya no se edita).

#### 4.16 Importar Estado de Cuenta
**Para qué sirve:** subir el **CSV** del banco para conciliar más rápido.
1. Elige la **cuenta bancaria**.
2. Sube el **archivo CSV** con una línea por movimiento, formato:
   `fecha,descripción,referencia,monto` — el **monto negativo = débito/retiro**.

#### 4.17 Cheques
**Para qué sirve:** administrar las chequeras por cuenta y el estado de cada cheque
(**Disponible / Girado / Cobrado / Anulado**).

**Generar una chequera:**
1. Elige arriba la **Cuenta bancaria** (y un **Estado** para filtrar).
2. Pulsa **Generar chequera** → escribe **Desde Nº** y **Hasta Nº** de cheque → **Generar**. Se crean
   todos los cheques de ese rango como **Disponibles**.

**Anular** un cheque disponible: botón ⃠ en su fila (pide el **motivo**).

#### 4.18 Pagos / Cobros
**Para qué sirve:** registrar un **pago** a proveedor o un **cobro** de cliente, y **aplicarlo** a los
documentos pendientes (baja la **Cartera**).

**La pantalla** tiene un conmutador **Cobros / Pagos** y el botón **Nuevo**.

**Registrar un pago/cobro:**
1. Pulsa **Nuevo** (respeta si estás en modo Pagos o Cobros).
2. Elige **Fecha** y el **Proveedor** (pago) o **Paciente** (cobro). Al elegirlo se cargan sus
   **documentos pendientes**.
3. Elige el **Método** (Efectivo, Transferencia, Cheque, Tarjeta, Depósito). Si no es efectivo, elige
   el **Banco**; en pagos a proveedor no-efectivo es **obligatorio el N° de comprobante** y el sistema
   **valida que el banco tenga saldo**.
4. En **Documentos a aplicar**, marca cada factura/venta y escribe el **monto a aplicar** a cada una.
   Si es un **anticipo** (sin documento), pon el valor en el campo **Anticipo**.
5. Revisa el **Total** y pulsa **Registrar**. (Un pago se puede **anular** desde su fila con la ✕.)

---

### Grupo: Tarjetas de Crédito

#### 4.19 Tarjetas / POS
**Para qué sirve:** registrar las **tarjetas** que aceptas y sus **POS** (datáfonos).
**Nueva tarjeta** → nombre/datos de la tarjeta y la lista de **POS** asociados. El lápiz edita.

#### 4.20 Lotes
**Para qué sirve:** agrupar los cobros con tarjeta en **lotes** para liquidarlos después.
- **Nuevo lote de tarjetas** → completa los datos del lote.
- Un lote en estado **ABIERTO** muestra el botón ✓ **Liquidar**, que te lleva a registrar su liquidación.

#### 4.21 Liquidaciones
**Para qué sirve:** registrar la **liquidación de la adquirente** (banco/procesador de la tarjeta): el
**depósito** que te acreditan, la **comisión** que te cobran, el **IVA** y las **retenciones**.

**Registrar una liquidación** (**Registrar liquidación de tarjeta**):
1. **Fecha de emisión**, **Tipo de documento**, **Proveedor (adquirente)**, **Banco (acreditación)**,
   **Número de documento** y **Comisión por liquidar**.
2. **Cargar facturas:** escribe el **N° de lote** y/o un **rango de fechas** y el sistema trae las
   ventas con tarjeta; **selecciónalas** y se cargan como transacciones (con su **depósito**,
   **comisión**, **IVA** y **retención de IVA**).
3. Agrega las **retenciones** que te aplicó la adquirente (tipo Renta/IVA, **código SRI**, base, % y
   valor).
4. Revisa los **totales** (depósito, comisión, IVA, retenciones y **neto a pagar/acreditar**).
5. Guarda. Luego, desde la lista, puedes **Ver** (ojo), **Editar**, **Acreditar** (✓ contabiliza el
   ingreso al banco) o **Anular** (✕) una ya contabilizada.

---

### Grupo: Recursos Humanos (Nómina)

#### 4.22 Empleados
**Para qué sirve:** la ficha del personal y su sueldo.
**Nuevo** (modal en secciones):
1. **Datos:** Código, tipo de identificación y **Identificación**, nombres, apellidos, email, teléfono,
   **Cargo**, **Departamento**, **Tipo de contrato** (Indefinido/Fijo/Eventual/Juvenil),
   **Frecuencia de pago**, **Fecha de ingreso** y **Cargas familiares**.
2. **Sueldo:** elige **Tipo de sueldo** — **Bruto** (estándar) o **Neto pactado** (el sistema calcula
   el bruto con *gross-up* sobre el IESS 9.45%). Verás el **neto/bruto estimado** en vivo.
3. **Beneficios sociales:** casillas de **Décimo tercero**, **Décimo cuarto**, **Fondos de reserva** y
   **Gasto deducible**, cada uno **Mensualizado** o **Acumulado**.
4. **Sede de origen del sueldo** y datos **bancarios** del empleado.
- El icono de **reloj** muestra el **historial de cambios de sueldo** (con motivo, para auditoría); al
  editar el sueldo conviene escribir la **razón del cambio**.

#### 4.23 Nómina
**Para qué sirve:** generar la planilla mensual.
1. Elige el **Año** (arriba) para ver las planillas.
2. **Generar período** → indica **Año** y **Mes (1-12)** → **Generar**. Se crea en estado **BORRADOR**.
3. Haz clic en la planilla para ver el **detalle por empleado** (sueldo, décimos D3/D4, fondos de
   reserva FR, **IESS**, **impuesto a la renta IR**, préstamos y **neto**). En borrador puedes ajustar
   el **préstamo** a descontar por empleado.
4. **Cerrar** la planilla → genera el **asiento contable**.
5. **Marcar pagado** cuando se haya pagado al personal.

#### 4.24 Préstamos
**Para qué sirve:** registrar **anticipos/préstamos** al personal que luego se **descuentan** en la
nómina. **Nuevo préstamo** → empleado, monto y condiciones.

#### 4.25 Plantillas Décimos
**Para qué sirve:** plantillas para el cálculo de **décimo tercero y décimo cuarto** (beneficios de ley
en Ecuador), que alimentan la nómina.

#### 4.26 Configuración (Nómina)
**Para qué sirve:** los **parámetros de cálculo** de la nómina (porcentajes de aportes IESS, topes,
cuentas contables que usa cada concepto, etc.). Ajústalos una vez con tu contador.

---

### Grupo: Contabilidad

#### 4.27 Dashboard Contable
**Para qué sirve:** ver de un vistazo cómo va el negocio. Arriba eliges el **Período**.
Muestra tarjetas con: **Ventas del mes** (vs. mes anterior con su flecha de tendencia), **Gastos del
mes**, **Utilidad del mes** (con **margen %**), **proyección del próximo período**, **ventas del año**
(vs. año anterior), **saldo total en bancos**, **ventas en efectivo de hoy** y **cuentas por pagar**.
Si hay **productos con stock bajo**, aparece una alerta que abre el listado.

#### 4.28 Plan de Cuentas
**Para qué sirve:** el **catálogo contable jerárquico** (norma Supercías).

- **¿Recién empiezas?** Pulsa **Cargar plan inicial** para sembrar el plan Supercías por defecto
  (no sobrescribe lo que ya exista).
- **Buscar:** por código o nombre, y filtrar por **tipo** (Activo, Pasivo, Patrimonio, Ingreso, Gasto,
  Costo, Orden).
- **Nueva cuenta:** botón **Nueva cuenta** → **Código**, **Nivel** (1–6), **Nombre**, **Tipo**,
  **Naturaleza** (Débito/Crédito), y casillas **Permite movimiento** (solo las que permiten movimiento
  reciben asientos) y **Activa**. El lápiz edita; las cuentas del sistema no se pueden borrar.

#### 4.29 Config. Cuentas (mapeo)
**Para qué sirve:** decirle al sistema **qué cuenta usar para cada concepto** (ventas, IVA, caja,
bancos, costo, etc.). Es una **tabla** con tres columnas: **Concepto**, **Cuenta a usar** y
**Efectiva actual**.
- Si dejas **"(Predeterminada)"** se usa la cuenta estándar.
- Revisa la columna **Efectiva actual**: si dice **"No resuelta"** (en rojo), asígnale una cuenta o
  ese concepto no sabrá dónde registrar.

#### 4.30 Centros de Costo
**Para qué sirve:** clasificar ingresos/gastos por área. **Nuevo** → código y nombre del centro; el
lápiz edita.

#### 4.31 Períodos Fiscales
**Para qué sirve:** controlar en qué meses se puede registrar. Elige el **Año** y **abre/cierra** cada
período. **Solo se puede contabilizar en un período abierto**; al cerrarlo, queda protegido.

#### 4.32 Asientos (libro diario)
**Para qué sirve:** ver y crear asientos. La tabla muestra número, fecha, **origen** (de dónde salió:
venta, caja, manual…), descripción, débito, crédito y **estado** (BORRADOR / CONTABILIZADO / ANULADO).

**Filtrar:** por **fechas**, **estado** y texto, luego **Filtrar**.

**Crear un asiento manual:**
1. **Nuevo asiento** → **Fecha** y **Descripción**.
2. Agrega **líneas** (botón **Agregar línea**): en cada una elige la **Cuenta**, una descripción y el
   **Débito** o **Crédito**.
3. Abajo ves los **totales** y la **Diferencia**: el asiento debe **cuadrar** (débito = crédito) o no
   deja guardar.
4. Pulsa **Guardar borrador** (queda como BORRADOR para revisión) o **Contabilizar** (lo registra).

**Acciones por fila:** **ojo** (ver detalle), y si es **BORRADOR**: ✓ **aprobar/contabilizar** o 🗑
**eliminar**; si está **CONTABILIZADO**: ↩ **reversar** (pide motivo y genera el asiento inverso).

#### 4.33 Consultas Mayor
**Para qué sirve:** ver el **mayor** de una cuenta. Elige la **Cuenta** y el rango **desde/hasta**;
muestra cada movimiento con su **saldo acumulado**.

#### 4.34 Balance de Comprobación
**Para qué sirve:** el resumen de **débitos y créditos por cuenta** en un rango, para verificar que
todo cuadre.

#### 4.35 Saldos por Período
**Para qué sirve:** ver saldos acumulados por período. El botón **Recalcular** **reconstruye los saldos
desde los asientos** (úsalo si algo se ve descuadrado).

#### 4.36 Personas
**Para qué sirve:** registrar **clientes, proveedores, empleados y vendedores** (con su RUC/cédula).
**Nueva** →
1. Elige el **Rol** (Cliente / Proveedor / Empleado / Vendedor).
2. **Tipo de identificación** (RUC / Cédula / Pasaporte) y **RUC/CI**.
3. **Razón social / Nombre**, nombre comercial, email, teléfono, dirección.
4. **Régimen tributario** (General, RIMPE Popular, RIMPE Emprendedor) y **Clasificación SRI**
   (Contribuyente **Especial**, **Agente de retención**).
- Buscar por RUC/nombre y filtrar por rol. El lápiz edita, el bote elimina.

#### 4.37 Cartera (CxC / CxP)
**Para qué sirve:** ver lo que te **deben** y lo que **debes**.
- Conmutador **Por Cobrar / Por Pagar**.
- Vista **Antigüedad** (aging): por persona, columnas **Por vencer, 1-30, 31-60, 61-90, +90** y total.
- Vista **Documentos**: cada factura con total, aplicado, **saldo** y estado.
- El icono de documento (o hacer clic en una fila) abre el **Estado de cuenta** de esa persona, con el
  detalle y el **saldo acumulado**.

#### 4.38 Ingresos Diferidos
**Para qué sirve:** manejar dinero cobrado por adelantado (ej. **paquetes de sesiones**). Arriba ves
**Diferido total**, **Reconocido** y **Por reconocer**.

**Reconocer un ingreso** (cuando se presta el servicio):
1. En la fila (estado ABIERTO o PARCIAL) pulsa **Reconocer**.
2. Indica **cuántas sesiones** reconocer **o** un **monto exacto** (si dejas vacío usa sesiones/saldo).
3. **Reconocer.** Se genera el **asiento** que pasa el dinero de "diferido" a "ingreso".

#### 4.39 Compras
**Para qué sirve:** registrar las **facturas de proveedores**. Si hay facturas **por autorizar**, lo
verás en una etiqueta junto al título. Busca por proveedor/RUC/serie/autorización y filtra por estado
(Por autorizar, Registrada, Pagada, Anulada).

**Registrar una factura manual** (**Nueva**):
1. Elige **Proveedor**, **Tipo de documento**, **Fecha**, **Establecimiento**, **Punto de emisión**,
   **Secuencial** y, opcional, **N° de autorización SRI**.
2. Agrega los **ítems** (botón **Línea**): descripción, cantidad, P.U., descuento, **IVA%**
   (0/12/15/No objeto/Exento) y la **Cuenta de gasto**. Con **➗ varias** puedes **distribuir un ítem
   en varias cuentas** (la suma debe cuadrar con el subtotal del ítem).
3. Agrega **Retenciones** si aplica (**+ Retención**): tipo IVA/Renta, código, base y %; el **monto**
   se calcula solo. Opcional: **N° comprobante de retención**.
4. Revisa los totales (subtotales por IVA, IVA, retención, **total** y **saldo**) y **Registrar**.

**Importar del SRI** (**Importar SRI**):
- **XML:** carga uno o varios **XML** de facturas electrónicas recibidas → **Importar**. Entran como
  **POR AUTORIZAR**.
- **TXT:** pega/carga el anexo en formato
  `RUC|RazonSocial|Tipo|Serie|Autorizacion|Fecha|Subtotal|IVA|Total`.

**Autorizar una factura importada:** en su fila pulsa **Verificar / Autorizar** → revisa datos,
**asigna la cuenta de gasto de cada ítem** y pulsa **Autorizar y contabilizar**.

**Otras acciones por fila:** **Emitir retención** (si la compra tiene retenciones y aún no se emitió)
y **Anular** (✕) una factura registrada.

#### 4.40 NC / ND (Notas de Crédito / Débito)
**Para qué sirve:** registrar **notas de crédito o débito** (devoluciones, ajustes). Botón
**Nueva nota** → completa los datos del documento y guárdalo; afecta la cartera/contabilidad según el
tipo.

#### 4.41 Retenciones
**Para qué sirve:** consultar los **comprobantes de retención** electrónicos. **Se emiten desde una
compra** (*Compras → Emitir retención*), no se crean aquí. En esta pantalla:
- El **ojo** abre el detalle del comprobante.
- Si alguno falló al enviarse al SRI, el botón **Reintentar** vuelve a procesarlo.

#### 4.42 Salud Contable
**Para qué sirve:** un **diagnóstico** automático. Muestra indicadores y una lista de **Hallazgos**
(asientos descuadrados, cuentas sin mapear, inconsistencias). Revísala y **corrige antes de declarar**.

---

### Grupo: Reportería

> En la mayoría de reportes eliges un rango **Desde/Hasta** (o **Año/Mes**) y pulsas **Generar/
> Consultar**; varios permiten **exportar** a Excel/XML con su botón de descarga.

#### 4.43 Rep. Ventas
**Para qué sirve:** analizar las ventas por período, producto y **categoría de servicio**. Incluye un
botón para administrar las **categorías de servicios** que agrupan los reportes.

#### 4.44 Rep. Financieros
**Para qué sirve:** los **estados financieros**. Elige **Desde/Hasta** y consulta:
- **Estado de Resultados:** Ingresos − Costo de ventas − Gastos = **Utilidad**.
- **Balance General:** Activos, Pasivos y **Patrimonio**.
- **Flujo:** saldo inicial, entradas, salidas, saldo final.
- Haz **clic en una cuenta** para ver su **detalle** (saldo inicial, débitos, créditos, saldo final).
- Botón para exportar el **archivo plano para Supercías**.

#### 4.45 Rep. Gerenciales
**Para qué sirve:** una **visión de negocio** en un rango (con opción de **agrupar**): ventas, **costo
de venta**, **utilidad bruta** y **margen**, compras e IVA, cuentas por pagar, valor de inventario (a
costo y a venta), descuentos, **top productos**, **cobros por método**, ventas anuladas, y un resumen
de balance/resultados.

#### 4.46 Rentabilidad x Médico
**Para qué sirve:** ver cuánto **genera cada médico** (ingresos, costos y **utilidad**) en el rango
**Desde/Hasta**.

#### 4.47 Presupuesto
**Para qué sirve:** planear y controlar el gasto/ingreso anual. Dos pestañas:
- **Editar:** elige el **Año**, agrega **cuentas** (ingreso/gasto/costo) con su **monto anual** (se
  reparte en 12 meses) y **Guardar presupuesto**.
- **Ejecución:** compara **Presupuesto vs. Real** por cuenta, con **variación** y **% de cumplimiento**.

#### 4.48 Flujo de Caja
**Para qué sirve:** ver **entradas y salidas de efectivo** en un rango **Desde/Hasta**, con total de
ingresos, total de egresos y **saldo final**.

#### 4.49 Rep. SRI
**Para qué sirve:** generar las **declaraciones y anexos** del SRI. Elige la **pestaña**, el **Año** y
el **Mes**, y pulsa **Generar** (o **Descargar XML**):
- **Formulario 104 (IVA)** y **Formulario 103 (Retenciones en la fuente)** — con descarga **XML (DIMM)**.
- **ATS** (Anexo Transaccional Simplificado) — descarga **XML**.
- **RDEP** (relación de dependencia / nómina) — por **Año**, con descarga **XML**.
- **Retenciones recibidas** y **Ventas/Compras** (este último exporta a **Excel**).

#### 4.50 Auditoría
**Para qué sirve:** el **registro de quién hizo qué** (creó, modificó, anuló) en el módulo contable,
para control interno.

---

## 5. Flujos de trabajo típicos (recetas)

### 5.1 Día normal de caja
1. **Cierre de Caja → Abrir caja** con el **fondo inicial**.
2. Durante el día se registran **ventas/cobros** (efectivo, tarjeta, transferencia).
3. Si acumulas mucho efectivo, **Bancos → Caja → Depositar** a la cuenta bancaria.
4. Al terminar el turno: **Cerrar caja**, cuenta el **efectivo físico** y revisa el **sobrante/faltante**.

### 5.2 Vender, cobrar y facturar
1. Registra la **venta** (o cobra la **cita** desde su flujo de cobro).
2. El sistema crea el **asiento** (ingreso + IVA + costo) y descuenta **inventario** solo.
3. Emite la **factura electrónica** desde **Facturación** (requiere Config. SRI).

### 5.3 Compra a proveedor con retención
1. **Compras → Nueva factura** (o **Importar XML del SRI** → **verificar y autorizar**).
2. Indica las **retenciones** (IVA / Renta) que correspondan.
3. **Emite la retención** electrónica; queda registrada en **Retenciones**.
4. Cuando pagues, usa **Pagos / Cobros** para aplicar el pago y bajar la **Cartera (CxP)**.

### 5.4 Cobro con tarjeta
1. El cobro con tarjeta se agrupa en un **Lote** (Tarjetas de Crédito → Lotes).
2. Cuando la adquirente te deposita, registra la **Liquidación** (depósito, comisión, retenciones).
3. **Acredita** la liquidación para contabilizar el ingreso al banco.

### 5.5 Cierre de mes (contable)
1. Revisa **Salud Contable** y corrige los hallazgos.
2. Corre la **depreciación** de **Activos Fijos** del mes.
3. **Reconoce** los **Ingresos Diferidos** que correspondan.
4. Revisa **Balance de Comprobación** y, si hace falta, **Recalcula** en *Saldos por Período*.
5. Genera la **nómina** del mes (RRHH → Nómina).
6. Saca **Rep. Financieros** y prepara **Rep. SRI** (ATS, 103, 104).
7. **Cierra el período fiscal** para protegerlo.

---

## 6. Buenas prácticas

- **Configura bien Config. Cuentas al inicio.** Es lo que hace que todo lo automático caiga en la
  cuenta correcta. Revisa que no haya conceptos **"No resuelta"**.
- **Abre y cierra la caja todos los días.** Es la forma más sencilla de detectar diferencias a tiempo.
- **Importa los XML del SRI** para tus compras en vez de teclearlas: menos errores y retenciones más
  rápidas.
- **No modifiques períodos ya cerrados.** Si necesitas corregir, usa un **asiento de ajuste** o
  **reversa** el asiento original.
- **Revisa "Salud Contable" antes de declarar.** Te ahorra sustos con el SRI.
- **Concilia los bancos** al menos una vez al mes con el **estado de cuenta**.
- **Usa Centros de Costo** desde el principio si quieres medir rentabilidad por área/sucursal.

---

## 7. Permisos por rol (resumen)

| Sección | Cajero | Contabilidad | Admin |
|---|:--:|:--:|:--:|
| Ventas / Cotizaciones / Facturación | ✔ | ✔ | ✔ |
| Caja (Apertura/Cierre) | ✔ | ✔ | ✔ |
| Descuentos | ✔ | ✔ | ✔ |
| Inventario / Bodegas / Kardex / Activos | — | ✔ | ✔ |
| Bancos / Tarjetas / Pagos-Cobros | — | ✔ | ✔ |
| Plan de Cuentas / Asientos / Cartera / Compras / Retenciones | — | ✔ | ✔ |
| Nómina / Empleados / Préstamos | — | ✔ | ✔ |
| Reportería (Financieros / SRI / Gerenciales) | — | ✔ | ✔ |
| Config. SRI / Config. Cuentas / Períodos | — | ✔ | ✔ |

> El rol **contabilidad** entra directo al **Dashboard Contable** al iniciar sesión.

---

## 8. Preguntas frecuentes

**¿Tengo que crear los asientos a mano?**
No. Ventas, cobros, cierres de caja, depreciación, nómina y liquidaciones **generan sus asientos
solos**. Los **Asientos manuales** son para ajustes puntuales.

**Una cuenta aparece como "No resuelta" en Config. Cuentas, ¿qué hago?**
Asígnale una cuenta del plan. Mientras esté "No resuelta", ese concepto no sabrá dónde registrar.

**¿Por qué no me deja registrar en una fecha?**
Probablemente el **período fiscal** está **cerrado** (o no existe). Ábrelo en **Períodos Fiscales**.

**¿Cuál es la diferencia entre "Caja" y "Cierre de Caja"?**
*Caja* es el efectivo (y desde ahí depositas al banco). *Cierre de Caja* es el **arqueo del turno**:
abrir con fondo y cerrar contando el efectivo.

**Importé una factura del SRI pero no aparece en la contabilidad.**
Entra como **POR AUTORIZAR**. Ve a **Compras**, **verifícala y autorízala** para que se contabilice.

**El balance no cuadra / veo cifras raras.**
Revisa **Salud Contable**, y en **Saldos por Período** usa **Recalcular** para reconstruir los saldos
desde los asientos.

**¿Dónde saco lo que necesito para el SRI?**
En **Reportería → Rep. SRI**: **ATS**, **Formulario 103** (retenciones), **Formulario 104** (IVA) y
**RDEP** (nómina), con sus archivos para subir.

**¿Necesito el certificado digital?**
Sí, para **facturación electrónica** y **retenciones**. Se carga en **Config. SRI** (`.p12`/`.pfx`).
