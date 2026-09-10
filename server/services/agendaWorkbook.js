const ExcelJS = require('exceljs');

/**
 * EL EXCEL DE LA AGENDA.
 *
 * Lo pidió mostrador: hasta ahora el detalle de las citas solo se podía sacar
 * en un informe de administración, con otros filtros y otras columnas, así que
 * la pregunta de todos los días —«pásame las citas de hoy tal como las estoy
 * viendo»— acababa en una captura de pantalla o en copiar la tabla a mano.
 *
 * DOS DECISIONES QUE EXPLICAN LO DEMÁS:
 *
 * 1. LO QUE SE EXPORTA ES LO QUE SE VE. La agenda filtra en el NAVEGADOR
 *    (sucursal, servicio, franja horaria y bandeja no viajan al servidor), así
 *    que reconstruir aquí ese filtrado habría sido copiar una lógica que se
 *    desincroniza en la primera pantalla que se toque, y el Excel diría algo
 *    distinto de lo que el usuario tiene delante. La pantalla manda los ids de
 *    las citas que está enseñando; aquí solo se comprueba que sean suyas.
 *
 * 2. NO LLEVA DATOS DE CONTACTO. Ni cédula, ni teléfono, ni correo, ni
 *    dirección — la misma línea que el resto del sistema: identificar al cliente
 *    del mostrador no es sacar el padrón entero en un archivo que se reenvía por
 *    WhatsApp. Es una agenda de trabajo, y para eso basta el nombre.
 */

/* ── Paleta ──────────────────────────────────────────────────────────────── */
const VERDE = 'FF047857';        // el de la marca, el mismo de los otros informes
const VERDE_SUAVE = 'FFD1FAE5';
const GRIS_TITULO = 'FF334155';
const GRIS_BANDA = 'FFF8FAFC';   // filas alternas
const GRIS_BORDE = 'FFE2E8F0';
const AMBAR = 'FFFEF3C7';
const AZUL = 'FFDBEAFE';
const ROJO = 'FFFEE2E2';
const GRIS = 'FFF1F5F9';

const ESTADOS = {
  pendiente: { texto: 'Pendiente', fondo: AMBAR, letra: 'FF92400E' },
  confirmada: { texto: 'Confirmada', fondo: AZUL, letra: 'FF1E40AF' },
  asistida: { texto: 'Asistida', fondo: VERDE_SUAVE, letra: 'FF065F46' },
  completada: { texto: 'Completada', fondo: VERDE_SUAVE, letra: 'FF065F46' },
  no_asistio: { texto: 'No asistió', fondo: ROJO, letra: 'FF991B1B' },
  cancelada: { texto: 'Cancelada', fondo: GRIS, letra: 'FF475569' },
};

const METODOS = {
  efectivo: 'Efectivo',
  transferencia: 'Transferencia',
  tarjeta_credito: 'Tarjeta de crédito',
  tarjeta_debito: 'Tarjeta de débito',
};

const ADELANTOS = { abono: 'Abono', total: 'Pagó todo' };

/** Los minutos a partir de los cuales una llegada se considera tarde. */
const { TOLERANCIA_MINUTOS } = require('../utils/appointmentArrival');

/* ── Utilidades ──────────────────────────────────────────────────────────── */

const borde = { style: 'thin', color: { argb: GRIS_BORDE } };
const BORDES = { top: borde, left: borde, bottom: borde, right: borde };

const relleno = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

