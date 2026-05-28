const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const Product = require('../models/Product');
const Treatment = require('../models/Treatment');
const { emitToClinic } = require('../realtime');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

// --- Almacenamiento en disco para adjuntos de seguimientos (PDFs) ---
const FOLLOWUPS_DIR = path.join(__dirname, '..', 'storage', 'followups');
try {
  fs.mkdirSync(FOLLOWUPS_DIR, { recursive: true });
} catch (_) {}

const followupStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(FOLLOWUPS_DIR, String(req.clinicId || 'default'));
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ts = Date.now();
    const rand = crypto.randomBytes(6).toString('hex');
    const ext = path.extname(file.originalname || '') || '.pdf';
    cb(null, `${ts}-${rand}${ext}`);
  },
});

exports.uploadAttachmentMiddleware = multer({
  storage: followupStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const okTypes = ['application/pdf'];
    if (okTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Solo se aceptan archivos PDF'));
  },
}).single('file');

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
      vitalSigns,        // signos vitales (opcional)
      opticaRx,          // datos ópticos (rol optica): { od:{...}, oi:{...} }
    } = req.body;

    if (!descripcion && !req.body.motivoConsulta) {
      return res.status(400).json({ message: 'El motivo de consulta es requerido' });
    }

    // Validación: la receta es obligatoria para guardar el seguimiento.
    const itemsRaw = Array.isArray(recetaItems) ? recetaItems : [];
    const hasReceta =
      itemsRaw.some((it) => (it.product || (it.name && it.name.trim()))) ||
      (typeof receta === 'string' && receta.trim().length > 0);
    if (!hasReceta) {
      return res
        .status(400)
        .json({ message: 'Debe registrar al menos un ítem en la receta antes de guardar el seguimiento' });
    }

    // --- Hidratar recetaItems con snapshot de nombre/categoría y marcar servicios ---
    const items = itemsRaw;
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
      const isComposite = Boolean(p?.isComposite);
      // Componentes elegidos por el doctor para un item compuesto.
      let componentsUsed = [];
      if (isComposite && Array.isArray(it.componentsUsed)) {
        const allowed = new Set((p.components || []).map((c) => String(c.product)));
        componentsUsed = it.componentsUsed
          .filter((c) => c.product && allowed.has(String(c.product)) && Number(c.quantity) > 0)
          .map((c) => ({ product: c.product, name: c.name || '', quantity: Number(c.quantity) }));
      }
      return {
        product: it.product || undefined,
        name: it.name || p?.name || '',
        quantity: Number(it.quantity || 1),
        dose: it.dose || '',
        frequency: it.frequency || '',
        duration: it.duration || '',
        instructions: it.instructions || '',
        isService: Boolean(isService),
        isComposite,
        componentsUsed,
      };
    });

    // Descontar del inventario los componentes de los items compuestos recetados.
    try {
      const InventoryMovement = require('../models/InventoryMovement');
      for (const it of hydratedItems) {
        if (!it.isComposite || !it.componentsUsed.length) continue;
        for (const comp of it.componentsUsed) {
          const compProduct = await Product.findOne({ _id: comp.product, clinic: req.clinicId });
          if (!compProduct || compProduct.unlimited) continue;
          const qty = comp.quantity * Number(it.quantity || 1);
          compProduct.stock = Math.max(0, (compProduct.stock || 0) - qty);
          await compProduct.save();
          await InventoryMovement.create({
            clinic: req.clinicId,
            product: comp.product,
            type: 'salida',
            quantity: qty,
            balanceAfter: compProduct.stock,
            reason: `Componente de ${it.name} (receta)`,
            createdBy: req.user._id,
          });
        }
      }
    } catch (e) {
      console.warn('No se pudo descontar componentes del inventario:', e.message);
    }

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
            vitalSigns: vitalSigns && typeof vitalSigns === 'object' ? {
              temperature: vitalSigns.temperature ?? null,
              bloodPressure: vitalSigns.bloodPressure || '',
              heartRate: vitalSigns.heartRate ?? null,
              respiratoryRate: vitalSigns.respiratoryRate ?? null,
              oxygenSaturation: vitalSigns.oxygenSaturation ?? null,
              weight: vitalSigns.weight ?? null,
              height: vitalSigns.height ?? null,
              glucose: vitalSigns.glucose ?? null,
            } : undefined,
            treatment: autoTreatmentId,
            autoTreatmentCreated: autoTreatmentId && !treatment ? autoTreatmentId : undefined,
            opticaRx: opticaRx && typeof opticaRx === 'object' ? opticaRx : undefined,
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
 * Sube un adjunto PDF a un seguimiento específico.
 * Espera multipart/form-data con campo "file" (single).
 */
exports.uploadFollowUpAttachment = async (req, res) => {
  try {
    const { patientId, followUpId } = req.params;
    if (!req.file) return res.status(400).json({ message: 'No se recibió archivo' });

    const record = await ClinicalRecord.findOne({
      clinic: req.clinicId,
      patient: patientId,
    });
    if (!record) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(404).json({ message: 'Ficha clínica no encontrada' });
    }
    const fu = record.followUps.id(followUpId);
    if (!fu) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(404).json({ message: 'Seguimiento no encontrado' });
    }

    const attachment = {
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadedAt: new Date(),
      uploadedBy: req.user._id,
    };
    fu.attachments.push(attachment);
    await record.save();

    const saved = fu.attachments[fu.attachments.length - 1];
    res.status(201).json({ message: 'Archivo subido', attachment: saved });
  } catch (error) {
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    res.status(500).json({ message: 'Error al subir archivo', error: error.message });
  }
};

