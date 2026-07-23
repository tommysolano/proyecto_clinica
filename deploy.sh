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

echo "==> 1/4 Trayendo el ultimo codigo de origin/$BRANCH"
git fetch --all --prune
git reset --hard "origin/$BRANCH"

echo "==> 2/4 Instalando dependencias (server + client)"
npm run install-all

echo "==> 3/4 Compilando el frontend (regenera client/dist)"
npm --prefix client run build

echo "==> 4/4 Reiniciando el backend con PM2 (bajo el usuario 'clinica')"
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

echo "==> Despliegue completado: $(date)"
