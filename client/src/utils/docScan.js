/**
 * Motor de escaneo de documentos (usado por la página /scanner).
 *
 * Hace lo mismo que CamScanner/iLovePDF pero en el navegador y sin librerías:
 *   1. `detectDocument`  — encuentra la hoja dentro del cuadro de la cámara.
 *   2. `warpDocument`    — la recorta y le corrige la perspectiva (queda recta).
 *   3. `applyFilter`     — la limpia (blanco y negro / gris / color realzado).
 *
 * Cómo se detecta la hoja
 * ───────────────────────
 * Buscar "la mancha clara más grande" no sirve: en la mesa de una oficina el
 * papel y el escritorio suelen tener el mismo brillo, así que la mancha se come
 * la mesa entera. Lo que SÍ separa una hoja de lo que tiene debajo es su BORDE
 * (el filo, la sombra que proyecta), y eso es lo que se busca aquí:
 *
 *   · se reduce el cuadro a ~256 px de ancho, se pasa a gris y se suaviza,
 *   · Sobel da la fuerza y la dirección del borde en cada píxel,
 *   · una transformada de Hough guiada por esa dirección saca las rectas largas
 *     de la escena (cada píxel solo vota por ángulos parecidos al suyo, así que
 *     es barata y los picos salen limpios),
 *   · se arman cuadriláteros con dos pares de rectas casi paralelas y
 *     perpendiculares entre sí,
 *   · como red de seguridad (papel arrugado, foto borrosa, bordes rotos) se
 *     añaden candidatos por regiones claras: se prueban varios umbrales, se
 *     toma la mancha más grande y se le calcula el cuadrilátero de área máxima
 *     sobre su envolvente convexa,
 *   · TODOS los candidatos se puntúan igual: cuánto borde real hay debajo de
 *     cada uno de los 4 lados. Un lado inventado no tiene borde y hunde la nota,
 *     que es lo que evita recortar una sombra o el filo de la mesa,
 *   · el ganador se afina ajustando cada lado por mínimos cuadrados a los
 *     píxeles de borde que tiene cerca, y de ahí salen las 4 esquinas.
 *
 * Cuando nada convence devuelve null y la página abre el recorte manual.
 */

// ─── Parámetros de la detección ──────────────────────────────────────────────
// Todo lo ajustable está aquí junto: es lo único que hay que retocar si algún
// día la detección se pasa de estricta (o de confiada) con otras cámaras.
const D = {
  work: 256,          // ancho al que se reduce el cuadro para analizarlo
  minArea: 0.10,      // la hoja ocupa al menos esto del cuadro
  maxArea: 0.985,     // …y no el cuadro entero (ahí no habría nada que recortar)
  minSide: 0.10,      // lado mínimo, respecto al lado corto del cuadro
  minOpposite: 0.35,  // relación mínima entre lados opuestos (perspectiva sana)
  cornerCos: 0.766,   // |cos| máximo en una esquina → ángulos entre 40° y 140°
  // Qué se considera "un borde nítido" (0-255). Se saca de la propia imagen con
  // Otsu, pero acotado: el suelo evita tomar el grano de la cámara por un filo,
  // y el techo evita lo contrario — que el texto de la hoja, que contrasta
  // muchísimo más que su borde, deje al borde de papel pareciendo insignificante.
  edgeFloor: 10,
  edgeCeil: 18,
  band: 3,            // px a cada lado en los que se busca el borde de un lado
  samples: 24,        // muestras por lado al puntuar
  hit: 0.35,          // desde aquí una muestra cuenta como borde de verdad
  coverage: 0.78,     // borde mínimo a lo largo de CADA lado. Es la regla que
                      // impide quedarse con un pedazo del documento: un lado
                      // que solo existe a ratos no es el filo de una hoja.
  accept: 0.42,       // nota mínima para dar la hoja por buena
  good: 0.72,         // por encima de esto ya no hace falta seguir buscando
  outside: 0.08,      // cuánto puede salirse una esquina del cuadro
  refine: 6,          // cuántos candidatos se afinan (los mejores)
};

const HOUGH = {
  thetaBins: 90,      // 2° por casilla
  rhoStep: 2,         // px por casilla
  spread: 2,          // casillas de ángulo a cada lado del gradiente del píxel
  maxPoints: 6000,    // píxeles de borde que se votan como mucho
  maxLines: 20,       // rectas que se conservan
  minPeak: 0.15,      // pico mínimo, respecto al más votado
  perAngle: 6,        // pares de rectas paralelas que se guardan por orientación
  maxPairs: 40,       // …y tope total de pares que se combinan entre sí
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const ratio = (a, b) => (Math.max(a, b) ? Math.min(a, b) / Math.max(a, b) : 0);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ─── Piezas de imagen ────────────────────────────────────────────────────────

/** Gris (luminancia) de un ImageData → Uint8ClampedArray de w*h. */
function toGray(data, w, h) {
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  }
  return g;
}

/** Umbral de Otsu: el valor (0-255) que mejor separa claro de oscuro. */
function otsuThreshold(values) {
  const hist = new Int32Array(256);
  for (let i = 0; i < values.length; i++) hist[values[i]]++;
  const total = values.length;
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

/** Valor por debajo del cual queda la fracción `p` de la imagen. */
function percentile(values, p) {
  const hist = new Int32Array(256);
  for (let i = 0; i < values.length; i++) hist[values[i]]++;
  const target = p * values.length;
  let acc = 0;
  for (let t = 0; t < 256; t++) {
    acc += hist[t];
    if (acc >= target) return t;
  }
  return 255;
}

/** Suavizado 3×3 separable: sin esto el grano de la cámara ensucia el Sobel. */
function blur3(gray, w, h) {
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const l = x > 0 ? gray[i - 1] : gray[i];
      const r = x < w - 1 ? gray[i + 1] : gray[i];
      tmp[i] = (l + 2 * gray[i] + r) * 0.25;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const u = y > 0 ? tmp[i - w] : tmp[i];
      const d = y < h - 1 ? tmp[i + w] : tmp[i];
      out[i] = (u + 2 * tmp[i] + d) * 0.25;
    }
  }
  return out;
}

