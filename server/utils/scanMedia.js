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
function crearReductor({
  ancho = 1200,
  calidad = 0.8,
  tope = 30000,
  fallosSeguidos = 5,
  // Cuánto se deja de intentar tras rendirse. NO es para siempre: al VPS le mata
  // el Chromium un pico de memoria puntual, y minutos después vuelve a abrirse sin
  // problema. Rendirse de por vida costó 3 GB de más en la tanda de septiembre —
  // las fotos se copiaron a tamaño completo hasta el final.
  descansoMs = 10 * 60 * 1000,
  // Cómo se abre el navegador. Se puede sustituir para probar qué pasa cuando
  // Chromium muere o se queda colgado, que es justo lo que hay que garantizar y
  // no se puede provocar con un Chromium de verdad.
  lanzar = null,
} = {}) {
  let navegador = null;
  let pagina = null;
  let fallos = 0;
  /** Hasta cuándo no se vuelve a intentar (0 = se puede intentar ya). */
  let descansaHasta = 0;

  async function preparar() {
    if (pagina) return pagina;
    const abrir = lanzar || (() => require('puppeteer').launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }));
    navegador = await abrir();
    // Si el navegador se cae —en este VPS lo mata el kernel por memoria— hay que
    // olvidarlo para que la siguiente foto abra uno nuevo. Sin esto se seguiría
    // usando una página muerta, cuyo `evaluate` NO falla: se queda esperando.
    navegador.on('disconnected', () => { navegador = null; pagina = null; });
    pagina = await navegador.newPage();
    return pagina;
  }

  async function cerrarNavegador() {
    const n = navegador;
    navegador = null;
    pagina = null;
    if (n) await n.close().catch(() => {});
  }

  /**
   * Un `evaluate` sobre un Chromium que acaba de morir no rechaza: se queda
   * colgado para siempre. Y colgado es MUCHO peor que fallado — en la tanda de
   * septiembre la importación se quedó clavada a las dos horas, con el latido
   * latiendo tan tranquilo y sin crear ni una ficha más, así que nada avisaba.
   * Con tope de tiempo, una foto que no vuelve se da por perdida y se sigue.
   */
  const conTope = (promesa) => Promise.race([
    promesa,
    new Promise((_, rechazar) => {
      const t = setTimeout(() => rechazar(new Error(`la reducción pasó de ${tope} ms`)), tope);
      t.unref?.();
    }),
  ]);

  return {
    async reducir(jpeg) {
      // Tras varios fallos seguidos se para un rato: insistir son 30 s tirados por
      // foto. Mientras descansa se copia tal cual —adjuntos más pesados, pero la
      // importación avanza— y pasado el descanso se vuelve a probar, porque lo
      // normal es que el navegador se pueda abrir otra vez.
      if (Date.now() < descansaHasta) return jpeg;
      try {
        const p = await conTope(preparar());
        const url = await conTope(p.evaluate(
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
        ));
        fallos = 0;
        const reducida = Buffer.from(url.split(',')[1], 'base64');
        return esJpeg(reducida) && reducida.length < jpeg.length ? reducida : jpeg;
      } catch (_) {
        // La página puede haber quedado inservible (navegador muerto): se suelta
        // para que la siguiente foto abra una nueva.
        pagina = null;
        fallos += 1;
        if (fallos >= fallosSeguidos) {
          descansaHasta = Date.now() + descansoMs;
          fallos = 0;
          await cerrarNavegador();
        }
        return jpeg;
      }
    },
    cerrar: cerrarNavegador,
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
