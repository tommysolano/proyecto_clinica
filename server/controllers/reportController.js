const ExcelJS = require('exceljs');
const Sale = require('../models/Sale');
const Appointment = require('../models/Appointment');
const Invoice = require('../models/Invoice');
const Patient = require('../models/Patient');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');
const Treatment = require('../models/Treatment');
const { canReq } = require('../utils/permissions');
// Hoja «Ventas» del Excel contable (una fila por venta, con el desglose por forma de pago).
// Es la MISMA que baja Reportes de Ventas: el formato del contador vive en un solo sitio.
const { addSalesSheet, findSalesForSheet } = require('../services/salesWorkbook');

/**
 * Reporte de atenciones por proveedor (doctor/enfermero) en un rango de fechas.
 * Cuenta pacientes atendidos (citas completadas) por cada doctor/enfermero.
 */
exports.attentionReport = async (req, res) => {
  try {
    const { start, end, doctor } = req.query;
    const startDate = start ? new Date(start) : new Date(Date.now() - 30 * 86400000);
    startDate.setHours(0, 0, 0, 0);
    const endDate = end ? new Date(end) : new Date();
    endDate.setHours(23, 59, 59, 999);

    // CRM/marketing global: atenciones de TODA la organización (no por sucursal).
    const query = {
      status: 'completada',
      date: { $gte: startDate, $lte: endDate },
    };
    if (doctor) query.doctor = doctor;

    const appts = await Appointment.find(query)
      .populate('doctor', 'name')
      .populate('attendedByNurse', 'name')
      .populate('patient', 'firstName lastName')
      .populate('services.product', 'name');

    const providers = {};
    const addAttention = (id, name, type, apt) => {
      if (!id) return;
      const key = String(id);
      if (!providers[key]) {
        providers[key] = {
          id: key,
          name,
          type,
          count: 0,
          patients: new Set(),
          list: [],
          treatments: {},
        };
      }
      providers[key].count += 1;
      if (apt.patient) providers[key].patients.add(String(apt.patient._id));
      const services = (apt.services || []).map((s) => s.name || s.product?.name).filter(Boolean);
      providers[key].list.push({
        date: apt.date,
        patient: apt.patient ? `${apt.patient.firstName} ${apt.patient.lastName}` : '—',
        patientId: apt.patient?._id || null,
        services,
      });
      services.forEach((sname) => {
        providers[key].treatments[sname] = (providers[key].treatments[sname] || 0) + 1;
      });
    };

    for (const apt of appts) {
      if (apt.doctor) addAttention(apt.doctor._id, apt.doctor.name, 'doctor', apt);
      if (apt.attendedByNurse) addAttention(apt.attendedByNurse._id, apt.attendedByNurse.name, 'enfermero', apt);
    }

    const result = Object.values(providers)
      .map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        attentions: p.count,
        uniquePatients: p.patients.size,
        list: p.list,
        treatments: Object.entries(p.treatments)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count),
      }))
      .sort((a, b) => b.attentions - a.attentions);

    res.json({ providers: result, total: appts.length });
  } catch (e) {
    res.status(500).json({ message: 'Error al generar reporte de atenciones', error: e.message });
  }
};

/**
 * Adherencia de un paciente: tratamientos recetados y su progreso (si los siguió).
 */
exports.patientAdherence = async (req, res) => {
  try {
    const treatments = await Treatment.find({ patient: req.params.patientId })
      .populate('prescribedBy', 'name')
      .sort({ createdAt: -1 });
    const data = treatments.map((t) => ({
      id: t._id,
      name: t.name,
      status: t.status,
      progress: t.progress ?? 0,
      prescribedBy: t.prescribedBy?.name || '—',
      startDate: t.startDate,
      items: (t.items || []).map((it) => ({ name: it.name, quantity: it.quantity, completed: it.completed || 0 })),
    }));
    res.json({ treatments: data });
  } catch (e) {
    res.status(500).json({ message: 'Error al obtener adherencia', error: e.message });
  }
};

const sendWorkbook = async (res, workbook, filename) => {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await workbook.xlsx.write(res);
  res.end();
};

const buildDateRange = (req) => {
  const { startDate, endDate } = req.query;
  if (startDate && endDate) {
    return { $gte: new Date(startDate), $lte: new Date(endDate + 'T23:59:59.999') };
  }
  return null;
};

const styleHeader = (worksheet) => {
  worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF047857' },
  };
  worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'left' };
};

