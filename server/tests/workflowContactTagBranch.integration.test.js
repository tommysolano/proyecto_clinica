/**
 * Envío masivo desde Excel → condición por ETIQUETA en la automatización.
 *
 * El caso real que motivó esto: un Excel con una columna AGENCIA (valores
 * PRINCIPAL / EXTENSION) y una automatización que debe mandar un mensaje u otro
 * según ese valor.
 *
 * La cadena tiene tres eslabones y los tres estaban rotos:
 *
 *  1. La columna acaba en `Contact.tags` (el usuario la mapea a "Etiquetas", o
 *     bien se auto-propone como sucursal y, al no coincidir con ninguna sede,
 *     el runner la guarda como etiqueta — ver contactImportRunner).
 *  2. La inscripción de una importación se crea con `patient: null` (un contacto
 *     del CRM no tiene ficha clínica). La condición miraba SOLO `patient.tags`,
 *     así que la lista estaba siempre vacía y ninguna rama se cumplía.
 *  3. Aunque llegara, la comparación era `Array.includes` de strings crudos:
 *     "PRINCIPAL" no casaba con "Principal" ni con "principal ".
 *
 * Aquí se prueba el recorrido REAL del motor sobre el grafo, con el contacto en
 * la base y sin paciente, que es exactamente lo que produce un envío masivo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const engine = require('../utils/workflowEngine');

const Clinic = require('../models/Clinic');
const Contact = require('../models/Contact');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// "Si la etiqueta es PRINCIPAL → mensaje A; si es EXTENSION → mensaje B; si no
// → mensaje C". Se usan add_tag como marcadores para saber por dónde salió.
const agencyWorkflow = (clinicId) => Workflow.create({
  clinic: clinicId,
  name: 'Ramificar por agencia',
  active: true,
  triggers: [{ type: 'contact_import', audience: 'all' }],
  nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'contact_import' }] } },
    {
      id: 'cond',
      type: 'condition',
      position: { x: 0, y: 130 },
      data: {
        branches: [
          { id: 'yes', name: 'Principal', match: 'all', conditions: [{ id: 'c1', field: 'tag', op: 'eq', value: 'PRINCIPAL' }] },
          { id: 'b2', name: 'Extension', match: 'all', conditions: [{ id: 'c2', field: 'tag', op: 'eq', value: 'EXTENSION' }] },
        ],
      },
    },
    { id: 'tp', type: 'add_tag', position: { x: -240, y: 260 }, data: { tag: 'fue-principal' } },
    { id: 'te', type: 'add_tag', position: { x: 0, y: 260 }, data: { tag: 'fue-extension' } },
    { id: 'to', type: 'add_tag', position: { x: 240, y: 260 }, data: { tag: 'fue-otras' } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'cond', sourceHandle: 'default' },
    { id: 'e1', source: 'cond', target: 'tp', sourceHandle: 'yes' },
    { id: 'e2', source: 'cond', target: 'te', sourceHandle: 'b2' },
    { id: 'e3', source: 'cond', target: 'to', sourceHandle: 'no' },
  ],
});

/**
 * Inscripción TAL Y COMO la crea la importación masiva: sin paciente, con el
 * teléfono y el contactId en el contexto (ver contactImportRunner).
 */
async function runImportEnrollment(wf, clinicId, contact) {
  const enr = await WorkflowEnrollment.create({
    clinic: clinicId,
    workflow: wf._id,
    patient: null,
    currentNodeId: 'cond',
    startNodeId: 'trigger',
    status: 'active',
    context: { phone: contact.phone, contactId: String(contact._id), eventType: 'contact_import' },
  });
  await engine.executeEnrollment(await WorkflowEnrollment.findById(enr._id));
  return WorkflowEnrollment.findById(enr._id);
}

// La rama por la que salió se lee del registro de la inscripción: el paso
// add_tag escribe en el PACIENTE y aquí no hay ninguno, así que el log es la
// fuente fiable.
const branchOf = (enr) => (enr.log || []).find((l) => l.type === 'condition')?.info || '';

test('la etiqueta que trae el Excel decide la rama, aunque el contacto no sea paciente', async () => {
  const clinic = await Clinic.create({ name: 'Sede única' });
  const wf = await agencyWorkflow(clinic._id);

  const principal = await Contact.create({
    clinic: clinic._id, phone: '593991110001', firstName: 'Ana', tags: ['PRINCIPAL'],
  });
  const extension = await Contact.create({
    clinic: clinic._id, phone: '593991110002', firstName: 'Luis', tags: ['EXTENSION'],
  });
  const ninguna = await Contact.create({
    clinic: clinic._id, phone: '593991110003', firstName: 'Sara', tags: ['OTRA-COSA'],
  });

  assert.match(branchOf(await runImportEnrollment(wf, clinic._id, principal)), /Rama Principal/);
  assert.match(branchOf(await runImportEnrollment(wf, clinic._id, extension)), /Rama Extension/);
  assert.match(branchOf(await runImportEnrollment(wf, clinic._id, ninguna)), /si no/i);
});

test('la etiqueta casa aunque el Excel y la condición no se escriban igual', async () => {
  const clinic = await Clinic.create({ name: 'Sede única' });
  const wf = await agencyWorkflow(clinic._id);

  // Minúsculas, espacios de sobra, acento y una errata: todas son PRINCIPAL /
  // EXTENSION para cualquier persona, y ahora también para el motor.
  const casos = [
    { tag: 'principal', rama: /Rama Principal/ },
    { tag: '  Principal ', rama: /Rama Principal/ },
    { tag: 'extensión', rama: /Rama Extension/ },
    { tag: 'EXTENCION', rama: /Rama Extension/ },
    // Y la contraparte: una etiqueta parecida pero DISTINTA no se cuela en la
    // primera rama (ver el contrato de sameTag en workflowEngine.test.js).
    { tag: 'PRINCIPAL 2', rama: /si no/i },
  ];
  for (const [i, caso] of casos.entries()) {
    // eslint-disable-next-line no-await-in-loop
    const contact = await Contact.create({
      clinic: clinic._id, phone: `59399122000${i}`, firstName: `C${i}`, tags: [caso.tag],
    });
    // eslint-disable-next-line no-await-in-loop
    const enr = await runImportEnrollment(wf, clinic._id, contact);
    assert.match(branchOf(enr), caso.rama, `etiqueta ${JSON.stringify(caso.tag)}`);
  }
});

test('el contacto se encuentra por TELÉFONO aunque el contexto no traiga contactId', async () => {
  // Inscripciones nacidas de un chat o una cita no guardan contactId; aun así
  // deben ver las etiquetas del contacto del CRM con ese número.
  const clinic = await Clinic.create({ name: 'Sede única' });
  const wf = await agencyWorkflow(clinic._id);
  const contact = await Contact.create({
    clinic: clinic._id, phone: '593991110009', firstName: 'Eva', tags: ['EXTENSION'],
  });

  const enr = await WorkflowEnrollment.create({
    clinic: clinic._id,
    workflow: wf._id,
    patient: null,
    currentNodeId: 'cond',
    startNodeId: 'trigger',
    status: 'active',
    context: { phone: contact.phone }, // sin contactId
  });
  await engine.executeEnrollment(await WorkflowEnrollment.findById(enr._id));
  assert.match(branchOf(await WorkflowEnrollment.findById(enr._id)), /Rama Extension/);
});
