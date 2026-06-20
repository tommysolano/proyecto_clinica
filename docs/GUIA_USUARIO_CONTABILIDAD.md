# Guía de usuario — Contabilidad, Tesorería y SRI

> Esta guía explica, **paso a paso y campo por campo**, todo lo que el sistema ofrece para llevar la
> **contabilidad** de la clínica: ventas y facturación, caja y bancos, tarjetas, inventario, nómina,
> compras con retenciones, impuestos del **SRI** y reportes. Para cada página encontrarás **qué ves en
> pantalla**, **qué botón pulsar**, **qué modal se abre**, **qué campos llenar y con qué información**.
> Está pensada para el equipo de **contabilidad**, **caja** y **administración**.
>
> Idea clave: **gran parte de la contabilidad se genera sola**. Cuando registras una venta, cobras una
> cita, cierras la caja o corres la nómina, el sistema crea los **asientos contables** automáticamente.
> Tu trabajo es **configurar bien al inicio**, **llenar bien los formularios**, **revisar** y **declarar**.

---

## Cómo leer esta guía

Cada página se documenta con esta estructura:

- **Para qué sirve** — el objetivo de la página.
- **La pantalla** — qué botones, filtros y columnas verás.
- **Paso a paso** — la secuencia exacta de clics.
- **Campos del formulario/modal** — cada campo, si es **obligatorio (\*)**, y **qué escribir**.
- **Acciones por fila** — los iconos de cada renglón de la tabla.

Convenciones de iconos comunes en todo el módulo:

| Icono | Significado |
|---|---|
| ✏️ (lápiz) | Editar el registro |
| 🗑️ (bote) | Eliminar |
| 👁️ (ojo) | Ver detalle (abre un modal de solo lectura) |
| ✓ (check) | Aprobar / contabilizar / liquidar / acreditar |
| ↩ (flecha) | Reversar un asiento ya contabilizado |
| ✕ / ⃠ | Anular |
| **+** | Agregar (línea, ítem, registro) |

> En casi todos los formularios, los campos con **\*** son obligatorios. Si intentas guardar sin
> llenarlos, el sistema no te deja y resalta el campo.

---

## 1. ¿Qué es este módulo y para quién es?

Es el "motor financiero" de la clínica: un solo lugar para **registrar el dinero que entra y sale**,
**controlar inventario y activos**, **pagar al personal**, **cumplir con el SRI** y **ver cómo va el
negocio** con reportes.

Lo usan tres perfiles (cada uno ve solo lo que le corresponde):

| Perfil | Para qué entra |
|---|---|
| **Cajero** | Vender, cobrar, **abrir y cerrar su caja**, facturar, aplicar descuentos. |
| **Contabilidad** | Todo lo contable: plan de cuentas, asientos, bancos, compras, retenciones, nómina, reportes, SRI. |
| **Administrador** | Todo lo anterior + configuración general y permisos. |

Todo el módulo vive en el **menú lateral izquierdo**, en grupos desplegables:
**Ventas, Inventario, Bancos, Tarjetas de Crédito, Recursos Humanos, Contabilidad** y **Reportería**.

---

## 2. Conceptos clave (glosario rápido)

- **Asiento contable:** el registro de un movimiento con su **Debe** y su **Haber** (siempre cuadran).
  La mayoría se generan **solos**.
- **Plan de cuentas:** el catálogo de "cajones" donde se clasifica el dinero (caja, bancos, ventas,
  IVA, gastos…), bajo norma **Supercías**.
- **Config. Cuentas (mapeo):** la regla que dice *"para las ventas usa esta cuenta, para el IVA esta
  otra"*. Si no la tocas, usa la cuenta estándar.
- **Período fiscal:** el mes/año contable. Para registrar algo, el período debe estar **abierto**.
- **Centro de costo:** etiqueta para saber **a qué área/sucursal** pertenece un ingreso o gasto.
- **Caja vs. Cierre de caja:** *Caja* es el efectivo de ventas pendiente de depósito. *Cierre de caja*
  es el **arqueo del turno** del cajero (abrir con fondo y cerrar contando el efectivo).
- **Cartera (CxC / CxP):** lo que te **deben** los clientes y lo que **debes** a proveedores/empleados.
- **Persona:** un cliente, proveedor, empleado o vendedor (con su RUC/cédula).
- **Retención:** parte del pago que, por ley, **retienes** al proveedor (IVA o Renta) y entregas al SRI.
- **Ingreso diferido:** dinero cobrado por un servicio **aún no prestado** (ej. paquetes de sesiones).
- **Kardex:** historial de entradas/salidas de cada producto y su **costo** (valoración por capas FIFO).
- **Deducción al personal:** descuento que se aplica al empleado en el rol (consumo, multa, anticipo…).
- **Consumo interno:** salida de inventario para uso de la clínica (no es venta); va a gasto.
- **SRI:** la autoridad tributaria del Ecuador (facturación electrónica, ATS, 103/104, RDEP).
- **Conciliación bancaria:** comparar tus movimientos con el **estado de cuenta del banco**.

---

## 3. Mapa del sistema: "quiero hacer X, ¿a dónde voy?"

| Quiero… | Página del menú |
|---|---|
| Registrar una **venta** y cobrarla | **Ventas** |
| Filtrar ventas por **cliente** y **descargar facturas en lote** | **Ventas** (filtros + botón "Descargar facturas (ZIP)") |
| Emitir / anular una **factura electrónica** | **Facturación** |
| Configurar **RUC, certificado y SRI** | **Config. SRI** |
| **Abrir / cerrar mi caja** y registrar gastos de caja chica | **Caja (Apertura/Cierre)** |
| Mover dinero de **caja a banco** | **Bancos → Caja** |
| Registrar **cuentas y movimientos bancarios** | **Bancos → Cuentas Bancarias** |
| **Conciliar** con el estado de cuenta | **Bancos → Conciliaciones** / **Importar Estado Cta.** |
| Registrar una **compra** y su **retención** | **Contabilidad → Compras** |
| **Pagar muchas facturas de proveedor de una vez** | **Bancos → Pagos / Cobros → Pago masivo** |
| Ver lo que me **deben / debo** | **Contabilidad → Cartera (CxC/CxP)** |
| Registrar un **pago o cobro** | **Bancos → Pagos / Cobros** |
| Definir qué **cuenta** usa cada concepto | **Contabilidad → Config. Cuentas** |
| Crear un **asiento manual** | **Contabilidad → Asientos** |
| **Pagar al personal** | **Recursos Humanos → Nómina** |
| Registrar **deducciones al personal** o **consumo interno** | **Recursos Humanos → Deducciones / Consumo** |
| Registrar usuarios del sistema como **empleados** | **Recursos Humanos → Empleados** |
| Cobros con **tarjeta** y sus liquidaciones | **Tarjetas de Crédito** |
| Sacar **Estado de Resultados / Balance** | **Reportería → Rep. Financieros** |
| Declarar **IVA / retenciones / ATS / RDEP** | **Reportería → Rep. SRI** |
| Ver **cómo va el negocio** | **Contabilidad → Dashboard Contable** |
| Revisar que la contabilidad esté **sana** | **Contabilidad → Salud Contable** |

