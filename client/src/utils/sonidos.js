/**
 * SONIDOS DE AVISO (oct-2026), como los de WhatsApp: un «pop» por mensaje
 * nuevo, un timbre corto por aviso de la campana, el tono de llamada entrante
 * y el de «está sonando» al llamar.
 *
 * Se SINTETIZAN con Web Audio en vez de cargar archivos: no hay nada que
 * descargar (ni que cachear mal el service worker) y suenan igual en todas las
 * máquinas.
 *
 * Tres cosas que no son obvias:
 *
 *  1. EL NAVEGADOR NO DEJA SONAR NADA HASTA QUE LA PERSONA TOCA LA PÁGINA
 *     (política de autoplay). `iniciarSonidos()` desbloquea el audio con el
 *     primer clic o tecla; antes de eso los avisos llegan en silencio.
 *  2. VARIAS PESTAÑAS = UN SOLO SONIDO. El aviso llega por socket a cada
 *     pestaña abierta; sin coordinar, tres pestañas eran tres «pops» desfasados.
 *     Se reparten con Web Locks: la primera pestaña que toma el candado del
 *     aviso es la que suena.
 *  3. El interruptor «Sonido de avisos» (campana) silencia mensajes y campana.
 *     Las LLAMADAS suenan siempre: perder una llamada es peor que una molestia.
 */

const CLAVE_PREF = 'vk-sonidos';
const EVENTO_PREF = 'vk-sonidos-cambio';

let ctx = null;

function contexto() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Desbloquea el audio con el primer gesto de la persona (ver cabecera, punto 1). */
export function iniciarSonidos() {
  const desbloquear = () => {
    const c = contexto();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
  };
  window.addEventListener('pointerdown', desbloquear, { passive: true });
  window.addEventListener('keydown', desbloquear);
  return () => {
    window.removeEventListener('pointerdown', desbloquear);
    window.removeEventListener('keydown', desbloquear);
  };
}

// ─────────── Preferencia (por navegador) ───────────

export function sonidosActivos() {
  try {
    return localStorage.getItem(CLAVE_PREF) !== '0';
  } catch {
    return true;
  }
}

export function setSonidosActivos(activos) {
  try {
    localStorage.setItem(CLAVE_PREF, activos ? '1' : '0');
  } catch { /* sin almacenamiento: dura lo que dure la pestaña */ }
  window.dispatchEvent(new Event(EVENTO_PREF));
}

/** Avisa cuando cambia la preferencia (en esta pestaña o en otra). */
export function alCambiarSonidos(fn) {
  const enOtra = (e) => { if (e.key === CLAVE_PREF) fn(sonidosActivos()); };
  const aqui = () => fn(sonidosActivos());
  window.addEventListener('storage', enOtra);
  window.addEventListener(EVENTO_PREF, aqui);
  return () => {
    window.removeEventListener('storage', enOtra);
    window.removeEventListener(EVENTO_PREF, aqui);
  };
}

// ─────────── Síntesis ───────────

/** Una nota con ataque rápido y caída suave. `t` en segundos desde ahora. */
function nota(c, destino, { freq, t = 0, dur = 0.2, vol = 0.2, tipo = 'sine' }) {
  const osc = c.createOscillator();
  const g = c.createGain();
  const inicio = c.currentTime + t;
  osc.type = tipo;
  osc.frequency.setValueAtTime(freq, inicio);
  g.gain.setValueAtTime(0.0001, inicio);
  g.gain.exponentialRampToValueAtTime(vol, inicio + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, inicio + dur);
  osc.connect(g).connect(destino);
  osc.start(inicio);
  osc.stop(inicio + dur + 0.05);
}

const PATRONES = {
  // Mensaje nuevo: dos gotas cortas y agudas.
  mensaje: (c, d) => {
    nota(c, d, { freq: 1046.5, t: 0, dur: 0.09, vol: 0.18 });
    nota(c, d, { freq: 1568, t: 0.07, dur: 0.16, vol: 0.16 });
  },
  // Aviso de la campana: campanilla de tres notas, más larga que el mensaje.
  aviso: (c, d) => {
    nota(c, d, { freq: 880, t: 0, dur: 0.35, vol: 0.18, tipo: 'triangle' });
    nota(c, d, { freq: 1318.5, t: 0.13, dur: 0.4, vol: 0.16, tipo: 'triangle' });
    nota(c, d, { freq: 1760, t: 0.26, dur: 0.55, vol: 0.12, tipo: 'sine' });
  },
  // Llamada entrante: arpegio tipo marimba, se repite mientras suena.
  timbre: (c, d) => {
    [659.3, 830.6, 987.8, 1318.5].forEach((freq, i) => {
      nota(c, d, { freq, t: i * 0.11, dur: 0.3, vol: 0.22, tipo: 'triangle' });
    });
    [659.3, 830.6, 987.8, 1318.5].forEach((freq, i) => {
      nota(c, d, { freq, t: 0.6 + i * 0.11, dur: 0.3, vol: 0.22, tipo: 'triangle' });
    });
  },
  // Llamada saliente sonando: tono doble largo y suave («tuuu…»).
  espera: (c, d) => {
    nota(c, d, { freq: 425, t: 0, dur: 1.2, vol: 0.07 });
    nota(c, d, { freq: 450, t: 0, dur: 1.2, vol: 0.05 });
  },
};

