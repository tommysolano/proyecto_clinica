/**
 * ANEXOS DEL SRI que acompañan a las declaraciones:
 *
 *   RDEP — Retenciones en la fuente por relación de dependencia (ANUAL). Es el detalle,
 *          empleado por empleado, del casillero laboral que el Formulario 103 declara mes a
 *          mes. Se CALCULA de las nóminas cerradas del año y el contador completa lo que el
 *          sistema no puede saber (gastos personales, otros empleadores, exoneraciones).
 *
 *   APS  — Anexo de Accionistas, Partícipes, Socios, Miembros del Directorio y
 *          Administradores. NO se calcula: la composición societaria se captura
 *          (modelo Shareholder) y de ahí sale el anexo, validando que los titulares de
 *          capital vigentes sumen 100 %.
 *
 * IMPORTANTE — el XML que genera este módulo es un BORRADOR TÉCNICO, igual que el del
 * 103/104: su estructura la definió este sistema y NO está validada contra el XSD vigente
 * del SRI, no es un archivo DIMM y no está listo para cargar. Sirve de respaldo y para
 * revisar/transcribir. Los IMPORTES sí son auditables (salen de la nómina y de la captura).
 */
const ExcelJS = require('exceljs');

const RdepAnnex = require('../models/RdepAnnex');
const Shareholder = require('../models/Shareholder');
const Clinic = require('../models/Clinic');
const { computeRdep } = require('../utils/sriForms/computeRdep');
const { XML_DISCLAIMER } = require('../utils/sriForms/definitions');

const { EDITABLE_FIELDS } = RdepAnnex;
const { CAPITAL_ROLES } = Shareholder;

const r2 = (n) => +(Number(n) || 0).toFixed(2);
const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });
const fail = (res, e) => res.status(e.status || 400).json({ message: e.message });
const HDR = 'FF0F766E'; // mismo verde de cabecera que el resto de exportaciones
const MONEY = '#,##0.00';

function escXml(s) {
  return String(s == null ? '' : s).replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  }[c]));
}

/** Año del query, con el actual por defecto. */
function readYear(req) {
  const y = parseInt(req.query.year, 10);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) {
    if (req.query.year) throw badRequest('Año inválido.');
    return new Date().getFullYear();
  }
  return y;
}

/** Cabecera de hoja de Excel con el estilo del resto de exportaciones del sistema. */
function styleHeader(ws) {
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HDR } }; });
}

// ─────────────────────────────────── RDEP ───────────────────────────────────

/** Calcula el RDEP del año mezclando lo capturado (RdepAnnex) con la nómina. */
async function buildRdep(clinicId, year) {
  const annex = await RdepAnnex.findOne({ clinic: clinicId, year });
  const overrides = annex ? annex.entryMap() : {};
  const result = await computeRdep({ clinicId, year, overrides });
  return { ...result, notes: annex?.notes || '', updatedAt: annex?.updatedAt || null };
}

/** GET /sri-annexes/rdep?year= */
exports.getRdep = async (req, res) => {
  try {
    const year = readYear(req);
    const data = await buildRdep(req.clinicId, year);
    res.json({ ...data, editableFields: EDITABLE_FIELDS, xmlDisclaimer: XML_DISCLAIMER });
  } catch (e) { fail(res, e); }
};

/**
 * PUT /sri-annexes/rdep?year=  { entries: { '0912345678': { gastosSalud: 120, ... } }, notes? }
 *
 * Solo se aceptan los campos CAPTURABLES: los calculados (sueldos, IESS, retenido) se
 * vuelven a leer de la nómina en cada consulta, así que enviarlos no tendría efecto y se
 * rechaza explícitamente en vez de ignorarlos en silencio.
 */
