const mongoose = require('mongoose');
const PuntoEmision = require('../models/PuntoEmision');
const InvoicingConfig = require('../models/InvoicingConfig');
const Invoice = require('../models/Invoice');
const CreditDebitNote = require('../models/CreditDebitNote');
const CashClosing = require('../models/CashClosing');
const Sale = require('../models/Sale');
const User = require('../models/User');
const Clinic = require('../models/Clinic');
const { sucursalUsaPuntos, puntoDelUsuario } = require('../services/puntoEmision');

/** Roles que pueden tener un punto de venta (los que facturan y manejan caja). */
const ROLES_CON_PUNTO = ['admin', 'cajero', 'contabilidad'];
const USUARIO_FIELDS = 'name email';

const httpError = (status, message) => Object.assign(new Error(message), { status });
const cod3 = (v) => String(v ?? '').replace(/\D/g, '').slice(-3).padStart(3, '0');

/** Mayor secuencial ya emitido en la sucursal para la serie, por tipo de comprobante. */
async function maxEmitido(clinicId, estab, ptoEmi) {
  const asNum = { $convert: { input: '$secuencial', to: 'long', onError: 0, onNull: 0 } };
  const clinic = new mongoose.Types.ObjectId(String(clinicId));
  const [fac, nc] = await Promise.all([
    Invoice.aggregate([
      { $match: { clinic, estab, ptoEmi } },
      { $group: { _id: null, max: { $max: asNum } } },
    ]),
    CreditDebitNote.aggregate([
      { $match: { clinic, kind: 'NC', direction: 'EMITIDA', estab, ptoEmi, secuencial: { $nin: [null, ''] } } },
      { $group: { _id: null, max: { $max: asNum } } },
    ]),
  ]);
  return { factura: Number(fac[0]?.max || 0), notaCredito: Number(nc[0]?.max || 0) };
}

/**
 * Otra sucursal con el MISMO RUC que ya emite con esta serie: el SRI vería dos cajas sacando
 * los mismos números. Devuelve el nombre de esa sucursal o null.
 */
async function serieUsadaEnOtraSucursal(clinicId, ruc, estab, codigo) {
  if (!ruc) return null;
  const otras = await InvoicingConfig.find({ ruc, clinic: { $ne: clinicId } })
    .select('clinic establecimiento puntoEmision').lean();
  for (const cfg of otras) {
    const tienePuntos = await PuntoEmision.exists({ clinic: cfg.clinic });
    const choca = tienePuntos
      ? await PuntoEmision.exists({ clinic: cfg.clinic, establecimiento: estab, codigo })
      : (cfg.establecimiento || '001') === estab && (cfg.puntoEmision || '001') === codigo;
    if (choca) {
      const c = await Clinic.findById(cfg.clinic).select('name').lean();
      return c?.name || 'otra sucursal';
    }
  }
  return null;
}

/** Usuarios de la sucursal que pueden recibir un punto, con su rol aquí. */
async function usuariosElegibles(clinicId) {
  const users = await User.find({ ...User.enSucursal(clinicId, ROLES_CON_PUNTO), active: { $ne: false } })
    .select('name email clinics worksInAllClinics companies')
    .sort({ name: 1 });
  return users.map((u) => ({ _id: u._id, name: u.name, email: u.email, role: u.getRoleForClinic(clinicId) }));
}

/**
 * Valida y normaliza los datos de un punto (alta o edición). `actual` es el documento que se
 * edita (null en el alta). Devuelve el objeto listo para guardar.
 */
