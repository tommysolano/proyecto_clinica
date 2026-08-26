import api from '../api/axios';

/**
 * Alta del aparato en las notificaciones push.
 *
 * Se llama al entrar a la app con sesión iniciada. Solo funciona con la app
 * SERVIDA POR HTTPS y con el service worker registrado (ver public/sw.js), o sea
 * en producción y en la app instalada desde el móvil — que es justo donde hace
 * falta: cuando recepción asigna una cita, el doctor no está mirando la pantalla.
 *
 * SE PIDE EL PERMISO UNA SOLA VEZ. Si el usuario dice que no, el navegador
 * recuerda la negativa y volver a pedirlo no abre ningún diálogo; se marca en
 * localStorage para no repetir la llamada en cada carga.
 */
const MARCA_RECHAZO = 'pushDenegado';

/** base64url (lo que manda el servidor) → Uint8Array (lo que pide el navegador). */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function activarPush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    if (localStorage.getItem(MARCA_RECHAZO) === '1') return false;

    const reg = await navigator.serviceWorker.ready;

    // Si ya está suscrito, se reenvía igualmente al servidor: es lo que reengancha
    // el aparato cuando se cambia de usuario o se limpió la base.
    let sub = await reg.pushManager.getSubscription();

    if (!sub) {
      if (Notification.permission === 'denied') {
        localStorage.setItem(MARCA_RECHAZO, '1');
        return false;
      }
      if (Notification.permission !== 'granted') {
        const permiso = await Notification.requestPermission();
        if (permiso !== 'granted') {
          if (permiso === 'denied') localStorage.setItem(MARCA_RECHAZO, '1');
          return false;
        }
      }
      const { data } = await api.get('/push/public-key');
      if (!data?.publicKey) return false;
      sub = await reg.pushManager.subscribe({
        // Web Push exige que TODO aviso se le muestre al usuario; sin esto,
        // Chrome rechaza la suscripción.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(data.publicKey),
      });
    }

    const json = sub.toJSON();
    await api.post('/push/subscribe', { endpoint: json.endpoint, keys: json.keys });
    return true;
  } catch {
    // Nunca se propaga: sin push la app funciona igual, solo hay que mirar la
    // campana.
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