/**
 * Sobel: derivadas en x e y (dirección del borde) y su fuerza ya escalada a
 * 0-255 (`edge`), que es lo que se compara contra umbrales.
 */
function sobel(src, w, h) {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const edge = new Uint8ClampedArray(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = src[i - w - 1], b = src[i - w], c = src[i - w + 1];
      const d = src[i - 1], f = src[i + 1];
      const g = src[i + w - 1], k = src[i + w], l = src[i + w + 1];
      const sx = (c + 2 * f + l) - (a + 2 * d + g);
      const sy = (g + 2 * k + l) - (a + 2 * b + c);
      gx[i] = sx;
      gy[i] = sy;
      edge[i] = Math.hypot(sx, sy) / 4; // el máximo teórico es ~1020
    }
  }
  return { gx, gy, edge };
}

// ─── Geometría ───────────────────────────────────────────────────────────────

/** Área de un polígono por la fórmula del zapatero. */
function quadArea(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p1 = q[i];
    const p2 = q[(i + 1) % q.length];
    a += p1.x * p2.y - p2.x * p1.y;
  }
  return Math.abs(a) / 2;
}

/** Ordena 4 puntos sueltos como [sup.izq, sup.der, inf.der, inf.izq]. */
function orderQuad(pts) {
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  // Ordenados por ángulo alrededor del centro quedan en sentido horario (la y
  // crece hacia abajo); solo falta empezar por la esquina superior izquierda.
  const ring = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let start = 0, best = Infinity;
  ring.forEach((p, i) => { if (p.x + p.y < best) { best = p.x + p.y; start = i; } });
  return [ring[start], ring[(start + 1) % 4], ring[(start + 2) % 4], ring[(start + 3) % 4]];
}

/** Un cuadrilátero cruzado o cóncavo no es una hoja. */
function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) continue;
    const s = cross > 0 ? 1 : -1;
    if (!sign) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

/** Envolvente convexa (cadena monótona de Andrew). */
function convexHull(pts) {
  if (pts.length < 4) return pts;
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Recorta la envolvente a `max` vértices: el ajuste de abajo es cúbico. */
function decimateHull(hull, max = 44) {
  if (hull.length <= max) return hull;
  const out = [];
  const step = hull.length / max;
  for (let i = 0; i < max; i++) out.push(hull[Math.floor(i * step)]);
  return out;
}

/**
 * Cuadrilátero de área máxima inscrito en un polígono convexo: para cada par de
 * vértices tomados como diagonal, el mejor vértice a cada lado.
 */
function maxAreaQuad(hull) {
  const n = hull.length;
  if (n < 4) return null;
  if (n === 4) return [...hull];
  const tri = (a, b, c) => Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  let best = null, bestArea = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      let p = -1, pa = 0;
      for (let k = i + 1; k < j; k++) {
        const a = tri(hull[i], hull[k], hull[j]);
        if (a > pa) { pa = a; p = k; }
      }
      let q = -1, qa = 0;
      for (let k = j + 1; k < i + n; k++) {
        const a = tri(hull[j], hull[k % n], hull[i]);
        if (a > qa) { qa = a; q = k % n; }
      }
      if (p < 0 || q < 0) continue;
      if (pa + qa > bestArea) { bestArea = pa + qa; best = [hull[i], hull[p], hull[j], hull[q]]; }
    }
  }
  return best;
}

/** Corte de dos rectas dadas como normal unitaria + distancia (nx·x + ny·y = c). */
function intersect(l1, l2) {
  const det = l1.nx * l2.ny - l1.ny * l2.nx;
  if (Math.abs(det) < 1e-9) return null;
  return {
    x: (l1.c * l2.ny - l2.c * l1.ny) / det,
    y: (l1.nx * l2.c - l2.nx * l1.c) / det,
  };
}

// ─── Puntuación: ¿hay borde real debajo de los 4 lados? ──────────────────────

/**
 * Recorre un lado buscando, en una banda de ±`D.band` px, el píxel con el borde
 * más fuerte y mejor orientado (perpendicular al lado). Devuelve la fuerza media
 * y qué fracción del lado tiene borde de verdad.
 */
function sideSupport(a, b, ctx) {
  const { w, h, gx, gy, edge, edgeRef } = ctx;
  const len = dist(a, b);
  if (len < 2) return { mean: 0, coverage: 0 };
  const nx = -(b.y - a.y) / len;
  const ny = (b.x - a.x) / len;
  let sum = 0, hits = 0;
  for (let s = 0; s < D.samples; s++) {
    const t = (s + 0.5) / D.samples;
    const px = a.x + (b.x - a.x) * t;
    const py = a.y + (b.y - a.y) * t;
    let best = 0;
    for (let d = -D.band; d <= D.band; d++) {
      const x = Math.round(px + nx * d);
      const y = Math.round(py + ny * d);
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      const i = y * w + x;
      const m = edge[i];
      if (!m) continue;
      const g = Math.hypot(gx[i], gy[i]) || 1;
      const align = Math.abs((gx[i] * nx + gy[i] * ny) / g);
      const v = Math.min(1, m / edgeRef) * align;
      if (v > best) best = v;
    }
    sum += best;
    if (best >= D.hit) hits++;
  }
  return { mean: sum / D.samples, coverage: hits / D.samples };
}

/** Gris medio de una banda paralela al lado, `off` px hacia dentro (o fuera). */
function bandMean(a, b, off, ctx) {
  const { w, h, gray } = ctx;
  const len = dist(a, b);
  if (len < 2) return 0;
  const nx = -(b.y - a.y) / len;
  const ny = (b.x - a.x) / len;
  let sum = 0, n = 0;
  for (let s = 0; s < D.samples; s++) {
    const t = (s + 0.5) / D.samples;
    const x = Math.round(a.x + (b.x - a.x) * t + nx * off);
    const y = Math.round(a.y + (b.y - a.y) * t + ny * off);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    sum += gray[y * w + x];
    n++;
  }
  return n ? sum / n : 0;
}

