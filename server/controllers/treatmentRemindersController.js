const ExcelJS = require('exceljs');
const Treatment = require('../models/Treatment');
const messaging = require('../utils/messaging');
// Lógica compartida (misma que treatmentController y el job periódico); esta
// copia local no emitía el evento de dominio y el trigger no disparaba.
const { applyAbandonment } = require('../utils/treatmentAbandonment');

async function fetchByAlert(clinicId, alert) {
  let treatments = await Treatment.find({ clinic: clinicId }).populate([
    { path: 'patient', select: 'firstName lastName cedula phone email whatsapp' },
  ]);
  await applyAbandonment(treatments);
  if (alert === 'completed') {
    treatments = treatments.filter((t) => t.status === 'completado');
  } else if (alert === 'warning') {
    treatments = treatments.filter((t) => t.abandonAlert === 'warning');
  } else if (alert === 'abandoned') {
    treatments = treatments.filter((t) => t.abandonAlert === 'abandoned');
  }
  return treatments;
}

/**
 * GET /api/treatments/reminders.xlsx?alert=abandoned
 */
exports.exportRemindersExcel = async (req, res) => {
  try {
    const alert = req.query.alert || 'abandoned';
    const treatments = await fetchByAlert(req.clinicId, alert);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Recordatorios');
    ws.columns = [
      { header: 'Paciente', key: 'patient', width: 35 },
      { header: 'Cédula', key: 'cedula', width: 14 },
      { header: 'Teléfono', key: 'phone', width: 16 },
      { header: 'WhatsApp', key: 'whatsapp', width: 16 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Tratamiento', key: 'name', width: 30 },
      { header: 'Estado', key: 'status', width: 14 },
      { header: 'Días sin actividad', key: 'days', width: 18 },
      { header: 'Avance %', key: 'progress', width: 12 },
      { header: 'Inicio', key: 'startDate', width: 14 },
    ];
    treatments.forEach((t) => {
      const p = t.patient || {};
      ws.addRow({
        patient: `${p.firstName || ''} ${p.lastName || ''}`.trim(),
        cedula: p.cedula || '',
        phone: p.phone || '',
        whatsapp: p.whatsapp || p.phone || '',
        email: p.email || '',
        name: t.name,
        status: t.status,
        days: t.daysSinceLastActivity,
        progress: t.progress,
        startDate: t.startDate ? new Date(t.startDate).toLocaleDateString() : '',
      });
    });
    ws.getRow(1).font = { bold: true };

    const filename = `recordatorios-${alert}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (error) {
    res.status(500).json({ message: 'Error al exportar Excel', error: error.message });
  }
};

/**
 * POST /api/treatments/whatsapp-broadcast
 * Body: { alert?, treatmentIds?: [], message: string }
 */
exports.whatsappBroadcast = async (req, res) => {
  try {
    const { alert, treatmentIds, message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ message: 'El mensaje es obligatorio' });
    }
    let treatments;
    if (Array.isArray(treatmentIds) && treatmentIds.length) {
      treatments = await Treatment.find({
        _id: { $in: treatmentIds },
        clinic: req.clinicId,
      }).populate([{ path: 'patient', select: 'firstName lastName phone whatsapp' }]);
    } else {
      treatments = await fetchByAlert(req.clinicId, alert || 'abandoned');
    }

    const seen = new Set();
    const recipients = [];
    for (const t of treatments) {
      const p = t.patient;
      if (!p) continue;
      const phone = p.whatsapp || p.phone;
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      recipients.push({ phone, patient: p, treatment: t });
    }

    const results = [];
    for (const r of recipients) {
      const name = `${r.patient.firstName || ''} ${r.patient.lastName || ''}`.trim();
      const personalized = String(message)
        .replace(/\{\{\s*name\s*\}\}/gi, name)
        .replace(/\{\{\s*treatment\s*\}\}/gi, r.treatment.name || '');
      // eslint-disable-next-line no-await-in-loop
      const sendResult = await messaging.send({
        clinicId: req.clinicId,
        channel: 'whatsapp',
        to: r.phone,
        contactName: name,
        patient: r.patient,
        body: personalized,
      });
      results.push({
        to: r.phone,
        ok: !!sendResult.ok,
        skipped: !!sendResult.skipped,
        reason: sendResult.reason || '',
        deliveryStatus: sendResult.deliveryStatus || '',
        errorCode: sendResult.errorCode || '',
        errorMessage: sendResult.errorMessage || '',
      });
    }

    const sent = results.filter((r) => r.ok).length;
    const skipped = results.filter((r) => r.skipped).length;
    const failed = results.length - sent - skipped;
    return res.json({
      total: recipients.length,
      sent,
      failed,
      skipped,
      simulated: false,
      results,
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al enviar WhatsApp', error: error.message });
  }
};
