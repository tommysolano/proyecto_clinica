/**
 * ANALÍTICAS DEL EMBUDO: «las gráficas no cuadran con las oportunidades».
 *
 * La página se armaba en el navegador con dos listados PAGINADOS —`GET /chats`
 * (tope 300) y `GET /chats/opportunities/all` (tope 500)— y encima medía las
 * citas del calendario en vez de la etapa de la oportunidad. Salían tres cosas
 * mal a la vez:
 *
 *  1. «Chats» se quedaba clavado en 300 pasara lo que pasara, y además contaba
 *     chats de fuera del rango (la lista no lo filtraba).
 *  2. Las oportunidades sin fecha de creación se colaban en CUALQUIER rango: el
 *     filtro del navegador solo comparaba si la fecha existía.
 *  3. "Agendado" salía de la agenda de citas, no de la etapa de la oportunidad.
 *
 * Ahora cuenta la base (GET /chats/opportunities/analytics), con la misma regla
 * de aplanado que el resto del sistema (utils/opportunities.AGG_FLATTEN).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const H = require('./_integrationHelpers');
const chat = require('../controllers/chatController');

const Clinic = require('../models/Clinic');
const Conversation = require('../models/Conversation');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hace = (dias) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - dias); return d; };

const pedir = (clinicId, query) => H.runController(
  chat.opportunityAnalytics,
  H.mockReq(clinicId, new mongoose.Types.ObjectId(), {}, { role: 'admin', query })
);

const rango = { from: iso(hace(30)), to: iso(hace(0)) };

test('cuenta UNA POR OPORTUNIDAD y no duplica la principal con su espejo legacy', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  // Chat moderno: tres oportunidades en el array + el espejo de la última.
  await Conversation.create({
    clinic: clinic._id,
    phone: '593900000001',
    opportunities: [
      { isOpportunity: true, stage: 'nuevo', createdAt: hace(5), expectedValue: 100 },
      { isOpportunity: true, stage: 'agendado', createdAt: hace(4), expectedValue: 200 },
      { isOpportunity: true, stage: 'ganado', createdAt: hace(3), expectedValue: 300 },
    ],
    opportunity: { isOpportunity: true, stage: 'ganado', createdAt: hace(3), expectedValue: 300 },
  });
  // Chat antiguo: solo el espejo legacy, sin array.
  await Conversation.create({
    clinic: clinic._id,
    phone: '593900000002',
    opportunity: { isOpportunity: true, stage: 'interesado', createdAt: hace(2), expectedValue: 50 },
  });

  const { payload } = await pedir(clinic._id, rango);
  assert.equal(payload.totals.oportunidades, 4); // 3 del array + 1 del espejo huérfano
  const etapa = Object.fromEntries(payload.embudo.map((e) => [e.stage, e.count]));
  assert.equal(etapa.ganado, 1); // NO 2: el espejo de la principal no se suma aparte
  assert.equal(etapa.agendado, 1);
  assert.equal(etapa.interesado, 1);
  // El embudo trae SIEMPRE las seis etapas (las vacías a cero) para que la
  // gráfica no cambie de forma según lo que haya en el rango.
  assert.equal(payload.embudo.length, 6);
  assert.equal(payload.totals.valorTotal, 650);
  assert.equal(payload.totals.valorGanado, 300);
});

test('el rango deja fuera lo viejo, y lo que no tiene fecha cae en la del chat', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  await Conversation.create({
    clinic: clinic._id, phone: '593900000003', createdAt: hace(2),
    opportunities: [{ isOpportunity: true, stage: 'nuevo', createdAt: hace(2) }],
  });
  await Conversation.create({
    clinic: clinic._id, phone: '593900000004', createdAt: hace(200),
    opportunities: [{ isOpportunity: true, stage: 'nuevo', createdAt: hace(200) }],
  });
  // Sin `createdAt` en la oportunidad: antes se colaba en CUALQUIER rango; ahora
  // se le aplica la fecha del chat, que aquí es vieja → queda fuera.
  await Conversation.collection.insertOne({
    clinic: clinic._id,
    phone: '593900000005',
    createdAt: hace(200),
    opportunities: [{ isOpportunity: true, stage: 'nuevo' }],
  });

  const { payload } = await pedir(clinic._id, rango);
  assert.equal(payload.totals.oportunidades, 1);
});

test('agendadas y ganadas se sitúan el día en que ENTRARON en la etapa', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  await Conversation.create({
    clinic: clinic._id,
    phone: '593900000006',
    opportunities: [{
      isOpportunity: true,
      stage: 'agendado',
      createdAt: hace(20),      // el lead entró hace 20 días…
      stageChangedAt: hace(3),  // …pero se agendó hace 3
    }],
  });

  const { payload } = await pedir(clinic._id, rango);
  const dia = (d) => payload.serie.find((s) => s.date === iso(hace(d))) || {};
  assert.equal(dia(20).creadas, 1);
  assert.equal(dia(20).agendadas, 0);   // no se agendó el día del alta
  assert.equal(dia(3).agendadas, 1);
  // La serie cubre TODO el rango, con los días sin actividad a cero: la línea no
  // salta huecos.
  assert.equal(payload.serie.length, 31);
});

test('los chats son los del rango, sin tope de página', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const docs = [];
  for (let i = 0; i < 320; i++) {
    docs.push({ clinic: clinic._id, phone: `59390001${String(i).padStart(4, '0')}`, createdAt: hace(1) });
  }
  docs.push({ clinic: clinic._id, phone: '593999999999', createdAt: hace(120) }); // fuera del rango
  await Conversation.insertMany(docs);

  const { payload } = await pedir(clinic._id, rango);
  assert.equal(payload.totals.chats, 320); // ni 300 (el tope viejo) ni 321
  assert.equal(payload.serie.find((s) => s.date === iso(hace(1))).chats, 320);
});

test('tasas, canal, agente y servicios salen de la etapa de la oportunidad', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  await Conversation.create({
    clinic: clinic._id, phone: '593900000007', channel: 'instagram', assignedToName: 'Lucía',
    opportunities: [
      { isOpportunity: true, stage: 'agendado', createdAt: hace(5), expectedValue: 100, interestedIn: [{ name: 'Botox' }] },
      { isOpportunity: true, stage: 'ganado', createdAt: hace(4), expectedValue: 400, interestedIn: [{ name: 'Botox' }] },
    ],
  });
  await Conversation.create({
    clinic: clinic._id, phone: '593900000008', channel: 'whatsapp',
    opportunities: [
      { isOpportunity: true, stage: 'perdido', createdAt: hace(3), lostReason: 'Precio' },
      { isOpportunity: true, stage: 'nuevo', createdAt: hace(2) },
    ],
  });

  const { payload } = await pedir(clinic._id, rango);
  // Agendamiento incluye las ganadas (ya pasaron por agendarse): 2 de 4.
  assert.equal(payload.totals.tasaAgendamiento, 0.5);
  assert.equal(payload.totals.tasaCierre, 0.25);
  assert.equal(payload.totals.enCurso, 1); // solo la 'nuevo'
  assert.deepEqual(
    payload.porCanal.map((c) => [c.canal, c.count]).sort(),
    [['instagram', 2], ['whatsapp', 2]]
  );
  const lucia = payload.porAgente.find((a) => a.agente === 'Lucía');
  assert.deepEqual([lucia.total, lucia.agendadas, lucia.ganadas, lucia.valorGanado], [2, 1, 1, 400]);
  assert.equal(payload.porAgente.find((a) => a.agente === 'Sin asignar').total, 2);
  // El servicio cuenta oportunidades, no importes (una oportunidad con tres
  // servicios repartiría su valor tres veces).
  assert.deepEqual(payload.servicios, [{ servicio: 'Botox', count: 2 }]);
  assert.deepEqual(payload.motivosPerdida, [{ motivo: 'Precio', count: 1 }]);
});

test('clasifica por oportunidad SOLO por su nombre: el titular del anuncio no se cuela', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  await Conversation.create({
    clinic: clinic._id, phone: '593900000011',
    opportunities: [
      { isOpportunity: true, name: 'Probiotic 1', stage: 'nuevo', createdAt: hace(3), expectedValue: 39 },
      { isOpportunity: true, name: 'Probiotic 1', stage: 'agendado', createdAt: hace(2), expectedValue: 39 },
      // Nacida sola de un anuncio: sin nombre. `attribution.campaign` NO es una
      // campaña, es el TITULAR del anuncio (referral.headline), así que no puede
      // acabar en el informe como si fuera una oportunidad que alguien creó.
      {
        isOpportunity: true, name: '', stage: 'nuevo', createdAt: hace(2),
        attribution: { adId: '120249', campaign: 'Revisa Tu Próstata A Tiempo' },
      },
    ],
  });
  await Conversation.create({
    clinic: clinic._id, phone: '593900000012',
    opportunities: [{ isOpportunity: true, name: 'Probiotic 1', stage: 'ganado', createdAt: hace(1), expectedValue: 39 }],
  });

  const { payload } = await pedir(clinic._id, rango);
  // Cuatro oportunidades repartidas en DOS chats: es la respuesta a "¿por qué hay
  // más oportunidades que chats?".
  assert.equal(payload.totals.oportunidades, 4);
  assert.equal(payload.totals.chatsConOportunidad, 2);

  const probiotic = payload.porOportunidad.find((o) => o.nombre === 'Probiotic 1');
  assert.deepEqual(
    [probiotic.total, probiotic.nuevo, probiotic.agendado, probiotic.ganado, probiotic.value],
    [3, 1, 1, 1, 117]
  );
  assert.equal(
    payload.porOportunidad.some((o) => o.nombre === 'Revisa Tu Próstata A Tiempo'),
    false,
    'el titular de un anuncio nunca es el nombre de una oportunidad'
  );
  const sinNombre = payload.porOportunidad.find((o) => o.nombre === 'Sin nombre');
  assert.equal(sinNombre.total, 1);
  assert.equal(sinNombre.desdeAnuncio, 1);
});

test('chats por anuncio: se cuentan los chats NUEVOS del rango, por el anuncio del chat', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const desde = (adId, campaign, createdAt) => ({
    clinic: clinic._id, createdAt, attribution: { adId, campaign, ctwaClid: '' },
  });
  await Conversation.insertMany([
    { ...desde('ad-1', 'Revisa Tu Próstata A Tiempo', hace(2)), phone: '593900000021' },
    { ...desde('ad-1', 'Revisa Tu Próstata A Tiempo', hace(1)), phone: '593900000022' },
    { ...desde('ad-2', 'Eliminar mi uñero', hace(1)), phone: '593900000023' },
    // Mismo titular que ad-2 pero OTRO anuncio: dos filas idénticas no valen.
    { ...desde('ad-3', 'Eliminar mi uñero', hace(1)), phone: '593900000024' },
    // Sin anuncio: cuenta como chat nuevo pero no en el desglose.
    { clinic: clinic._id, phone: '593900000025', createdAt: hace(1) },
    // De un anuncio pero FUERA del rango.
    { ...desde('ad-1', 'Revisa Tu Próstata A Tiempo', hace(200)), phone: '593900000026' },
  ]);

  const { payload } = await pedir(clinic._id, rango);
  assert.equal(payload.totals.chats, 5);
  assert.equal(payload.totals.chatsDesdeAnuncios, 4, 'los de anuncios son un subconjunto de los nuevos');

  const porAnuncio = payload.porAnuncio;
  assert.equal(porAnuncio.length, 3);
  assert.equal(porAnuncio[0].adId, 'ad-1');
  assert.equal(porAnuncio[0].chats, 2);
  // El titular repetido se desempata con el final del id del anuncio.
  const repes = porAnuncio.filter((a) => a.adId !== 'ad-1').map((a) => a.titular);
  assert.deepEqual(repes.sort(), ['Eliminar mi uñero · …ad-2', 'Eliminar mi uñero · …ad-3']);
});

test('la clínica ajena no entra en las cuentas', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const otra = await Clinic.create({ name: 'Otra' });
  await Conversation.create({
    clinic: otra._id, phone: '593900000009',
    opportunities: [{ isOpportunity: true, stage: 'ganado', createdAt: hace(1), expectedValue: 999 }],
  });

  const { payload } = await pedir(clinic._id, rango);
  assert.equal(payload.totals.oportunidades, 0);
  assert.equal(payload.totals.chats, 0);
});

test('mover la etapa sella la fecha del movimiento (y guardar sin tocarla no la mueve)', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const conv = await Conversation.create({
    clinic: clinic._id, phone: '593900000010',
    opportunities: [{ isOpportunity: true, stage: 'nuevo', createdAt: hace(10), stageChangedAt: hace(10) }],
  });
  const userId = new mongoose.Types.ObjectId();

  await H.runController(
    chat.updateOpportunityAt,
    H.mockReq(clinic._id, userId, { stage: 'agendado' }, { role: 'admin', params: { id: String(conv._id), idx: '0' } })
  );
  const movido = await Conversation.findById(conv._id);
  const sellada = movido.opportunities[0].stageChangedAt;
  assert.ok(sellada > hace(1), 'la fecha de etapa debe ser de ahora');

  // Guardar de nuevo SIN cambiar la etapa (el modal manda un PUT por fila) no
  // puede mover la oportunidad de día en las gráficas.
  await H.runController(
    chat.updateOpportunityAt,
    H.mockReq(clinic._id, userId, { stage: 'agendado', notes: 'llamar mañana' }, { role: 'admin', params: { id: String(conv._id), idx: '0' } })
  );
  const otraVez = await Conversation.findById(conv._id);
  assert.equal(Number(otraVez.opportunities[0].stageChangedAt), Number(sellada));
});

// ─────────────────────────────────────────────────────────────────────────────
//  Detalle de una barra: QUIÉNES son, para poder abrir su chat
// ─────────────────────────────────────────────────────────────────────────────
const detalle = (clinicId, query) => H.runController(
  chat.opportunityAnalyticsDetail,
  H.mockReq(clinicId, new mongoose.Types.ObjectId(), {}, { role: 'admin', query })
);

/** Dos chats perdidos por el mismo motivo, uno por otro, y una oportunidad viva. */
async function seedDetalle() {
  const clinic = await Clinic.create({ name: 'Principal' });
  await Conversation.create({
    clinic: clinic._id, phone: '593900000101', contactName: 'Ana Pérez', assignedToName: 'Lucía',
    opportunities: [{ isOpportunity: true, name: 'Detox', stage: 'perdido', lostReason: 'otra provincia', createdAt: hace(3) }],
  });
  await Conversation.create({
    clinic: clinic._id, phone: '593900000102', contactName: 'Beto Ruiz',
    opportunities: [{ isOpportunity: true, name: 'Detox', stage: 'perdido', lostReason: 'otra provincia', createdAt: hace(2) }],
  });
  await Conversation.create({
    clinic: clinic._id, phone: '593900000103', contactName: 'Caro Mora',
    opportunities: [{ isOpportunity: true, name: 'Detox', stage: 'perdido', lostReason: 'precio', createdAt: hace(2) }],
  });
  await Conversation.create({
    clinic: clinic._id, phone: '593900000104', contactName: 'Dani Salas',
    opportunities: [{ isOpportunity: true, name: 'Detox', stage: 'nuevo', createdAt: hace(1) }],
  });
  return clinic;
}

