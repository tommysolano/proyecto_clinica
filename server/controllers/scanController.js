/**
 * Escáner de documentos (/scanner).
 *
 * El navegador solo toma la foto (o coge la que sube el usuario) y la manda TAL
 * CUAL como JPEG: no busca el borde del documento, no corrige la perspectiva y
 * no aplica filtros (ver client/src/utils/photoPage.js). Aquí se arman en un PDF
 * (una página A4 por imagen), se guarda en disco y se registra la ficha. Ojo:
 * como son fotos sin recortar, la imagen trae lo que rodea al documento; el
 * servidor no lo corrige.
 *
 * Se puede pedir UN SOLO PDF con todas las imágenes (lo de siempre) o UN PDF
 * POR IMAGEN — `mode=split` —, que es lo que hace falta cuando se sube una
 * tanda de fotos sueltas (cédulas, recetas…) y cada una es un documento aparte.
 *
 * NO hay tope de imágenes por documento. Una petición sí tiene tope (nginx corta
 * el cuerpo y multer no admite más de MAX_POR_ENVIO archivos), así que las tandas
 * grandes llegan en varios envíos: en `mode=split` cada envío crea sus PDF y en
 * un PDF único las páginas se van dejando en un apartado temporal (`sessionId`)
 * hasta que el último envío (`finish=true`) las junta en un solo archivo.
 *
 *   POST   /api/scans                 crear (multipart: pages[] + name + mode)
 *                                     (tandas grandes: varios envíos con startIndex,
 *                                      o sessionId + finish para un PDF único)
 *   GET    /api/scans                 listar los de la clínica
 *   GET    /api/scans/:id/download    descargar / ver uno
 *   POST   /api/scans/download-zip    descargar varios en un ZIP
 *   PATCH  /api/scans/:id             renombrar
 *   DELETE /api/scans/:id             eliminar (autor o admin)
 *   POST   /api/scans/delete-many     eliminar varios (autor o admin)
 *
 * Disponible para TODOS los roles: cualquiera de la clínica escanea y ve lo
 * escaneado por el resto (cada documento muestra quién lo hizo).
 */
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { pipeline } = require('stream/promises');
const crypto = require('crypto');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const ScannedDocument = require('../models/ScannedDocument');
// Se requiere para que `populate('createdBy')` encuentre el modelo registrado.
require('../models/User');
const { writeZipStream } = require('../utils/zip');
const { nameKeyOf, sanitizeName, defaultName } = require('../utils/scanNames');

const SCANS_DIR = path.join(__dirname, '..', 'storage', 'scans');
try { fs.mkdirSync(SCANS_DIR, { recursive: true }); } catch (_) {}

const clinicDir = (clinicId) => path.join(SCANS_DIR, String(clinicId || 'default'));

/**
 * Tope de una PETICIÓN, no del documento: nginx corta el cuerpo y multer no
 * admite más archivos de golpe. Un PDF puede tener las páginas que haga falta;
 * el cliente las manda por tandas de este tamaño (ver el apartado temporal).
 */
const MAX_POR_ENVIO = 40;
const OK_IMAGE_TYPES = ['image/jpeg', 'image/png'];

exports.uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: MAX_POR_ENVIO },
  fileFilter: (req, file, cb) => {
    if (OK_IMAGE_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Las páginas deben ser imágenes JPG o PNG'));
  },
}).array('pages', MAX_POR_ENVIO);

// ─── Apartado temporal de un PDF que llega en varias tandas ──────────────────
/**
 * Un PDF único con 300 páginas no cabe en una sola petición, pero tampoco se
 * puede ir armando: pdfkit escribe el archivo de una vez. Así que cada envío
 * deja sus imágenes aquí, numeradas por su posición real, y el último las junta.
 *
 * Vive dentro de storage/scans para que comparta disco con los PDF ya
 * guardados; `_tmp` nunca choca con una carpeta de clínica (son ObjectId).
 */
