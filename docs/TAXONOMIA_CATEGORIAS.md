# Categorías: qué significa cada una

Hay **cuatro** cosas distintas que en el código se llaman «categoría». Confundirlas es la razón
de que un servicio pidiera cuenta de inventario y de que el reporte de ventas no supiera agrupar.
Ninguna se elimina y **no se crea una taxonomía nueva**: se aclara cuál es cuál.

| Concepto | Campo / modelo | Para qué sirve | A quién aplica |
|---|---|---|---|
| **Tipo de producto** | `Product.category` — enum `insumo` \| `servicio` \| `programa` | Decide **qué es** el ítem: si se inventaría, si se agenda, si es un paquete. Es lo que mira el sistema para saber si hay stock. | Todos |
| **Categoría comercial** | `Product.categoria` (texto, del desplegable de `utils/productCategories.js`) | Agrupar para **vender**: reportes de ventas, búsqueda, presets. | Productos **y** servicios |
| **Categoría de inventario / contable** | `InventoryCategory` (`Product.inventoryCategory`) | **Stock, bodegas, kardex, tomas físicas** y las **cuentas** de inventario/costo. Con `kind: 'ACTIVO_FIJO'` es además la única fuente de las cuentas y la depreciación de un activo. | Solo **inventariables** |
| **Categoría de servicios** | `ServiceCategory` (con su lista `products[]`) | Agrupación **real del negocio** para reportes ("Estética", "Sueroterapia"). | Servicios y productos vendibles |

> `Product.category` y `Product.categoria` se parecen en el nombre y **no tienen nada que ver**:
> el primero es el TIPO (`insumo`/`servicio`/`programa`), el segundo la categoría comercial.
> Es la trampa más fácil de este código. No se renombran (hay datos, importadores y reportes
> encima); se documentan.

## Qué exige cada tipo de ítem

**Producto inventariable** (`category: 'insumo'`, `unlimited: false`):
categoría comercial, **categoría de inventario** (de ahí salen la cuenta de inventario y la de
costo), y las cuentas contables que esa categoría define. Sin categoría de inventario, una compra
de ese producto no sabe a qué cuenta va y el kardex no puede clasificarlo.

**Servicio** (`category: 'servicio'`): categoría comercial, cuenta de ingreso y precio.
**No** se le pide bodega, ni stock, ni categoría de inventario, ni cuenta de inventario o de costo
de inventario. Un servicio **conserva** su categoría comercial: no se le quita por no tener stock.

**Programa** (paquete de servicios): como el servicio, salvo que declare consumo de insumos.

## Campo canónico y legacy

- Canónico para agrupar comercialmente: **`Product.categoria`**.
- Canónico para inventario y contabilidad: **`Product.inventoryCategory`** (`InventoryCategory`).
- **`ServiceCategory`** es una agrupación del negocio, **no** una búsqueda guardada: para eso está
  `SalesReportPreset` (ver `docs/`), que guarda la selección exacta con sus inclusiones y
  exclusiones. Mezclarlos convertiría cada consulta ad-hoc de la contadora en una categoría falsa.
- Los campos `Product.costAccountCode` / `inventoryAccountCode` (texto) son **legacy**: se leen,
  no se escriben. La cuenta viene de la categoría de inventario.

Nada se borra y **nada se migra solo**: los valores ambiguos los resuelve una persona.

```bash
# Solo lectura: qué productos están mal clasificados y por qué
node scripts/diagnoseProductCategories.js --clinic=<id>
```
