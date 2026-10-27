# Centros de costo de Contífico por sucursal

La empresa principal conserva el archivo de documentos y asientos de Contífico en
Central. Su centro de costo original permanece en cada documento y cada línea;
los valores vacíos permanecen vacíos. `Clinic.accountingDataClinic` indica dónde
leer ese archivo y no cambia la sucursal operativa de una venta nueva.

| Centro | Sucursal operativa | Alcance del historial |
| --- | --- | --- |
| 1 Central | Central | Central |
| 2 Extensión | Extensión | Extensión y Odontología |
| 3 Odontología | Extensión | Historial de Extensión y Odontología; las ventas nuevas de Odontología usan el centro 2 |
| 4 Optometría | Central | Central, mientras no exista otra sucursal identificada |
| 5 Laboratorio | Laboratorio | Laboratorio |
| 6 Servicios Médicos | Central | Central, mientras no exista otra sucursal identificada |
| DERMAZEN | Dermazen | Centro local nuevo; no se atribuye a Contífico |

Las bodegas BOD004 y BOD005 y sus capas de existencia pasan a Extensión y
Laboratorio. BOD001 permanece en Central. Los centros nuevos que aparezcan en
Contífico se crean automáticamente durante la sincronización financiera y se
conservan en la empresa principal; los que no tengan una regla de sucursal se
muestran en Central y en la vista de toda la empresa.

## Aplicación a la base configurada

Estos comandos se ejecutan **después de activar este código en el backend que
usa la base configurada**. Ejecutarlos con el backend anterior activo dejaría
fuera de sus consultas parte del historial. Ninguno realiza `git commit` ni `push`.

```powershell
cd server
node scripts/configureCostCenterBranches.js
node scripts/syncContificoCostCenters.js
node scripts/configureCostCenterBranches.js --commit
node scripts/syncContificoCostCenters.js --commit
```

Los dos comandos de aplicación guardan previamente una copia comprimida de
los registros que pueden cambiar en `server/storage/branch-centers/`. La
reasignación es idempotente y usa una transacción. La conciliación histórica
restaura los centros documentales de Contífico sin cambiar sus asientos.

Después, verificar en la aplicación: centros y bodegas de Laboratorio,
Extensión y Dermazen; ventas y compras históricas por centro; documentos sin
centro en la vista de toda la empresa; y una venta de prueba en Laboratorio.
