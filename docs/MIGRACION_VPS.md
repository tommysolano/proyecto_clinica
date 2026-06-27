# Migración a VPS DigitalOcean — Guía técnica

> Estado: **diagnóstico previo a migrar**. La base de datos permanece en MongoDB
> Atlas. El VPS solo corre backend, frontend (estático), procesos auxiliares y Nginx.
> No se modifican datos ni secretos reales en este documento.

---

## 1. Arquitectura objetivo

```
                       Internet (HTTPS :443)
                              │
                        ┌─────▼─────┐
                        │   Nginx   │  (TLS con Let's Encrypt)
                        └─────┬─────┘
            ┌─────────────────┼──────────────────────┐
            │                 │                       │
   sirve archivos      proxy /api  ───────►   proxy /socket.io (WebSocket)
   estáticos del            │                       │
   build (client/dist)      ▼                       ▼
                     ┌───────────────────────────────────┐
                     │  Node/Express + Socket.IO  :5000   │  (PM2: clinica-api)
                     │  + jobs internos (cron, workflows, │
                     │    WhatsApp QR/Chromium)           │
                     └───────────────────┬───────────────┘
                                         │ mongoose
                                         ▼
                              MongoDB Atlas (externo, NO migra)
```

- **Un solo proceso Node** corre el API HTTP, Socket.IO y todos los jobs en
  segundo plano (ver §6). No hay workers separados hoy.
- Nginx hace dos trabajos: (a) servir el build estático del frontend y
  (b) reverse-proxy de `/api` y `/socket.io` hacia Node en `localhost:5000`.

---

## 2. Estructura del proyecto

Monorepo con dos paquetes + un `package.json` raíz de orquestación.

| Carpeta | Rol | Stack |
|---|---|---|
| `/` (raíz) | scripts de dev (`concurrently`) | — |
| `/server` | Backend API | Node + Express 4 + Mongoose 8 + Socket.IO 4 |
| `/client` | Frontend SPA | React 19 + Vite 8 + Tailwind 4 |

**Comandos reales:**

```bash
# Instalar TODO (desde la raíz)
npm run install-all            # = (cd server && npm install) + (cd client && npm install)

# Backend
cd server && npm install
cd server && npm start         # node index.js  (producción)
cd server && npm run dev       # nodemon (solo desarrollo)

# Frontend
cd client && npm install
cd client && npm run build     # genera client/dist/   (carpeta de salida Vite por defecto)
cd client && npm run preview   # sirve el build localmente para probar
```

- **Build del frontend:** sí, `vite build` → **`client/dist/`** (HTML+JS+CSS estáticos).
  Hoy NO está versionado en git (se genera en el destino). Es lo que Nginx debe servir.

---

## 3. Backend

- **Framework:** Express 4.21 sobre `http.createServer` + Socket.IO 4.8.
  Entry point: `server/index.js`.
- **Puerto:** `const PORT = process.env.PORT || 5000;` → **usa `process.env.PORT` correctamente.**
- **Reverse proxy:** apto. Solo escucha HTTP en localhost; Nginx termina TLS y
  reenvía. **Pendiente recomendado:** añadir `app.set('trust proxy', 1)` para que
  `req.protocol`/IP del cliente sean correctos detrás de Nginx (afecta a
  `PUBLIC_API_URL` calculada y futuros rate-limits).
- **Healthcheck:** **sí** → `GET /api/health` responde `{ status: 'ok', timestamp }`.
  Úsalo para PM2/monitor/uptime y para validar el proxy de Nginx.
- **CORS / WebSocket:** ambos leen `ALLOWED_ORIGINS` (CSV). Socket.IO acepta
  `websocket` y `polling`.

> Nota menor: `connectDB()` se invoca dos veces en `index.js` (líneas 11 y 107).
> No es bloqueante (Mongoose multiplexa), pero se puede limpiar.

---

## 4. Frontend

- **URL del backend:** `client/src/api/axios.js` y `client/src/context/SocketContext.jsx`
  usan **`import.meta.env.VITE_API_URL`**.
  - Si `VITE_API_URL` está definida → `${VITE_API_URL}/api`.
  - Si está vacía → usa rutas **relativas** (`/api`), ideal cuando Nginx sirve
    front y back bajo el mismo dominio.
