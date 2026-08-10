/**
 * Motor de escaneo de documentos (usado por la página /scanner).
 *
 * Hace lo mismo que CamScanner/iLovePDF pero en el navegador y sin librerías:
 *   1. `detectDocument`  — encuentra la hoja dentro del cuadro de la cámara.
 *   2. `warpDocument`    — la recorta y le corrige la perspectiva (queda recta).
 *   3. `applyFilter`     — la limpia (blanco y negro / gris / color realzado).
 *
 * Cómo se detecta la hoja (a propósito sin detección de bordes ni Hough, que en
 * JS puro son lentos y frágiles con poca luz):
 *   · se reduce el cuadro a ~220px de ancho y se pasa a gris,
 *   · se separa "papel" de "fondo" con el umbral de Otsu (el papel es lo claro),
 *   · se toma la mancha clara más grande (componente conexa),
 *   · sus 4 esquinas son los extremos de x+y y x−y, que dan un cuadrilátero
 *     correcto aunque la hoja esté girada o en diagonal,
 *   · se descarta si es muy chica, muy grande o si la mancha no llena bien el
 *     cuadrilátero (eso significa que no era una hoja).
 * Cuando no encuentra nada devuelve null y la página deja recortar a mano.
 */

// ─── Detección ───────────────────────────────────────────────────────────────

/** Gris (luminancia) de un ImageData → Uint8ClampedArray de w*h. */
function toGray(data, w, h) {
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  }
  return g;
}

/** Umbral de Otsu: el valor de gris que mejor separa claro de oscuro. */
function otsuThreshold(gray) {
  const hist = new Int32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

/**
 * Componente conexa (4-vecinos) más grande de la máscara. Devuelve los índices
 * de sus píxeles. Pila explícita: recursión se desborda con imágenes grandes.
 */
function largestBlob(mask, w, h) {
  const labels = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  let best = null;
  let bestSize = 0;
  let label = 0;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start] !== -1) continue;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = label;
    const pixels = [];
    while (sp > 0) {
      const p = stack[--sp];
      pixels.push(p);
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && labels[p - 1] === -1) { labels[p - 1] = label; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && labels[p + 1] === -1) { labels[p + 1] = label; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && labels[p - w] === -1) { labels[p - w] = label; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && labels[p + w] === -1) { labels[p + w] = label; stack[sp++] = p + w; }
    }
    if (pixels.length > bestSize) { bestSize = pixels.length; best = pixels; }
    label++;
  }
  return best;
}

/** Área de un cuadrilátero por la fórmula del zapatero. */
function quadArea(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p1 = q[i];
    const p2 = q[(i + 1) % q.length];
    a += p1.x * p2.y - p2.x * p1.y;
  }
  return Math.abs(a) / 2;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Busca la hoja en un ImageData ya reducido.
 * Devuelve las 4 esquinas [tl, tr, br, bl] en píxeles de ESE ImageData, o null.
 */
export function detectDocumentInImageData(imageData) {
  const { data, width: w, height: h } = imageData;
  if (w < 40 || h < 40) return null;
  const gray = toGray(data, w, h);
  const th = otsuThreshold(gray);

  // El papel es la clase clara. Si casi todo el cuadro es "claro" no hay hoja
  // que recortar (foto contra una pared blanca, por ejemplo).
  const mask = new Uint8Array(w * h);
  let bright = 0;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] > th) { mask[i] = 1; bright++; }
  }
  const brightRatio = bright / (w * h);
  if (brightRatio < 0.05 || brightRatio > 0.97) return null;

  const blob = largestBlob(mask, w, h);
  if (!blob || blob.length < w * h * 0.08) return null;

  // Esquinas: extremos de (x+y) y (x−y). Robusto con la hoja girada.
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
  let tl = null, br = null, bl = null, tr = null;
  let minX = w, maxX = 0, minY = h, maxY = 0;
  for (const p of blob) {
    const x = p % w;
    const y = (p / w) | 0;
    const s = x + y;
    const d = x - y;
    if (s < minSum) { minSum = s; tl = { x, y }; }
    if (s > maxSum) { maxSum = s; br = { x, y }; }
    if (d < minDiff) { minDiff = d; bl = { x, y }; }
    if (d > maxDiff) { maxDiff = d; tr = { x, y }; }
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const quad = [tl, tr, br, bl];
  if (quad.some((p) => !p)) return null;

  const area = quadArea(quad);
  const frame = w * h;
  // Ni una mancha diminuta ni el cuadro entero (ahí no habría nada que recortar).
  if (area < frame * 0.12 || area > frame * 0.985) return null;
  // La mancha debe LLENAR el cuadrilátero: si no, no era una hoja rectangular.
  if (blob.length / area < 0.75) return null;
  // Lados mínimos: descarta cuadriláteros degenerados (casi una línea).
  const top = dist(tl, tr), right = dist(tr, br), bottom = dist(br, bl), left = dist(bl, tl);
  if (Math.min(top, right, bottom, left) < Math.min(w, h) * 0.12) return null;
  // Los lados opuestos de una hoja se parecen, incluso fotografiada en ángulo:
  // la perspectiva los acorta, pero no 3 veces. Esto descarta manchas claras con
  // forma de L o de banda diagonal, que sí llenaban su cuadrilátero.
  const ratio = (a, b) => Math.min(a, b) / Math.max(a, b);
  if (ratio(top, bottom) < 0.4 || ratio(left, right) < 0.4) return null;

  return quad;
}