exports.saveRdep = async (req, res) => {
  try {
    const year = readYear(req);
    const incoming = req.body?.entries || {};
    if (typeof incoming !== 'object' || Array.isArray(incoming)) throw badRequest('`entries` debe ser un objeto {identificacion: {...}}.');

    const annex = await RdepAnnex.findOne({ clinic: req.clinicId, year })
      || new RdepAnnex({ clinic: req.clinicId, year, entries: [] });
    const current = annex.entryMap();

    for (const [ident, patch] of Object.entries(incoming)) {
      const id = String(ident).trim();
      if (!id) throw badRequest('Hay una fila sin identificación de empleado.');
      const base = current[id] || { identificacion: id };
      for (const [k, v] of Object.entries(patch || {})) {
        if (k === 'notes') { base.notes = String(v || ''); continue; }
        if (!EDITABLE_FIELDS.includes(k)) {
          throw badRequest(`El campo "${k}" del RDEP lo calcula el sistema desde la nómina: no se captura.`);
        }
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) throw badRequest(`El campo "${k}" de ${id} debe ser un número mayor o igual a cero.`);
        base[k] = r2(n);
      }
      current[id] = base;
    }

    annex.entries = Object.values(current);
    if (req.body?.notes !== undefined) annex.notes = String(req.body.notes || '');
    annex.updatedBy = req.user._id;
    await annex.save();

    const data = await buildRdep(req.clinicId, year);
    res.json({ ...data, editableFields: EDITABLE_FIELDS, xmlDisclaimer: XML_DISCLAIMER });
  } catch (e) { fail(res, e); }
};

