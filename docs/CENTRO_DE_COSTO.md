# Centro de costo y bodega

La bodega **propone**; el documento **manda**. Regla única en
[`server/services/costCenterPolicy.js`](../server/services/costCenterPolicy.js): la usan compras,
ventas, traslados y tomas físicas, y por eso no pueden contradecirse entre sí.

1. `Warehouse.costCenter` es el centro **predeterminado** de la bodega.
2. Si el documento no trae centro, se **propone** el de la bodega. Proponerlo no contabiliza nada.
3. Si el documento ya trae uno, **no se pisa**. Si además es distinto del de la bodega, hay que
   **confirmarlo**: sin confirmación el backend responde `409` con
   `code: 'COST_CENTER_MISMATCH'` y dice bodega, centro esperado y centro elegido.
4. Se registra el centro **realmente usado**, y la diferencia confirmada queda en `AuditLog`.

Validaciones (en el servidor, no en React): bodega y centro deben ser **de la misma clínica** y
estar **activos**. Una advertencia en pantalla se salta con un `curl`; esto no.

## Compras: el centro es **por línea**

El modelo ya era por línea (`PurchaseInvoice.items[].warehouse` y `.costCenter`) y **no se cambió
a cabecera**. `PurchaseInvoice.costCenter` es solo el **valor por defecto** de las líneas que no
eligieron uno.

Es lo correcto para una compra **mixta**: una misma factura puede recibir insumos en la bodega de
farmacia y un activo fijo en la de quirófano, y cada línea se lleva su centro. Un centro único de
cabecera obligaría a mentir en una de las dos.

El centro efectivo de cada línea se resuelve **una vez** (`applyCostCenterPolicy`) y se escribe en
`items[].costCenter`. Todo lo de aguas abajo lee **ese** valor, así que no pueden discrepar:

| Destino | Campo |
|---|---|
| Asiento | `JournalEntry.lines[].costCenter` |
| Movimiento de inventario | `InventoryMovement.costCenter` |
| Capa FIFO | `InventoryLayer.costCenter` |
| Activo fijo generado | `FixedAsset.costCenter` |

## Ventas: el centro es **de la venta**

`Sale.warehouse` + `Sale.costCenter` (cabecera). Una venta sale de **una** bodega, y su ingreso y
su costo van a **un** centro. Cada línea guarda la bodega (`Sale.items[].warehouse`) porque es la
que consume las capas FIFO.

El centro de la venta llega a: el asiento de **ingreso**, el de **costo de venta (COGS)**, la
**salida de inventario**, la **CxC**, el **reporte** y el **Excel**.

**Un servicio no tiene bodega**: entonces no hay centro de bodega que proponer y no se inventa
ninguno (el usuario puede elegir uno a mano, y se respeta).

**Un cobro posterior NO reclasifica** el centro de la venta: el asiento bancario conserva el
vínculo al documento, pero el ingreso ya está reconocido donde se reconoció.

## Lo que esto arregló

La venta **nunca copiaba la bodega a sus líneas**: `kardex.issueStock` leía un `it.warehouse` que
no existía. Consecuencia: toda venta consumía capas FIFO de **cualquier** bodega (el costo de
venta podía salir de la bodega equivocada) y su movimiento quedaba **sin bodega**, invisible en el
kardex de todas ellas. Y vender desde una bodega ahora exige que **esa** bodega tenga el stock,
no que el `stock` global del producto alcance.
