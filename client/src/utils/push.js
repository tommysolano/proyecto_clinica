import api from '../api/axios';

/**
 * Alta del aparato en las notificaciones push.
 *
 * Solo funciona con la app SERVIDA POR HTTPS y con el service worker registrado
 * (ver public/sw.js), o sea en producción y en la app instalada desde el móvil
 * — que es justo donde hace falta: cuando recepción asigna una cita, el doctor
 * no está mirando la pantalla.
 *
 * POR QUÉ EL PERMISO SE PIDE CON UN CLIC Y NO AL ENTRAR.
 * Antes se pedía solo, en cuanto cargaba la app. Sale un cuadro del navegador
 * sin explicación, en medio de otra cosa; casi todo el mundo lo descarta, y
 * descartarlo tres veces hace que Chrome lo bloquee para siempre. Resultado
 * medido en producción: los únicos suscritos eran quienes lo aceptaron de
 * casualidad, y ningún doctor recibía nada. Ahora al entrar solo se REGISTRA el
 * aparato si el permiso ya estaba concedido, y pedirlo es un botón de la
 * campana, que además deja probarlo.
 */

/** base64url (lo que manda el servidor) → Uint8Array (lo que pide el navegador). */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/** ¿Este navegador puede recibir avisos push? */
export function pushSoportado() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/**
 * Estado real, para poder DECIRLE al usuario qué pasa en vez de fallar callando.
 *
 * `permiso`: 'default' (no se ha pedido) | 'granted' | 'denied'.
 * `suscrito`: si este navegador ya tiene su suscripción registrada.
 */
export async function estadoPush() {
  if (!pushSoportado()) return { soportado: false, permiso: 'unsupported', suscrito: false };
  let suscrito = false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    suscrito = !!(await reg?.pushManager.getSubscription());
  } catch {
    /* sin registro todavía */
  }
  return { soportado: true, permiso: Notification.permission, suscrito };
}

/**
 * Registra el aparato. Con `pedirPermiso` en false (la carga de la app) no
 * molesta a nadie: si el permiso no está concedido, se va sin hacer nada.
 *
 * Devuelve 'ok' | 'sin-soporte' | 'sin-permiso' | 'denegado' | 'error'.
 */
export async function activarPush({ pedirPermiso = false } = {}) {
  try {
    if (!pushSoportado()) return 'sin-soporte';

    const reg = await navigator.serviceWorker.ready;

    // Si ya está suscrito se reenvía igualmente al servidor: es lo que reengancha
    // el aparato cuando se cambia de usuario o se limpió la base.
    let sub = await reg.pushManager.getSubscription();

    if (!sub) {
      if (Notification.permission === 'denied') return 'denegado';
      if (Notification.permission !== 'granted') {
        if (!pedirPermiso) return 'sin-permiso';
        const permiso = await Notification.requestPermission();
        if (permiso === 'denied') return 'denegado';
        if (permiso !== 'granted') return 'sin-permiso';
      }
      const { data } = await api.get('/push/public-key');
      if (!data?.publicKey) return 'error';
      sub = await reg.pushManager.subscribe({
        // Web Push exige que TODO aviso se le muestre al usuario; sin esto,
        // Chrome rechaza la suscripción.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(data.publicKey),
      });
    }

    const json = sub.toJSON();
    await api.post('/push/subscribe', { endpoint: json.endpoint, keys: json.keys });
    return 'ok';
  } catch {
    // Nunca se propaga: sin push la app funciona igual, solo hay que mirar la
    // campana.
    return 'error';
  }
}

/** Manda un aviso de prueba a ESTE aparato, para comprobar que llega de verdad. */
export async function probarPush() {
  try {
    await api.post('/push/test');
    return true;
  } catch {
    return false;
  }
}

/** Baja del aparato (al cerrar sesión). */
export async function desactivarPush() {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await api.post('/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  } catch {
    /* sin ruido: cerrar sesión no puede fallar por esto */
  }
}
