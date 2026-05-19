const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const Product = require('../models/Product');
const Treatment = require('../models/Treatment');
const { emitToClinic } = require('../realtime');

/**
 * Obtiene la ficha clínica de un paciente. Si no existe la crea con datos
 * básicos copiados del paciente.
 */
exports.getOrCreateByPatient = async (req, res) => {
  try {
    const { patientId } = req.params;
    const patient = await Patient.findById(patientId);
    if (!patient) return res.status(404).json({ message: 'Paciente no encontrado' });

    let record = await ClinicalRecord.findOne({
      clinic: req.clinicId,
      patient: patientId,
    })
      .populate('followUps.createdBy', 'name')
      .populate('createdBy', 'name')
      .populate('updatedBy', 'name');

    if (!record) {
      // Edad calculada
      let edad;
      if (patient.birthDate) {
        const diff = Date.now() - new Date(patient.birthDate).getTime();
        edad = Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
      }
      record = await ClinicalRecord.create({
        clinic: req.clinicId,
        patient: patient._id,
        fecha: new Date(),
        nombre: `${patient.firstName} ${patient.lastName}`.trim(),
        direccion: patient.address || '',
        edad: edad ?? 0,
        cedula: patient.cedula,
        celular: patient.phone || '',
        tomaMedicamentos: { value: false, detail: '' },
        tieneAlergias: { value: false, detail: '' },
        tieneCirugias: { value: false, detail: '' },
        followUps: [],
        createdBy: req.user._id,
      });
    }

    res.json(record);
  } catch (error) {
    res
      .status(500)
      .json({ message: 'Error al obtener ficha clínica', error: error.message });
  }
};

exports.updateByPatient = async (req, res) => {
  try {
    const { patientId } = req.params;
    const patient = await Patient.findById(patientId);
    if (!patient) return res.status(404).json({ message: 'Paciente no encontrado' });

    const allowed = [
      'fecha',
      'nombre',
      'direccion',
      'edad',
      'cedula',
      'celular',
      'tomaMedicamentos',
      'tieneAlergias',
      'tieneCirugias',
    ];
    const update = { updatedBy: req.user._id };
    for (const k of allowed) {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    }

    const record = await ClinicalRecord.findOneAndUpdate(
      { clinic: req.clinicId, patient: patientId },
      { $set: update, $setOnInsert: { createdBy: req.user._id } },
      { new: true, upsert: true, runValidators: true }
    );

    res.json(record);
  } catch (error) {
    res
      .status(500)
      .json({ message: 'Error al actualizar ficha clínica', error: error.message });
  }
};