test('detalle por motivo de pérdida: las mismas personas que cuenta la barra, con su chat', async () => {
  const clinic = await seedDetalle();

  const grafica = await pedir(clinic._id, rango);
  const barra = grafica.payload.motivosPerdida.find((m) => m.motivo === 'otra provincia');
  assert.equal(barra.count, 2);

  const { payload } = await detalle(clinic._id, { ...rango, by: 'motivo', value: 'otra provincia' });
  // La cifra del detalle TIENE que ser la de la barra: si no, el informe deja de
  // ser creíble.
  assert.equal(payload.total, barra.count);
  assert.deepEqual(payload.items.map((i) => i.contactName).sort(), ['Ana Pérez', 'Beto Ruiz']);
  // Con el id de la conversación y el teléfono es con lo que se abre el chat.
  assert.ok(payload.items.every((i) => i.conversationId && i.phone));
  assert.ok(payload.items.every((i) => i.stage === 'perdido'));
  assert.equal(payload.items.find((i) => i.contactName === 'Ana Pérez').assignedToName, 'Lucía');
});

test('detalle por oportunidad: todas sus etapas, o solo la etapa pinchada', async () => {
  const clinic = await seedDetalle();

  const todas = await detalle(clinic._id, { ...rango, by: 'oportunidad', value: 'Detox' });
  assert.equal(todas.payload.total, 4);

  const soloNuevas = await detalle(clinic._id, { ...rango, by: 'oportunidad', value: 'Detox', stage: 'nuevo' });
  assert.deepEqual(soloNuevas.payload.items.map((i) => i.contactName), ['Dani Salas']);

  const perdidas = await detalle(clinic._id, { ...rango, by: 'oportunidad', value: 'Detox', stage: 'perdido' });
  assert.equal(perdidas.payload.total, 3);
});