const STAGING_DIR = path.join(SCANS_DIR, '_tmp');
/** Un apartado abandonado (se cerró la pestaña a media tanda) se borra solo. */
const STAGING_TTL_MS = 6 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 30 * 60 * 1000;

/** Id de sesión que manda el cliente: solo se acepta si es inofensivo (no es una ruta). */
const validSessionId = (raw) => (/^[A-Za-z0-9_-]{6,64}$/.test(String(raw || '')) ? String(raw) : '');

const stagingDir = (clinicId, sessionId) =>
  path.join(STAGING_DIR, String(clinicId || 'default'), sessionId);

/** Borra los apartados que quedaron a medias. Se llama de vez en cuando, sin esperar. */
let lastSweep = 0;
async function sweepStaging() {
  if (Date.now() - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = Date.now();
  try {
    for (const clinic of await fsp.readdir(STAGING_DIR)) {
      const dir = path.join(STAGING_DIR, clinic);
      for (const session of await fsp.readdir(dir).catch(() => [])) {
        const target = path.join(dir, session);
        const stat = await fsp.stat(target).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > STAGING_TTL_MS) {
          await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
        }
      }
    }
  } catch (_) { /* no hay nada apartado todavía */ }
}

/**
 * Deja las imágenes de este envío en el apartado y devuelve cuántas hay ya.
 * El nombre es la POSICIÓN de la página (000012.img), así que el orden se
 * recupera ordenando por nombre aunque las tandas lleguen desordenadas.
 */
async function stagePages(clinicId, sessionId, files, startIndex) {
  const dir = stagingDir(clinicId, sessionId);
  await fsp.mkdir(dir, { recursive: true });
  for (const [i, file] of files.entries()) {
    await fsp.writeFile(path.join(dir, `${String(startIndex + i).padStart(6, '0')}.img`), file.buffer);
  }
  return (await fsp.readdir(dir)).length;
}

/** Las rutas de todo lo apartado, en el orden en que van dentro del PDF. */
async function stagedPaths(clinicId, sessionId) {
  const dir = stagingDir(clinicId, sessionId);
  const names = (await fsp.readdir(dir).catch(() => [])).filter((n) => n.endsWith('.img')).sort();
  return names.map((n) => path.join(dir, n));
}

// ─── Nombres ─────────────────────────────────────────────────────────────────
// Viven en utils/scanNames.js porque el importador de fichas escaneadas también
// los necesita para emparejar los PDF del ZIP con su ficha en la base.

/** Nombres ya ocupados en la clínica. `ignoreId` sirve al renombrar. */
async function takenNameKeys(clinicId, ignoreId = null) {
  const filter = { clinic: clinicId };
  if (ignoreId) filter._id = { $ne: ignoreId };
  // Sin `_id` la consulta se resuelve solo con el índice, sin ir a buscar los
  // documentos: se lee una vez por envío y una clínica tiene miles de escaneos.
  return new Set(
    (await ScannedDocument.find(filter).select('nameKey -_id').lean()).map((d) => d.nameKey)
  );
}

/**
 * Elige un nombre libre contra `taken` y lo APARTA (lo agrega al conjunto). Si
 * "Receta" ya existe prueba "Receta (2)", "Receta (3)"… hasta encontrar uno.
 *
 * Lo aparta para que una tanda de PDF —uno por imagen— reparta nombres
 * distintos entre sí con una sola consulta a la base, en vez de una por PDF.
 */