/**
 * Detecta la hoja en un `<video>`/`<canvas>`/`ImageBitmap` reduciéndolo primero.
 * Devuelve las esquinas en coordenadas RELATIVAS (0..1) para poder pintarlas
 * sobre el vídeo y reutilizarlas luego sobre la foto a resolución completa.
 */
export function detectDocument(source, sourceW, sourceH, work = 220) {
  if (!sourceW || !sourceH) return null;
  const scale = work / sourceW;
  const w = Math.max(40, Math.round(sourceW * scale));
  const h = Math.max(40, Math.round(sourceH * scale));
  const canvas = getScratch(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const quad = detectDocumentInImageData(ctx.getImageData(0, 0, w, h));
  if (!quad) return null;
  return quad.map((p) => ({ x: p.x / w, y: p.y / h }));
}

// Un único canvas de trabajo reutilizado: crear uno por cuadro dispara el GC.
let scratch = null;
function getScratch(w, h) {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
  return scratch;
}

// ─── Corrección de perspectiva ───────────────────────────────────────────────

/**
 * Homografía que lleva el rectángulo destino (0,0)-(dw,dh) al cuadrilátero
 * origen. Resuelve el sistema 8×8 por eliminación gaussiana.
 */
function homography(dst, src) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = dst[i];
    const { x: u, y: v } = src[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
  }
  // Gauss con pivoteo parcial.
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    if (Math.abs(A[pivot][col]) < 1e-10) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      if (!f) continue;
      for (let c = col; c < 8; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const m = b.map((v, i) => v / A[i][i]);
  return [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], 1];
}

/**
 * Recorta el cuadrilátero de `source` y lo endereza en un canvas nuevo.
 * `quad` en coordenadas relativas (0..1). `maxSide` limita el tamaño de salida.
 */
export function warpDocument(source, sourceW, sourceH, quad, maxSide = 1700) {
  const src = quad.map((p) => ({ x: p.x * sourceW, y: p.y * sourceH }));
  const [tl, tr, br, bl] = src;

  // Tamaño de salida: el lado más largo de cada par (arriba/abajo, izq/der).
  let dw = Math.round(Math.max(dist(tl, tr), dist(bl, br)));
  let dh = Math.round(Math.max(dist(tl, bl), dist(tr, br)));
  if (dw < 8 || dh < 8) return null;
  const k = Math.min(1, maxSide / Math.max(dw, dh));
  dw = Math.max(8, Math.round(dw * k));
  dh = Math.max(8, Math.round(dh * k));

  const H = homography(
    [{ x: 0, y: 0 }, { x: dw, y: 0 }, { x: dw, y: dh }, { x: 0, y: dh }],
    src
  );
  if (!H) return null;

  // Origen completo en memoria para poder muestrear píxel a píxel.
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = sourceW;
  srcCanvas.height = sourceH;
  const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(source, 0, 0, sourceW, sourceH);
  const sdata = sctx.getImageData(0, 0, sourceW, sourceH).data;

  const out = document.createElement('canvas');
  out.width = dw;
  out.height = dh;
  const octx = out.getContext('2d');
  const odata = octx.createImageData(dw, dh);
  const o = odata.data;

  const [a, bb, c, d, e, f, g, hh] = H;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const den = g * x + hh * y + 1;
      const u = (a * x + bb * y + c) / den;
      const v = (d * x + e * y + f) / den;
      const oi = (y * dw + x) * 4;
      if (u < 0 || v < 0 || u > sourceW - 1 || v > sourceH - 1) {
        o[oi] = o[oi + 1] = o[oi + 2] = 255;
        o[oi + 3] = 255;
        continue;
      }
      // Bilineal: sin esto los bordes de las letras quedan dentados.
      const x0 = u | 0, y0 = v | 0;
      const x1 = Math.min(x0 + 1, sourceW - 1);
      const y1 = Math.min(y0 + 1, sourceH - 1);
      const fx = u - x0, fy = v - y0;
      const i00 = (y0 * sourceW + x0) * 4;
      const i10 = (y0 * sourceW + x1) * 4;
      const i01 = (y1 * sourceW + x0) * 4;
      const i11 = (y1 * sourceW + x1) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = sdata[i00 + ch] * (1 - fx) + sdata[i10 + ch] * fx;
        const bot = sdata[i01 + ch] * (1 - fx) + sdata[i11 + ch] * fx;
        o[oi + ch] = top * (1 - fy) + bot * fy;
      }
      o[oi + 3] = 255;
    }
  }
  octx.putImageData(odata, 0, 0);
  return out;
}