- **No hay URLs quemadas de Render/Vercel en el código.** Las únicas referencias
  a Vercel/Render están en archivos `.env.example` (documentación) y a `localhost`
  en `vite.config.js` (solo dev: proxy a `localhost:5000`).
- **Variable a usar para el nuevo backend:** `VITE_API_URL` (se incrusta en build;
  hay que **recompilar** si cambia). Recomendado dejarla vacía y servir todo bajo
  un dominio con Nginx proxyando `/api` + `/socket.io`.
- **Servible como estático desde Nginx:** sí. SPA con fallback a `index.html`
  (en Vercel se hacía con `vercel.json` rewrites; en Nginx con `try_files`).

---

## 5. Variables de entorno

Ver plantillas completas: `server/.env.production.example` y
`client/.env.production.example`.

### Backend (`server/.env`)

| Variable | Tipo | Origen | Notas para VPS |
|---|---|---|---|
| `MONGODB_URI` | privada | **copiar de Render** | Atlas, sin cambios |
| `JWT_SECRET` | privada | **copiar de Render** | reutilizar para no invalidar sesiones |
| `JWT_EXPIRES_IN` | pública | copiar de Render | `7d` |
| `PORT` | — | nuevo en VPS | `5000` (interno, detrás de Nginx) |
| `ALLOWED_ORIGINS` | config | **CAMBIA** | poner dominio del frontend del VPS |
| `INVOICE_ENCRYPTION_KEY` | privada | **copiar de Render (idéntico)** | si cambia, se rompe la firma SRI |
| `PUBLIC_API_URL` | config | **CAMBIA** | dominio público del VPS + `/api` |
| `SECRETS_KEY` | privada | **copiar de Render (idéntico)** | si cambia, tokens WhatsApp ilegibles |
| `WHATSAPP_VERIFY_TOKEN` | privada | copiar de Render (si existe) | handshake webhook Meta |
| `WHATSAPP_API_VERSION` | pública | opcional | default `v20.0` |
| `TEMPLATE_SYNC_INTERVAL_MIN` | config | opcional | default 60 |
| `ANTHROPIC_API_KEY` | privada | copiar de Render (si existe) | IA del call center |
| `ANTHROPIC_MODEL` | pública | opcional | — |
| `PUPPETEER_EXECUTABLE_PATH` | config | **nuevo en VPS** | ruta a Chromium del sistema |
| `ADMIN_NAME/EMAIL/PASSWORD` | privada | solo script | crear superadmin puntual |

### Frontend (`client/.env.production`)

| Variable | Tipo | Origen | Notas |
|---|---|---|---|
| `VITE_API_URL` | **pública** (va al navegador) | **copiar de Vercel y CAMBIAR** | dominio del backend en VPS, o vacío si mismo dominio |

> ⚠️ El `.env` local actual (`server/.env`) solo tiene 6 variables
> (`ALLOWED_ORIGINS, INVOICE_ENCRYPTION_KEY, JWT_EXPIRES_IN, JWT_SECRET,
> MONGODB_URI, PORT`). Antes de migrar, **verifica en el panel de Render** si
> existen además `PUBLIC_API_URL`, `SECRETS_KEY`, `WHATSAPP_VERIFY_TOKEN`,
> `ANTHROPIC_API_KEY` (la captura de Render se corta en `MONGODB_URI`). Las que
> falten, créalas en el VPS según las features que uses.

---

## 6. Procesos en segundo plano

Todos corren **dentro del mismo proceso Node** (`index.js`), arrancados tras
conectar a Mongo. No necesitan proceso aparte hoy:

| Job | Frecuencia | Fuente |
|---|---|---|
| Auto "no asistió" de citas pasadas | diario | `utils/autoNoShow` |
| Reanudar flujos de mensajes vencidos | 60 s | `chatController.processDueFlowRuns` |
| Mensajes de campañas encolados | 60 s | `campaignController.processDueScheduledMessages` |
| Motor de workflows (eventos + esperas) | 60 s | `utils/workflowEngine` |
| Cumpleaños del día | diario | `utils/birthdayJob` |
| Sync de plantillas WhatsApp con Meta | `TEMPLATE_SYNC_INTERVAL_MIN` | `messageTemplateController` |
| **WhatsApp por QR** (whatsapp-web.js) | persistente | `utils/whatsappQrManager` |
| Socket.IO (tiempo real) | persistente | `realtime.js` |