function allocateName(taken, base) {
  const clean = sanitizeName(base) || defaultName();
  const apartar = (n) => { taken.add(nameKeyOf(n)); return n; };
  if (!taken.has(nameKeyOf(clean))) return apartar(clean);
  /**
   * El tope de intentos sale de cuántos nombres hay ocupados, no de un número
   * fijo: como cada candidato es distinto, con `taken.size + 2` está garantizado
   * encontrar uno libre. Estaba clavado en 999 y era el ÚLTIMO tope escondido
   * del escáner: una clínica con mil escaneos del mismo nombre ("cedula")
   * empezaba a bautizar los siguientes con un sufijo aleatorio —"cedula
   * (51b51e)"— y, con muy mala suerte, dos iguales chocaban contra el índice
   * único y esa imagen se perdía.
   */
  const tope = taken.size + 2;
  for (let i = 2; i <= tope; i++) {
    const candidate = `${clean} (${i})`;
    if (!taken.has(nameKeyOf(candidate))) return apartar(candidate);
  }
  // Salida de emergencia: inalcanzable con el tope de arriba, se queda de red.
  return apartar(`${clean} (${crypto.randomBytes(3).toString('hex')})`);
}

/** Devuelve un nombre libre en la clínica (una consulta + reparto). */
async function uniqueName(clinicId, base, ignoreId = null) {
  return allocateName(await takenNameKeys(clinicId, ignoreId), base);
}

// ─── PDF ─────────────────────────────────────────────────────────────────────

/**
 * Arma el PDF EN DISCO: una página A4 por imagen, centrada y escalada sin
 * deformar. A4 en vez del tamaño exacto de la foto para que salga bien al
 * imprimir.
 *
 * Se escribe con un flujo, y cada imagen puede ser una ruta del apartado en vez
 * de un buffer: un documento de 300 páginas pesa cientos de MB y tener a la vez
 * el PDF entero y todas sus fotos en memoria era justo lo que impedía quitar el
 * tope de imágenes. Pasando rutas, pdfkit lee una, la incrusta y la suelta.
 */
function buildPdfTo(destPath, images, title) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, info: { Title: title } });
    const out = fs.createWriteStream(destPath);
    const A4 = { w: 595.28, h: 841.89 };
    const MARGIN = 18;
    let fallo = null;
    out.on('error', reject);
    out.on('finish', () => (fallo ? reject(fallo) : resolve()));
    doc.on('error', reject);
    doc.pipe(out);
    try {
      for (const img of images) {
        doc.addPage({ size: 'A4', margin: 0 });
        // Ruta en disco (tanda apartada) o buffer del propio envío.
        doc.image(typeof img === 'string' ? img : img.buffer, MARGIN, MARGIN, {
          fit: [A4.w - MARGIN * 2, A4.h - MARGIN * 2],
          align: 'center',
          valign: 'center',
        });
      }
      doc.end();
    } catch (e) {
      fallo = new Error(`No se pudo procesar una de las páginas: ${e.message}`);
      // Se corta el flujo: el archivo a medias no debe quedarse abierto (quien
      // llama lo borra). No se llama a doc.end(), que volvería a fallar.
      out.destroy();
      reject(fallo);
    }
  });
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

/**
 * Arma el PDF de `images` en disco y registra su ficha.
 *
 * `images` son rutas del apartado o buffers del propio envío (ver buildPdfTo).
 * Si algo falla después de escribir el archivo, se borra: una ficha sin archivo
 * se nota enseguida, pero un archivo sin ficha se queda ocupando disco para siempre.
 *
 * El nombre se reparte en memoria (allocateName), así que DOS peticiones a la vez
 * de la misma sucursal pueden elegir el mismo y chocar contra el índice único
 * {clinic, nameKey}. Al quitar el tope de imágenes eso pasó de raro a probable:
 * una tanda de 500 son decenas de peticiones y minutos de ventana. Ante un E11000
 * se vuelve a pedir nombre y se reintenta SOLO el registro, sin rehacer el PDF.
 */
