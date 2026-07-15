# Verificar cambios end-to-end (Shiluv)

Receta comprobada para levantar la app real en local (Windows) sin tocar la BD Atlas del `.env`, y conducirla con Puppeteer.

## Levantar entorno aislado

1. **Mongo en memoria** (queda vivo en background; usa el paquete del server):
   ```js
   // node script en background; imprime la URI (p.ej. mongodb://127.0.0.1:PUERTO/?replicaSet=testset)
   const { MongoMemoryReplSet } = require('<repo>/server/node_modules/mongodb-memory-server');
   const rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
   console.log(rs.getUri());
   ```
2. **Seed** (crea super admin y clínica):
   `cd server && MONGODB_URI="<uri>/shiluv_verify?replicaSet=testset" node seed.js`
   → credenciales: `admin@shiluv.com` / `Shiluv2026!` (login autoselecciona la clínica si hay una sola).
3. **Backend**: `MONGODB_URI=... PORT=5000 node index.js` (Vite proxya `/api` y `/socket.io` a :5000).
4. **Frontend**: `cd client && npx vite --port 5173 --strictPort`.
5. Para probar envíos de WhatsApp sin red: crear una `WhatsappAccount` stub
   `{ label, connectionType: 'cloud_api', accessToken: '', enabled: true, isDefault: true }`
   → el provider responde "simulated/failed" de forma controlada pero el mensaje se persiste
   (deliveryStatus `failed`), suficiente para verificar el cableado completo.

## Conducir la UI

- **Puppeteer ya está instalado** en `server/node_modules/puppeteer` (dependencia de whatsapp-web.js) — requerirlo por ruta absoluta.
- Login: `input[type="email"]`, `input[type="password"]`, `button[type="submit"]`.
- Para inputs controlados por React usar el setter nativo + `dispatchEvent(new Event('input', { bubbles: true }))` (un `.value=` directo no dispara onChange).
- OJO clicks por texto: hay botones con texto contenido en otros (p.ej. "Simular" vs "Simular entrante") — comparar con `.trim() === texto`.
- Crear conversaciones de prueba con el botón **Simular entrante** del chat (teléfono + nombre + mensaje) — abre la ventana de 24h.

## Gotchas

- `node --check` para sintaxis backend; `cd client && npm run build` para el frontend (warnings de lightningcss/chunk size son preexistentes).
- Los tests van con `node --test tests/<archivo>` desde `server/` (mongodb-memory-server, sin config extra).
- Matar procesos al final: buscar `node.exe` con CommandLine `index.js|vite|mem-mongo`.