/**
 * Valida y puntúa un candidato. Devuelve null si ni siquiera parece una hoja.
 *   `score` — cuánto borde real lo sostiene (es lo que decide si se acepta)
 *   `rank`  — el mismo score más un empujón por tamaño y por "esto es papel"
 *             (más claro por dentro que por fuera), solo para elegir entre varios.
 */
function scoreQuad(quad, ctx) {
  const { w, h } = ctx;
  if (!isConvex(quad)) return null;

  const areaRatio = quadArea(quad) / (w * h);
  if (areaRatio < D.minArea || areaRatio > D.maxArea) return null;

  const sides = [0, 1, 2, 3].map((i) => dist(quad[i], quad[(i + 1) % 4]));
  if (Math.min(...sides) < Math.min(w, h) * D.minSide) return null;
  if (ratio(sides[0], sides[2]) < D.minOpposite || ratio(sides[1], sides[3]) < D.minOpposite) return null;

  for (let i = 0; i < 4; i++) {
    const prev = quad[(i + 3) % 4], cur = quad[i], next = quad[(i + 1) % 4];
    const ax = prev.x - cur.x, ay = prev.y - cur.y;
    const bx = next.x - cur.x, by = next.y - cur.y;
    const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
    if (Math.abs(cos) > D.cornerCos) return null;
  }

  let mean = 0, worst = 1, worstCov = 1, inner = 0, outer = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4];
    const s = sideSupport(a, b, ctx);
    mean += s.mean / 4;
    if (s.mean < worst) worst = s.mean;
    if (s.coverage < worstCov) worstCov = s.coverage;
    inner += bandMean(a, b, D.band + 2, ctx) / 4;
    outer += bandMean(a, b, -(D.band + 2), ctx) / 4;
  }
  // Un lado que solo tiene borde a ratos es un lado inventado: no es una hoja.
  if (worstCov < D.coverage) return null;

  // Pesa más el lado peor que el promedio: los 4 lados tienen que existir.
  const score = 0.35 * mean + 0.45 * worst + 0.2 * worstCov;
  // Entre dos candidatos igual de sostenidos gana el más grande y el que parece
  // papel (más claro por dentro que por fuera): así se prefiere el borde de la
  // hoja antes que un recuadro interior formado por los renglones del texto.
  const paper = clamp((inner - outer) / 50, -1, 1);
  return { quad, score, areaRatio, rank: score + 0.18 * areaRatio + 0.1 * paper };
}

/**
 * Afina el cuadrilátero: ajusta cada lado por mínimos cuadrados (PCA) a los
 * píxeles de borde que tiene al lado y vuelve a cortar las rectas. Sin esto las
 * esquinas quedan a merced de la resolución de Hough o del umbral de la mancha.
 */
function refineQuad(quad, ctx) {
  const { w, h, gx, gy, edge, edgeRef } = ctx;
  const lines = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i], b = quad[(i + 1) % 4];
    const len = dist(a, b);
    if (len < 8) return null;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    const steps = Math.max(24, Math.round(len));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      let bestV = 0, bx = 0, by = 0;
      for (let d = -D.band; d <= D.band; d++) {
        const x = Math.round(px + nx * d);
        const y = Math.round(py + ny * d);
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        const i2 = y * w + x;
        const m = edge[i2];
        if (!m) continue;
        const g = Math.hypot(gx[i2], gy[i2]) || 1;
        const v = m * Math.abs((gx[i2] * nx + gy[i2] * ny) / g);
        if (v > bestV) { bestV = v; bx = x; by = y; }
      }
      if (bestV < edgeRef * 0.4) continue;
      n++; sx += bx; sy += by; sxx += bx * bx; sxy += bx * by; syy += by * by;
    }
    if (n < 10) return null;
    const mx = sx / n, my = sy / n;
    const cxx = sxx / n - mx * mx;
    const cxy = sxy / n - mx * my;
    const cyy = syy / n - my * my;
    // Dirección principal de la nube de puntos = dirección del lado.
    const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const dx = Math.cos(theta), dy = Math.sin(theta);
    const lnx = -dy, lny = dx;
    lines.push({ nx: lnx, ny: lny, c: lnx * mx + lny * my });
  }
  // El vértice i es el cruce del lado que llega (i-1) con el que sale (i).
  const out = [];
  for (let i = 0; i < 4; i++) {
    const p = intersect(lines[(i + 3) % 4], lines[i]);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

/** Descarta el candidato si se sale del cuadro; si roza, lo mete dentro. */
function fitToFrame(quad, ctx) {
  const { w, h } = ctx;
  const mx = w * D.outside, my = h * D.outside;
  const out = [];
  for (const p of quad) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    if (p.x < -mx || p.x > w - 1 + mx || p.y < -my || p.y > h - 1 + my) return null;
    out.push({ x: clamp(p.x, 0, w - 1), y: clamp(p.y, 0, h - 1) });
  }
  return out;
}

// ─── Candidatos por rectas (Hough guiado por el gradiente) ───────────────────