async function storePdf({ clinicId, userId, name, images, renombrar = null }) {
  const dir = clinicDir(clinicId);
  await fsp.mkdir(dir, { recursive: true });
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.pdf`;
  const full = path.join(dir, filename);
  try {
    await buildPdfTo(full, images, name);
    const { size } = await fsp.stat(full);
    let intento = name;
    for (let n = 0; ; n++) {
      try {
        const doc = await ScannedDocument.create({
          clinic: clinicId,
          name: intento,
          nameKey: nameKeyOf(intento),
          filename,
          size,
          pages: images.length,
          createdBy: userId,
        });
        return doc.populate('createdBy', 'name');
      } catch (e) {
        // Solo el choque de nombre se reintenta; cualquier otro error sube tal cual.
        if (e?.code !== 11000 || !renombrar || n >= 5) throw e;
        intento = await renombrar(intento);
      }
    }
  } catch (e) {
    await fsp.unlink(full).catch(() => {});
    throw e;
  }
}

/** ¿Piden un PDF por imagen? Acepta `mode=split` o `split=true`. */
const wantsSplit = (body = {}) =>
  ['split', 'separado', 'true', '1'].includes(
    String(body.mode !== undefined ? body.mode : body.split || '').toLowerCase()
  );

/**
 * Nombre propio de cada imagen subida (`pageNames`, en el mismo orden que
 * `pages[]`), sin la extensión: es con lo que se bautiza cada PDF cuando el
 * usuario no escribió ningún nombre.
 */
function parsePageNames(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { arr = []; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((n) => String(n || '').replace(/\.(jpe?g|png|webp|heic|heif|gif|bmp|tiff?|pdf)$/i, ''));
}

/** ¿Es el último envío de una tanda? (`finish=true`) */
const isFinish = (body = {}) => ['true', '1', 'yes'].includes(String(body.finish || '').toLowerCase());

exports.createScan = async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) {
      return res.status(400).json({ message: 'Envía al menos una página escaneada' });
    }
    const base = sanitizeName(req.body.name);
    sweepStaging(); // sin await: limpiar apartados viejos no debe demorar el envío

    // ── Lo de siempre: todas las imágenes dentro de un mismo PDF ─────────────
    if (!wantsSplit(req.body)) {
      const sessionId = validSessionId(req.body.sessionId);

      // Sin sesión es un envío único (lo habitual: unas cuantas páginas).
      if (!sessionId) {
        const name = await uniqueName(req.clinicId, base || defaultName());
        const doc = await storePdf({ clinicId: req.clinicId, userId: req.user._id, name, images: files });
        return res.status(201).json(doc);
      }

      // Con sesión, el documento llega en varias tandas: se van apartando en
      // disco por su posición y solo el último envío arma el PDF.
      const desde = Math.max(0, parseInt(req.body.startIndex, 10) || 0);
      const apartadas = await stagePages(req.clinicId, sessionId, files, desde);
      if (!isFinish(req.body)) {
        return res.status(202).json({ staged: true, pages: apartadas, sessionId });
      }
      const rutas = await stagedPaths(req.clinicId, sessionId);
      try {
        if (!rutas.length) return res.status(400).json({ message: 'No quedó ninguna página del envío' });
        const name = await uniqueName(req.clinicId, base || defaultName());
        const doc = await storePdf({ clinicId: req.clinicId, userId: req.user._id, name, images: rutas });
        return res.status(201).json(doc);
      } finally {
        // El apartado se borra pase lo que pase: si el PDF falló, el cliente
        // todavía tiene las imágenes y reintenta con una sesión nueva.
        await fsp.rm(stagingDir(req.clinicId, sessionId), { recursive: true, force: true }).catch(() => {});
      }
    }

    // ── Un PDF por imagen ───────────────────────────────────────────────────
    // El nombre sale, por orden: del que escribió el usuario ("Receta 1",
    // "Receta 2"…), del nombre del archivo que subió, o del de por defecto.
    const taken = await takenNameKeys(req.clinicId);
    const propios = parsePageNames(req.body.pageNames);
    // Una tanda grande no cabe en una sola petición (nginx y multer la cortan),
    // así que el cliente la manda por partes: `startIndex` es cuántas imágenes
    // van ya, para que la numeración siga en 21, 22… y no vuelva a empezar en 1.
    const desde = Math.max(0, parseInt(req.body.startIndex, 10) || 0);
    const documents = [];
    const errores = [];
    /**
     * Las que NO se pudieron convertir, con su POSICIÓN dentro de este envío.
     *
     * El texto de `errores` no basta: el cliente necesita saber qué imagen fue
     * para dejarla en la rejilla y que el usuario la reintente. Antes se daban
     * por subidas todas y se borraban de la pantalla; con tandas de 500 fotos
     * eso es perder archivos que el usuario ya no sabe ni cuáles eran.
     */
    const fallidas = [];
    for (const [i, file] of files.entries()) {
      const n = desde + i + 1;
      const sugerido = base
        ? `${base} ${n}`
        : sanitizeName(propios[i]) || `${defaultName()} ${n}`;
      const name = allocateName(taken, sugerido);
      try {
        documents.push(await storePdf({
          clinicId: req.clinicId,
          userId: req.user._id,
          name,
          images: [file],
          // Si otro envío simultáneo se quedó con el nombre, se pide el siguiente
          // libre releyendo la base, en vez de perder esta imagen por un E11000.
          renombrar: async () => allocateName(await takenNameKeys(req.clinicId), sugerido),
        }));
      } catch (e) {
        // Una imagen rota no debe tirar abajo el resto de la tanda.
        errores.push(`Imagen ${n}: ${e.message}`);
        fallidas.push({
          index: i,                                   // posición DENTRO de este envío
          number: n,                                  // su número dentro de la tanda entera
          file: propios[i] || file.originalname || '', // para poder nombrarla al usuario
          message: e.message,
        });
      }
    }
    if (!documents.length) {
      return res.status(400).json({ message: `No se pudo generar ningún PDF. ${errores[0] || ''}`.trim() });
    }
    // `errors` se mantiene (texto suelto) por compatibilidad; `failed` es el que
    // permite al cliente conservar en pantalla justo las imágenes que fallaron.
    return res.status(201).json({ documents, count: documents.length, errors: errores, failed: fallidas });
  } catch (error) {
    res.status(400).json({ message: `No se pudo generar el PDF: ${error.message}` });
  }
};

exports.listScans = async (req, res) => {
  try {
    const { search = '', page = 1, limit = 20, mine } = req.query;
    const query = { clinic: req.clinicId };
    if (String(search).trim()) query.nameKey = { $regex: nameKeyOf(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
    if (mine === 'true' || mine === '1') query.createdBy = req.user._id;

    const perPage = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
    const skip = (Math.max(parseInt(page) || 1, 1) - 1) * perPage;
    const [docs, total] = await Promise.all([
      ScannedDocument.find(query)
        .populate('createdBy', 'name')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(perPage)
        .lean(),
      ScannedDocument.countDocuments(query),
    ]);
    res.json({ documents: docs, total, pages: Math.ceil(total / perPage) || 1, currentPage: Math.max(parseInt(page) || 1, 1) });
  } catch (error) {
    res.status(500).json({ message: 'Error al listar los documentos escaneados', error: error.message });
  }
};

/** Lee el PDF de disco; 404 si la ficha existe pero el archivo se perdió. */
async function readPdf(doc) {
  const file = path.join(clinicDir(doc.clinic), doc.filename);
  try {
    return await fsp.readFile(file);
  } catch {
    const err = new Error(`El archivo de "${doc.name}" ya no está en el servidor`);
    err.status = 404;
    throw err;
  }
}

exports.downloadScan = async (req, res) => {
  try {
    const doc = await ScannedDocument.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!doc) return res.status(404).json({ message: 'Documento no encontrado' });
    const file = path.join(clinicDir(doc.clinic), doc.filename);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat) {
      return res.status(404).json({ message: `El archivo de "${doc.name}" ya no está en el servidor` });
    }
    // `inline` para verlo en el visor del navegador; si no, se descarga.
    const disposition = req.query.inline === '1' ? 'inline' : 'attachment';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `${disposition}; filename="${sanitizeName(doc.name)}.pdf"`);
    // Se manda por flujo, no de una pieza: sin tope de páginas un documento
    // puede pesar cientos de MB y cargarlo entero en memoria tumbaría el backend.
    await pipeline(fs.createReadStream(file), res);
  } catch (error) {
    // Si la descarga ya empezó (se cortó a mitad) no hay respuesta que dar.
    if (res.headersSent) return;
    res.status(error.status || 500).json({ message: error.message });
  }
};

/**
 * Tamaño máximo de UN ZIP. Es por lo que se corta la descarga masiva en tandas
 * (ver `zipPlan`): un archivo de varios GB no lo quiere nadie, se tarda una
 * eternidad en bajarlo y si se corta a la mitad hay que empezar de cero.
 *
 * Ya no es un límite de memoria —el ZIP se manda por flujo, un archivo a la vez
 * (`writeZipStream`)—, pero sigue siendo un tope sensato: el formato ZIP clásico
 * tampoco pasa de 4 GB por campo.
 */
const MAX_ZIP_BYTES = 300 * 1024 * 1024;

/**
 * Descarga varios escaneos en un ZIP.
 *
 *   { ids: [...] }            los seleccionados
 *   { all: true, search }     TODOS los de la sucursal (respetando el buscador),
 *                             no solo los de la página que se está viendo
 */
/**
 * Traduce el cuerpo de la petición al filtro de Mongo. Lo comparten la descarga
 * y el planificador de partes: si cada uno armara el suyo, el plan podría contar
 * documentos que la descarga luego no incluye.
 *
 * Devuelve `null` si la selección está vacía (el que llama responde el 400).
 */
function filtroDeDescarga(req) {
  const todos = req.body.all === true || req.body.all === 'true';
  if (todos) {
    const filtro = { clinic: req.clinicId };
    // Mismo filtro que el listado: lo que el usuario ve buscado es lo que baja.
    const search = String(req.body.search || '').trim();
    if (search) filtro.nameKey = { $regex: nameKeyOf(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
    if (req.body.mine === true || req.body.mine === 'true') filtro.createdBy = req.user._id;
    return filtro;
  }
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (!ids.length) return null;
  return { _id: { $in: ids }, clinic: req.clinicId };
}

/**
 * ORDEN ESTABLE. `createdAt` a secas no basta: con miles de escaneos hay empates
 * —una tanda subida en el mismo segundo— y Mongo puede devolverlos en distinto
 * orden en dos consultas. Al partir la descarga en tandas, ese baile significaría
 * un documento repetido en una parte y ausente en otra. `_id` desempata.
 */
const ORDEN_DESCARGA = { createdAt: -1, _id: -1 };

/**
 * REPARTE los documentos en tandas que quepan en un ZIP.
 *
 * El corte es por PESO, no por cantidad: el ZIP se arma entero en memoria, así
 * que lo que de verdad manda es cuántos MB caben (`MAX_ZIP_BYTES`). Un documento
 * que por sí solo pase del tope va igualmente en su propia tanda: es eso o no
 * poder bajarlo nunca.
 */
function repartirEnTandas(docs, topeBytes) {
  const tandas = [];
  let actual = null;
  for (const d of docs) {
    const peso = d.size || 0;
    if (!actual || (actual.ids.length > 0 && actual.bytes + peso > topeBytes)) {
      actual = { ids: [], bytes: 0 };
      tandas.push(actual);
    }
    actual.ids.push(String(d._id));
    actual.bytes += peso;
  }
  return tandas;
}

/**
 * PLAN DE DESCARGA: en cuántos ZIP hay que partirlo y qué va en cada uno.
 *
 * Devuelve los IDS de cada tanda, no un "trae la página 3": así el navegador
 * pide exactamente los mismos documentos que se contaron aquí, y que alguien
 * escanee algo mientras se bajan las 25 partes no descoloca el reparto.
 *
 * Mismo cuerpo que `downloadZip` ({ ids } | { all, search, mine }).
 */
exports.zipPlan = async (req, res) => {
  try {
    const filtro = filtroDeDescarga(req);
    if (!filtro) return res.status(400).json({ message: 'Selecciona al menos un documento' });

    const docs = await ScannedDocument.find(filtro)
      .sort(ORDEN_DESCARGA)
      .select('_id size');
    if (!docs.length) {
      return res.status(404).json({ message: 'No hay documentos escaneados para descargar' });
    }

    const tandas = repartirEnTandas(docs, MAX_ZIP_BYTES);
    res.json({
      total: docs.length,
      totalBytes: docs.reduce((s, d) => s + (d.size || 0), 0),
      maxBytes: MAX_ZIP_BYTES,
      parts: tandas.map((t, i) => ({
        index: i + 1,
        count: t.ids.length,
        bytes: t.bytes,
        ids: t.ids,
      })),
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al planificar la descarga', error: error.message });
  }
};

exports.downloadZip = async (req, res) => {
  try {
    const filtro = filtroDeDescarga(req);
    if (!filtro) return res.status(400).json({ message: 'Selecciona al menos un documento' });

    const docs = await ScannedDocument.find(filtro).sort(ORDEN_DESCARGA);
    if (!docs.length) {
      return res.status(404).json({
        message: filtro._id
          ? 'No se encontraron los documentos seleccionados'
          : 'No hay documentos escaneados para descargar',
      });
    }

    // Se comprueba con el tamaño registrado ANTES de leer nada del disco: si no
    // cabe, hay que decirlo sin haber cargado cientos de MB en memoria.
    //
    // Un solo documento por encima del tope pasa igual: partirlo es imposible y
    // rechazarlo dejaría un archivo imposible de bajar desde aquí.
    const pesoTotal = docs.reduce((s, d) => s + (d.size || 0), 0);
    if (docs.length > 1 && pesoTotal > MAX_ZIP_BYTES) {
      return res.status(413).json({
        message: `Son ${(pesoTotal / 1048576).toFixed(0)} MB y el máximo por ZIP es ${MAX_ZIP_BYTES / 1048576} MB. `
          + 'Usa «Descargar todo por partes», que lo reparte solo en varios ZIP.',
      });
    }

    // Solo los NOMBRES se preparan por adelantado; los PDF se leen de uno en uno
    // mientras se escribe el ZIP (ver writeZipStream).
    const used = new Set();
    const entries = docs.map((doc) => {
      let entry = `${sanitizeName(doc.name)}.pdf`;
      // Dentro del ZIP tampoco puede haber dos entradas con el mismo nombre.
      let i = 2;
      while (used.has(entry.toLowerCase())) entry = `${sanitizeName(doc.name)} (${i++}).pdf`;
      used.add(entry.toLowerCase());
      return { name: entry, read: () => readPdf(doc) };
    });

    /**
     * El ZIP se manda POR FLUJO, no de una pieza.
     *
     * Armarlo entero en memoria eran ~600 MB de pico para una tanda de 300 MB
     * —los PDF, más la copia del `Buffer.concat`—, de sobra para dejar sin RAM al
     * servidor y tirar el backend para todos. Y como no salía un byte hasta
     * tenerlo todo, nginx cortaba por tiempo antes de empezar a descargar.
     *
     * A cambio: una vez enviada la primera cabecera ya no se puede responder un
     * error con código, de ahí el `headersSent` del catch.
     */
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="escaneos_${Date.now()}.zip"`);
    const escritos = await writeZipStream(entries, res);
    if (!escritos) {
      // Ni un solo archivo estaba en disco. Ya se mandaron las cabeceras, así que
      // lo que baja es un ZIP vacío VÁLIDO; el cliente avisa de que está vacío.
      console.warn('[escaner] ZIP vacío: ninguno de los %d documentos tenía archivo', docs.length);
    }
    // Se espera al vaciado de verdad: `end()` solo encola, y volver antes deja la
    // petición dada por terminada con trozos todavía en el búfer.
    await new Promise((resolve) => {
      res.end(resolve);
      // Si el navegador cancela la descarga, 'finish' no llega nunca.
      res.once('close', resolve);
      res.once('error', resolve);
    });
  } catch (error) {
    // Si la descarga ya empezó no hay respuesta que dar: cortar el socket es lo
    // único que le dice al navegador que el archivo quedó incompleto.
    if (res.headersSent) return res.destroy();
    res.status(500).json({ message: 'Error al preparar el ZIP', error: error.message });
  }
};