---

## 4. Antes de empezar: configuración inicial (una sola vez)

Para que todo funcione, el **administrador/contador** debe dejar listo esto al inicio, **en este orden**:

1. **Config. SRI** — RUC, dirección, **establecimiento** (ej. 001), **punto de emisión**, **secuencial**
   y **ambiente** (*pruebas*/*producción*). Sube el certificado **`.p12`/`.pfx`** con su contraseña.
2. **Plan de Cuentas** → botón **Cargar plan inicial** (siembra el catálogo Supercías).
3. **Config. Cuentas** → revisa que ningún concepto quede **"No resuelta"**.
4. **Períodos Fiscales** → abre el año y los meses en los que vas a operar.
5. **Centros de Costo**, **Bodegas**, **Cuentas Bancarias**, **Tarjetas/POS** y **Empleados**.

> Consejo: dedica un rato a **Config. Cuentas** al inicio. Es lo que hace que ventas, compras y cierres
> generen asientos correctos **sin que tengas que tocarlos**.

---

# 5. Guía página por página

## Grupo: Ventas y Facturación

### 5.1 Ventas
**Para qué sirve:** registrar lo que se vende. Cada venta **genera su asiento** (ingreso + IVA + costo) y
**descuenta el inventario** solo. *(El cajero crea ventas; el historial solo lo ven admin/contabilidad.)*

**La pantalla:**
- Arriba: botón **Excel** (exporta el listado filtrado) y **Nueva Venta**.
- Barra de filtros: **Desde**, **Hasta** (fechas), **Filtrar por cliente…** (texto libre: nombre del
  cliente o paciente), **Filtrar por producto/servicio…** (autocompletado), botón **Descargar facturas
  (ZIP)** y botón **Top productos** (muestra/oculta un gráfico).
- Tabla: N° Venta, Fecha, Cliente, Total, Estado (Completada/Anulada), Factura (estado SRI) y Acciones.

**Registrar una venta** — botón **Nueva Venta** (modal grande):
1. **Buscar paciente registrado (opcional):** escribe nombre o cédula y selecciónalo de la lista; el
   sistema autocompleta Cliente, Cédula, Email, Teléfono y Dirección, y carga sus **tratamientos**
   activos. Si es una venta a consumidor final, deja los datos por defecto.
2. **Cliente** *(texto)* — por defecto *"Consumidor Final"*. Cámbialo si tienes el nombre real.
3. **Cédula / RUC** — por defecto `9999999999999` (consumidor final); escribe la cédula/RUC real si vas
   a facturar a nombre del cliente.
4. **Email cliente** / **Teléfono cliente** — para enviar la factura (opcionales pero recomendados).
5. **Método de pago** — elige uno y aparecen campos adicionales:
   - **Efectivo:** sin campos extra (entra a Caja).
   - **Transferencia:** elige la **Cuenta bancaria de destino** (obligatorio si hay cuentas).
   - **Tarjeta:** elige **Tarjeta/Adquirente**, **POS/Terminal** (si la tarjeta tiene POS), **N° de
     lote** y **N° de voucher** (los del comprobante del datáfono, sirven para la liquidación).
   - **Crédito (CxC):** elige **Vence (crédito)** (fecha); queda como cuenta por cobrar en Cartera.
6. **Recomendado por (comisión)** — opcional; elige el empleado que recomendó (para comisiones).
7. **Dirección / Ciudad / Zona** — Ciudad: *Guayaquil* u *Otra*. En Guayaquil, la **Zona/Parroquia** debe
   elegirse del listado oficial (si escribes una no reconocida, te avisa en ámbar).
8. **Agregar productos:** en el buscador escribe y selecciona el producto/servicio, pon la **cantidad**
   y pulsa **Agregar**. Repite por cada ítem. En la tabla de ítems puedes editar **Cant.**, **Desc. $**
   (descuento en dólares por ítem) y, si el paciente tiene tratamientos, asociar la línea a un
   **Tratamiento**. El total se recalcula solo (Subtotal − Descuento = Total).
9. Pulsa **Cobrar $XX.XX** para guardar.

> Nota de stock: en productos no-servicio el sistema no deja agregar más cantidad que el stock
> disponible. Los **servicios** (marcados "ilimitado") no controlan stock.

**Acciones por fila:**
- 👁️ **Detalle** — abre el modal con cliente, método de pago, responsables (cajero, doctor, etc.) e ítems.
- 📄 **Facturar** *(si está completada y sin factura)* — emite la factura electrónica al SRI.
- 💵 **Registrar cobro** *(solo ventas a crédito con saldo)* — pide el monto a cobrar (efectivo).
- ✕ **Anular** *(solo admin)* — anula la venta y restaura stock/contabilidad. No deja anular si la
  factura ya está **AUTORIZADA** (primero anula la factura en *Facturación*).

**Descargar facturas en lote (ZIP):** ajusta **Desde/Hasta** y/o **cliente**, pulsa **Descargar facturas
(ZIP)**. Baja un `.zip` con los **PDF (RIDE)** de las facturas **autorizadas** del filtro.

### 5.2 Cotizaciones
**Para qué sirve:** armar **propuestas de precio**, compartirlas por **WhatsApp** y **convertirlas en
venta** si las aceptan. Botón **Nueva** → cliente, ítems (producto + cantidad + descuento) y notas.

### 5.3 Facturación
**Para qué sirve:** ver, emitir y **anular** los comprobantes electrónicos. Requiere **Config. SRI** lista.

**La pantalla:** botón **Exportar Excel**; filtros **Desde/Hasta** y **Estado**; tabla con N° Factura,
Cliente, Fecha, Total, Estado (AUTORIZADO, EN_PROCESO, DEVUELTA, ANULADA…) y Acciones.

**Acciones por fila:**
- 👁️ **Ver detalle** — clave de acceso, ambiente, mensajes del SRI, etc.
- ⬇️ **Ver/Descargar RIDE** *(solo AUTORIZADO)* — abre el PDF.
- ↻ **Reintentar** *(si quedó EN_PROCESO/DEVUELTA/ERROR)* — vuelve a consultar al SRI.
- ✕ **Anular factura** *(solo admin, solo AUTORIZADO)*. Abre un modal:
  - **Motivo de anulación \*** — texto, **mínimo 10 caracteres**.
  - **☑ Anular también la venta asociada** *(marcado por defecto)* — al confirmar, además de marcar la
    factura como ANULADA, **reversa la venta**: deshace los asientos contables, **devuelve el inventario**
    y **cierra la cuenta por cobrar**. Si lo desmarcas, solo se anula el documento electrónico.
  - Confirma con **Confirmar anulación**. Recuerda que la anulación **oficial** se hace en el portal del SRI.

### 5.4 Descuentos
**Para qué sirve:** definir **reglas de descuento** que aplican en ventas (por porcentaje o monto fijo,
con vigencias, días, horarios, sucursales, público y límites).

**Crear un descuento** — botón **Nuevo descuento** (modal):
- **Nombre \*** — ej. "Promo martes faciales".
- **Tipo** — *Porcentaje (%)* o *Valor ($)*.
- **Valor \*** — número (porcentaje o monto según el tipo).
- **Alcance** — *Todos los productos* o *Productos específicos*.
  - Si eliges **específicos**: aparece un **buscador** y una **lista de casillas**. Escribe en "Buscar
    producto o servicio…" para filtrar y **marca** los que aplican (el contador muestra cuántos llevas;
    "Quitar todos" los deselecciona). *(Antes era un selector múltiple incómodo; ahora es buscar+marcar.)*
- **Inicio** / **Fin** — fechas de vigencia (opcionales).
- **Parametrizaciones:**
  - **Días de la semana** — marca los días en que aplica (vacío = todos).
  - **Hora desde / Hora hasta** — franja horaria (vacío = todo el día).
  - **Sucursales** — en qué sedes aplica (vacío = todas).
  - **Público objetivo** — Todos / Pacientes nuevos / Recurrentes / Cumpleañeros.
  - **Compra mínima ($)** — monto mínimo para que aplique.
  - **Límite de usos** — 0 = ilimitado.
- **☑ Activo** — si está disponible para usarse.

---

## Grupo: Inventario

### 5.5 Productos *(menú: Inventario → Productos)*
**Para qué sirve:** el **catálogo** de productos y servicios. Pestañas **Productos** y **Movimientos**.
Arriba puedes **buscar**, filtrar por **categoría** y ver **stock bajo**.

**Crear/editar un producto** — botón **+** (Nuevo): **código**, **nombre**, **categoría** (medicamento,
insumo, servicio, programa, otro), **precio de compra** y **precio de venta**, **stock** y **stock
mínimo**, **unidad** e **IVA**. Marca **"ilimitado"** para servicios (no controlan stock).

**Registrar un movimiento de stock** (pestaña Movimientos): **producto**, **tipo** (entrada/salida),
**cantidad** y **motivo**.

**Carga masiva por Excel:** botón de **carga masiva** → **descarga la plantilla**, llénala y **súbela**.
El sistema informa cuántos productos se **crearon/actualizaron** y los **errores** por fila.
> Si el Excel da error, ábrelo y **vuelve a guardarlo como .xlsx**.

### 5.6 Bodegas *(menú: Inventario → Bodegas)*
**Para qué sirve:** las **ubicaciones físicas** del inventario.

**Nueva/editar bodega** (modal):
- **Código \*** — ej. `BOD-01`.
- **Nombre \*** — ej. "Bodega principal".
- **Dirección** — ubicación física (opcional).
- **☑ Principal** — márcala en la bodega por defecto.

### 5.7 Categorías de Inventario/Activos
**Para qué sirve:** agrupar productos/activos y asignarles las **cuentas contables** que usan.

**Nueva/editar categoría** (modal):
- **Código \*** — ej. `INV-01`.
- **Tipo** — *INVENTARIO* o *ACTIVO_FIJO* (cambia los campos siguientes).
- **Nombre \*** — ej. "Medicamentos".
- **Categoría padre** — "raíz" o una categoría existente del mismo tipo (para subcategorías/tipos).
- Si **ACTIVO_FIJO**: **% Depreciación anual**, **Vida útil (años)**, **% Valor residual**.
- **Cuentas contables vinculadas:**
  - Inventario → **Cuenta de inventario**, **Costo/gasto**, **Ingreso por venta**.
  - Activo fijo → **Cuenta de activo**, **Gasto depreciación**, **Depreciación acumulada**.

### 5.8 Inventario Consolidado
**Para qué sirve:** vista global de solo lectura: **SKUs totales**, **unidades en stock** y **valor total**
sumando todas las bodegas, con detalle por producto.

### 5.9 Tomas Físicas
**Para qué sirve:** el **conteo físico** y su ajuste automático.

**Paso a paso:**
1. **Nueva toma** (modal): **Bodega (opcional)** — una bodega o *Todas*; **Descripción** — ej. "Conteo
   mensual diciembre". Pulsa **Iniciar**. El sistema carga todos los productos con su **cantidad en
   sistema**.
2. La toma aparece a la izquierda; haz clic para abrirla (estado **BORRADOR**). En la tabla, escribe la
   **cantidad contada** de cada producto: se calcula la **Diferencia** (verde = sobrante, rojo = faltante)
   y su valor a costo.
3. **Guardar** para conservar el avance.
4. **Confirmar** → ajusta el stock a lo contado y genera el **asiento de ajuste**. (Pide confirmación.)

### 5.10 Activos Fijos
**Para qué sirve:** registrar equipos/bienes y su **depreciación**.

**Nuevo/editar activo** (modal grande):
- **Código \*** (ej. `AF-001`) y **Nombre \*** (ej. "Sillón odontológico").
- **Categoría** — al elegirla, **autocompleta** % depreciación, vida útil, valor residual y cuentas.
- **Tipo de activo** — subtipo dentro de la categoría (si existe).
- **Sede/clínica** y **Ubicación específica (área)** — ej. "Consultorio 2".
- **Factura de compra (opcional)** — al elegirla, copia **costo** y **fecha** de la compra.
- **Fecha de adquisición \*** y **Inicio de depreciación \***.
- **Costo de adquisición** — valor de compra.
- **% valor residual** / **Valor residual ($)** — lo que valdrá al final de su vida útil.
- **% depreciación anual** / **Vida útil (meses)** — uno recalcula al otro.
- **Serial** — número de serie.
- **Cuentas contables ligadas** — Cuenta de activo, Gasto depreciación, Dep. acumulada (si las dejas
  vacías usa las de la categoría).

**Acciones por fila:** 👁️ **Ver** (valor inicial, depreciado y actual + historial de depreciación) y
✏️ **Editar**.

**Correr depreciación mensual** — botón **Correr depreciación** (modal): **Año** y **Mes** → **Procesar**.
Genera un **asiento consolidado**; es **idempotente** (no duplica si lo corres dos veces el mismo mes).

### 5.11 Kardex
**Para qué sirve:** consultar el **historial** de un producto.
1. Elige el **Producto** (obligatorio) y, opcional, **Bodega**, **Tipo de movimiento** y **Desde/Hasta**.
2. **Consultar.** Muestra el **saldo actual** y cada movimiento con fecha, tipo, bodega, cantidad (con
   signo), **costo unitario** y **saldo acumulado**.

---

## Grupo: Bancos y Tesorería

### 5.12 Cuentas Bancarias
**Para qué sirve:** registrar tus cuentas, ver su **saldo** y sus **movimientos**.

**La pantalla:** botones **Caja → Banco** (atajo a depositar efectivo) y **Nueva cuenta**. Debajo, una
**tarjeta por cuenta** con su saldo; al **hacer clic** en una se listan abajo sus movimientos.

**Crear una cuenta bancaria** (modal):
- **Nombre \*** — ej. "Cuenta Pichincha principal".
- **Banco**, **Nro de cuenta**, **Tipo** (Corriente/Ahorros/Virtual), **Ciudad**.
- **Saldo inicial** — el saldo real al empezar a usar el sistema.
- **Próximo cheque #** — siguiente número de cheque a usar.
- **Cuenta contable \*** — del plan, empieza por `1.1.01…`.

**Registrar un movimiento manual:** selecciona la cuenta → **+ Movimiento**:
- **Tipo** — Depósito, Retiro, Cheque emitido, Comisión, Interés, Ajuste, Transferencia (entrada/salida).
- **Fecha**, **Monto**, **N° Comprobante** (obligatorio para depósito/transferencia/cheque),
  **URL comprobante** (opcional), **Referencia**, **Descripción**. Si es **transferencia**, elige el
  **banco contraparte**.
- En la tabla, la columna **Concil.** muestra ✓ cuando el movimiento ya fue conciliado.

> La mayoría de movimientos se generan **solos** desde cobros, pagos, depósitos de caja y liquidaciones
> de tarjeta. Usa el manual solo para comisiones, intereses o ajustes.

### 5.13 Caja (efectivo pendiente de depósito)
**Para qué sirve:** ver el **efectivo de ventas** aún no llevado al banco y **depositarlo**.

**La pantalla:** tres tarjetas (**Efectivo en caja**, **Seleccionado**, **Cuentas bancarias disponibles**)
y una tabla con cada venta en efectivo pendiente.

**Depositar al banco:**
1. **Marca** las ventas a depositar (casilla por fila, o la del encabezado para todas).
2. Pulsa **Depositar a banco**.
3. En el modal: **Cuenta bancaria destino \***, **Número de papeleta/comprobante \*** (el que da el
   banco), **Fecha** y **Descripción**.
4. **Confirmar depósito.** Crea el movimiento bancario y su asiento (efectivo → banco).

### 5.14 Cierre de Caja *(menú: "Caja (Apertura/Cierre)")*
**Para qué sirve:** el **arqueo del turno**. **Cada cajero abre y cierra su propia caja**: solo ves la
tuya, y cada cajero administra sus movimientos por separado.

**Abrir la caja:**
1. Pulsa **Abrir caja**.
2. **Fondo de caja inicial ($)** — el efectivo con el que arrancas; **Observaciones** (opcional).
3. **Abrir caja.** Verás el panel **CAJA ABIERTA** con: fondo inicial, **efectivo de ventas**, **tarjeta**,
   **transferencia** y **efectivo esperado**, todo en vivo.

**Registrar un movimiento durante el turno (caja chica)** — botón **+ Movimiento** (modal):
- **Tipo de movimiento \*** — *Ingreso a caja*, *Gasto (caja chica)*, *Egreso*, *Retiro* o *Depósito a
  banco*.
- **Monto ($) \*** y **Descripción** (concepto).
- **Cuenta de gasto / Cuenta de ingreso** *(para todos menos Depósito)* — elige la cuenta contable del
  gasto/ingreso; si la dejas en "por defecto", usa *Otros gastos*/*Otros ingresos*.
- **Banco destino \*** *(solo Depósito a banco)*.
- Cada movimiento se puede **anular** desde su fila (revierte su asiento).

**Cerrar la caja:**
1. Pulsa **Cerrar caja**.
2. El sistema muestra fondo, efectivo de ventas, tarjeta y transferencia. Escribe el **Efectivo físico
   contado ($)**.
3. Verás en vivo **esperado**, **contado** y **diferencia** (faltante en rojo, sobrante en ámbar,
   cuadrado en verde). El esperado incluye ventas de contado, **cobros de crédito en efectivo** y los
   movimientos de caja chica del turno.
4. **Cerrar caja.** Se genera **automáticamente el asiento** de la diferencia (faltante = gasto, sobrante
   = ingreso).

**Historial:** abajo, todos los cierres con fondo, efectivo, esperado, contado, diferencia, cajero y
estado. 👁️ abre el detalle.

### 5.15 Conciliaciones
**Para qué sirve:** **cuadrar** tus movimientos con el **estado de cuenta** del banco.

**Paso a paso:**
1. **Nueva** (modal): **Cuenta bancaria \***, **Período desde \*** / **hasta \***, **Saldo del extracto
   bancario**. Pulsa **Iniciar**. El sistema carga los movimientos del período como ítems.
2. Selecciona la conciliación a la izquierda; en el panel derecho **marca ✓** cada movimiento que también
   aparece en el extracto del banco. Puedes ajustar el **Saldo extracto**.
3. **Guardar** para conservar el avance.
4. Cuando todo cuadre, **Cerrar** (queda CERRADA y ya no se edita).

### 5.16 Importar Estado de Cuenta
**Para qué sirve:** subir el **CSV** del banco para conciliar más rápido.
1. Elige la **Cuenta bancaria** y carga el **Archivo CSV** (o pega el texto). Formato por línea:
   `fecha,descripción,referencia,monto` — **monto negativo = débito/retiro**.
2. Pulsa **Conciliar.** El sistema marca las líneas que **coinciden** con tus movimientos y las que **no**.
3. Para las **sin coincidencia**, marca **Crear movimiento** y, opcionalmente, escribe el **Código de
   contrapartida** (cuenta contable) del movimiento a crear.
4. **Aplicar conciliación.**

### 5.17 Cheques
**Para qué sirve:** administrar chequeras por cuenta y el estado de cada cheque (Disponible / Girado /
Cobrado / Anulado).

**Generar una chequera:**
1. Arriba elige la **Cuenta bancaria** (y un **Estado** para filtrar).
2. **Generar chequera** (modal): **Desde Nº de cheque** y **Hasta Nº de cheque** → **Generar**. Se crean
   todos los cheques del rango como **Disponibles**.

**Anular** un cheque disponible: botón ⃠ en su fila (pide el **motivo**).

### 5.18 Pagos / Cobros
**Para qué sirve:** registrar un **pago** a proveedor o un **cobro** de cliente y **aplicarlo** a los
documentos pendientes (baja la **Cartera**). Incluye **Pago masivo** a proveedores.

**La pantalla:** conmutador **Cobros / Pagos**, botón **Pago masivo** (solo en modo Pagos) y **Nuevo**.

**Registrar un pago/cobro individual** — **Nuevo** (modal):
- **Fecha \***.
- **Proveedor** (pago) o **Paciente** (cobro) **\*** — al elegirlo se cargan sus **documentos pendientes**.
- **Método de pago** — Efectivo, Transferencia, Cheque, Tarjeta, Depósito.
- **Banco \*** *(si no es efectivo)*.
- **N° Comprobante \*** y **URL comprobante** *(en pagos a proveedor no-efectivo)* — el sistema **valida
  que el banco tenga saldo**.
- **Documentos a aplicar** — marca cada factura/venta y escribe el **monto a aplicar** a cada una.
- **Anticipo** — si es un pago/cobro sin documento, pon el valor aquí.
- Revisa el **Total** y pulsa **Registrar**. (Se puede **anular** desde su fila con ✕.)

**Pago masivo a proveedores** — botón **Pago masivo** (modal grande):
1. **Fecha \***, **Método**, **Banco \*** (si no es efectivo) y **N° Comprobante / referencia**.
2. **Buscar por proveedor o serie…** para filtrar la lista de **todas las compras con saldo pendiente**.
3. **Marca** las facturas a pagar; por cada una puedes ajustar el monto en **A pagar** (por defecto el
   saldo completo). Abajo ves cuántas seleccionaste y el **Total a pagar**.
4. **Registrar pagos.** El sistema crea **un pago por proveedor** (agrupa sus facturas), descuenta de la
   cartera y registra el egreso del banco. Avisa cuántos pagos creó y por qué total.

---

## Grupo: Tarjetas de Crédito

### 5.19 Tarjetas / POS
**Para qué sirve:** registrar las **tarjetas** que aceptas y sus **POS** (datáfonos).

**Nueva/editar tarjeta** (modal):
- **Nombre \*** — ej. "Visa Datafast".
- **Marca** — VISA / MASTERCARD / AMEX / DINERS / DISCOVER / OTRA.
- **Adquiriente** — ej. "Datafast", "Medianet".
- **Tipo de cuenta** — Crédito / Débito / Corriente.
- **% Comisión** y **% Retención** — los que cobra/retiene la adquirente.
- **Cuenta contable** — del plan (por ej. "Tarjetas por liquidar").
- **POS / Terminales** — **Agregar POS** y por cada uno: **Código**, **Nombre**, **Terminal**, **% Com.**

### 5.20 Lotes (de tarjetas)
**Para qué sirve:** agrupar cobros con tarjeta en **lotes** para liquidarlos.

**Nuevo lote** (modal grande):
- **Fecha de cierre \***, **Tipo de tarjeta** (Crédito/Débito), **Adquirente \***.
- **% comisión**, **% retención**, **% IVA comisión**, **Banco de acreditación \***.
- **Vouchers** — **Voucher** por cada cobro: **Voucher #**, **Lote**, **Últ. 4** (últimos 4 dígitos),
  **Monto bruto**. Abajo ves el **Total bruto**.
- **Crear lote.** Un lote **ABIERTO** muestra ✓ **Liquidar**: registra en banco el **neto** (bruto −
  comisión − IVA − retención) con su asiento.

### 5.21 Liquidaciones
**Para qué sirve:** registrar la **liquidación de la adquirente**: el **depósito** que te acreditan, la
**comisión**, el **IVA** y las **retenciones**.

**Registrar una liquidación** (**Registrar liquidación de tarjeta**):
1. **Fecha de emisión**, **Tipo de documento**, **Proveedor (adquirente)**, **Banco (acreditación)**,
   **Número de documento** y **Comisión por liquidar**.
2. **Cargar facturas:** escribe el **N° de lote** y/o **rango de fechas**; el sistema trae las ventas con
   tarjeta. **Selecciónalas** y se cargan como transacciones (depósito, comisión, IVA, retención de IVA).
3. **Retenciones** que aplicó la adquirente (tipo Renta/IVA, **código SRI**, base, % y valor).
4. Revisa **totales** (depósito, comisión, IVA, retenciones y **neto**).
5. Guarda. Acciones: 👁️ **Ver**, ✏️ **Editar**, ✓ **Acreditar** (contabiliza el ingreso al banco), ✕ **Anular**.

---

## Grupo: Recursos Humanos (Nómina)

### 5.22 Empleados
**Para qué sirve:** la ficha del personal y su sueldo. También permite **registrar como empleados** a las
personas que solo tienen cuenta/acceso en el sistema.

**La pantalla:** botón **Nuevo**; si hay **usuarios del sistema sin ficha de empleado**, aparece arriba
una **tarjeta ámbar** que los lista. Debajo, la tabla de empleados (código, cédula, nombre, cargo,
ingreso, tipo de sueldo, bruto, neto).

**Registrar como empleado a un usuario del sistema:** en la tarjeta ámbar, pulsa **Registrar** junto a la
persona. Se abre el modal de alta **precargado** con su nombre, email, teléfono y cédula y un aviso de que
quedará **vinculado a ese usuario**; completa los datos laborales y guarda.

**Nuevo/editar empleado** (modal en secciones):
1. **Datos:** **Código \***, **Tipo de identificación**, **Identificación \***, **Nombres \***,
   **Apellidos \***, **Email**, **Teléfono**, **Cargo**, **Departamento**, **Tipo de contrato**
   (Indefinido/Fijo/Eventual/Juvenil), **Frecuencia de pago** (Mensual/Quincenal), **Fecha de ingreso \***,
   **Cargas familiares**.
2. **Sueldo:** **Tipo de sueldo** — *Bruto (estándar)* o *Neto pactado* (el sistema calcula el bruto con
   *gross-up* sobre IESS 9.45%). Según el tipo, llena **Sueldo bruto mensual** o **Neto a recibir**; verás
   el otro valor estimado en vivo. Al **editar** el sueldo, escribe la **Razón del cambio** (auditoría).
3. **Beneficios sociales:** casillas **Décimo tercero**, **Décimo cuarto**, **Fondos de reserva** y
   **Gasto deducible**, cada uno **Mensualizado** o **Acumulado**.
4. **Origen del sueldo (sede)** y datos **bancarios** (Banco, Nº cuenta, Tipo).

El icono de **reloj** muestra el **historial de cambios de sueldo**.

### 5.23 Nómina
**Para qué sirve:** generar la planilla mensual.

**Paso a paso:**
1. Arriba elige el **Año** para ver las planillas de ese año.
2. **Generar período** (modal): **Año \*** y **Mes (1-12) \*** → **Generar.** Se crea en **BORRADOR** con
   una línea por empleado.
3. Haz clic en la planilla; a la derecha ves el **detalle por empleado**: Sueldo, **D3** (décimo tercero),
   **D4** (décimo cuarto), **FR** (fondos de reserva), **IESS**, **IR** (impuesto a la renta), **Prest**
   (préstamos) y **Neto**. En **BORRADOR** puedes editar el **préstamo** a descontar por empleado.
   *(Las deducciones registradas en "Deducciones / Consumo" se incluyen automáticamente y reducen el neto.)*
4. **Cerrar** → genera el **asiento contable** (y descuenta cuotas de préstamos y deducciones).
5. **Marcar pagado** cuando se haya pagado al personal.

### 5.24 Deducciones / Consumo *(nueva)*
**Para qué sirve:** registrar **deducciones al personal** (que se descuentan del rol) y el **consumo
interno** de inventario por la clínica. Tiene dos pestañas.

**Pestaña "Deducciones al personal":**
- La tabla muestra fecha, empleado, tipo, descripción, monto y estado (**PENDIENTE** / **APLICADO** /
  **ANULADO**). Las pendientes se descuentan **automáticamente al cerrar el rol** del período.
- **Nueva deducción** (modal):
  - **Empleado \***.
  - **Tipo** — *Consumo de productos/servicios*, *Multa/sanción*, *Uniformes/EPP*, *Anticipo de sueldo*
    u *Otro*.
  - **Monto ($) \*** y **Fecha \***.
  - **Cuenta contraparte (opcional)** — si la dejas "Automática", el sistema usa la cuenta por defecto del
    tipo (p. ej. *Anticipo* → Caja; *Multa/Consumo/Otro* → Otros ingresos). El cargo se registra contra
    **Cuentas por cobrar empleados**.
  - **Descripción** — concepto del descuento.
  - Una deducción **PENDIENTE** se puede **anular** (🗑️) hasta que el rol la aplique.

**Pestaña "Consumo interno":** salida de inventario para uso de la clínica (no es venta).
- **Fecha \***, **Cuenta de gasto** (por defecto "Consumo interno"), **Notas**.
- Agrega productos: elige **Producto** + **Cantidad** y pulsa **Agregar** (repite). Solo productos con
  stock (no servicios).
- **Registrar consumo interno.** Da salida del inventario (FIFO) y carga el **costo** a la cuenta de gasto.

### 5.25 Préstamos
**Para qué sirve:** registrar **préstamos/anticipos** al personal que se **descuentan** en la nómina.

**Nuevo préstamo** (modal):
- **Empleado \***, **Tipo de préstamo** (Empresa/Quirografario/Hipotecario), **Fecha de inicio \***,
  **Capital \***, **N° de cuotas \***, **Descripción**. El sistema arma el cronograma y descuenta una
  cuota por mes al cerrar el rol.

### 5.26 Plantillas Décimos
**Para qué sirve:** calcular **décimo tercero (13ro)** y **décimo cuarto (14to)**.
1. Elige **Tipo de décimo** y **Año** → **Generar.** Verás el período de cálculo, el total y, por empleado,
   sueldo base, meses trabajados y valor del décimo.
2. **Excel/CSV** exporta el listado.

### 5.27 Configuración (Nómina)
**Para qué sirve:** los **parámetros de cálculo**.
- **Parámetros:** Frecuencia de pago, **SBU**, **% IESS personal**, **% IESS patronal**, **% IECE**,
  **% SECAP**, **% Fondos de reserva**.
- **Cuentas contables (códigos del plan):** Gasto sueldos, Gasto beneficios, Gasto aporte patronal, IESS
  por pagar, Sueldos por pagar, IR por pagar, Préstamos empleados por cobrar, Provisiones por pagar.
- **Guardar configuración.** Ajústalo una vez con tu contador.

---

## Grupo: Contabilidad

### 5.28 Dashboard Contable
**Para qué sirve:** ver de un vistazo cómo va el negocio. Arriba eliges el **Período**. Tarjetas: ventas
del mes (vs. anterior), gastos, utilidad y margen, proyección, ventas del año, saldo en bancos, efectivo
de hoy y cuentas por pagar. Si hay **stock bajo**, una alerta abre el listado.

### 5.29 Plan de Cuentas
**Para qué sirve:** el **catálogo contable jerárquico** (Supercías).

**La pantalla:** botones **Cargar plan inicial** (siembra el plan por defecto, no sobrescribe) y **Nueva
cuenta**; buscador por **código/nombre** y filtro por **tipo**.

**Nueva/editar cuenta** (modal):
- **Código \*** — ej. `1.1.01.01`.
- **Nivel** — 1 a 6 (jerarquía; determina la sangría).
- **Nombre \***.
- **Tipo** — Activo / Pasivo / Patrimonio / Ingreso / Gasto / Costo / Orden.
- **Naturaleza** — Débito o Crédito.
- **☑ Permite movimiento** — solo las que lo permiten reciben asientos (las de agrupación, no).
- **☑ Activa.**
> Las cuentas del sistema no se pueden borrar (no muestran 🗑️).

### 5.30 Config. Cuentas (mapeo)
**Para qué sirve:** decirle al sistema **qué cuenta usar para cada concepto**. Tabla por grupos con
**Concepto**, **Cuenta a usar** y **Efectiva actual**.
- En **Cuenta a usar** elige una cuenta o deja **"(Predeterminada: código)"** para usar la estándar.
- Si **Efectiva actual** dice **"No resuelta"** (rojo), asígnale una cuenta. Pulsa **Guardar** al terminar.

### 5.31 Centros de Costo
**Nuevo/editar** (modal): **Código \*** (ej. `CC-01`), **Nombre \*** (ej. "Sucursal Norte"),
**Descripción** (opcional).

### 5.32 Períodos Fiscales
**Para qué sirve:** controlar en qué meses se puede registrar. Elige el **Año**. Cada mes es una tarjeta:
- **Abrir** (si no existe) → crea el período **ABIERTO**.
- **Cerrar** (si está ABIERTO) → pasa a **CERRADO** (protegido; reabrible).
- **Reabrir** / **Bloquear** (si está CERRADO) — *Bloquear* es **definitivo**.
- **Apertura de año** — genera el asiento de apertura con los saldos al cierre del año anterior.
- **Cierre anual** — genera el asiento de utilidad/pérdida del año.

> **Solo se puede contabilizar en un período abierto.**

### 5.33 Asientos (libro diario)
**Para qué sirve:** ver y crear asientos. Tabla: número, fecha, **origen**, descripción, débito, crédito,
**estado** (BORRADOR / CONTABILIZADO / ANULADO). Filtros: **Desde/Hasta**, **Estado**, texto → **Filtrar**.

**Crear un asiento manual** — **Nuevo asiento** (modal):
- **Fecha \*** y **Descripción \***.
- **Líneas** (botón **Agregar línea**): por cada una, **Cuenta** (solo las que permiten movimiento),
  **Descripción**, **Débito** o **Crédito**.
- Abajo ves **Totales** y la **Diferencia**: debe **cuadrar** (débito = crédito) o no deja guardar.
- **Guardar borrador** (queda BORRADOR) o **Contabilizar** (lo registra).

**Acciones por fila:** 👁️ ver; si **BORRADOR**: ✓ aprobar/contabilizar o 🗑️ eliminar; si **CONTABILIZADO**:
↩ reversar (pide motivo y genera el asiento inverso).

### 5.34 Consultas Mayor
**Para qué sirve:** el **mayor** de una cuenta. Elige la **Cuenta** y **Desde/Hasta**; muestra cada
movimiento con su **saldo acumulado**.

### 5.35 Balance de Comprobación
**Para qué sirve:** **débitos y créditos por cuenta** en un rango, para verificar que todo cuadre.

### 5.36 Saldos por Período
**Para qué sirve:** saldos acumulados por período. **Recalcular** **reconstruye los saldos desde los
asientos** (úsalo si algo se ve descuadrado).

### 5.37 Personas
**Para qué sirve:** registrar clientes, proveedores, empleados y vendedores.

**Nueva/editar persona** (modal):
- **Roles** — elige uno: Cliente / Proveedor / Empleado / Vendedor.
- **Tipo de identificación** — RUC / Cédula / Pasaporte.
- **RUC / CI \*** — ej. `0991234567001`.
- **Razón social / Nombre \*** y **Nombre comercial** (opcional).
- **Email**, **Teléfono**, **Dirección**.
- **Régimen tributario** — General / RIMPE Popular / RIMPE Emprendedor.
- **Clasificación SRI** — casillas **Especial** y **Ag. retención**.

### 5.38 Cartera (CxC / CxP)
**Para qué sirve:** ver lo que te **deben** y lo que **debes**. Conmutadores **Por Cobrar / Por Pagar** y
**Antigüedad / Documentos**.
- **Antigüedad (aging):** por persona, columnas **Por vencer, 1-30, 31-60, 61-90, +90** y total.
- **Documentos:** cada factura con total, aplicado, **saldo** y estado.
- El icono 📄 (o clic en la fila) abre el **Estado de cuenta** de esa persona con el **saldo acumulado**.

### 5.39 Ingresos Diferidos
**Para qué sirve:** manejar dinero cobrado por adelantado (ej. **paquetes de sesiones**). Arriba ves
**Diferido total**, **Reconocido** y **Por reconocer**; filtro por estado.

**Reconocer un ingreso** (cuando se presta el servicio) — botón **Reconocer** en la fila (ABIERTO/PARCIAL):
- **Sesiones a reconocer** — número (si el paquete se mide por sesiones), **o**
- **Monto exacto ($)** — déjalo vacío para usar las sesiones/saldo.
- **Reconocer.** Genera el asiento que pasa el dinero de "diferido" a "ingreso".

### 5.40 Compras
**Para qué sirve:** registrar **facturas de proveedores**. Si hay facturas **por autorizar**, lo ves en una
etiqueta junto al título. Busca por proveedor/RUC/serie/autorización y filtra por estado.

**Registrar una factura manual** — **Nueva** (modal grande):
1. **Proveedor \***, **Tipo de documento**, **Fecha de emisión \***, **Establecimiento**, **Punto de
   emisión**, **Secuencial \***, **N° de autorización SRI** (opcional).
2. **Ítems** (botón **Línea**): **Descripción \***, **Cant.**, **P.U.**, **Desc.**, **IVA%**
   (0/12/15/No obj/Exento) y **Cuenta de gasto \***. Con **➗ varias** puedes **distribuir un ítem en
   varias cuentas** (la suma debe cuadrar con el subtotal del ítem).
3. **Retenciones** (botón **+ Retención**): **Tipo** (IVA/Renta), **Código** (código SRI), **Base** y
   **%**; el **Monto** se calcula solo. Opcional: **N° comprobante de retención**.
4. Revisa totales (subtotales por IVA, IVA, retención, **total** y **saldo**) y **Registrar**.

**Importar del SRI** — **Importar SRI** (modal):
- **XML:** carga uno o varios **XML** de facturas recibidas → **Importar**. Entran como **POR AUTORIZAR**.
- **TXT:** carga/pega el anexo `RUC|RazonSocial|Tipo|Serie|Autorizacion|Fecha|Subtotal|IVA|Total`.

**Autorizar una importada:** en su fila, **Verificar / Autorizar** → revisa datos, **asigna la cuenta de
gasto de cada ítem** y pulsa **Autorizar y contabilizar**.

**Otras acciones por fila:** **Emitir retención** (si tiene retenciones y no se emitió) y ✕ **Anular**.

> Para **pagar** estas compras usa **Pagos / Cobros** (individual) o **Pago masivo** (varias a la vez).

### 5.41 NC / ND (Notas de Crédito / Débito)
**Para qué sirve:** registrar **notas de crédito o débito** (devoluciones, ajustes). **Nueva nota** →
completa los datos del documento; afecta cartera/contabilidad según el tipo.

### 5.42 Retenciones
**Para qué sirve:** consultar los **comprobantes de retención** electrónicos. **Se emiten desde una
compra** (*Compras → Emitir retención*), no se crean aquí. 👁️ ve el detalle; **Reintentar** reenvía al SRI
si falló.

### 5.43 Salud Contable
**Para qué sirve:** un **diagnóstico** automático. Muestra indicadores y una lista de **Hallazgos**
(asientos descuadrados, cuentas sin mapear, inconsistencias). **Corrige antes de declarar.**

---

## Grupo: Reportería

> En la mayoría de reportes eliges un rango **Desde/Hasta** (o **Año/Mes**) y pulsas **Generar/Consultar**;
> varios permiten **exportar** a Excel/XML con su botón de descarga.

### 5.44 Rep. Ventas
**Para qué sirve:** analizar ventas por período, **producto/servicio** y **categoría**.
- Filtros: **Desde/Hasta**, chips de **categorías guardadas**, y un desplegable **"Filtrar por
  producto/servicio"** con un **buscador** y casillas (escribe para filtrar y marca los ítems; "Limpiar"
  los deselecciona).
