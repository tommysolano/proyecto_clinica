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

// ─────────────────────────────────────────────────────────────────────────────
//  Escenas realistas
//
//  Los casos de arriba son figuras planas de laboratorio. Los de abajo imitan
//  una foto de verdad —grano de la cámara, filos suavizados, texto dentro de la
//  hoja, sombra proyectada— y sobre todo el caso que rompía la versión anterior:
//  una hoja BLANCA sobre un escritorio CLARO. Ahí el brillo no separa nada; lo
//  único que distingue la hoja es su filo.
// ─────────────────────────────────────────────────────────────────────────────

/** Ruido reproducible: un test no puede depender de Math.random. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** Cuadro de fondo con grano, como el de cualquier cámara de celular. */
function scene(w, h, bg, seed = 7, amp = 3) {
  const img = frame(w, h, bg);
  const rnd = rng(seed);
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(255, bg + Math.round((rnd() - 0.5) * 2 * amp)));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
  }
  return img;
}

const insidePoly = (pts, x, y) => {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    if ((pts[i].y > y) !== (pts[j].y > y)
      && x < ((pts[j].x - pts[i].x) * (y - pts[i].y)) / (pts[j].y - pts[i].y) + pts[i].x) {
      hit = !hit;
    }
  }
  return hit;
};

/** Polígono con el filo suavizado (supermuestreo 3×3): ningún borde real es un escalón perfecto. */
function fillSoft(img, pts, value) {
  const { data, width: w, height: h } = img;
  const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x)) - 2));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(...pts.map((p) => p.x)) + 2));
  const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y)) - 2));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(...pts.map((p) => p.y)) + 2));
  const sub = [0.17, 0.5, 0.83];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let cov = 0;
      for (const dy of sub) for (const dx of sub) if (insidePoly(pts, x + dx, y + dy)) cov++;
      if (!cov) continue;
      const k = cov / 9;
      const p = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) data[p + c] = data[p + c] * (1 - k) + value * k;
    }
  }
  return img;
}

/** Renglones de texto dentro de la hoja (bordes mucho más fuertes que el papel). */
function addText(img, quad, rows = 6) {
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const [tl, tr, br, bl] = quad;
  for (let i = 0; i < rows; i++) {
    const t0 = 0.14 + (i * 0.72) / rows;
    const t1 = t0 + 0.4 / rows;
    const l0 = lerp(tl, bl, t0), r0 = lerp(tr, br, t0);
    const l1 = lerp(tl, bl, t1), r1 = lerp(tr, br, t1);
    fillSoft(img, [lerp(l0, r0, 0.12), lerp(l0, r0, 0.88), lerp(l1, r1, 0.88), lerp(l1, r1, 0.12)], 70);
  }
  return img;
}

/** Distancia de cada esquina real a la más cercana de las detectadas. */
function cornersNear(quad, real, tol) {
  for (const p of real) {
    const closest = Math.min(...quad.map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
    assert.ok(closest <= tol, `ninguna esquina cerca de ${JSON.stringify(p)} (${closest.toFixed(1)} px)`);
  }
}

test('Hoja clara sobre una mesa igual de clara: la encuentra por el filo, no por el brillo', () => {
  // Este es el caso que fallaba antes: el papel (231) y el escritorio (203)
  // caen del mismo lado de cualquier umbral de brillo.
  const img = scene(260, 200, 203);
  const paper = [{ x: 52, y: 26 }, { x: 206, y: 34 }, { x: 198, y: 172 }, { x: 44, y: 164 }];
  fillSoft(img, paper.map((p) => ({ x: p.x + 5, y: p.y + 7 })), 178); // sombra proyectada
  fillSoft(img, paper, 231);
  addText(img, paper);

  const quad = detectDocumentInImageData(img);

  assert.ok(quad, 'debería encontrar la hoja pese al poco contraste');
  cornersNear(quad, paper, 6);
});

test('El texto de la hoja no se confunde con la hoja: recorta el papel entero', () => {
  const img = scene(240, 190, 60);
  const paper = [{ x: 38, y: 22 }, { x: 202, y: 22 }, { x: 202, y: 168 }, { x: 38, y: 168 }];
  fillSoft(img, paper, 234);
  addText(img, paper, 8);

  const quad = detectDocumentInImageData(img);

  assert.ok(quad, 'debería encontrar la hoja');
  cornersNear(quad, paper, 5);
});

test('Una línea larga de la escena (cable, filo de la mesa) no se lleva el recorte', () => {
  const img = scene(260, 200, 150);
  fillSoft(img, [{ x: 0, y: 8 }, { x: 260, y: 22 }, { x: 260, y: 30 }, { x: 0, y: 16 }], 235); // cable
  fillSoft(img, [{ x: 0, y: 186 }, { x: 260, y: 178 }, { x: 260, y: 200 }, { x: 0, y: 200 }], 96); // filo mesa
  const paper = [{ x: 58, y: 48 }, { x: 204, y: 56 }, { x: 196, y: 160 }, { x: 50, y: 152 }];
  fillSoft(img, paper, 232);
  addText(img, paper, 5);

  const quad = detectDocumentInImageData(img);

  assert.ok(quad, 'debería encontrar la hoja');
  cornersNear(quad, paper, 6);
});

test('Aguanta una foto tomada muy de lado (perspectiva marcada)', () => {
  const img = scene(260, 200, 74);
  // El lado de arriba sale casi el doble de largo que el de abajo.
  const paper = [{ x: 26, y: 30 }, { x: 236, y: 46 }, { x: 176, y: 176 }, { x: 74, y: 168 }];
  fillSoft(img, paper, 230);
  addText(img, paper, 5);

  const quad = detectDocumentInImageData(img);

  assert.ok(quad, 'debería encontrar la hoja aunque esté muy escorzada');
  cornersNear(quad, paper, 7);
});

test('Si la hoja se sale del cuadro no se inventa el lado que falta', () => {
  // Sin uno de los cuatro filos no hay recorte fiable: mejor decirlo y dejar
  // que el usuario ajuste a mano que entregar una página cortada.
  const img = scene(240, 190, 70);
  fillSoft(img, [{ x: -40, y: 24 }, { x: 198, y: 24 }, { x: 198, y: 166 }, { x: -40, y: 166 }], 232);

  assert.equal(detectDocumentInImageData(img), null);
});