exports.addFollowUp = async (req, res) => {
  try {
    const { patientId } = req.params;
    const {
      fecha,
      descripcion,
      valor,
      metodoPago,
      recomendaciones,
      estudioSintomas,
      receta,            // texto libre legacy (opcional)
      recetaItems,       // array estructurado de items (medicamentos/servicios) desde inventario
      observaciones,     // reemplaza el antiguo "tratamiento asociado"
      treatment,         // legacy: id de tratamiento manual (sigue soportado)
    } = req.body;

    if (!descripcion && !req.body.motivoConsulta) {
      return res.status(400).json({ message: 'El motivo de consulta es requerido' });
    }

    // --- Hidratar recetaItems con snapshot de nombre/categoría y marcar servicios ---
    const items = Array.isArray(recetaItems) ? recetaItems : [];
    const productIds = items.map((it) => it.product).filter(Boolean);
    let productsById = {};
    if (productIds.length) {
      const prods = await Product.find({ _id: { $in: productIds }, clinic: req.clinicId });
      productsById = prods.reduce((acc, p) => {
        acc[String(p._id)] = p;
        return acc;
      }, {});
    }
    const hydratedItems = items.map((it) => {
      const p = it.product ? productsById[String(it.product)] : null;
      const isService = p && ['servicio', 'programa'].includes(p.category);
      return {
        product: it.product || undefined,
        name: it.name || p?.name || '',
        quantity: Number(it.quantity || 1),
        dose: it.dose || '',
        frequency: it.frequency || '',
        duration: it.duration || '',
        instructions: it.instructions || '',
        isService: Boolean(isService),
      };
    });

    // --- Crear automáticamente un Tratamiento si la receta tiene items de tipo servicio/programa ---
    let autoTreatmentId = treatment || null;
    const serviceItems = hydratedItems.filter((it) => it.isService && it.product);
    if (!autoTreatmentId && serviceItems.length > 0) {
      try {
        const newT = await Treatment.create({
          clinic: req.clinicId,
          patient: patientId,
          name: `Tratamiento desde receta — ${new Date().toLocaleDateString('es-EC')}`,
          status: 'activo',
          items: serviceItems.map((it) => ({
            product: it.product,
            name: it.name,
            quantity: it.quantity,
            completed: 0,
            completionRefs: [],
          })),
          createdBy: req.user._id,
          lastActivityAt: new Date(),
        });
        autoTreatmentId = newT._id;
        emitToClinic(req.clinicId, 'treatment:created', newT);
      } catch (e) {
        console.warn('No se pudo crear tratamiento automático:', e.message);
      }
    }

    const record = await ClinicalRecord.findOneAndUpdate(
      { clinic: req.clinicId, patient: patientId },
      {
        $push: {
          followUps: {
            fecha: fecha ? new Date(fecha) : new Date(),
            descripcion: descripcion || req.body.motivoConsulta || '',
            motivoConsulta: req.body.motivoConsulta || descripcion || '',
            recomendaciones: recomendaciones || estudioSintomas || '',
            estudioSintomas: estudioSintomas || recomendaciones || '',
            receta: receta || '',
            recetaItems: hydratedItems,
            observaciones: observaciones || '',
            treatment: autoTreatmentId,
            autoTreatmentCreated: autoTreatmentId && !treatment ? autoTreatmentId : undefined,
            valor: valor || 0,
            metodoPago: metodoPago || 'efectivo',
            createdBy: req.user._id,
          },
        },
        $setOnInsert: { createdBy: req.user._id },
      },
      { new: true, upsert: false }
    );

    if (!record) {
      return res
        .status(404)
        .json({ message: 'Primero debe crear la ficha clínica del paciente' });
    }

    // Si esta consulta nació de una cita 'asistida' del doctor actual, se completa.
    if (req.body.appointmentId) {
      try {
        const Appointment = require('../models/Appointment');
        const apt = await Appointment.findOne({
          _id: req.body.appointmentId,
          clinic: req.clinicId,
        });
        if (apt && ['asistida', 'pendiente', 'confirmada'].includes(apt.status)) {
          apt.status = 'completada';
          apt.consultationEndedAt = new Date();
          await apt.save();
          emitToClinic(req.clinicId, 'appointment:updated', apt);
        }
      } catch (e) {
        console.warn('No se pudo cerrar la cita asociada:', e.message);
      }
    }

    emitToClinic(req.clinicId, 'clinicalRecord:updated', { patient: patientId });
    res.status(201).json(record);
  } catch (error) {
    res.status(500).json({ message: 'Error al agregar seguimiento', error: error.message });
  }
};

exports.deleteFollowUp = async (req, res) => {
  try {
    const { patientId, followUpId } = req.params;

    const record = await ClinicalRecord.findOneAndUpdate(
      { clinic: req.clinicId, patient: patientId },
      { $pull: { followUps: { _id: followUpId } } },
      { new: true }
    );

    if (!record) return res.status(404).json({ message: 'Ficha no encontrada' });
    emitToClinic(req.clinicId, 'clinicalRecord:updated', { patient: patientId });
    res.json(record);
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar seguimiento' });
  }
};

/**
 * Genera un PDF imprimible del seguimiento (receta, estudio/síntomas, observaciones,
 * tratamiento asociado) listo para entregar al paciente.
 */