function houghCandidates(ctx) {
  const { w, h, gx, gy, edge, edgeRef } = ctx;
  const minLen = Math.min(w, h) * D.minSide;
  // Umbral generoso a propósito: el filo del papel suele ser mucho más suave que
  // el texto o los objetos de la mesa, y si no vota aquí no se encuentra nunca.
  // Lo que separa un borde de verdad del ruido es que se repita en línea recta,
  // y de eso ya se encarga el propio Hough (y después la cobertura por lado).
  const th = Math.max(7, edgeRef * 0.5);

  let count = 0;
  for (let i = 0; i < edge.length; i++) if (edge[i] >= th) count++;
  if (count < 40) return [];
  const stride = Math.max(1, Math.ceil(count / HOUGH.maxPoints));

  const nTheta = HOUGH.thetaBins;
  const step = Math.PI / nTheta;
  const cos = new Float32Array(nTheta);
  const sin = new Float32Array(nTheta);
  for (let t = 0; t < nTheta; t++) { cos[t] = Math.cos(t * step); sin[t] = Math.sin(t * step); }

  const diag = Math.hypot(w, h);
  const nRho = Math.ceil((2 * diag) / HOUGH.rhoStep) + 1;
  const acc = new Float32Array(nTheta * nRho);

  let seen = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = edge[i];
      if (m < th) continue;
      if (seen++ % stride) continue;
      // Cada píxel solo vota por los ángulos cercanos al de SU gradiente (5 de
      // 90 casillas, no las 90): sale ~18 veces más barato que un Hough clásico
      // y además los picos quedan mucho más definidos.
      let a = Math.atan2(gy[i], gx[i]);
      if (a < 0) a += Math.PI;
      if (a >= Math.PI) a -= Math.PI;
      const base = Math.round(a / step);
      // El voto se satura en cuanto el borde es nítido. Es clave: si votara con
      // el contraste crudo, los renglones de texto (que contrastan muchísimo más
      // que el filo del papel) se quedarían con todos los picos y la hoja no
      // aparecería nunca. Así lo que decide un pico es LO LARGA que es la recta.
      const weight = Math.min(1, m / edgeRef);
      for (let k = -HOUGH.spread; k <= HOUGH.spread; k++) {
        const t = (base + k + nTheta) % nTheta;
        const rho = x * cos[t] + y * sin[t];
        const r = Math.round((rho + diag) / HOUGH.rhoStep);
        if (r < 0 || r >= nRho) continue;
        acc[t * nRho + r] += weight;
      }
    }
  }

  // Picos: máximos locales en (ángulo, distancia).
  let peak = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] > peak) peak = acc[i];
  if (peak <= 0) return [];
  const floor = peak * HOUGH.minPeak;
  const found = [];
  for (let t = 0; t < nTheta; t++) {
    for (let r = 1; r < nRho - 1; r++) {
      const v = acc[t * nRho + r];
      if (v < floor) continue;
      let isMax = true;
      for (let dt = -1; dt <= 1 && isMax; dt++) {
        const tt = (t + dt + nTheta) % nTheta;
        for (let dr = -3; dr <= 3; dr++) {
          if (!dt && !dr) continue;
          const rr = r + dr;
          if (rr < 0 || rr >= nRho) continue;
          if (acc[tt * nRho + rr] > v) { isMax = false; break; }
        }
      }
      if (isMax) found.push({ t, r, v });
    }
  }
  found.sort((a, b) => b.v - a.v);

  const lines = [];
  for (const p of found) {
    if (lines.length >= HOUGH.maxLines) break;
    // Nada de dos rectas prácticamente iguales.
    if (lines.some((l) => Math.abs(l.t - p.t) <= 2 && Math.abs(l.r - p.r) <= 4)) continue;
    lines.push({
      t: p.t,
      r: p.r,
      votes: p.v,
      nx: cos[p.t],
      ny: sin[p.t],
      c: p.r * HOUGH.rhoStep - diag,
    });
  }
  if (lines.length < 4) return [];

  // Pares de rectas casi paralelas y suficientemente separadas: los dos lados
  // opuestos de la hoja.
  const pairs = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const dot = lines[i].nx * lines[j].nx + lines[i].ny * lines[j].ny;
      if (Math.abs(dot) < 0.92) continue;
      const cj = dot >= 0 ? lines[j].c : -lines[j].c;
      const sep = Math.abs(lines[i].c - cj);
      if (sep < minLen) continue;
      pairs.push({ a: lines[i], b: lines[j], nx: lines[i].nx, ny: lines[i].ny, sep, votes: lines[i].votes + lines[j].votes });
    }
  }
  if (!pairs.length) return [];

  // Un par vale por lo votado que está y por lo SEPARADO que está. Lo segundo
  // es lo que hace ganar a los dos filos de la hoja frente a dos renglones de
  // texto: los lados de una hoja son los extremos de su familia de paralelas.
  let maxVotes = 0, maxSep = 0;
  for (const p of pairs) {
    if (p.votes > maxVotes) maxVotes = p.votes;
    if (p.sep > maxSep) maxSep = p.sep;
  }
  for (const p of pairs) p.rank = p.votes / (maxVotes || 1) + p.sep / (maxSep || 1);
  // Se conservan los mejores pares POR ORIENTACIÓN. Cortando la lista por votos
  // a secas, en una hoja con renglones los pares horizontales (muchos y muy
  // marcados) se quedan con todos los puestos y no sobra ni un par vertical con
  // el que armar el cuadrilátero: la hoja no se encuentra por falta de sitio.
  pairs.sort((p, q) => q.rank - p.rank);
  const byAngle = new Map();
  const top = [];
  for (const p of pairs) {
    if (top.length >= HOUGH.maxPairs) break;
    const bucket = Math.floor((Math.atan2(p.ny, p.nx) * 180) / Math.PI / 15) % 12;
    const used = byAngle.get(bucket) || 0;
    if (used >= HOUGH.perAngle) continue;
    byAngle.set(bucket, used + 1);
    top.push(p);
  }

  const out = [];
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const dot = top[i].nx * top[j].nx + top[i].ny * top[j].ny;
      if (Math.abs(dot) > 0.7) continue; // los dos pares deben cruzarse de frente
      const c1 = intersect(top[i].a, top[j].a);
      const c2 = intersect(top[i].a, top[j].b);
      const c3 = intersect(top[i].b, top[j].b);
      const c4 = intersect(top[i].b, top[j].a);
      if (!c1 || !c2 || !c3 || !c4) continue;
      out.push(orderQuad([c1, c2, c3, c4]));
    }
  }
  return out;
}

// ─── Candidatos por regiones claras (red de seguridad) ───────────────────────