- Botón **Categorías** para crear/editar **categorías de servicios** (nombre, descripción y los
  productos/servicios incluidos, también con buscador).
- **Excel detallado** exporta el reporte. Verás KPIs (total, subtotal, IVA, descuentos, documentos,
  anulados), ventas en el tiempo, cobros por método y top de servicios.

### 5.45 Rep. Financieros
**Para qué sirve:** los **estados financieros**. Elige **Desde/Hasta** y consulta **Estado de Resultados**,
**Balance General** y **Flujo**. Clic en una cuenta para ver su detalle. Botón para exportar el **archivo
plano para Supercías**.

### 5.46 Rep. Gerenciales
**Para qué sirve:** una **visión de negocio** (con opción de **agrupar**): ventas, costo de venta,
utilidad bruta y margen, compras e IVA, cuentas por pagar, valor de inventario (a costo y a venta),
descuentos, top productos, cobros por método, ventas anuladas y un resumen de balance/resultados.

### 5.47 Rentabilidad x Médico
**Para qué sirve:** cuánto **genera cada médico** (ingresos, costos y **utilidad**) en el rango.

### 5.48 Presupuesto
**Para qué sirve:** planear y controlar ingresos/gastos anuales. Elige el **Año** y usa las pestañas:
- **Editar:** **Cuenta** (botón **+ Cuenta**: ingreso/gasto/costo) con su **Monto anual** (se reparte en
  12 meses). **Guardar presupuesto.**