/* ============================== VENTAS ============================== */
exports.exportSales = async (req, res) => {
  try {
    const range = buildDateRange(req);
    const sales = await findSalesForSheet(req.clinicId, { range, status: req.query.status });

    // La hoja la arma `services/salesWorkbook`: es el MISMO archivo que se descarga desde
    // Reportes de Ventas (el contador trabaja con este formato y no puede haber dos).
    const wb = new ExcelJS.Workbook();
    addSalesSheet(wb, sales);

    await sendWorkbook(res, wb, `ventas_${Date.now()}.xlsx`);
  } catch (error) {
    res.status(500).json({ message: 'Error al exportar ventas', error: error.message });
  }
};

/* ============================== CITAS ============================== */
exports.exportAppointments = async (req, res) => {
  try {
    const query = { clinic: req.clinicId };
    const range = buildDateRange(req);
    if (range) query.date = range;
    if (req.query.status) query.status = req.query.status;
    if (req.query.doctor) query.doctor = req.query.doctor;
    if (req.query.createdBy) query.createdBy = req.query.createdBy;

    const appointments = await Appointment.find(query)
      .populate('patient', 'firstName lastName cedula phone')
      .populate('doctor', 'name specialty')
      .populate('createdBy', 'name email')
      .sort({ date: 1, startTime: 1 });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Citas');
    // El Excel de citas NO debe incluir teléfono, correo, cédula ni dirección del paciente.
    ws.columns = [
      { header: 'Fecha', key: 'date', width: 12 },
      { header: 'Hora inicio', key: 'start', width: 11 },
      { header: 'Hora fin', key: 'end', width: 11 },
      { header: 'Paciente', key: 'patient', width: 28 },
      { header: 'Paciente nuevo', key: 'isFirst', width: 14 },
      { header: 'Doctor', key: 'doctor', width: 24 },
      { header: 'Especialidad', key: 'specialty', width: 18 },
      { header: 'Estado', key: 'status', width: 12 },
      { header: 'Motivo', key: 'reason', width: 30 },
      { header: 'Servicios', key: 'services', width: 36 },
      { header: 'Total servicios', key: 'totalServ', width: 14 },
      { header: 'Abonó adelanto', key: 'paid', width: 14 },
      { header: 'Registrado por', key: 'createdBy', width: 22 },
      { header: 'Rol creador', key: 'createdRole', width: 14 },
    ];

    appointments.forEach((a) => {
      const totalServ = (a.services || []).reduce((s, x) => s + Number(x.price || 0), 0);
      ws.addRow({
        date: new Date(a.date).toLocaleDateString('es-EC'),
        start: a.startTime,
        end: a.endTime,
        patient: `${a.patient?.firstName || ''} ${a.patient?.lastName || ''}`.trim(),
        isFirst: a.isFirstVisit ? 'SÍ' : '',
        doctor: a.doctor?.name || '',
        specialty: a.doctor?.specialty || '',
        status: a.status,
        reason: a.reason || '',
        services: (a.services || []).map((s) => s.name).join(', '),
        totalServ,
        paid: a.paidInAdvance ? 'SÍ' : '',
        createdBy: a.createdBy?.name || '',
        createdRole: a.createdByRole || '',
      });
    });
    ws.getColumn('totalServ').numFmt = '"$"#,##0.00';
    styleHeader(ws);

    // Hoja de comisiones agrupadas
    const wsCom = wb.addWorksheet('Comisiones');
    wsCom.columns = [
      { header: 'Persona', key: 'person', width: 28 },
      { header: 'Rol', key: 'role', width: 14 },
      { header: 'Total citas', key: 'count', width: 14 },
      { header: 'Pacientes nuevos', key: 'news', width: 18 },
      { header: 'Total servicios ($)', key: 'amount', width: 18 },
    ];
    const commissionsByDoctor = new Map();
    const commissionsByCallCenter = new Map();

    appointments.forEach((a) => {
      const doctorName = a.doctor?.name || '—';
      const dKey = String(a.doctor?._id || doctorName);
      const dCur = commissionsByDoctor.get(dKey) || {
        person: doctorName,
        role: 'doctor',
        count: 0,
        news: 0,
        amount: 0,
      };
      dCur.count += 1;
      if (a.isFirstVisit) dCur.news += 1;
      dCur.amount += (a.services || []).reduce((s, x) => s + Number(x.price || 0), 0);
      commissionsByDoctor.set(dKey, dCur);

      if (a.createdByRole === 'call_center' && a.createdBy) {
        const ccName = a.createdBy?.name || '—';
        const cKey = String(a.createdBy?._id || ccName);
        const cCur = commissionsByCallCenter.get(cKey) || {
          person: ccName,
          role: 'call_center',
          count: 0,
          news: 0,
          amount: 0,
        };
        cCur.count += 1;
        if (a.isFirstVisit) cCur.news += 1;
        cCur.amount += (a.services || []).reduce((s, x) => s + Number(x.price || 0), 0);
        commissionsByCallCenter.set(cKey, cCur);
      }
    });

    [...commissionsByDoctor.values(), ...commissionsByCallCenter.values()].forEach((row) =>
      wsCom.addRow(row)
    );
    wsCom.getColumn('amount').numFmt = '"$"#,##0.00';
    styleHeader(wsCom);

    await sendWorkbook(res, wb, `citas_${Date.now()}.xlsx`);
  } catch (error) {
    res.status(500).json({ message: 'Error al exportar citas', error: error.message });
  }
};