- **WhatsApp QR** levanta **un Chromium headless por número (~300–500 MB RAM)**.
  La sesión se persiste en **Mongo** (RemoteAuth + wwebjs-mongo), así que sobrevive
  a reinicios. Requiere Chromium del sistema y suficiente RAM en el VPS.
- **Proceso PM2 propuesto:** un único `clinica-api`. Si más adelante el QR de
  WhatsApp consume demasiado, se puede extraer a un proceso aparte, pero **hoy no
  es necesario** (los jobs y el QR comparten el mismo proceso del API).

---

## 7. Archivos y uploads (persistencia)

El backend escribe a disco local con `multer.diskStorage` y `fs`:

| Ruta | Contenido | Riesgo |
|---|---|---|
| `server/storage/certs/<clinicId>.p12` | Certificados de firma electrónica SRI | **Crítico**: si se pierde, no se factura |
| `server/storage/followups/<clinicId>/` | Adjuntos de fichas clínicas (seguimientos) | **Crítico**: datos de pacientes |
| `server/assets/Shiluv-logo-4.png` | Logo (versionado en git) | OK |

- En **Render** estas carpetas son **efímeras** (se borran en cada deploy) →
  probablemente ya es un problema hoy. **El VPS lo resuelve** porque el disco
  persiste, **siempre que no borres `server/storage/` al hacer `git pull`/redeploy.**
- **Recomendación:** mover `storage/` fuera del árbol de la app (p. ej.
  `/var/lib/clinica/storage`) y apuntar el código allí, o como mínimo **incluir
  `server/storage/` en backups** y nunca limpiarlo en el deploy.
- Subidas que van a **memoria** (no a disco): logos de clínica, extractos
  bancarios, galería de chat → no requieren carpeta persistente.

---

## 8. Webhooks e integraciones externas

URLs que se exponen al exterior y deberán **reconfigurarse al nuevo dominio**:

| Integración | Endpoint (relativo) | Dónde se reconfigura |
|---|---|---|
| WhatsApp Cloud API (Meta) | `POST/GET /api/chats/webhook/whatsapp` | Meta for Developers |
| Messenger | `/api/chats/webhook/messenger/:clinicId` | Meta for Developers |
| Instagram | `/api/chats/webhook/instagram/:clinicId` | Meta for Developers |
| TikTok | `/api/chats/webhook/tiktok/:clinicId` | TikTok Developer |
| Webhook genérico | `/api/chats/webhook` | según proveedor |

- El backend muestra estas URLs al admin usando `PUBLIC_API_URL`
  (`GET /api/call-center-config/webhook-urls`). **Al cambiar el dominio, actualiza
  `PUBLIC_API_URL`** y vuelve a pegar las URLs en cada panel (Meta/TikTok).
- **SRI Ecuador:** salidas a `*.sri.gob.ec` (recepción/autorización de
  comprobantes). Son llamadas **salientes**, no reciben callbacks → no requieren
  cambio de URL, pero la **IP del VPS** debe poder salir a esos hosts.
- **Anthropic:** salida a la API de Claude (IA del call center). Saliente, sin callback.
- No se detectó Uber ni pasarelas de pago integradas por webhook.

> No cambies nada de esto hasta que el dominio del VPS tenga HTTPS estable.

---

## 9. MongoDB Atlas

- El proyecto usa **`process.env.MONGODB_URI`** vía `server/config/db.js`
  (`mongoose.connect`). **No hay cadena de conexión hardcodeada.**
- **La base se queda en Atlas.** Solo hay que: **permitir la IP pública del VPS**
  en Atlas → *Network Access* → *Add IP Address* (la IP estática del droplet).
  Evita `0.0.0.0/0` en producción.
- No se modifican modelos ni datos en la migración.