/** Etiqueta las manchas de la máscara (4-vecinos, pila explícita). */
function labelRegions(mask, w, h) {
  const labels = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const sizes = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start] !== -1) continue;
    const label = sizes.length;
    let sp = 0, size = 0;
    stack[sp++] = start;
    labels[start] = label;
    while (sp > 0) {
      const p = stack[--sp];
      size++;
      const x = p % w;
      const y = (p / w) | 0;
      if (x > 0 && mask[p - 1] && labels[p - 1] === -1) { labels[p - 1] = label; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && labels[p + 1] === -1) { labels[p + 1] = label; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && labels[p - w] === -1) { labels[p - w] = label; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && labels[p + w] === -1) { labels[p + w] = label; stack[sp++] = p + w; }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

/**
 * Envolvente convexa de una mancha. Basta con el píxel más a la izquierda y el
 * más a la derecha de cada fila: cualquier otro cae entre esos dos, así que no
 * puede ser vértice de la envolvente.
 */
function regionHull(labels, target, w, h) {
  const pts = [];
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let lo = -1, hi = -1;
    for (let x = 0; x < w; x++) {
      if (labels[row + x] !== target) continue;
      if (lo < 0) lo = x;
      hi = x;
    }
    if (lo < 0) continue;
    pts.push({ x: lo, y });
    if (hi !== lo) pts.push({ x: hi, y });
  }
  return convexHull(pts);
}

function regionCandidates(ctx) {
  const { gray, w, h } = ctx;
  const out = [];
  const tried = new Set();
  // Varios umbrales: con papel y mesa parecidos, el que separa no es el de Otsu.
  for (const th of [otsuThreshold(gray), percentile(gray, 0.55), percentile(gray, 0.72)]) {
    if (th < 16 || th > 244 || tried.has(th)) continue;
    tried.add(th);
    const mask = new Uint8Array(w * h);
    let bright = 0;
    for (let i = 0; i < gray.length; i++) if (gray[i] > th) { mask[i] = 1; bright++; }
    const brightRatio = bright / (w * h);
    if (brightRatio < D.minArea * 0.7 || brightRatio > 0.97) continue;

    const { labels, sizes } = labelRegions(mask, w, h);
    let target = -1, size = 0;
    for (let i = 0; i < sizes.length; i++) if (sizes[i] > size) { size = sizes[i]; target = i; }
    if (target < 0 || size < w * h * D.minArea * 0.7) continue;

    const quad = maxAreaQuad(decimateHull(regionHull(labels, target, w, h)));
    if (!quad) continue;
    // La mancha tiene que LLENAR su cuadrilátero; si no, no era rectangular.
    const area = quadArea(quad);
    if (!area || size / area < 0.7) continue;
    out.push(orderQuad(quad));
  }
  return out;
}

// ─── Detección ───────────────────────────────────────────────────────────────

/**
 * Busca la hoja en un ImageData ya reducido.
 * Devuelve las 4 esquinas [tl, tr, br, bl] en píxeles de ESE ImageData, o null.
 */
export function detectDocumentInImageData(imageData) {
  const { data, width: w, height: h } = imageData;
  if (w < 40 || h < 40) return null;

  const gray = toGray(data, w, h);
  const { gx, gy, edge } = sobel(blur3(gray, w, h), w, h);
  const ctx = { w, h, gray, gx, gy, edge, edgeRef: clamp(otsuThreshold(edge), D.edgeFloor, D.edgeCeil) };

  let best = pickBest(houghCandidates(ctx), ctx);
  if (!best || best.score < D.good) {
    const alt = pickBest(regionCandidates(ctx), ctx);
    if (alt && (!best || alt.rank > best.rank)) best = alt;
  }
  return best && best.score >= D.accept ? best.quad : null;
}

/** Puntúa todos los candidatos y afina los mejores. */
function pickBest(candidates, ctx) {
  const scored = [];
  for (const q of candidates) {
    const fit = fitToFrame(q, ctx);
    const s = fit && scoreQuad(fit, ctx);
    if (s) scored.push(s);
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.rank - a.rank);
  let best = scored[0];
  for (const s of scored.slice(0, D.refine)) {
    const refined = refineQuad(s.quad, ctx);
    const fit = refined && fitToFrame(refined, ctx);
    const s2 = fit && scoreQuad(fit, ctx);
    if (s2 && s2.rank > best.rank) best = s2;
  }
  return best;
}

/**
 * Detecta la hoja en un `<video>`/`<canvas>`/`ImageBitmap` reduciéndolo primero.
 * Devuelve las esquinas en coordenadas RELATIVAS (0..1) para poder pintarlas
 * sobre el vídeo y reutilizarlas luego sobre la foto a resolución completa.
 */