- **Ejecución:** compara **Presupuesto vs. Real** por cuenta, con **variación** y **% de cumplimiento**.

### 5.49 Flujo de Caja
**Para qué sirve:** **entradas y salidas de efectivo** en un rango, con total de ingresos, egresos y
**saldo final**.

### 5.50 Rep. SRI
**Para qué sirve:** generar **declaraciones y anexos** del SRI. Elige la **pestaña**, **Año** y **Mes** y
pulsa **Generar** (o **Descargar XML**):
- **Formulario 104 (IVA)** y **Formulario 103 (Retenciones)** — descarga **XML (DIMM)**.
- **ATS** — descarga **XML**.
- **RDEP** (nómina) — por **Año**, descarga **XML**.
- **Retenciones recibidas** y **Ventas/Compras** (este exporta a **Excel**).

### 5.51 Auditoría
**Para qué sirve:** el **registro de quién hizo qué** (creó, modificó, anuló) en el módulo, para control
interno.

---

## 6. Flujos de trabajo típicos (recetas)

### 6.1 Día normal de caja (cajero)
1. **Cierre de Caja → Abrir caja** con el **fondo inicial**.
2. Registra **ventas/cobros** durante el día.
3. Gastos menores del turno → **+ Movimiento → Gasto (caja chica)** eligiendo la cuenta de gasto.
4. Si acumulas efectivo → **Bancos → Caja → Depositar a banco**.
5. Al terminar → **Cerrar caja**, cuenta el efectivo físico y revisa el sobrante/faltante.

