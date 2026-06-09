/**
 * Firmador XAdES-BES para comprobantes electrónicos del SRI Ecuador.
 *
 * Particularidades requeridas por el SRI:
 *   - Algoritmo de firma: rsa-sha1
 *   - DigestMethod: sha1
 *   - Canonicalización: http://www.w3.org/TR/2001/REC-xml-c14n-20010315
 *   - Tres references: a #comprobante, a #Certificate y a #SignedProperties
 *   - SignedProperties con QualifyingProperties (XAdES 1.3.2)
 *   - IssuerName con E= renombrado a EMAILADDRESS=
 *   - Serial del certificado en notación decimal (BigInteger)
 *   - El XML resultante DEBE generarse sin pretty-print
 */

const forge = require('node-forge');
const crypto = require('crypto');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const xmlCrypto = require('xml-crypto');

const C14N_URL = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const SHA1_DIGEST = 'http://www.w3.org/2000/09/xmldsig#sha1';
const RSA_SHA1 = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1';
const XADES_NS = 'http://uri.etsi.org/01903/v1.3.2#';
const DSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';

/**
 * Lee y valida un certificado P12.
 * @returns {{ certPem: string, keyPem: string, certificate, privateKey,
 *             issuerName: string, serialNumberDecimal: string,
 *             validFrom: Date, validTo: Date, subject: string }}
 */
function loadP12(p12Buffer, password) {
  const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12Buffer.toString('binary')));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

  // Buscar la clave privada y el certificado de firma
  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyBag =
    keyBags[forge.pki.oids.pkcs8ShroudedKeyBag] &&
    keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0];

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certs = certBags[forge.pki.oids.certBag] || [];

  if (!keyBag || certs.length === 0) {
    throw new Error('El P12 no contiene clave privada y/o certificado');
  }

  // El certificado del firmante es el que tiene Key Usage para firma digital
  // y cuyo subject coincide con la clave; en la práctica suele ser el primero.
  let signerCert = certs[0].cert;
  for (const c of certs) {
    const bc = c.cert.getExtension('basicConstraints');
    if (!bc || !bc.cA) {
      signerCert = c.cert;
      break;
    }
  }

  const certificate = signerCert;
  const privateKey = keyBag.key;
  const certPem = forge.pki.certificateToPem(certificate);
  const keyPem = forge.pki.privateKeyToPem(privateKey);

  // IssuerName: E= → EMAILADDRESS=, en orden inverso, separados por coma+espacio
  const issuerName = certificate.issuer.attributes
    .map((a) => {
      const name = a.shortName === 'E' ? 'EMAILADDRESS' : a.shortName || a.name;
      return `${name}=${a.value}`;
    })
    .reverse()
    .join(', ');

  // Serial en decimal usando node-forge
  const serialNumberDecimal = new forge.jsbn.BigInteger(certificate.serialNumber, 16).toString(10);

  const subject = certificate.subject.attributes
    .map((a) => `${a.shortName || a.name}=${a.value}`)
    .join(', ');

  const subjectAttribs = {};
  certificate.subject.attributes.forEach((a) => {
    if (a.shortName) subjectAttribs[a.shortName] = a.value;
    if (a.name) subjectAttribs[a.name] = a.value;
  });

  return {
    certPem,
    keyPem,
    certificate,
    privateKey,
    issuerName,
    serialNumberDecimal,
    validFrom: certificate.validity.notBefore,
    validTo: certificate.validity.notAfter,
    subject,
    subjectAttribs,
  };
}

function sha1Base64(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('base64');
}

/**
 * Canonicaliza un nodo o cadena XML usando C14N (xml-c14n-20010315).
 */
function canonicalize(xmlOrNode) {
  const c14n = new xmlCrypto.SignedXml().getCanonicalizationAlgorithm
    ? null
    : null;
  // xml-crypto expone CanonicalizationAlgorithms como mapa
  const Algo = xmlCrypto.SignedXml.CanonicalizationAlgorithms[C14N_URL];
  const inst = new Algo();
  let node = xmlOrNode;
  if (typeof xmlOrNode === 'string') {
    node = new DOMParser().parseFromString(xmlOrNode, 'text/xml').documentElement;
  }
  return inst.process(node);
}

