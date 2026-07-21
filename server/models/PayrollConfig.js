const mongoose = require('mongoose');

/**
 * Configuración de nómina por clínica. Centraliza tasas legales (configurables)
 * y el MAPEO DE CUENTAS que usa el cierre de rol.
 *
 * El mapeo de cuentas replica la estructura de RRHH de Contífico (ver
 * docs/CONFIGURACION_NOMINA.md), pedida por la contadora:
 *
 *  - `accounts.byDepartment.<TIPO>`: cuentas de GASTO, distintas por departamento
 *    (Administrativo/Ventas/Costos/Otros). Un empleado carga su sueldo/beneficios/
 *    provisiones a las cuentas del TIPO de su departamento.
 *  - `accounts.global`: cuentas de BALANCE (activos/pasivos). No cambian por
 *    departamento: descuentos, préstamos, sueldos por pagar, provisiones por pagar,
 *    aportes al IESS por pagar, etc.
 *
 * Todas son referencias al plan de cuentas (`ChartOfAccount`) y admiten null. El
 * posteo resuelve `config → default por código` para los rubros centrales (para que
 * una clínica recién creada contabilice sin configurar nada) y BLOQUEA con mensaje
 * claro cuando un rubro con valor no tiene cuenta (coherente con "nunca adivinar
 * cuentas", igual que ventas/compras).
 */
const accRef = () => ({ type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount' });

// Cuentas de GASTO por departamento (Ingresos del empleado + gastos de provisiones/IESS).
const deptAccountsSchema = new mongoose.Schema({
  // 1.2 Ingresos del empleado (gasto)
  sueldo: accRef(),
  alimentacion: accRef(),
  transporte: accRef(),
  vivienda: accRef(),
  comisiones: accRef(),
  horasExtra: accRef(),
  bonificaciones: accRef(),
  otrosIngresos: accRef(),
  devBeneficios: accRef(),
  devDiasMultas: accRef(),
  // 1.5/1.6 Gasto de provisiones y aportes patronales (el pasivo es global)
  dec3Gasto: accRef(),
  dec4Gasto: accRef(),
  fondosReservaGasto: accRef(),
  vacacionesGasto: accRef(),
  aportePatronalGasto: accRef(),
  secapGasto: accRef(),
}, { _id: false });

// Cuentas GLOBALES de balance (activos/pasivos): no dependen del departamento.
const globalAccountsSchema = new mongoose.Schema({
  // 1.3 Egresos/descuentos al empleado (activo/pasivo)
  anticipos: accRef(),
  descuento: accRef(),
  multa: accRef(),
  ausencias: accRef(),
  comisariato: accRef(),
  farmacia: accRef(),
  seguros: accRef(),
  celular: accRef(),
  descuentoDiasNoLaborados: accRef(),
  // 1.4 Otros egresos
  prestamoQuirografario: accRef(),
  prestamoHipotecario: accRef(),
  prestamoPersonal: accRef(),
  otrosEgresos: accRef(),
  impRenta: accRef(),
  // 1.5 Obligaciones con el empleado (pasivos)
  sueldosPorPagar: accRef(),
  dec3Pasivo: accRef(),
  dec4Pasivo: accRef(),
  fondosReservaPasivo: accRef(),
  vacacionesPasivo: accRef(),
  // 1.6 Obligaciones con el IESS (pasivos)
  iessPersonal: accRef(),
  aporteConyugal: accRef(),
  aportePatronalPasivo: accRef(),
  secapPasivo: accRef(),
}, { _id: false });

const payrollConfigSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, unique: true, index: true },
    paymentFrequency: { type: String, enum: ['MENSUAL', 'QUINCENAL'], default: 'MENSUAL' },
    // Anticipo de la 1ª quincena: % del SUELDO que se paga como anticipo (la contadora usa 40%).
    // Sobreescribible por empleado (Employee.anticipoQuincenaPct). Solo sueldo, sin IESS.
    anticipoQuincenaPct: { type: Number, default: 40, min: 0, max: 100 },
    // Tasas (en %, se dividen entre 100 al usarse)
    iessPersonal: { type: Number, default: 9.45 },
    iessPatronal: { type: Number, default: 11.15 },
    iece: { type: Number, default: 0.5 },
    secap: { type: Number, default: 0.5 },
    fondosReserva: { type: Number, default: 8.33 },
    sbu: { type: Number, default: 460 }, // Salario Básico Unificado
    // Mapeo de cuentas contables (refs al plan). Ver documentación de arriba.
    accounts: {
      global: { type: globalAccountsSchema, default: () => ({}) },
      byDepartment: {
        ADMINISTRATIVO: { type: deptAccountsSchema, default: () => ({}) },
        VENTAS: { type: deptAccountsSchema, default: () => ({}) },
        COSTOS: { type: deptAccountsSchema, default: () => ({}) },
        OTROS: { type: deptAccountsSchema, default: () => ({}) },
      },
    },
  },
  { timestamps: true }
);