export function detectDocument(source, sourceW, sourceH, work = D.work) {
  if (!sourceW || !sourceH) return null;
  const scale = work / sourceW;
  const w = Math.max(40, Math.round(sourceW * scale));
  const h = Math.max(40, Math.round(sourceH * scale));
  const canvas = getScratch(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const quad = detectDocumentInImageData(ctx.getImageData(0, 0, w, h));
  if (!quad) return null;
  return quad.map((p) => ({ x: p.x / (w - 1), y: p.y / (h - 1) }));
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

/** Dibuja un origen en un canvas nuevo del tamaño pedido, con buen filtrado. */
function paintScaled(source, w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d');
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  x.drawImage(source, 0, 0, w, h);
  return c;
}

/**
 * Reduce el origen ANTES de muestrearlo, de dos en dos.
 *
 * Sin esto, sacar una página de 3000 px de una foto de 12 MP significa leer un
 * píxel de cada tres y tirar los otros dos: los trazos finos caen ENTRE muestra y
 * muestra, así que el texto chico sale dentado o directamente desaparece. Bajando
 * a la mitad cada vez, cada paso promedia bloques de 2×2 con el filtrado nativo
 * del navegador y no se pierde nada por el camino.
 */
function downscaleSource(source, sw, sh, tw, th) {
  let cur = source, cw = sw, ch = sh;
  while (cw > tw * 2 && ch > th * 2) {
    cw = Math.max(tw, Math.round(cw / 2));
    ch = Math.max(th, Math.round(ch / 2));
    cur = paintScaled(cur, cw, ch);
  }
  return cw === tw && ch === th ? cur : paintScaled(cur, tw, th);
}

/**
 * Lado mayor de la página que se genera. A4 a 3000 px son ~255 ppp: por debajo
 * de eso un OCR empieza a fallar con la letra chica y con los números.
 */
export const PAGE_MAX_SIDE = 3000;

/**
 * Recorta el cuadrilátero de `source` y lo endereza en un canvas nuevo.
 * `quad` en coordenadas relativas (0..1). `maxSide` limita el tamaño de salida.
 */
export function warpDocument(source, sourceW, sourceH, quad, maxSide = PAGE_MAX_SIDE) {
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

  // Si la hoja se está achicando (foto de muchos megapíxeles, o cámara lejos),
  // se prefiltra el origen hasta la escala a la que se va a muestrear.
  const shrink = Math.sqrt(quadArea(src) / (dw * dh));
  let sw = sourceW, sh = sourceH, sample = source;
  if (shrink > 1.25) {
    sw = Math.max(8, Math.round(sourceW / shrink));
    sh = Math.max(8, Math.round(sourceH / shrink));
    sample = downscaleSource(source, sourceW, sourceH, sw, sh);
  }
  const kx = (sw - 1) / (sourceW - 1);
  const ky = (sh - 1) / (sourceH - 1);

  // Origen completo en memoria para poder muestrear píxel a píxel.
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = sw;
  srcCanvas.height = sh;
  const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(sample, 0, 0, sw, sh);
  const sdata = sctx.getImageData(0, 0, sw, sh).data;

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
      const u = ((a * x + bb * y + c) / den) * kx;
      const v = ((d * x + e * y + f) / den) * ky;
      const oi = (y * dw + x) * 4;
      if (u < 0 || v < 0 || u > sw - 1 || v > sh - 1) {
        o[oi] = o[oi + 1] = o[oi + 2] = 255;
        o[oi + 3] = 255;
        continue;
      }
      // Bilineal: sin esto los bordes de las letras quedan dentados.
      const x0 = u | 0, y0 = v | 0;
      const x1 = Math.min(x0 + 1, sw - 1);
      const y1 = Math.min(y0 + 1, sh - 1);
      const fx = u - x0, fy = v - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
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

/** Rejilla con la que se estima la luz del papel (celdas por el lado mayor). */
const LIGHT_CELLS = 16;
/** Celdas alrededor que se miran para tapar una mancha grande (ver abajo). */
const LIGHT_REACH = 2;

/** Máximo (o mínimo, con `sign` = -1) del vecindario de cada celda. */
function morphGrid(src, gw, gh, sign) {
  const out = new Float32Array(gw * gh);
  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      let best = -Infinity;
      for (let dy = -LIGHT_REACH; dy <= LIGHT_REACH; dy++) {
        const yy = cy + dy;
        if (yy < 0 || yy >= gh) continue;
        for (let dx = -LIGHT_REACH; dx <= LIGHT_REACH; dx++) {
          const xx = cx + dx;
          if (xx < 0 || xx >= gw) continue;
          const v = sign * src[yy * gw + xx];
          if (v > best) best = v;
        }
      }
      out[cy * gw + cx] = sign * best;
    }
  }
  return out;
}
const dilateGrid = (src, gw, gh) => morphGrid(src, gw, gh, 1);
const erodeGrid = (src, gw, gh) => morphGrid(src, gw, gh, -1);

/** Deja la rejilla en bruto lista para usarse (ver `paperLights`). */
function settleGrid(raw, gw, gh, cell) {
  // Cierre morfológico (primero el máximo del vecindario, después el mínimo).
  // El máximo solo tapa el hueco que dejó la mancha, y el mínimo deshace el
  // ensanchamiento: sin ese segundo paso la luz queda sobreestimada allí donde
  // la iluminación cae en degradado, y ese borde de la hoja sale negro.
  const grid = erodeGrid(dilateGrid(raw, gw, gh), gw, gh);

  // Suavizado 3×3: si no, se notan los escalones entre celdas en el fondo.
  const smooth = new Float32Array(gw * gh);
  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = cy + dy;
        if (yy < 0 || yy >= gh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = cx + dx;
          if (xx < 0 || xx >= gw) continue;
          s += grid[yy * gw + xx]; n++;
        }
      }
      smooth[cy * gw + cx] = s / n;
    }
  }
  return { grid: smooth, gw, gh, cell };
}

/**
 * Estima la LUZ DEL PAPEL de los tres canales: qué tan iluminado está el fondo
 * en cada zona de la hoja. Es lo que después permite quitar sombras y dejar el
 * papel blanco parejo.
 *
 * De cada celda se toma un valor ALTO (el percentil 85), no el promedio, porque
 * dentro de una celda el papel es lo más claro que hay: así el texto no arrastra
 * la estimación hacia abajo. Y luego cada celda se queda con el máximo de sus
 * vecinas: sin eso, una mancha de color más grande que la ventana —un sello, un
 * membrete, un resaltador— pasa a ser su propio "papel" y sale BLANCA. Era el
 * caso: el sello rojo desaparecía de la página.
 *
 * Los tres canales salen de UNA sola pasada: recorrer una foto de 6 MP tres
 * veces, una por canal, costaba un cuarto de segundo de más por página.
 */
function paperLights(data, w, h) {
  const cell = Math.max(8, Math.ceil(Math.max(w, h) / LIGHT_CELLS));
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  const raw = [new Float32Array(gw * gh), new Float32Array(gw * gh), new Float32Array(gw * gh)];
  const hist = [new Int32Array(256), new Int32Array(256), new Int32Array(256)];

  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      hist[0].fill(0); hist[1].fill(0); hist[2].fill(0);
      const y1 = Math.min(h, (cy + 1) * cell);
      const x1 = Math.min(w, (cx + 1) * cell);
      let n = 0;
      for (let y = cy * cell; y < y1; y++) {
        const row = y * w * 4;
        for (let x = cx * cell; x < x1; x++) {
          const p = row + x * 4;
          hist[0][data[p]]++;
          hist[1][data[p + 1]]++;
          hist[2][data[p + 2]]++;
          n++;
        }
      }
      for (let c = 0; c < 3; c++) {
        let acc = 0, v = 255;
        for (let t = 255; t >= 0; t--) {
          acc += hist[c][t];
          if (acc >= n * 0.15) { v = t; break; }
        }
        raw[c][cy * gw + cx] = v;
      }
    }
  }
  return raw.map((r) => settleGrid(r, gw, gh, cell));
}

