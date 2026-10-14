/**
 * PVP de un producto de Contífico, CON IVA.
 *
 * En Contífico `pvp1` es la BASE: la factura pone el IVA encima (HIDRAURE: pvp1 14.35 →
 * base 14.35 + IVA 2.15 = 16.50). Aquí `salePrice` es lo que paga el paciente y el producto
 * lleva `priceIncludesVat: true`, así que guardar el pvp1 tal cual cobraba un 15 % de menos:
 * el IVA se sacaba de dentro de 14.35 en vez de sumarse.
 *
 * Se calcula como la factura: base al centavo + IVA al centavo (mitad hacia arriba), en
 * centavos ENTEROS. Con `(35.5 * 1.15).toFixed(2)` la coma flotante daba 40.82 y Contífico
 * factura 35.50 + 5.33 = 40.83. Al cobrar, `calculateSaleLine` divide entre (1 + tarifa) y
 * vuelve a la misma base e IVA.
 */
function pvpConIva(pvp1, porcentajeIva) {
  const baseCentavos = Math.round(Math.max(0, Number(pvp1) || 0) * 100);
  const tarifa = Number(porcentajeIva) > 0 ? Number(porcentajeIva) : 0;
  return (baseCentavos + Math.round((baseCentavos * tarifa) / 100)) / 100;
}

module.exports = { pvpConIva };
