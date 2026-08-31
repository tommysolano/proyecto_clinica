/**
 * PÁGINAS DE UN ESCANEO: sacarlas del PDF, reducirlas y volver a empaquetarlas.
 *
 * Los PDF de /scanner los arma `scanController.buildPdfTo` con pdfkit: una página
 * A4 por foto, y cada foto va incrustada TAL CUAL como JPEG (`/DCTDecode`). Eso
 * permite recuperar cada página sin decodificar el PDF entero ni depender de
 * ninguna herramienta externa: se localiza el objeto imagen y se copian sus bytes.
 *
 * Se usa al importar las fichas físicas (scripts/importPatientsFromScans.js), que
 * necesita dos cosas del escaneo:
 *   · la ÚLTIMA página (la «hoja de seguimiento») como observación del paciente;
 *   · una copia del documento completo para su historia clínica.
 *
 * ─── POR QUÉ SE REDUCEN LAS IMÁGENES ─────────────────────────────────────────
 * Las fotos vienen del móvil a 1688×3000 y pesan ~1 MB cada una. Copiar tal cual
 * los 6.000 escaneos de la tanda de agosto duplicaría los 12 GB que ya ocupa
 * storage/scans y llenaría el disco del VPS. A 1200 px de ancho la letra escrita
 * a mano se sigue leyendo y la página baja a ~120 KB. El ORIGINAL no se toca: sigue
 * intacto en storage/scans y en /scanner, que es la única prueba de lo que decía
 * el papel.
 *
 * La reducción la hace el Chromium de puppeteer, el mismo que ya imprime recetas
 * y RIDE: no añade dependencias nuevas (sharp obligaría a compilar en el VPS).
 * Se abre UN navegador para toda la tanda — abrirlo por ficha costaba 2 s de las
 * 6.000 fichas, casi cuatro horas de nada.
 */
const PDFDocument = require('pdfkit');

/** Un JPEG de verdad empieza por SOI (FF D8 FF); si no, el objeto no era una foto. */
const esJpeg = (buf) => buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;

/**
 * Los JPEG incrustados en el PDF, en orden de página.
 *
 * Solo se aceptan los `/DCTDecode` (JPEG). El escáner también admite PNG, que
 * pdfkit guarda comprimido con Flate: esos bytes no son una imagen utilizable
 * y se descartan aquí, así que quien llame verá menos páginas de las que tiene
 * el PDF y podrá avisar en vez de escribir un archivo corrupto.
 */
function paginasJpeg(buf) {
  const s = buf.toString('latin1');
  const paginas = [];
  const re = /\/Subtype\s*\/Image([\s\S]{0,600}?)stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const dict = m[1];
    if (!/\/DCTDecode/.test(dict)) continue;
    const len = Number((dict.match(/\/Length\s+(\d+)/) || [])[1]);
    if (!len) continue;
    const datos = buf.subarray(m.index + m[0].length, m.index + m[0].length + len);
    if (esJpeg(datos)) paginas.push(datos);
  }
  return paginas;
}

/**
 * Reductor de fotos. Abre el navegador la primera vez que se le pide algo y lo
 * mantiene abierto hasta `cerrar()`.
 *
 * `reducir` devuelve el JPEG reescalado, o el ORIGINAL si el navegador falla: en
 * una tanda de horas, quedarse sin adjunto es peor que guardar uno grande.
 */
function crearReductor({ ancho = 1200, calidad = 0.8 } = {}) {
  let navegador = null;
  let pagina = null;

  async function preparar() {
    if (pagina) return pagina;
    const puppeteer = require('puppeteer');
    navegador = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    pagina = await navegador.newPage();
    return pagina;
  }

  return {
    async reducir(jpeg) {
      try {
        const p = await preparar();
        const url = await p.evaluate(
          async (b64, w, q) => {
            const img = new Image();
            img.src = `data:image/jpeg;base64,${b64}`;
            await img.decode();
            // Una foto que ya es más pequeña que el objetivo no se toca: reescalarla
            // hacia arriba solo la haría pesar más sin añadir un solo detalle.
            const esc = Math.min(1, w / img.naturalWidth);
            const c = document.createElement('canvas');
            c.width = Math.round(img.naturalWidth * esc);
            c.height = Math.round(img.naturalHeight * esc);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            return c.toDataURL('image/jpeg', q);
          },
          jpeg.toString('base64'),
          ancho,
          calidad
        );
        const reducida = Buffer.from(url.split(',')[1], 'base64');
        return esJpeg(reducida) && reducida.length < jpeg.length ? reducida : jpeg;
      } catch (_) {
        return jpeg;
      }
    },
    async cerrar() {
      const n = navegador;
      navegador = null;
      pagina = null;
      if (n) await n.close().catch(() => {});
    },
  };
}

/**
 * Empaqueta unas páginas en un PDF, con el MISMO formato que el escáner (A4,
 * imagen centrada y escalada sin deformar), para que el documento adjunto a la
 * historia clínica se vea igual que el original.
 */
function pdfDePaginas(paginas, titulo = 'Ficha escaneada') {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, info: { Title: titulo } });
    const A4 = { w: 595.28, h: 841.89 };
    const MARGEN = 18;
    const trozos = [];
    doc.on('data', (t) => trozos.push(t));
    doc.on('end', () => resolve(Buffer.concat(trozos)));
    doc.on('error', reject);
    try {
      for (const jpeg of paginas) {
        doc.addPage({ size: 'A4', margin: 0 });
        doc.image(jpeg, MARGEN, MARGEN, {
          fit: [A4.w - MARGEN * 2, A4.h - MARGEN * 2],
          align: 'center',
          valign: 'center',
        });
      }
      doc.end();
    } catch (e) {
      reject(new Error(`No se pudo empaquetar el PDF: ${e.message}`));
    }
  });
}

module.exports = { paginasJpeg, crearReductor, pdfDePaginas, esJpeg };