### 6.2 Vender, cobrar y facturar
1. Registra la **venta** (el asiento e inventario se generan solos).
2. Emite la **factura electrónica** desde la venta (📄) o en **Facturación**.
3. ¿Necesitas todas las facturas del mes? **Ventas → Descargar facturas (ZIP)** con el filtro de fechas.

### 6.3 Compra a proveedor con retención y pago masivo
1. **Compras → Nueva** (o **Importar XML → Verificar/Autorizar**).
2. Indica las **retenciones** (IVA/Renta) y **Emite la retención**.
3. Para pagar varias compras juntas: **Pagos / Cobros → Pago masivo**, marca facturas, elige banco y
   registra.

### 6.4 Cobro con tarjeta
1. Agrupa los cobros en un **Lote** (Tarjetas → Lotes) o regístralos en **Liquidaciones** cargando por
   N° de lote/fechas.
2. Cuando la adquirente deposita, **Liquida/Acredita** para contabilizar el ingreso al banco.

### 6.5 Personal: deducciones, consumo y rol
1. Si un empleado se lleva productos/servicios o tiene una multa → **Deducciones / Consumo → Nueva
   deducción**.
2. Insumos usados por la clínica → **Deducciones / Consumo → Consumo interno**.
3. Al cierre de mes, **Nómina → Generar período** (incluye las deducciones pendientes), **Cerrar** y
   **Marcar pagado**.