async function validar(clinicId, body, actual) {
  const config = await InvoicingConfig.findOne({ clinic: clinicId });
  if (!config) throw httpError(400, 'Primero guarde los datos del emisor en la configuración SRI.');

  const data = {};
  const estab = body.establecimiento !== undefined ? cod3(body.establecimiento) : actual?.establecimiento || cod3(config.establecimiento || '001');
  const codigo = body.codigo !== undefined ? cod3(body.codigo) : actual?.codigo;
  if (!/^\d{3}$/.test(estab) || estab === '000') throw httpError(400, 'El establecimiento debe tener 3 dígitos (001, 002…).');
  if (!/^\d{3}$/.test(codigo || '') || codigo === '000') throw httpError(400, 'El código del punto de emisión debe tener 3 dígitos (001, 002…).');
  data.establecimiento = estab;
  data.codigo = codigo;
  if (body.nombre !== undefined) data.nombre = String(body.nombre || '').trim();
  if (body.direccionEstablecimiento !== undefined) data.direccionEstablecimiento = String(body.direccionEstablecimiento || '').trim();
  if (body.activo !== undefined) data.activo = !!body.activo;

  const cambiaSerie = actual && (actual.establecimiento !== estab || actual.codigo !== codigo);
  if (cambiaSerie) {
    const emitio = (await Invoice.exists({ puntoEmision: actual._id })) || (await CreditDebitNote.exists({ puntoEmision: actual._id }));
    if (emitio) {
      throw httpError(400, `El punto ${actual.establecimiento}-${actual.codigo} ya emitió comprobantes: su serie no se puede cambiar. Desactívelo y cree un punto nuevo.`);
    }
  }

  // Serie única en la sucursal…
  const repetido = await PuntoEmision.findOne({ clinic: clinicId, establecimiento: estab, codigo, _id: { $ne: actual?._id } }).lean();
  if (repetido) throw httpError(400, `Ya existe el punto ${estab}-${codigo}${repetido.nombre ? ` (${repetido.nombre})` : ''} en esta sucursal.`);
  // …y entre sucursales que facturan con el mismo RUC.
  const otra = await serieUsadaEnOtraSucursal(clinicId, config.ruc, estab, codigo);
  if (otra) throw httpError(400, `La serie ${estab}-${codigo} ya la usa la sucursal ${otra} con el mismo RUC. Use otro código.`);

  // Usuario: uno por punto y un punto por usuario.
  if (body.usuario !== undefined) {
    const usuarioId = body.usuario || null;
    if (usuarioId) {
      const u = await User.findOne({ _id: usuarioId, ...User.enSucursal(clinicId, ROLES_CON_PUNTO) }).select('name');
      if (!u) throw httpError(400, 'El usuario elegido no es cajero, administrador ni contabilidad en esta sucursal.');
      const otroPunto = await PuntoEmision.findOne({ clinic: clinicId, usuario: usuarioId, _id: { $ne: actual?._id } }).lean();
      if (otroPunto) {
        throw httpError(400, `${u.name} ya tiene el punto ${otroPunto.establecimiento}-${otroPunto.codigo}${otroPunto.nombre ? ` (${otroPunto.nombre})` : ''}. Un usuario solo puede tener un punto de venta.`);
      }
    }
    data.usuario = usuarioId;
  }

  // Cambiar de dueño o desactivar con la caja abierta dejaría esa caja huérfana.
  const cambiaUsuario = actual && data.usuario !== undefined && String(actual.usuario || '') !== String(data.usuario || '');
  const desactiva = actual && actual.activo && data.activo === false;
  if (cambiaUsuario || desactiva) {
    const abierta = await CashClosing.findOne({ clinic: clinicId, status: 'ABIERTA', puntoEmision: actual._id }).populate('openedBy', 'name');
    if (abierta) {
      throw httpError(400, `El punto tiene una caja abierta por ${abierta.openedBy?.name || 'un usuario'}. Ciérrela antes de ${desactiva ? 'desactivarlo' : 'cambiar el usuario'}.`);
    }
  }

  // Secuenciales (próximo número a usar). Nunca por debajo de lo ya emitido con esta serie.
  const emitido = await maxEmitido(clinicId, estab, codigo);
  const esParLegacy = estab === cod3(config.establecimiento || '001') && codigo === cod3(config.puntoEmision || '001');
  const minimo = {
    factura: Math.max(emitido.factura + 1, esParLegacy && !actual ? Number(config.secuencial) || 1 : 1),
    notaCredito: Math.max(emitido.notaCredito + 1, esParLegacy && !actual ? Number(config.creditNoteSequential) || 1 : 1),
  };
  const campos = { factura: 'secuencialFactura', notaCredito: 'secuencialNotaCredito' };
  const nombres = { factura: 'factura', notaCredito: 'nota de crédito' };
  for (const tipo of Object.keys(campos)) {
    const campo = campos[tipo];
    const pedido = body[campo];
    if (pedido === undefined || pedido === null || pedido === '') {
      // Alta sin número: arranca donde corresponde (continúa la serie si ya se usó).
      if (!actual) data[campo] = minimo[tipo];
      else if (cambiaSerie) data[campo] = Math.max(actual[campo] || 1, emitido[tipo] + 1);
      continue;
    }
    const n = parseInt(pedido, 10);
    if (!Number.isFinite(n) || n < 1 || n > 999999999) throw httpError(400, `El próximo número de ${nombres[tipo]} no es válido.`);
    if (n <= emitido[tipo]) {
      throw httpError(400, `Ya se emitió la ${nombres[tipo]} ${estab}-${codigo}-${String(emitido[tipo]).padStart(9, '0')}: el próximo número debe ser al menos ${emitido[tipo] + 1}.`);
    }
    data[campo] = n;
  }
  return data;
}

