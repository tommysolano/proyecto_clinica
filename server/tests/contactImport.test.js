/**
 * Importador de contactos: mapeo de filas (columna → campo) y lectura de los
 * archivos reales (CSV y XLSX) en streaming.
 *
 * Son las dos piezas donde una importación de 47k filas se tuerce en silencio:
 * un teléfono mal normalizado duplica contactos, y una cabecera mal leída manda
 * la columna equivocada al campo equivocado.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { mapRow, suggestMapping, splitFullName, guessField } = require('../utils/contactRowMapper');
const { readHeaders, iterateRows } = require('../utils/contactFileReader');

// ───────────────────────── mapeo de filas ─────────────────────────

const MAP = [
  { column: 'Celular', field: 'phone', skipEmpty: true },
  { column: 'Nombre', field: 'displayName', skipEmpty: true },
  { column: 'Correo', field: 'email', skipEmpty: true },
  { column: 'Etiquetas', field: 'tags', skipEmpty: true },
  { column: 'Ciudad', field: 'custom:ciudad', skipEmpty: true },
  { column: 'Basura', field: '', skipEmpty: true }, // columna no asignada
];

test('mapRow: fila típica de un Excel de WhatsApp', () => {
  const r = mapRow(
    {
      Celular: '099 911 1222',
      Nombre: 'Ligia Farfán',
      Correo: 'LIGIA@Example.com ',
      Etiquetas: 'feria, vip',
      Ciudad: 'Guayaquil',
      Basura: 'no importar',
    },
    MAP
  );
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.contact.phone, '593999111222'); // normalizado
  assert.equal(r.contact.displayName, 'Ligia Farfán');
  assert.equal(r.contact.firstName, 'Ligia');
  assert.equal(r.contact.lastName, 'Farfán');
  assert.deepEqual(r.contact.tags, ['feria', 'vip']);
  assert.equal(r.contact.customFields.ciudad, 'Guayaquil');
  // La columna sin asignar no aparece por ningún lado.
  assert.equal(r.contact.Basura, undefined);
});

test('mapRow: un contacto puede ser SOLO un teléfono', () => {
  // El caso real: media agenda de WhatsApp no tiene ni nombre.
  const r = mapRow({ Celular: '0999111222' }, MAP);
  assert.equal(r.ok, true);
  assert.equal(r.contact.phone, '593999111222');
  // Los campos que no venían quedan AUSENTES, no en ''. Es lo que hace que al
  // reimportar un archivo sin la columna Nombre no se borre el nombre que ya
  // tenía el contacto (un '' sí lo pisaría).
  assert.equal('displayName' in r.contact, false);
  assert.equal('email' in r.contact, false);
});

test('mapRow: sin teléfono no hay contacto', () => {
  const r = mapRow({ Nombre: 'Juan', Celular: '' }, MAP);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'sin teléfono');
});

test('mapRow: un teléfono ilegible se rechaza explicando por qué y con el valor', () => {
  const r = mapRow({ Celular: '12345', Nombre: 'Juan' }, MAP);
  assert.equal(r.ok, false);
  assert.equal(r.value, '12345'); // el informe le enseña al usuario qué corregir
  assert.match(r.reason, /Ecuador|indicativo/);
});

test('mapRow: "omitir valores vacíos" no manda cadenas vacías', () => {
  const conSkip = mapRow({ Celular: '0999111222', Correo: '' }, MAP);
  assert.equal('email' in conSkip.contact, false);

  // Con skipEmpty desactivado sí se manda (para poder BORRAR un dato al actualizar).
  const sinSkip = mapRow(
    { Celular: '0999111222', Correo: '' },
    [{ column: 'Celular', field: 'phone' }, { column: 'Correo', field: 'email', skipEmpty: false }]
  );
  assert.equal(sinSkip.contact.email, '');
});

test('mapRow: nombres y apellidos separados componen el nombre visible', () => {
  const r = mapRow(
    { Cel: '0999111222', N: 'Ligia', A: 'Farfán' },
    [
      { column: 'Cel', field: 'phone' },
      { column: 'N', field: 'firstName' },
      { column: 'A', field: 'lastName' },
    ]
  );
  assert.equal(r.contact.displayName, 'Ligia Farfán');
});

test('splitFullName: parte por la primera palabra y no se pone creativo', () => {
  assert.deepEqual(splitFullName('Juan Pérez'), { firstName: 'Juan', lastName: 'Pérez' });
  assert.deepEqual(splitFullName('Ana María de la Cruz'), { firstName: 'Ana', lastName: 'María de la Cruz' });
  assert.deepEqual(splitFullName('Dome'), { firstName: 'Dome', lastName: '' });
  assert.deepEqual(splitFullName('  '), { firstName: '', lastName: '' });
});

test('suggestMapping: adivina las columnas comunes y no repite campo', () => {
  const m = suggestMapping(['First Name', 'Last Name', 'Phone', 'Email', 'Ciudad', 'Nombres']);
  const byCol = Object.fromEntries(m.map((x) => [x.column, x.field]));
  assert.equal(byCol['Phone'], 'phone');
  assert.equal(byCol['First Name'], 'firstName');
  assert.equal(byCol['Last Name'], 'lastName');
  assert.equal(byCol['Email'], 'email');
  // "Ciudad" es una columna de datos reconocible: se propone como campo personalizado
  // (para segmentar/usar de variable), no como "No importar".
  assert.equal(byCol['Ciudad'], 'custom:ciudad');
  // 'Nombres' también sería firstName, pero ya está tomado: dos columnas al mismo
  // campo se pisarían, así que se deja sin asignar para que el usuario decida.
  assert.equal(byCol['Nombres'], '');
});

// ───────────────────────── lectura de archivos ─────────────────────────

const tmp = (name) => path.join(os.tmpdir(), `test_${Date.now()}_${name}`);

test('CSV: lee cabeceras con muestras y recorre las filas', async () => {
  const file = tmp('contactos.csv');
  // Con BOM (como exporta Excel), comas dentro de comillas y una fila corta.
  fs.writeFileSync(
    file,
    '﻿Nombre,Celular,Notas\n' +
      '"Farfán, Ligia",0999111222,"Interesada en botox, urgente"\n' +
      'Dome,0988776655,\n' +
      'Juan,0977665544\n',
    'utf8'
  );
  try {
    const { headers, samples } = await readHeaders(file, 'contactos.csv');
    assert.deepEqual(headers, ['Nombre', 'Celular', 'Notas']); // el BOM no ensucia la 1ª
    assert.deepEqual(samples.find((s) => s.column === 'Nombre').values, ['Farfán, Ligia', 'Dome', 'Juan']);

    const rows = [];
    await iterateRows(file, 'contactos.csv', (obj, rowNo) => { rows.push({ ...obj, rowNo }); });
    assert.equal(rows.length, 3);
    // La coma dentro de comillas no parte la celda.
    assert.equal(rows[0].Nombre, 'Farfán, Ligia');
    assert.equal(rows[0].Notas, 'Interesada en botox, urgente');
    assert.equal(rows[0].rowNo, 2); // fila real del archivo (1 = cabecera)
    // Una fila con menos columnas no rompe la importación.
    assert.equal(rows[2].Nombre, 'Juan');
  } finally {
    fs.unlinkSync(file);
  }
});

test('XLSX: lee cabeceras y filas', async () => {
  const file = tmp('contactos.xlsx');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Contactos');
  ws.addRow(['Nombre', 'Celular']);
  ws.addRow(['Ligia', '0999111222']);
  ws.addRow(['Dome', '0988776655']);
  await wb.xlsx.writeFile(file);
  try {
    const { headers, samples } = await readHeaders(file, 'contactos.xlsx');
    assert.deepEqual(headers, ['Nombre', 'Celular']);
    assert.deepEqual(samples.find((s) => s.column === 'Celular').values, ['0999111222', '0988776655']);

    const rows = [];
    await iterateRows(file, 'contactos.xlsx', (obj) => { rows.push(obj); });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].Nombre, 'Ligia');
  } finally {
    fs.unlinkSync(file);
  }
});

test('columnas sin título o repetidas no rompen el mapeo', async () => {
  const file = tmp('raro.csv');
  // Dos columnas "Tel" y una sin título: si se mezclaran, el mapeo mandaría el
  // dato al campo equivocado.
  fs.writeFileSync(file, 'Tel,Tel,\n0999111222,0988776655,x\n', 'utf8');
  try {
    const { headers } = await readHeaders(file, 'raro.csv');
    assert.deepEqual(headers, ['Tel', 'Tel (2)', 'Columna 3']);
    const rows = [];
    await iterateRows(file, 'raro.csv', (o) => rows.push(o));
    assert.equal(rows[0]['Tel'], '0999111222');
    assert.equal(rows[0]['Tel (2)'], '0988776655');
  } finally {
    fs.unlinkSync(file);
  }
});

test('el archivo entero se recorre sin cargarlo en memoria (5.000 filas)', async () => {
  const file = tmp('grande.csv');
  const lines = ['Nombre,Celular'];
  for (let i = 0; i < 5000; i++) {
    lines.push(`Contacto ${i},09${String(90000000 + i).slice(0, 8)}`);
  }
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  try {
    let count = 0;
    await iterateRows(file, 'grande.csv', () => { count++; });
    assert.equal(count, 5000);
  } finally {
    fs.unlinkSync(file);
  }
});

test('suggestMapping: "Nombre completo" NO se confunde con "Nombres"', () => {
  // La regla de firstName no está anclada, así que "Nombre completo" —que empieza
  // por "Nombre"— la ganaba y el nombre ENTERO acababa en firstName: la plantilla
  // saludaba "Hola María José Pérez Gómez" y {{apellido}} salía vacío.
  assert.equal(guessField('Nombre completo'), 'displayName');
  assert.equal(guessField('Nombre Completo'), 'displayName');
  assert.equal(guessField('nombre_completo'), 'displayName');
  assert.equal(guessField('Nombre de contacto'), 'displayName');
  assert.equal(guessField('Full Name'), 'displayName');
  assert.equal(guessField('Name'), 'displayName');

  // Pero una columna de nombre de pila sigue siendo firstName.
  assert.equal(guessField('Nombre'), 'firstName');
  assert.equal(guessField('Nombres'), 'firstName');
  assert.equal(guessField('First Name'), 'firstName');
  assert.equal(guessField('Nombre del paciente'), 'firstName');
  assert.equal(guessField('Apellidos'), 'lastName');
});

test('cadena completa: Excel con nombre y apellido separados llena bien la plantilla', () => {
  // Es el caso que importa: columnas separadas → cada variable con SU dato.
  const { buildContactTemplateVars, suggestVarMapping } = require('../utils/contactTemplateVars');
  const mapping = suggestMapping(['Nombre', 'Apellido', 'Numero']);
  const r = mapRow({ Nombre: 'Emily', Apellido: 'Torres Vera', Numero: '0999111222' }, mapping);

  assert.equal(r.ok, true);
  assert.equal(r.contact.firstName, 'Emily');
  assert.equal(r.contact.lastName, 'Torres Vera');
  assert.equal(r.contact.phone, '593999111222');

  const tpl = {
    body: 'Hola {{nombre}} {{apellido}}, te esperamos.',
    variables: [{ key: 'nombre', example: 'María' }, { key: 'apellido', example: 'Pérez' }],
  };
  assert.deepEqual(
    buildContactTemplateVars(tpl, r.contact, suggestVarMapping(tpl)),
    ['Emily', 'Torres Vera']
  );
});

test('cadena completa: una sola columna de nombre completo se parte para el saludo', () => {
  const { buildContactTemplateVars, suggestVarMapping } = require('../utils/contactTemplateVars');
  const mapping = suggestMapping(['Nombre completo', 'Celular']);
  const r = mapRow({ 'Nombre completo': 'María José Pérez Gómez', Celular: '0998220447' }, mapping);

  // La primera palabra es el nombre: el saludo queda bien, que es lo que importa.
  assert.equal(r.contact.firstName, 'María');
  assert.equal(r.contact.displayName, 'María José Pérez Gómez', 'se conserva lo que venía en el archivo');

  const tpl = { body: 'Hola {{nombre}}', variables: [{ key: 'nombre', example: 'X' }] };
  assert.deepEqual(buildContactTemplateVars(tpl, r.contact, suggestVarMapping(tpl)), ['María']);
});
