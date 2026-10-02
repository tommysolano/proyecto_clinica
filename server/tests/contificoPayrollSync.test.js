'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { personsInJournals, salaryCheck } = require('../services/contificoPayrollSync');
const { payrollPaymentJournal, payrollClosingJournal, payrollProvisions } = require('../scripts/projectContificoSupplemental');

const journal = (id, date, description, lines) => ({ _id: id, date: new Date(`${date}T12:00:00Z`), description, lines });
const credit = (accountCode, value) => ({ accountCode, debit: 0, credit: value });
const debit = (accountCode, value) => ({ accountCode, debit: value, credit: 0 });

test('descubre en los asientos de nómina a personas que no están marcadas como empleado', () => {
  const persons = [
    { razon_social: 'ARDILA SUAREZ JAIME ERNESTO', cedula: '0901' },
    { razon_social: 'ARDILA SUAREZ CARLA MADELEINE', cedula: '0902' },
    { razon_social: 'ALVARADO CASTRO JENIFFER STEPHANIA', cedula: '0903' },
    { razon_social: 'CLIENTE CUALQUIERA', cedula: '0904' },
  ];
  const found = personsInJournals([
    journal('a', '2026-08-31', 'Registro de sueldos y provisión de beneficios sociales Agosto 2026, - ALVARADO CASTRO JENIFFER ', []),
    journal('b', '2026-08-17', 'Cancelación de haberes correspodientes al mes de Agosto, ARDILA SUAREZ CARLA MADELEINE', []),
  ], persons);
  assert.deepEqual([...found.keys()].sort(), ['0902', '0903']);
});

test('los sueldos de los roles deben cuadrar con el mayor cuando el mes está cerrado', () => {
  const role = (sueldos) => ({ detalles: sueldos.map((total) => ({ nombre: 'SUELDO', tipo: 'INGRESO', total })) });
  const roles = [role([200]), role([300, 1100]), { detalles: [{ nombre: '9.45% IESS', tipo: 'EGRESO', total: 47 }] }];
  assert.equal(salaryCheck(roles, 1600).state, 'CUADRA');
  assert.equal(salaryCheck(roles, 1953.47).state, 'DIFERENTE');
  assert.equal(salaryCheck(roles, 0).state, 'SIN_CIERRE');
});

test('cada pago y cierre de rol se enlaza a su asiento aunque dos empleados compartan apellidos y monto', () => {
  const journals = [
    journal('carla', '2026-04-15', 'Cancelación de haberes correspodientes al mes de Abril, CARLA ARDILA SUAREZ', [credit('1.1.1.3', 200), debit('1.1.2.5.4.1', 200)]),
    journal('jaime', '2026-04-15', 'Cancelación de haberes correspodientes al mes de Abril, JAIME ARDILA SUAREZ', [credit('1.1.1.3', 200), debit('1.1.2.5.4.1', 200)]),
    journal('cierre', '2026-04-30', 'Registro de sueldos y provisión de beneficios sociales Abril 2026, - JAIME ARDILA SUAREZ',
      [credit('2.1.7.7.1', 252.75), debit('5.2.1.2.1', 500), debit('5.2.1.2.5', 55.75), debit('5.2.1.2.6', 5),
        debit('5.2.1.2.8', 41.67), debit('5.2.1.2.9', 40.17), debit('5.2.1.2.10', 20.83)]),
  ];
  const date = new Date('2026-04-15T12:00:00Z');
  assert.equal(payrollPaymentJournal(journals, { date, amount: 200, person: 'ARDILA SUAREZ JAIME ERNESTO' })._id, 'jaime');
  assert.equal(payrollPaymentJournal(journals, { date, amount: 200, person: 'CARLA MADELEINE ARDILA SUAREZ' })._id, 'carla');
  assert.equal(payrollPaymentJournal(journals, { date, amount: 201, person: 'CARLA MADELEINE ARDILA SUAREZ' }), null);
  const closing = payrollClosingJournal(journals, { year: 2026, month: 4, net: 252.75, person: 'ARDILA SUAREZ JAIME ERNESTO' });
  assert.equal(closing._id, 'cierre');
  assert.deepEqual(payrollProvisions(closing), { iessPatronal: 55.75, secap: 5, provDecimoTercero: 41.67,
    provDecimoCuarto: 40.17, provVacaciones: 20.83, totalProvisiones: 163.42 });
});
