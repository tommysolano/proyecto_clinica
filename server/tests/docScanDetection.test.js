/**
 * Detección de la hoja del escáner (client/src/utils/docScan.js).
 *
 * Vive aquí, en la suite del servidor, porque el cliente no tiene corredor de
 * tests y `detectDocumentInImageData` es una función PURA: recibe {data, width,
 * height} y no toca el DOM, así que se puede ejercitar desde Node. Es la pieza
 * más delicada del escáner (si falla, el recorte automático deja de servir),
 * por eso vale la pena cubrirla aunque el archivo sea del front.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const MODULE = pathToFileURL(
  path.join(__dirname, '..', '..', 'client', 'src', 'utils', 'docScan.js')
).href;

let detectDocumentInImageData;
test.before(async () => {
  ({ detectDocumentInImageData } = await import(MODULE));
});

/** Lienzo sintético relleno de un gris. */
function frame(w, h, bg = 30) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = bg;
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}

/** Pinta un polígono relleno (regla par-impar) — hace de "hoja de papel". */
function fillPolygon(img, points, value = 235) {
  const { data, width: w, height: h } = img;
  for (let y = 0; y < h; y++) {
    const xs = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let x = Math.ceil(xs[k]); x <= Math.floor(xs[k + 1]); x++) {
        if (x < 0 || x >= w) continue;
        const p = (y * w + x) * 4;
        data[p] = data[p + 1] = data[p + 2] = value;
      }
    }
  }
  return img;
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ─────────────────────────────────────────────────────────────────────────────
test('Detecta una hoja recta sobre fondo oscuro y devuelve sus 4 esquinas', () => {
  const img = frame(200, 150);
  const paper = [{ x: 40, y: 25 }, { x: 165, y: 25 }, { x: 165, y: 125 }, { x: 40, y: 125 }];
  fillPolygon(img, paper);

  const quad = detectDocumentInImageData(img);

  assert.ok(quad, 'debería encontrar la hoja');
  assert.equal(quad.length, 4);
  const [tl, tr, br, bl] = quad;
  assert.ok(near(tl.x, 40, 4) && near(tl.y, 25, 4), `sup. izq. fuera de lugar: ${JSON.stringify(tl)}`);
  assert.ok(near(tr.x, 165, 4) && near(tr.y, 25, 4), `sup. der. fuera de lugar: ${JSON.stringify(tr)}`);
  assert.ok(near(br.x, 165, 4) && near(br.y, 125, 4), `inf. der. fuera de lugar: ${JSON.stringify(br)}`);
  assert.ok(near(bl.x, 40, 4) && near(bl.y, 125, 4), `inf. izq. fuera de lugar: ${JSON.stringify(bl)}`);
});

test('Detecta la hoja aunque esté girada / en perspectiva', () => {
  const img = frame(220, 180);
  // Trapecio: la foto tomada desde arriba en ángulo.
  const paper = [{ x: 55, y: 20 }, { x: 190, y: 45 }, { x: 165, y: 160 }, { x: 30, y: 130 }];
  fillPolygon(img, paper);

  const quad = detectDocumentInImageData(img);

  assert.ok(quad, 'debería encontrar la hoja inclinada');
  // Cada esquina detectada debe caer cerca de una esquina real.
  for (const real of paper) {
    const closest = Math.min(...quad.map((q) => Math.hypot(q.x - real.x, q.y - real.y)));
    assert.ok(closest <= 8, `ninguna esquina detectada cerca de ${JSON.stringify(real)} (${closest.toFixed(1)}px)`);
  }
});

test('Sin hoja (cuadro uniforme) no inventa un recorte', () => {
  assert.equal(detectDocumentInImageData(frame(200, 150, 120)), null);
});

test('Si el papel ocupa TODO el cuadro no hay nada que recortar', () => {
  const img = frame(200, 150, 240);
  assert.equal(detectDocumentInImageData(img), null);
});

test('Una mancha clara que no es rectangular se descarta', () => {
  const img = frame(200, 150);
  // Forma de "L": llena su caja envolvente a medias, no es una hoja.
  fillPolygon(img, [
    { x: 30, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 100 },
    { x: 170, y: 100 }, { x: 170, y: 130 }, { x: 30, y: 130 },
  ]);

  assert.equal(detectDocumentInImageData(img), null);
});

test('Un objeto claro pequeño (no una hoja) se ignora', () => {
  const img = frame(200, 150);
  fillPolygon(img, [{ x: 90, y: 65 }, { x: 115, y: 65 }, { x: 115, y: 85 }, { x: 90, y: 85 }]);

  assert.equal(detectDocumentInImageData(img), null);
});