---

## 10. Seguridad

| Punto | Estado | Acción |
|---|---|---|
| Secretos hardcodeados | ✅ Ninguno (sin fallbacks de `JWT_SECRET`/keys) | — |
| `.env` ignorado por git | ✅ Sí (`server/.env` y `client/.env` ignorados) | — |
| Certificados/keys en git | ✅ Ninguno trackeado | — |
| `.gitignore` | ⚠️ Muy escueto (`node_modules/`, `.env`) | endurecer (ver abajo) |
| `helmet` | ❌ No instalado | **añadir** cabeceras de seguridad |
| `express-rate-limit` | ❌ No instalado | añadir al menos en `/api/auth/login` |
| Logs de acceso/errores | ⚠️ Solo `console`; sin `morgan` | PM2 ya captura stdout; opcional `morgan` |
| JWT | ✅ Verificación correcta, sin default inseguro | reutilizar secret |
| CORS | ✅ Allowlist por env | fijar dominio de prod (no Vercel) |
| Cifrado en reposo | ✅ P12 (AES-CBC) y secrets WhatsApp (AES-GCM) | **conservar las mismas keys** |

`.gitignore` sugerido (endurecimiento, opcional pero recomendado):

```gitignore
node_modules/
.env
.env.*
!.env.example
!.env.production.example
client/dist/
server/storage/
*.log
*.p12
*.pfx
```

---

## 11. Dependencias y Node

- **No hay `engines`, `.nvmrc` ni `.node-version`.** Stack moderno (Vite 8, React 19,
  Mongoose 8, `node --test`).
- **Node recomendado en el VPS: Node 20 LTS o 22 LTS** (Ubuntu 22.04/24.04).
  Vite 8 y React 19 requieren Node ≥ 20.19 / ≥ 22.12. Evitar Node 18 (EOL).
- `npm install` y `npm run build` funcionan en Ubuntu sin cambios. **Puppeteer /
  whatsapp-web.js** sí requieren librerías de sistema para Chromium (ver §12).

---

## 12. Despliegue en el VPS

### 12.1 Paquetes de sistema (Ubuntu)

```bash
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Nginx + Certbot
sudo apt-get install -y nginx
sudo apt-get install -y certbot python3-certbot-nginx

# Chromium + dependencias para Puppeteer / whatsapp-web.js
sudo apt-get install -y chromium-browser \
  fonts-liberation libnss3 libatk-bridge2.0-0 libgbm1 libasound2 \
  libgtk-3-0 libxshmfence1 ca-certificates
# Luego en server/.env: PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# PM2
sudo npm install -g pm2
```

### 12.2 PM2 — `ecosystem.config.cjs` (crear en el VPS, no en el repo)

```js
module.exports = {
  apps: [
    {
      name: 'clinica-api',
      cwd: '/var/www/clinica/server',
      script: 'index.js',
      instances: 1,            // 1 sola instancia: Socket.IO + jobs + WhatsApp QR
      exec_mode: 'fork',       // NO cluster (estado en memoria del QR/sockets)
      max_memory_restart: '1G',
      env: { NODE_ENV: 'production' },
      // las variables sensibles viven en server/.env (dotenv las carga)
      out_file: '/var/log/clinica/api.out.log',
      error_file: '/var/log/clinica/api.err.log',
      time: true,
    },
  ],
};
```

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup            # genera el servicio systemd para arranque automático
```

### 12.3 Nginx — sitio (un solo dominio sirve front + proxy del API)

```nginx
server {
    server_name app.tudominio.com;

    # Frontend estático (build de Vite)
    root /var/www/clinica/client/dist;
    index index.html;

    # SPA: cualquier ruta cae en index.html
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API REST → Node
    location /api/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket (Socket.IO)
    location /socket.io/ {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;   # conexiones largas
    }

    client_max_body_size 12M;       # acorde al límite de 10MB del API
    listen 80;
}
```

> Con este esquema (mismo dominio) puedes dejar `VITE_API_URL` **vacío** y
> `ALLOWED_ORIGINS=https://app.tudominio.com`. Si usas subdominio aparte para el
> API, ajusta ambos.