/**
 * Luz del papel de TODA una fila (bilineal), volcada en `out`, para los tres
 * canales a la vez. Comparten rejilla, así que los índices y los pesos de la
 * interpolación se calculan UNA vez: repetirlos por canal costaba más que las
 * propias lecturas.
 */
function lightRows(lights, y, out) {
  const { gw, gh, cell } = lights[0];
  const fy = y / cell - 0.5;
  const y0 = clamp(Math.floor(fy), 0, gh - 1);
  const y1 = Math.min(gh - 1, y0 + 1);
  const ty = clamp(fy - y0, 0, 1);
  const ry0 = y0 * gw, ry1 = y1 * gw;
  for (let x = 0; x < out[0].length; x++) {
    const fx = x / cell - 0.5;
    const x0 = clamp(Math.floor(fx), 0, gw - 1);
    const x1 = Math.min(gw - 1, x0 + 1);
    const tx = clamp(fx - x0, 0, 1);
    for (let c = 0; c < 3; c++) {
      const g = lights[c].grid;
      const top = g[ry0 + x0] * (1 - tx) + g[ry0 + x1] * tx;
      const bot = g[ry1 + x0] * (1 - tx) + g[ry1 + x1] * tx;
      out[c][x] = Math.max(1, top * (1 - ty) + bot * ty);
    }
  }
}

/** Ajustes del tono. Ver `enhanceImageData`. */
const TONE = {
  paperLo: 0.80,     // ventana donde se busca el pico del papel (fracción de su luz)
  paperHi: 1.25,
  shoulder: 0.30,    // el papel termina donde el pico cae a esta fracción
  whiteMin: 0.86,    // …con topes, por si la página no tiene papel a la vista
  whiteMax: 0.995,
  blackPct: 0.004,   // el 0,4% más oscuro de la página ya es tinta
  blackMin: 0.06,
  blackMax: 0.45,
  gamma: 1.15,       // >1 oscurece los medios: el trazo gana cuerpo
  bnThreshold: 184,  // corte de blanco y negro, ya sobre el tono corregido
  sharpen: 0.55,     // fuerza de la máscara de enfoque
};

/** Curva del tono precalculada: `Math.pow` por píxel y canal cuesta segundos. */
const TONE_CURVE = (() => {
  const lut = new Uint8ClampedArray(1025);
  for (let i = 0; i <= 1024; i++) lut[i] = 255 * Math.pow(i / 1024, TONE.gamma);
  return lut;
})();

/**
 * Dónde deja de ser papel. El papel es un PICO del histograma alrededor de 1
 * (por construcción: ahí es donde se estimó su luz) y lo que interesa es el pie
 * de ese pico, no su centro: por debajo de ahí ya hay contenido.
 */
function paperWhite(hist) {
  const lo = Math.round(TONE.paperLo * 200);
  const hi = Math.min(255, Math.round(TONE.paperHi * 200));
  let peak = lo, peakN = -1;
  for (let b = lo; b <= hi; b++) if (hist[b] > peakN) { peakN = hist[b]; peak = b; }
  if (peakN <= 0) return TONE.whiteMax;
  const floor = peakN * TONE.shoulder;
  let b = peak;
  while (b > lo && hist[b] >= floor) b--;
  // Un poco de margen: el pie medido es donde el papel ya casi no aporta píxeles.
  return clamp((b + 1) / 200 - 0.01, TONE.whiteMin, TONE.whiteMax);
}

/** Dónde empieza a ser tinta: el percentil `blackPct` de la página. */
function inkBlack(hist, total) {
  const target = total * TONE.blackPct;
  let acc = 0;
  for (let b = 0; b < 256; b++) {
    acc += hist[b];
    if (acc >= target) return clamp(b / 200, TONE.blackMin, TONE.blackMax);
  }
  return TONE.blackMin;
}

/** Suavizado 3×3 separable en 8 bits (el de `blur3` da Float32: 4× la memoria). */
function blur3u8(src, w, h) {
  const tmp = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const l = x > 0 ? src[i - 1] : src[i];
      const r = x < w - 1 ? src[i + 1] : src[i];
      tmp[i] = (l + 2 * src[i] + r) * 0.25;
    }
  }
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const u = y > 0 ? tmp[i - w] : tmp[i];
      const d = y < h - 1 ? tmp[i + w] : tmp[i];
      out[i] = (u + 2 * tmp[i] + d) * 0.25;
    }
  }
  return out;
}

/**
 * Máscara de enfoque sobre el BRILLO: devuelve el filo que se pierde al reducir
 * la foto y al comprimirla en JPEG, que es justo lo que necesita un OCR para no
 * confundir un 8 con un 6. Va sobre la luminancia y no canal a canal para no
 * inventar colores en el borde de las letras.
 */
function unsharpLuma(d, w, h, amount) {
  const y = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < y.length; i++, p += 4) {
    y[i] = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000;
  }
  const soft = blur3u8(y, w, h);
  for (let i = 0, p = 0; i < y.length; i++, p += 4) {
    const k = amount * (y[i] - soft[i]);
    if (k > -1 && k < 1) continue;
    // `d` es Uint8ClampedArray: recorta a 0-255 él solo.
    d[p] += k;
    d[p + 1] += k;
    d[p + 2] += k;
  }
}