/** GET /sri-annexes/rdep/export.xlsx?year= */
exports.exportRdepXlsx = async (req, res) => {
  try {
    const year = readYear(req);
    const { rows, totals } = await buildRdep(req.clinicId, year);
    const clinic = await Clinic.findById(req.clinicId).select('razonSocial name ruc').lean();

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Sistema clínico';
    const ws = wb.addWorksheet('RDEP', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'Tipo ident.', key: 'tipoIdentificacion', width: 12 },
      { header: 'Identificación', key: 'identificacion', width: 16 },
      { header: 'Apellidos y nombres', key: 'nombre', width: 34 },
      { header: 'Cargo', key: 'cargo', width: 22 },
      { header: 'Meses', key: 'meses', width: 8 },
      { header: 'Sueldos y salarios', key: 'sueldos', width: 17 },
      { header: 'Sobresueldos/comisiones/bonos', key: 'sobresueldos', width: 27 },
      { header: 'Ingresos gravados con este empleador', key: 'gravadoEmpleador', width: 32 },
      { header: 'Ingresos gravados otros empleadores', key: 'ingresosOtrosEmpleadores', width: 32 },
      { header: 'Ingresos NO gravados (décimos, fondos, vac.)', key: 'noGravado', width: 36 },
      { header: 'Aporte personal IESS', key: 'iessPersonal', width: 18 },
      { header: 'Aporte IESS otros empleadores', key: 'iessOtrosEmpleadores', width: 26 },
      { header: 'Vivienda', key: 'gastosVivienda', width: 13 },
      { header: 'Salud', key: 'gastosSalud', width: 13 },
      { header: 'Educación', key: 'gastosEducacion', width: 13 },
      { header: 'Alimentación', key: 'gastosAlimentacion', width: 14 },
      { header: 'Vestimenta', key: 'gastosVestimenta', width: 13 },
      { header: 'Turismo', key: 'gastosTurismo', width: 13 },
      { header: 'Total gastos personales', key: 'gastosPersonales', width: 20 },
      { header: 'Exoneración discapacidad', key: 'exoneracionDiscapacidad', width: 22 },
      { header: 'Exoneración tercera edad', key: 'exoneracionTerceraEdad', width: 22 },
      { header: 'Base imponible', key: 'baseImponible', width: 16 },
      { header: 'Impuesto a la renta causado', key: 'impuestoCausado', width: 24 },
      { header: 'Retenido por este empleador', key: 'retenidoEmpleador', width: 24 },
      { header: 'Retenido por otros empleadores', key: 'retenidoOtrosEmpleadores', width: 27 },
      { header: 'Diferencia por retener', key: 'saldoPorRetener', width: 20 },
    ];
    styleHeader(ws);
    for (const r of rows) ws.addRow(r);
    const t = ws.addRow({
      nombre: `TOTALES ${year} · ${clinic?.razonSocial || clinic?.name || ''} (RUC ${clinic?.ruc || '—'})`,
      ...totals,
    });
    t.font = { bold: true };
    for (const col of ws.columns) {
      if (!['tipoIdentificacion', 'identificacion', 'nombre', 'cargo', 'meses'].includes(col.key)) {
        ws.getColumn(col.key).numFmt = MONEY;
      }
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="rdep-${year}.xlsx"`);
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  } catch (e) { fail(res, e); }
};

/** GET /sri-annexes/rdep/draft.xml?year= — BORRADOR TÉCNICO (no es el XML oficial). */
exports.exportRdepXml = async (req, res) => {
  try {
    const year = readYear(req);
    const { rows, totals } = await buildRdep(req.clinicId, year);
    const clinic = await Clinic.findById(req.clinicId).select('razonSocial name ruc').lean();

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += `<!-- ${XML_DISCLAIMER} -->\n<rdep>\n`;
    xml += `  <advertencia>${escXml(XML_DISCLAIMER)}</advertencia>\n`;
    xml += `  <ruc>${escXml(clinic?.ruc)}</ruc>\n`;
    xml += `  <razonSocial>${escXml(clinic?.razonSocial || clinic?.name)}</razonSocial>\n`;
    xml += `  <anio>${year}</anio>\n`;
    xml += '  <empleados>\n';
    for (const r of rows) {
      xml += '    <empleado>\n';
      xml += `      <tipoIdentificacion>${escXml(r.tipoIdentificacion)}</tipoIdentificacion>\n`;
      xml += `      <identificacion>${escXml(r.identificacion)}</identificacion>\n`;
      xml += `      <apellidosNombres>${escXml(r.nombre)}</apellidosNombres>\n`;
      xml += `      <sueldosSalarios>${r.sueldos.toFixed(2)}</sueldosSalarios>\n`;
      xml += `      <sobresueldos>${r.sobresueldos.toFixed(2)}</sobresueldos>\n`;
      xml += `      <ingresosGravadosEsteEmpleador>${r.gravadoEmpleador.toFixed(2)}</ingresosGravadosEsteEmpleador>\n`;
      xml += `      <ingresosGravadosOtrosEmpleadores>${r.ingresosOtrosEmpleadores.toFixed(2)}</ingresosGravadosOtrosEmpleadores>\n`;
      xml += `      <aportePersonalIess>${r.iessPersonal.toFixed(2)}</aportePersonalIess>\n`;
      xml += `      <aporteIessOtrosEmpleadores>${r.iessOtrosEmpleadores.toFixed(2)}</aporteIessOtrosEmpleadores>\n`;
      xml += '      <gastosPersonales>\n';
      xml += `        <vivienda>${r.gastosVivienda.toFixed(2)}</vivienda>\n`;
      xml += `        <salud>${r.gastosSalud.toFixed(2)}</salud>\n`;
      xml += `        <educacion>${r.gastosEducacion.toFixed(2)}</educacion>\n`;
      xml += `        <alimentacion>${r.gastosAlimentacion.toFixed(2)}</alimentacion>\n`;
      xml += `        <vestimenta>${r.gastosVestimenta.toFixed(2)}</vestimenta>\n`;
      xml += `        <turismo>${r.gastosTurismo.toFixed(2)}</turismo>\n`;
      xml += '      </gastosPersonales>\n';
      xml += `      <exoneracionDiscapacidad>${r.exoneracionDiscapacidad.toFixed(2)}</exoneracionDiscapacidad>\n`;
      xml += `      <exoneracionTerceraEdad>${r.exoneracionTerceraEdad.toFixed(2)}</exoneracionTerceraEdad>\n`;
      xml += `      <baseImponible>${r.baseImponible.toFixed(2)}</baseImponible>\n`;
      xml += `      <impuestoCausado>${r.impuestoCausado.toFixed(2)}</impuestoCausado>\n`;
      xml += `      <valorRetenidoEsteEmpleador>${r.retenidoEmpleador.toFixed(2)}</valorRetenidoEsteEmpleador>\n`;
      xml += `      <valorRetenidoOtrosEmpleadores>${r.retenidoOtrosEmpleadores.toFixed(2)}</valorRetenidoOtrosEmpleadores>\n`;
      xml += '    </empleado>\n';
    }
    xml += '  </empleados>\n';
    xml += `  <totalRetenido>${totals.retenidoEmpleador.toFixed(2)}</totalRetenido>\n`;
    xml += '</rdep>\n';

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="borrador-tecnico-rdep-${year}.xml"`);
    res.send(xml);
  } catch (e) { fail(res, e); }
};

