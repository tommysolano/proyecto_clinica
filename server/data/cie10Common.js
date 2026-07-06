/**
 * Subconjunto de códigos CIE-10 de uso frecuente en consulta externa (Ecuador).
 * Sirve para que el buscador funcione de inmediato. El catálogo OFICIAL completo
 * del MSP se carga con: node scripts/seedCie10.js --file=<archivo oficial>.
 */
module.exports = [
  // Infecciosas
  { code: 'A09', description: 'Diarrea y gastroenteritis de presunto origen infeccioso' },
  { code: 'A08.4', description: 'Infección intestinal viral, no especificada' },
  { code: 'B34.9', description: 'Infección viral, no especificada' },
  { code: 'B00.9', description: 'Infección herpética viral, no especificada' },
  { code: 'B01.9', description: 'Varicela sin complicaciones' },
  { code: 'B02.9', description: 'Herpes zóster sin complicaciones' },
  { code: 'B37.3', description: 'Candidiasis de la vulva y de la vagina' },

  // Endócrino / metabólico
  { code: 'E11.9', description: 'Diabetes mellitus tipo 2, sin complicaciones' },
  { code: 'E10.9', description: 'Diabetes mellitus tipo 1, sin complicaciones' },
  { code: 'E03.9', description: 'Hipotiroidismo, no especificado' },
  { code: 'E05.9', description: 'Tirotoxicosis [hipertiroidismo], no especificada' },
  { code: 'E66.9', description: 'Obesidad, no especificada' },
  { code: 'E78.5', description: 'Hiperlipidemia, no especificada' },
  { code: 'E86', description: 'Depleción del volumen (deshidratación)' },

  // Mentales
  { code: 'F41.9', description: 'Trastorno de ansiedad, no especificado' },
  { code: 'F41.2', description: 'Trastorno mixto de ansiedad y depresión' },
  { code: 'F32.9', description: 'Episodio depresivo, no especificado' },
  { code: 'F43.2', description: 'Trastornos de adaptación' },

  // Nervioso
  { code: 'G43.9', description: 'Migraña, no especificada' },
  { code: 'G47.0', description: 'Trastornos del inicio y del mantenimiento del sueño (insomnio)' },

  // Ojo y oído
  { code: 'H10.9', description: 'Conjuntivitis, no especificada' },
  { code: 'H61.2', description: 'Cerumen impactado' },
  { code: 'H66.9', description: 'Otitis media, no especificada' },

  // Circulatorio
  { code: 'I10', description: 'Hipertensión esencial (primaria)' },
  { code: 'I25.9', description: 'Enfermedad isquémica crónica del corazón, no especificada' },
  { code: 'I83.9', description: 'Venas varicosas de miembros inferiores sin úlcera ni inflamación' },

  // Respiratorio
  { code: 'J00', description: 'Rinofaringitis aguda [resfriado común]' },
  { code: 'J02.9', description: 'Faringitis aguda, no especificada' },
  { code: 'J03.9', description: 'Amigdalitis aguda, no especificada' },
  { code: 'J06.9', description: 'Infección aguda de las vías respiratorias superiores, no especificada' },
  { code: 'J20.9', description: 'Bronquitis aguda, no especificada' },
  { code: 'J18.9', description: 'Neumonía, no especificada' },
  { code: 'J30.4', description: 'Rinitis alérgica, no especificada' },
  { code: 'J45.9', description: 'Asma, no especificada' },

  // Digestivo
  { code: 'K21.9', description: 'Enfermedad del reflujo gastroesofágico sin esofagitis' },
  { code: 'K29.7', description: 'Gastritis, no especificada' },
  { code: 'K30', description: 'Dispepsia funcional' },
  { code: 'K52.9', description: 'Gastroenteritis y colitis no infecciosas, no especificadas' },
  { code: 'K59.0', description: 'Estreñimiento' },
  { code: 'K80.2', description: 'Cálculo de la vesícula biliar sin colecistitis' },

  // Piel
  { code: 'L20.9', description: 'Dermatitis atópica, no especificada' },
  { code: 'L23.9', description: 'Dermatitis alérgica de contacto, de causa no especificada' },
  { code: 'L30.9', description: 'Dermatitis, no especificada' },
  { code: 'L50.9', description: 'Urticaria, no especificada' },

  // Osteomuscular
  { code: 'M54.5', description: 'Lumbago no especificado (dolor lumbar)' },
  { code: 'M54.2', description: 'Cervicalgia' },
  { code: 'M25.5', description: 'Dolor en articulación' },
  { code: 'M79.1', description: 'Mialgia' },
  { code: 'M17.9', description: 'Gonartrosis, no especificada' },
  { code: 'M19.9', description: 'Artrosis, no especificada' },
  { code: 'M10.9', description: 'Gota, no especificada' },

  // Genitourinario
  { code: 'N39.0', description: 'Infección de vías urinarias, sitio no especificado' },
  { code: 'N30.0', description: 'Cistitis aguda' },
  { code: 'N40', description: 'Hiperplasia de la próstata' },
  { code: 'N76.0', description: 'Vaginitis aguda' },
  { code: 'N95.1', description: 'Estados menopáusicos y climatéricos femeninos' },

  // Embarazo
  { code: 'Z34.9', description: 'Supervisión de embarazo normal, no especificado' },

  // Sangre
  { code: 'D64.9', description: 'Anemia, no especificada' },

  // Síntomas y signos (R)
  { code: 'R05', description: 'Tos' },
  { code: 'R10.4', description: 'Dolor abdominal, no especificado' },
  { code: 'R11', description: 'Náusea y vómito' },
  { code: 'R42', description: 'Mareo y desvanecimiento' },
  { code: 'R50.9', description: 'Fiebre, no especificada' },
  { code: 'R51', description: 'Cefalea' },
  { code: 'R53', description: 'Malestar y fatiga' },

  // Alergia / lesiones / factores
  { code: 'T78.4', description: 'Alergia, no especificada' },

  // Contacto con servicios de salud (Z)
  { code: 'Z00.0', description: 'Examen médico general' },
  { code: 'Z01.4', description: 'Examen ginecológico (general)' },
  { code: 'Z23', description: 'Necesidad de inmunización contra enfermedad bacteriana única' },
];