// Los 4 tipos estándar de departamento (claves de accounts.byDepartment).
const DEPT_TYPES = ['ADMINISTRATIVO', 'VENTAS', 'COSTOS', 'OTROS'];

/**
 * Códigos por defecto del plan para los rubros CENTRALES del rol. Solo se usan para
 * que una clínica sin configurar contabilice igual (resiliencia); los rubros
 * granulares que la contadora administra (alimentación, transporte, comisiones, horas
 * extra, etc.) NO tienen default → si se usan sin cuenta, el cierre se BLOQUEA.
 */
const POSTING_DEFAULT_CODES = {
  byDepartment: {
    sueldo: '6.1.01',
    otrosIngresos: '6.1.01',
    dec3Gasto: '6.1.02',
    dec4Gasto: '6.1.02',
    fondosReservaGasto: '6.1.02',
    vacacionesGasto: '6.1.07',
    aportePatronalGasto: '6.1.03',
    secapGasto: '6.1.03',
  },
  global: {
    sueldosPorPagar: '2.1.03.01',
    iessPersonal: '2.1.03.02',
    aporteConyugal: '2.1.03.02',
    aportePatronalPasivo: '2.1.03.02',
    secapPasivo: '2.1.03.02',
    impRenta: '2.1.02.05',
    dec3Pasivo: '2.1.03.03',
    dec4Pasivo: '2.1.03.04',
    fondosReservaPasivo: '2.1.03.05',
    vacacionesPasivo: '2.1.03.06',
    anticipos: '1.1.02.06',
    descuento: '1.1.02.06',
    multa: '1.1.02.06',
    ausencias: '1.1.02.06',
    seguros: '1.1.02.06',
    celular: '1.1.02.06',
    descuentoDiasNoLaborados: '1.1.02.06',
    otrosEgresos: '1.1.02.06',
    prestamoPersonal: '1.1.02.04',
    prestamoQuirografario: '1.1.02.06',
    prestamoHipotecario: '1.1.02.06',
  },
};

/**
 * Búsqueda por NOMBRE para pre-cargar los rubros granulares de ingreso al sembrar
 * (cuentas de gasto ya existentes en el plan de la clínica). Si no hay coincidencia,
 * el campo queda en blanco (la contadora lo asigna). No crea cuentas.
 */
const DEPT_NAME_HINTS = {
  alimentacion: /aliment/i,
  transporte: /transport|moviliz/i,
  vivienda: /arriend|vivienda/i,
  comisiones: /comision/i,
  horasExtra: /sobretiempo|horas?\s*extra/i,
  bonificaciones: /gratificac|bonificac/i,
};

module.exports = mongoose.model('PayrollConfig', payrollConfigSchema);
module.exports.DEPT_TYPES = DEPT_TYPES;
module.exports.POSTING_DEFAULT_CODES = POSTING_DEFAULT_CODES;
module.exports.DEPT_NAME_HINTS = DEPT_NAME_HINTS;