// ────────────────────────── Accionistas (anexo APS) ──────────────────────────

/** Normaliza y valida el cuerpo de un accionista. */
function readShareholder(body) {
  const identificacion = String(body?.identificacion || '').trim();
  const razonSocial = String(body?.razonSocial || '').trim();
  if (!identificacion) throw badRequest('La identificación es obligatoria.');
  if (!razonSocial) throw badRequest('Los apellidos y nombres (o la razón social) son obligatorios.');
  const pct = Number(body?.porcentajeParticipacion) || 0;
  if (pct < 0 || pct > 100) throw badRequest('El porcentaje de participación debe estar entre 0 y 100.');
  return {
    tipoPersona: body?.tipoPersona === 'JURIDICA' ? 'JURIDICA' : 'NATURAL',
    tipoIdentificacion: ['CEDULA', 'RUC', 'PASAPORTE'].includes(body?.tipoIdentificacion) ? body.tipoIdentificacion : 'CEDULA',
    identificacion,
    razonSocial,
    role: Shareholder.ROLES.includes(body?.role) ? body.role : 'ACCIONISTA',
    paisResidencia: String(body?.paisResidencia || 'ECUADOR').trim() || 'ECUADOR',
    paraisoFiscal: !!body?.paraisoFiscal,
    porcentajeParticipacion: r2(pct),
    capitalInvertido: r2(body?.capitalInvertido),
    numeroAcciones: Math.max(0, Math.trunc(Number(body?.numeroAcciones) || 0)),
    fechaDesde: body?.fechaDesde ? new Date(body.fechaDesde) : null,
    fechaHasta: body?.fechaHasta ? new Date(body.fechaHasta) : null,
    active: body?.active !== false,
    notes: String(body?.notes || ''),
  };
}

/** GET /sri-annexes/shareholders */
exports.listShareholders = async (req, res) => {
  try {
    const items = await Shareholder.find({ clinic: req.clinicId }).sort({ role: 1, razonSocial: 1 });
    res.json({ items, roles: Shareholder.ROLES, capitalRoles: CAPITAL_ROLES });
  } catch (e) { fail(res, e); }
};

/** POST /sri-annexes/shareholders */
exports.createShareholder = async (req, res) => {
  try {
    const doc = await Shareholder.create({
      ...readShareholder(req.body), clinic: req.clinicId, createdBy: req.user._id,
    });
    res.status(201).json(doc);
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ message: 'Esa persona ya está registrada con esa misma calidad (accionista, socio…).' });
    fail(res, e);
  }
};

/** PUT /sri-annexes/shareholders/:id */
exports.updateShareholder = async (req, res) => {
  try {
    const doc = await Shareholder.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!doc) return res.status(404).json({ message: 'Accionista no encontrado' });
    Object.assign(doc, readShareholder(req.body));
    await doc.save();
    res.json(doc);
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ message: 'Esa persona ya está registrada con esa misma calidad (accionista, socio…).' });
    fail(res, e);
  }
};

/** DELETE /sri-annexes/shareholders/:id */
exports.removeShareholder = async (req, res) => {
  try {
    const doc = await Shareholder.findOneAndDelete({ _id: req.params.id, clinic: req.clinicId });
    if (!doc) return res.status(404).json({ message: 'Accionista no encontrado' });
    res.json({ ok: true, deleted: String(doc._id) });
  } catch (e) { fail(res, e); }
};

/**
 * Arma el anexo APS al corte del 31 de diciembre del año pedido (o a hoy si el año es el
 * actual): titulares vigentes, totales y la validación de que el capital sume 100 %.
 */
