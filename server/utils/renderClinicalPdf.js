/** Genera un PDF clínico y libera Chromium incluso si falla el renderizado. */
async function renderClinicalPdf(html, options) {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    return Buffer.from(await page.pdf(options));
  } finally {
    await browser.close();
  }
}

module.exports = { renderClinicalPdf };