/**
 * Descarga un adjunto PDF de un seguimiento.
 */
exports.downloadFollowUpAttachment = async (req, res) => {
  try {
    const { patientId, followUpId, attachmentId } = req.params;
    const record = await ClinicalRecord.findOne({
      clinic: req.clinicId,
      patient: patientId,
    });
    if (!record) return res.status(404).json({ message: 'Ficha no encontrada' });
    const fu = record.followUps.id(followUpId);
    if (!fu) return res.status(404).json({ message: 'Seguimiento no encontrado' });
    const att = fu.attachments.id(attachmentId);
    if (!att) return res.status(404).json({ message: 'Archivo no encontrado' });

    const filePath = path.join(FOLLOWUPS_DIR, String(req.clinicId), att.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: 'Archivo no existe en disco' });
    }
    res.setHeader('Content-Type', att.mimeType || 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(att.originalName)}"`
    );
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    res.status(500).json({ message: 'Error al descargar archivo', error: error.message });
  }
};

/**
 * Elimina un adjunto PDF de un seguimiento.
 */
exports.deleteFollowUpAttachment = async (req, res) => {
  try {
    const { patientId, followUpId, attachmentId } = req.params;
    const record = await ClinicalRecord.findOne({
      clinic: req.clinicId,
      patient: patientId,
    });
    if (!record) return res.status(404).json({ message: 'Ficha no encontrada' });
    const fu = record.followUps.id(followUpId);
    if (!fu) return res.status(404).json({ message: 'Seguimiento no encontrado' });
    const att = fu.attachments.id(attachmentId);
    if (!att) return res.status(404).json({ message: 'Archivo no encontrado' });

    const filePath = path.join(FOLLOWUPS_DIR, String(req.clinicId), att.filename);
    try { fs.unlinkSync(filePath); } catch (_) {}
    att.deleteOne();
    await record.save();
    res.json({ message: 'Archivo eliminado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar archivo', error: error.message });
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
    }).populate('followUps.createdBy', 'name specialty signatureImage');
    if (!record) return res.status(404).json({ message: 'Ficha no encontrada' });

    const fu = record.followUps.id(followUpId);
    if (!fu) return res.status(404).json({ message: 'Seguimiento no encontrado' });

    const patient = await Patient.findById(patientId);
    const Clinic = require('../models/Clinic');
    const clinic = await Clinic.findById(req.clinicId);
    const doctorSignature = fu.createdBy?.signatureImage || '';
    const doctorName = fu.createdBy?.name || '';
    const doctorSpecialty = fu.createdBy?.specialty || '';

    // Fecha en formato dd/mm/aaaa para Ecuador
    const fmtDate = (() => {
      const d = new Date(fu.fecha);
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yyyy = d.getFullYear();
      return `${dd}/${mm}/${yyyy}`;
    })();
    // Signos vitales
    const vs = fu.vitalSigns || {};
    const vitalsParts = [];
    if (vs.bloodPressure) vitalsParts.push(`TA: ${vs.bloodPressure}`);
    if (vs.heartRate) vitalsParts.push(`FC: ${vs.heartRate} lpm`);
    if (vs.respiratoryRate) vitalsParts.push(`FR: ${vs.respiratoryRate} rpm`);
    if (vs.temperature != null) vitalsParts.push(`T°: ${vs.temperature}°C`);
    if (vs.oxygenSaturation) vitalsParts.push(`SatO₂: ${vs.oxygenSaturation}%`);
    if (vs.weight) vitalsParts.push(`Peso: ${vs.weight} kg`);
    if (vs.height) vitalsParts.push(`Talla: ${vs.height} cm`);
    if (vs.glucose) vitalsParts.push(`Glucosa: ${vs.glucose} mg/dL`);
    const vitalsHtml = vitalsParts.length
      ? `<div class="box"><div class="label">Signos vitales</div><div>${vitalsParts.join(' &nbsp;·&nbsp; ')}</div></div>`
      : '';
    // Receta óptica
    const rxOd = fu.opticaRx?.od || {};
    const rxOi = fu.opticaRx?.oi || {};
    const hasOptica = ['sph','cyl','ax','add','dnp','alt'].some((c) => (rxOd[c] || rxOi[c]));
    const opticaHtml = hasOptica ? `
      <div class="label" style="margin-top:8px">Receta óptica (RX)</div>
      <table>
        <thead><tr><th>RX</th><th>SPH</th><th>CYL</th><th>AX</th><th>ADD</th><th>DNP</th><th>ALT</th></tr></thead>
        <tbody>
          <tr><td style="padding:6px 8px;border:1px solid #e2e8f0"><b>OD</b></td>
            ${['sph','cyl','ax','add','dnp','alt'].map((c) => `<td style="padding:6px 8px;border:1px solid #e2e8f0">${rxOd[c] || '—'}</td>`).join('')}
          </tr>
          <tr><td style="padding:6px 8px;border:1px solid #e2e8f0"><b>OI</b></td>
            ${['sph','cyl','ax','add','dnp','alt'].map((c) => `<td style="padding:6px 8px;border:1px solid #e2e8f0">${rxOi[c] || '—'}</td>`).join('')}
          </tr>
        </tbody>
      </table>` : '';
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

  ${vitalsHtml}
  ${opticaHtml}

  <div class="sign">
    ${doctorSignature ? `<img src="${doctorSignature}" alt="Firma" style="max-height:60px;display:block;margin:0 auto 4px;" />` : ''}
    ${doctorName ? `Dr. ${doctorName}` : ''}
    <br/><span style="color:#94a3b8">${doctorSpecialty || 'Médico tratante'}</span>
  </div>

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
