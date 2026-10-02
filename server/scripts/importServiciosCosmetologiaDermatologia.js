/**
 * Da de alta en el inventario los servicios de COSMETOLOGÍA (IVA 15 %) y
 * DERMATOLOGÍA (IVA 0 %) de la lista de precios de oct-2026.
 *
 * - Crea (si faltan) las categorías contables SERVICIO «COSMETOLOGIA» y
 *   «DERMATOLOGIA», con ingreso en 4.1.2 Prestación de Servicios (la misma que
 *   SERVICIOS MEDICOS).
 * - `salePrice` es el PVP CON IVA (`priceIncludesVat: true`, como el resto del
 *   catálogo): la venta desglosa la base (44,85 / 1,15 = 39,00).
 * - Catálogo compartido: se crean en la sucursal dueña del catálogo (Central)
 *   y `availableInClinics` vacío = disponibles en todas las sucursales.
 * - Idempotente: casa por código; los que ya existen no se tocan.
 *
 * Uso:  node scripts/importServiciosCosmetologiaDermatologia.js            (simulación)
 *       node scripts/importServiciosCosmetologiaDermatologia.js --commit   (graba)
 * Después: node scripts/seedAppointmentServiceItems.js  (para que salgan al agendar)
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../models/Product');
const InventoryCategory = require('../models/InventoryCategory');
const ChartOfAccount = require('../models/ChartOfAccount');
const Clinic = require('../models/Clinic');

const COMMIT = process.argv.includes('--commit');
const INCOME_ACCOUNT_CODE = '4.1.2';

// [código, nombre, PVP con IVA, descripción]
const COSMETOLOGIA = [
  ['COSANTAGE37', 'ANTI AGE', 44.85],
  ['COSCOMMI17', 'COMBO REALCE DE MIRADA', 44.85],
  ['COSDEPCER07', 'DEPILACION CERA CEJAS', 11.5],
  ['COSDEPCER08', 'DEPILACION CERA BIGOTE', 6.9],
  ['COSDEPCER18', 'DEPILACION CERA PATILLAS', 6.9],
  ['COSDEPCER19', 'DEPILACION DE CERA FULL FACE (ROSTRO COMPLETO)', 28.75],
  ['COSDEPCER20', 'DEPILACION CERA AXILA', 9.2],
  ['COSDEPCER21', 'DEPILACION CERA BIKINI COMPLETO', 28.75],
  ['COSDEPCER22', 'DEPILACION CERA MEDIO BIKINI', 17.25],
  ['COSDEPCER23', 'DEPILACION CERA PIERNAS COMPLETAS', 34.5],
  ['COSDEPCER24', 'DEPILACION CERA MEDIAS PIERNAS', 17.25],
  ['COSDEPDIO04', 'DEPILACION DE DIODO', 11.5],
  ['COSDEPHIL25', 'DEPILACION HILO CEJAS', 11.5],
  ['COSDEPHIL26', 'DEPILACION HILO AXILA', 13.8],
  ['COSDEPHIL27', 'DEPILACION HILO BIGOTE', 9.2],
  ['COSDEPHIL28', 'DEPILACION HILO PATILLAS', 9.2],
  ['COSDEPHIL29', 'DEPILACION HILO FULL FACE (ROSTRO COMPLETO)', 28.75],
  ['COSDEPNAV30', 'DEPILACION NAVAJA CEJAS', 5.75],
  ['COSDERLUM11', 'DERMAPLANING LUMINOUS', 28.75],
  ['COSDERMA03', 'DERMAPLANING', 23],
  ['COSDESTAP09', 'DESTAPONAMIENTO CAPILAR', 28.75],
  ['COSDESTAP40', 'DESTAPONAMIENTO CAPILAR GRADO DOS', 40.25],
  ['COSE+CEL13', 'EXOSOMAS + CELULAS MADRE', 86.25],
  ['COSE+PDR12', 'EXOSOMAS + PDRN', 79.35],
  ['COSHIDOJE35', 'HIDRATACION DE OJERAS', 11.5],
  ['COSLAMCEJ16', 'LAMINADO DE CEJAS', 28.75],
  ['COSLIFPES15', 'LIFTING PESTAÑAS', 28.75],
  ['COSLIMCON36', 'LIMPIEZA CONTROL ACNÉ', 46],
  ['COSLIMFAC01', 'LIMPIEZA FACIAL EXPRESS', 17.25],
  ['COSLIMFAC02', 'LIMPIEZA FACIAL PROFUNDA', 28.75],
  ['COSNAD+RES06', 'NAD + RESVERATROL', 23],
  ['COSPLA+LIM31', 'PLASMA RICO EN PLAQUETAS + LIMPIEZA FACIAL', 44.85],
  ['COSPLACAP32', 'PLASMA CAPILAR', 56.35],
  ['COSPLARIC34', 'PLASMA RICO EN PLAQUETAS LOCALIZADO (ROSTRO CUELLO Y ESCOTE)', 97.75],
  ['COSPLAS+SUE33', 'PLASMA RICO EN PLAQUETAS + SUERO TERAPIA DE VITAMINA C', 69],
  ['COSPROSKI05', 'PROBIOTIC SKIN GLOW', 28.75],
  ['COSRITREN38', 'RITUAL RENOVADOR HIDRA', 46],
  ['COSSKIBOO10', 'SKIN BOOSTER', 33.35],
  ['COSSKIBOO14', 'SKIN BOOSTER ADICIONAL', 17.25],
  ['COSUENOV41', 'SUERO NOVA PIEL', 29],
  ['COSUEVIT39', 'SUERO VITAMINA C', 23],
];

const DERMATOLOGIA = [
  ['DERACRO13', 'ACROCORDONES 1–5', 40, 'ELECTROCAUTERIO, TIJERA FINA O RADIOFRECUENCIA'],
  ['DERBIOEX04', 'BIOPSIA EXCISIONAL PEQUEÑA', 110, 'KIT DE CIRUGIA, ANESTESIA, SUTURAS, ELECTROCAUTERIO'],
  ['DERBIOINC03', 'BIOPSIA INCISIONAL', 80, 'MANGO Y HOJA DE BISTURÍ, INSTRUMENTAL QUIRÚRGICO, ANESTESIA, SUTURAS, FORMOL'],
  ['DERBIOPUN01', 'BIOPSIA PUNCH', 75, 'PUNCH 2–6 MM, LIDOCAÍNA, JERINGAS, AGUJAS, CLORHEXIDINA AL 2%, CAMPOS DE OJO, PINZA ADSON CON DIENTE, PINZA ADSON SIN DIENTE, PINZA DE DISECCION FINA TIPO IRIS, PINZA MOSQUITO RECTA Y CURVA, PINZA KELLY, PINZA ALIS, PINZAS DE CAMPO, PORTAAGUJAS GRANDE DE 12 A 14 CM, TIJERA IRIS DE 11 A 12 CM RECTA Y CURVA, SUTURA DICRIL 5-0, SUTURA DICRIL 4-0, SUTURA NYLON 4-0 / 3-0 / 5-0, FRASCO CON FORMOL AL 10%'],
  ['DERBIOSHA02', 'BIOPSIA SHAVE', 59, 'HOJA DE BISTURÍ #15, 11 Y 10, DERMABLADE, ANESTESIA UN FRASCO CON EPINEFRINA, ANESTESIA UN FRASCO SIN EPINEFRINA, ELECTROCAUTERIO BOVIE DERM, HEMOSTÁTICO FRASCO MONSEL, FORMOL AL 10%'],
  ['DERCONCON26', 'CONSULTA DE CONTROL', 20],
  ['DERCONDER25', 'CONSULTA DERMATOLOGÍA', 15, 'REVISION DE LA PATOLOGÍA, HISTORIA CLÍNICA, ANÁLISIS DE LA PIEL O CUERO CABELLUDO CON DERMATOSCOPIO Y PLANIFICACIÓN DE TRATAMIENTO'],
  ['DERCUR+ELE10', 'CURETAJE + ELECTRODESECACIÓN', 60, 'CURETAS + ELECTROCAUTERIO/ELECTROCOAGULADOR'],
  ['DERCURDER20', 'CURACIÓN DERMATOLÓGICA', 30, 'SUERO FISIOLÓGICO, CLORHEXIDINA, GASAS, APÓSITOS'],
  ['DERCURLES09', 'CURETAJE DE LESIÓN', 40, 'CURETAS DERMATOLÓGICAS, ANESTESIA, ANTISÉPTICO'],
  ['DERDREABS19', 'DRENAJE DE ABSCESO PEQUEÑO', 50, 'BISTURÍ, ANESTESIA, GASAS, SUERO FISIOLÓGICO, APÓSITOS, GASAS ESTERIL'],
  ['DERELECTR11', 'ELECTROCAUTERIZACIÓN DE 1 SESIONE', 30, 'ELECTROCAUTERIO, PUNTAS/ELECTRODOS, ANESTESIA'],
  ['DEREXALAB27', 'EXÁMENES DE LABORATORIO', 20],
  ['DEREXELES06', 'EXÉRESIS DE LESIÓN MEDIANA', 150, 'INSTRUMENTAL QUIRÚRGICO, ANESTESIA, SUTURAS, ELECTROCAUTERIO'],
  ['DEREXELIP08', 'EXÉRESIS DE LIPOMA PEQUEÑO', 130, 'KIT QUIRÚRGICO, ANESTESIA, HEMOSTASIA, SUTURAS'],
  ['DEREXENEV05', 'EXÉRESIS DE NEVO PEQUEÑO', 100, 'IGUAL QUE CIRUGÍA MENOR'],
  ['DEREXEQUI07', 'EXÉRESIS DE QUISTE EPIDERMOIDE PEQUEÑO', 130, 'KIT QUIRÚRGICO, ANESTESIA, SUTURA'],
  ['DERINFALO17', 'INFILTRACIÓN ALOPECIA AREATA', 60, 'TRIAMCINOLONA (CONFARPI), JERINGAS Y AGUJAS'],
  ['DERINFIL16', 'INFILTRACIÓN INTRALESIONAL DE QUELOIDE', 50, 'LIDOCAÍNA, JERINGA DE 1 ML, AGUJAS FINAS'],
  ['DERINFQUI18', 'INFILTRACIÓN DE QUISTE INFLAMADO', 40, 'TRIAMCINOLONA, JERINGA, AGUJA'],
  ['DERMILI15', 'MILIUM', 20, 'AGUJA 18–25 G, EXTRACTOR DE COMEDONES'],
  ['DERPRPCAP22', 'PRP CAPILAR', 69, 'CENTRÍFUGA, TUBOS PRP, AGUJAS, JERINGAS, MARIPOSA/TOMA SANGUÍNEA'],
  ['DERQUERA14', 'QUERATOSIS SEBORREICAS', 50, 'CURETA/ELECTROCAUTERIO/CRIOTERAPIA'],
  ['DERRETPUN21', 'RETIRO DE PUNTOS', 10, 'PINZA, TIJERA, GASAS'],
  ['DERTOXBOT23', 'TOXINA BOTULÍNICA TERCIO SUPERIOR', 300, 'TOXINA BOTULÍNICA BTXA, SSN, JERINGAS DE INSULINA, AGUJAS'],
  ['DERTOXHIP24', 'TOXINA PARA HIPERHIDROSIS AXILAR', 450, 'TOXINA BOTULÍNICA DISPOR, JERINGAS, PRUEBA DE MINOR OPCIONAL'],
  ['DERVERPLA12', 'VERRUGAS PLANTARES', 80, 'CRIOTERAPIA, CURETA; ÁCIDO SALICÍLICO SEGÚN CASO'],
];

const GRUPOS = [
  { categoria: 'COSMETOLOGIA', iva: 15, items: COSMETOLOGIA },
  { categoria: 'DERMATOLOGIA', iva: 0, items: DERMATOLOGIA },
];

async function categoriaServicio(clinicId, name, incomeAccount) {
  const cat = await InventoryCategory.findOne({ clinic: clinicId, kind: 'SERVICIO', name });
  if (cat) return { cat, creada: false };
  if (!COMMIT) return { cat: { _id: null, name }, creada: true };
  const nueva = await InventoryCategory.create({ clinic: clinicId, code: name, name, kind: 'SERVICIO', incomeAccount });
  return { cat: nueva, creada: true };
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  // La sucursal dueña del catálogo (donde viven los demás servicios).
  const clinic = await Clinic.findOne({ name: 'Central' });
  if (!clinic) throw new Error('No se encontró la sucursal Central');
  const income = await ChartOfAccount.findOne({ code: INCOME_ACCOUNT_CODE });
  if (!income) throw new Error(`No existe la cuenta ${INCOME_ACCOUNT_CODE}`);

  let creados = 0;
  let existentes = 0;
  for (const g of GRUPOS) {
    const { cat, creada } = await categoriaServicio(clinic._id, g.categoria, income._id);
    console.log(`Categoría ${g.categoria}: ${creada ? (COMMIT ? 'CREADA' : 'se crearía') : 'ya existe'}`);
    for (const [code, name, price, description = ''] of g.items) {
      if (await Product.exists({ code })) {
        existentes++;
        console.log(`  = ${code} ya existe, no se toca`);
        continue;
      }
      const base = +(price / (1 + g.iva / 100)).toFixed(2);
      console.log(`  + ${code}  ${name}  PVP ${price.toFixed(2)} (base ${base.toFixed(2)}, IVA ${g.iva}%)`);
      creados++;
      if (!COMMIT) continue;
      await Product.create({
        clinic: clinic._id,
        code,
        name,
        description,
        category: 'servicio',
        categoria: g.categoria,
        inventoryCategory: cat._id,
        incomeAccount: income._id,
        salePrices: [{ name: 'General', price, active: true }],
        salePrice: price,
        priceIncludesVat: true,
        taxRate: g.iva,
        taxCategory: g.iva === 15 ? 'IVA_15' : 'IVA_0',
        taxCodeSri: g.iva === 15 ? '4' : '0',
        unlimited: true,
        unit: 'servicio',
        stock: 0,
        minStock: 0,
        availableInClinics: [],
      });
    }
  }
  console.log(`\n${COMMIT ? 'Creados' : 'Se crearían'}: ${creados} · ya existentes: ${existentes}`);
  if (!COMMIT) console.log('Simulación. Repite con --commit para grabar.');
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
