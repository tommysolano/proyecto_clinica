# Configuración de cuentas de nómina (estructura Contífico)

Estructura de la pantalla **Nómina → Configuración → Cuentas Contables**, replicando la
configuración de RRHH de Contífico que pidió la contadora. La referencia entre paréntesis es la
cuenta de ejemplo del sistema anterior (guía para elegir el default del plan de la clínica).

Convención de tipos junto a cada campo: **A** Activo · **P** Pasivo · **G** Costos y Gastos · **I** Ingresos.
El buscador de cuentas filtra por esos tipos.

## 1. Selector de departamento (arriba)

`Administrativo | Ventas | Costos | Otros`. Solo afecta a los campos **por departamento** (cuentas
de GASTO). Los 4 departamentos se siembran automáticamente por clínica: la contadora **solo crea
los cargos**, no los departamentos. Botón **"Copiar cuentas de gasto a otro departamento"** para no
configurar 4 veces lo mismo.

## 2. Ingresos del Empleado — POR DEPARTAMENTO (gasto)

Cuentas de gasto de los rubros que recibe el empleado:

| Rubro | Tipo | Ref. |
|---|---|---|
| Sueldo | G | 5.2.1.2.1 Sueldos Unificados Adm. |
| Alimentación | G | 5.2.1.2.4 Alimentación Adm. |
| Transporte | G | 5.2.1.2.26 Movilización y Transporte Adm. |
| Vivienda | G | 5.2.1.2.19 Arriendos Adm. |
| Comisiones | G | 5.2.1.2.20 Comisiones Adm. |
| Horas Extra | G | 5.2.1.2.2 Sobretiempos Adm. |
| Bonificaciones | G | 5.2.1.2.3 Gratificaciones Adm. |
| Otros | G/P/A | — |
| Dev. Beneficios Sociales | G/P/A | — |
| Dev. Días laborados/multas | G/P/A | — |

## 3. Provisiones y aportes — Gasto, POR DEPARTAMENTO

El pasivo es general; el gasto es por departamento:

| Rubro | Tipo | Ref. |
|---|---|---|
| Décimo Tercero — Gasto | G | 5.2.1.2.8 Décimo Tercer Sueldo Adm. |
| Décimo Cuarto — Gasto | G | 5.2.1.2.9 Décimo Cuarto Sueldo Adm. |
| Fondos de Reserva — Gasto | G | 5.2.1.2.7 Fondos de Reserva Adm. |
| Vacaciones — Gasto | G | 5.2.1.2.10 Vacaciones Adm. |
| Aporte Patronal — Gasto | G | 5.2.1.2.5 Aportes Patronales al IESS Adm. |
| SECAP/IECE — Gasto | G | 5.2.1.2.6 Secap-Iece Adm. |

## Cuentas generales — aplican a todos los departamentos (balance)

### 4. Egresos/Descuentos al Empleado

| Rubro | Tipo | Ref. |
|---|---|---|
| Anticipos a Empleado | A | 1.1.2.5.4.1 Anticipos de empleados (integra el anticipo quincenal) |
| Descuento | A/P | 1.1.2.5.4.2 Descuentos al empleado |
| Multa | A/P/I | 4.2.2 Multas |
| Ausencias | A/P | 1.1.2.5.4.2 |
| Comisariato | A/P | — (sin default; opcional) |
| Farmacia | A/P | — (sin default; opcional) |
| Seguros | A/P | 1.1.2.5.4.2 |
| Celular | A/P | 1.1.2.5.4.2 |
| Descuento días/horas no laborados | A/P | 1.1.2.5.4.2 |

### 5. Otros Egresos

| Rubro | Tipo | Ref. |
|---|---|---|
| Préstamo Quirografario | P | 2.1.7.1.2 Préstamos Quirografarios |
| Préstamo Hipotecario | P | 2.1.7.1.3 Préstamos Hipotecarios |
| Préstamo Personal | A | 1.1.2.5.4.3 Préstamos personales |
| Otros | A/P | 1.1.2.5.4.2 |
| Imp. Renta | P | 2.1.7.5.1 Impuesto a la Renta Cía. |

