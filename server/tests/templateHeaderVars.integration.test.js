/**
 * Variables en la CABECERA de una plantilla (además del cuerpo):
 *  - buildMetaComponents numera la cabecera aparte del cuerpo y adjunta su ejemplo
 *    (Meta admite 1 variable en la cabecera de texto). El pie va literal (Meta no
 *    admite variables en el pie).
 *  - enrichTemplateHeader, al enviar, añade el PARÁMETRO de la cabecera (si falta,
 *    Meta responde #132000 "number of parameters does not match").
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ctrl = require('../controllers/messageTemplateController');
const messaging = require('../utils/messaging');
const MessageTemplate = require('../models/MessageTemplate');

test('buildMetaComponents: la cabecera de texto con variable se numera aparte y lleva su ejemplo', () => {
  const comps = ctrl.buildMetaComponents({
    headerType: 'text',
    headerText: 'Hola {{nombre}}',
    body: 'Tu cita es el {{fecha}} a las {{hora}}',
    footer: 'Clínica Shiluv',
    variables: [
      { key: 'nombre', example: 'María' },
      { key: 'fecha', example: 'lunes 20' },
      { key: 'hora', example: '14:30' },
    ],
    buttons: [],
  });

  const header = comps.find((c) => c.type === 'HEADER');
  assert.equal(header.format, 'TEXT');
  assert.equal(header.text, 'Hola {{1}}', 'la cabecera numera su propia variable desde 1');
  assert.deepEqual(header.example, { header_text: ['María'] });

  const body = comps.find((c) => c.type === 'BODY');
  assert.equal(body.text, 'Tu cita es el {{1}} a las {{2}}', 'el cuerpo numera aparte, desde 1');
  assert.deepEqual(body.example, { body_text: [['lunes 20', '14:30']] });

  const footer = comps.find((c) => c.type === 'FOOTER');
  assert.equal(footer.text, 'Clínica Shiluv', 'el pie va literal');
});

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('enrichTemplateHeader: al enviar, la variable de la cabecera se rellena con el paciente', async () => {
  const { clinicId } = await H.seedClinic();
  await MessageTemplate.create({
    clinic: clinicId,
    channel: 'whatsapp',
    name: 'saludo_cabecera',
    headerType: 'text',
    headerText: 'Hola {{nombre}}',
    body: 'Gracias por tu interés, {{nombre}}.',
    footer: 'Clínica Shiluv',
    variables: [{ key: 'nombre', example: 'María' }],
  });

  const info = await messaging.enrichTemplateHeader(
    clinicId,
    { name: 'saludo_cabecera', language: 'es', components: [] },
    { firstName: 'Emily' }, // paciente
    null,
    null
  );

  const header = info.components.find((c) => c.type === 'header');
  assert.ok(header, 'se añadió el componente header con su parámetro (si falta → #132000)');
  assert.deepEqual(header.parameters, [{ type: 'text', text: 'Emily' }], 'la cabecera se rellena con el nombre real');

  const body = info.components.find((c) => c.type === 'body');
  assert.deepEqual(body.parameters, [{ type: 'text', text: 'Emily' }]);
  // El header va PRIMERO (unshift): Meta espera el orden header→body.
  assert.equal(info.components[0].type, 'header');
});

test('enrichTemplateHeader: cabecera de texto SIN variable no añade parámetros de header', async () => {
  const { clinicId } = await H.seedClinic();
  await MessageTemplate.create({
    clinic: clinicId, channel: 'whatsapp', name: 'saludo_fijo',
    headerType: 'text', headerText: 'Bienvenido', body: 'Hola {{nombre}}',
    variables: [{ key: 'nombre', example: 'María' }],
  });

  const info = await messaging.enrichTemplateHeader(
    clinicId, { name: 'saludo_fijo', language: 'es', components: [] }, { firstName: 'Emily' }, null, null
  );
  assert.equal(info.components.some((c) => c.type === 'header'), false, 'cabecera fija = sin parámetro de header');
});