exports.renameScan = async (req, res) => {
  try {
    const doc = await ScannedDocument.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!doc) return res.status(404).json({ message: 'Documento no encontrado' });
    const clean = sanitizeName(req.body.name);
    if (!clean) return res.status(400).json({ message: 'El nombre no puede quedar vacío' });
    const name = await uniqueName(req.clinicId, clean, doc._id);
    doc.name = name;
    doc.nameKey = nameKeyOf(name);
    await doc.save();
    res.json(await doc.populate('createdBy', 'name'));
  } catch (error) {
    res.status(400).json({ message: `No se pudo renombrar: ${error.message}` });
  }
};

/**
 * Cada quien borra lo suyo; el admin (y el super-admin) borra cualquiera.
 *
 * Vive aquí y no dentro de cada endpoint porque el cliente decide con la MISMA
 * regla si pinta el botón de eliminar: si se cambia en un solo lado, el usuario
 * ve un botón que el servidor le rechaza (o al revés, no ve uno que sí podría).
 */
const puedeBorrar = (doc, req) =>
  req.role === 'admin'
  || !!req.user.isSuperAdmin
  || String(doc.createdBy) === String(req.user._id);

/** Borra el PDF del disco y su ficha. */
async function dropScan(doc) {
  await fsp.unlink(path.join(clinicDir(doc.clinic), doc.filename)).catch(() => {});
  await doc.deleteOne();
}