/* ============================== FACTURAS ============================== */
exports.exportInvoices = async (req, res) => {
  try {
    const query = { clinic: req.clinicId };
    const range = buildDateRange(req);
    if (range) query.createdAt = range;
    if (req.query.estado) query.estado = req.query.estado;

    const invoices = await Invoice.find(query)
      .populate({
        path: 'sale',
        populate: { path: 'patient', select: 'firstName lastName cedula' },
      })
      .sort({ createdAt: -1 });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Facturas');
    ws.columns = [
      { header: 'N° Factura', key: 'num', width: 18 },
      { header: 'Clave de acceso', key: 'clave', width: 50 },
      { header: 'Fecha', key: 'date', width: 14 },
      { header: 'Cliente', key: 'client', width: 30 },
      { header: 'Identificación', key: 'cedula', width: 16 },
      { header: 'Paciente registrado', key: 'patient', width: 28 },
      { header: 'Subtotal', key: 'subtotal', width: 12 },
      { header: 'IVA', key: 'iva', width: 10 },
      { header: 'Total', key: 'total', width: 12 },
      { header: 'Estado', key: 'estado', width: 14 },
      { header: 'Ambiente', key: 'amb', width: 12 },
    ];
    invoices.forEach((inv) => {
      const num = `${inv.estab}-${inv.ptoEmi}-${String(inv.secuencial).padStart(9, '0')}`;
      ws.addRow({
        num,
        clave: inv.claveAcceso,
        date: inv.fechaEmision,
        client: inv.razonSocialComprador,
        cedula: inv.identificacionComprador,
        patient: inv.sale?.patient
          ? `${inv.sale.patient.firstName} ${inv.sale.patient.lastName}`
          : '—',
        subtotal: Number(inv.totalSinImpuestos || 0),
        iva: Number(inv.totalImpuesto || 0),
        total: Number(inv.importeTotal || 0),
        estado: inv.estado,
        amb: inv.ambiente === '2' ? 'Producción' : 'Pruebas',
      });
    });
    ['subtotal', 'iva', 'total'].forEach((k) => {
      ws.getColumn(k).numFmt = '"$"#,##0.00';
    });
    styleHeader(ws);

    await sendWorkbook(res, wb, `facturas_${Date.now()}.xlsx`);
  } catch (error) {
    res.status(500).json({ message: 'Error al exportar facturas', error: error.message });
  }
};