### 6.6 Cierre de mes (contable)
1. Revisa **Salud Contable** y corrige hallazgos.
2. Corre la **depreciación** de Activos Fijos.
3. **Reconoce** los **Ingresos Diferidos** que correspondan.
4. Revisa **Balance de Comprobación**; si hace falta, **Recalcula** en *Saldos por Período*.
5. Genera y cierra la **Nómina**.
6. Saca **Rep. Financieros** y prepara **Rep. SRI** (ATS, 103, 104).
7. **Cierra el período fiscal**.

---

## 7. Buenas prácticas

- **Configura bien Config. Cuentas al inicio.** Revisa que no haya conceptos **"No resuelta"**.
- **Abre y cierra tu caja todos los días.** Es la forma más sencilla de detectar diferencias a tiempo.
- **Importa los XML del SRI** para tus compras: menos errores y retenciones más rápidas.
- **No modifiques períodos cerrados.** Usa un **asiento de ajuste** o **reversa** el asiento original.
- **Revisa "Salud Contable" antes de declarar.**
- **Concilia los bancos** al menos una vez al mes.
- **Usa Centros de Costo** desde el principio si quieres medir rentabilidad por área/sucursal.
- **Registra deducciones y consumo interno cuando ocurren**, no a fin de mes, para que el rol salga exacto.