function reproducir(patron) {
  const c = contexto();
  if (!c) return;
  const tocar = () => {
    try {
      PATRONES[patron](c, c.destination);
    } catch { /* un aviso sin sonido no rompe nada */ }
  };
  if (c.state === 'running') {
    tocar();
    return;
  }
  // Sin un gesto previo el navegador no lo deja reanudar y la promesa no
  // resuelve: ese aviso se queda en silencio (ver cabecera, punto 1). Con un
  // tope para que un aviso viejo no suene de golpe al primer clic.
  const pedido = Date.now();
  c.resume().then(() => { if (Date.now() - pedido < 1500) tocar(); }).catch(() => {});
}

// ─────────── Una pestaña por aviso (ver cabecera, punto 2) ───────────

const esperar = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Ejecuta `fn` solo en UNA pestaña por clave. El candado se suelta cuando la
 * promesa de `retener` termina: para un aviso, unos segundos (cubre el retraso
 * entre pestañas); para el timbre, mientras la llamada suene.
 */
function enUnaPestana(clave, fn, retener = () => esperar(3000)) {
  if (!navigator.locks?.request) {
    fn();
    return;
  }
  navigator.locks
    .request(`vk-sonido:${clave}`, { ifAvailable: true }, async (candado) => {
      if (!candado) return;
      fn();
      await retener();
    })
    .catch(() => {});
}

// Dos avisos seguidos (el mismo aviso llega por el rol Y por la persona) son
// un solo sonido.
let ultimo = { patron: '', t: 0 };
function sinRepetir(patron, ms = 1200) {
  const ahora = Date.now();
  if (ultimo.patron === patron && ahora - ultimo.t < ms) return false;
  ultimo = { patron, t: ahora };
  return true;
}

/** «Pop» de mensaje nuevo. `clave` = id del mensaje. */
export function sonarMensaje(clave) {
  if (!sonidosActivos() || !sinRepetir('mensaje', 600)) return;
  enUnaPestana(`msg:${clave}`, () => reproducir('mensaje'));
}

/** Campanilla de un aviso nuevo de la campana. `clave` = id de la notificación. */
export function sonarAviso(clave) {
  if (!sonidosActivos() || !sinRepetir('aviso')) return;
  enUnaPestana(`aviso:${clave}`, () => reproducir('aviso'));
}

/**
 * Tono que se repite mientras la llamada suena: 'timbre' (entrante) o 'espera'
 * (saliente). Devuelve la función que lo para. Ignora la preferencia: las
 * llamadas suenan siempre.
 */
export function sonarEnBucle(patron, clave, cadaMs) {
  let parado = false;
  let soltar = () => {};
  const suelto = new Promise((r) => { soltar = r; });
  let timer = null;
  enUnaPestana(
    `bucle:${patron}:${clave}`,
    () => {
      const vuelta = () => {
        if (parado) return;
        reproducir(patron);
        timer = setTimeout(vuelta, cadaMs);
      };
      vuelta();
    },
    () => suelto
  );
  return () => {
    parado = true;
    clearTimeout(timer);
    soltar();
  };
}

// ─────────── Qué chat está a la vista (para no sonar por él) ───────────

let chatAbierto = null;

/** La bandeja avisa qué conversación tiene abierta (null al salir). */
export function marcarChatAbierto(id) {
  chatAbierto = id ? String(id) : null;
}

/**
 * ¿La persona está MIRANDO este chat ahora? Como en WhatsApp: si la ventana no
 * tiene el foco, el mensaje suena aunque el chat esté abierto.
 */
export function chatALaVista(id) {
  return !!id && chatAbierto === String(id)
    && document.visibilityState === 'visible' && document.hasFocus();
}
