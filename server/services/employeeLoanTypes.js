/**
 * TIPOS DE PRÉSTAMO / DESCUENTO AL EMPLEADO — fuente única.
 *
 * Cada tipo dice tres cosas, y las tres tienen que ir juntas o el rol descuenta contra una
 * cuenta y el desembolso debita otra:
 *   · `accountField`: qué cuenta de la configuración de nómina lo representa. Un préstamo
 *     quirografario NO puede debitar la cuenta de préstamos de la empresa (era lo que pasaba:
 *     todos los tipos caían en `prestamoPersonal`).
 *   · `conceptCode`: con qué concepto entra al rol de pagos. Es el mismo catálogo que ya usa
 *     el rol, así que la recuperación se contabiliza sola en la cuenta del tipo.
 *   · `disburses`: si por defecto sale dinero al crearlo. Un préstamo de la empresa o un
 *     anticipo se entregan (banco/caja); una multa o un IR solo se descuentan del rol.
 *
 * El contador puede cambiar las dos cuentas del asiento en el formulario: esto es la
 * PROPUESTA por tipo, no una imposición.
 */
const LOAN_TYPES = {
  EMPRESA: {
    label: 'Préstamo de la empresa',
    accountField: 'prestamoPersonal',
    conceptCode: 'EGR-PREST-PERSONAL',
    disburses: true,
  },
  QUIROGRAFARIO: {
    label: 'Préstamo quirografario (IESS)',
    accountField: 'prestamoQuirografario',
    conceptCode: 'EGR-PREST-QUIROGRAFARIO',
    // Lo desembolsa el IESS: la empresa solo retiene la cuota y la remite.
    disburses: false,
  },
  HIPOTECARIO: {
    label: 'Préstamo hipotecario (IESS)',
    accountField: 'prestamoHipotecario',
    conceptCode: 'EGR-PREST-HIPOTECARIO',
    disburses: false,
  },
  ANTICIPO: {
    label: 'Anticipo de sueldo',
    accountField: 'anticipos',
    conceptCode: 'EGR-ANTICIPO',
    disburses: true,
  },
  IMPUESTO_RENTA: {
    label: 'Impuesto a la renta (a descontar)',
    accountField: 'impRenta',
    conceptCode: 'EGR-IMPUESTO-RENTA',
    disburses: false,
  },
  SEGURO: {
    label: 'Seguro adicional',
    accountField: 'seguros',
    conceptCode: 'EGR-SEGURO',
    // La empresa suele pagar la póliza y descontarla: por eso admite desembolso.
    disburses: true,
  },
  MULTA: {
    label: 'Multa',
    accountField: 'multa',
    conceptCode: 'EGR-MULTAS',
    disburses: false,
  },
  DESCUENTO: {
    label: 'Descuento',
    accountField: 'descuento',
    conceptCode: 'EGR-DESCUENTOS',
    disburses: false,
  },
};

/** Tipo normalizado (los registros antiguos guardaban 'EMPRESA'). */
function loanType(type) {
  return LOAN_TYPES[type] ? type : 'EMPRESA';
}

/** Definición del tipo (nunca undefined). */
function loanTypeDef(type) {
  return LOAN_TYPES[loanType(type)];
}

/** Origen del dinero al entregarlo. SIN_DESEMBOLSO = no sale nada ahora (solo se descontará). */
const DISBURSEMENT_METHODS = ['TRANSFERENCIA', 'CHEQUE', 'EFECTIVO', 'CAJA_CHICA', 'SIN_DESEMBOLSO'];

const DISBURSEMENT_LABELS = {
  TRANSFERENCIA: 'Transferencia bancaria',
  CHEQUE: 'Cheque',
  EFECTIVO: 'Efectivo (caja)',
  CAJA_CHICA: 'Caja chica',
  SIN_DESEMBOLSO: 'Sin desembolso (solo se descuenta del rol)',
};

module.exports = { LOAN_TYPES, DISBURSEMENT_METHODS, DISBURSEMENT_LABELS, loanType, loanTypeDef };