---

## 8. Permisos por rol (resumen)

| Sección | Cajero | Contabilidad | Admin |
|---|:--:|:--:|:--:|
| Ventas / Cotizaciones / Facturación | ✔ | ✔ | ✔ |
| Caja (Apertura/Cierre) | ✔ | ✔ | ✔ |
| Descuentos | ✔ | ✔ | ✔ |
| Anular venta / Anular factura | — | — (factura: solo admin) | ✔ |
| Inventario / Bodegas / Kardex / Activos | — | ✔ | ✔ |
| Bancos / Tarjetas / Pagos-Cobros / Pago masivo | — | ✔ | ✔ |
| Plan de Cuentas / Asientos / Cartera / Compras / Retenciones | — | ✔ | ✔ |
| Nómina / Empleados / Préstamos / Deducciones-Consumo | — | ✔ | ✔ |
| Reportería (Financieros / SRI / Gerenciales) | — | ✔ | ✔ |
| Config. SRI / Config. Cuentas / Períodos | — | ✔ | ✔ |

> El rol **contabilidad** entra directo al **Dashboard Contable** al iniciar sesión.

---

## 9. Preguntas frecuentes

**¿Tengo que crear los asientos a mano?**
No. Ventas, cobros, cierres de caja, depreciación, nómina, deducciones, consumo interno y liquidaciones
**generan sus asientos solos**. Los **asientos manuales** son para ajustes puntuales.