### 6. Obligaciones con el Empleado (pasivos)

| Rubro | Tipo | Ref. |
|---|---|---|
| Sueldos x pagar | P | 2.1.7.7.1 Sueldos por Pagar |
| Décimo Tercero — Pasivo | P | 2.1.7.6.1 Décimo Tercer Sueldo |
| Décimo Cuarto — Pasivo | P | 2.1.7.6.2 Décimo Cuarto Sueldo |
| Fondos de Reserva — Pasivo | P | 2.1.7.6.6 Fondos de Reservas |
| Vacaciones — Pasivo | P | 2.1.7.6.3 Vacaciones |

### 7. Obligaciones con el IESS (pasivos)

| Rubro | Tipo | Ref. |
|---|---|---|
| 9.45% Aporte Personal IESS | P | 2.1.7.1.1 Aportes Individuales |
| 3.41% Aporte Conyugal IESS | P | 2.1.7.1.4 Aporte Conyugal |
| Aporte Patronal — Pasivo | P | 2.1.7.6.4 11.15% Aportes Patronales IESS |
| SECAP/IECE — Pasivo | P | 2.1.7.6.5 1% Secap-Iece |

---

## Modelo de datos

`PayrollConfig.accounts`:

```
accounts: {
  global: { anticipos, descuento, multa, ausencias, comisariato, farmacia, seguros, celular,
            descuentoDiasNoLaborados, prestamoQuirografario, prestamoHipotecario, prestamoPersonal,
            otrosEgresos, impRenta, sueldosPorPagar, dec3Pasivo, dec4Pasivo, fondosReservaPasivo,
            vacacionesPasivo, iessPersonal, aporteConyugal, aportePatronalPasivo, secapPasivo },
  byDepartment: {
    ADMINISTRATIVO | VENTAS | COSTOS | OTROS: {
      sueldo, alimentacion, transporte, vivienda, comisiones, horasExtra, bonificaciones,
      otrosIngresos, devBeneficios, devDiasMultas,
      dec3Gasto, dec4Gasto, fondosReservaGasto, vacacionesGasto, aportePatronalGasto, secapGasto }
  }
}
```

Todas son referencias a `ChartOfAccount` (o `null`). El empleado carga su gasto a las cuentas del
**tipo de su departamento**; los descuentos/obligaciones a las globales. Cada línea de **gasto**
lleva el **centro de costo del empleado** (`Employee.costCenter`) → el estado de resultados por
centro de costo refleja la nómina.

### Resolución de cuentas y bloqueo

`config → default por código`. Los rubros **centrales** (sueldo, otros ingresos, décimos/fondos/
vacaciones gasto, aporte patronal/SECAP gasto, y todas las globales excepto comisariato/farmacia)
tienen un código por defecto para que una clínica sin configurar contabilice igual. Los rubros
**granulares** (alimentación, transporte, vivienda, comisiones, horas extra, bonificaciones,
devoluciones) **no** tienen default: si se usan sin cuenta, el cierre se **bloquea** con un mensaje
que nombra el rubro y el departamento (regla "nunca adivinar cuentas", igual que ventas/compras).

Un select vacío se guarda como `null` (no como `""`): así ningún formulario revienta al castear a
ObjectId.

### Migraciones

- `scripts/migratePayrollAccounts.js` — lleva la config legacy (códigos de `PayrollConfig.accounts`,
  `PayrollDepartment.accounts`, `PayrollConcept.deptAccounts`) a la nueva estructura sin perder lo
  mapeado. `--dry-run` / `--commit`, idempotente.
- `scripts/migratePayrollStandardDepartments.js` — reduce los departamentos a los 4 estándar por
  tipo y reasigna empleados/cargos de los personalizados al canónico. `--dry-run` / `--commit`.