async function buildAps(clinicId, year) {
  const now = new Date();
  const cutoff = year < now.getFullYear() ? new Date(year, 11, 31, 23, 59, 59) : now;
  const all = await Shareholder.find({ clinic: clinicId });
  const vigentes = all.filter((s) => s.vigenteAl(cutoff));
  const rows = vigentes.map((s) => ({
    _id: s._id,
    tipoPersona: s.tipoPersona,
    tipoIdentificacion: s.tipoIdentificacion,
    identificacion: s.identificacion,
    razonSocial: s.razonSocial,
    role: s.role,
    paisResidencia: s.paisResidencia,
    paraisoFiscal: s.paraisoFiscal,
    porcentajeParticipacion: r2(s.porcentajeParticipacion),
    capitalInvertido: r2(s.capitalInvertido),
    numeroAcciones: s.numeroAcciones || 0,
    fechaDesde: s.fechaDesde,
    fechaHasta: s.fechaHasta,
    titularDeCapital: CAPITAL_ROLES.includes(s.role),
  }));
  rows.sort((a, b) => (b.porcentajeParticipacion - a.porcentajeParticipacion) || String(a.razonSocial).localeCompare(String(b.razonSocial)));

  const capital = rows.filter((r) => r.titularDeCapital);
  const totalPct = r2(capital.reduce((s, r) => s + r.porcentajeParticipacion, 0));
  const totals = {
    titulares: capital.length,
    otrosRoles: rows.length - capital.length,
    porcentajeTotal: totalPct,
    capitalTotal: r2(capital.reduce((s, r) => s + r.capitalInvertido, 0)),
    accionesTotal: capital.reduce((s, r) => s + (r.numeroAcciones || 0), 0),
  };

  const warnings = [];
  if (!capital.length) {
    warnings.push({
      code: 'SIN_ACCIONISTAS',
      message: 'No hay accionistas, socios ni partícipes registrados: el anexo no se puede presentar. Regístrelos en esta misma pantalla.',
    });
  } else if (Math.abs(totalPct - 100) > 0.01) {
    warnings.push({
      code: 'PARTICIPACION_NO_SUMA_100',
      message: `La participación de los titulares de capital suma ${totalPct.toFixed(2)} % y debe sumar exactamente 100 %. Revise los porcentajes antes de presentar el anexo.`,
    });
  }
  const sinPais = rows.filter((r) => !r.paisResidencia);
  if (sinPais.length) {
    warnings.push({
      code: 'SIN_PAIS_RESIDENCIA',
      message: `${sinPais.length} titular(es) sin país de residencia: el anexo lo exige y define la retención de dividendos.`,
    });
  }

  const conciliaciones = [
    {
      key: 'PARTICIPACION_100',
      label: 'La participación de los titulares de capital suma 100 %',
      detalle: `${capital.length} titular(es) · ${totalPct.toFixed(2)} %`,
      ok: capital.length > 0 && Math.abs(totalPct - 100) <= 0.01,
    },
    {
      key: 'DATOS_COMPLETOS',
      label: 'Todos los reportados tienen identificación y país de residencia',
      detalle: sinPais.length ? `${sinPais.length} sin país de residencia` : `${rows.length} registro(s) completos`,
      ok: sinPais.length === 0,
    },
  ];

  return { rows, totals, warnings, conciliaciones, year, cutoff };
}

/** GET /sri-annexes/aps?year= */
exports.getAps = async (req, res) => {
  try {
    const year = readYear(req);
    const data = await buildAps(req.clinicId, year);
    res.json({ ...data, roles: Shareholder.ROLES, capitalRoles: CAPITAL_ROLES, xmlDisclaimer: XML_DISCLAIMER });
  } catch (e) { fail(res, e); }
};