### 12.4 HTTPS

```bash
sudo certbot --nginx -d app.tudominio.com
# Certbot reescribe el bloque a listen 443 ssl y configura la renovación automática.
```

### 12.5 Comandos de operación

```bash
# Instalar dependencias
cd /var/www/clinica && npm run install-all

# Compilar frontend
cd /var/www/clinica/client && npm run build

# Iniciar / reiniciar backend
pm2 start ecosystem.config.cjs        # primera vez
pm2 restart clinica-api               # tras un deploy
pm2 reload clinica-api                # reinicio sin downtime (cuidado con WhatsApp QR)

# Ver logs
pm2 logs clinica-api
pm2 logs clinica-api --lines 200
tail -f /var/log/clinica/api.err.log

# Estado / salud
pm2 status
curl -s http://127.0.0.1:5000/api/health
```

### 12.6 Backups mínimos

- **Base de datos:** Atlas ya hace backups gestionados (verifica el plan/retención).
- **`server/storage/`** (certificados P12 + adjuntos clínicos): backup periódico
  fuera del VPS (cron + `tar` a Spaces/S3 o `rsync`). **Es lo único en disco que
  no está en Atlas ni en git.**
- **`server/.env`:** guárdalo en un gestor de secretos / bóveda offline.

---

## 13. Plan de migración paso a paso

1. **Preparar VPS:** Ubuntu LTS, usuario no-root, firewall (`uff allow 80,443,OpenSSH`),
   Node 20, Nginx, PM2, Chromium + libs (§12.1). Anota la **IP pública estática**.
2. **Clonar repo** en `/var/www/clinica`.
3. **Instalar dependencias:** `npm run install-all`.
4. **Configurar `.env`:** copiar `server/.env.production.example` → `server/.env`
   y `client/.env.production.example` → `client/.env.production`; rellenar con los
   valores de Render/Vercel (ver §5). `chmod 600 server/.env`.
5. **Atlas Network Access:** añadir la IP del VPS (Atlas › Network Access).
6. **Probar backend en localhost:** `cd server && node index.js`; en otra shell
   `curl http://127.0.0.1:5000/api/health` → `{ "status": "ok" }`.
7. **Compilar y probar frontend:** `cd client && npm run build`; revisar `client/dist`.
8. **Configurar Nginx** (§12.3) y `nginx -t && systemctl reload nginx`.
9. **Configurar HTTPS** con Certbot (§12.4).
10. **Probar login** end-to-end desde el dominio (token JWT, sesión).
11. **Probar módulos clave:** citas/calendario (Socket.IO en vivo), cobro/caja,
    facturación SRI (requiere P12 y `INVOICE_ENCRYPTION_KEY`), WhatsApp (webhook
    Cloud API + reconexión QR), reportes.
12. **Cambiar DNS:** apuntar el dominio a la IP del VPS; actualizar `PUBLIC_API_URL`
    y reconfigurar los **webhooks de Meta/TikTok** al nuevo dominio (§8).
13. **Mantener Render/Vercel activos unos días** como respaldo; vigilar logs y
    healthcheck antes de apagarlos.

---

## Resumen de bloqueantes antes de migrar

- [ ] Confirmar en Render el set COMPLETO de variables (la captura se corta en
      `MONGODB_URI`); especialmente `SECRETS_KEY`, `INVOICE_ENCRYPTION_KEY`,
      `PUBLIC_API_URL`, `WHATSAPP_VERIFY_TOKEN`, `ANTHROPIC_API_KEY`.
- [ ] Reutilizar **idénticas** `INVOICE_ENCRYPTION_KEY` y `SECRETS_KEY` (si no, se
      rompen facturación SRI y tokens de WhatsApp ya guardados).
- [ ] Plan de **persistencia + backup de `server/storage/`** (certs y adjuntos).
- [ ] IP del VPS habilitada en Atlas Network Access.
- [ ] Chromium del sistema instalado + `PUPPETEER_EXECUTABLE_PATH` (para WhatsApp QR/PDF).

(Recomendados, no bloqueantes: `helmet`, `express-rate-limit`, `trust proxy`,
endurecer `.gitignore`.)
