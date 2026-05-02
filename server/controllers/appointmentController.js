const Appointment = require('../models/Appointment');
const Product = require('../models/Product');

const POPULATE_PATIENT = 'firstName lastName cedula phone whatsapp email birthDate age gender';
const POPULATE_DOCTOR = 'name specialty';
const POPULATE_CREATOR = 'name email';

// Convierte 'YYYY-MM-DD' (o ISO) a Date en zona local, fijando 12:00 para evitar
// que el cambio de zona horaria mueva el día al guardar/leer.
const parseLocalDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value;
  const str = String(value);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const [, y, mo, d] = m;
    return new Date(Number(y), Number(mo) - 1, Number(d), 12, 0, 0, 0);
  }
  return new Date(str);
};

// Valida 'HH:MM' (24h) y devuelve minutos desde medianoche, o null si inválido.
const toMinutes = (hhmm) => {
  if (typeof hhmm !== 'string') return null;
  const m = hhmm.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
};

exports.getAppointments = async (req, res) => {
  try {
    const { startDate, endDate, doctor, status, createdBy } = req.query;
    const query = { clinic: req.clinicId };

    if (startDate && endDate) {
      const start = parseLocalDate(startDate);
      const end = parseLocalDate(endDate);
      if (end) end.setHours(23, 59, 59, 999);
      query.date = { $gte: start, $lte: end };
    }
    if (doctor) query.doctor = doctor;
    if (status) query.status = status;
    if (createdBy) query.createdBy = createdBy;

    if (req.role === 'doctor') {
      query.doctor = req.user._id;
    }
    if (req.role === 'call_center') {
      // Call center solo ve las citas que él mismo creó
      query.createdBy = req.user._id;
    }

    const appointments = await Appointment.find(query)
      .populate('patient', POPULATE_PATIENT)
      .populate('doctor', POPULATE_DOCTOR)
      .populate('createdBy', POPULATE_CREATOR)
      .sort({ date: 1, startTime: 1 });

    res.json(appointments);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener citas', error: error.message });
  }
};

exports.getAppointment = async (req, res) => {
  try {
    const appointment = await Appointment.findOne({ _id: req.params.id, clinic: req.clinicId })
      .populate('patient', POPULATE_PATIENT + ' address')
      .populate('doctor', POPULATE_DOCTOR)
      .populate('createdBy', POPULATE_CREATOR)
      .populate('services.product', 'name code salePrice category');

    if (!appointment) return res.status(404).json({ message: 'Cita no encontrada' });
    res.json(appointment);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener cita' });
  }
};

const buildServicesSnapshot = async (clinicId, items) => {
  if (!Array.isArray(items) || items.length === 0) return [];
  const ids = items
    .map((s) => (typeof s === 'string' ? s : s.product))
    .filter(Boolean);
  if (ids.length === 0) return [];
  const products = await Product.find({ _id: { $in: ids }, clinic: clinicId }).select(
    'name salePrice'
  );
  const byId = new Map(products.map((p) => [String(p._id), p]));
  return ids
    .map((id) => byId.get(String(id)))
    .filter(Boolean)
    .map((p) => ({ product: p._id, name: p.name, price: p.salePrice }));
};

exports.createAppointment = async (req, res) => {
  try {
    const { doctor, date, startTime, endTime, patient, services } = req.body;

    // --- Validaciones de fecha y horario ---
    const localDate = parseLocalDate(date);
    if (!localDate || Number.isNaN(localDate.getTime())) {
      return res.status(400).json({ message: 'Fecha inválida' });
    }
    const startMin = toMinutes(startTime);
    const endMin = toMinutes(endTime);
    if (startMin === null || endMin === null) {
      return res
        .status(400)
        .json({ message: 'Horario inválido. Usa el formato HH:MM (24h).' });
    }
    if (endMin <= startMin) {
      return res
        .status(400)
        .json({ message: 'La hora de fin debe ser posterior a la hora de inicio.' });
    }

    const conflict = await Appointment.findOne({
      clinic: req.clinicId,
      doctor,
      date: localDate,
      status: { $nin: ['cancelada', 'no_asistio'] },
      $or: [{ startTime: { $lt: endTime }, endTime: { $gt: startTime } }],
    });

    if (conflict) {
      return res.status(400).json({ message: 'El doctor ya tiene una cita en ese horario' });
    }

    // ¿Es primera cita del paciente?
    const previousCount = await Appointment.countDocuments({
      clinic: req.clinicId,
      patient,
      status: { $nin: ['cancelada'] },
    });
    const isFirstVisit = previousCount === 0;

    const servicesSnapshot = await buildServicesSnapshot(req.clinicId, services);

    const appointment = await Appointment.create({
      ...req.body,
      date: localDate,
      services: servicesSnapshot,
      isFirstVisit,
      clinic: req.clinicId,
      createdBy: req.user._id,
      createdByRole: req.role || null,
    });

    const populated = await appointment
      .populate('patient', POPULATE_PATIENT)
      .then((doc) => doc.populate('doctor', POPULATE_DOCTOR))
      .then((doc) => doc.populate('createdBy', POPULATE_CREATOR));

    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear cita', error: error.message });
  }
};