/** GET /sri-annexes/aps/export.xlsx?year= */
exports.exportApsXlsx = async (req, res) => {
  try {
    const year = readYear(req);
    const { rows, totals } = await buildAps(req.clinicId, year);
    const clinic = await Clinic.findById(req.clinicId).select('razonSocial name ruc').lean();

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Sistema clínico';
    const ws = wb.addWorksheet('Accionistas', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'Calidad', key: 'role', width: 22 },
      { header: 'Tipo de persona', key: 'tipoPersona', width: 16 },
      { header: 'Tipo ident.', key: 'tipoIdentificacion', width: 12 },
      { header: 'Identificación', key: 'identificacion', width: 18 },
      { header: 'Apellidos y nombres / Razón social', key: 'razonSocial', width: 38 },
      { header: 'País de residencia', key: 'paisResidencia', width: 20 },
      { header: 'Paraíso fiscal', key: 'paraisoFiscal', width: 14 },
      { header: '% participación', key: 'porcentajeParticipacion', width: 16 },
      { header: 'Capital invertido', key: 'capitalInvertido', width: 18 },
      { header: 'N° de acciones', key: 'numeroAcciones', width: 15 },
      { header: 'Desde', key: 'fechaDesde', width: 13 },
      { header: 'Hasta', key: 'fechaHasta', width: 13 },
    ];
    styleHeader(ws);
    const d = (x) => (x ? new Date(x).toLocaleDateString('es-EC') : '');
    for (const r of rows) {
      ws.addRow({ ...r, paraisoFiscal: r.paraisoFiscal ? 'SÍ' : 'NO', fechaDesde: d(r.fechaDesde), fechaHasta: d(r.fechaHasta) });
    }
    const t = ws.addRow({
      razonSocial: `TOTAL TITULARES DE CAPITAL ${year} · ${clinic?.razonSocial || clinic?.name || ''} (RUC ${clinic?.ruc || '—'})`,
      porcentajeParticipacion: totals.porcentajeTotal,
      capitalInvertido: totals.capitalTotal,
      numeroAcciones: totals.accionesTotal,
    });
    t.font = { bold: true };
    ws.getColumn('porcentajeParticipacion').numFmt = MONEY;
    ws.getColumn('capitalInvertido').numFmt = MONEY;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="anexo-accionistas-${year}.xlsx"`);
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  } catch (e) { fail(res, e); }
};

/** GET /sri-annexes/aps/draft.xml?year= — BORRADOR TÉCNICO (no es el XML oficial). */
exports.exportApsXml = async (req, res) => {
  try {
    const year = readYear(req);
    const { rows, totals } = await buildAps(req.clinicId, year);
    const clinic = await Clinic.findById(req.clinicId).select('razonSocial name ruc').lean();

    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += `<!-- ${XML_DISCLAIMER} -->\n<anexoAccionistas>\n`;
    xml += `  <advertencia>${escXml(XML_DISCLAIMER)}</advertencia>\n`;
    xml += `  <ruc>${escXml(clinic?.ruc)}</ruc>\n`;
    xml += `  <razonSocial>${escXml(clinic?.razonSocial || clinic?.name)}</razonSocial>\n`;
    xml += `  <anio>${year}</anio>\n`;
    xml += '  <titulares>\n';
    for (const r of rows) {
      xml += '    <titular>\n';
      xml += `      <calidad>${escXml(r.role)}</calidad>\n`;
      xml += `      <tipoPersona>${escXml(r.tipoPersona)}</tipoPersona>\n`;
      xml += `      <tipoIdentificacion>${escXml(r.tipoIdentificacion)}</tipoIdentificacion>\n`;
      xml += `      <identificacion>${escXml(r.identificacion)}</identificacion>\n`;
      xml += `      <razonSocial>${escXml(r.razonSocial)}</razonSocial>\n`;
      xml += `      <paisResidencia>${escXml(r.paisResidencia)}</paisResidencia>\n`;
      xml += `      <paraisoFiscal>${r.paraisoFiscal ? 'SI' : 'NO'}</paraisoFiscal>\n`;
      xml += `      <porcentajeParticipacion>${r.porcentajeParticipacion.toFixed(2)}</porcentajeParticipacion>\n`;
      xml += `      <capitalInvertido>${r.capitalInvertido.toFixed(2)}</capitalInvertido>\n`;
      xml += `      <numeroAcciones>${r.numeroAcciones}</numeroAcciones>\n`;
      xml += '    </titular>\n';
    }
    xml += '  </titulares>\n';
    xml += `  <porcentajeTotal>${totals.porcentajeTotal.toFixed(2)}</porcentajeTotal>\n`;
    xml += `  <capitalTotal>${totals.capitalTotal.toFixed(2)}</capitalTotal>\n`;
    xml += '</anexoAccionistas>\n';

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="borrador-tecnico-accionistas-${year}.xml"`);
    res.send(xml);
  } catch (e) { fail(res, e); }
};