test('detalle: el rango y la sucursal mandan igual que en la gráfica', async () => {
  const clinic = await seedDetalle();
  const otra = await Clinic.create({ name: 'Sucursal 2' });
  await Conversation.create({
    clinic: otra._id, phone: '593900000105', contactName: 'De otra sede',
    opportunities: [{ isOpportunity: true, name: 'Detox', stage: 'perdido', lostReason: 'otra provincia', createdAt: hace(2) }],
  });
  // Fuera del rango: no debe salir.
  await Conversation.create({
    clinic: clinic._id, phone: '593900000106', contactName: 'Vieja',
    opportunities: [{ isOpportunity: true, name: 'Detox', stage: 'perdido', lostReason: 'otra provincia', createdAt: hace(200) }],
  });

  const { payload } = await detalle(clinic._id, { ...rango, by: 'motivo', value: 'otra provincia' });
  assert.deepEqual(payload.items.map((i) => i.contactName).sort(), ['Ana Pérez', 'Beto Ruiz']);
});

test('detalle: «Sin motivo» y «Sin nombre» son las etiquetas de lo que viene vacío', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  await Conversation.create({
    clinic: clinic._id, phone: '593900000107', contactName: 'Sin razón',
    opportunities: [{ isOpportunity: true, name: '', stage: 'perdido', createdAt: hace(2) }],
  });

  const porMotivo = await detalle(clinic._id, { ...rango, by: 'motivo', value: 'Sin motivo' });
  assert.deepEqual(porMotivo.payload.items.map((i) => i.contactName), ['Sin razón']);

  const porNombre = await detalle(clinic._id, { ...rango, by: 'oportunidad', value: 'Sin nombre' });
  assert.deepEqual(porNombre.payload.items.map((i) => i.contactName), ['Sin razón']);
});

test('detalle: sin decir qué barra es, no se devuelve nada', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const { statusCode } = await detalle(clinic._id, { ...rango, by: 'loQueSea', value: 'x' });
  assert.equal(statusCode, 400);
});
