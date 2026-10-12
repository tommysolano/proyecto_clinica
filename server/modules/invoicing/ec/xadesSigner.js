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
const { DOMParser } = require('@xmldom/xmldom');
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
/**
 * `opciones.ruc`: RUC que emite. Si el .p12 trae VARIOS certificados con clave (p. ej. el
 * de persona natural y el de representante legal de la empresa, de la misma persona), se
 * prefiere el que lleva ese RUC: es el único que el SRI acepta para ese emisor.
 */
function loadP12(p12Buffer, password, opciones = {}) {
  const p12Asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12Buffer.toString('binary')));
  const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);

  /**
   * LA CLAVE Y SU CERTIFICADO, EMPAREJADOS (oct-2026).
   *
   * Antes se tomaba la PRIMERA clave privada y el primer certificado que no fuera de una
   * autoridad. Los .p12 reales (Banco Central, Security Data…) traen la cadena entera y a
   * veces varias claves (firma y cifrado): si la clave usada no es la del certificado que va
   * en <ds:KeyInfo>, el SRI comprueba la firma con OTRA clave pública y responde «FIRMA
   * INVALIDA». Ahora el par se elige porque la clave pública del certificado ES la de la
   * clave privada; entre varios pares, el de firma (keyUsage / nombre «Signing Key»).
   */
  const keyBagsAll = [
    ...((p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]) || []),
    ...((p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]) || []),
  ].filter((b) => b && b.key);
  const certs = ((p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]) || [])
    .filter((b) => b && b.cert);

  if (!keyBagsAll.length || certs.length === 0) {
    throw new Error('El P12 no contiene clave privada y/o certificado');
  }

  const nombreBag = (b) => { try { return String(b?.attributes?.friendlyName?.[0] || ''); } catch { return ''; } };
  const esPareja = (k, c) => !!(k.key.n && c.cert.publicKey?.n && k.key.n.equals(c.cert.publicKey.n));
  const puntaje = (k, c) => {
    const ku = c.cert.getExtension('keyUsage');
    const bc = c.cert.getExtension('basicConstraints');
    let p = 0;
    if (ku && (ku.digitalSignature || ku.nonRepudiation)) p += 4;
    if (!bc || !bc.cA) p += 2;
    if (/sign|firma/i.test(nombreBag(k)) || /sign|firma/i.test(nombreBag(c))) p += 1;
    if (opciones.ruc && rucsDelCertificado(c.cert).includes(String(opciones.ruc).trim())) p += 8;
    return p;
  };
  const pares = [];
  for (const k of keyBagsAll) for (const c of certs) if (esPareja(k, c)) pares.push({ k, c, p: puntaje(k, c) });
  if (!pares.length) {
    throw new Error('El .p12 no tiene un certificado que corresponda a su clave privada: no se puede firmar. Vuelva a exportar el certificado de firma.');
  }
  pares.sort((a, b) => b.p - a.p);

  const certificate = pares[0].c.cert;
  const privateKey = pares[0].k.key;
  const certPem = forge.pki.certificateToPem(certificate);
  const keyPem = forge.pki.privateKeyToPem(privateKey);

  // IssuerName: E= → EMAILADDRESS=, en orden inverso, separados por coma+espacio
  // Mismo formato que valida el SRI (X500Principal RFC 2253, como ec-sri-invoice-signer):
  // orden inverso, separador «,» SIN espacio, E→EMAILADDRESS y OID para lo que no tiene nombre corto.
  const issuerName = certificate.issuer.attributes
    .slice()
    .reverse()
    .filter((a) => a.shortName || a.type)
    .map((a) => {
      const name = a.shortName === 'E' ? 'EMAILADDRESS' : a.shortName || a.type;
      return `${name}=${a.value}`;
    })
    .join(',');

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

