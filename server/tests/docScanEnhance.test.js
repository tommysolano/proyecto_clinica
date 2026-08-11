/**
 * Limpieza de la página escaneada (client/src/utils/docScan.js → enhanceImageData).
 *
 * Vive aquí, en la suite del servidor, por lo mismo que docScanDetection: el
 * cliente no tiene corredor de tests y `enhanceImageData` es una función PURA
 * sobre un ImageData, así que se ejercita desde Node sin tocar el DOM.
 *
 * Lo que se cuida acá es que el filtro NO se coma el contenido. La versión
 * anterior mandaba a blanco puro todo lo que pasara del 90% del brillo del papel
 * y medía ese brillo sobre la luminancia: los recuadros celestes de un
 * formulario preimpreso, el membrete y el texto gris claro desaparecían de la
 * página, que es exactamente lo que hace inservible un PDF del que después hay
 * que extraer datos.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const MODULE = pathToFileURL(
  path.join(__dirname, '..', '..', 'client', 'src', 'utils', 'docScan.js')
).href;

let enhanceImageData;
test.before(async () => { ({ enhanceImageData } = await import(MODULE)); });

// ─── Página sintética ────────────────────────────────────────────────────────

const W = 320;
const H = 240;

/** Ruido reproducible: un test no puede depender de Math.random. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * Hoja fotografiada: papel `paper`, con la luz cayendo `shade` de izquierda a
 * derecha (0.45 = el lado derecho llega al 55% de luz) y algo de grano.
 */
function page({ paper = [240, 238, 234], shade = 0, grain = 2, seed = 11 } = {}) {
  const data = new Uint8ClampedArray(W * H * 4);
  const rnd = rng(seed);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = 1 - shade * (x / (W - 1));
      const n = (rnd() - 0.5) * 2 * grain;
      const p = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) data[p + c] = paper[c] * k + n;
      data[p + 3] = 255;
    }
  }
  return { data, width: W, height: H, shade };
}

/** Pinta un rectángulo respetando la caída de luz de la hoja. */
function rect(img, x0, y0, x1, y1, color) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const k = 1 - (img.shade || 0) * (x / (W - 1));
      const p = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) img.data[p + c] = color[c] * k;
    }
  }
  return img;
}

/** Unas líneas de texto negro: sin tinta en la página no hay punto negro. */
const withText = (img) => {
  for (let i = 0; i < 5; i++) rect(img, 30, 150 + i * 14, 290, 156 + i * 14, [28, 28, 30]);
  return img;
};

const px = (img, x, y) => {
  const p = (y * W + x) * 4;
  return [img.data[p], img.data[p + 1], img.data[p + 2]];
};

/** Promedio de una zona: evita que el grano o el enfoque decidan un assert. */
function area(img, x0, y0, x1, y1) {
  const acc = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) acc[c] += img.data[p + c];
      n++;
    }
  }
  return acc.map((v) => Math.round(v / n));
}

// ─────────────────────────────────────────────────────────────────────────────
//  El papel
// ─────────────────────────────────────────────────────────────────────────────

test('El papel sale blanco parejo de un extremo a otro pese a la sombra', () => {
  const img = withText(page({ shade: 0.45 }));

  enhanceImageData(img, 'documento');

  const izq = area(img, 10, 20, 60, 70);
  const der = area(img, 260, 20, 310, 70);
  for (const [lado, v] of [['izquierdo', izq], ['derecho', der]]) {
    assert.ok(Math.min(...v) >= 248, `papel ${lado} no quedó blanco: ${v}`);
  }
});

test('La luz cálida de interior no deja el papel amarillo: sale neutro', () => {
  // Papel blanco bajo una bombilla: el azul llega mucho más bajo que el rojo.
  const img = withText(page({ paper: [245, 232, 200] }));

  enhanceImageData(img, 'documento');

  const [r, g, b] = area(img, 10, 20, 60, 70);
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 6, `papel con tinte: ${[r, g, b]}`);
  assert.ok(b >= 248, `papel apagado: ${[r, g, b]}`);
});

// ─────────────────────────────────────────────────────────────────────────────
//  El contenido — la regresión que motivó el cambio
// ─────────────────────────────────────────────────────────────────────────────

test('Un recuadro celeste tenue de formulario preimpreso NO se borra', () => {
  // Este es el caso de las fichas de "Registro de pacientes": los campos son
  // recuadros celestes clarísimos. Su BRILLO está al 90% del papel, así que el
  // filtro anterior los mandaba a blanco puro y la ficha salía en blanco.
  const img = withText(page());
  rect(img, 40, 40, 280, 70, [200, 218, 238]);

  enhanceImageData(img, 'documento');

  const caja = area(img, 60, 48, 260, 62);
  const papel = area(img, 40, 100, 280, 130);
  assert.ok(papel[0] >= 248, `el papel debería ser blanco: ${papel}`);
  assert.ok(caja[0] <= 230, `el recuadro celeste se borró: ${caja}`);
  assert.ok(caja[2] - caja[0] >= 20, `el recuadro perdió su color celeste: ${caja}`);
});