/** Hora de Ecuador en HH:MM, o '' si no hay marca. */
function horaEc(valor) {
  if (!valor) return '';
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('es-EC', {
    timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function fechaEc(valor) {
  if (!valor) return '';
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('es-EC', { timeZone: 'America/Guayaquil' });
}

const nombreDeSede = (c) => c?.nombreComercial || c?.name || '';

const nombreDePersona = (u) => (u?.name || '').trim();

/**
 * QUIÉN ATIENDE, leído de los turnos — que son la fuente única (los espejos
 * `doctor` y `attendedByNurse` solo cuentan la mitad de una cita con varios
 * pasos). El «Dr.» va por el TIPO del turno, no por el rol actual de la
 * persona: los de enfermería llevan «Enf.» y nadie más lleva título.
 *
 * SIN ENFERMERÍA (`opciones.sinEnfermeria`, lo elige quien descarga). El
 * autofiltro de Excel agrupa por el texto ENTERO de la celda, así que
 * «Dr. A → Dr. B» y «Dr. A → Dr. B → Enf. C» son DOS entradas distintas: la
 * lista del filtro se llena de combinaciones que solo se diferencian en quién
 * puso el suero, y buscar «las citas de la Dra. B» deja de ser un clic. Con la
 * opción puesta, los turnos de enfermería no se escriben y esas dos citas caen
 * bajo el mismo «Dr. A → Dr. B».
 *
 * Con esa opción el llamador TAMBIÉN deja fuera —con `soloEnfermeria`, más
 * abajo— las citas que no pasó ningún médico: si el rótulo dice «solo los
 * médicos», una fila atendida solo por enfermería no puede estar.
 */
function quienAtiende(a, { sinEnfermeria = false } = {}) {
  const turnos = (a.turns || []).filter((t) => t.user || t.kind === 'enfermeria');
  if (!turnos.length) return a.doctor?.name ? `Dr. ${a.doctor.name}` : '';
  if (sinEnfermeria && !turnos.some((t) => t.kind !== 'enfermeria')) return 'Solo enfermería';
  return turnos
    .filter((t) => !(sinEnfermeria && t.kind === 'enfermeria'))
    .map((t) => {
      const nombre = nombreDePersona(t.user);
      if (t.kind === 'enfermeria') return nombre ? `Enf. ${nombre}` : 'Enfermería (sin asignar)';
      return nombre ? `Dr. ${nombre}` : '';
    })
    .filter(Boolean)
    .join(' → ');
}

/**
 * ¿LA CITA LA ATENDIÓ SOLO ENFERMERÍA? (turnos presentes y ninguno de médico).
 * Las que no tienen turnos NO cuentan: esas se rotulan con el médico espejo.
 */
function soloEnfermeria(a) {
  const turnos = (a.turns || []).filter((t) => t.user || t.kind === 'enfermeria');
  return turnos.length > 0 && !turnos.some((t) => t.kind !== 'enfermeria');
}

/**
 * A NOMBRE DE QUIÉN QUEDÓ LA CITA, y quién la escribió si no fue la misma
 * persona: el call center trabaja en pareja —una la cierra por teléfono y otra
 * la teclea— y el reporte por asesora se lee mal sin esa distinción.
 */
function agendadaPor(a) {
  const acreditada = a.createdBy?.name || a.createdByName || '';
  const escribio = (a.registeredByName || '').trim();
  if (!acreditada) return escribio;
  return escribio && escribio !== acreditada ? acreditada + ' (escribió ' + escribio + ')' : acreditada;
}

/** El servicio de la cita: el del catálogo de agenda y, si no, los del inventario. */
function servicioDeLaCita(a) {
  if (a.serviceItem?.name || a.serviceName) return a.serviceItem?.name || a.serviceName;
  return (a.services || []).map((s) => s.name).filter(Boolean).join(', ');
}

/* ── Hoja de citas ───────────────────────────────────────────────────────── */

const COLUMNAS = [
  { header: 'Fecha', key: 'fecha', width: 11, align: 'center' },
  { header: 'Hora', key: 'hora', width: 8, align: 'center' },
  { header: 'Llegó', key: 'llego', width: 8, align: 'center' },
  { header: 'Retraso', key: 'retraso', width: 9, align: 'center', numFmt: '0" min"' },
  { header: 'Paciente', key: 'paciente', width: 30 },
  { header: '¿Paciente nuevo?', key: 'nuevo', width: 16, align: 'center' },
  { header: 'Sucursal', key: 'sucursal', width: 18 },
  { header: 'Servicio', key: 'servicio', width: 26, wrap: true },
  { header: 'Quién atiende', key: 'atiende', width: 26, wrap: true },
  { header: 'Estado', key: 'estado', width: 13, align: 'center' },
  { header: 'Motivo', key: 'motivo', width: 34, wrap: true },
  { header: 'Valor', key: 'valor', width: 12, numFmt: '"$"#,##0.00', align: 'right' },
  { header: 'Canje', key: 'canje', width: 8, align: 'center' },
  { header: 'Abonado', key: 'abonado', width: 12, numFmt: '"$"#,##0.00', align: 'right' },
  { header: 'Adelanto', key: 'adelanto', width: 14 },
  { header: 'Forma de pago', key: 'formaPago', width: 17 },
  { header: 'Agendada por', key: 'agendadaPor', width: 22 },
  { header: 'Origen', key: 'origen', width: 12, align: 'center' },
];

/** Fila 1-4: de qué son estas citas. Sin esto, «17 citas» no dice de cuándo. */
function cabeceraDelInforme(ws, { titulo, subtitulo, periodo, filtros, resumen }) {
  const ultima = COLUMNAS.length;
  const merge = (fila) => ws.mergeCells(fila, 1, fila, ultima);

  merge(1);
  const t = ws.getCell('A1');
  t.value = titulo;
  t.font = { name: 'Calibri', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
  t.fill = relleno(VERDE);
  t.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(1).height = 30;

  merge(2);
  const s = ws.getCell('A2');
  s.value = subtitulo;
  s.font = { size: 11, bold: true, color: { argb: GRIS_TITULO } };
  s.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(2).height = 18;

  merge(3);
  const p = ws.getCell('A3');
  p.value = filtros ? `${periodo}     ·     Filtros: ${filtros}` : periodo;
  p.font = { size: 10, color: { argb: 'FF475569' } };
  p.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(3).height = 16;

  merge(4);
  const r = ws.getCell('A4');
  r.value = resumen;
  r.font = { size: 9, italic: true, color: { argb: 'FF94A3B8' } };
  r.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(4).height = 16;
}

function hojaDeCitas(wb, citas, meta, opciones) {
  const ws = wb.addWorksheet('Citas', {
    views: [{ state: 'frozen', ySplit: 6 }],
    pageSetup: {
      orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
      printTitlesRow: '6:6',
    },
  });

  ws.columns = COLUMNAS.map((c) => ({ key: c.key, width: c.width }));
  cabeceraDelInforme(ws, meta);

  // Fila 6: los encabezados de la tabla.
  const cab = ws.getRow(6);
  COLUMNAS.forEach((c, i) => {
    const celda = cab.getCell(i + 1);
    celda.value = c.header;
    celda.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    celda.fill = relleno(VERDE);
    celda.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    celda.border = BORDES;
  });
  cab.height = 22;

  citas.forEach((a, idx) => {
    const estado = ESTADOS[a.status] || { texto: a.status || '', fondo: GRIS, letra: GRIS_TITULO };
    const retraso = typeof a.arrivalDelayMinutes === 'number' ? a.arrivalDelayMinutes : null;
    const fila = ws.addRow({
      fecha: fechaEc(a.date),
      hora: a.startTime || '',
      llego: horaEc(a.arrivedAt),
      // El retraso va como NÚMERO para que se pueda ordenar y promediar en la
      // hoja: como texto («12 min») el Excel no lo suma.
      retraso: retraso === null ? '' : retraso,
      paciente: `${a.patient?.firstName || ''} ${a.patient?.lastName || ''}`.trim(),
      // SIEMPRE dice una de las dos cosas. Dejaba en blanco al recurrente y
      // una columna medio vacía no se lee como «no»: se lee como que el dato no
      // está, que es justo lo contrario de lo que quiere saber quien la mira.
      nuevo: a.isFirstVisit ? 'Nuevo' : 'Recurrente',
      sucursal: nombreDeSede(a.clinic),
      servicio: servicioDeLaCita(a),
      atiende: quienAtiende(a, opciones),
      estado: estado.texto,
      motivo: a.reason || '',
      valor: a.isCanje ? 0 : Number(a.agreedValue ?? 0),
      canje: a.isCanje ? 'Sí' : '',
      abonado: Number(a.advanceAmount || 0),
      adelanto: ADELANTOS[a.advancePayment] || '',
      formaPago: METODOS[a.advanceMethod] || '',
      agendadaPor: agendadaPor(a),
      origen: a.conversation ? 'Chat' : 'Agenda',
    });

    fila.height = 16;
    fila.eachCell({ includeEmpty: true }, (celda, col) => {
      const def = COLUMNAS[col - 1] || {};
      celda.border = BORDES;
      celda.font = { size: 10 };
      celda.alignment = {
        vertical: 'middle',
        horizontal: def.align || 'left',
        wrapText: !!def.wrap,
        indent: def.align ? 0 : 1,
      };
      if (def.numFmt) celda.numFmt = def.numFmt;
      // Bandas: leer diecisiete filas seguidas sin perder el renglón.
      if (idx % 2 === 1) celda.fill = relleno(GRIS_BANDA);
    });

    // El estado, con su color: es lo que se busca de un vistazo.
    const cEstado = fila.getCell(COLUMNAS.findIndex((c) => c.key === 'estado') + 1);
    cEstado.fill = relleno(estado.fondo);
    cEstado.font = { size: 10, bold: true, color: { argb: estado.letra } };

    // El paciente NUEVO, resaltado: es lo que se busca de un vistazo (y lo que
    // mueve las comisiones), así que no puede costar lo mismo leerlo que al resto.
    const cNuevo = fila.getCell(COLUMNAS.findIndex((c) => c.key === 'nuevo') + 1);
    if (a.isFirstVisit) {
      cNuevo.fill = relleno(VERDE_SUAVE);
      cNuevo.font = { size: 10, bold: true, color: { argb: 'FF065F46' } };
    } else {
      cNuevo.font = { size: 10, color: { argb: 'FF94A3B8' } };
    }

    // Y el retraso, en rojo solo cuando de verdad llegó tarde.
    if (retraso !== null && retraso > TOLERANCIA_MINUTOS) {
      const cRetraso = fila.getCell(COLUMNAS.findIndex((c) => c.key === 'retraso') + 1);
      cRetraso.font = { size: 10, bold: true, color: { argb: 'FFB91C1C' } };
    }
  });

  // Totales. Con borde grueso arriba: cierra la tabla y no se confunde con otra cita.
  const totales = ws.addRow({
    paciente: `${citas.length} ${citas.length === 1 ? 'cita' : 'citas'}`,
    valor: citas.reduce((s, a) => s + (a.isCanje ? 0 : Number(a.agreedValue ?? 0)), 0),
    abonado: citas.reduce((s, a) => s + Number(a.advanceAmount || 0), 0),
  });
  totales.eachCell({ includeEmpty: true }, (celda, col) => {
    const def = COLUMNAS[col - 1] || {};
    celda.font = { size: 10, bold: true, color: { argb: GRIS_TITULO } };
    celda.fill = relleno(VERDE_SUAVE);
    celda.border = { ...BORDES, top: { style: 'medium', color: { argb: VERDE } } };
    celda.alignment = { vertical: 'middle', horizontal: def.align || 'left', indent: def.align ? 0 : 1 };
    if (def.numFmt) celda.numFmt = def.numFmt;
  });
  totales.height = 20;

  // El filtro va sobre los encabezados, no sobre el título del informe.
  if (citas.length) {
    ws.autoFilter = { from: { row: 6, column: 1 }, to: { row: 6, column: COLUMNAS.length } };
  } else {
    const vacio = ws.addRow({ paciente: 'No hay citas que cuadren con los filtros aplicados.' });
    vacio.getCell(5).font = { size: 10, italic: true, color: { argb: 'FF94A3B8' } };
  }

  return ws;
}

/* ── Hoja de resumen ─────────────────────────────────────────────────────── */

/**
 * Un bloque del resumen: título, encabezados y filas. Devuelve la fila
 * siguiente, para ir apilándolos sin llevar la cuenta a mano.
 */
function bloque(ws, desde, titulo, encabezados, filas, { numFmt } = {}) {
  const t = ws.getCell(desde, 1);
  ws.mergeCells(desde, 1, desde, encabezados.length);
  t.value = titulo;
  t.font = { size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
  t.fill = relleno(VERDE);
  t.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(desde).height = 20;

  const cab = ws.getRow(desde + 1);
  encabezados.forEach((h, i) => {
    const c = cab.getCell(i + 1);
    c.value = h;
    c.font = { size: 10, bold: true, color: { argb: GRIS_TITULO } };
    c.fill = relleno(VERDE_SUAVE);
    c.border = BORDES;
    c.alignment = { vertical: 'middle', horizontal: i ? 'center' : 'left', indent: i ? 0 : 1 };
  });

  filas.forEach((f, idx) => {
    const fila = ws.getRow(desde + 2 + idx);
    f.forEach((v, i) => {
      const c = fila.getCell(i + 1);
      c.value = v;
      c.font = { size: 10 };
      c.border = BORDES;
      c.alignment = { vertical: 'middle', horizontal: i ? 'center' : 'left', indent: i ? 0 : 1 };
      if (i && numFmt && numFmt[i]) c.numFmt = numFmt[i];
      if (idx % 2 === 1) c.fill = relleno(GRIS_BANDA);
    });
  });

  return desde + 2 + filas.length + 1; // una fila en blanco entre bloques
}

/** Cuenta por clave y devuelve las filas ordenadas de más a menos. */
function contarPor(citas, clave) {
  const mapa = new Map();
  citas.forEach((a) => {
    const k = clave(a) || '—';
    mapa.set(k, (mapa.get(k) || 0) + 1);
  });
  return [...mapa.entries()].sort((a, b) => b[1] - a[1]);
}

function hojaDeResumen(wb, citas, meta, opciones) {
  const ws = wb.addWorksheet('Resumen', {
    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  ws.columns = [{ width: 34 }, { width: 14 }, { width: 14 }];

  ws.mergeCells('A1:C1');
  const t = ws.getCell('A1');
  t.value = meta.titulo;
  t.font = { size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
  t.fill = relleno(VERDE);
  t.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(1).height = 26;
  ws.mergeCells('A2:C2');
  const s = ws.getCell('A2');
  s.value = meta.periodo;
  s.font = { size: 10, color: { argb: 'FF475569' } };
  s.alignment = { vertical: 'middle', indent: 1 };

  const total = citas.length || 1; // solo para el porcentaje; nunca se divide por 0
  const pct = (n) => n / total;

  let fila = 4;

  fila = bloque(
    ws, fila, 'Citas por estado', ['Estado', 'Citas', '%'],
    contarPor(citas, (a) => (ESTADOS[a.status] || {}).texto || a.status)
      .map(([k, n]) => [k, n, pct(n)]),
    { numFmt: { 2: '0.0%' } }
  );

  fila = bloque(
    ws, fila, 'Citas por sucursal', ['Sucursal', 'Citas', '%'],
    contarPor(citas, (a) => nombreDeSede(a.clinic)).map(([k, n]) => [k, n, pct(n)]),
    { numFmt: { 2: '0.0%' } }
  );

  fila = bloque(
    ws, fila, 'Citas por quién atiende', ['Profesional', 'Citas', 'Nuevos'],
    (() => {
      const mapa = new Map();
      citas.forEach((a) => {
        const k = quienAtiende(a, opciones) || 'Sin asignar';
        const cur = mapa.get(k) || { n: 0, nuevos: 0 };
        cur.n += 1;
        if (a.isFirstVisit) cur.nuevos += 1;
        mapa.set(k, cur);
      });
      return [...mapa.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => [k, v.n, v.nuevos]);
    })()
  );

  fila = bloque(
    ws, fila, 'Citas por servicio', ['Servicio', 'Citas', '%'],
    contarPor(citas, servicioDeLaCita).map(([k, n]) => [k, n, pct(n)]),
    { numFmt: { 2: '0.0%' } }
  );

  // PUNTUALIDAD. Sale de `arrivalDelayMinutes`, que se sella una sola vez al
  // recibir al paciente: no se recalcula al abrir el informe (ver
  // utils/appointmentArrival.js).
  const conLlegada = citas.filter((a) => typeof a.arrivalDelayMinutes === 'number');
  const tarde = conLlegada.filter((a) => a.arrivalDelayMinutes > TOLERANCIA_MINUTOS);
  const retrasoMedio = tarde.length
    ? Math.round(tarde.reduce((s, a) => s + a.arrivalDelayMinutes, 0) / tarde.length)
    : 0;
  fila = bloque(
    ws, fila, `Puntualidad (tolerancia: ${TOLERANCIA_MINUTOS} min)`, ['', 'Citas', ''],
    [
      ['Llegaron a la hora', conLlegada.length - tarde.length, ''],
      ['Llegaron tarde', tarde.length, ''],
      ['Retraso medio de los que llegaron tarde', retrasoMedio ? `${retrasoMedio} min` : '—', ''],
      ['Sin hora de llegada registrada', citas.length - conLlegada.length, ''],
    ]
  );

  const nuevos = citas.filter((a) => a.isFirstVisit).length;
  fila = bloque(
    ws, fila, 'Pacientes', ['', 'Citas', '%'],
    [
      ['Pacientes nuevos', nuevos, pct(nuevos)],
      ['Ya venían antes', citas.length - nuevos, pct(citas.length - nuevos)],
    ],
    { numFmt: { 2: '0.0%' } }
  );

  const valor = citas.reduce((s, a) => s + (a.isCanje ? 0 : Number(a.agreedValue ?? 0)), 0);
  const abonado = citas.reduce((s, a) => s + Number(a.advanceAmount || 0), 0);
  fila = bloque(
    ws, fila, 'Valor de las citas (dato operativo, no contable)', ['', 'Monto', ''],
    [
      ['Valor acordado', valor, ''],
      ['Ya abonado', abonado, ''],
      ['Pendiente de cobrar', Math.max(0, valor - abonado), ''],
      ['Citas por canje', citas.filter((a) => a.isCanje).length, ''],
    ],
    { numFmt: { 1: '"$"#,##0.00' } }
  );

  const nota = ws.getCell(fila, 1);
  ws.mergeCells(fila, 1, fila, 3);
  nota.value =
    'El valor de la cita es lo acordado con el paciente, no lo facturado: la parte contable ' +
    'vive en Ventas. Este archivo no incluye cédula, teléfono, correo ni dirección.';
  nota.font = { size: 9, italic: true, color: { argb: 'FF94A3B8' } };
  nota.alignment = { vertical: 'top', wrapText: true, indent: 1 };
  ws.getRow(fila).height = 30;

  return ws;
}

/* ── Entrada ─────────────────────────────────────────────────────────────── */

/**
 * Arma el libro entero.
 *
 * @param {Array}  citas     las citas ya pobladas (paciente, sucursal, turnos…)
 * @param {object} meta      { titulo, subtitulo, periodo, filtros, resumen }
 * @param {object} opciones  { sinEnfermeria } — cómo se rotula «Quién atiende».
 *                           Las citas de solo enfermería las deja fuera el
 *                           llamador (con `soloEnfermeria`) ANTES de llegar aquí.
 * @returns {ExcelJS.Workbook}
 */
function construirLibroDeAgenda(citas, meta, opciones = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Vikingo';
  wb.created = new Date();
  // Las DOS hojas con las mismas opciones: si el detalle y el resumen rotularan
  // distinto, los totales por profesional no cuadrarían con las filas.
  hojaDeCitas(wb, citas, meta, opciones);
  hojaDeResumen(wb, citas, meta, opciones);
  return wb;
}

module.exports = { construirLibroDeAgenda, quienAtiende, servicioDeLaCita, soloEnfermeria };