exports.deleteScan = async (req, res) => {
  try {
    const doc = await ScannedDocument.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!doc) return res.status(404).json({ message: 'Documento no encontrado' });
    if (!puedeBorrar(doc, req)) {
      return res.status(403).json({ message: 'Solo quien lo escaneó (o un administrador) puede eliminarlo' });
    }
    await dropScan(doc);
    res.json({ message: 'Documento eliminado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar el documento', error: error.message });
  }
};

/**
 * Elimina varios de una vez (limpiar una tanda que se subió mal).
 *
 * Los que el usuario no puede borrar NO tumban la operación: se borran los que
 * sí y los otros vuelven en `skipped` para poder decírselo por su nombre.
 */
exports.deleteManyScans = async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ message: 'Selecciona al menos un documento' });

    const docs = await ScannedDocument.find({ _id: { $in: ids }, clinic: req.clinicId });
    if (!docs.length) {
      return res.status(404).json({ message: 'No se encontraron los documentos seleccionados' });
    }

    let deleted = 0;
    const skipped = [];
    for (const doc of docs) {
      if (!puedeBorrar(doc, req)) { skipped.push(doc.name); continue; }
      await dropScan(doc);
      deleted++;
    }
    if (!deleted) {
      return res.status(403).json({ message: 'Solo quien los escaneó (o un administrador) puede eliminarlos' });
    }
    res.json({
      message: `${deleted} documento${deleted === 1 ? '' : 's'} eliminado${deleted === 1 ? '' : 's'}`,
      deleted,
      skipped,
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar los documentos', error: error.message });
  }
};

// Exportados para los tests.
exports._internals = {
  uniqueName, allocateName, takenNameKeys, parsePageNames, wantsSplit, isFinish, puedeBorrar,
  validSessionId, stagingDir, stagePages, stagedPaths,
  nameKeyOf, sanitizeName, defaultName, SCANS_DIR, STAGING_DIR, MAX_POR_ENVIO,
};
