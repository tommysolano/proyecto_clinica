const express = require('express');
const SignedDocumentVerification = require('../models/SignedDocumentVerification');
const router = express.Router();

router.get('/:token', async (req, res) => {
  if (!/^[a-f0-9]{48}$/.test(req.params.token)) return res.status(404).send('Documento no encontrado');
  try {
    const doc = await SignedDocumentVerification.findOne({ token: req.params.token }).lean();
    if (!doc) return res.status(404).send('Documento no encontrado');
    if (!/^[a-f0-9]{64}$/.test(doc.sha256)) throw new Error('Huella de documento inválida');
    res.set('Cache-Control', 'no-store');
    res.set('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    // La comparación se realiza en el navegador: el PDF no se envía al servidor.
    res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verificar documento</title><style>body{font:16px system-ui;max-width:42rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#243047}main{border:1px solid #cbd5e1;border-radius:12px;padding:1.5rem}input{max-width:100%}#resultado{font-weight:bold}</style></head><body><main><h1>Verificar documento</h1><p>Este código corresponde a un PDF firmado y registrado por el sistema.</p><p>Para comprobar que su archivo es exactamente el registrado, selecciónelo aquí. El archivo permanece en su dispositivo.</p><input type="file" id="archivo" accept="application/pdf"><p id="resultado" role="status"></p><p>El QR identifica el PDF registrado; por sí solo no permite detectar cambios en una copia impresa. Para revisar el certificado y la firma criptográfica, abra el PDF en un validador de firmas.</p></main><script>document.getElementById('archivo').addEventListener('change',async function(){const out=document.getElementById('resultado');try{if(!this.files[0]){out.textContent='';return}const hash=await crypto.subtle.digest('SHA-256',await this.files[0].arrayBuffer());const hex=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');out.textContent=hex==='${doc.sha256}'?'El archivo coincide con el PDF firmado registrado.':'El archivo no coincide con el PDF registrado.'}catch(e){out.textContent='No se pudo comprobar el archivo en este navegador.'}})</script></body></html>`);
  } catch (error) {
    console.error('Error consultando verificación de documento:', error.message);
    res.status(503).send('No se pudo consultar el documento. Inténtelo más tarde.');
  }
});

module.exports = router;