**Una cuenta aparece como "No resuelta" en Config. Cuentas, ¿qué hago?**
Asígnale una cuenta del plan. Mientras esté "No resuelta", ese concepto no sabrá dónde registrar.

**¿Por qué no me deja registrar en una fecha?**
Probablemente el **período fiscal** está **cerrado** (o no existe). Ábrelo en **Períodos Fiscales**.

**¿Cuál es la diferencia entre "Caja" y "Cierre de Caja"?**
*Caja* es el efectivo pendiente de depósito (desde ahí depositas al banco). *Cierre de Caja* es el
**arqueo del turno** del cajero (abrir con fondo y cerrar contando).

**¿Cada cajero tiene su propia caja?**
Sí. Cada cajero **abre y cierra la suya**; solo ve y administra su propia sesión y sus movimientos.

**Quiero pagar 15 facturas de proveedor de una vez.**
Usa **Pagos / Cobros → Pago masivo**: marca las facturas (de uno o varios proveedores), elige banco y
registra; el sistema crea un pago por proveedor.

**Quiero descargar muchas facturas de venta.**
En **Ventas**, ajusta los filtros (fechas/cliente) y pulsa **Descargar facturas (ZIP)** para bajar los
PDF (RIDE) autorizados en un solo archivo.

**Un empleado se llevó productos / tiene una multa, ¿cómo lo descuento del sueldo?**
**Recursos Humanos → Deducciones / Consumo → Nueva deducción.** Queda **PENDIENTE** y se descuenta solo al
cerrar el rol del período.

**¿Cómo registro que la clínica usó insumos del inventario (sin venderlos)?**
**Deducciones / Consumo → pestaña Consumo interno.** Da salida del stock y lo lleva a gasto.

**Tengo a alguien con cuenta en el sistema pero no en nómina.**
En **Empleados**, la tarjeta ámbar "Usuarios sin ficha de empleado" lo lista; pulsa **Registrar** y
completa sus datos laborales.

**Importé una factura del SRI pero no aparece en la contabilidad.**
Entra como **POR AUTORIZAR**. Ve a **Compras**, **verifícala y autorízala**.

**El balance no cuadra / veo cifras raras.**
Revisa **Salud Contable**, y en **Saldos por Período** usa **Recalcular**.

**¿Dónde saco lo del SRI?**
En **Reportería → Rep. SRI**: **ATS**, **103**, **104** y **RDEP**, con sus archivos para subir.

**¿Necesito el certificado digital?**
Sí, para **facturación electrónica** y **retenciones**. Se carga en **Config. SRI** (`.p12`/`.pfx`).