const populatePunto = (q) => q.populate('usuario', USUARIO_FIELDS);

exports.list = async (req, res) => {
  try {
    const [puntos, usuarios, config] = await Promise.all([
      populatePunto(PuntoEmision.find({ clinic: req.clinicId }).sort({ establecimiento: 1, codigo: 1 })),
      usuariosElegibles(req.clinicId),
      InvoicingConfig.findOne({ clinic: req.clinicId }).select('establecimiento puntoEmision secuencial creditNoteSequential direccionEstablecimiento'),
    ]);
    const abiertas = await CashClosing.find({ clinic: req.clinicId, status: 'ABIERTA', puntoEmision: { $ne: null } })
      .select('puntoEmision openedAt').lean();
    const abiertaPor = new Map(abiertas.map((c) => [String(c.puntoEmision), c.openedAt]));
    res.json({
      puntos: puntos.map((p) => ({ ...p.toObject(), cajaAbiertaDesde: abiertaPor.get(String(p._id)) || null })),
      usuarios,
      legacy: config
        ? {
          establecimiento: config.establecimiento || '001',
          puntoEmision: config.puntoEmision || '001',
          secuencial: config.secuencial || 1,
          creditNoteSequential: config.creditNoteSequential || 1,
          direccionEstablecimiento: config.direccionEstablecimiento || '',
        }
        : null,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

/** Punto del usuario actual (para la venta y la caja). */
exports.mine = async (req, res) => {
  try {
    const usaPuntos = await sucursalUsaPuntos(req.clinicId);
    const punto = usaPuntos ? await puntoDelUsuario(req.clinicId, req.user._id) : null;
    res.json({ usaPuntos, punto });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

exports.create = async (req, res) => {
  try {
    const data = await validar(req.clinicId, req.body, null);
    const punto = await PuntoEmision.create({ clinic: req.clinicId, ...data });
    res.status(201).json(await populatePunto(PuntoEmision.findById(punto._id)));
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ message: 'Esa serie o ese usuario ya están en otro punto de emisión.' });
    res.status(e.status || 400).json({ message: e.message });
  }
};

exports.update = async (req, res) => {
  try {
    const actual = await PuntoEmision.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!actual) return res.status(404).json({ message: 'Punto de emisión no encontrado' });
    const data = await validar(req.clinicId, req.body, actual);
    Object.assign(actual, data);
    await actual.save();
    res.json(await populatePunto(PuntoEmision.findById(actual._id)));
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ message: 'Esa serie o ese usuario ya están en otro punto de emisión.' });
    res.status(e.status || 400).json({ message: e.message });
  }
};

/** Solo se borra un punto sin historia; si ya facturó o tuvo caja, se desactiva. */
exports.remove = async (req, res) => {
  try {
    const punto = await PuntoEmision.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!punto) return res.status(404).json({ message: 'Punto de emisión no encontrado' });
    const usado = (await Invoice.exists({ puntoEmision: punto._id }))
      || (await CreditDebitNote.exists({ puntoEmision: punto._id }))
      || (await CashClosing.exists({ puntoEmision: punto._id }))
      || (await Sale.exists({ puntoEmision: punto._id }));
    if (usado) {
      return res.status(400).json({ message: 'Este punto ya tiene ventas, comprobantes o cajas registradas: desactívelo en lugar de eliminarlo.' });
    }
    await punto.deleteOne();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};
