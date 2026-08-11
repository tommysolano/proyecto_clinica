#!/usr/bin/env bash
#
# Despliegue de la app clinica / Shiluv en el VPS.
# Lo ejecuta GitHub Actions en cada push a main, y tambien sirve para correr a mano:
#     sudo -iu clinica bash /var/www/clinica/deploy.sh
#
set -euo pipefail

# Asegura que git / node / npm / pm2 esten en el PATH incluso en sesiones SSH
# no interactivas (como las de GitHub Actions).
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"
# Si instalaste Node con nvm en lugar de apt, descomenta estas dos lineas:
# export NVM_DIR="$HOME/.nvm"
# [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

APP_DIR="/var/www/clinica"
BRANCH="main"

cd "$APP_DIR"

echo "==> 1/6 Trayendo el ultimo codigo de origin/$BRANCH"
git fetch --all --prune
git reset --hard "origin/$BRANCH"

echo "==> 2/6 Instalando dependencias (server + client)"
npm run install-all

echo "==> 3/6 Compilando el frontend (regenera client/dist)"
npm --prefix client run build

echo "==> 4/6 Tareas de UNA SOLA VEZ"
# Cada tarea lleva su marca en la base (coleccion `onetimetasks`), asi que se ejecuta
# solo en el PRIMER despliegue que la trae: los siguientes push la encuentran DONE y no
# hacen nada. Si falla, queda FAILED y el proximo despliegue la reintenta; el fallo NO
# aborta el despliegue (el codigo nuevo tiene que subir igual), pero sale en el log.
#
# Vigente: borrar todas las ventas para empezar las pruebas desde cero (jul-2026).
# Cuando ya este DONE se puede quitar esta linea sin riesgo (la marca la protege igual).
if ! ( cd "$APP_DIR/server" && node scripts/wipeSalesOnce.js --commit ); then
  echo "ADVERTENCIA: la tarea de una sola vez fallo. Revisa el log y reintenta a mano:"
  echo "   sudo -iu clinica bash -lc 'cd $APP_DIR/server && node scripts/wipeSalesOnce.js --commit'"
fi

# ─────────────────────────────────────────────────────────────────────────────────────
# DESACTIVADA A PROPOSITO — dejar la CONTABILIDAD EN CERO para rehacer las pruebas.
#
# El script existe y esta probado, pero NO debe correr todavia. Mientras estas dos
# lineas sigan comentadas, ningun despliegue lo ejecuta.
#
# PARA ACTIVARLO (cuando el usuario lo pida): quitar el '# ' del if / echo / fi de abajo
# y hacer push. Se ejecutara UNA sola vez (marca `borrar-contabilidad-2026-08-10` en la
# coleccion `onetimetasks`); los push siguientes ya no haran nada aunque quede activo.
#
# Borra ventas, compras, cobros/pagos, caja, bancos, inventario, activos, comisiones,
# nomina, asientos, declaraciones SRI y presupuestos. NO toca el CRM/marketing, ni
# pacientes/citas/fichas, ni los catalogos, ni el certificado digital, ni los
# secuenciales del SRI. Ver la cabecera de server/scripts/wipeAccountingOnce.js.
#
# Para ver que borraria sin borrar nada:
#   sudo -iu clinica bash -lc 'cd /var/www/clinica/server && node scripts/wipeAccountingOnce.js'
#
# if ! ( cd "$APP_DIR/server" && node scripts/wipeAccountingOnce.js --commit ); then
#   echo "ADVERTENCIA: el borrado contable fallo. Revisa el log y reintenta a mano:"
#   echo "   sudo -iu clinica bash -lc 'cd $APP_DIR/server && node scripts/wipeAccountingOnce.js --commit'"
# fi
# ─────────────────────────────────────────────────────────────────────────────────────

# Vigente: reencolar las inscripciones que quedaron programadas para dispararse en pleno
# horario de silencio (ago-2026, al invertir el significado de las ventanas horarias).
if ! ( cd "$APP_DIR/server" && node scripts/rescheduleQuietWindowsOnce.js --commit ); then
  echo "ADVERTENCIA: el reencolado de ventanas fallo. Revisa el log y reintenta a mano:"
  echo "   sudo -iu clinica bash -lc 'cd $APP_DIR/server && node scripts/rescheduleQuietWindowsOnce.js --commit'"
fi

echo "==> 5/6 Reiniciando el backend con PM2 (bajo el usuario 'clinica')"
# IMPORTANTE: el backend corre bajo el pm2 del usuario `clinica` (God Daemon en
# /home/clinica/.pm2), NO bajo el de root. GitHub Actions ejecuta este deploy
# como root, así que un `pm2 restart` a secas apuntaba al pm2 de ROOT (vacío) →
# fallaba con "clinica-api doesn't exist" y el backend NUNCA se reiniciaba (seguía
# corriendo código viejo hasta un reboot). Por eso apuntamos SIEMPRE al pm2 de
# clinica; si el deploy ya se corre como clinica (manual), se usa pm2 directo.
#
# `unset SECRETS_KEY`: con --update-env, pm2 reinyecta el entorno de esta shell al
# proceso. Vaciamos SECRETS_KEY para que NADIE la pise y sea SIEMPRE dotenv
# (server/.env) la única fuente de la clave. Sin esto, un entorno sin la clave
# (el de GitHub Actions) la borraba del proceso y los tokens de WhatsApp quedaban
# ILEGIBLES ("no se pudo descifrar el token") hasta el siguiente reinicio manual.
#
# --kill-timeout 15000: da 15 s para cerrar los Chromium de WhatsApp QR (destroy);
# sin la gracia, la sesión moría a mitad de escritura y quedaba corrupta.
PM2_CMD='unset SECRETS_KEY; pm2 restart clinica-api --update-env --kill-timeout 15000 && pm2 save'
if [ "$(id -un)" = "clinica" ]; then
  bash -lc "$PM2_CMD"
else
  sudo -iu clinica bash -lc "$PM2_CMD"
fi

echo "==> 6/6 Tareas de UNA SOLA VEZ que exigen el codigo NUEVO ya corriendo"
# Va DESPUES del reinicio a proposito: esta tarea borra un estado que el codigo VIEJO
# fabricaba solo. Si corriera antes (en el paso 4), el backend viejo, todavia vivo,
# podria volver a crear una ventana fantasma entre la limpieza y el reinicio, y la
# marca de "una sola vez" ya no la volveria a barrer.
#
# Vigente: borrar las ventanas de 24h FANTASMA de los chats nacidos de un envio nuestro
# (ago-2026). Sin esto, esos chats siguen diciendo "ventana abierta" y el texto libre que
# escriba el agente lo rechaza Meta con el error 131047: el paciente nunca lo recibe.
if ! ( cd "$APP_DIR/server" && node scripts/clearPhantomWhatsappWindowOnce.js --commit ); then
  echo "ADVERTENCIA: la limpieza de ventanas fantasma fallo. Revisa el log y reintenta a mano:"
  echo "   sudo -iu clinica bash -lc 'cd $APP_DIR/server && node scripts/clearPhantomWhatsappWindowOnce.js --commit'"
fi

echo "==> Despliegue completado: $(date)"