/**
 * Limpia la página escaneada. Trabaja sobre un ImageData y lo modifica en sitio
 * (`applyFilter` es la envoltura que lo saca del canvas y lo devuelve).
 *
 * El punto de partida es el mismo en los tres modos que tocan la imagen: se
 * divide CADA CANAL por la luz del papel de su zona (`paperLight`). Eso hace dos
 * cosas a la vez: se van las sombras del pulso y de la lámpara, y el papel queda
 * blanco NEUTRO (se corrige de paso el tinte cálido de la luz de interior).
 *
 * Que sea canal a canal —y no sobre el brillo, como antes— es lo que salva el
 * contenido que se distingue del papel por su COLOR pero apenas por su BRILLO:
 * los recuadros celestes de un formulario preimpreso, un sello pálido, una firma
 * azul clarita. Midiendo solo el brillo, todo eso caía dentro del papel.
 *
 * Después viene el tono, con los dos extremos sacados de la propia página:
 *   · BLANCO — el pie del pico del papel (`paperWhite`). Así el papel queda
 *     parejo, con su grano incluido, sin comerse lo que está apenas por debajo.
 *     Antes el corte era fijo: TODO lo que pasara del 90% del papel se iba a
 *     blanco puro, y con ello desaparecían los renglones y los recuadros tenues.
 *   · NEGRO  — el 0,4% más oscuro (`inkBlack`). La tinta sale negra de verdad y
 *     una hoja escrita a lápiz no se queda toda gris.
 * Entre medias, gamma 1,15: oscurece los medios, o sea que el trazo gana cuerpo.
 *
 * Modos: 'documento' conserva el color; 'gris' pasa a escala de grises; 'bn'
 * binariza (texto puro, archivo liviano); 'color' devuelve la foto sin tocar.
 */
export function enhanceImageData(img, mode = 'documento') {
  const { data: d, width: w, height: h } = img;
  if (mode === 'color' || w < 2 || h < 2) return img;

  const light = paperLights(d, w, h);
  const lr = [new Float32Array(w), new Float32Array(w), new Float32Array(w)];

  // ── Los dos extremos del tono, medidos sobre una muestra de la página ──────
  // Con una de cada `step` filas y columnas sobra para un percentil, y en una
  // foto de muchos megapíxeles ahorra la mayor parte del trabajo.
  const hist = new Int32Array(256);
  const step = Math.max(1, Math.round(Math.max(w, h) / 700));
  let seen = 0;
  for (let y = 0; y < h; y += step) {
    lightRows(light, y, lr);
    for (let x = 0; x < w; x += step) {
      const p = (y * w + x) * 4;
      const n = (299 * (d[p] / lr[0][x]) + 587 * (d[p + 1] / lr[1][x]) + 114 * (d[p + 2] / lr[2][x])) / 1000;
      hist[clamp(Math.round(n * 200), 0, 255)]++;
      seen++;
    }
  }
  const white = paperWhite(hist);
  const black = inkBlack(hist, seen);

  // El punto blanco se abre donde hay menos luz. El grano de la cámara son unos
  // pocos NIVELES, no un porcentaje, así que al dividir por la luz local ese
  // mismo grano pesa mucho más en la zona con sombra: con un punto blanco único
  // para toda la hoja, el lado sombreado sale gris sucio. Se mide en la parte
  // mejor iluminada (que es de donde sale `white`) y se ensancha en proporción.
  const margin = 1 - white;
  let refLight = 1;
  for (let i = 0; i < light[0].grid.length; i++) {
    const v = (299 * light[0].grid[i] + 587 * light[1].grid[i] + 114 * light[2].grid[i]) / 1000;
    if (v > refLight) refLight = v;
  }

  // ── Tono ──────────────────────────────────────────────────────────────────
  for (let y = 0; y < h; y++) {
    lightRows(light, y, lr);
    for (let x = 0; x < w; x++) {
      const local = (299 * lr[0][x] + 587 * lr[1][x] + 114 * lr[2][x]) / 1000;
      const span = clamp(1 - margin * (refLight / local), TONE.whiteMin, TONE.whiteMax) - black;
      // La curva va en línea (y no como función): serían millones de llamadas.
      const k = 1024 / span;
      const p = (y * w + x) * 4;
      const tr = (d[p] / lr[0][x] - black) * k;
      const tg = (d[p + 1] / lr[1][x] - black) * k;
      const tb = (d[p + 2] / lr[2][x] - black) * k;
      let r = tr <= 0 ? 0 : tr >= 1024 ? 255 : TONE_CURVE[tr | 0];
      let g = tg <= 0 ? 0 : tg >= 1024 ? 255 : TONE_CURVE[tg | 0];
      let b = tb <= 0 ? 0 : tb >= 1024 ? 255 : TONE_CURVE[tb | 0];
      if (mode !== 'documento') {
        const v = (r * 299 + g * 587 + b * 114) / 1000;
        r = g = b = mode === 'bn' ? (v >= TONE.bnThreshold ? 255 : 0) : v;
      }
      d[p] = r;
      d[p + 1] = g;
      d[p + 2] = b;
      d[p + 3] = 255;
    }
  }

  // En blanco y negro no: la máscara de enfoque solo dejaría halos grises.
  if (mode !== 'bn') unsharpLuma(d, w, h, TONE.sharpen);
  return img;
}

/** Limpia la página de un canvas (envoltura de `enhanceImageData`). */
export function applyFilter(canvas, mode = 'documento') {
  if (mode === 'color') return canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  enhanceImageData(img, mode);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// ─── Ayudas ──────────────────────────────────────────────────────────────────

/**
 * Calidad JPEG de las páginas. El servidor mete el JPEG en el PDF tal cual (no
 * recomprime), así que lo que se elija aquí es lo que queda para siempre: a 0,85
 * la letra chica se empasta y el OCR empieza a equivocarse.
 */
export const PAGE_QUALITY = 0.92;

/** Las 4 esquinas del cuadro completo (cuando no se detecta hoja). */
export const FULL_QUAD = [
  { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
];

/** Canvas → Blob JPEG (lo que se sube al servidor como página). */
export function canvasToJpeg(canvas, quality = PAGE_QUALITY) {
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