/**
 * Firma un XML de factura/comprobante ya construido con `xmlBuilder`.
 *
 * @param {string} xml         - XML del comprobante (sin pretty-print)
 * @param {Buffer} p12Buffer   - contenido del archivo .p12
 * @param {string} p12Password - contraseña del P12
 * @returns {string} XML firmado
 */
function signXml(xml, p12Buffer, p12Password) {
  const cert = loadP12(p12Buffer, p12Password);

  // Cargar XML
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const rootEl = doc.documentElement;

  // El nodo a firmar: <factura id="comprobante">
  if (!rootEl.getAttribute('id')) {
    rootEl.setAttribute('id', 'comprobante');
  }

  // IDs únicos
  const ts = Date.now();
  const sigId = `Signature${ts}`;
  const signedInfoId = `${sigId}-SignedInfo`;
  const signedPropsId = `${sigId}-SignedProperties`;
  const keyInfoId = `Certificate${ts}`;
  const objectId = `${sigId}-Object`;
  const signatureValueId = `${sigId}-SignatureValue`;
  const refCertId = `Reference-ID-Cert-${ts}`;
  const refPropsId = `Reference-ID-Props-${ts}`;
  const refDocId = `Reference-ID-Doc-${ts}`;

  // Certificado en base64 (DER)
  const certDer = Buffer.from(
    forge.asn1.toDer(forge.pki.certificateToAsn1(cert.certificate)).getBytes(),
    'binary'
  );
  const certBase64 = certDer.toString('base64');
  const certDigest = sha1Base64(certDer);

  // Modulus + Exponent
  const modulus = Buffer.from(cert.certificate.publicKey.n.toByteArray()).toString('base64');
  const exponent = Buffer.from(cert.certificate.publicKey.e.toByteArray()).toString('base64');

  const fechaFirma = new Date().toISOString();

  // Construcción manual de la firma (xmlbuilder2 es más limpio pero tenemos que
  // mezclarla en el documento existente). Construimos los fragmentos como string
  // y los parseamos.

  // 1. SignedProperties — se firma su forma canonicalizada
  const signedPropertiesXml =
    `<etsi:SignedProperties Id="${signedPropsId}">` +
    `<etsi:SignedSignatureProperties>` +
    `<etsi:SigningTime>${fechaFirma}</etsi:SigningTime>` +
    `<etsi:SigningCertificate>` +
    `<etsi:Cert>` +
    `<etsi:CertDigest>` +
    `<ds:DigestMethod Algorithm="${SHA1_DIGEST}"></ds:DigestMethod>` +
    `<ds:DigestValue>${certDigest}</ds:DigestValue>` +
    `</etsi:CertDigest>` +
    `<etsi:IssuerSerial>` +
    `<ds:X509IssuerName>${escapeXml(cert.issuerName)}</ds:X509IssuerName>` +
    `<ds:X509SerialNumber>${cert.serialNumberDecimal}</ds:X509SerialNumber>` +
    `</etsi:IssuerSerial>` +
    `</etsi:Cert>` +
    `</etsi:SigningCertificate>` +
    `</etsi:SignedSignatureProperties>` +
    `<etsi:SignedDataObjectProperties>` +
    `<etsi:DataObjectFormat ObjectReference="#${refDocId}">` +
    `<etsi:Description>contenido comprobante</etsi:Description>` +
    `<etsi:MimeType>text/xml</etsi:MimeType>` +
    `</etsi:DataObjectFormat>` +
    `</etsi:SignedDataObjectProperties>` +
    `</etsi:SignedProperties>`;

  // KeyInfo
  const keyInfoXml =
    `<ds:KeyInfo Id="${keyInfoId}">` +
    `<ds:X509Data>` +
    `<ds:X509Certificate>${certBase64}</ds:X509Certificate>` +
    `</ds:X509Data>` +
    `<ds:KeyValue>` +
    `<ds:RSAKeyValue>` +
    `<ds:Modulus>${modulus}</ds:Modulus>` +
    `<ds:Exponent>${exponent}</ds:Exponent>` +
    `</ds:RSAKeyValue>` +
    `</ds:KeyValue>` +
    `</ds:KeyInfo>`;

  // Para calcular los digests necesitamos los nodos canonicalizados con sus
  // namespaces correctos. Los envolvemos temporalmente en una raíz con los xmlns
  // declarados, luego sacamos el nodo interno.
  const signedPropertiesC14N = canonicalizeFragment(signedPropertiesXml, {
    'xmlns:etsi': XADES_NS,
    'xmlns:ds': DSIG_NS,
  });
  const digestSignedProps = sha1Base64(Buffer.from(signedPropertiesC14N, 'utf8'));

  const keyInfoC14N = canonicalizeFragment(keyInfoXml, { 'xmlns:ds': DSIG_NS });
  const digestKeyInfo = sha1Base64(Buffer.from(keyInfoC14N, 'utf8'));

  // Digest del documento (nodo factura completo, ya está bien declarado)
  const docC14N = canonicalize(rootEl);
  const digestDoc = sha1Base64(Buffer.from(docC14N, 'utf8'));

  // SignedInfo
  const signedInfoXml =
    `<ds:SignedInfo Id="${signedInfoId}">` +
    `<ds:CanonicalizationMethod Algorithm="${C14N_URL}"></ds:CanonicalizationMethod>` +
    `<ds:SignatureMethod Algorithm="${RSA_SHA1}"></ds:SignatureMethod>` +
    `<ds:Reference Id="${refCertId}" URI="#${keyInfoId}">` +
    `<ds:DigestMethod Algorithm="${SHA1_DIGEST}"></ds:DigestMethod>` +
    `<ds:DigestValue>${digestKeyInfo}</ds:DigestValue>` +
    `</ds:Reference>` +
    `<ds:Reference Id="${refPropsId}" Type="http://uri.etsi.org/01903#SignedProperties" URI="#${signedPropsId}">` +
    `<ds:DigestMethod Algorithm="${SHA1_DIGEST}"></ds:DigestMethod>` +
    `<ds:DigestValue>${digestSignedProps}</ds:DigestValue>` +
    `</ds:Reference>` +
    `<ds:Reference Id="${refDocId}" URI="#comprobante">` +
    `<ds:Transforms>` +
    `<ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></ds:Transform>` +
    `</ds:Transforms>` +
    `<ds:DigestMethod Algorithm="${SHA1_DIGEST}"></ds:DigestMethod>` +
    `<ds:DigestValue>${digestDoc}</ds:DigestValue>` +
    `</ds:Reference>` +
    `</ds:SignedInfo>`;

  // Canonicalizar SignedInfo y firmar con RSA-SHA1
  const signedInfoC14N = canonicalizeFragment(signedInfoXml, { 'xmlns:ds': DSIG_NS });
  const signer = crypto.createSign('RSA-SHA1');
  signer.update(signedInfoC14N, 'utf8');
  const signatureValue = signer.sign(cert.keyPem, 'base64');

  // Construir el bloque <ds:Signature> completo
  const signatureXml =
    `<ds:Signature xmlns:ds="${DSIG_NS}" xmlns:etsi="${XADES_NS}" Id="${sigId}">` +
    signedInfoXml +
    `<ds:SignatureValue Id="${signatureValueId}">${signatureValue}</ds:SignatureValue>` +
    keyInfoXml +
    `<ds:Object Id="${objectId}">` +
    `<etsi:QualifyingProperties Target="#${sigId}">` +
    signedPropertiesXml +
    `</etsi:QualifyingProperties>` +
    `</ds:Object>` +
    `</ds:Signature>`;

  // Insertar como último hijo del elemento raíz
  const sigDoc = new DOMParser().parseFromString(signatureXml, 'text/xml');
  const sigNode = doc.importNode(sigDoc.documentElement, true);
  rootEl.appendChild(sigNode);

  return new XMLSerializer().serializeToString(doc);
}

/**
 * Canonicaliza un fragmento XML que aún no tiene declarados sus namespaces,
 * envolviéndolo en una raíz temporal con los xmlns indicados, canonicaliza, y
 * luego extrae solo la sección original.
 */
function canonicalizeFragment(fragmentXml, namespaces) {
  const nsAttrs = Object.entries(namespaces)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  const wrapped = `<wrapper ${nsAttrs}>${fragmentXml}</wrapper>`;
  const doc = new DOMParser().parseFromString(wrapped, 'text/xml');
  const inner = doc.documentElement.firstChild;
  return canonicalize(inner);
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case "'":
        return '&apos;';
      case '"':
        return '&quot;';
      default:
        return c;
    }
  });
}

module.exports = { signXml, loadP12 };
