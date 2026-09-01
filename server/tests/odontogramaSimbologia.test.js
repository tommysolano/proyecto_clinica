/**
 * SIMBOLOGÍA DEL ODONTOGRAMA.
 *
 * Dos cosas que se rompen en silencio:
 *
 *  1. El catálogo está DUPLICADO (server/constants y client/src/constants). Si se
 *     cambia un símbolo en uno y no en el otro, el odontólogo dibuja una cosa y
 *     el PDF imprime otra, sin ningún error.
 *  2. El símbolo se declara en el catálogo pero lo DIBUJA `SimboloCara` en
 *     Odontograma.jsx. Un símbolo que el catálogo nombra y el componente no sabe
 *     pintar cae al `default` — un círculo — y el sellante se ve idéntico a una
 *     caries. Nadie se entera hasta que un odontólogo lee mal una hoja.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { ODONTOGRAMA_ESTADOS } = require('../constants/specialtyCatalogs');

const CLIENTE = path.join(__dirname, '..', '..', 'client', 'src', 'constants', 'specialtyCatalogs.js');
const COMPONENTE = path.join(__dirname, '..', '..', 'client', 'src', 'components', 'Odontograma.jsx');

test('el sellante se dibuja con un ASTERISCO, no con un cuadro', () => {
  for (const key of ['sellanteNecesario', 'sellanteRealizado', 'sellante']) {
    const e = ODONTOGRAMA_ESTADOS.find((x) => x.key === key);
    assert.ok(e, `falta el estado ${key}`);
    assert.equal(e.simbolo, 'asterisco', `${key} tiene que ser un asterisco`);
    assert.equal(e.ambito, 'cara', 'el sellante se pinta sobre una cara');
  }
});

test('caries y obturado siguen siendo círculos: el asterisco los distingue', () => {
  for (const key of ['caries', 'obturado']) {
    assert.equal(ODONTOGRAMA_ESTADOS.find((x) => x.key === key).simbolo, 'circulo');
  }
});

test('el componente sabe dibujar TODOS los símbolos de cara del catálogo', () => {
  const fuente = fs.readFileSync(COMPONENTE, 'utf8');
  const simbolos = new Set(
    ODONTOGRAMA_ESTADOS.filter((e) => e.ambito === 'cara').map((e) => e.simbolo)
  );
  // 'circulo' es el caso por defecto de SimboloCara y no lleva rama propia.
  simbolos.delete('circulo');
  for (const s of simbolos) {
    assert.ok(
      fuente.includes(`simbolo === '${s}'`),
      `SimboloCara no tiene rama para '${s}': se pintaría como un círculo, igual que una caries`,
    );
  }
});

test('los cinco elementos: letras, colores y ciclos completos', () => {
  const {
    TERAPIA_ELEMENTOS, TERAPIA_CICLO_APOYO, TERAPIA_CICLO_CONTROL,
  } = require('../constants/specialtyCatalogs');

  assert.equal(TERAPIA_ELEMENTOS.length, 5);
  // Madera y Metal comparten la M A PROPÓSITO: lo que las distingue es el color.
  // Si alguien las pinta iguales, el gráfico deja de poder leerse.
  const porLetra = {};
  for (const e of TERAPIA_ELEMENTOS) (porLetra[e.letra] ||= []).push(e);
  assert.deepEqual(porLetra.M.map((e) => e.key).sort(), ['madera', 'metal']);
  assert.notEqual(
    porLetra.M[0].color, porLetra.M[1].color,
    'los dos círculos con M TIENEN que tener colores distintos o no hay forma de saber cuál es cuál',
  );
  for (const e of TERAPIA_ELEMENTOS) {
    assert.match(e.color, /^#[0-9a-f]{6}$/i, `${e.key}: color`);
    assert.ok(e.x >= 0 && e.x <= 100 && e.y >= 0 && e.y <= 100, `${e.key}: fuera del lienzo`);
  }

  // Los dos ciclos son cerrados: cinco tramos y cada elemento sale y entra una vez.
  const keys = TERAPIA_ELEMENTOS.map((e) => e.key).sort();
  for (const [nombre, ciclo] of [['apoyo', TERAPIA_CICLO_APOYO], ['control', TERAPIA_CICLO_CONTROL]]) {
    assert.equal(ciclo.length, 5, `ciclo de ${nombre}`);
    assert.deepEqual(ciclo.map((p) => p[0]).sort(), keys, `ciclo de ${nombre}: cada elemento sale una vez`);
    assert.deepEqual(ciclo.map((p) => p[1]).sort(), keys, `ciclo de ${nombre}: cada elemento entra una vez`);
    for (const [a, b] of ciclo) assert.notEqual(a, b, `ciclo de ${nombre}: flecha a sí mismo`);
  }
});

test('el catálogo de terapia del cliente es idéntico al del servidor', () => {
  const fuente = fs.readFileSync(CLIENTE, 'utf8');
  const {
    TERAPIA_ELEMENTOS, TERAPIA_FODA, TERAPIA_HABITOS_FILAS,
  } = require('../constants/specialtyCatalogs');
  for (const e of TERAPIA_ELEMENTOS) {
    const linea = fuente.split('\n').find((l) => l.includes(`key: '${e.key}'`) && l.includes('letra'));
    assert.ok(linea, `el cliente no tiene el elemento '${e.key}'`);
    assert.ok(linea.includes(`letra: '${e.letra}'`), `'${e.key}': la letra no coincide`);
    assert.ok(linea.includes(`color: '${e.color}'`), `'${e.key}': el color no coincide → ${linea.trim()}`);
  }
  for (const c of [...TERAPIA_FODA, ...TERAPIA_HABITOS_FILAS]) {
    assert.ok(fuente.includes(`key: '${c.key}'`), `el cliente no tiene '${c.key}'`);
  }
});

test('el catálogo del odontograma del cliente es idéntico al del servidor', () => {
  const fuente = fs.readFileSync(CLIENTE, 'utf8');
  for (const e of ODONTOGRAMA_ESTADOS) {
    // Se compara la línea entera del estado: clave, ámbito y símbolo juntos.
    const linea = fuente
      .split('\n')
      .find((l) => l.includes(`key: '${e.key}'`) && l.includes('ambito'));
    assert.ok(linea, `el cliente no tiene el estado '${e.key}'`);
    assert.ok(
      linea.includes(`simbolo: '${e.simbolo}'`),
      `'${e.key}': el servidor dice '${e.simbolo}' y el cliente dice otra cosa → ${linea.trim()}`,
    );
    assert.ok(linea.includes(`ambito: '${e.ambito}'`), `'${e.key}': el ámbito no coincide`);
  }
});