/** 'YYYY-MM-DDTHH:mm:ss-05:00' en hora de Ecuador (UTC-5, sin horario de verano). */
function horaEcuador(fecha) {
  const ec = new Date(fecha.getTime() - 5 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${ec.getUTCFullYear()}-${p(ec.getUTCMonth() + 1)}-${p(ec.getUTCDate())}T${p(ec.getUTCHours())}:${p(ec.getUTCMinutes())}:${p(ec.getUTCSeconds())}-05:00`;
}

function sha1Base64(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('base64');
}

/**
 * Canonicaliza un nodo o cadena XML usando C14N (xml-c14n-20010315).
 * `ancestorNamespaces`: los namespaces que el nodo HEREDA de sus ancestros
 * ([{ prefix, namespaceURI }]). La C14N inclusiva los escribe en el nodo, y el SRI
 * canonicaliza así: sin pasarlos, el digest no coincide con el suyo.
 */
function canonicalize(xmlOrNode, ancestorNamespaces = []) {
  /**
   * EL ALGORITMO C14N, según la versión de xml-crypto (oct-2026).
   *
   * Hasta la v5 vivía en un mapa ESTÁTICO (`SignedXml.CanonicalizationAlgorithms`). Desde la
   * v6 —la que fija el package.json— ese mapa es de cada instancia y la clase se exporta
   * suelta (`C14nCanonicalization`). Leer el estático en la v6 daba
   * «Cannot read properties of undefined (reading '…xml-c14n-20010315')»: NINGUNA factura
   * llegaba a firmarse y el cobro terminaba en «Error al emitir factura».
   */
  const Algo = xmlCrypto.C14nCanonicalization
    || xmlCrypto.SignedXml?.CanonicalizationAlgorithms?.[C14N_URL];
  if (!Algo) throw new Error('No se encontró el algoritmo de canonicalización C14N en xml-crypto');
  const inst = new Algo();
  let node = xmlOrNode;
  if (typeof xmlOrNode === 'string') {
    node = new DOMParser().parseFromString(xmlOrNode, 'text/xml').documentElement;
  }
  return inst.process(node, { ancestorNamespaces });
}

/**
 * Firma un XML de factura/comprobante ya construido con `xmlBuilder`.
 *
 * @param {string} xml         - XML del comprobante (sin pretty-print)
 * @param {Buffer} p12Buffer   - contenido del archivo .p12
 * @param {string} p12Password - contraseña del P12
 * @returns {string} XML firmado
 */
function signXml(xmlEntrada, p12Buffer, p12Password) {
  /**
   * EL MISMO PROCESO QUE EL FIRMADOR QUE EL SRI ACEPTA (oct-2026).
   *
   * Rehecho siguiendo paso a paso el de micartaonline (basado en ec-sri-invoice-signer), que
   * factura en producción contra el SRI. El anterior reparseaba y re-serializaba el documento
   * entero con xmldom para meter la firma y el SRI la rechazaba con «FIRMA INVALIDA». Ahora:
   *  · el comprobante NO se toca: la firma se inserta como texto antes del cierre del raíz;
   *  · los digests de SignedProperties, KeyInfo y SignedInfo se calculan sobre su forma
   *    canónica, con los dos namespaces que heredan de <ds:Signature> (ds y etsi);
   *  · el digest del comprobante es la C14N del nodo id="comprobante" (sin la firma);
   *  · referencias en el orden del firmador probado: SignedProperties, Certificate, comprobante.
   */
  // El RUC del comprobante decide qué certificado del .p12 se usa (si trae varios).
  const rucEmisor = (String(xmlEntrada).match(/<ruc>(\d{13})<\/ruc>/) || [])[1];
  const cert = loadP12(p12Buffer, p12Password, { ruc: rucEmisor });
  const xml = String(xmlEntrada).trim().replace(/\t|\r/g, '');

  const raiz = detectarNodoRaiz(xml);
  if (!raiz) throw new Error('No se pudo determinar el nodo raíz del comprobante para insertar la firma.');
  const cierre = `</${raiz}>`;
  if (!xml.includes(cierre)) throw new Error(`El XML no tiene el cierre ${cierre}: no se puede insertar la firma.`);
  if (!new RegExp(`<${raiz}[^>]*\\sid="comprobante"`).test(xml)) {
    throw new Error(`El elemento <${raiz}> debe tener id="comprobante".`);
  }

  const numero = () => Math.floor(Math.random() * 900000) + 100000;
  const sigId = `Signature${numero()}`;
  const signedPropsId = `${sigId}-SignedProperties${numero()}`;
  const signedInfoId = `Signature-SignedInfo${numero()}`;
  const keyInfoId = `Certificate${numero()}`;
  const refPropsId = `SignedPropertiesID${numero()}`;
  const refDocId = `Reference-ID${numero()}`;
  const signatureValueId = `SignatureValue${numero()}`;
  const objectId = `${sigId}-Object${numero()}`;

  // Certificado (DER), su digest, y la clave pública como enteros sin signo.
  const certDer = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert.certificate)).getBytes(), 'binary');
  const certBase64 = certDer.toString('base64');
  const certDigest = sha1Base64(certDer);
  const sinSigno = (bi) => {
    const hex = bi.toString(16);
    return Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex').toString('base64');
  };
  const modulus = sinSigno(cert.certificate.publicKey.n);
  const exponent = sinSigno(cert.certificate.publicKey.e);
  const fechaFirma = horaEcuador(new Date());

  const NS = `xmlns:ds="${DSIG_NS}" xmlns:etsi="${XADES_NS}"`;
  // Forma canónica de un fragmento: con los namespaces que hereda de <ds:Signature>.
  const conNs = (fragmento, etiqueta) => fragmento.replace(`<${etiqueta}`, `<${etiqueta} ${NS}`);

  const signedProperties =
    `<etsi:SignedProperties Id="${signedPropsId}">` +
    '<etsi:SignedSignatureProperties>' +
    `<etsi:SigningTime>${fechaFirma}</etsi:SigningTime>` +
    '<etsi:SigningCertificate><etsi:Cert><etsi:CertDigest>' +
    `<ds:DigestMethod Algorithm="${SHA1_DIGEST}"></ds:DigestMethod>` +
    `<ds:DigestValue>${certDigest}</ds:DigestValue>` +
    '</etsi:CertDigest><etsi:IssuerSerial>' +
    `<ds:X509IssuerName>${textoCanonico(cert.issuerName)}</ds:X509IssuerName>` +
    `<ds:X509SerialNumber>${cert.serialNumberDecimal}</ds:X509SerialNumber>` +
    '</etsi:IssuerSerial></etsi:Cert></etsi:SigningCertificate>' +
    '</etsi:SignedSignatureProperties>' +
    '<etsi:SignedDataObjectProperties>' +
    `<etsi:DataObjectFormat ObjectReference="#${refDocId}">` +
    '<etsi:Description>contenido comprobante</etsi:Description>' +
    '<etsi:MimeType>text/xml</etsi:MimeType>' +
    '</etsi:DataObjectFormat>' +
    '</etsi:SignedDataObjectProperties>' +
    '</etsi:SignedProperties>';
  const digestSignedProps = sha1Base64(Buffer.from(conNs(signedProperties, 'etsi:SignedProperties'), 'utf8'));

  const keyInfo =
    `<ds:KeyInfo Id="${keyInfoId}">` +
    `<ds:X509Data><ds:X509Certificate>${certBase64}</ds:X509Certificate></ds:X509Data>` +
    '<ds:KeyValue><ds:RSAKeyValue>' +
    `<ds:Modulus>${modulus}</ds:Modulus>` +
    `<ds:Exponent>${exponent}</ds:Exponent>` +
    '</ds:RSAKeyValue></ds:KeyValue>' +
    '</ds:KeyInfo>';
  const digestKeyInfo = sha1Base64(Buffer.from(conNs(keyInfo, 'ds:KeyInfo'), 'utf8'));

  // Digest del comprobante: C14N del nodo id="comprobante" (aún sin firma).
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const digestDoc = sha1Base64(Buffer.from(canonicalize(doc.documentElement), 'utf8'));

  const signedInfo =
    `<ds:SignedInfo Id="${signedInfoId}">` +
    `<ds:CanonicalizationMethod Algorithm="${C14N_URL}"></ds:CanonicalizationMethod>` +
    `<ds:SignatureMethod Algorithm="${RSA_SHA1}"></ds:SignatureMethod>` +
    `<ds:Reference Id="${refPropsId}" Type="http://uri.etsi.org/01903#SignedProperties" URI="#${signedPropsId}">` +
    `<ds:DigestMethod Algorithm="${SHA1_DIGEST}"></ds:DigestMethod>` +
    `<ds:DigestValue>${digestSignedProps}</ds:DigestValue>` +
    '</ds:Reference>' +
    `<ds:Reference URI="#${keyInfoId}">` +
    `<ds:DigestMethod Algorithm="${SHA1_DIGEST}"></ds:DigestMethod>` +
    `<ds:DigestValue>${digestKeyInfo}</ds:DigestValue>` +
    '</ds:Reference>' +
    `<ds:Reference Id="${refDocId}" URI="#comprobante">` +
    '<ds:Transforms>' +
    '<ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></ds:Transform>' +
    `<ds:Transform Algorithm="${C14N_URL}"></ds:Transform>` +
    '</ds:Transforms>' +
    `<ds:DigestMethod Algorithm="${SHA1_DIGEST}"></ds:DigestMethod>` +
    `<ds:DigestValue>${digestDoc}</ds:DigestValue>` +
    '</ds:Reference>' +
    '</ds:SignedInfo>';

  const signedInfoCanonico = conNs(signedInfo, 'ds:SignedInfo');
  const signer = crypto.createSign('RSA-SHA1');
  signer.update(signedInfoCanonico, 'utf8');
  const signatureValue = signer.sign(cert.keyPem, 'base64');
  // Nunca se manda al SRI una firma que no se verifica con el certificado que la acompaña.
  const comprobacion = crypto.createVerify('RSA-SHA1');
  comprobacion.update(signedInfoCanonico, 'utf8');
  if (!comprobacion.verify(cert.certPem, signatureValue, 'base64')) {
    throw new Error('La firma no se puede verificar con el certificado del .p12 (clave y certificado no corresponden).');
  }

  const firma =
    `<ds:Signature ${NS} Id="${sigId}">` +
    signedInfo +
    `<ds:SignatureValue Id="${signatureValueId}">${signatureValue}</ds:SignatureValue>` +
    keyInfo +
    `<ds:Object Id="${objectId}">` +
    `<etsi:QualifyingProperties Target="#${sigId}">` +
    signedProperties +
    '</etsi:QualifyingProperties>' +
    '</ds:Object>' +
    '</ds:Signature>';

  // Insertada como TEXTO antes del cierre del raíz: el resto del comprobante queda intacto.
  const corte = xml.lastIndexOf(cierre);
  return xml.slice(0, corte) + firma + xml.slice(corte);
}

/** Comprobantes electrónicos del SRI, por su nodo raíz. */
const NODOS_RAIZ = ['factura', 'notaCredito', 'notaDebito', 'comprobanteRetencion', 'guiaRemision', 'liquidacionCompra'];

function detectarNodoRaiz(xml) {
  for (const nodo of NODOS_RAIZ) {
    if (new RegExp(`<${nodo}[\\s>]`).test(xml)) return nodo;
  }
  return null;
}

/** Texto en forma canónica C14N: & < > y \r escapados; las comillas no. */
function textoCanonico(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#xD;');
}

/**
 * EL RUC DEL CERTIFICADO, tal como lo lee el SRI (oct-2026).
 *
 * Las entidades certificadoras de Ecuador (Banco Central, Security Data, ANF…) guardan el
 * RUC del titular en una extensión propia cuyo OID termina en «.3.11». El SRI lo compara
 * con el RUC del comprobante y, si no es el mismo, responde «FIRMA INVALIDA … RucComprobante:
 * X RucCertificado: Y» aunque la firma sea perfecta. Devuelve los RUC encontrados ([] si el
 * certificado no trae esa extensión: entonces no se puede comprobar aquí).
 */
function rucsDelCertificado(certificate) {
  const rucs = new Set();
  for (const ext of certificate?.extensions || []) {
    if (!/\.3\.11$/.test(String(ext.id || ''))) continue;
    let texto = '';
    try {
      const asn1 = forge.asn1.fromDer(ext.value);
      texto = typeof asn1.value === 'string' ? asn1.value : '';
    } catch { texto = ''; }
    if (!texto) texto = String(ext.value || '');
    for (const m of texto.match(/\d{13}/g) || []) rucs.add(m);
  }
  return [...rucs];
}

module.exports = { signXml, loadP12, rucsDelCertificado };