test('El texto gris claro sigue leyéndose', () => {
  const img = withText(page());
  rect(img, 40, 40, 280, 60, [186, 186, 188]);

  enhanceImageData(img, 'documento');

  const texto = area(img, 60, 45, 260, 55);
  assert.ok(texto[0] <= 215, `el texto gris claro se blanqueó: ${texto}`);
});

test('El texto negro sale negro en los cuatro modos', () => {
  for (const mode of ['documento', 'gris', 'bn']) {
    const img = withText(page({ shade: 0.4 }));
    enhanceImageData(img, mode);
    const texto = area(img, 60, 151, 260, 155);
    assert.ok(Math.max(...texto) <= 60, `modo ${mode}: el texto no salió negro (${texto})`);
  }
});

test('Un sello de color más grande que la ventana de análisis conserva su color', () => {
  // La luz del papel se estima por celdas de 1/16 del lado: una mancha que ocupe
  // varias celdas pasaría a ser su propio "papel" y saldría blanca si no fuera
  // por el cierre morfológico de paperLight.
  const img = withText(page());
  rect(img, 120, 30, 200, 110, [198, 52, 48]);

  enhanceImageData(img, 'documento');

  const [r, g, b] = area(img, 135, 45, 185, 95);
  assert.ok(r >= 150, `el sello se apagó: ${[r, g, b]}`);
  assert.ok(r - Math.max(g, b) >= 80, `el sello perdió el rojo: ${[r, g, b]}`);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Los modos
// ─────────────────────────────────────────────────────────────────────────────

test('Modo grises: los tres canales iguales, papel blanco y texto oscuro', () => {
  const img = withText(page({ shade: 0.35 }));
  rect(img, 40, 40, 280, 70, [200, 218, 238]);

  enhanceImageData(img, 'gris');

  for (const [x, y] of [[20, 30], [150, 50], [80, 152], [300, 200]]) {
    const [r, g, b] = px(img, x, y);
    assert.equal(r, g, `(${x},${y}) no es gris: ${[r, g, b]}`);
    assert.equal(g, b, `(${x},${y}) no es gris: ${[r, g, b]}`);
  }
  assert.ok(area(img, 10, 20, 60, 70)[0] >= 248, 'el papel debería ser blanco');
  assert.ok(area(img, 60, 48, 260, 62)[0] <= 235, 'el recuadro celeste se borró en grises');
});

test('Modo B/N: solo blanco o negro, con el texto en negro', () => {
  const img = withText(page({ shade: 0.4 }));

  enhanceImageData(img, 'bn');

  for (let i = 0; i < img.data.length; i += 4) {
    const v = img.data[i];
    if (v !== 0 && v !== 255) assert.fail(`valor intermedio en B/N: ${v}`);
  }
  assert.ok(area(img, 60, 151, 260, 155)[0] <= 40, 'el texto no salió negro en B/N');
  assert.ok(area(img, 10, 20, 60, 70)[0] >= 250, 'el papel no salió blanco en B/N');
});

test('Modo color: devuelve la foto exactamente como entró', () => {
  const img = withText(page({ shade: 0.4 }));
  const antes = Uint8ClampedArray.from(img.data);

  enhanceImageData(img, 'color');

  assert.deepEqual(Array.from(img.data), Array.from(antes));
});

// ─────────────────────────────────────────────────────────────────────────────
//  Casos límite
// ─────────────────────────────────────────────────────────────────────────────

test('Una hoja escrita a lápiz no se queda toda gris', () => {
  // Sin trazo negro en la página, el punto negro se saca del propio contenido:
  // lo más oscuro que haya pasa a ser negro y el lápiz gana contraste.
  const img = page();
  for (let i = 0; i < 6; i++) rect(img, 40, 60 + i * 20, 280, 68 + i * 20, [150, 150, 152]);

  enhanceImageData(img, 'documento');

  const trazo = area(img, 60, 62, 260, 66);
  assert.ok(trazo[0] <= 150, `el lápiz quedó demasiado claro: ${trazo}`);
  assert.ok(area(img, 40, 30, 280, 50)[0] >= 248, 'el papel debería seguir blanco');
});

test('Una imagen diminuta no revienta', () => {
  const tiny = { data: new Uint8ClampedArray(4).fill(200), width: 1, height: 1 };
  assert.doesNotThrow(() => enhanceImageData(tiny, 'documento'));
});