// ─── Filtros ─────────────────────────────────────────────────────────────────

/** Suma acumulada 2D: permite promediar cualquier ventana en tiempo constante. */
function integralImage(gray, w, h) {
  const sum = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += gray[y * w + x];
      sum[(y + 1) * (w + 1) + (x + 1)] = sum[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  return sum;
}

/**
 * Limpia la página escaneada. Modos:
 *   'color'      — la deja tal cual (fotos, sellos, membretes a color)
 *   'gris'       — escala de grises
 *   'documento'  — fondo blanco parejo y texto negro: divide cada píxel por la
 *                  luz de su entorno, así se van las sombras del pulso y del
 *                  brillo desigual. Es el modo por defecto.
 *   'bn'         — binarizado duro (texto puro, archivo muy liviano)
 */
export function applyFilter(canvas, mode = 'documento') {
  if (mode === 'color') return canvas;
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const gray = toGray(d, w, h);

  if (mode === 'gris') {
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      d[p] = d[p + 1] = d[p + 2] = gray[i];
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  // Luz local con una ventana grande (~1/8 del lado): estima la iluminación.
  const radius = Math.max(8, Math.round(Math.min(w, h) / 16));
  const sum = integralImage(gray, w, h);
  const meanAt = (x, y) => {
    const x0 = Math.max(0, x - radius), y0 = Math.max(0, y - radius);
    const x1 = Math.min(w - 1, x + radius), y1 = Math.min(h - 1, y + radius);
    const area = (x1 - x0 + 1) * (y1 - y0 + 1);
    const s = sum[(y1 + 1) * (w + 1) + (x1 + 1)]
      - sum[y0 * (w + 1) + (x1 + 1)]
      - sum[(y1 + 1) * (w + 1) + x0]
      + sum[y0 * (w + 1) + x0];
    return s / area;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const local = Math.max(1, meanAt(x, y));
      // Normalizado por la luz local: el papel queda en 255 aunque tenga sombra.
      let v = (gray[i] / local) * 255;
      if (mode === 'bn') {
        v = v > 242 ? 255 : 0;
      } else {
        // Curva suave: aclara el papel y oscurece el trazo sin quemar los grises.
        v = v < 235 ? Math.max(0, (v - 40) * 1.35) : 255;
        v = Math.min(255, v);
      }
      const p = i * 4;
      d[p] = d[p + 1] = d[p + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ─── Ayudas ──────────────────────────────────────────────────────────────────

/** Las 4 esquinas del cuadro completo (cuando no se detecta hoja). */
export const FULL_QUAD = [
  { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
];

/** Canvas → Blob JPEG (lo que se sube al servidor como página). */
export function canvasToJpeg(canvas, quality = 0.85) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('No se pudo convertir la imagen'))),
      'image/jpeg',
      quality
    );
  });
}

/** Dibuja un canvas reducido (para las miniaturas de la lista de páginas). */
export function thumbnailUrl(canvas, maxSide = 320) {
  const k = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const t = document.createElement('canvas');
  t.width = Math.max(1, Math.round(canvas.width * k));
  t.height = Math.max(1, Math.round(canvas.height * k));
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.7);
}

/** Carga un File/Blob de imagen en un HTMLImageElement ya decodificado. */
export function loadImage(fileOrUrl) {
  return new Promise((resolve, reject) => {
    const url = typeof fileOrUrl === 'string' ? fileOrUrl : URL.createObjectURL(fileOrUrl);
    const img = new Image();
    img.onload = () => {
      if (typeof fileOrUrl !== 'string') URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      if (typeof fileOrUrl !== 'string') URL.revokeObjectURL(url);
      reject(new Error('No se pudo leer la imagen'));
    };
    img.src = url;
  });
}
