/**
 * EL REDUCTOR DE FOTOS DE LOS ESCANEOS (utils/scanMedia.js).
 *
 * Lo que se prueba aquí no es la calidad del JPEG —eso lo hace Chromium— sino que
 * la importación de 6.000 fichas NO SE QUEDE COLGADA.
 *
 * Pasó de verdad: en la tanda de septiembre el kernel del VPS mató el Chromium por
 * falta de memoria, el `page.evaluate` sobre esa página muerta nunca resolvió NI
 * rechazó, y la importación se quedó clavada a las dos horas — con el latido de
 * `onetimetasks` latiendo puntual cada cinco minutos, así que desde fuera parecía
 * viva. Dos horas sin crear una sola ficha y nada avisando.
 *
 * Un Chromium de verdad no se puede matar a voluntad desde un test, por eso el
 * reductor acepta que le inyecten cómo abrir el navegador.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { crearReductor, paginasJpeg, pdfDePaginas, esJpeg } = require('../utils/scanMedia');

/** JPEG de 1×1 real: pdfkit lee sus marcas para poder incrustarlo. */
const JPEG_1x1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);

/** Un navegador de mentira cuyo `evaluate` hace lo que le digamos. */
const navegadorFalso = (evaluate) => ({
  on() {},
  async newPage() { return { evaluate }; },
  async close() {},
});

test('M1) si el navegador se queda colgado, la foto se devuelve tal cual y se sigue', async () => {
  // `evaluate` que nunca resuelve: es exactamente lo que hace una página cuyo
  // Chromium acaba de morir.
  const colgado = () => new Promise(() => {});
  const reductor = crearReductor({ tope: 50, lanzar: async () => navegadorFalso(colgado) });

  const t0 = Date.now();
  const salida = await reductor.reducir(JPEG_1x1);
  const tardo = Date.now() - t0;

  assert.deepEqual(salida, JPEG_1x1, 'devuelve el original en vez de esperar para siempre');
  assert.ok(tardo < 2000, `no se cuelga (tardó ${tardo} ms)`);
  await reductor.cerrar();
});

test('M2) tras varios fallos seguidos descansa: ni insiste en cada foto ni se rinde para siempre', async () => {
  // Las dos mitades importan. Insistir son 30 s tirados POR FOTO y con 4.000 por
  // delante la importación no termina nunca. Pero rendirse de por vida es lo que
  // costó 3 GB de más en septiembre: al VPS le mata el Chromium un pico de memoria
  // puntual y minutos después vuelve a abrirse tan campante.
  let aperturas = 0;
  let responde = false;
  const reductor = crearReductor({
    tope: 30,
    fallosSeguidos: 3,
    descansoMs: 250,
    lanzar: async () => {
      aperturas += 1;
      return navegadorFalso(responde
        ? async () => `data:image/jpeg;base64,${JPEG_1x1.toString('base64')}`
        : () => new Promise(() => {}));
    },
  });

  for (let i = 0; i < 3; i += 1) await reductor.reducir(JPEG_1x1);
  const trasRendirse = aperturas;

  const t0 = Date.now();
  for (let i = 0; i < 20; i += 1) {
    assert.deepEqual(await reductor.reducir(JPEG_1x1), JPEG_1x1);
  }
  assert.equal(aperturas, trasRendirse, 'mientras descansa no vuelve a abrir el navegador');
  assert.ok(Date.now() - t0 < 100, 'y las fotos pasan de largo, sin gastar el tope');

  // Pasado el descanso lo vuelve a intentar, y si el navegador ya va, reduce.
  responde = true;
  await new Promise((r) => setTimeout(r, 300));
  const grande = Buffer.concat([JPEG_1x1, Buffer.alloc(50)]);
  assert.deepEqual(await reductor.reducir(grande), JPEG_1x1, 'vuelve a reducir en cuanto puede');
  assert.ok(aperturas > trasRendirse, 'ha reintentado abrir el navegador');
  await reductor.cerrar();
});

test('M3) una foto que sí se reduce vuelve reducida, y una que crecería se deja igual', async () => {
  const masPequena = Buffer.concat([JPEG_1x1, Buffer.alloc(10)]);
  const reductor = crearReductor({
    lanzar: async () => navegadorFalso(async () => `data:image/jpeg;base64,${JPEG_1x1.toString('base64')}`),
  });
  assert.deepEqual(await reductor.reducir(masPequena), JPEG_1x1, 'se queda con la reducida');

  // Cuando "reducir" devuelve algo MÁS GRANDE (una foto que ya era pequeña), se
  // conserva el original: reescalar hacia arriba solo añade peso.
  const otro = crearReductor({
    lanzar: async () => navegadorFalso(
      async () => `data:image/jpeg;base64,${Buffer.concat([JPEG_1x1, Buffer.alloc(500)]).toString('base64')}`
    ),
  });
  assert.deepEqual(await otro.reducir(JPEG_1x1), JPEG_1x1);
  await reductor.cerrar();
  await otro.cerrar();
});

test('M4) las páginas salen del PDF en orden y se pueden volver a empaquetar', async () => {
  // Es lo que permite separar la ficha (página 1) de las hojas de seguimiento.
  const pdf = await pdfDePaginas([JPEG_1x1, JPEG_1x1, JPEG_1x1], 'Ficha de prueba');
  const paginas = paginasJpeg(pdf);

  assert.equal(paginas.length, 3);
  assert.ok(paginas.every(esJpeg), 'cada página es un JPEG de verdad');

  const soloLaFicha = paginasJpeg(await pdfDePaginas(paginas.slice(0, 1)));
  const soloLasHojas = paginasJpeg(await pdfDePaginas(paginas.slice(1)));
  assert.equal(soloLaFicha.length, 1);
  assert.equal(soloLasHojas.length, 2);
});