exports.printFollowUp = async (req, res) => {
  try {
    const { patientId, followUpId } = req.params;
    const record = await ClinicalRecord.findOne({
      clinic: req.clinicId,
      patient: patientId,
    }).populate('followUps.createdBy', 'name specialty');
    if (!record) return res.status(404).json({ message: 'Ficha no encontrada' });

    const fu = record.followUps.id(followUpId);
    if (!fu) return res.status(404).json({ message: 'Seguimiento no encontrado' });

    const patient = await Patient.findById(patientId);
    const Clinic = require('../models/Clinic');
    const clinic = await Clinic.findById(req.clinicId);

    const fmtDate = new Date(fu.fecha).toLocaleDateString('es-EC');
    const items = (fu.recetaItems || [])
      .map(
        (it) => `
        <tr>
          <td style="padding:6px 8px;border:1px solid #e2e8f0">${it.name || '—'}</td>
          <td style="padding:6px 8px;border:1px solid #e2e8f0;text-align:center">${it.quantity || 1}</td>
          <td style="padding:6px 8px;border:1px solid #e2e8f0">${it.dose || '—'}</td>
          <td style="padding:6px 8px;border:1px solid #e2e8f0">${it.frequency || '—'}</td>
          <td style="padding:6px 8px;border:1px solid #e2e8f0">${it.duration || '—'}</td>
          <td style="padding:6px 8px;border:1px solid #e2e8f0">${it.instructions || '—'}</td>
        </tr>`
      )
      .join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<style>
  body{font-family:Arial,sans-serif;color:#1e293b;padding:30px;}
  h1{color:#047857;margin:0 0 4px 0;}
  .header{border-bottom:2px solid #10b981;padding-bottom:12px;margin-bottom:18px;}
  .box{background:#f0fdf4;border-radius:8px;padding:10px 12px;margin-bottom:12px;}
  .label{font-size:11px;color:#047857;text-transform:uppercase;font-weight:600;margin-bottom:3px;}
  table{width:100%;border-collapse:collapse;font-size:12px;}
  th{background:#ecfdf5;text-align:left;padding:6px 8px;border:1px solid #e2e8f0;}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;}
  .footer{margin-top:30px;font-size:11px;color:#64748b;border-top:1px dashed #cbd5e1;padding-top:8px;}
  .sign{margin-top:60px;border-top:1px solid #94a3b8;width:280px;padding-top:6px;text-align:center;font-size:11px;}
</style></head><body>
  <div class="header">
    <h1>${clinic?.nombreComercial || clinic?.name || 'Clínica'}</h1>
    <div style="font-size:12px;color:#64748b">${clinic?.direccion || ''} · ${clinic?.telefono || ''}</div>
    <div style="margin-top:6px;font-size:13px;font-weight:600">Receta médica / Indicaciones</div>
  </div>

  <div class="grid">
    <div class="box"><div class="label">Paciente</div><div>${patient?.firstName || ''} ${patient?.lastName || ''}</div></div>
    <div class="box"><div class="label">Cédula</div><div>${patient?.cedula || '—'}</div></div>
    <div class="box"><div class="label">Edad</div><div>${record.edad || '—'}</div></div>
    <div class="box"><div class="label">Fecha</div><div>${fmtDate}</div></div>
  </div>

  ${fu.descripcion ? `<div class="box"><div class="label">Motivo de consulta</div><div>${fu.descripcion}</div></div>` : ''}

  ${(fu.estudioSintomas || fu.recomendaciones) ? `<div class="box"><div class="label">Estudio o síntomas</div><div>${fu.estudioSintomas || fu.recomendaciones}</div></div>` : ''}

  ${items ? `<div class="label" style="margin-top:8px">Receta</div>
    <table><thead><tr>
      <th>Medicamento / Servicio</th>
      <th style="text-align:center">Cant.</th>
      <th>Dosis</th>
      <th>Frecuencia</th>
      <th>Duración</th>
      <th>Indicaciones</th>
    </tr></thead><tbody>${items}</tbody></table>` : ''}

  ${fu.receta ? `<div class="box" style="margin-top:10px"><div class="label">Receta (notas adicionales)</div><div style="white-space:pre-wrap">${fu.receta}</div></div>` : ''}

  ${fu.observaciones ? `<div class="box"><div class="label">Observaciones</div><div style="white-space:pre-wrap">${fu.observaciones}</div></div>` : ''}

  <div class="sign">${fu.createdBy?.name ? `Dr. ${fu.createdBy.name}` : ''}<br/><span style="color:#94a3b8">Médico tratante</span></div>

  <div class="footer">Documento generado el ${new Date().toLocaleString('es-EC')}</div>
</body></html>`;

    const puppeteer = require('puppeteer');
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' },
    });
    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="receta_${followUpId}.pdf"`);
    res.end(pdf);
  } catch (error) {
    console.error('Error generando PDF de seguimiento:', error);
    res.status(500).json({ message: 'Error al generar PDF', error: error.message });
  }
};