exports.updateAppointment = async (req, res) => {
  try {
    const update = { ...req.body };
    // No permitir alterar isFirstVisit ni createdBy en updates
    delete update.isFirstVisit;
    delete update.createdBy;
    delete update.createdByRole;

    if (update.date !== undefined) {
      const localDate = parseLocalDate(update.date);
      if (!localDate || Number.isNaN(localDate.getTime())) {
        return res.status(400).json({ message: 'Fecha inválida' });
      }
      update.date = localDate;
    }

    if (update.startTime !== undefined || update.endTime !== undefined) {
      const startMin = toMinutes(update.startTime);
      const endMin = toMinutes(update.endTime);
      if (startMin === null || endMin === null) {
        return res
          .status(400)
          .json({ message: 'Horario inválido. Usa el formato HH:MM (24h).' });
      }
      if (endMin <= startMin) {
        return res
          .status(400)
          .json({ message: 'La hora de fin debe ser posterior a la hora de inicio.' });
      }
    }

    if (Array.isArray(update.services)) {
      update.services = await buildServicesSnapshot(req.clinicId, update.services);
    }

    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      update,
      { new: true, runValidators: true }
    )
      .populate('patient', POPULATE_PATIENT)
      .populate('doctor', POPULATE_DOCTOR)
      .populate('createdBy', POPULATE_CREATOR);

    if (!appointment) return res.status(404).json({ message: 'Cita no encontrada' });
    res.json(appointment);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar cita', error: error.message });
  }
};

exports.deleteAppointment = async (req, res) => {
  try {
    const appointment = await Appointment.findOneAndUpdate(
      { _id: req.params.id, clinic: req.clinicId },
      { status: 'cancelada' },
      { new: true }
    );
    if (!appointment) return res.status(404).json({ message: 'Cita no encontrada' });
    res.json({ message: 'Cita cancelada' });
  } catch (error) {
    res.status(500).json({ message: 'Error al cancelar cita' });
  }
};

exports.getTodayAppointments = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const query = {
      clinic: req.clinicId,
      date: { $gte: today, $lt: tomorrow },
    };

    if (req.role === 'doctor') {
      query.doctor = req.user._id;
    }
    if (req.role === 'call_center') {
      query.createdBy = req.user._id;
    }

    const appointments = await Appointment.find(query)
      .populate('patient', POPULATE_PATIENT)
      .populate('doctor', POPULATE_DOCTOR)
      .populate('createdBy', POPULATE_CREATOR)
      .sort({ startTime: 1 });

    res.json(appointments);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener citas del día' });
  }
};

/**
 * Genera un PDF imprimible de la cita.
 * Usa puppeteer (ya disponible en el proyecto para RIDE de facturas).
 */
