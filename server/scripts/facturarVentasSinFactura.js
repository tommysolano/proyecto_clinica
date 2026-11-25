#!/usr/bin/env node
/**
 * VENTAS COBRADAS QUE SE QUEDARON SIN FACTURA — DIAGNÓSTICO Y FACTURACIÓN MANUAL.
 *
 * ─── POR QUÉ ───────────────────────────────────────────────────────────────────────
 * La factura electrónica NO se emite en la misma petición que la venta: el navegador
 * registra la venta y hace una SEGUNDA petición (POST /invoices/from-sale/:id).
 * Si esa segunda petición no sale o falla antes de crear la factura (red caída, pestaña cerrada,
 * /puntos-emision/mio que no cargó…), la venta queda cobrada y «Sin factura».
 *
 * ─── QUÉ HACE ──────────────────────────────────────────────────────────────────────
 * Recorre TODOS los puntos de emisión activos con usuario y lista sus ventas COMPLETADAS
 * sin factura (o con factura NO AUTORIZADA) desde --desde. Con --commit emite las ventas
 * pedidas con el MISMO controlador del botón «Facturar», como el dueño del punto (su serie,
 * su numeración, su ambiente). Una venta que ya tenga factura válida se salta.
 * Requisito del controlador: la caja del dueño del punto tiene que estar ABIERTA.
 *
 * ─── USO ───────────────────────────────────────────────────────────────────────────
 *   node scripts/facturarVentasSinFactura.js                              (solo lista)
 *   node scripts/facturarVentasSinFactura.js --desde=2026-11-01           (otra fecha)
 *   node scripts/facturarVentasSinFactura.js --commit --ventas=V-000275   (factura esas)
 *   node scripts/facturarVentasSinFactura.js --commit --punto=002-002     (todas las de ese punto)
 */
const { connect, disconnect } = require('./_common');

const PuntoEmision = require('../models/PuntoEmision');
const Sale = require('../models/Sale');
const User = require('../models/User');
const Invoice = require('../models/Invoice');

const arg = (name) => {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : null;
};

async function ventasDelPunto(punto, desde, rechazadas) {
  return Sale.find({
    status: 'completada',
    createdAt: { $gte: desde },
    $and: [
      { $or: [{ puntoEmision: punto._id }, { createdBy: punto.usuario }, { cashier: punto.usuario }] },
      { $or: [{ invoice: null }, { invoice: { $in: rechazadas } }] },
    ],
  }).sort({ createdAt: 1 });
}

/** Llama al controlador como lo haría el botón «Facturar» del dueño del punto. */
async function emitir(venta, userId) {
  const { emitFromSale } = require('../controllers/invoiceController');
  const doc = await User.findById(userId);
  const req = {
    clinicId: String(venta.clinic),
    user: doc,
    role: doc.getRoleForClinic(venta.clinic) || 'cajero',
    params: { saleId: String(venta._id) },
    body: {},
    query: {},
  };
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); return this; },
    };
    emitFromSale(req, res).catch((e) => resolve({ status: 500, payload: { message: e.message } }));
  });
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const desde = new Date(`${arg('desde') || '2026-10-29'}T00:00:00-05:00`);
  const soloVentas = (arg('ventas') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const soloPunto = arg('punto');
  if (commit && !soloVentas.length && !soloPunto) {
    throw new Error('Con --commit indica --ventas=V-000275[,V-...] o --punto=002-002');
  }

  console.log('\n=== VENTAS SIN FACTURA POR PUNTO DE EMISIÓN ===');
  console.log(commit ? 'MODO: COMMIT (emite al SRI).' : 'MODO: SOLO LISTA. Usa --commit --ventas=... para emitir.');
  console.log(`Desde: ${desde.toISOString()}\n`);
  await connect();
  try {
    const { cajaAbiertaDelUsuario } = require('../services/puntoEmision');
    const puntos = await PuntoEmision.find({ activo: true, usuario: { $ne: null } })
      .sort({ establecimiento: 1, codigo: 1 }).lean();
    const rechazadas = await Invoice.distinct('_id', { estado: 'NO_AUTORIZADO' });
    let fallidas = 0;
    for (const p of puntos) {
      const serie = `${p.establecimiento}-${p.codigo}`;
      // eslint-disable-next-line no-await-in-loop
      const user = await User.findById(p.usuario).select('name').lean();
      // eslint-disable-next-line no-await-in-loop
      const ventas = await ventasDelPunto(p, desde, rechazadas);
      // eslint-disable-next-line no-await-in-loop
      const abierta = await cajaAbiertaDelUsuario(p.clinic, p.usuario, p).catch(() => null);
      console.log(`• ${serie} (${p.nombre || '—'}) · ${user?.name || p.usuario} · caja ${abierta ? 'ABIERTA' : 'cerrada'} · sin factura: ${ventas.length}`);
      for (const v of ventas) {
        const pagos = (v.payments || []).map((x) => `${x.method} ${Number(x.amount || 0).toFixed(2)}`).join(' + ');
        console.log(`    - ${v.saleNumber}  ${v.createdAt.toISOString()}  $${Number(v.total).toFixed(2)}  ${v.clientName || ''}  [${pagos || v.paymentMethod || ''}]${v.invoice ? '  (factura NO AUTORIZADA)' : ''}`);
      }
      if (!commit) continue;

      const elegidas = ventas.filter((v) =>
        (!soloPunto || soloPunto === serie) &&
        (!soloVentas.length || soloVentas.includes(v.saleNumber)) &&
        (!v.puntoEmision || String(v.puntoEmision) === String(p._id))
      );
      for (const v of elegidas) {
        if (!v.puntoEmision) {
          // eslint-disable-next-line no-await-in-loop
          await Sale.updateOne({ _id: v._id }, { $set: { puntoEmision: p._id } });
        }
        // eslint-disable-next-line no-await-in-loop
        const r = await emitir(v, p.usuario);
        const inv = r.payload?.invoice || r.payload;
        const numero = inv?.secuencial ? `${inv.estab}-${inv.ptoEmi}-${inv.secuencial}` : '';
        if (r.status >= 400) fallidas += 1;
        console.log(`    → ${v.saleNumber}: HTTP ${r.status} ${inv?.estado || ''} ${numero} ${r.status >= 400 ? (r.payload?.message || '') : ''}`);
      }
    }
    if (fallidas) process.exitCode = 1;
  } finally {
    await disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
