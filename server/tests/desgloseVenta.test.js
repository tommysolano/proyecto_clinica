'use strict';
/**
 * DESGLOSE DE LA VENTA EN LOS EXCEL (nov-2026, reunión con la contadora).
 * La captura: Subtotal 110,50 · IVA 14,41 · Total 110,50. El «subtotal» era el precio
 * visible con el IVA dentro. Debe salir como en la factura: bases por tarifa + IVA = total.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { desgloseVenta, facturaDeVenta } = require('../utils/desgloseVenta');
const { salesSheetRow, SALES_COLUMNS } = require('../services/salesWorkbook');

// 110,50 cobrados: 100,00 de un servicio con IVA incluido (86,96 + 13,04) + 10,50 al 0 %.
const venta = {
  saleNumber: 'V-017036',
  createdAt: new Date('2026-10-30T15:00:00Z'),
  clientName: 'PACIENTE', paymentMethod: 'tarjeta',
  subtotal: 110.5, taxAmount: 13.04, total: 110.5,
  items: [
    { productName: 'Servicio', quantity: 1, unitPrice: 100, taxRate: 15, taxCategory: 'IVA_15', taxCodeSri: '4',
      grossAmount: 100, discount: 0, discountTaxBase: 0, taxBase: 86.96, taxAmount: 13.04, lineTotal: 100, subtotal: 86.96 },
    { productName: 'Consulta', quantity: 1, unitPrice: 12, taxRate: 0, taxCategory: 'IVA_0', taxCodeSri: '0',
      grossAmount: 12, discount: 1.5, discountTaxBase: 1.5, taxBase: 10.5, taxAmount: 0, lineTotal: 10.5, subtotal: 10.5 },
  ],
  payments: [{ method: 'tarjeta', amount: 110.5, cardTypeSnapshot: 'CREDITO' }],
  invoice: { estab: '002', ptoEmi: '001', secuencial: '3344', estado: 'AUTORIZADO' },
};

test('el subtotal es la suma de las bases (sin IVA), no el precio con IVA', () => {
  const d = desgloseVenta(venta);
  assert.equal(d.base15, 86.96);
  assert.equal(d.base0, 10.5);
  assert.equal(d.subtotal, 97.46);
  assert.equal(d.iva, 13.04);
  assert.equal(+(d.subtotal + d.iva).toFixed(2), d.total, 'subtotal + IVA = total');
  assert.equal(d.descuento, 1.5, 'el descuento de la factura se ve');
});

test('el Excel de Ventas empieza por la factura y no trae el número de venta', () => {
  assert.equal(SALES_COLUMNS[0].header, 'Factura');
  assert.ok(!SALES_COLUMNS.some((c) => /venta/i.test(c.header) && c.key === 'saleNumber'));
  const fila = salesSheetRow(venta);
  assert.equal(fila.invoice, '002-001-000003344');
  assert.equal(fila.subtotal, 97.46);
  assert.equal(fila.base15, 86.96);
  assert.equal(fila.tarjetaCredito, 110.5, 'la tarjeta de crédito sigue separada de la de débito');
});

test('sin factura se dice; las importadas de Contífico traen la factura como número', () => {
  assert.equal(facturaDeVenta({ saleNumber: 'V-1' }, null), 'Sin factura (V-1)');
  assert.equal(facturaDeVenta({ saleNumber: '002-002-000002531' }, null), '002-002-000002531');
});