exports.getAppointmentPdf = async (req, res) => {
  try {
    const appointment = await Appointment.findOne({ _id: req.params.id, clinic: req.clinicId })
      .populate('patient', POPULATE_PATIENT + ' address')
      .populate('doctor', POPULATE_DOCTOR)
      .populate('createdBy', POPULATE_CREATOR);

    if (!appointment) return res.status(404).json({ message: 'Cita no encontrada' });

    const Clinic = require('../models/Clinic');
    const clinic = await Clinic.findById(req.clinicId);

    const isoDate = appointment.date instanceof Date
      ? appointment.date.toISOString()
      : String(appointment.date || '');
    const dateMatch = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
    const fmtDate = dateMatch
      ? `${dateMatch[3]}/${dateMatch[2]}/${dateMatch[1]}`
      : new Date(appointment.date).toLocaleDateString('es-EC');
    const created = new Date(appointment.createdAt).toLocaleString('es-EC');
    const services = (appointment.services || [])
      .map(
        (s) =>
          `<tr><td style="padding:6px 8px;border:1px solid #e2e8f0">${s.name || '—'}</td>` +
          `<td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:right">$${Number(
            s.price || 0
          ).toFixed(2)}</td></tr>`
      )
      .join('');

    const statusLabels = {
      programada: 'Programada',
      confirmada: 'Confirmada',
      en_curso: 'En curso',
      completada: 'Completada',
      cancelada: 'Cancelada',
      no_asistio: 'No asistió',
    };

    const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<title>Cita ${appointment._id}</title>
<style>
  body { font-family: Arial, sans-serif; color: #1e293b; padding: 30px; }
  h1 { color: #047857; margin: 0 0 4px 0; }
  .header { border-bottom: 2px solid #10b981; padding-bottom: 12px; margin-bottom: 18px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
  .box { background: #f0fdf4; border-radius: 8px; padding: 10px 12px; }
  .label { font-size: 11px; color: #047857; text-transform: uppercase; font-weight: 600; }
  .val { font-size: 13px; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; font-size: 12px; }
  th { background: #ecfdf5; text-align: left; padding: 6px 8px; border: 1px solid #e2e8f0; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: #fef3c7; color: #92400e; }
  .footer { margin-top: 28px; font-size: 11px; color: #64748b; border-top: 1px dashed #cbd5e1; padding-top: 8px; }
</style>
</head>
<body>
  <div class="header">
    <h1>${clinic?.nombreComercial || clinic?.name || 'Clínica'}</h1>
    <div style="font-size:12px;color:#64748b">Comprobante de Cita Médica</div>
  </div>

  <div class="grid">
    <div class="box"><div class="label">Paciente</div><div class="val">${appointment.patient?.firstName || ''} ${appointment.patient?.lastName || ''}${
      appointment.isFirstVisit ? ' <span class="badge">PACIENTE NUEVO</span>' : ''
    }</div></div>
    <div class="box"><div class="label">Cédula</div><div class="val">${appointment.patient?.cedula || '—'}</div></div>
    <div class="box"><div class="label">Doctor</div><div class="val">Dr. ${appointment.doctor?.name || '—'} ${appointment.doctor?.specialty ? '— ' + appointment.doctor.specialty : ''}</div></div>
    <div class="box"><div class="label">Estado</div><div class="val">${statusLabels[appointment.status] || appointment.status}</div></div>
    <div class="box"><div class="label">Fecha</div><div class="val">${fmtDate}</div></div>
    <div class="box"><div class="label">Horario</div><div class="val">${appointment.startTime} — ${appointment.endTime}</div></div>
    <div class="box"><div class="label">Teléfono</div><div class="val">${appointment.patient?.phone || '—'}</div></div>
    <div class="box"><div class="label">Email</div><div class="val">${appointment.patient?.email || '—'}</div></div>
  </div>

  ${appointment.reason ? `<div class="box" style="margin-bottom:12px"><div class="label">Motivo</div><div class="val">${appointment.reason}</div></div>` : ''}

  ${services ? `<div class="label" style="margin-top:14px">Servicios</div><table><thead><tr><th>Servicio</th><th style="text-align:right">Precio</th></tr></thead><tbody>${services}</tbody></table>` : ''}

  ${appointment.diagnosis ? `<div class="box" style="margin-top:12px"><div class="label">Diagnóstico</div><div class="val">${appointment.diagnosis}</div></div>` : ''}
  ${appointment.treatment ? `<div class="box" style="margin-top:8px"><div class="label">Tratamiento</div><div class="val">${appointment.treatment}</div></div>` : ''}
  ${appointment.notes ? `<div class="box" style="margin-top:8px"><div class="label">Notas</div><div class="val">${appointment.notes}</div></div>` : ''}

  <div class="footer">
    Registrado por: ${appointment.createdBy?.name || '—'}${appointment.createdByRole ? ' (' + appointment.createdByRole + ')' : ''} &nbsp;|&nbsp; Creada: ${created}
  </div>
</body></html>`;

    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' },
    });
    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="cita_${appointment._id}.pdf"`
    );
    res.end(pdfBuffer);
  } catch (error) {
    console.error('Error generando PDF de cita:', error);
    res.status(500).json({ message: 'Error al generar PDF', error: error.message });
  }
};
