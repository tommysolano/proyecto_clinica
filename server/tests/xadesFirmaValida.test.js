/**
 * LA FIRMA XAdES DE LAS FACTURAS ES VÁLIDA (oct-2026).
 *
 * Dos fallos que convivían y que este test no deja volver:
 *  1. Con xml-crypto v6 el firmador leía el algoritmo C14N de un mapa estático que ya no
 *     existe: ninguna factura llegaba a firmarse («Error al emitir factura»).
 *  2. Los fragmentos (KeyInfo, SignedProperties, SignedInfo) se canonicalizaban sin los
 *     namespaces que heredan de <ds:Signature>: los digests y la firma no coincidían con
 *     los que calcula un verificador estándar (el del SRI), que la rechazaría.
 *
 * Se verifica con la propia xml-crypto (verificador independiente del firmador) y, a mano,
 * cada digest y la firma RSA sobre el documento firmado final.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const forge = require('node-forge');
const { SignedXml, C14nCanonicalization } = require('xml-crypto');
const { DOMParser } = require('@xmldom/xmldom');
const { signXml } = require('../modules/invoicing/ec/xadesSigner');
const { buildFacturaXml } = require('../modules/invoicing/ec/xmlBuilder');

const DS = 'http://www.w3.org/2000/09/xmldsig#';

function certificado() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 300 * 86400000);
  cert.setSubject([{ name: 'commonName', value: 'CLINICA PRUEBA' }]);
  cert.setIssuer([{ name: 'commonName', value: 'CLINICA PRUEBA' }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], 'clave', { algorithm: '3des' })).getBytes(), 'binary');
  return { p12, certPem: forge.pki.certificateToPem(cert), publicPem: forge.pki.publicKeyToPem(keys.publicKey) };
}

function facturaXml() {
  return buildFacturaXml({
    infoTributaria: {
      ambiente: '1', tipoEmision: '1', razonSocial: 'CLÍNICA ÑANDÚ & ASOCIADOS', ruc: '0999999999001',
      claveAcceso: '1'.repeat(49), codDoc: '01', estab: '001', ptoEmi: '001', secuencial: '000000001', dirMatriz: 'Av. Test',
    },
    infoFactura: {
      fechaEmision: '12/10/2026', dirEstablecimiento: 'Av. Test', obligadoContabilidad: 'SI',
      tipoIdentificacionComprador: '07', razonSocialComprador: 'CONSUMIDOR FINAL', identificacionComprador: '9999999999999',
      totalSinImpuestos: 20, totalDescuento: 0,
      totalConImpuestos: [{ codigo: '2', codigoPorcentaje: '0', baseImponible: 20, valor: 0 }],
      propina: 0, importeTotal: 20, moneda: 'DOLAR',
      pagos: [{ formaPago: '01', total: 20, plazo: 0, unidadTiempo: 'dias' }],
    },
    detalles: [{
      codigoPrincipal: 'C1', descripcion: 'Consulta médica', cantidad: 1, precioUnitario: 20, descuento: 0,
      precioTotalSinImpuesto: 20, impuestos: [{ codigo: '2', codigoPorcentaje: '0', tarifa: 0, baseImponible: 20, valor: 0 }],
    }],
    infoAdicional: [{ nombre: 'Email', valor: 'paciente@correo.com' }],
  });
}

/** Namespaces que un nodo hereda de sus ancestros (C14N inclusiva los escribe). */
function heredados(node) {
  const out = [];
  const vistos = new Set();
  for (let p = node.parentNode; p && p.nodeType === 1; p = p.parentNode) {
    for (const a of Array.from(p.attributes || [])) {
      if (a.name !== 'xmlns' && !a.name.startsWith('xmlns:')) continue;
      const prefix = a.name === 'xmlns' ? '' : a.name.slice(6);
      if (!vistos.has(prefix)) { vistos.add(prefix); out.push({ prefix, namespaceURI: a.value }); }
    }
  }
  return out;
}

test('la factura firmada pasa la verificación de xml-crypto', () => {
  const { p12, certPem } = certificado();
  const firmado = signXml(facturaXml(), p12, 'clave');
  const doc = new DOMParser().parseFromString(firmado, 'text/xml');
  const v = new SignedXml({ publicCert: certPem });
  v.loadSignature(doc.getElementsByTagNameNS(DS, 'Signature')[0]);
  assert.equal(v.checkSignature(firmado), true);
});

test('cada digest y la firma RSA cuadran con la C14N inclusiva del documento final', () => {
  const { p12, publicPem } = certificado();
  const firmado = signXml(facturaXml(), p12, 'clave');
  const doc = new DOMParser().parseFromString(firmado, 'text/xml');
  const c14n = (n) => new C14nCanonicalization().process(n, { ancestorNamespaces: heredados(n) });
  const porId = (id) => Array.from(doc.getElementsByTagName('*'))
    .find((e) => e.getAttribute('Id') === id || e.getAttribute('id') === id);

  const signedInfo = doc.getElementsByTagNameNS(DS, 'SignedInfo')[0];
  const referencias = Array.from(signedInfo.getElementsByTagNameNS(DS, 'Reference'));
  assert.equal(referencias.length, 3);
  for (const r of referencias) {
    const id = r.getAttribute('URI').slice(1);
    let canon;
    if (id === 'comprobante') {
      const copia = new DOMParser().parseFromString(firmado, 'text/xml').documentElement;
      const sig = copia.getElementsByTagNameNS(DS, 'Signature')[0];
      sig.parentNode.removeChild(sig); // transformación enveloped-signature
      canon = new C14nCanonicalization().process(copia, {});
    } else {
      canon = c14n(porId(id));
    }
    const calculado = crypto.createHash('sha1').update(canon, 'utf8').digest('base64');
    assert.equal(calculado, r.getElementsByTagNameNS(DS, 'DigestValue')[0].textContent, `digest de #${id}`);
  }

  const valor = doc.getElementsByTagNameNS(DS, 'SignatureValue')[0].textContent.replace(/\s/g, '');
  const verif = crypto.createVerify('RSA-SHA1');
  verif.update(c14n(signedInfo), 'utf8');
  assert.equal(verif.verify(publicPem, valor, 'base64'), true, 'firma RSA de SignedInfo');
});