/* ============================== PACIENTES ============================== */
exports.exportPatients = async (req, res) => {
  try {
    const patients = await Patient.find({ clinic: req.clinicId, active: true }).sort({
      lastName: 1,
    });
    // Los datos de contacto son solo del admin (ver CONTACT_FIELDS en
    // patientController). Un Excel descargable es justo por donde se escaparían
    // en bloque, así que para el resto del personal esas columnas ni se crean.
    const showContact = canReq(req, 'patients.contactData');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Pacientes');
    ws.columns = [
      ...(showContact ? [{ header: 'Cédula', key: 'cedula', width: 14 }] : []),
      { header: 'Nombres', key: 'first', width: 18 },
      { header: 'Apellidos', key: 'last', width: 18 },
      { header: 'Edad', key: 'age', width: 8 },
      { header: 'Género', key: 'gender', width: 12 },
      ...(showContact
        ? [
            { header: 'Email', key: 'email', width: 26 },
            { header: 'Teléfono', key: 'phone', width: 14 },
            { header: 'WhatsApp', key: 'wa', width: 14 },
            { header: 'Dirección', key: 'address', width: 28 },
          ]
        : []),
      { header: 'Registrado', key: 'created', width: 14 },
    ];
    patients.forEach((p) => {
      const obj = p.toObject({ virtuals: true });
      ws.addRow({
        first: p.firstName,
        last: p.lastName,
        age: obj.computedAge ?? '',
        gender: p.gender || '',
        created: new Date(p.createdAt).toLocaleDateString('es-EC'),
        ...(showContact
          ? {
              cedula: p.cedula,
              email: p.email || '',
              phone: p.phone || '',
              wa: p.whatsapp || '',
              address: p.address || '',
            }
          : {}),
      });
    });
    styleHeader(ws);
    await sendWorkbook(res, wb, `pacientes_${Date.now()}.xlsx`);
  } catch (error) {
    res.status(500).json({ message: 'Error al exportar pacientes', error: error.message });
  }
};

/* ============================== INVENTARIO ============================== */
exports.exportInventory = async (req, res) => {
  try {
    const products = await Product.find({ clinic: req.clinicId, active: true }).sort({
      name: 1,
    });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Productos');
    ws.columns = [
      { header: 'Código', key: 'code', width: 14 },
      { header: 'Nombre', key: 'name', width: 30 },
      { header: 'Categoría', key: 'cat', width: 14 },
      { header: 'Precio compra', key: 'pp', width: 14 },
      { header: 'Precio venta', key: 'sp', width: 14 },
      { header: 'Stock', key: 'stock', width: 10 },
      { header: 'Stock mínimo', key: 'minStock', width: 12 },
      { header: 'Ilimitado', key: 'unlimited', width: 12 },
      { header: 'Unidad', key: 'unit', width: 12 },
      { header: 'IVA %', key: 'tax', width: 8 },
    ];
    products.forEach((p) => {
      ws.addRow({
        code: p.code,
        name: p.name,
        cat: p.category,
        pp: Number(p.purchasePrice || 0),
        sp: Number(p.salePrice || 0),
        stock: p.unlimited ? '∞' : p.stock,
        minStock: p.minStock,
        unlimited: p.unlimited ? 'SÍ' : '',
        unit: p.unit,
        tax: p.taxRate,
      });
    });
    ['pp', 'sp'].forEach((k) => {
      ws.getColumn(k).numFmt = '"$"#,##0.00';
    });
    styleHeader(ws);
    await sendWorkbook(res, wb, `inventario_${Date.now()}.xlsx`);
  } catch (error) {
    res.status(500).json({ message: 'Error al exportar inventario', error: error.message });
  }
};

/* ============================== VENTAS POR ÍTEM ============================== */
exports.exportSalesByItem = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const clinicObjId = new mongoose.Types.ObjectId(req.clinicId);
    const match = { clinic: clinicObjId, status: 'completada' };
    const range = buildDateRange(req);
    if (range) match.createdAt = range;

    const rows = await Sale.aggregate([
      { $match: match },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.product',
          name: { $first: '$items.productName' },
          code: { $first: '$items.productCode' },
          category: { $first: '$items.category' },
          quantity: { $sum: '$items.quantity' },
          revenue: { $sum: '$items.subtotal' },
          salesCount: { $sum: 1 },
        },
      },
      { $sort: { revenue: -1 } },
    ]);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Ventas por ítem');
    ws.columns = [
      { header: 'Código', key: 'code', width: 14 },
      { header: 'Producto / Servicio', key: 'name', width: 36 },
      { header: 'Categoría', key: 'category', width: 14 },
      { header: 'Cantidad vendida', key: 'qty', width: 16 },
      { header: 'Veces en ventas', key: 'count', width: 16 },
      { header: 'Total facturado', key: 'rev', width: 16 },
    ];
    rows.forEach((r) =>
      ws.addRow({
        code: r.code || '',
        name: r.name || '',
        category: r.category || '',
        qty: r.quantity,
        count: r.salesCount,
        rev: Number(r.revenue || 0),
      })
    );
    ws.getColumn('rev').numFmt = '"$"#,##0.00';
    styleHeader(ws);
    await sendWorkbook(res, wb, `ventas_por_item_${Date.now()}.xlsx`);
  } catch (error) {
    res.status(500).json({ message: 'Error al exportar reporte por ítem', error: error.message });
  }
};


